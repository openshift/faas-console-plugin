import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./testing/setup.ts'],
    css: false,
    exclude: ['node_modules', 'dist', 'e2e'],
  },
});
