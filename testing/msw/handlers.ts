import { http, HttpResponse } from 'msw';

const BACKEND_API = 'http://localhost/api/proxy/plugin/console-functions-plugin/backend';

/** Default backend API handlers. Override per test by using server.use(). */
export const handlers = [
  // GET /api/v1/auth/user - authenticated user
  http.get(`${BACKEND_API}/api/v1/auth/user`, () =>
    HttpResponse.json({ login: 'twoGiants', avatarUrl: '' }),
  ),

  // GET /api/v1/func/list - list function repos
  http.get(`${BACKEND_API}/api/v1/func/list`, () => HttpResponse.json([])),
];
