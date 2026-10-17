import { http, HttpResponse } from 'msw';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { FileEntry, FunctionMetadata, WorkflowRunRecord } from '../types';

// -----------------------------------------------------------------------------
// Test Doubles ----------------------------------------------------------------
// -----------------------------------------------------------------------------

export function listFunctionsStub(
  {
    responses,
    errorResponse,
    wait,
  }: {
    responses?: FunctionMetadata[];
    errorResponse?: { message: string; status: number };
    wait?: Promise<void>;
  } = {
    responses: [],
  },
) {
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/list`, async ({ request }) => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      if (wait) await wait;

      const url = new URL(request.url);

      const all = url.searchParams.get('all');
      if (all === 'true') return HttpResponse.json(responses);

      const namespace = url.searchParams.get('namespace');
      if (!namespace)
        return HttpResponse.json({ message: 'namespace can not be empty' }, { status: 400 });

      return HttpResponse.json(responses?.filter((item) => item.namespace === namespace));
    }),
  );
}

export function getFilesStub(
  {
    owner = 'twoGiants',
    repoName = 'my-func',
    responses,
    errorResponse,
    wait,
  }: {
    owner?: string;
    repoName?: string;
    responses?: FileEntry[];
    errorResponse?: { message: string; status: number };
    wait?: Promise<void>;
  } = {
    responses: [],
  },
) {
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/${owner}/${repoName}/files`, async () => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      if (wait) await wait;

      return HttpResponse.json(responses);
    }),
  );
}

export function putFilesStub({
  owner = 'twoGiants',
  repoName = 'my-func',
  errorResponse,
  wait,
}: {
  owner?: string;
  repoName?: string;
  errorResponse?: { message: string; status: number };
  wait?: Promise<void>;
} = {}) {
  server.use(
    http.put(`${BACKEND_API}/api/v1/func/${owner}/${repoName}/files`, async () => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      if (wait) await wait;

      return new HttpResponse(null, { status: 204 });
    }),
  );
}

export type WorkflowRunStreamEvent =
  | { type: 'build-status'; runs: WorkflowRunRecord }
  | { type: 'app-error'; message: string; code?: number };

export function receiveWorkflowRunEventsStub({
  snapshot,
  stream,
  errorResponse,
}: {
  snapshot?: WorkflowRunRecord;
  stream?: AsyncIterable<WorkflowRunStreamEvent>;
  errorResponse?: { message: string; status: number };
} = {}) {
  const encoder = new TextEncoder();
  let start: (controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>) => void;

  if (stream)
    start = async (controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>) => {
      try {
        for await (const event of stream) {
          const data =
            event.type === 'build-status'
              ? `event: build-status\ndata: ${JSON.stringify(event.runs)}\n\n`
              : `event: app-error\ndata: ${JSON.stringify({ message: event.message, code: event.code })}\n\n`;
          controller.enqueue(encoder.encode(data));
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    };
  else if (snapshot)
    start = (controller) => {
      controller.enqueue(
        encoder.encode(`event: build-status\ndata: ${JSON.stringify(snapshot)}\n\n`),
      );
    };

  server.use(
    http.get(`${BACKEND_API}/api/v1/func/build/watch`, () => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      const body = new ReadableStream<Uint8Array>({ start });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }),
  );
}
