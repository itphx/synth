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
import type { AttachmentService, UploadedAttachmentMeta } from '../../engine/attachments/service.js';
import {
  UploadSessionError,
  UploadSessionStore,
} from '../../engine/attachments/uploads.js';
import type {
  CreateUploadSessionInput,
  UploadSessionScope,
} from '../../engine/attachments/uploads.js';

/** Доступные виды медиа-частей (последняя часть пути раздачи). */
const MEDIA_PART_TYPES = new Set(['image', 'audio', 'video', 'file']);

/** Локализуемые сообщения (backend передаёт `t()`, core — русские литералы). */
export interface AttachmentRouteMessages {
  sessionNotFound: (c: Context) => string;
  attachmentNotFound: (c: Context) => string;
  fileRequired: (c: Context) => string;
  tooLarge: (c: Context) => string;
  unsupportedMime: (c: Context, detail: string) => string;
  /** ADR-115: вложения выключены администратором (`attachments.enabled=false`). */
  attachmentsDisabled: (c: Context) => string;
  /** B2a: сессии chunked-загрузки нет (неизвестный id либо протухла). */
  uploadNotFound: (c: Context) => string;
  /** B2a: `offset` части не совпал с уже принятым объёмом. */
  uploadOffsetMismatch: (c: Context) => string;
  /** B2a: часть больше `attachments.maxChunkBytes`. */
  uploadChunkTooLarge: (c: Context) => string;
  /** B2a: тело инициализации загрузки некорректно. */
  uploadInvalid: (c: Context) => string;
}

/** Сообщения по умолчанию (core: русские литералы; backend передаёт `t()`). */
export const DEFAULT_MESSAGES: AttachmentRouteMessages = {
  sessionNotFound: () => 'Сессия не найдена',
  attachmentNotFound: () => 'Вложение не найдено',
  fileRequired: () => 'Файл не передан (ожидается поле file)',
  tooLarge: () => 'Размер вложения превышает допустимый',
  unsupportedMime: (_c, detail) => `Тип вложения не поддерживается: ${detail}`,
  attachmentsDisabled: () => 'Вложения отключены администратором',
  uploadNotFound: () => 'Сессия загрузки не найдена',
  uploadOffsetMismatch: () => 'Смещение части не совпадает с принятым объёмом',
  uploadChunkTooLarge: () => 'Размер части превышает допустимый',
  uploadInvalid: () => 'Некорректные параметры загрузки',
};

