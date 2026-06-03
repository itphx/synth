import { resolve, normalize, relative, sep, join } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { FsErrorCode } from '@synth/shared';
import type { FsError, FileEntry } from '@synth/shared';

export class WorkspaceResolver {
  constructor(
    private workspaceRoot: string,
    private getProject: (projectId: string) => Promise<{ workspace?: string } | null>,
  ) {}

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  resolveRootPath(requestedPath: string): string {
    const normalized = normalize(requestedPath).replace(/^[/\\]+/, '');
    const fullPath = resolve(this.workspaceRoot, normalized);

    const rel = relative(this.workspaceRoot, fullPath);
    if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
      const err: FsError = { error: 'Попытка выхода за пределы корневого каталога', code: FsErrorCode.PATH_TRAVERSAL };
      throw err;
    }

    return fullPath;
  }

  async listRootEntries(includeHidden: boolean = false): Promise<FileEntry[]> {
    await this._ensureWorkspaceRoot();
    const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (!entry.isDirectory()) continue;

      let modifiedAt = 0;
      try {
        const s = await stat(join(this.workspaceRoot, entry.name));
        modifiedAt = s.mtimeMs;
      } catch { /* ignore */ }

      result.push({
        name: entry.name,
        path: entry.name,
        isDirectory: true,
        size: 0,
        modifiedAt,
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listRootSubDirectory(
    relPath: string,
    includeHidden: boolean = false,
  ): Promise<FileEntry[]> {
    const dirPath = this.resolveRootPath(relPath);

    let s;
    try {
      s = await stat(dirPath);
    } catch {
      const err: FsError = { error: `Директория не найдена: ${relPath}`, code: FsErrorCode.NOT_FOUND };
      throw err;
    }
    if (!s.isDirectory()) {
      const err: FsError = { error: 'Путь не является директорией', code: FsErrorCode.NOT_A_DIRECTORY };
      throw err;
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (!entry.isDirectory()) continue;

      let modifiedAt = 0;
      try {
        const st = await stat(join(dirPath, entry.name));
        modifiedAt = st.mtimeMs;
      } catch { /* ignore */ }

      result.push({
        name: entry.name,
        path: relPath ? `${relPath}/${entry.name}` : entry.name,
        isDirectory: true,
        size: 0,
        modifiedAt,
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createRootDirectory(relPath: string): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    const dirPath = this.resolveRootPath(relPath);
    await mkdir(dirPath, { recursive: true });
  }

  async resolve(projectId: string): Promise<string> {
    const project = await this.getProject(projectId);
    if (!project) {
      const err: FsError = { error: 'Проект не найден', code: FsErrorCode.NOT_FOUND };
      throw err;
    }
    if (!project.workspace) {
      const err: FsError = { error: 'Workspace не задан для проекта', code: FsErrorCode.WORKSPACE_NOT_SET };
      throw err;
    }

    const wsPath = resolve(this.workspaceRoot, project.workspace);

    const rel = relative(this.workspaceRoot, wsPath);
    if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
      const err: FsError = { error: 'Workspace проекта выходит за пределы разрешённого корня',
        code: FsErrorCode.PATH_TRAVERSAL };
      throw err;
    }

    try {
      const s = await stat(wsPath);
      if (!s.isDirectory()) {
        const err: FsError = { error: 'Workspace не является директорией', code: FsErrorCode.NOT_A_DIRECTORY };
        throw err;
      }
    } catch {
      const err: FsError = { error: `Workspace не найден: ${wsPath}`, code: FsErrorCode.WORKSPACE_NOT_FOUND };
      throw err;
    }

    return wsPath;
  }

  resolveSafePath(workspace: string, requestedPath: string): string {
    const normalizedRequest = normalize(requestedPath).replace(/^[/\\]+/, '');
    const fullPath = resolve(workspace, normalizedRequest);

    // Проверка что путь внутри workspace
    const rel = relative(workspace, fullPath);
    if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
      const err: FsError = { error: 'Попытка выхода за пределы workspace', code: FsErrorCode.PATH_TRAVERSAL };
      throw err;
    }

    return fullPath;
  }

  validateWorkspacePath(relativePath: string): string | null {
    const normalized = normalize(relativePath).replace(/^[/\\]+/, '');
    if (!normalized) return 'Путь не может быть пустым';

    const fullPath = resolve(this.workspaceRoot, normalized);
    const rel = relative(this.workspaceRoot, fullPath);

    if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
      return 'Путь выходит за пределы разрешённого корневого каталога';
    }
    if (rel === '') {
      return 'Нельзя выбрать корневой каталог';
    }

    return null;
  }

  static isTextFile(filename: string): boolean {
    const textExtensions = new Set([
      '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
      '.py', '.rb', '.rs', '.go', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
      '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
      '.sh', '.bash', '.zsh', '.fish',
      '.sql', '.graphql', '.gql',
      '.env', '.gitignore', '.dockerignore', '.editorconfig',
      '.vue', '.svelte', '.astro',
      '.php', '.lua', '.r', '.pl', '.pm',
      '.prisma', '.proto',
      '.csv', '.log',
    ]);

    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return textExtensions.has(ext);
  }

  private async _ensureWorkspaceRoot(): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    try {
      await mkdir(this.workspaceRoot, { recursive: true });
    } catch { /* уже существует */ }
  }

  async moveEntry(projectId: string, sourcePath: string, targetPath: string): Promise<void> {
    const { rename: fsRename, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');

    const workspace = await this.resolve(projectId);
    const src = this.resolveSafePath(workspace, sourcePath);
    const dst = this.resolveSafePath(workspace, targetPath);

    // Проверяем что источник существует
    try {
      await stat(src);
    } catch {
      const err: FsError = { error: `Источник не найден: ${sourcePath}`, code: FsErrorCode.NOT_FOUND };
      throw err;
    }

    // Проверяем что целевая директория существует
    const targetDir = dirname(dst);
    try {
      await stat(targetDir);
    } catch {
      await mkdir(targetDir, { recursive: true });
    }

    await fsRename(src, dst);
  }
}
