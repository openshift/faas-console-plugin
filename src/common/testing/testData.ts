import { FunctionListItem } from '../types';

export function repoListItem({
  repoName = 'my-func',
  name = repoName,
  namespace = 'demo',
  runtime = 'go',
}: {
  repoName?: string;
  name?: string;
  namespace?: string;
  runtime?: string;
} = {}): FunctionListItem {
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