export interface AttachmentRoutesDeps {
  sessionManager: SessionManager;
  service: AttachmentService;
  /**
   * Лимиты вложений (`attachments.*`) — ранняя проверка тела до буферизации.
   * Статический снимок **или** резолвер (ADR-115): runtime-настройки читаются
   * на каждый запрос.
   */
  config: AttachmentsConfig | (() => AttachmentsConfig);
  /**
   * B2a: реестр сессий chunked-загрузки. Не задан — создаётся внутри фабрики
   * (состояние — на томе, ADR-115 §«Chunked-протокол»; см. `uploads.ts`).
   */
  uploads?: UploadSessionStore;
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
  const { sessionManager, service } = deps;
  /** Эффективные настройки на текущий запрос (ADR-115: runtime без рестарта). */
  const resolveConfig = (): AttachmentsConfig =>
    typeof deps.config === 'function' ? deps.config() : deps.config;
  // POST /:id/attachments — загрузка одного файла (multipart, поле `file`).
  app.post('/:id/attachments', async (c) => {
    const session = await sessionManager.getSession(c.req.param('id'));
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
    }
    const config = resolveConfig();
    if (!config.enabled) {
      getAttachmentMetricsHook()?.onUpload({ outcome: 'unsupported', kind: 'file' });
      return c.json(
        { error: { code: 'attachments_disabled', message: messages.attachmentsDisabled(c) } },
        415,
      );
    }

    // Единый ответ обоих режимов: `201` с метаданными либо отказ `AttachmentError`.
    const respond = async (run: () => Promise<UploadedAttachmentMeta>): Promise<Response> => {
      try {
        return c.json(await run(), 201);
      } catch (err) {
        if (err instanceof AttachmentError) {
          return attachmentErrorResponse(c, err, messages, config.maxBytesPerFile);
        }
        throw err;
      }
    };

    // Multipart оставлен для совместимости (Telegram-шлюз и старые клиенты).
    if (isMultipartUpload(c)) {
      const form = await readAttachmentUploadForm(c, config, messages);
      if (!form.ok) return form.response;
      return respond(() =>
        service.upload({
          sessionId: session.id,
          bytes: form.bytes,
          ...(form.name ? { name: form.name } : {}),
          ...(form.declaredMime ? { declaredMime: form.declaredMime } : {}),
        }),
      );
    }

    // Raw-body режим (ADR-115 этап B1): тело запроса — сам файл; байты идут
    // потоком в blob, без буферизации всего тела в памяти.
    const raw = openAttachmentRawUpload(c, config, messages);
    if (!raw.ok) return raw.response;
    return respond(() => service.ingestStream(raw.upload));
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

    // ADR-115: `?variant=thumb` — серверная миниатюра (JPEG) вместо оригинала.
    // Тот же контур доступа (prefix-guard), отдельный ETag и суточный кэш;
    // нет миниатюры (ещё не сгенерирована/не применима) — 404.
    if (c.req.query('variant') === 'thumb') {
      let thumb = await service.thumbnail(blobPath);
      if (!thumb) {
        // Ленивая генерация: старые вложения (до появления миниатюр) не
        // проходили через `upload` этого инстанса. Ошибка не ломает запрос.
        const data = media.data as { mime?: unknown; durationMs?: unknown };
        const mediaMime =
          typeof data.mime === 'string' && data.mime !== '' ? data.mime : resolved.mime;
        await service.ensureThumbnail(
          blobPath,
          mediaMime,
          typeof data.durationMs === 'number' ? data.durationMs : undefined,
        );
        thumb = await service.thumbnail(blobPath);
      }
      if (!thumb) return notFound();
      const thumbEtag = `"thumb-${resolved.sha256}-${thumb.width}"`;
      const thumbHeaders: Record<string, string> = {
        'Content-Type': thumb.mime,
        ETag: thumbEtag,
        'Cache-Control': 'private, max-age=86400',
        'Content-Length': String(thumb.size),
      };
      metrics?.onDownload({ outcome: 'ok' });
      if (matchesEtag(c.req.header('if-none-match'), thumbEtag)) {
        return c.body(null, 304, thumbHeaders);
      }
      return streamResponse(thumb.stream, 200, thumbHeaders);
    }

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

  // B2a: chunked-загрузка (`/:id/attachments/uploads…`). Тот же prefix-guard
  // (write) и те же лимиты/MIME, что у POST-загрузки; временный объект собирает
  // `UploadSessionStore`, публикацию делает `AttachmentService.ingestPath`.
  const uploads = deps.uploads ?? new UploadSessionStore({ service, config: deps.config });
  registerUploadSessionRoutes(app, {
    uploads,
    resolveConfig,
    messages,
    sessionExists: async (c) => Boolean(await sessionManager.getSession(c.req.param('id') ?? '')),
  });

  return app;
}

/** Запас на multipart-обвязку (границы, заголовки частей), байт. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Результат разбора multipart-загрузки: байты + имя либо готовый HTTP-отказ. */
export type AttachmentUploadForm =
  | { ok: true; bytes: Buffer; name?: string; declaredMime?: string }
  | { ok: false; response: Response };

/**
 * Разбор multipart-загрузки одного файла (поле `file`) с ранними лимитами.
 *
 * Общий для загрузки в сессию (`POST /:id/attachments`) и staging-загрузки
 * (`POST /api/v2/attachments`, ADR-115): одинаковые проверки
 * `content-length`/`size`, одинаковые коды (`413`/`400`).
 *
 * `formData()` буферизует всё тело в память, поэтому по заявленному
 * `content-length` отсекаем заведомо большие запросы до чтения. Лживый или
 * отсутствующий заголовок не проходит дальше без проверки — фактический размер
 * проверяется ниже и в сервисе (`maxBytesPerFile`).
 */
export async function readAttachmentUploadForm(
  c: Context,
  config: AttachmentsConfig,
  messages: AttachmentRouteMessages,
): Promise<AttachmentUploadForm> {
  const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
  if (
    Number.isFinite(declaredLength)
    && declaredLength > config.maxBytesPerFile + MULTIPART_OVERHEAD_BYTES
  ) {
    // ADR-094: отказ до разбора тела — вид вложения ещё неизвестен (`file`).
    getAttachmentMetricsHook()?.onUpload({ outcome: 'too_large', kind: 'file' });
    return {
      ok: false,
      response: c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: messages.tooLarge(c),
            details: { maxBytesPerFile: config.maxBytesPerFile },
          },
        },
        413,
      ),
    };
  }

  const formData = await c.req.formData().catch(() => null);
  if (!formData) {
    return {
      ok: false,
      response: c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.fileRequired(c) } },
        400,
      ),
    };
  }
  const rawFile = formData.get('file');
  const uploaded = Array.isArray(rawFile) ? rawFile[0] : rawFile;
  if (!uploaded || typeof uploaded === 'string') {
    return {
      ok: false,
      response: c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.fileRequired(c) } },
        400,
      ),
    };
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
    return {
      ok: false,
      response: c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: messages.tooLarge(c),
            details: { maxBytesPerFile: config.maxBytesPerFile },
          },
        },
        413,
      ),
    };
  }

  const bytes = Buffer.from(await uploaded.arrayBuffer());
  const rawName = formData.get('name');
  const name =
    typeof rawName === 'string' && rawName.trim() !== ''
      ? rawName
      : (uploaded as { name?: string }).name;

  return {
    ok: true,
    bytes,
    ...(name ? { name } : {}),
    ...(uploaded.type ? { declaredMime: uploaded.type } : {}),
  };
}

