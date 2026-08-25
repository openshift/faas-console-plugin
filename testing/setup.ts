import '@testing-library/jest-dom/vitest';
import { server } from '../testing/msw/server';

export const BACKEND_API = 'http://localhost/api/proxy/plugin/console-functions-plugin/backend';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
