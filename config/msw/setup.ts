import '@testing-library/jest-dom/vitest';
import { server } from '../../src/common/testing/mswServer';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
