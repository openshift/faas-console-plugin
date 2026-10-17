import { FunctionListItem } from '../types';

export function repoListItem({
  repoName = 'my-func',
  name = repoName,
  namespace = 'demo',
  runtime = 'go',
  err,
}: {
  repoName?: string;
  name?: string;
  namespace?: string;
  runtime?: string;
  err?: string;
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
    err,
  };
}
