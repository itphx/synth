/**
 * HTTP-контур вложений сообщений (ADR-115 §«API и лимиты»).
 *
 * - `POST   /:id/attachments`        — multipart-загрузка одного файла (поле `file`);
 * - `GET    /:id/attachments/:partId` — раздача байтов части сообщения (Range/ETag).
 *
 * Фабрика **не регистрирует** auth/guard: она монтируется внутрь роутера
 * сессий (`createSessionRoutes`), а доступ к `:id` решает единый prefix-guard
 * (`server/session-access-guard.ts`, инвариант 16) — вид доступа `read`/`write`
 * выводится из HTTP-метода. Дублирующих проверок здесь нет.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { Readable } from 'node:stream';
import type { AttachmentsConfig, Message, Part, Session } from '@itphx/synth-shared';
import type { SessionManager } from '../../index.js';
import { getAttachmentMetricsHook } from '../../metrics/collectors/attachments.js';
import { AttachmentError, partTypeOf } from '../../engine/attachments/service.js';
import type { AttachmentService } from '../../engine/attachments/service.js';

/** Доступные виды медиа-частей (последняя часть пути раздачи). */
const MEDIA_PART_TYPES = new Set(['image', 'audio', 'video', 'file']);

/** Локализуемые сообщения (backend передаёт `t()`, core — русские литералы). */
export interface AttachmentRouteMessages {
  sessionNotFound: (c: Context) => string;
  attachmentNotFound: (c: Context) => string;
  fileRequired: (c: Context) => string;
  tooLarge: (c: Context) => string;
  unsupportedMime: (c: Context, detail: string) => string;
}

const DEFAULT_MESSAGES: AttachmentRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  attachmentNotFound: () => 'Вложение не найдено',
  fileRequired: () => 'Файл не передан (ожидается поле file)',
  tooLarge: () => 'Размер вложения превышает допустимый',
  unsupportedMime: (_c, detail) => `Тип вложения не поддерживается: ${detail}`,
};

export interface AttachmentRoutesDeps {
  sessionManager: SessionManager;
  service: AttachmentService;
  /** Лимиты вложений (`attachments.*`) — ранняя проверка тела до буферизации. */
  config: AttachmentsConfig;
}

export interface AttachmentRoutesOptions {
  messages?: Partial<AttachmentRouteMessages>;
}

/**
 * Роуты вложений (относительные пути `/:id/attachments…`).
 *
 * Ожидают монтирования внутрь приложения сессий — под тем же prefix-guard'ом.
 */
