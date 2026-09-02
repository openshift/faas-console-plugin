import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { FAKE_GH_PAT } from './constants';

interface DevEnv {
  fakeGithubPort?: number;
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

interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string;
  number: number;
}

interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  steps: WorkflowStep[];
}

interface WorkflowRunInput {
  headSha?: string;
  status: string; // queued | in_progress | completed
  conclusion?: string; // success | failure | ...
  jobs?: WorkflowJob[];
}

export async function setWorkflowRun(
  owner: string,
  name: string,
  branch: string,
  run: WorkflowRunInput,
): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/_admin/actions/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner,
      repo: name,
      branch,
      headSha: run.headSha ?? '',
      status: run.status,
      conclusion: run.conclusion ?? '',
      jobs: run.jobs ?? [],
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to set workflow run for ${owner}/${name} in fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
}
