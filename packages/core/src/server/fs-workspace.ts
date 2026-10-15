import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { open, stat } from 'node:fs/promises';
import type { FsError, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { FsErrorCode } from '@itphx/synth-shared';

/**
 * ADR-075: единая (core) реализация резолва workspace проекта и детекта
 * бинарных файлов для FS-эндпоинтов. Перенесено из backend
 * (`routes/fs.ts`/`lib/workspace-resolver.ts`) в рамках унификации: backend
 * монтирует core-`createFsRoutes` и передаёт `getProjectWorkspace`.
 */

/** FsError-форма для броска из хелперов (`{ error, code }`). */
function fsError(code: FsErrorCode, error: string): FsError {
  return { error, code };
}

export interface ResolveProjectWorkspaceOptions {
  /** Корень managed-каталогов workspace (абсолютный или относительный — нормализуется). */
  workspacesRoot: string;
  /** Загрузка проекта (структурно совместимо с core/backend ProjectStore). */
  getProject: (projectId: string) => Promise<{ workspace?: string } | null>;
  /**
   * Политика путей вне `workspacesRoot`: `deny` (managed — 403), иначе абсолютный
   * workspace вне root разрешается (standalone, ADR-075). По умолчанию — `deny`.
   */
  outsideRootPolicy?: () => WorkspaceOutsideRootPolicy;
  /**
   * `true` (managed) — ошибки отсутствия проекта/workspace/каталога бросаются
   * `FsError`; `false` (standalone) — возвращается `null` (fallback на плоский root).
   */
  strict?: boolean;
}

/**
 * ADR-075: резолв абсолютного каталога workspace проекта.
 * - относительный `project.workspace` → от `workspacesRoot`;
 * - абсолютный внутри root → как есть; вне root — по политике (`deny` → 403);
 * - containment через `relative` (соседний `rootfoo` не считается внутри root).
 */
export async function resolveProjectWorkspace(
  projectId: string,
  opts: ResolveProjectWorkspaceOptions,
): Promise<string | null> {
  const strict = opts.strict === true;

  const project = await opts.getProject(projectId);
  if (!project) {
    if (strict) throw fsError(FsErrorCode.NOT_FOUND, 'Проект не найден');
    return null;
  }

  const workspace = project.workspace;
  if (!workspace) {
    if (strict) throw fsError(FsErrorCode.WORKSPACE_NOT_SET, 'Workspace не задан для проекта');
    return null;
  }

  const root = resolve(opts.workspacesRoot);
  const wsPath = isAbsolute(workspace) ? normalize(workspace) : resolve(root, workspace);

  const inside = wsPath === root || wsPath.startsWith(root.endsWith(sep) ? root : root + sep);
  if (!inside) {
    const policy = opts.outsideRootPolicy?.() ?? 'deny';
    if (policy === 'deny') {
      throw fsError(
        FsErrorCode.PATH_TRAVERSAL,
        'Workspace проекта выходит за пределы разрешённого корня',
      );
    }
  }

  let s;
  try {
    s = await stat(wsPath);
  } catch {
    if (strict) throw fsError(FsErrorCode.WORKSPACE_NOT_FOUND, `Workspace не найден: ${wsPath}`);
    return null;
  }
  if (!s.isDirectory()) {
    if (strict) throw fsError(FsErrorCode.NOT_A_DIRECTORY, 'Workspace не является директорией');
    return null;
  }

  return wsPath;
}

/**
 * Определяет, является ли файл текстовым (utf-8/utf-16) или бинарным.
 * 1. Быстрый путь: известные текстовые расширения и типовые имена без расширения.
 * 2. Быстрый путь: известные бинарные расширения.
 * 3. Надёжный путь: чтение первых байт и поиск NUL-байта (с учётом BOM UTF-16).
 */
export async function isTextFile(filePath: string): Promise<boolean> {
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
