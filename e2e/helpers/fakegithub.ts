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

export interface SeedFile {
  path: string;
  mode: string;
  content: string;
}

// nodeFunctionFiles returns the standard func.yaml + handler seed for a Node
// function, shared by every test that seeds a basic function repo.
export function nodeFunctionFiles(name: string, namespace: string): SeedFile[] {
  return [
    {
      path: 'func.yaml',
      mode: '100644',
      content: `name: ${name}\nruntime: node\nnamespace: ${namespace}\n`,
    },
    {
      path: 'index.js',
      mode: '100644',
      content: 'module.exports = async (context) => context;',
    },
  ];
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
  const kubeconfigExpireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const mergedVariables = {
    CLUSTER_API_URL: clusterAPIURL(),
    KUBECONFIG_EXPIRE_AT: kubeconfigExpireAt,
    ...variables,
  };
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

export async function getRepoVariable(
  owner: string,
  name: string,
  variable: string,
): Promise<string> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/repos/${owner}/${name}/actions/variables/${variable}`, {
    headers: { Authorization: `token ${FAKE_GH_PAT}` },
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to read variable ${variable} for ${owner}/${name} in fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
  const body = (await resp.json()) as { name: string; value: string };
  return body.value;
}

export async function resetFakeGithub(): Promise<void> {
  const url = fakeGithubUrl();
  const resp = await fetch(`${url}/_admin/reset`, { method: 'POST' });
  if (!resp.ok) {
    throw new Error(`Failed to reset fake GitHub: ${resp.status} ${await resp.text()}`);
  }
}

interface WorkflowRunResult {
  conclusion: string;
  logUrl: string;
}

export async function waitForWorkflowRun(
  owner: string,
  repo: string,
  { timeout = 600_000, interval = 5_000 }: { timeout?: number; interval?: number } = {},
): Promise<WorkflowRunResult> {
  const url = `${fakeGithubUrl()}/repos/${owner}/${repo}/actions/workflows/func-deploy.yaml/runs`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const data = await fetch(url, {
      headers: { Authorization: `token ${FAKE_GH_PAT}` },
    }).then((r) => r.json());
    const run = data.workflow_runs?.[0];
    if (run?.status === 'completed') {
      // The backend calls fakegithub via the in-cluster service URL, so r.Host in
      // the fake server is the cluster-internal hostname. html_url therefore contains
      // that hostname, which is unreachable from the test runner. Keep only the path
      // and prepend the port-forward URL that the test runner can actually reach.
      const logPath = new URL(run.html_url as string).pathname;
      return { conclusion: run.conclusion as string, logUrl: `${fakeGithubUrl()}${logPath}` };
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Workflow run for ${owner}/${repo} did not complete within ${timeout}ms`);
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

interface WorkflowRunInput {
  headSha?: string;
  status: string; // queued | in_progress | completed
  conclusion?: string; // success | failure | ...
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
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to set workflow run for ${owner}/${name} in fake GitHub: ${resp.status} ${await resp.text()}`,
    );
  }
}
