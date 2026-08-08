import { readFileSync } from 'fs';
import * as path from 'path';

interface DevEnv {
  fakeGithubPort?: number;
}

function readDevEnv(): DevEnv {
  const devEnvPath = path.join(__dirname, '../../.dev-env.json');
  return JSON.parse(readFileSync(devEnvPath, 'utf-8'));
}

export function fakeGithubUrl(): string {
  if (process.env.FAKE_GITHUB_URL) return process.env.FAKE_GITHUB_URL;
  const env = readDevEnv();
  if (!env.fakeGithubPort) {
    throw new Error(
      'fakeGithubPort not found in .dev-env.json. Start dev with: hack/dev.sh --fake-gh',
    );
  }
  return `http://localhost:${env.fakeGithubPort}`;
}

interface SeedFile {
  path: string;
  mode: string;
  content: string;
}

export async function seedRepo(
  owner: string,
  name: string,
  branch: string,
  topics: string[],
  files: SeedFile[],
): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/_admin/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, repo: name, branch, topics, files }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to seed repo ${owner}/${name}: ${resp.status} ${await resp.text()}`);
  }
}

export async function resetFakeGithub(): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/_admin/reset`, { method: 'POST' });
  if (!resp.ok) {
    throw new Error(`Failed to reset fake GitHub: ${resp.status} ${await resp.text()}`);
  }
}

const FAKE_GH_PAT = 'placeholder-pat';

export async function deleteRepoOnFakeGithub(owner: string, name: string): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/repos/${owner}/${name}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${FAKE_GH_PAT}` },
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to delete repo ${owner}/${name} on fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
}
