import { readdir, mkdir } from 'node:fs/promises';
import { resolve as pathResolve, relative, join } from 'node:path';
import { simpleGit, type LogResult } from 'simple-git';
import type { RepoStatus, CommitInfo, CommitDetail, CommitFileInfo } from '@synth/shared';

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'только что';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес назад`;
  const years = Math.floor(months / 12);
  return `${years} г назад`;
}

function resolveRepoPath(workspaceRoot: string, reposPath: string, repoRelPath: string): string {
  const repoPath = repoRelPath ? pathResolve(reposPath, repoRelPath) : reposPath;
  const rel = relative(workspaceRoot, repoPath);
  if (rel.startsWith('..') || pathResolve(repoPath) !== repoPath) {
    throw { error: 'Путь репозитория выходит за пределы workspace', code: 'PATH_TRAVERSAL' };
  }
  return repoPath;
}

function deriveRepoName(url: string): string {
  let name = url.replace(/\/$/, '').split('/').pop() || 'repo';
  name = name.replace(/\.git$/, '');
  return name;
}

export class GitService {
  constructor(private workspacesRoot: string) {}

  async isRepo(repoPath: string): Promise<boolean> {
    try {
      return await simpleGit(repoPath).checkIsRepo();
    } catch {
      return false;
    }
  }

  async getRepoStatus(repoAbsPath: string): Promise<RepoStatus | null> {
    if (!(await this.isRepo(repoAbsPath))) return null;
    try {
      const g = simpleGit(repoAbsPath);
      const branch = await g.revparse(['--abbrev-ref', 'HEAD']);
      const log = await g.log({ maxCount: 1 });
      const last = log.latest;
      return {
        path: '',
        isRepo: true,
        currentBranch: branch.trim() || undefined,
        lastCommitAt: last ? last.date : undefined,
        lastCommitSubject: last ? last.message.split('\n')[0] : undefined,
      };
    } catch {
      return null;
    }
  }

  async scanWorkspace(wsAbsPath: string): Promise<RepoStatus[]> {
    const results: RepoStatus[] = [];

    const rootStatus = await this.getRepoStatus(wsAbsPath);
    if (rootStatus) {
      rootStatus.path = '';
      results.push(rootStatus);
    }

    const subdirs = await this.listSubdirs(wsAbsPath, 3);
    for (const subdir of subdirs) {
      const fullPath = join(wsAbsPath, subdir);
      const status = await this.getRepoStatus(fullPath);
      if (status) {
        status.path = subdir;
        results.push(status);
      }
    }

    return results;
  }

  private async listSubdirs(root: string, maxDepth: number): Promise<string[]> {
    const result: string[] = [];

    async function walk(dir: string, depth: number, relPrefix: string) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        result.push(relPath);
        await walk(join(dir, entry.name), depth + 1, relPath);
      }
    }

    await walk(root, 1, '');
    return result;
  }

  async initRepo(wsAbsPath: string, repoRelPath: string, defaultBranch?: string): Promise<RepoStatus> {
    const repoPath = resolveRepoPath(this.workspacesRoot, wsAbsPath, repoRelPath);
    try {
      await mkdir(repoPath, { recursive: true });
    } catch {
      // directory might already exist
    }
    const g = simpleGit(repoPath);
    if (defaultBranch) {
      await g.init(['--initial-branch', defaultBranch]);
    } else {
      await g.init();
    }
    return {
      path: repoRelPath,
      isRepo: true,
    };
  }

  async cloneRepo(wsAbsPath: string, repoRelPath: string, url: string, branch?: string): Promise<RepoStatus> {
    const effectivePath = repoRelPath || deriveRepoName(url);
    const repoPath = resolveRepoPath(this.workspacesRoot, wsAbsPath, effectivePath);
    const parentDir = pathResolve(repoPath, '..');
    try {
      await mkdir(parentDir, { recursive: true });
    } catch {
    }
    await simpleGit().clone(url, repoPath, branch ? { '--branch': branch } : undefined);
    return {
      path: effectivePath,
      isRepo: true,
    };
  }

  async getLog(wsAbsPath: string, repoRelPath: string, maxCount = 30): Promise<CommitInfo[]> {
    const repoPath = resolveRepoPath(this.workspacesRoot, wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath);
    const g = simpleGit(repoPath);
    const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const log: LogResult = await g.log({ maxCount });
    return log.all.map((entry) => ({
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      subject: entry.message.split('\n')[0] || '',
      message: entry.message,
      author: entry.author_name,
      authorEmail: entry.author_email,
      date: entry.date,
      relativeDate: relativeTime(entry.date),
      branch,
    }));
  }

  async getCommitDetail(wsAbsPath: string, repoRelPath: string, hash: string): Promise<CommitDetail> {
    const repoPath = resolveRepoPath(this.workspacesRoot, wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath);
    const g = simpleGit(repoPath);
    const branch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim();

    const showRaw = await g.raw(['show', '--format=%H%n%an%n%ae%n%aI%n%s%n%B%n==ENDOFCOMMIT==', '-s', '--no-patch', hash]);
    const metaEnd = showRaw.indexOf('\n==ENDOFCOMMIT==');
    const meta = metaEnd >= 0 ? showRaw.slice(0, metaEnd).split('\n') : showRaw.split('\n');
    const commitHash = meta[0] || hash;
    const author = meta[1] || '';
    const authorEmail = meta[2] || '';
    const date = meta[3] || '';
    const message = meta.slice(4).join('\n');
    const subject = message.split('\n')[0] || '';

    const statRaw = await g.raw(['diff-tree', '--no-commit-id', '--numstat', '-r', hash]);
    const files: CommitFileInfo[] = [];
    if (statRaw.trim()) {
      for (const line of statRaw.trim().split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        files.push({
          path: parts[2]!,
          status: 'modified' as CommitFileInfo['status'],
          additions: parseInt(parts[0]!, 10) || 0,
          deletions: parseInt(parts[1]!, 10) || 0,
        });
      }
    }

    const diff = await g.show([hash, '--patch', '--format=']);

    return {
      hash: commitHash,
      shortHash: commitHash.slice(0, 7),
      subject,
      message,
      author,
      authorEmail,
      date,
      relativeDate: relativeTime(date),
      branch,
      files,
      diff: diff || '',
    };
  }

  private async ensureRepo(repoPath: string): Promise<void> {
    if (!(await this.isRepo(repoPath))) {
      throw { error: 'Директория не является git-репозиторием', code: 'NOT_FOUND' };
    }
  }
}
