import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./config/msw/setup.ts'],
    css: false,
    exclude: ['node_modules', 'dist', 'e2e'],
    execArgv: ['--localstorage-file=.tmp/vitest-localstorage'],
  },
});
