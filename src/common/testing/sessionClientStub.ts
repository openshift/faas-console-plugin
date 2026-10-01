import { http, HttpResponse } from 'msw';
import { BACKEND_API } from './constants';
import { server } from './mswServer';
import { storeSession } from '../clients/sessionClient';

// -----------------------------------------------------------------------------
// Session storage helpers (not HTTP) ------------------------------------------
// -----------------------------------------------------------------------------

export function startSessionFake() {
  storeSession('sess_test', { name: 'twoGiants', avatarUrl: 'https://valid.url' });
}

export function endSessionFake() {
  sessionStorage.clear();
}

// -----------------------------------------------------------------------------
// HTTP stubs ------------------------------------------------------------------
// -----------------------------------------------------------------------------

export function loginStub(
  {
    response,
    errorResponse,
  }: {
    response?: { token: string; login: string; avatarUrl: string };
    errorResponse?: { message: string; status: number };
  } = {
    response: { token: 'sess_test', login: 'twoGiants', avatarUrl: 'https://valid.url' },
  },
) {
  server.use(
    http.post(`${BACKEND_API}/api/v1/auth/login`, () => {
      if (errorResponse)
        return HttpResponse.json(
          { message: errorResponse.message },
          { status: errorResponse.status },
        );

      return HttpResponse.json(response);
    }),
  );
}

export function resumeSessionStub(
  {
    response,
    errorResponse,
  }: {
    response?: { token: string; login: string; avatarUrl: string };
    errorResponse?: { message: string; status: number };
  } = {
    response: { token: 'sess_test', login: 'twoGiants', avatarUrl: 'https://valid.url' },
  },
) {
  server.use(
    http.post(`${BACKEND_API}/api/v1/auth/session`, () => {
      if (errorResponse)
        return HttpResponse.json(
          { message: errorResponse.message },
          { status: errorResponse.status },
        );

      return HttpResponse.json(response);
    }),
  );
}

export function logoutStub({
  errorResponse,
}: {
  errorResponse?: { message: string; status: number };
} = {}) {
  server.use(
    http.post(`${BACKEND_API}/api/v1/auth/logout`, () => {
      if (errorResponse)
        return HttpResponse.json(
          { message: errorResponse.message },
          { status: errorResponse.status },
        );

      return new HttpResponse(null, { status: 204 });
    }),
  );
}
