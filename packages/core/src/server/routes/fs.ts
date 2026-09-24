import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { FileEntry, WorkspaceOutsideRootPolicy } from '@itphx/synth-shared';
import { fsWorkspaceBrowseQuerySchema, fsWorkspaceMkdirBodySchema } from '@itphx/synth-shared';
import type { AuthKit } from '../../auth/local.js';
import { checkPath, loadProtectedPaths } from '../../engine/security/protected-paths.js';
import type { ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';
import { isRemoteRef, toLocalId, remoteErrorToHttp } from '../../remote/aggregate.js';
import type { RemoteBackendClient } from '../../remote/client.js';

/**
 * AD-075: опции FS-роутов core (standalone) для паритета с backend.
 * Позиционный `workspacesRoot` остаётся обратносовместимым; здесь — мягкая
 * политика путей вне root и защищённые пути.
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
 * AD-075: подкаталоги директории (только `isDirectory`), отсортированные по имени.
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
  auth: AuthKit,
  workspacesRoot?: string,
  getRemoteClient?: () => RemoteBackendClient | null,
  opts: FsRoutesOptions = {},
): Hono {
  const app = new Hono();
  // Legacy-корень: как раньше (fallback process.cwd()), чтобы не менять поведение
  // существующих эндпоинтов при вызове фабрики без root.
  const root = workspacesRoot || process.cwd();
  // AD-075: новые `/workspace-root*` работают только с явно настроенным корнем —
  // process.cwd() как fallback здесь запрещён (см. workspacesRootOrError).
  const configuredRoot = workspacesRoot && workspacesRoot.trim() ? workspacesRoot : undefined;
  const resolveClient = (): RemoteBackendClient | undefined => getRemoteClient?.() ?? undefined;
  const outsideRootPolicy = (): WorkspaceOutsideRootPolicy => opts.getOutsideRootPolicy?.() ?? 'confirm';
  const protectedPaths = (): ProtectedPathsPolicy =>
    opts.getProtectedPathsPolicy ? opts.getProtectedPathsPolicy() : loadProtectedPaths();

  /** Корень для новых `/workspace-root*`; без настроенного root — 500. */
  const workspacesRootOrError = (c: Context): string | Response => {
    if (!configuredRoot) {
      return c.json(
        { error: { code: 'WORKSPACE_ROOT_NOT_CONFIGURED', message: 'Корневой каталог workspace не настроен' } },
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

    const path = c.req.query('path') || '';
    const includeHidden = c.req.query('includeHidden') === 'true';
    const fullPath = resolveSafe(root, path);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const entryPath = join(path, entry.name);
        let size = 0;
        let modifiedAt = 0;
        try {
          const s = await stat(join(fullPath, entry.name));
          size = s.size;
          modifiedAt = s.mtimeMs;
        } catch { /* ignore */ }
        result.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
          size,
          modifiedAt,
        });
      }
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return c.json({ path: path || '/', entries: result });
    } catch {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Директория не найдена' } }, 404);
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

    const filePath = c.req.query('path') || '';
    const fullPath = resolveSafe(root, filePath);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Это директория' } }, 400);
      }
      const content = await readFile(fullPath, 'utf-8');
      return c.json({ path: filePath, content, size: s.size, encoding: 'utf-8' });
    } catch {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }, 404);
    }
  });

  // POST /write — запись файла
  app.post('/write', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => null);
    const projectId = body?.projectId || body?.project_id;
    if (typeof projectId === 'string' && isRemoteRef(projectId)) {
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

    const path = body?.path;
    const content = body?.content;
    if (typeof path !== 'string' || !path || typeof content !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Ожидаются поля path и content' } }, 400);
    }

    const fullPath = resolveSafe(root, path);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      await mkdir(join(fullPath, '..'), { recursive: true }).catch(() => {});
      await writeFile(fullPath, content, 'utf-8');
      const s = await stat(fullPath);
      return c.json({ path, content, size: s.size, encoding: 'utf-8' }, 200);
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось записать файл' } }, 500);
    }
  });

  // POST /upload — загрузка файла (multipart)
  app.post('/upload', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const formData = await c.req.formData();
    const projectIdField = formData.get('project_id');
    const projectId = typeof projectIdField === 'string' ? projectIdField : undefined;

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

    const dirPath = typeof formData.get('path') === 'string' ? String(formData.get('path')) : '';
    const file = formData.get('file');
    const uploadedFile = file;

    if (!uploadedFile || typeof uploadedFile === 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Файл не передан' } }, 400);
    }

    const targetDir = resolveSafe(root, dirPath);
    if (!targetDir) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    const rawName = (uploadedFile as { name?: string }).name;
    const fileName = basename(rawName || 'uploaded-file');
    const targetPath = join(targetDir, fileName);
    const safeTarget = resolveSafe(root, relative(root, targetPath));
    if (!safeTarget) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      await mkdir(join(safeTarget, '..'), { recursive: true }).catch(() => {});

      let data: ArrayBuffer;
      if (typeof (uploadedFile as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
        data = await (uploadedFile as File).arrayBuffer();
      } else {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Неподдерживаемый тип файла' } }, 400);
      }

      await writeFile(safeTarget, new Uint8Array(data));
      return c.json({ path: relative(root, safeTarget), name: fileName }, 201);
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось загрузить файл' } }, 500);
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

    const filePath = c.req.query('path') || '';
    const fullPath = resolveSafe(root, filePath);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    const s = await stat(fullPath).catch(() => null);
    if (!s) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }, 404);
    }

    if (s.isDirectory()) {
      return c.json({ error: { code: 'IS_DIRECTORY', message: 'Нельзя скачать директорию' } }, 400);
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

    const path = c.req.query('path') || '';
    const fullPath = resolveSafe(root, path);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    const s = await stat(fullPath).catch(() => null);
    if (!s) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Путь не найден' } }, 404);
    }

    try {
      if (s.isDirectory()) {
        const files = await readdir(fullPath);
        if (files.length > 0) {
          return c.json({ error: { code: 'DIR_NOT_EMPTY', message: 'Директория не пуста' } }, 400);
        }
        await rmdir(fullPath);
      } else {
        await unlink(fullPath);
      }
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось удалить' } }, 500);
    }

    return c.json({ deleted: true, path }, 200);
  });

  // POST /mkdir — создание директории
  app.post('/mkdir', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => null);
    const projectId = body?.projectId || body?.project_id;
    if (typeof projectId === 'string' && isRemoteRef(projectId)) {
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

    const path = body?.path;
    if (typeof path !== 'string' || !path) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Ожидается поле path' } }, 400);
    }

    const fullPath = resolveSafe(root, path);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      const existing = await stat(fullPath);
      if (existing.isDirectory()) {
        return c.json({ error: { code: 'ALREADY_EXISTS', message: 'Директория уже существует' } }, 409);
      }
      return c.json({ error: { code: 'ALREADY_EXISTS', message: 'Файл с таким именем уже существует' } }, 409);
    } catch {
      // не существует — можно создавать
    }

    try {
      await mkdir(fullPath, { recursive: true });
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось создать директорию' } }, 500);
    }

    return c.json({ created: true, path }, 201);
  });

  // POST /move — перемещение/переименование
  app.post('/move', auth.requireAuth, async (c) => {
    const remoteClient = resolveClient();
    const body = await c.req.json().catch(() => null);
    const projectId = body?.projectId || body?.project_id;
    if (typeof projectId === 'string' && isRemoteRef(projectId)) {
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

    const sourcePath = body?.sourcePath;
    const targetPath = body?.targetPath;
    if (typeof sourcePath !== 'string' || !sourcePath || typeof targetPath !== 'string' || !targetPath) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'sourcePath и targetPath обязательны' } }, 400);
    }

    const fullSource = resolveSafe(root, sourcePath);
    const fullTarget = resolveSafe(root, targetPath);
    if (!fullSource || !fullTarget) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    const sourceStat = await stat(fullSource).catch(() => null);
    if (!sourceStat) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Путь не найден' } }, 404);
    }

    try {
      await mkdir(join(fullTarget, '..'), { recursive: true }).catch(() => {});
      await rename(fullSource, fullTarget);
    } catch {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Не удалось переместить' } }, 500);
    }

    return c.json({ moved: true, sourcePath, targetPath }, 200);
  });

  // GET /workspace-root — список поддиректорий корня workspace (AD-075)
  app.get('/workspace-root', auth.requireAuth, async (c) => {
    const wsRoot = workspacesRootOrError(c);
    if (wsRoot instanceof Response) return wsRoot;

    const parsed = fsWorkspaceBrowseQuerySchema.safeParse({
      includeHidden: c.req.query('includeHidden'),
    });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный параметр includeHidden' } }, 400);
    }

    const policy = protectedPaths();
    try {
      await mkdir(wsRoot, { recursive: true });
      const entries = await listChildDirectories(wsRoot, '', parsed.data.includeHidden, wsRoot, policy);
      return c.json({ root: wsRoot, entries });
    } catch (err) {
      return c.json({
        error: {
          code: 'INTERNAL_ERROR',
          message: `Не удалось прочитать корень workspace: ${err instanceof Error ? err.message : String(err)}`,
        },
      }, 500);
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
    const wsRoot = workspacesRootOrError(c);
    if (wsRoot instanceof Response) return wsRoot;

    const parsed = fsWorkspaceBrowseQuerySchema.safeParse({
      path: c.req.query('path') ?? '',
      includeHidden: c.req.query('includeHidden'),
    });
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры навигации' } }, 400);
    }

    const policy = protectedPaths();
    const target = resolveAgainstRoot(wsRoot, parsed.data.path);
    if (isPathDenied(target, wsRoot, policy)) {
      return c.json({ error: { code: 'PROTECTED_PATH_DENIED', message: 'Путь защищён политикой безопасности' } }, 403);
    }

    const inside = isInsideRoot(wsRoot, target);
    if (!inside && outsideRootPolicy() === 'deny') {
      return c.json({
        error: { code: 'WORKSPACE_OUTSIDE_ROOT_DENIED', message: 'Путь вне корня workspace запрещён политикой' },
      }, 403);
    }

    const s = await stat(target).catch(() => null);
    if (!s) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Директория не найдена: ${parsed.data.path || '/'}` } }, 404);
    }
    if (!s.isDirectory()) {
      return c.json({ error: { code: 'NOT_A_DIRECTORY', message: 'Путь не является директорией' } }, 400);
    }

    const relBase = inside ? relative(wsRoot, target) : target;
    try {
      const entries = await listChildDirectories(target, relBase, parsed.data.includeHidden, wsRoot, policy);
      return c.json({ root: wsRoot, path: relBase, entries });
    } catch (err) {
      return c.json({
        error: {
          code: 'INTERNAL_ERROR',
          message: `Не удалось прочитать директорию: ${err instanceof Error ? err.message : String(err)}`,
        },
      }, 500);
    }
  });

  /**
   * POST /workspace-root/mkdir — создание каталога.
   * Внутри root — свободно; вне root: `deny` → 403, `confirm` без
   * `confirmOutsideRoot` → 409 (`WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED`),
   * с флагом → создаётся. Запрещённые policy-пути — 403.
   */
  app.post('/workspace-root/mkdir', auth.requireAuth, async (c) => {
    const wsRoot = workspacesRootOrError(c);
    if (wsRoot instanceof Response) return wsRoot;

    const body = await c.req.json().catch(() => null);
    const parsed = fsWorkspaceMkdirBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Ожидается поле path' } }, 400);
    }

    const policy = protectedPaths();
    const target = resolveAgainstRoot(wsRoot, parsed.data.path);
    if (isPathDenied(target, wsRoot, policy)) {
      return c.json({ error: { code: 'PROTECTED_PATH_DENIED', message: 'Путь защищён политикой безопасности' } }, 403);
    }

    if (!isInsideRoot(wsRoot, target)) {
      if (outsideRootPolicy() === 'deny') {
        return c.json({
          error: { code: 'WORKSPACE_OUTSIDE_ROOT_DENIED', message: 'Путь вне корня workspace запрещён политикой' },
        }, 403);
      }
      if (parsed.data.confirmOutsideRoot !== true) {
        return c.json({
          error: {
            code: 'WORKSPACE_OUTSIDE_ROOT_CONFIRM_REQUIRED',
            message: 'Создание каталога вне корня workspace требует подтверждения (confirmOutsideRoot: true)',
          },
        }, 409);
      }
    }

    const existing = await stat(target).catch(() => null);
    if (existing) {
      return c.json({
        error: {
          code: 'ALREADY_EXISTS',
          message: existing.isDirectory() ? 'Директория уже существует' : 'Файл с таким именем уже существует',
        },
      }, 409);
    }

    try {
      await mkdir(target, { recursive: true });
    } catch (err) {
      return c.json({
        error: {
          code: 'WORKSPACE_CREATE_FAILED',
          message: `Не удалось создать директорию: ${err instanceof Error ? err.message : String(err)}`,
        },
      }, 422);
    }

    return c.json({ created: true, path: parsed.data.path }, 201);
  });

  return app;
}
