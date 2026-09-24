import { resolve, normalize, relative, isAbsolute, sep, join } from 'node:path';
import { stat, readdir, open } from 'node:fs/promises';
import { FsErrorCode } from '@itphx/synth-shared';
import type { FsError, FileEntry } from '@itphx/synth-shared';

/**
 * AD-075: результат валидации/нормализации `project.workspace` для managed-режима.
 * Успех возвращает относительный (внутри `workspacesRoot`) workspace; ошибка —
 * HTTP-статус и код для ответа API (`VALIDATION_ERROR` / `WORKSPACE_OUTSIDE_ROOT_DENIED`).
 */
export type WorkspacePathValidation =
  | { ok: true; workspace: string }
  | { ok: false; status: 400 | 403; code: string; message: string };

export class WorkspaceResolver {
  constructor(
    private workspaceRoot: string,
    private getProject: (projectId: string) => Promise<{ workspace?: string } | null>,
  ) {}

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * AD-075: резолв пути для `/fs/workspace-root*`.
   * Абсолютный путь нормализуется как есть (ведущий `/` не срезается вслепую),
   * относительный — от `workspaceRoot`. Containment — через `relative` с разделителем
   * `sep` (соседний каталог `rootfoo` не считается внутри root).
   * - внутри root → абсолютный путь;
   * - абсолютный вне root (managed) → `WORKSPACE_OUTSIDE_ROOT_DENIED`;
   * - относительный traversal `..` за root → `PATH_TRAVERSAL`.
   */
  resolveRootPath(requestedPath: string): string {
    const trimmed = (requestedPath ?? '').trim();
    const absoluteRequest = isAbsolute(trimmed);
    const fullPath = absoluteRequest
      ? normalize(trimmed)
      : resolve(this.workspaceRoot, trimmed || '.');

    const rel = relative(this.workspaceRoot, fullPath);
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (outside) {
      const err: FsError = absoluteRequest
        ? { error: 'Путь вне корня workspace запрещён политикой',
          code: FsErrorCode.WORKSPACE_OUTSIDE_ROOT_DENIED }
        : { error: 'Попытка выхода за пределы корневого каталога',
          code: FsErrorCode.PATH_TRAVERSAL };
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
    requestedPath: string,
    includeHidden: boolean = false,
  ): Promise<FileEntry[]> {
    const dirPath = this.resolveRootPath(requestedPath);
    // Внутри root всегда отдаём относительный базис (абсолютный вход тоже
    // нормализуется в относительный — см. resolveRootPath).
    const relBase = relative(this.workspaceRoot, dirPath);

    let s;
    try {
      s = await stat(dirPath);
    } catch {
      const err: FsError = { error: `Директория не найдена: ${requestedPath || '/'}`, code: FsErrorCode.NOT_FOUND };
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
        path: relBase ? `${relBase}/${entry.name}` : entry.name,
        isDirectory: true,
        size: 0,
        modifiedAt,
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * AD-075: создание каталога в корне workspace. Паритет с core — при уже
   * существующем пути бросаем `ALREADY_EXISTS` (409), новый каталог → 201.
   */
  async createRootDirectory(requestedPath: string): Promise<void> {
    const { mkdir } = await import('node:fs/promises');
    const dirPath = this.resolveRootPath(requestedPath);

    const existing = await stat(dirPath).catch(() => null);
    if (existing) {
      const err: FsError = {
        error: existing.isDirectory() ? 'Директория уже существует' : 'Файл с таким именем уже существует',
        code: FsErrorCode.ALREADY_EXISTS,
      };
      throw err;
    }

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

  /**
   * AD-075: валидация и нормализация `project.workspace` для managed-режима.
   * - относительный путь внутри `workspacesRoot` → нормализуется, возвращается как есть;
   * - абсолютный путь внутри `workspacesRoot` → нормализуется в относительный;
   * - абсолютный путь вне `workspacesRoot` (или traversal) → жёсткий deny (403).
   * Ведущий `/` больше не срезается вслепую: абсолютные пути проверяются на
   * containment относительно корня (иначе `/etc` превращался в `etc` внутри root).
   */
  validateWorkspacePath(input: string): WorkspacePathValidation {
    const trimmed = (input ?? '').trim();
    if (!trimmed) {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Путь не может быть пустым' };
    }

    // Абсолютный путь: containment относительно корня, при попадании — в относительный.
    if (isAbsolute(trimmed)) {
      const abs = normalize(trimmed);
      const rel = relative(this.workspaceRoot, abs);
      if (rel === '') {
        return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Нельзя выбрать корневой каталог' };
      }
      if (rel.startsWith('..') || rel.startsWith(`${sep}..`) || isAbsolute(rel)) {
        return {
          ok: false,
          status: 403,
          code: 'WORKSPACE_OUTSIDE_ROOT_DENIED',
          message: 'Абсолютный workspace вне workspacesRoot запрещён политикой',
        };
      }
      return { ok: true, workspace: rel };
    }

    const normalized = normalize(trimmed).replace(/^[/\\]+/, '');
    if (!normalized || normalized === '.') {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Путь не может быть пустым' };
    }

    const fullPath = resolve(this.workspaceRoot, normalized);
    const rel = relative(this.workspaceRoot, fullPath);

    if (rel.startsWith('..') || rel.startsWith(`${sep}..`) || isAbsolute(rel)) {
      return {
        ok: false,
        status: 403,
        code: 'WORKSPACE_OUTSIDE_ROOT_DENIED',
        message: 'Путь выходит за пределы разрешённого корневого каталога',
      };
    }
    if (rel === '') {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Нельзя выбрать корневой каталог' };
    }

    return { ok: true, workspace: rel };
  }

  /**
   * Определяет, является ли файл текстовым (utf-8/utf-16) или бинарным.
   * 1. Быстрый путь: известные текстовые расширения и типовые имена без расширения.
   * 2. Быстрый путь: известные бинарные расширения.
   * 3. Надёжный путь: чтение первых байт и поиск NUL-байта (с учётом BOM UTF-16).
   */
  static async isTextFile(filePath: string): Promise<boolean> {
    const filename = filePath.split(/[\\/]/).pop() ?? filePath;
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();

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
    if (textExtensions.has(ext)) return true;

    // Типовые имена без расширения или с «точечным» именем
    const knownTextNames = new Set([
      'makefile', 'dockerfile', 'license', 'licence', 'readme', 'changelog',
      'copying', 'notice', 'authors', 'contributors', 'todo', 'notes',
      '.npmrc', '.yarnrc', '.babelrc', '.eslintrc', '.prettierrc',
      '.dockerignore', '.gitignore', '.gitattributes', '.editorconfig',
      'gemfile', 'rakefile', 'procfile', 'vagrantfile',
    ]);
    if (knownTextNames.has(filename.toLowerCase())) return true;

    // Заведомо бинарные расширения (не дожидаясь чтения содержимого)
    const binaryExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz', '.zst',
      '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.ogg', '.flac', '.webm',
      '.woff', '.woff2', '.ttf', '.otf', '.eot',
      '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
      '.class', '.jar', '.o', '.obj', '.a', '.pyc',
      '.wasm', '.iso', '.img',
    ]);
    if (binaryExtensions.has(ext)) return false;

    // Надёжный путь: проверяем первые байты содержимого
    try {
      const handle = await open(filePath, 'r');
      try {
        const buf = Buffer.alloc(8000);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead);

        // UTF-16 BOM (LE: FF FE, BE: FE FF)
        const isUtf16Bom = head.length >= 2 && (
          (head[0] === 0xff && head[1] === 0xfe) ||
          (head[0] === 0xfe && head[1] === 0xff)
        );
        if (isUtf16Bom) return true;

        // Наличие NUL-байта — признак бинарного файла
        return !head.includes(0);
      } finally {
        await handle.close();
      }
    } catch {
      // Не удалось прочитать — считаем текстовым (обратная совместимость)
      return true;
    }
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