/**
 * Multipart ли это загрузка (совместимость с Telegram-шлюзом и старыми
 * клиентами). Иначе `POST …/attachments` принимает **raw-body**: тело запроса —
 * сам файл (ADR-115 этап B1, потоковая загрузка без буферизации).
 */
export function isMultipartUpload(c: Context): boolean {
  return (c.req.header('content-type') ?? '').trim().toLowerCase().startsWith('multipart/form-data');
}

/** Открытая raw-загрузка: поток тела + имя/заявленный MIME. */
export interface AttachmentRawUpload {
  stream: Readable;
  name?: string;
  declaredMime?: string;
}

/** Результат открытия raw-загрузки: поток либо готовый HTTP-отказ. */
export type AttachmentRawUploadResult =
  | { ok: true; upload: AttachmentRawUpload }
  | { ok: false; response: Response };

const payloadTooLarge = (
  c: Context,
  messages: AttachmentRouteMessages,
  maxBytesPerFile: number,
): Response =>
  c.json(
    {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: messages.tooLarge(c),
        details: { maxBytesPerFile },
      },
    },
    413,
  );

const fileRequired = (c: Context, messages: AttachmentRouteMessages): Response =>
  c.json({ error: { code: 'VALIDATION_ERROR', message: messages.fileRequired(c) } }, 400);

/**
 * Разбор raw-body загрузки (ADR-115 этап B1): тело запроса — файл.
 *
 * - `content-length` больше предела → `413` до чтения тела (у raw нет
 *   multipart-обвязки, поэтому без запаса `MULTIPART_OVERHEAD_BYTES`);
 * - нет тела или `content-length: 0` → `400 VALIDATION_ERROR` (как «файл не
 *   передан» в multipart-ветке);
 * - имя — `?name=` (URL-декодирован) либо `x-file-name` (percent-encoding
 *   декодируется; битая последовательность остаётся как есть), санитайз —
 *   в сервисе (`sanitizeFileName`);
 * - `declaredMime` — `content-type` без параметров (MIME всё равно проверяется
 *   по сигнатуре в сервисе).
 */
