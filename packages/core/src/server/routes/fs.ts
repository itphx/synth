import { createReadStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { FileEntry, FsError, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import {
  FsErrorCode,
  fsWorkspaceBrowseQuerySchema,
  fsWorkspaceMkdirBodySchema,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_PREVIEW_BYTES,
  MAX_FS_LIST_DEPTH,
  MAX_FS_LIST_ENTRIES,
  fileKind,
  fileMime,
  INLINE_PREVIEW_KINDS,
} from '@itphx/synth-shared';
import { checkPath, loadProtectedPaths } from '../../engine/security/protected-paths.js';
import type { ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';
import { isInsideReal } from '../../engine/tools/path-utils.js';
import { isTextFile } from '../fs-workspace.js';
import { isRemoteRef, toLocalId, remoteErrorToHttp } from '../../remote/aggregate.js';
import type { RemoteBackendClient } from '../../remote/client.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики (структурно совместим с core/backend AuthKit). */
export interface FsRoutesAuth {
  requireAuth: Middleware;
}

/**
 * ADR-075: опции FS-роутов core (standalone) для паритета с backend.
 * Позиционный `workspacesRoot` остаётся обратносовместимым; здесь — мягкая
 * политика путей вне root, защищённые пути и project-aware режим.
 */
export interface FsRoutesOptions {
  /**
   * Политика для путей вне `workspacesRoot`: `confirm` (standalone — browse
   * разрешён, mkdir требует `confirmOutsideRoot`), `deny` (managed — 403).
   * По умолчанию — `confirm`.
   */
  getOutsideRootPolicy?: () => WorkspaceOutsideRootPolicy;
  /**
   * Политика защищённых путей (`ProtectedPathsStore.getPolicy`). Не задана —
   * загружается системная политика + пользовательский override.
   */
  getProtectedPathsPolicy?: () => ProtectedPathsPolicy;
  /**
   * ADR-075: project-aware режим. Возвращает абсолютный каталог workspace проекта
   * или `null` (standalone — fallback на плоский root). Может бросить `FsError`
   * (managed: проект/workspace не найдены, нарушение containment). Задано и
   * передан `project_id` → базой эндпоинтов (кроме `/workspace-root*`) становится
   * workspace проекта, иначе — плоский root. Гибридные `remote:`-ref'ы
   * обрабатываются отдельно (до резолва).
   */
  getProjectWorkspace?: (projectId: string) => Promise<string | null>;
  /** Managed: `project_id` обязателен — без него 400 (паритет с backend). */
  requireProjectId?: boolean;
  /**
   * ADR-089 (P0): проверка доступа к проекту для project-aware эндпоинтов
   * (managed RBAC; образец — `createGitRoutes.authorizeProject`). Вызывается,
   * когда задан `getProjectWorkspace` и передан `project_id`; `false` → 403
   * `FORBIDDEN` (существование проекта не раскрывается отдельно от доступа).
   * Паритет чтение/запись определяет сама проверка (обычно по `c.req.method`).
   * Не задана (standalone) — поведение прежнее.
   */
  authorizeProject?: (c: Context, projectId: string) => Promise<boolean>;
  /**
   * Максимальный размер загружаемого файла (`POST /upload`), в байтах.
   * Не задан — `DEFAULT_MAX_UPLOAD_BYTES` (100 МиБ); точки монтирования
   * (standalone/backend) передают сюда `resolveMaxUploadBytes(config)`.
   * Проверяется до чтения тела (по `content-length` и размеру `File`) и
   * повторно по фактическому размеру прочитанных байт — защита от обхода/лжи
   * в `content-length`.
   */
  maxUploadBytes?: number;
  /**
   * Максимальный размер файла, отдаваемого `GET /read`, в байтах.
   * Не задан — `DEFAULT_MAX_READ_BYTES` (5 МиБ); точки монтирования
   * (standalone/backend) передают сюда `resolveMaxReadBytes(config)`.
   * Проверяется по `stat` **до** чтения содержимого: файл больше лимита
   * (или бинарный) → `413` с машинным кодом `FILE_TOO_LARGE` и
   * `details.maxReadBytes`.
   */
  maxReadBytes?: number;
  /**
   * Максимальный размер файла, отдаваемого `GET /raw` (предпросмотр медиа),
   * в байтах. Не задан — `DEFAULT_MAX_PREVIEW_BYTES` (100 МиБ); точки монтирования
   * (standalone/backend) передают сюда `resolveMaxPreviewBytes(config)`.
   * Проверяется по `stat` **до** чтения байт: файл больше лимита → `413` с
   * машинным кодом `FILE_TOO_LARGE` и `details.maxPreviewBytes`.
   */
  maxPreviewBytes?: number;
  /**
   * Общий предел числа записей в рекурсивном листинге (`GET /?maxDepth>0`).
   * Не задан — `MAX_FS_LIST_ENTRIES` (10 000); при достижении предела обход
   * прекращается, в ответе `truncated: true`.
   */
  maxListEntries?: number;
  /**
   * ADR-118 §4 / ADR-095: HTTP-мутация workspace состоялась — уведомить сессии
   * проекта событием `fs.changed` (дерево Files, редакторы, Git-вкладка). Payload
   * тот же, что у мутирующих инструментов (`op`/`paths`/`from`/`to`), источник —
   * HTTP. Вызывается только для project-aware операций (есть `project_id`);
   * `scope: 'file'` — изменение конкретного пути/путей.
   */
  onFsChanged?: (projectId: string, change: FsChangedChange) => void | Promise<void>;
}

/** Изменение workspace для `FsRoutesOptions.onFsChanged` (форма — как у тулов). */
export interface FsChangedChange {
  scope: 'file' | 'all';
  paths?: string[];
  op?: 'write' | 'delete' | 'mkdir' | 'move';
  from?: string;
  to?: string;
}

type FsHttpStatus = 400 | 403 | 404 | 409 | 413 | 422 | 500;

/**
 * Лимит загрузки файла по умолчанию (`POST /upload`), в байтах: щедро, но
 * ограничивает DoS (тело буферизуется в память целиком). Константа живёт в
 * `@itphx/synth-shared` (чтобы config-схема и core-дефолт не расходились);
 * реэкспорт сохраняет прежний публичный импорт из `@itphx/synth-core`.
 * Эффективный лимит: конфиг/env (`resolveMaxUploadBytes`) → эта опция фабрики
 * `FsRoutesOptions.maxUploadBytes` (для тестов) → `DEFAULT_MAX_UPLOAD_BYTES`.
 */
export { DEFAULT_MAX_UPLOAD_BYTES };

/**
 * Лимит чтения файла (`GET /read`) по умолчанию, в байтах: 5 МиБ.
 * Константа живёт в `@itphx/synth-shared` (чтобы config-схема и core-дефолт
 * не расходились); реэкспорт сохраняет прежний публичный импорт из
 * `@itphx/synth-core`.
 * Эффективный лимит: конфиг/env (`resolveMaxReadBytes`) → эта опция фабрики
 * `FsRoutesOptions.maxReadBytes` (для тестов) → `DEFAULT_MAX_READ_BYTES`.
 */
export { DEFAULT_MAX_READ_BYTES };

/**
 * Лимит предпросмотра файла (`GET /raw`) по умолчанию, в байтах: 100 МиБ.
 * Константа живёт в `@itphx/synth-shared` (чтобы config-схема и core-дефолт
 * не расходились); реэкспорт сохраняет публичный импорт из `@itphx/synth-core`.
 * Эффективный лимит: конфиг/env (`resolveMaxPreviewBytes`) → эта опция фабрики
 * `FsRoutesOptions.maxPreviewBytes` (для тестов) → `DEFAULT_MAX_PREVIEW_BYTES`.
 */
export { DEFAULT_MAX_PREVIEW_BYTES };

/** FsError-форма (`{ error: { error, code } }`) — единый формат ошибок FS. */
function makeFsError(code: string, error: string): { error: FsError } {
  return { error: { error, code: code as FsErrorCode } };
}

/**
 * FsError-форма с подробностями (`details`) — машиночитаемый отказ:
 * клиент не разбирает текст сообщения.
 */
function makeFsErrorWithDetails(
  code: string,
  error: string,
  details: Record<string, unknown>,
): { error: FsError } {
  return { error: { error, code: code as FsErrorCode, details } };
}

/** Ошибка валидации тела/параметров (legacy-код backend `PERMISSION_DENIED`), HTTP 400. */
function validationError(message: string): { error: FsError } {
  return makeFsError(FsErrorCode.PERMISSION_DENIED, message);
}

/** Брошенный FsError — для хелперов резолва (ловится `fsErrorResponse`). */
function fsError(code: string, error: string): FsError {
  return { error, code: code as FsErrorCode };
}

/** Код FsError → HTTP-статус (паритет с backend). Неизвестный код → 500. */
const FS_STATUS: Record<string, FsHttpStatus> = {
  NOT_FOUND: 404,
  WORKSPACE_NOT_FOUND: 400,
  WORKSPACE_NOT_SET: 400,
  NOT_A_DIRECTORY: 400,
  IS_DIRECTORY: 400,
  DIR_NOT_EMPTY: 400,
  VALIDATION_ERROR: 400,
  PERMISSION_DENIED: 400,
  ALREADY_EXISTS: 409,
  PATH_TRAVERSAL: 403,
  FORBIDDEN: 403,
  WORKSPACE_OUTSIDE_ROOT_DENIED: 403,
  WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED: 409,
  PROTECTED_PATH_DENIED: 403,
  WORKSPACE_CREATE_FAILED: 422,
  PAYLOAD_TOO_LARGE: 413,
  FILE_TOO_LARGE: 413,
};

/** Ответ на брошенную ошибку: FsError → по `FS_STATUS`, прочее → 500. */
function fsErrorResponse(c: Context, err: unknown): Response {
  const e = err as Partial<FsError> | undefined;
  if (e && typeof e.code === 'string') {
    const status = (FS_STATUS[e.code] ?? 500) as FsHttpStatus;
    const body: FsError = { error: e.error ?? e.code, code: e.code as FsErrorCode };
    if (e.details) body.details = e.details;
    return c.json({ error: body }, status);
  }
  return c.json(
    { error: { error: err instanceof Error ? err.message : String(err), code: FsErrorCode.PERMISSION_DENIED } },
    500,
  );
}

/** Преобразовать RemoteError в HTTP-ответ API v2; не-RemoteError → undefined (пробросить дальше). */
function mapRemoteError(c: Context, err: unknown): Response | undefined {
  const http = remoteErrorToHttp(err);
  if (!http) return undefined;
  return c.json(
    { error: { code: http.code, message: err instanceof Error ? err.message : String(err) } },
    http.status as 400 | 401 | 404 | 409 | 500 | 502,
  );
}

/** 502, если гибрид не настроен, иначе undefined — обрабатываем удалённую сессию. */
function remoteUnavailable(c: Context): Response | undefined {
  return c.json({ error: { code: 'REMOTE_UNAVAILABLE', message: 'Гибридный режим не настроен' } }, 502);
}

/** Резолвит путь относительно root и проверяет, что результат внутри root. */
function resolveSafe(root: string, p: string): string | null {
  const full = resolve(root, p || '');
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) return null;
  return full;
}

/** true, если `abs` лежит внутри `root` (сам root включительно). */
function isInsideRoot(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Резолв запрошенного пути: абсолютный — как есть, относительный — от `root`. */
function resolveAgainstRoot(root: string, p: string): string {
  const trimmed = (p || '').trim();
  if (!trimmed) return root;
  return isAbsolute(trimmed) ? normalize(trimmed) : resolve(root, trimmed);
}

/** true, если путь запрещён политикой защищённых путей (`checkPath` → deny). */
function isPathDenied(abs: string, cwd: string, policy: ProtectedPathsPolicy): boolean {
  return checkPath(abs, cwd, policy).action === 'deny';
}

/**
 * Разобранный диапазон байтов (`Range: bytes=…`).
 *
 * - `none` — заголовка нет/он неразборчив → сервер отдаёт файл целиком (200);
 * - `range` — диапазон в границах файла → `206 Partial Content`;
 * - `unsatisfiable` — диапазон за пределами файла → `416`.
 */
type ByteRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Разобрать заголовок `Range: bytes=…`.
 *
 * Поддерживаются `bytes=start-end`, `bytes=start-` (до конца файла) и
 * `bytes=-suffix` (последние N байт). Неразборчивый заголовок (в т.ч.
 * несколько диапазонов через запятую) игнорируется — файл отдаётся целиком.
 */
function parseByteRange(header: string | undefined, size: number): ByteRange {
  if (!header) return { kind: 'none' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'none' };
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return { kind: 'none' };
  if (size === 0) return { kind: 'unsatisfiable' };

  if (startRaw === '') {
    // `bytes=-suffix` — последние N байт файла.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'none' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start)) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };
  if (endRaw === '') return { kind: 'range', start, end: size - 1 };

  const end = Number(endRaw);
  if (!Number.isFinite(end)) return { kind: 'none' };
  if (end < start) return { kind: 'none' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

/** ETag файла — по размеру и времени модификации (содержимое не хешируем). */
function fileEtag(size: number, mtimeMs: number): string {
  return `"${size}-${Math.floor(mtimeMs)}"`;
}

/**
 * Совпадение `If-None-Match` с вычисленным ETag (без учёта префикса `W/`).
 * `*` — совпадает с любым текущим представлением.
 */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const tags = header.split(',').map((t) => t.trim()).filter((t) => t !== '');
  if (tags.includes('*')) return true;
  const strip = (t: string): string => (t.startsWith('W/') ? t.slice(2) : t);
  const target = strip(etag);
  return tags.some((t) => strip(t) === target);
}

/**
 * ADR-075 (managed): безопасный путь внутри workspace проекта (backend-семантика):
 * ведущие `/` срезаются, traversal за пределы workspace → `PATH_TRAVERSAL`.
 */
function resolveSafeInWorkspace(workspace: string, requestedPath: string): string {
  const normalizedRequest = normalize(requestedPath).replace(/^[/\\]+/, '');
  const fullPath = resolve(workspace, normalizedRequest);

  const rel = relative(workspace, fullPath);
  if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
    throw fsError(FsErrorCode.PATH_TRAVERSAL, 'Попытка выхода за пределы workspace');
  }
  return fullPath;
}

/** Плоский (standalone/legacy) резолв: текущий core-контракт — только внутри root. */
function resolveSafeInRoot(root: string, requestedPath: string): string {
  const full = resolveSafe(root, requestedPath);
  if (!full) throw fsError('FORBIDDEN', 'Доступ запрещён');
  return full;
}

/**
 * Containment с учётом симлинков: после лексической проверки путь не должен
 * вести за пределы базы через симлинк (иначе `link -> /etc` внутри workspace
 * обходил бы каталог). Неразрешимый путь — fail-closed (как выход за пределы).
 */
function assertRealContained(base: string, fullPath: string, projectAware: boolean): void {
  if (isInsideReal(base, fullPath)) return;
  if (projectAware) throw fsError(FsErrorCode.PATH_TRAVERSAL, 'Попытка выхода за пределы workspace');
  throw fsError('FORBIDDEN', 'Доступ запрещён');
}

/** Резолв пути от базы: project-aware (workspace проекта) либо плоский root. */
function resolveRequestedPath(base: string, requestedPath: string, projectAware: boolean): string {
  const full = projectAware
    ? resolveSafeInWorkspace(base, requestedPath)
    : resolveSafeInRoot(base, requestedPath);
  assertRealContained(base, full, projectAware);
  return full;
}

/**
 * Глубина рекурсии листинга (0 — только текущий каталог; максимум
 * `MAX_FS_LIST_DEPTH` = 3). Значение из запроса ограничивается жёстко —
 * глубокий обход каталога (и ответ на него) неконтролируемо растёт.
 */
function parseMaxDepth(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(n, MAX_FS_LIST_DEPTH);
}

/** Бюджет обхода листинга: остаток записей и признак усечения. */
interface ListBudget {
  /** Сколько записей ещё можно вернуть (≤ 0 — обход прекращается). */
  remaining: number;
  /** Обход прерван по лимиту записей. */
  truncated: boolean;
}

/**
 * Рекурсивный листинг (паритет с backend): dir-first, затем по имени.
 *
 * Бюджет (`remaining`) ограничивает общее число записей: при его исчерпании
 * обход прекращается, а `truncated` в ответе равен `true`. Бюджет задаётся
 * только при `maxDepth > 0` (при `maxDepth = 0` список не рекурсивный и
 * лимит не применяется).
 */
async function listDirectoryRecursive(
  absDir: string,
  relBase: string,
  maxDepth: number,
  includeHidden: boolean,
  currentDepth: number,
  budget: ListBudget,
): Promise<FileEntry[]> {
  if (currentDepth > maxDepth) return [];
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }

  const entries = await readdir(absDir, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }

    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    let modifiedAt = 0;
    let size = 0;

    try {
      const s = await stat(join(absDir, entry.name));
      modifiedAt = s.mtimeMs;
      size = s.size;
    } catch {
      // ignore stat errors
    }

    result.push({
      name: entry.name,
      path: relPath,
      isDirectory: entry.isDirectory(),
      size,
      modifiedAt,
    });
    budget.remaining -= 1;

    if (entry.isDirectory() && currentDepth < maxDepth) {
      const children = await listDirectoryRecursive(
        join(absDir, entry.name), relPath, maxDepth, includeHidden, currentDepth + 1, budget,
      );
      result.push(...children);
      if (budget.remaining <= 0) budget.truncated = true;
    }
  }

  return result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * ADR-075: подкаталоги директории (только `isDirectory`), отсортированные по имени.
 * Запрещённые policy-пути пропускаются (не показываются). `relBase` — база
 * относительного пути для элементов (относительно root или абсолютная для
 * путей вне root).
 */
async function listChildDirectories(
  absDir: string,
  relBase: string,
  includeHidden: boolean,
  cwd: string,
  policy: ProtectedPathsPolicy,
): Promise<FileEntry[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;
    const abs = join(absDir, entry.name);
    if (isPathDenied(abs, cwd, policy)) continue;
    let modifiedAt = 0;
    try {
      modifiedAt = (await stat(abs)).mtimeMs;
    } catch { /* ignore stat errors */ }
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

export function createFsRoutes(
  auth: FsRoutesAuth,
  workspacesRoot?: string,
  getRemoteClient?: () => RemoteBackendClient | null,
  opts: FsRoutesOptions = {},
): Hono {
  const app = new Hono();
  // Legacy-корень: как раньше (fallback process.cwd()), чтобы не менять поведение
  // существующих эндпоинтов при вызове фабрики без root.
  // ADR-075: нормализуем к абсолютному — иначе containment не работает при
  // относительном корне из конфига/env.
  const root = resolve(workspacesRoot || process.cwd());
  // ADR-075: новые `/workspace-root*` работают только с явно настроенным корнем —
  // process.cwd() как fallback здесь запрещён (см. workspacesRootOrError).
  const configuredRoot = workspacesRoot && workspacesRoot.trim() ? resolve(workspacesRoot) : undefined;
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  const outsideRootPolicy = (): WorkspaceOutsideRootPolicy => opts.getOutsideRootPolicy?.() ?? 'confirm';
  const protectedPaths = (): ProtectedPathsPolicy =>
    opts.getProtectedPathsPolicy ? opts.getProtectedPathsPolicy() : loadProtectedPaths();
  const getProjectWorkspace = opts.getProjectWorkspace;
  const requireProjectId = opts.requireProjectId === true;
  const authorizeProject = opts.authorizeProject;
  const maxUploadBytes =
    opts.maxUploadBytes && opts.maxUploadBytes > 0
      ? Math.floor(opts.maxUploadBytes)
      : DEFAULT_MAX_UPLOAD_BYTES;
  const maxReadBytes =
    opts.maxReadBytes && opts.maxReadBytes > 0
      ? Math.floor(opts.maxReadBytes)
      : DEFAULT_MAX_READ_BYTES;
  const maxPreviewBytes =
    opts.maxPreviewBytes && opts.maxPreviewBytes > 0
      ? Math.floor(opts.maxPreviewBytes)
      : DEFAULT_MAX_PREVIEW_BYTES;
  const maxListEntries =
    opts.maxListEntries && opts.maxListEntries > 0
      ? Math.floor(opts.maxListEntries)
      : MAX_FS_LIST_ENTRIES;
  const onFsChanged = opts.onFsChanged;
  /** Уведомить сессии проекта об изменении workspace (только project-aware). */
  const notifyFsChanged = async (
    projectId: string | undefined,
    change: FsChangedChange,
  ): Promise<void> => {
    if (!projectId || !onFsChanged) return;
    await onFsChanged(projectId, change);
  };

  /** 413 `PAYLOAD_TOO_LARGE` — единый ответ на превышение лимита загрузки. */
  const payloadTooLarge = (c: Context): Response =>
    c.json(
      makeFsError('PAYLOAD_TOO_LARGE', `Файл превышает лимит загрузки (${maxUploadBytes} байт)`),
      413,
    );

  /**
   * Managed-режим (`requireProjectId`) не использует выбор workspace: каталог
   * проекта авто-провижнится (ADR-075), UI-пикер скрыт. Роуты `/workspace-root*`
   * там раскрывали бы перечень управляемых workspace всех проектов (имена/mtime/
   * size) и позволяли создавать каталоги в чужих; и `project_id` у них по дизайну
   * нет, поэтому `ensureProjectAccess` не срабатывает. Fail-closed → 403 `FORBIDDEN`
   * (паритет с отказом по доступу к проекту). В standalone (`requireProjectId`
   * не задан) поведение прежнее.
   */
  const managedWorkspaceRootDisabled = (c: Context): Response | null => {
    if (!requireProjectId) return null;
    return c.json(
      makeFsError('FORBIDDEN', 'Выбор рабочего каталога недоступен в managed-режиме'),
      403,
    );
  };

  /** ADR-089 (P0): нет доступа к проекту → 403 `FORBIDDEN` (fail-closed). */
  const ensureProjectAccess = async (c: Context, projectId: string): Promise<void> => {
    if (!authorizeProject) return;
    const allowed = await authorizeProject(c, projectId).catch(() => false);
    if (!allowed) throw fsError('FORBIDDEN', 'Доступ к проекту запрещён');
  };

  /**
   * База для path-эндпоинтов: workspace проекта (project-aware) либо плоский root.
   * Managed (`requireProjectId`) без `project_id` → 400; standalone без проекта → root.
   * ADR-089 (P0): project-aware ветка сначала проверяет доступ к проекту (403).
   */
  const resolveBase = async (
    c: Context,
    projectId: string | undefined,
  ): Promise<{ base: string; projectAware: boolean }> => {
    if (getProjectWorkspace && projectId) {
      await ensureProjectAccess(c, projectId);
      const dir = await getProjectWorkspace(projectId);
      if (dir) return { base: dir, projectAware: true };
      if (requireProjectId) throw fsError(FsErrorCode.WORKSPACE_NOT_SET, 'Workspace не задан для проекта');
      return { base: root, projectAware: false };
    }
    if (requireProjectId) throw fsError(FsErrorCode.PERMISSION_DENIED, 'project_id обязателен');
    return { base: root, projectAware: false };
  };

  /** Корень для новых `/workspace-root*`; без настроенного root — 500. */
  const workspacesRootOrError = (c: Context): string | Response => {
    if (!configuredRoot) {
      return c.json(
        makeFsError('WORKSPACE_ROOT_NOT_CONFIGURED', 'Корневой каталог workspace не настроен'),
        500,
      );
    }
    return configuredRoot;
  };

  // GET / — список файлов в директории
  app.get('/', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const projectId = c.req.query('project_id');
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.fsList({ projectId: toLocalId(projectId), path: c.req.query('path') || '' });
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const { base, projectAware } = await resolveBase(c, projectId);
      const path = c.req.query('path') || '';
      const includeHidden = c.req.query('includeHidden') === 'true';
      const maxDepth = parseMaxDepth(c.req.query('maxDepth'));
      // Лимит записей применяется только к рекурсивному листингу
      // (`maxDepth > 0`): при `maxDepth = 0` список не рекурсивный.
      const budget: ListBudget = {
        remaining: maxDepth > 0 ? maxListEntries : Number.MAX_SAFE_INTEGER,
        truncated: false,
      };
      const fullPath = resolveRequestedPath(base, path, projectAware);

      const s = await stat(fullPath).catch(() => null);
      if (!s) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Путь не найден: ${path || '/'}`), 404);
      }
      if (!s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.NOT_A_DIRECTORY, 'Указанный путь не является директорией'), 400);
      }

      const entries = await listDirectoryRecursive(
        fullPath,
        path,
        maxDepth,
        includeHidden,
        0,
        budget,
      );
      return c.json({ path: path || '/', entries, truncated: budget.truncated });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // GET /read — содержимое файла
  app.get('/read', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const projectId = c.req.query('project_id');
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.fsRead({ projectId: toLocalId(projectId), path: c.req.query('path') || '' });
        return c.json(result);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const { base, projectAware } = await resolveBase(c, projectId);
      const path = c.req.query('path') || '';
      if (projectAware && !path) {
        return c.json(validationError('Ожидается поле path'), 400);
      }

      const fullPath = resolveRequestedPath(base, path, projectAware);
      const s = await stat(fullPath).catch(() => null);
      if (!s) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Файл не найден: ${path}`), 404);
      }
      if (s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.IS_DIRECTORY, 'Указанный путь является директорией'), 400);
      }

      // Cap чтения: размер известен из `stat` — содержимое в память не читаем.
      if (s.size > maxReadBytes) {
        return c.json(
          makeFsErrorWithDetails(
            FsErrorCode.FILE_TOO_LARGE,
            `Файл превышает лимит чтения (${maxReadBytes} байт)`,
            { maxReadBytes, size: s.size, reason: 'size' },
          ),
          413,
        );
      }

      if (!(await isTextFile(fullPath))) {
        // Бинарный файл содержимое не отдаём: тот же отказ, что и для большого
        // (машинный код `FILE_TOO_LARGE`), причина — в `details.reason`.
        return c.json(
          makeFsErrorWithDetails(
            FsErrorCode.FILE_TOO_LARGE,
            'Бинарный файл не читается через HTTP',
            { maxReadBytes, size: s.size, reason: 'binary' },
          ),
          413,
        );
      }
      const content = await readFile(fullPath, 'utf-8');
      return c.json({ path, content, size: s.size, encoding: 'utf-8' });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // POST /write — запись файла
  app.post('/write', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => null);
    const projectIdRaw = body?.projectId || body?.project_id;
    const projectId = typeof projectIdRaw === 'string' ? projectIdRaw : undefined;
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.fsWrite({
          projectId: toLocalId(projectId),
          path: body?.path,
          content: body?.content,
        });
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const path = body?.path;
      const content = body?.content;
      if (typeof path !== 'string' || !path || typeof content !== 'string') {
        return c.json(validationError('Ожидаются поля path и content'), 400);
      }

      const { base, projectAware } = await resolveBase(c, projectId);
      const fullPath = resolveRequestedPath(base, path, projectAware);

      await mkdir(join(fullPath, '..'), { recursive: true }).catch(() => {});
      await writeFile(fullPath, content, 'utf-8');
      const s = await stat(fullPath);
      await notifyFsChanged(projectId, { scope: 'file', paths: [path], op: 'write' });
      return c.json({ path, content, size: s.size, encoding: 'utf-8' }, 200);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // POST /upload — загрузка файла (multipart)
  app.post('/upload', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();

    // DoS-защита: отклоняем по заявленному `content-length` до чтения тела
    // (`formData()` буферизует весь запрос в память). Отсутствие/некорректный
    // заголовок не пропускает дальше без проверки — ниже есть проверки размера.
    const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      return payloadTooLarge(c);
    }

    const formData = await c.req.formData();
    const projectIdField = formData.get('project_id');
    const projectId = typeof projectIdField === 'string' ? projectIdField : undefined;

    // Ранняя проверка размера файла (`File.size`) — до `arrayBuffer()`.
    const rawUploadField = formData.get('file');
    const uploadField = Array.isArray(rawUploadField) ? rawUploadField[0] : rawUploadField;
    const declaredFileSize =
      uploadField && typeof uploadField !== 'string'
        ? (uploadField as { size?: unknown }).size
        : undefined;
    if (typeof declaredFileSize === 'number' && declaredFileSize > maxUploadBytes) {
      return payloadTooLarge(c);
    }

    // Гибрид: файлы удалённого проекта загружаются на backend (multipart as есть).
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const fd = new FormData();
        for (const [k, v] of formData.entries()) {
          fd.set(k, k === 'project_id' ? toLocalId(String(v)) : v);
        }
        const result = await remoteClient.fsUpload(fd);
        return c.json(result, 201);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const dirPath = typeof formData.get('path') === 'string' ? String(formData.get('path')) : '';
      const rawFile = formData.get('file');
      const uploaded = Array.isArray(rawFile) ? rawFile[0] : rawFile;

      if (!uploaded || typeof uploaded === 'string') {
        return c.json(validationError('Файл не передан'), 400);
      }

      const { base, projectAware } = await resolveBase(c, projectId);
      const targetDir = resolveRequestedPath(base, dirPath, projectAware);

      const rawName = (uploaded as { name?: string }).name;
      const fileName = basename(rawName || 'uploaded-file');
      const targetPath = join(targetDir, fileName);
      assertRealContained(base, targetPath, projectAware);

      await mkdir(join(targetPath, '..'), { recursive: true }).catch(() => {});

      let data: ArrayBuffer;
      if (typeof (uploaded as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
        data = await (uploaded as File).arrayBuffer();
      } else {
        return c.json(validationError('Неподдерживаемый тип файла'), 400);
      }

      // Фактический размер прочитанных байт — защита от обхода через лживый/
      // отсутствующий `content-length` (chunked-тело).
      if (data.byteLength > maxUploadBytes) {
        return payloadTooLarge(c);
      }

      await writeFile(targetPath, new Uint8Array(data));
      const uploadedPath = relative(base, targetPath);
      await notifyFsChanged(projectId, { scope: 'file', paths: [uploadedPath], op: 'write' });
      return c.json({ path: uploadedPath, name: fileName }, 201);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // GET /download — скачивание файла
  app.get('/download', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const projectId = c.req.query('project_id');
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        return await remoteClient.fsDownload(
          { projectId: toLocalId(projectId), path: c.req.query('path') || '' },
          { signal: c.req.raw.signal },
        );
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const { base, projectAware } = await resolveBase(c, projectId);
      const path = c.req.query('path') || '';
      if (projectAware && !path) {
        return c.json(validationError('Ожидается поле path'), 400);
      }

      const fullPath = resolveRequestedPath(base, path, projectAware);
      const s = await stat(fullPath).catch(() => null);
      if (!s) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Файл не найден: ${path}`), 404);
      }
      if (s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.IS_DIRECTORY, 'Нельзя скачать директорию'), 400);
      }

      const fileName = basename(fullPath);
      const fileStream = createReadStream(fullPath);
      const webStream = Readable.toWeb(fileStream) as ReadableStream;

      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          'Content-Length': String(s.size),
        },
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // GET /raw — предпросмотр файла (медиа/изображения/PDF): байты потоком.
  //
  // Отличие от `/read` (текст) и `/download` (вложение): отдаёт **inline** с
  // корректным MIME, поддерживает `Range`/`206` (seek в видео) и `ETag`/`304`.
  //
  // Inline-allowlist — `INLINE_PREVIEW_KINDS` (image/video/audio/pdf): всё
  // остальное (в т.ч. `text/html`) отдаётся как `application/octet-stream` +
  // `attachment`, иначе HTML исполнился бы в origin приложения (XSS).
  app.get('/raw', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const projectId = c.req.query('project_id');
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const range = c.req.header('range');
        return await remoteClient.fsRaw(
          { projectId: toLocalId(projectId), path: c.req.query('path') || '' },
          {
            signal: c.req.raw.signal,
            ...(range ? { headers: { Range: range } } : {}),
          },
        );
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const { base, projectAware } = await resolveBase(c, projectId);
      const path = c.req.query('path') || '';
      if (projectAware && !path) {
        return c.json(validationError('Ожидается поле path'), 400);
      }

      const fullPath = resolveRequestedPath(base, path, projectAware);
      const s = await stat(fullPath).catch(() => null);
      if (!s) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Файл не найден: ${path}`), 404);
      }
      if (s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.IS_DIRECTORY, 'Указанный путь является директорией'), 400);
      }

      // Кап предпросмотра: размер известен из `stat` — байты в память не читаются.
      if (s.size > maxPreviewBytes) {
        return c.json(
          makeFsErrorWithDetails(
            FsErrorCode.FILE_TOO_LARGE,
            `Файл превышает лимит предпросмотра (${maxPreviewBytes} байт)`,
            { maxPreviewBytes, size: s.size, reason: 'preview_size' },
          ),
          413,
          // Hono отбрасывает тело HEAD-ответа, поэтому причина отказа и размеры
          // дублируются заголовками — иначе HEAD-проверка (`probeRawFile`)
          // видит голый `413` без данных для кнопки «Скачать».
          {
            'X-Synth-Preview-Reason': 'preview_size',
            'X-Synth-Preview-Max-Bytes': String(maxPreviewBytes),
            'X-Synth-Preview-Size': String(s.size),
          },
        );
      }

      const kind = fileKind(path);
      const inline = INLINE_PREVIEW_KINDS.includes(kind);
      const mime = fileMime(path);
      const fileName = basename(fullPath);
      const etag = fileEtag(s.size, s.mtimeMs);

      const headers: Record<string, string> = {
        'Content-Type': inline ? mime : 'application/octet-stream',
        'Content-Disposition':
          `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`,
        'Accept-Ranges': 'bytes',
        // Файлы workspace меняются — кэш браузера проверяет по ETag (`304`).
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        'Last-Modified': new Date(s.mtimeMs).toUTCString(),
        'X-Content-Type-Options': 'nosniff',
      };
      // SVG — активное содержимое: при прямой навигации браузер выполняет
      // скрипты, поэтому документ изолируем (в `<img>` скрипты и так не идут).
      if (inline && mime === 'image/svg+xml') {
        headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      }

      // Условный запрос: файл не изменился — 304 без тела.
      if (etagMatches(c.req.header('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
      }

      const range = parseByteRange(c.req.header('range'), s.size);
      if (range.kind === 'unsatisfiable') {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${s.size}` },
        });
      }

      if (range.kind === 'range') {
        const length = range.end - range.start + 1;
        const rangeStream = createReadStream(fullPath, { start: range.start, end: range.end });
        return new Response(Readable.toWeb(rangeStream) as ReadableStream, {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(length),
            'Content-Range': `bytes ${range.start}-${range.end}/${s.size}`,
          },
        });
      }

      // HEAD — те же заголовки без тела (поток не открываем).
      if (c.req.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(s.size) } });
      }

      const fileStream = createReadStream(fullPath);
      return new Response(Readable.toWeb(fileStream) as ReadableStream, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(s.size) },
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // DELETE / — удаление файла или пустой директории
  app.delete('/', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const projectId = c.req.query('project_id');
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.fsDelete({ projectId: toLocalId(projectId), path: c.req.query('path') || '' });
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const { base, projectAware } = await resolveBase(c, projectId);
      const path = c.req.query('path') || '';
      if (projectAware && !path) {
        return c.json(validationError('Ожидается поле path'), 400);
      }

      const fullPath = resolveRequestedPath(base, path, projectAware);
      const s = await stat(fullPath).catch(() => null);
      if (!s) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Путь не найден: ${path}`), 404);
      }

      if (s.isDirectory()) {
        const files = await readdir(fullPath);
        if (files.length > 0) {
          return c.json(makeFsError(FsErrorCode.DIR_NOT_EMPTY, 'Директория не пуста'), 400);
        }
        await rmdir(fullPath);
      } else {
        await unlink(fullPath);
      }

      await notifyFsChanged(projectId, { scope: 'file', paths: [path], op: 'delete' });
      return c.json({ deleted: true, path }, 200);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // POST /mkdir — создание директории
  app.post('/mkdir', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => null);
    const projectIdRaw = body?.projectId || body?.project_id;
    const projectId = typeof projectIdRaw === 'string' ? projectIdRaw : undefined;
    if (projectId && isRemoteRef(projectId)) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.fsMkdir({ projectId: toLocalId(projectId), path: body?.path });
        return c.json(result, 201);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const path = body?.path;
      if (typeof path !== 'string' || !path) {
        return c.json(validationError('Ожидается поле path'), 400);
      }

      const { base, projectAware } = await resolveBase(c, projectId);
      const fullPath = resolveRequestedPath(base, path, projectAware);

      const existing = await stat(fullPath).catch(() => null);
      if (existing) {
        return c.json(
          makeFsError(
            FsErrorCode.ALREADY_EXISTS,
            existing.isDirectory() ? 'Директория уже существует' : 'Файл с таким именем уже существует',
          ),
          409,
        );
      }

      await mkdir(fullPath, { recursive: true });
      await notifyFsChanged(projectId, { scope: 'file', paths: [path], op: 'mkdir' });
      return c.json({ created: true, path }, 201);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // POST /move — перемещение/переименование; `targetProjectId` — межпроектный перенос
  app.post('/move', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => null);
    const projectIdRaw = body?.projectId || body?.project_id;
    const projectId = typeof projectIdRaw === 'string' ? projectIdRaw : undefined;
    const targetProjectIdRaw = body?.targetProjectId || body?.target_project_id;
    const targetProjectId =
      typeof targetProjectIdRaw === 'string' && targetProjectIdRaw ? targetProjectIdRaw : undefined;

    const projectRemote = !!projectId && isRemoteRef(projectId);
    const targetRemote = !!targetProjectId && isRemoteRef(targetProjectId);

    // Межпроектный перенос с удалённым проектом (в любую сторону) не поддерживается.
    if (targetProjectId && (projectRemote || targetRemote)) {
      return c.json(validationError('Межпроектный перенос с удалённым проектом не поддерживается'), 400);
    }

    if (projectRemote) {
      if (!remoteClient) return remoteUnavailable(c);
      try {
        const result = await remoteClient.fsMove({
          projectId: toLocalId(projectId),
          sourcePath: body?.sourcePath,
          targetPath: body?.targetPath,
        });
        return c.json(result, 200);
      } catch (err) {
        const mapped = mapRemoteError(c, err);
        if (mapped) return mapped;
        throw err;
      }
    }

    try {
      const sourcePath = body?.sourcePath;
      const targetPath = body?.targetPath;
      if (typeof sourcePath !== 'string' || !sourcePath || typeof targetPath !== 'string' || !targetPath) {
        return c.json(validationError('sourcePath и targetPath обязательны'), 400);
      }

      // База источника; при `targetProjectId` — база назначения (иначе та же).
      const source = await resolveBase(c, projectId);
      const target = targetProjectId ? await resolveBase(c, targetProjectId) : source;
      const fullSource = resolveRequestedPath(source.base, sourcePath, source.projectAware);
      const fullTarget = resolveRequestedPath(target.base, targetPath, target.projectAware);

      const sourceStat = await stat(fullSource).catch(() => null);
      if (!sourceStat) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Источник не найден: ${sourcePath}`), 404);
      }

      // Запрет переноса каталога в самого себя/потомка (rename/cp дал бы невнятную ошибку).
      if (sourceStat.isDirectory()) {
        const relToTarget = relative(fullSource, fullTarget);
        if (!relToTarget.startsWith('..') && !isAbsolute(relToTarget)) {
          return c.json(
            validationError('Нельзя переместить каталог в самого себя или вложенный каталог'),
            400,
          );
        }
      }

      const targetDir = dirname(fullTarget);
      if (resolve(source.base) === resolve(target.base)) {
        // Одна база (проект/ФС) — быстрое переименование.
        await mkdir(targetDir, { recursive: true }).catch(() => {});
        await rename(fullSource, fullTarget);
      } else {
        // Разные базы — межпроектный перенос: копируем (файл/каталог), затем удаляем источник.
        await mkdir(targetDir, { recursive: true });
        try {
          await cp(fullSource, fullTarget, { recursive: true, errorOnExist: true, force: false });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // `cp` с `force:false`/`errorOnExist` сигналит о существующей цели
          // (в т.ч. несовпадением типов) — единый контракт: 409 ALREADY_EXISTS.
          if (
            code === 'EEXIST' ||
            code === 'ERR_FS_CP_EEXIST' ||
            code === 'ERR_FS_CP_NON_DIR_TO_DIR' ||
            code === 'ERR_FS_CP_DIR_TO_NON_DIR'
          ) {
            return c.json(
              makeFsError(FsErrorCode.ALREADY_EXISTS, `Цель уже существует: ${targetPath}`),
              409,
            );
          }
          throw err;
        }
        await rm(fullSource, { recursive: true, force: false });
      }
      // ADR-118 §4: перенос/переименование — уведомляем источник и (при
      // межпроектном переносе) целевой проект.
      await notifyFsChanged(projectId, { scope: 'file', op: 'move', from: sourcePath, to: targetPath });
      if (targetProjectId && targetProjectId !== projectId) {
        await notifyFsChanged(targetProjectId, { scope: 'file', op: 'move', from: sourcePath, to: targetPath });
      }
      return c.json({ moved: true, sourcePath, targetPath }, 200);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // GET /workspace-root — список поддиректорий корня workspace (ADR-075)
  app.get('/workspace-root', auth.requireAuth, async (c) => {
    const disabled = managedWorkspaceRootDisabled(c);
    if (disabled) return disabled;

    const wsRoot = workspacesRootOrError(c);
    if (wsRoot instanceof Response) return wsRoot;

    const parsed = fsWorkspaceBrowseQuerySchema.safeParse({
      includeHidden: c.req.query('includeHidden'),
    });
    if (!parsed.success) {
      return c.json(makeFsError('VALIDATION_ERROR', 'Некорректный параметр includeHidden'), 400);
    }

    const policy = protectedPaths();
    try {
      await mkdir(wsRoot, { recursive: true });
      const entries = await listChildDirectories(wsRoot, '', parsed.data.includeHidden, wsRoot, policy);
      return c.json({ root: wsRoot, entries });
    } catch (err) {
      return c.json(
        makeFsError(
          'INTERNAL_ERROR',
          `Не удалось прочитать корень workspace: ${err instanceof Error ? err.message : String(err)}`,
        ),
        500,
      );
    }
  });

  /**
   * GET /workspace-root/browse — навигация по каталогам.
   * Пути внутри `workspacesRoot` — свободно; вне root — по политике
   * (`confirm` разрешает, `deny` → 403). Абсолютные пути принимаются как есть,
   * относительные резолвятся от root; результат нормализуется, поэтому выход
   * `..` за root классифицируется как «вне root», а не обходится.
   */
  app.get('/workspace-root/browse', auth.requireAuth, async (c) => {
    const disabled = managedWorkspaceRootDisabled(c);
    if (disabled) return disabled;

    const wsRoot = workspacesRootOrError(c);
    if (wsRoot instanceof Response) return wsRoot;

    const parsed = fsWorkspaceBrowseQuerySchema.safeParse({
      path: c.req.query('path') ?? '',
      includeHidden: c.req.query('includeHidden'),
    });
    if (!parsed.success) {
      return c.json(makeFsError('VALIDATION_ERROR', 'Некорректные параметры навигации'), 400);
    }

    const policy = protectedPaths();
    const target = resolveAgainstRoot(wsRoot, parsed.data.path);
    if (isPathDenied(target, wsRoot, policy)) {
      return c.json(makeFsError('PROTECTED_PATH_DENIED', 'Путь защищён политикой безопасности'), 403);
    }

    const inside = isInsideRoot(wsRoot, target) && isInsideReal(wsRoot, target);
    if (!inside && outsideRootPolicy() === 'deny') {
      return c.json(
        makeFsError('WORKSPACE_OUTSIDE_ROOT_DENIED', 'Путь вне корня workspace запрещён политикой'),
        403,
      );
    }

    const s = await stat(target).catch(() => null);
    if (!s) {
      return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Директория не найдена: ${parsed.data.path || '/'}`), 404);
    }
    if (!s.isDirectory()) {
      return c.json(makeFsError('NOT_A_DIRECTORY', 'Путь не является директорией'), 400);
    }

    const relBase = inside ? relative(wsRoot, target) : target;
    try {
      const entries = await listChildDirectories(target, relBase, parsed.data.includeHidden, wsRoot, policy);
      return c.json({ root: wsRoot, path: relBase, entries });
    } catch (err) {
      return c.json(
        makeFsError(
          'INTERNAL_ERROR',
          `Не удалось прочитать директорию: ${err instanceof Error ? err.message : String(err)}`,
        ),
        500,
      );
    }
  });

  /**
   * POST /workspace-root/mkdir — создание каталога.
   * Внутри root — свободно; вне root: `deny` → 403, `confirm` без
   * `confirmOutsideRoot` → 409 (`WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`),
   * с флагом → создаётся. Запрещённые policy-пути — 403.
   */
  app.post('/workspace-root/mkdir', auth.requireAuth, async (c) => {
    const disabled = managedWorkspaceRootDisabled(c);
    if (disabled) return disabled;

    const wsRoot = workspacesRootOrError(c);
    if (wsRoot instanceof Response) return wsRoot;

    const body = await c.req.json().catch(() => null);
    const parsed = fsWorkspaceMkdirBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(makeFsError('VALIDATION_ERROR', 'Ожидается поле path'), 400);
    }

    const policy = protectedPaths();
    const target = resolveAgainstRoot(wsRoot, parsed.data.path);
    if (isPathDenied(target, wsRoot, policy)) {
      return c.json(makeFsError('PROTECTED_PATH_DENIED', 'Путь защищён политикой безопасности'), 403);
    }

    if (!isInsideRoot(wsRoot, target) || !isInsideReal(wsRoot, target)) {
      if (outsideRootPolicy() === 'deny') {
        return c.json(
          makeFsError('WORKSPACE_OUTSIDE_ROOT_DENIED', 'Путь вне корня workspace запрещён политикой'),
          403,
        );
      }
      if (parsed.data.confirmOutsideRoot !== true) {
        return c.json(
          makeFsError(
            'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED',
            'Создание каталога вне корня workspace требует подтверждения (confirmOutsideRoot: true)',
          ),
          409,
        );
      }
    }

    const existing = await stat(target).catch(() => null);
    if (existing) {
      return c.json(
        makeFsError(
          FsErrorCode.ALREADY_EXISTS,
          existing.isDirectory() ? 'Директория уже существует' : 'Файл с таким именем уже существует',
        ),
        409,
      );
    }

    try {
      await mkdir(target, { recursive: true });
    } catch (err) {
      return c.json(
        makeFsError(
          'WORKSPACE_CREATE_FAILED',
          `Не удалось создать директорию: ${err instanceof Error ? err.message : String(err)}`,
        ),
        422,
      );
    }

    return c.json({ created: true, path: parsed.data.path }, 201);
  });

  return app;
}
