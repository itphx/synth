import { Hono } from 'hono';
import { z } from 'zod';
import { readdir, readFile, writeFile, unlink, rmdir, mkdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { AuthKit } from '../auth/middleware.js';
import type { ProjectStore } from '../storage/project-store.js';
import { WorkspaceResolver } from '../lib/workspace-resolver.js';
import {
  fsListQuerySchema, fsReadQuerySchema, fsWriteBodySchema,
  fsDeleteQuerySchema, fsMkdirBodySchema, fsDownloadQuerySchema,
} from '@itphx/synth-shared';
import type { DirectoryListResult, FileEntry, FileReadResult, FsError } from '@itphx/synth-shared';
import { FsErrorCode } from '@itphx/synth-shared';

/**
 * Тело POST /api/v2/fs/move. Shared-схемы для него нет, поэтому объявлена
 * локально (общий `@itphx/synth-shared` в рамках AD-075 не трогаем).
 */
const fsMoveBodySchema = z.object({
  projectId: z.string().min(1),
  sourcePath: z.string().min(1),
  targetPath: z.string().min(1),
});

/** Тело POST /api/v2/fs/workspace-root/mkdir (создание каталога в корне workspace). */
const fsWorkspaceRootMkdirBodySchema = z.object({
  path: z.string().min(1),
});

function makeFsError(code: FsErrorCode, message: string): { error: FsError } {
  return { error: { error: message, code } };
}

/** Ошибка валидации тела/параметров — общий FS-формат (`{ error: { error, code } }`), HTTP 400. */
function makeFsValidationError(message: string): { error: FsError } {
  return makeFsError(FsErrorCode.PERMISSION_DENIED, message);
}

async function listDirectoryRecursive(
  wsPath: string,
  relBase: string,
  maxDepth: number,
  includeHidden: boolean,
  currentDepth: number,
): Promise<FileEntry[]> {
  if (currentDepth > maxDepth) return [];

  const entries = await readdir(wsPath, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;

    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    let modifiedAt = 0;
    let size = 0;

    try {
      const s = await stat(join(wsPath, entry.name));
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

    if (entry.isDirectory() && currentDepth < maxDepth) {
      const children = await listDirectoryRecursive(
        join(wsPath, entry.name), relPath, maxDepth, includeHidden, currentDepth + 1,
      );
      result.push(...children);
    }
  }

  return result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function createFsRoutes(kit: AuthKit, projectStore: ProjectStore, workspacesRoot: string): Hono {
  const app = new Hono();
  const wsResolver = new WorkspaceResolver(workspacesRoot,
    (projectId) => projectStore.load(projectId),
  );

  // GET /api/v2/fs — список файлов в директории
  app.get('/', kit.requireAuth, async (c) => {
    try {
      const query = fsListQuerySchema.parse({
        project_id: c.req.query('project_id'),
        path: c.req.query('path') || '',
        maxDepth: c.req.query('maxDepth'),
        includeHidden: c.req.query('includeHidden'),
      });

      const workspace = await wsResolver.resolve(query.project_id);
      const safePath = wsResolver.resolveSafePath(workspace, query.path || '');

      let s;
      try {
        s = await stat(safePath);
      } catch {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Путь не найден: ${query.path || '/'}`), 404);
      }

      if (!s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.NOT_A_DIRECTORY, 'Указанный путь не является директорией'), 400);
      }

      const maxDepth = query.maxDepth ?? 0;
      const includeHidden = query.includeHidden ?? false;

      const entries = await listDirectoryRecursive(safePath, query.path || '', maxDepth, includeHidden, 0);

      const result: DirectoryListResult = {
        path: query.path || '/',
        entries,
      };

      return c.json(result);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.NOT_FOUND ? 404
          : e.code === FsErrorCode.WORKSPACE_NOT_SET ? 400
          : e.code === FsErrorCode.WORKSPACE_NOT_FOUND ? 400
          : e.code === FsErrorCode.PATH_TRAVERSAL ? 403
          : 500;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // GET /api/v2/fs/read — содержимое файла
  app.get('/read', kit.requireAuth, async (c) => {
    try {
      const query = fsReadQuerySchema.parse({
        project_id: c.req.query('project_id'),
        path: c.req.query('path'),
      });

      const workspace = await wsResolver.resolve(query.project_id);
      const safePath = wsResolver.resolveSafePath(workspace, query.path);

      let s;
      try {
        s = await stat(safePath);
      } catch {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Файл не найден: ${query.path}`), 404);
      }

      if (s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.IS_DIRECTORY, 'Указанный путь является директорией'), 400);
      }

      if (!(await WorkspaceResolver.isTextFile(safePath))) {
        const result: FileReadResult = {
          path: query.path,
          content: '',
          size: s.size,
          encoding: 'binary',
        };
        return c.json(result);
      }

      const content = await readFile(safePath, 'utf-8');
      const result: FileReadResult = {
        path: query.path,
        content,
        size: s.size,
        encoding: 'utf-8',
      };
      return c.json(result);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.NOT_FOUND ? 404
          : e.code === FsErrorCode.PATH_TRAVERSAL ? 403
          : 500;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // POST /api/v2/fs/write — запись файла
  app.post('/write', kit.requireAuth, async (c) => {
    try {
      const body = fsWriteBodySchema.parse(await c.req.json());

      const workspace = await wsResolver.resolve(body.projectId);
      const safePath = wsResolver.resolveSafePath(workspace, body.path);

      await mkdir(join(safePath, '..'), { recursive: true }).catch(() => {});
      await writeFile(safePath, body.content, 'utf-8');

      const s = await stat(safePath);
      const result: FileReadResult = {
        path: body.path,
        content: body.content,
        size: s.size,
        encoding: 'utf-8',
      };
      return c.json(result, 200);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.PATH_TRAVERSAL ? 403 : 500;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // POST /api/v2/fs/upload — загрузка файла (multipart)
  app.post('/upload', kit.requireAuth, async (c) => {
    try {
      const formData = await c.req.parseBody({ all: true });
      const projectId = typeof formData.project_id === 'string' ? formData.project_id : '';
      const dirPath = typeof formData.path === 'string' ? formData.path : '';
      const file = formData.file;

      if (!projectId) {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, 'project_id обязателен'), 400);
      }
      if (!file || typeof file === 'string') {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, 'Файл не передан'), 400);
      }

      const uploadedFile = Array.isArray(file) ? file[0] : file;
      if (!uploadedFile || typeof uploadedFile === 'string') {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, 'Файл не передан'), 400);
      }

      const workspace = await wsResolver.resolve(projectId);
      const targetDir = wsResolver.resolveSafePath(workspace, dirPath || '');

      const fileName = (uploadedFile as { name?: string }).name || 'uploaded-file';
      const targetPath = join(targetDir, fileName);
      const safeTarget = wsResolver.resolveSafePath(workspace, relative(workspace, targetPath));

      await mkdir(join(safeTarget, '..'), { recursive: true }).catch(() => {});

      let data: ArrayBuffer;
      if (uploadedFile instanceof File || (uploadedFile as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer) {
        data = await (uploadedFile as File).arrayBuffer();
      } else {
        return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, 'Неподдерживаемый тип файла'), 400);
      }

      await writeFile(safeTarget, new Uint8Array(data));

      return c.json({ path: relative(workspace, safeTarget), name: fileName }, 201);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        return c.json({ error: e }, e.code === FsErrorCode.PATH_TRAVERSAL ? 403 : 500);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // GET /api/v2/fs/download — скачивание файла
  app.get('/download', kit.requireAuth, async (c) => {
    try {
      const query = fsDownloadQuerySchema.parse({
        project_id: c.req.query('project_id'),
        path: c.req.query('path'),
      });

      const workspace = await wsResolver.resolve(query.project_id);
      const safePath = wsResolver.resolveSafePath(workspace, query.path);

      let s;
      try {
        s = await stat(safePath);
      } catch {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Файл не найден: ${query.path}`), 404);
      }

      if (s.isDirectory()) {
        return c.json(makeFsError(FsErrorCode.IS_DIRECTORY, 'Нельзя скачать директорию'), 400);
      }

      const fileName = basename(safePath);
      const fileStream = createReadStream(safePath);
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
      if ((err as FsError)?.code) {
        const e = err as FsError;
        return c.json({ error: e }, e.code === FsErrorCode.PATH_TRAVERSAL ? 403 : 500);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // DELETE /api/v2/fs — удаление файла или пустой папки
  app.delete('/', kit.requireAuth, async (c) => {
    try {
      const query = fsDeleteQuerySchema.parse({
        project_id: c.req.query('project_id'),
        path: c.req.query('path'),
      });

      const workspace = await wsResolver.resolve(query.project_id);
      const safePath = wsResolver.resolveSafePath(workspace, query.path);

      let s;
      try {
        s = await stat(safePath);
      } catch {
        return c.json(makeFsError(FsErrorCode.NOT_FOUND, `Путь не найден: ${query.path}`), 404);
      }

      if (s.isDirectory()) {
        const files = await readdir(safePath);
        if (files.length > 0) {
          return c.json(makeFsError(FsErrorCode.DIR_NOT_EMPTY, 'Директория не пуста'), 400);
        }
        await rmdir(safePath);
      } else {
        await unlink(safePath);
      }

      return c.json({ deleted: true, path: query.path });
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.NOT_FOUND ? 404
          : e.code === FsErrorCode.DIR_NOT_EMPTY ? 400
          : e.code === FsErrorCode.PATH_TRAVERSAL ? 403
          : 500;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // POST /api/v2/fs/mkdir — создание директории
  app.post('/mkdir', kit.requireAuth, async (c) => {
    try {
      const parsed = fsMkdirBodySchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json(makeFsValidationError(
          `Некорректное тело запроса: projectId и path обязательны (${parsed.error.issues[0]?.message ?? 'невалидные данные'})`,
        ), 400);
      }
      const body = parsed.data;

      const workspace = await wsResolver.resolve(body.projectId);
      const safePath = wsResolver.resolveSafePath(workspace, body.path);

      try {
        const existing = await stat(safePath);
        if (existing.isDirectory()) {
          return c.json(makeFsError(FsErrorCode.ALREADY_EXISTS, 'Директория уже существует'), 409);
        }
        return c.json(makeFsError(FsErrorCode.ALREADY_EXISTS, 'Файл с таким именем уже существует'), 409);
      } catch {
        // не существует — можно создавать
      }

      await mkdir(safePath, { recursive: true });
      return c.json({ created: true, path: body.path }, 201);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        return c.json({ error: e }, e.code === FsErrorCode.PATH_TRAVERSAL ? 403 : 500);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // POST /api/v2/fs/move — переместить/переименовать файл или папку
  app.post('/move', kit.requireAuth, async (c) => {
    try {
      const parsed = fsMoveBodySchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json(makeFsValidationError('projectId, sourcePath и targetPath обязательны'), 400);
      }
      const { projectId, sourcePath, targetPath } = parsed.data;
      await wsResolver.moveEntry(projectId, sourcePath, targetPath);
      return c.json({ moved: true, sourcePath, targetPath }, 200);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.NOT_FOUND ? 404
          : e.code === FsErrorCode.PATH_TRAVERSAL ? 403
          : 500;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // GET /api/v2/fs/workspace-root — список поддиректорий корня workspace
  app.get('/workspace-root', kit.requireAuth, async (c) => {
    try {
      const includeHidden = c.req.query('includeHidden') === 'true';
      const entries = await wsResolver.listRootEntries(includeHidden);
      return c.json({
        root: wsResolver.getWorkspaceRoot(),
        entries,
      });
    } catch (err) {
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // GET /api/v2/fs/workspace-root/browse — список поддиректорий внутри корня.
  // Абсолютный путь внутри root → 200 (относительный `path` в ответе);
  // абсолютный вне root (managed deny) / traversal → 403.
  app.get('/workspace-root/browse', kit.requireAuth, async (c) => {
    try {
      const path = c.req.query('path') || '';
      const includeHidden = c.req.query('includeHidden') === 'true';
      const entries = await wsResolver.listRootSubDirectory(path, includeHidden);
      return c.json({
        root: wsResolver.getWorkspaceRoot(),
        path: relative(wsResolver.getWorkspaceRoot(), wsResolver.resolveRootPath(path)),
        entries,
      });
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.NOT_FOUND ? 404
          : e.code === FsErrorCode.NOT_A_DIRECTORY ? 400
          : e.code === FsErrorCode.PATH_TRAVERSAL ? 403
          : e.code === FsErrorCode.WORKSPACE_OUTSIDE_ROOT_DENIED ? 403
          : 404;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  // POST /api/v2/fs/workspace-root/mkdir — создать директорию в корне.
  // Абсолютный путь внутри root → 201; вне root (managed deny) / traversal → 403;
  // существующий путь → 409 ALREADY_EXISTS (паритет с core).
  app.post('/workspace-root/mkdir', kit.requireAuth, async (c) => {
    try {
      const parsed = fsWorkspaceRootMkdirBodySchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json(makeFsValidationError('Поле path обязательно'), 400);
      }
      const path = parsed.data.path.trim();
      if (!path) {
        return c.json(makeFsValidationError('Поле path обязательно'), 400);
      }
      await wsResolver.createRootDirectory(path);
      return c.json({ created: true, path }, 201);
    } catch (err) {
      if ((err as FsError)?.code) {
        const e = err as FsError;
        const status = e.code === FsErrorCode.PATH_TRAVERSAL ? 403
          : e.code === FsErrorCode.WORKSPACE_OUTSIDE_ROOT_DENIED ? 403
          : e.code === FsErrorCode.ALREADY_EXISTS ? 409
          : 500;
        return c.json({ error: e }, status);
      }
      return c.json(makeFsError(FsErrorCode.PERMISSION_DENIED, String(err)), 500);
    }
  });

  return app;
}
