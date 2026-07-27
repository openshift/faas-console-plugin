import { rm } from 'fs/promises';
import * as path from 'path';

// Force a fresh login on every run to avoid stale CSRF tokens when switching clusters.
export default async function globalSetup() {
  const authDir = path.join(__dirname, '../.e2e/auth');
  await rm(authDir, { recursive: true, force: true });
}