export function openAttachmentRawUpload(
  c: Context,
  config: AttachmentsConfig,
  messages: AttachmentRouteMessages,
): AttachmentRawUploadResult {
  const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > config.maxBytesPerFile) {
    getAttachmentMetricsHook()?.onUpload({ outcome: 'too_large', kind: 'file' });
    return { ok: false, response: payloadTooLarge(c, messages, config.maxBytesPerFile) };
  }

  const body = c.req.raw.body;
  if (!body || declaredLength === 0) {
    return { ok: false, response: fileRequired(c, messages) };
  }

  // `c.req.query` уже URL-декодирован; заголовок может прийти percent-encoded.
  const queryName = c.req.query('name');
  const headerName = decodeUploadName(c.req.header('x-file-name'));
  const name = queryName && queryName.trim() !== '' ? queryName : headerName;

  const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim();

  return {
    ok: true,
    upload: {
      // Глобальный `ReadableStream` (undici/Node) и `node:stream/web` в типах —
      // разные объявления одного интерфейса, поэтому каст на границе.
      stream: Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      ...(name ? { name } : {}),
      ...(contentType ? { declaredMime: contentType } : {}),
    },
  };
}

/** Декодировать имя из заголовка; битый percent-encoding — как есть. */
function decodeUploadName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * HTTP-ответ на отказ `AttachmentService.upload`: `too_large` → `413`,
 * `attachments_disabled`/`unsupported_mime` → `415`. Общий для обоих контуров
 * загрузки (сессия и staging).
 *
 * ADR-115: у `413` в `error.details.maxBytesPerFile` — фактический предел
 * инстанса (клиент показывает его в тексте ошибки); передаётся вызывающим.
 */
