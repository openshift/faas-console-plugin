import { http, HttpResponse } from 'msw';
import { BACKEND_API } from './constants';
import { server } from './mswServer';

const CREDENTIAL_URL = `${BACKEND_API}/api/v1/scm/github/credential`;

export const CONNECTED_ACCOUNT = { login: 'twoGiants', avatarUrl: 'https://valid.url' };

type Account = { login: string; avatarUrl: string };
type ErrorResponse = { message: string; status: number };

// connectStub answers the POST that hands the backend a PAT.
export function connectGithubUserStub({
  response = CONNECTED_ACCOUNT,
  errorResponse,
}: { response?: Account; errorResponse?: ErrorResponse } = {}) {
  server.use(http.post(CREDENTIAL_URL, () => reply(response, errorResponse)));
}

// connectionStub answers the GET the UI makes on mount. Omit the response to
// play a user who has never connected, which is the 404 the backend sends.
export function fetchGithubUserStub({
  response = CONNECTED_ACCOUNT,
  errorResponse,
}: { response?: Account | null; errorResponse?: ErrorResponse } = {}) {
  server.use(
    http.get(CREDENTIAL_URL, () => {
      if (!response && !errorResponse) {
        return HttpResponse.json({ message: 'no stored credential' }, { status: 404 });
      }
      return reply(response as Account, errorResponse);
    }),
  );
}

// noConnectionStub plays a user with nothing stored, so the UI should prompt
// for a PAT rather than connect them.
export function noGithubUserStub() {
  fetchGithubUserStub({ response: null });
}

export function disconnectGithubUserStub({
  errorResponse,
}: { errorResponse?: ErrorResponse } = {}) {
  server.use(
    http.delete(CREDENTIAL_URL, () => {
      if (errorResponse) {
        return HttpResponse.json(
          { message: errorResponse.message },
          { status: errorResponse.status },
        );
      }
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

function reply(response: Account, errorResponse?: ErrorResponse) {
  if (errorResponse) {
    return HttpResponse.json({ message: errorResponse.message }, { status: errorResponse.status });
  }
  return HttpResponse.json(response);
}
