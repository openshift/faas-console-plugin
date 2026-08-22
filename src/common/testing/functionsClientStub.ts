import { http, HttpResponse } from 'msw';
import { BACKEND_API } from '../testing/constants';
import { server } from '../testing/mswServer';
import { FunctionListItem } from '../types';

// -----------------------------------------------------------------------------
// Test Doubles ----------------------------------------------------------------
// -----------------------------------------------------------------------------

export function listFunctionsStub({
  response,
  errorResponse,
}: {
  response?: FunctionListItem;
  errorResponse?: { message: string; status: number };
} = {}) {
  server.use(
    http.get(`${BACKEND_API}/api/v1/func/list`, () => {
      return errorResponse?.message && errorResponse?.status
        ? HttpResponse.json({ message: errorResponse?.message }, { status: errorResponse.status })
        : HttpResponse.json([response]);
    }),
  );
}