export function attachmentErrorResponse(
  c: Context,
  err: AttachmentError,
  messages: AttachmentRouteMessages,
  maxBytesPerFile?: number,
): Response {
  if (err.code === 'too_large') {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: messages.tooLarge(c),
          ...(typeof maxBytesPerFile === 'number'
            ? { details: { maxBytesPerFile } }
            : {}),
        },
      },
      413,
    );
  }
  if (err.code === 'attachments_disabled') {
    return c.json(
      { error: { code: 'attachments_disabled', message: messages.attachmentsDisabled(c) } },
      415,
    );
  }
  // Пустой поток raw-загрузки — «файл не передан», как в multipart-ветке.
  if (err.code === 'empty') {
    return fileRequired(c, messages);
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

/** Пределы для `details` ответа о превышении размера. */
export interface UploadLimitDetails {
  maxBytesPerFile?: number;
  maxChunkBytes?: number;
}

/** Опции регистрации chunked-загрузки (общие для сессии и staging). */
export interface UploadSessionRoutesOptions {
  uploads: UploadSessionStore;
  /** Эффективный конфиг на запрос (runtime-настройки без рестарта). */
  resolveConfig: () => AttachmentsConfig;
  messages: AttachmentRouteMessages;
  /** Проверка существования сессии (контур сессии; staging её не передаёт). */
  sessionExists?: (c: Context) => Promise<boolean>;
  /** Хук после успешного `complete` (аудит staging-контура). */
  onComplete?: (meta: UploadedAttachmentMeta, c: Context) => void | Promise<void>;
  /** База путей: сессия — `/:id/attachments/uploads`, staging — `/uploads`. */
  basePath?: string;
}

/**
 * ADR-115 (B2a): маршруты chunked-загрузки — общие для контура сессии и
 * staging-контура (различаются только базой путей, проверкой сессии и аудитом).
 *
 * - `POST   <base>`                       — инициализация `{name?, mime?, size?}`;
 * - `PUT    <base>/:uploadId?offset=N`    — часть сырых байтов;
 * - `POST   <base>/:uploadId/complete`    — публикация вложения;
 * - `DELETE <base>/:uploadId`             — отмена (идемпотентно).
 *
 * Ошибки — `{error:{code,message}}` как у остальных роутов вложений:
 * 404 неизвестная сессия загрузки, 400 смещение/валидация, 413 лимит,
 * 415 `attachments_disabled`/MIME.
 */
export function registerUploadSessionRoutes(app: Hono, opts: UploadSessionRoutesOptions): void {
  const base = opts.basePath ?? '/:id/attachments/uploads';
  const { uploads, messages } = opts;

  /**
   * Область операции: сессия-владелец контура.
   *
   * В контуре сессии база — `/:id/attachments/uploads`, поэтому `id` — id сессии:
   * загрузка привязывается к ней (sidecar на томе) и чужой сессией не
   * завершается. В staging-контуре (база `/uploads`) сессии нет — привязки нет.
   */
  const scopeOf = (c: Context): UploadSessionScope | undefined => {
    const sessionId = c.req.param('id');
    return sessionId ? { sessionId } : undefined;
  };

  const missingSession = async (c: Context): Promise<Response | null> => {
    if (!opts.sessionExists) return null;
    if (await opts.sessionExists(c)) return null;
    return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
  };

  const disabled = (c: Context): Response =>
    c.json(
      { error: { code: 'attachments_disabled', message: messages.attachmentsDisabled(c) } },
      415,
    );

  const limits = (config: AttachmentsConfig): UploadLimitDetails => ({
    maxBytesPerFile: config.maxBytesPerFile,
    maxChunkBytes: config.maxChunkBytes,
  });

  app.post(base, async (c) => {
    const missing = await missingSession(c);
    if (missing) return missing;
    const config = opts.resolveConfig();
    if (!config.enabled) return disabled(c);

    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      // Пустое тело — допустимо: все поля необязательны.
      raw = {};
    }
    const input = parseUploadInitBody(raw);
    if (!input) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.uploadInvalid(c) } },
        400,
      );
    }

    const sessionId = c.req.param('id');
    try {
      return c.json(
        await uploads.create({ ...(sessionId ? { sessionId } : {}), ...input }),
        201,
      );
    } catch (err) {
      return uploadSessionErrorResponse(c, err, messages, limits(config));
    }
  });
  app.put(`${base}/:uploadId`, async (c) => {
    const missing = await missingSession(c);
    if (missing) return missing;
    const config = opts.resolveConfig();
    if (!config.enabled) return disabled(c);

    const rawOffset = c.req.query('offset');
    const offset = rawOffset === undefined || rawOffset === '' ? Number.NaN : Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.uploadOffsetMismatch(c) } },
        400,
      );
    }

    // Ранний отказ по заявленному `content-length` — до чтения тела в память.
    const declaredLength = Number.parseInt(c.req.header('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxChunkBytes) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: messages.uploadChunkTooLarge(c),
            details: { maxChunkBytes: config.maxChunkBytes },
          },
        },
        413,
      );
    }

    // Фактический размер тоже ограничен, причём **до** накопления тела в
    // памяти: клиент может не прислать `content-length` (chunked body).
    const bytes = await readChunkBody(c, config.maxChunkBytes);
    if (!bytes) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: messages.uploadChunkTooLarge(c),
            details: { maxChunkBytes: config.maxChunkBytes },
          },
        },
        413,
      );
    }

    try {
      return c.json(
        await uploads.append(c.req.param('uploadId'), offset, bytes, scopeOf(c)),
        200,
      );
    } catch (err) {
      return uploadSessionErrorResponse(c, err, messages, limits(config));
    }
  });

  app.post(`${base}/:uploadId/complete`, async (c) => {
    const missing = await missingSession(c);
    if (missing) return missing;
    const config = opts.resolveConfig();
    if (!config.enabled) return disabled(c);

    try {
      const meta = await uploads.complete(c.req.param('uploadId'), scopeOf(c));
      if (opts.onComplete) await opts.onComplete(meta, c);
      return c.json(meta, 201);
    } catch (err) {
      return uploadSessionErrorResponse(c, err, messages, limits(config));
    }
  });

  app.delete(`${base}/:uploadId`, async (c) => {
    const missing = await missingSession(c);
    if (missing) return missing;
    // Идемпотентно: неизвестная/уже отменённая сессия — тоже 204.
    await uploads.cancel(c.req.param('uploadId'), scopeOf(c));
    return c.body(null, 204);
  });
}

