import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { FAKE_GH_PAT } from './constants';

interface DevEnv {
  fakeGithubPort?: number;
  clusterAPIURL?: string;
}

function readDevEnv(): DevEnv {
  const devEnvPath = path.join(__dirname, '../../.dev-env.json');
  if (!existsSync(devEnvPath)) {
    throw new Error(
      '.dev-env.json not found. Is the development environment running? Start with: make dev-fake-gh',
    );
  }
  return JSON.parse(readFileSync(devEnvPath, 'utf-8'));
}

export function fakeGithubUrl(): string {
  if (process.env.FAKE_GITHUB_URL) return process.env.FAKE_GITHUB_URL;
  const env = readDevEnv();
  if (!env.fakeGithubPort) {
    throw new Error('fakeGithubPort not found in .dev-env.json. Start dev with: make dev-fake-gh');
  }
  return `http://localhost:${env.fakeGithubPort}`;
}

export function clusterAPIURL(): string {
  if (process.env.CLUSTER_API_URL) return process.env.CLUSTER_API_URL;
  const env = readDevEnv();
  if (!env.clusterAPIURL) {
    throw new Error('clusterAPIURL not found in .dev-env.json. Start dev with: make dev-fake-gh');
  }
  return env.clusterAPIURL;
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
  variables?: Record<string, string>,
): Promise<void> {
  const url = fakeGithubUrl();
  const mergedVariables = { CLUSTER_API_URL: clusterAPIURL(), ...variables };
  const resp = await fetch(`${url}/_admin/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, repo: name, branch, topics, files, variables: mergedVariables }),
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to seed repo ${owner}/${name} in fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
}

export async function resetFakeGithub(): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/_admin/reset`, { method: 'POST' });
  if (!resp.ok) {
    throw new Error(`Failed to reset fake GitHub: ${resp.status} ${await resp.text()}`);
  }
}

export async function deleteRepoOnFakeGithub(owner: string, name: string): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/repos/${owner}/${name}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${FAKE_GH_PAT}` },
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to delete repo ${owner}/${name} in fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
}
