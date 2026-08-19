import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { AuthKit } from '../../auth/local.js';

/** Резолвит путь относительно root и проверяет, что результат внутри root. */
function resolveSafe(root: string, p: string): string | null {
  const full = resolve(root, p || '');
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) return null;
  return full;
}

export function createFsRoutes(auth: AuthKit, workspacesRoot?: string): Hono {
  const app = new Hono();
  const root = workspacesRoot || process.cwd();

  // GET / — список файлов в директории
  app.get('/', auth.requireAuth, async (c) => {
    const path = c.req.query('path') || '';
    const fullPath = resolveSafe(root, path);
    if (!fullPath) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Доступ запрещён' } }, 403);
    }

    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
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
    const body = await c.req.json().catch(() => null);
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
    const formData = await c.req.parseBody({ all: true });
    const dirPath = typeof formData.path === 'string' ? formData.path : '';
    const file = formData.file;
    const uploadedFile = Array.isArray(file) ? file[0] : file;

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
    const body = await c.req.json().catch(() => null);
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
    const body = await c.req.json().catch(() => null);
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

  return app;
}
