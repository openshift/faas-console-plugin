import { http, HttpResponse } from 'msw';
import { BACKEND_API } from './constants';
import { server } from './mswServer';

const CREDENTIAL_URL = `${BACKEND_API}/api/v1/scm/github/credential`;

const CONNECTED_ACCOUNT = { login: 'twoGiants', avatarUrl: 'https://valid.url' };

type Account = { login: string; avatarUrl: string };
type ErrorResponse = { message: string; status: number };

// connectStub answers the POST that hands the backend a PAT.
export function connectGithubUserStub({
  response = CONNECTED_ACCOUNT,
  errorResponse,
  wait,
}: {
  response?: Account;
  errorResponse?: ErrorResponse;
  wait?: Promise<void>;
} = {}) {
  server.use(
    http.post(CREDENTIAL_URL, async () => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      if (wait) await wait;

      return HttpResponse.json(response);
    }),
  );
}

// connectionStub answers the GET the UI makes on mount.
export function fetchGithubUserStub({
  response = CONNECTED_ACCOUNT,
  errorResponse,
}: {
  response?: Account;
  errorResponse?: ErrorResponse;
} = {}) {
  server.use(
    http.get(CREDENTIAL_URL, () => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      return HttpResponse.json(response);
    }),
  );
}

// noConnectionStub plays a user with nothing stored, so the UI should prompt
// for a PAT rather than connect them.
export function noGithubUserStub() {
  server.use(
    http.get(CREDENTIAL_URL, () =>
      HttpResponse.json({ message: 'no stored credential' }, { status: 404 }),
    ),
  );
}

export function disconnectGithubUserStub({
  errorResponse,
}: { errorResponse?: ErrorResponse } = {}) {
  server.use(
    http.delete(CREDENTIAL_URL, () => {
      if (errorResponse?.message && errorResponse?.status)
        return HttpResponse.json(
          { message: errorResponse?.message },
          { status: errorResponse.status },
        );

      return new HttpResponse(null, { status: 204 });
    }),
  );
}
