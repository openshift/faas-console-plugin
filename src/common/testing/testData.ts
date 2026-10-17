import { FunctionMetadata } from '../types';

export function functionMetadata({
  repoName = 'my-func',
  name = repoName,
  namespace = 'demo',
  runtime = 'go',
}: {
  repoName?: string;
  name?: string;
  namespace?: string;
  runtime?: string;
} = {}): FunctionMetadata {
  return {
    owner: 'twoGiants',
    repoName,
    repoURL: `https://github.com/twoGiants/${repoName}`,
    defaultBranch: 'main',
    name,
    namespace,
    runtime,
    source: 'repo',
  };
}
