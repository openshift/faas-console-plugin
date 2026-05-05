import { FileEntry, ForgeUser, RepoMetadata, RepoSecret } from '../types';

export interface SourceControlService {
  listFunctionRepos(): Promise<RepoMetadata[]>;
  fetchFileContent(repo: RepoMetadata, path: string): Promise<string>;
  createRepoWithSecret(
    repo: RepoMetadata,
    files: FileEntry[],
    message: string,
    secret: RepoSecret,
  ): Promise<void>;
  updateRepo(repo: RepoMetadata, files: FileEntry[], message: string): Promise<void>;
  fetch(repo: RepoMetadata): Promise<FileEntry[]>;
  fetchUserInfo(pat: string): Promise<ForgeUser>;
}