/**
 * Прочитать тело части с жёстким пределом: `null` — тело больше `maxBytes`.
 *
 * Тело читается потоком (`ReadableStream`), поэтому клиент без
 * `content-length` (chunked) не может заставить сервер буферизовать мегабайты:
 * при превышении чтение отменяется и в память уже ничего не добавляется.
 */
async function readChunkBody(c: Context, maxBytes: number): Promise<Buffer | null> {
  const body = c.req.raw.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Разбор тела инициализации загрузки; `null` — некорректные поля. */
function parseUploadInitBody(raw: unknown): CreateUploadSessionInput | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const input: CreateUploadSessionInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return null;
    if (body.name.trim() !== '') input.name = body.name;
  }
  if (body.mime !== undefined) {
    if (typeof body.mime !== 'string') return null;
    if (body.mime.trim() !== '') input.declaredMime = body.mime;
  }
  if (body.size !== undefined) {
    if (typeof body.size !== 'number' || !Number.isInteger(body.size) || body.size < 0) return null;
    input.size = body.size;
  }
  return input;
}

/**
 * HTTP-ответ на отказ chunked-загрузки: `AttachmentError` — общая таблица
 * (`attachmentErrorResponse`), `UploadSessionError` — 404/400/413.
 */
export function uploadSessionErrorResponse(
  c: Context,
  err: unknown,
  messages: AttachmentRouteMessages,
  limits: UploadLimitDetails = {},
): Response {
  if (err instanceof AttachmentError) {
    return attachmentErrorResponse(c, err, messages, limits.maxBytesPerFile);
  }
  if (err instanceof UploadSessionError) {
    if (err.code === 'not_found') {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.uploadNotFound(c) } }, 404);
    }
    if (err.code === 'offset_mismatch') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.uploadOffsetMismatch(c) } },
        400,
      );
    }
    if (err.code === 'too_large_chunk') {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: messages.uploadChunkTooLarge(c),
            ...(typeof limits.maxChunkBytes === 'number'
              ? { details: { maxChunkBytes: limits.maxChunkBytes } }
              : {}),
          },
        },
        413,
      );
    }
    // too_large — общий предел файла.
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: messages.tooLarge(c),
          ...(typeof limits.maxBytesPerFile === 'number'
            ? { details: { maxBytesPerFile: limits.maxBytesPerFile } }
            : {}),
        },
      },
      413,
    );
  }
  throw err;
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

/**
 * `Content-Disposition: inline` с UTF-8-именем (RFC 6266/5987).
 *
 * Значение HTTP-заголовка — Latin-1 (`ByteString`): не-ASCII символ в
 * `filename="…"` роняет сборку `Response` (`TypeError: Cannot convert argument
 * to a ByteString`, 500 на раздаче файла с кириллическим именем). Поэтому в
 * `filename=` уходит ASCII-fallback (не-ASCII, кавычки, `\`, CR/LF → `_`),
 * а настоящее имя передаётся рядом в `filename*` (UTF-8, RFC 5987).
 */
function contentDisposition(name: string | undefined): string {
  const raw = name ?? 'attachment';
  const ascii = raw.replace(/[^\x20-\x7E]|["\\]/g, '_');
  const safe = ascii === '' ? 'attachment' : ascii;
  const encoded = encodeURIComponent(raw);
  return `inline; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/** Имя для `Content-Disposition`, если метаданных нет: сам хеш. */
function basenameOf(blobPath: string): string {
  const segments = blobPath.split('/');
  return segments[segments.length - 1] ?? 'attachment';
}