export function createAttachmentRoutes(
  deps: AttachmentRoutesDeps,
  opts: AttachmentRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: AttachmentRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const { sessionManager, service, config } = deps;
  /**
   * Запас на multipart-обвязку (границы, заголовки частей): `formData()`
   * буферизует всё тело в память, поэтому по заявленному `content-length`
   * отсекаем заведомо большие запросы до чтения. Лживый/отсутствующий заголовок
   * не проходит дальше без проверки — фактический размер проверяется ниже и в
   * сервисе (`maxBytesPerFile`).
   */
  const multipartOverheadBytes = 64 * 1024;

  // POST /:id/attachments — загрузка одного файла (multipart, поле `file`).
  app.post('/:id/attachments', async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }

    const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxBytesPerFile + multipartOverheadBytes) {
      // ADR-094: отказ до разбора тела — вид вложения ещё неизвестен (`file`).
      getAttachmentMetricsHook()?.onUpload({ outcome: 'too_large', kind: 'file' });
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: messages.tooLarge(c) } }, 413);
    }

    const formData = await c.req.formData().catch(() => null);
    if (!formData) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.fileRequired(c) } }, 400);
    }
    const rawFile = formData.get('file');
    const uploaded = Array.isArray(rawFile) ? rawFile[0] : rawFile;
    if (!uploaded || typeof uploaded === 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.fileRequired(c) } }, 400);
    }

    // Ранняя проверка заявленного размера — до чтения тела в память.
    const declaredSize = (uploaded as { size?: unknown }).size;
    if (typeof declaredSize === 'number' && declaredSize > config.maxBytesPerFile) {
      // ADR-094: вид известен из заявленного MIME части (сервис уже не вызывается).
      const declaredMime = (uploaded as { type?: unknown }).type;
      getAttachmentMetricsHook()?.onUpload({
        outcome: 'too_large',
        kind: typeof declaredMime === 'string' && declaredMime ? partTypeOf(declaredMime) : 'file',
      });
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: messages.tooLarge(c) } }, 413);
    }

    const bytes = Buffer.from(await uploaded.arrayBuffer());
    const rawName = formData.get('name');
    const name =
      typeof rawName === 'string' && rawName.trim() !== ''
        ? rawName
        : (uploaded as { name?: string }).name;

    try {
      const meta = await service.upload({
        sessionId: session.id,
        bytes,
        ...(name ? { name } : {}),
        ...(uploaded.type ? { declaredMime: uploaded.type } : {}),
      });
      return c.json(meta, 201);
    } catch (err) {
      if (err instanceof AttachmentError) {
        if (err.code === 'too_large') {
          return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: messages.tooLarge(c) } }, 413);
        }
        return c.json(
          {
            error: {
              code: 'UNSUPPORTED_MEDIA_TYPE',
              // Ключ i18n + detail: клиенту важно понимать, что именно не так с типом.
              message: messages.unsupportedMime(c, err.message),
            },
          },
          415,
        );
      }
      throw err;
    }
  });

  // GET /:id/attachments/:partId — байты вложения (потоком, с Range/ETag).
  app.get('/:id/attachments/:partId', async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const partId = c.req.param('partId');
    // ADR-094: исход раздачи — `ok` (объект отдан, в т.ч. 304/206/416) или
    // `not_found` (нет части/объекта). Id сессии/части в лейблы не идут.
    const metrics = getAttachmentMetricsHook();
    const notFound = () => {
      metrics?.onDownload({ outcome: 'not_found' });
      return c.json({ error: { code: 'NOT_FOUND', message: messages.attachmentNotFound(c) } }, 404);
    };
    const media = findMediaPart(session, partId);
    if (!media) return notFound();

    const blobPath = (media.data as { blobPath?: unknown }).blobPath;
    if (typeof blobPath !== 'string' || blobPath === '') return notFound();

    const resolved = await service.resolve(blobPath);
    if (!resolved) return notFound();
    metrics?.onDownload({ outcome: 'ok' });

    const etag = `"${resolved.sha256}"`;
    const headers: Record<string, string> = {
      'Content-Type': resolved.mime,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Cache-Control': 'private, max-age=86400',
      'Content-Disposition': contentDisposition(resolved.name ?? basenameOf(blobPath)),
    };

    // `If-None-Match` — условный запрос: объект неизменяем (content-addressed).
    if (matchesEtag(c.req.header('if-none-match'), etag)) {
      return c.body(null, 304, headers);
    }

    const total = resolved.stat.size;
    const range = parseRange(c.req.header('range'), total);
    if (range === 'invalid') {
      return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${total}` });
    }

    // HEAD — те же заголовки (размер/ETag/диапазон), без тела и без открытия
    // потока файла (иначе дескриптор остался бы висеть до сборки мусора).
    const headOnly = c.req.method === 'HEAD';

    if (range) {
      const rangeHeaders = {
        ...headers,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
      };
      if (headOnly) return c.body(null, 206, rangeHeaders);
      const stream = await service.read(blobPath, { start: range.start, end: range.end });
      if (!stream) return notFound();
      return streamResponse(stream, 206, rangeHeaders);
    }

    const fullHeaders = { ...headers, 'Content-Length': String(total) };
    if (headOnly) return c.body(null, 200, fullHeaders);
    const stream = await service.read(blobPath);
    if (!stream) return notFound();
    return streamResponse(stream, 200, fullHeaders);
  });

  return app;
}

/** Медиа-часть сообщения по её id (только сообщения этой сессии). */
function findMediaPart(session: Session, partId: string): Part | undefined {
  for (const message of session.messages as Message[]) {
    const part = message.parts.find((p: Part) => p.id === partId && MEDIA_PART_TYPES.has(p.type));
    if (part) return part;
  }
  return undefined;
}

/** Отдать поток порта как HTTP-ответ (web-стрим без буферизации). */
function streamResponse(
  stream: Readable,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
}

/** Разбор `Range: bytes=start-end` (один диапазон). */
function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | 'invalid' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined; // множественные/незнакомые диапазоны — отдаём объект целиком
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    // Суффиксный диапазон: последние N байт.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    const start = Math.max(0, total - suffix);
    return { start, end: total - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? total - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start < 0 || end < start || start >= total) return 'invalid';
  return { start, end: Math.min(end, total - 1) };
}

/** Совпадает ли `If-None-Match` с ETag (в т.ч. `*` и список через запятую). */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag);
}

/** `Content-Disposition: inline` с UTF-8-именем (RFC 6266/5987). */
function contentDisposition(name: string | undefined): string {
  const safe = (name ?? 'attachment').replace(/["\\\r\n]/g, '_');
  const encoded = encodeURIComponent(name ?? 'attachment');
  return `inline; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/** Имя для `Content-Disposition`, если метаданных нет: сам хеш. */
function basenameOf(blobPath: string): string {
  const segments = blobPath.split('/');
  return segments[segments.length - 1] ?? 'attachment';
}
