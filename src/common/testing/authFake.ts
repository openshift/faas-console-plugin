import { http, HttpResponse } from 'msw';
import { BACKEND_API } from './constants';
import { server } from './mswServer';
import { storeSession } from '../clients/sessionClient';

export function authenticateGithubFake() {
  storeSession('sess_test', { name: 'twoGiants', avatarUrl: 'https://valid.url' });
}

export function logoutGithubFake() {
  sessionStorage.clear();
}

export function logoutStub() {
  server.use(
    http.post(`${BACKEND_API}/api/v1/auth/logout`, () => new HttpResponse(null, { status: 204 })),
  );
}
