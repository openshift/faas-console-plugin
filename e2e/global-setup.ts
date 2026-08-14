import { rm } from 'fs/promises';
import * as path from 'path';
import { resetFakeGithub, seedRepo } from './helpers/fakegithub';
import { E2E_USER, PRESEEDED_FUNC_NAME } from './helpers/constants';

// Force a fresh login on every run to avoid stale CSRF tokens when switching clusters.
export default async function globalSetup() {
  const authDir = path.join(__dirname, '../.e2e/auth');
  await rm(authDir, { recursive: true, force: true });

  await resetFakeGithub();
  await seedRepo(
    E2E_USER,
    PRESEEDED_FUNC_NAME,
    'main',
    ['serverless-function'],
    [
      {
        path: 'func.yaml',
        mode: '100644',
        content: `name: ${PRESEEDED_FUNC_NAME}\nruntime: node\nnamespace: default\n`,
      },
      {
        path: 'index.js',
        mode: '100644',
        content: 'module.exports = async (context) => context;',
      },
    ],
  );
}
