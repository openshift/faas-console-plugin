import { http, HttpResponse } from 'msw';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { FileEntry, FunctionListItem } from '../types';

// -----------------------------------------------------------------------------
// Test Doubles ----------------------------------------------------------------
// -----------------------------------------------------------------------------

export function listFunctionsStub(
  {
    responses,
    errorResponse,
    wait,
  }: {
    responses?: FunctionListItem[];
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

export function repoListItem({
  repoName = 'my-func',
  name = 'my-func',
  namespace = 'demo',
  runtime = 'go',
}: {
  repoName?: string;
  name?: string;
  namespace?: string;
  runtime?: string;
} = {}): FunctionListItem {
  return {
    owner: 'twoGiants',
    repoName,
    repoURL: `https://github.com/twoGiants/${repoName}`,
    defaultBranch: 'main',
    name: name ?? repoName,
    namespace,
    runtime,
    source: 'repo',
  };
}

export function getFilesStub(
  {
    responses,
    errorResponse,
    wait,
  }: {
    responses?: FileEntry[];
    errorResponse?: { message: string; status: number };
    wait?: Promise<void>;
  } = {
    responses: [],
  },
) {
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, async ({ request }) => {
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

export function putFilesSpy({
  errorResponse,
  wait,
}: {
  errorResponse?: { message: string; status: number };
  wait?: Promise<void>;
} = {}) {
  const requests: PutFilesRequest[] = [];
  server.use(
    http.put(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, async ({ request }) => {
      requests.push((await request.json()) as PutFilesRequest);

      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      if (wait) await wait;

      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { requests };
}

interface PutFilesRequest {
  files: FileEntry[];
  message: string;
  branch: string;
}

export function putFilesStub({
  expectedRequest,
  errorResponse,
  wait,
}: {
  expectedRequest?: PutFilesRequest;
  errorResponse?: { message: string; status: number };
  wait?: Promise<void>;
} = {}) {
  server.use(
    http.put(`${BACKEND_API}/api/v1/func/twoGiants/my-func/files`, async ({ request }) => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      if (wait) await wait;

      if (expectedRequest) {
        const actualRequest = (await request.json()) as PutFilesRequest;
        expect(actualRequest).toEqual(expectedRequest);
      }

      return new HttpResponse(null, { status: 204 });
    }),
  );
}
