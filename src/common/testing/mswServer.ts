import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { BACKEND_API } from './constants';

// Default backend API handlers. Override per test by using server.use().
const defaultHandlers = [
  // GET /api/v1/auth/user - authenticated user
  http.get(`${BACKEND_API}/api/v1/auth/user`, () =>
    HttpResponse.json({ login: 'twoGiants', avatarUrl: '' }),
  ),

  // GET /api/v1/func/list - list function repos
  http.get(`${BACKEND_API}/api/v1/func/list`, () => HttpResponse.json([])),

  // GET /api/v1/func/build/watch - server-sent events stream
  // Default: empty stream (tests override with setWatchResponse)
  http.get(`${BACKEND_API}/api/v1/func/build/watch`, () =>
    HttpResponse.text('', {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  ),
];

export const server = setupServer(...defaultHandlers);
