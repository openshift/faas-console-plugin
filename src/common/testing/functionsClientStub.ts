import { http, HttpResponse } from 'msw';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { CreateFunctionRequest, FunctionListItem } from '../types';

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

export function createFunctionStub(
  {
    response,
    errorResponse,
  }: {
    response?: Partial<CreateFunctionRequest>;
    errorResponse?: { message: string; status: number };
  } = { response: undefined },
) {
  const keys = response ? (Object.keys(response) as (keyof CreateFunctionRequest)[]) : [];

  server.use(
    http.post(`${BACKEND_API}/api/v1/func/create`, async ({ request }) => {
      if (errorResponse)
        return HttpResponse.json(
          { message: errorResponse.message },
          { status: errorResponse.status },
        );

      const body = (await request.json()) as CreateFunctionRequest;
      const matches = keys.every(
        (key) => JSON.stringify(body[key]) === JSON.stringify(response![key]),
      );
      if (!matches) {
        return HttpResponse.json({ message: 'Unexpected payload' }, { status: 422 });
      }
      return new HttpResponse(null, { status: 201 });
    }),
  );
}
