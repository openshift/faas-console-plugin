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
