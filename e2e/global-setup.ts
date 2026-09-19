import { execFile } from 'child_process';
import { rm } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { resetFakeGithub, seedRepo } from './helpers/fakegithub';
import { E2E_USER, PRESEEDED_FUNC_NAME, PRESEEDED_FUNC_NAMESPACE } from './helpers/constants';

const execFileAsync = promisify(execFile);

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
        content: `name: ${PRESEEDED_FUNC_NAME}\nruntime: node\nnamespace: ${PRESEEDED_FUNC_NAMESPACE}\n`,
      },
      {
        path: 'index.js',
        mode: '100644',
        content: 'module.exports = async (context) => context;',
      },
    ],
  );

  try {
    await execFileAsync('oc', [
      'get',
      'serviceaccount',
      'func-scm',
      '--namespace',
      PRESEEDED_FUNC_NAMESPACE,
    ]);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    await execFileAsync('oc', [
      'create',
      'serviceaccount',
      'func-scm',
      '--namespace',
      PRESEEDED_FUNC_NAMESPACE,
    ]);
  }
}
