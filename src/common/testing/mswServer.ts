import { setupServer } from 'msw/node';

// Deliberately started with no handlers. The suite runs with
// onUnhandledRequest: 'error', so every test declares the endpoints it expects
// via server.use() and anything unmocked fails loudly instead of silently
// getting a blanket default.
export const server = setupServer();
