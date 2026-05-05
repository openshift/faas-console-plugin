import { Octokit } from '@octokit/rest';
import { FileEntry, ForgeUser, RepoMetadata, RepoSecret } from '../types';
import { SourceControlService } from './SourceControlService';

export class GithubService implements SourceControlService {
  #getToken: () => string;
  #cachedOctokit: Octokit | null = null;
  #cachedToken: string = '';
  #lastCommitSha = new Map<string, string>();
  #cachedFunctionRepos: RepoMetadata[] = [];

  constructor(getToken: () => string) {
    this.#getToken = getToken;
  }

  get #octokit(): Octokit {
    const token = this.#getToken();
    if (token !== this.#cachedToken) {
      this.#cachedToken = token;
      this.#cachedOctokit = new Octokit({ auth: token });
    }
    return this.#cachedOctokit!;
  }

  async fetchUserInfo(pat: string): Promise<ForgeUser> {
    const octokit = new Octokit({ auth: pat });
    const { data } = await octokit.users.getAuthenticated();
    return { name: data.login };
  }

  async listFunctionRepos(): Promise<RepoMetadata[]> {
    const { data: user } = await this.#octokit.users.getAuthenticated();

    const { data } = await this.#octokit.search.repos({
      q: `topic:serverless-function user:${user.login}`,
    });

    const fetchedFunctionRepos = data.items.map((item) => ({
      owner: item.owner?.login ?? '',
      name: item.name,
      url: item.html_url,
      defaultBranch: item.default_branch,
    }));
    const fetchedNames = new Set(fetchedFunctionRepos.map((r) => r.name));
    const unfetched = this.#cachedFunctionRepos.filter((r) => !fetchedNames.has(r.name));
    this.#cachedFunctionRepos = [...fetchedFunctionRepos, ...unfetched];
    return this.#cachedFunctionRepos;
  }

  async createRepoWithSecret(
    repo: RepoMetadata,
    files: FileEntry[],
    message: string,
    secret: RepoSecret,
  ): Promise<void> {
    const { owner, name: repoName, defaultBranch } = repo;

    if (await this.#doesRepoExist(owner, repoName))
      throw new Error(`repository '${repoName}' exists, please choose a different name`);

    await this.#octokit.repos.createForAuthenticatedUser({
      name: repoName,
      auto_init: true,
    });

    await this.#createSecret(repo, secret.name, secret.value);

    if (defaultBranch !== 'main')
      await this.#octokit.repos.renameBranch({
        owner,
        repo: repoName,
        branch: 'main',
        new_name: defaultBranch,
      });

    await this.#octokit.repos.replaceAllTopics({
      owner,
      repo: repoName,
      names: ['serverless-function'],
    });

    const treeEntries = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await this.#octokit.git.createBlob({
          owner,
          repo: repoName,
          content: file.content,
          encoding: 'utf-8',
        });
        return {
          path: file.path,
          mode: file.mode,
          type: file.type as 'blob',
          sha: blob.sha,
        };
      }),
    );

    const { data: ref } = await this.#octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${defaultBranch}`,
    });

    const { data: parentCommit } = await this.#octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: ref.object.sha,
    });

    const { data: tree } = await this.#octokit.git.createTree({
      owner,
      repo: repoName,
      tree: treeEntries,
      base_tree: parentCommit.tree.sha,
    });

    const { data: commit } = await this.#octokit.git.createCommit({
      owner,
      repo: repoName,
      message,
      tree: tree.sha,
      parents: [parentCommit.sha],
    });

    await this.#octokit.git.updateRef({
      owner,
      repo: repoName,
      ref: `heads/${defaultBranch}`,
      sha: commit.sha,
    });

    this.#cachedFunctionRepos.push({
      owner,
      name: repoName,
      url: `https://github.com/${owner}/${repoName}`,
      defaultBranch,
    });
  }

  async #doesRepoExist(owner: string, repoName: string): Promise<boolean> {
    try {
      await this.#octokit.repos.get({ owner, repo: repoName });
      return true;
    } catch (err) {
      const is404 =
        err instanceof Error && 'status' in err && (err as { status: number }).status === 404;
      if (is404) return false;
      throw err;
    }
  }

  async updateRepo(repo: RepoMetadata, files: FileEntry[], message: string): Promise<void> {
    const { owner, name: repoName, defaultBranch: branch } = repo;
    const refKey = `${owner}/${repoName}/${branch}`;

    const treeEntries = await Promise.all(
      files.map(async (file) => {
        const { data: blob } = await this.#octokit.git.createBlob({
          owner,
          repo: repoName,
          content: file.content,
          encoding: 'utf-8',
        });
        return {
          path: file.path,
          mode: file.mode,
          type: file.type as 'blob',
          sha: blob.sha,
        };
      }),
    );

    // GitHub's ref storage is eventually consistent. After a successful
    // updateRef, a subsequent getRef may return a stale SHA. Use the
    // locally cached commit SHA from the previous push when available.
    // Fall back to getRef only on first push or if the cache is stale
    // (someone else pushed, causing a "not a fast forward" error).
    let parentCommitSha = this.#lastCommitSha.get(refKey);
    if (!parentCommitSha) {
      const { data: ref } = await this.#octokit.git.getRef({
        owner,
        repo: repoName,
        ref: `heads/${branch}`,
      });
      parentCommitSha = ref.object.sha;
    }

    const { data: parentCommit } = await this.#octokit.git.getCommit({
      owner,
      repo: repoName,
      commit_sha: parentCommitSha,
    });

    const { data: tree } = await this.#octokit.git.createTree({
      owner,
      repo: repoName,
      tree: treeEntries,
      base_tree: parentCommit.tree.sha,
    });

    const { data: commit } = await this.#octokit.git.createCommit({
      owner,
      repo: repoName,
      message,
      tree: tree.sha,
      parents: [parentCommitSha],
    });

    try {
      await this.#octokit.git.updateRef({
        owner,
        repo: repoName,
        ref: `heads/${branch}`,
        sha: commit.sha,
      });
      this.#lastCommitSha.set(refKey, commit.sha);
    } catch (err) {
      // If cache was stale (someone else pushed). Clear and let next
      // attempt use getRef for the fresh SHA.
      const isStaleRef = err instanceof Error && err.message.includes('fast forward');
      if (isStaleRef) this.#lastCommitSha.delete(refKey);
      throw err;
    }
  }

  async fetch(repo: RepoMetadata): Promise<FileEntry[]> {
    const { data: repoContent } = await this.#octokit.git.getTree({
      owner: repo.owner,
      repo: repo.name,
      tree_sha: repo.defaultBranch,
      recursive: '1',
    });

    const filesAsBlobs = repoContent.tree.filter((entry) => entry.type === 'blob');

    const files = await Promise.all(
      filesAsBlobs.map(async (fileAsBlob) => {
        const { data: file } = await this.#octokit.git.getBlob({
          owner: repo.owner,
          repo: repo.name,
          file_sha: fileAsBlob.sha!,
        });
        return {
          path: fileAsBlob.path!,
          mode: (fileAsBlob.mode ?? '100644') as FileEntry['mode'],
          content: base64ToUtf8(file.content),
          type: 'blob' as const,
        };
      }),
    );

    return files;
  }

  async #createSecret(repo: RepoMetadata, name: string, value: string): Promise<void> {
    const { owner, name: repoName } = repo;

    const {
      data: { key_id, key },
    } = await this.#octokit.actions.getRepoPublicKey({ owner, repo: repoName });

    const encrypted_value = await this.#encryptForGithub(value, key);

    await this.#octokit.actions.createOrUpdateRepoSecret({
      owner,
      repo: repoName,
      secret_name: name,
      encrypted_value,
      key_id,
    });
  }

  async #encryptForGithub(value: string, publicKeyBase64: string): Promise<string> {
    const mod = await import('libsodium-wrappers');
    // The default export is the mutable sodium object where crypto functions
    // are populated after ready. The ES module namespace is immutable and
    // only exposes static utility exports.
    type SodiumFull = typeof mod & {
      crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
    };
    const sodium = ((mod as unknown as { default?: SodiumFull }).default ?? mod) as SodiumFull;
    await sodium.ready;
    if (typeof sodium.crypto_box_seal !== 'function') {
      throw new Error('libsodium crypto_box_seal not available');
    }
    const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
    const encrypted = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
    return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  }

  async fetchFileContent(repo: RepoMetadata, path: string): Promise<string> {
    const { data } = await this.#octokit.repos.getContent({
      owner: repo.owner,
      repo: repo.name,
      path,
    });

    if (!('content' in data)) {
      throw new Error(`${path} is not a file`);
    }
    return base64ToUtf8(data.content);
  }
}

/**
 * Decodes base64 to UTF-8. Unlike plain atob, handles multi-byte characters.
 */
function base64ToUtf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
