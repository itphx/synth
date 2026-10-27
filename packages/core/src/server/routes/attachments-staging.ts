/**
 * Staging-загрузка вложений без сессии (ADR-115 §«API и лимиты»).
 *
 * `POST /api/v2/attachments` — multipart, поле `file`; **201** `{id, blobPath,
 * sha256, mime, size, name?}`. Нужна контурам, у которых нет пользовательской
 * сессии: шлюзы (Telegram/VK) принимают файл из внешнего канала, пайплайны —
 * из шага; полученный `blobPath` дальше передаётся в `POST /sessions/:id/prompt`
 * (`attachments: string[]`) или используется как артефакт прогона.
 *
 * `GET /api/v2/attachments/:sha256` — раздача байтов **по sha256** (outbound-
 * контур шлюзов): финальные вложения ответа приходят в `stream.done`
 * (`attachments[].sha256`), а байты забираются здесь — без доступа к сессии.
 * Content-addressed путь объекта выводится из хеша
 * (`attachments/<sha[0:2]>/<sha>`), поэтому контур ограничен тем же каталогом
 * (`isAttachmentPath`), а не произвольными blob'ами. `Range` не поддерживается
 * (шлюзу он не нужен), `HEAD` отдаёт те же заголовки без тела.
 *
 * Почему отдельный роут, а не `POST /sessions/:id/attachments`: staging-объект
 * **не привязан к сессии** — адресация content-addressed (`attachments/<sha2>/
 * <sha256>`), объект общий, ссылки (`blob_refs`) появляются только когда путь
 * попадёт в сообщение. Объект без ссылок живёт `attachments.gcDays` и
 * удаляется фоновым pruner'ом (`engine/attachments/prune.ts`) — отдельного TTL
 * у staging нет. Оригинальные байты сохраняются: очистка метаданных выполняется
 * на границе отправки провайдеру, а не при загрузке.
 *
 * Контур ограничен `attachments/` (`isAttachmentPath` в сервисе): раздавать
 * произвольные blob'ы через этот роут нельзя.
 *
 * Auth: фабрика принимает минимальный контракт `{requireAuth}`; core монтирует
 * под `requireAuth`, backend дополнительно вешает scope-гейт
 * (`opts.guard`, service-key — `events:ingest`). Гейт навешивается на `/*`,
 * поэтому покрывает и раздачу по sha (не только `POST /`). Лимиты и разбор
 * multipart — те же, что у загрузки в сессию (`readAttachmentUploadForm`).
 */
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import { getAttachmentMetricsHook } from '../../metrics/collectors/attachments.js';
import { ATTACHMENT_DIR, AttachmentError } from '../../engine/attachments/service.js';
import type { AttachmentService, UploadedAttachmentMeta } from '../../engine/attachments/service.js';
import {
  attachmentErrorResponse,
  DEFAULT_MESSAGES,
  readAttachmentUploadForm,
  type AttachmentRouteMessages,
} from './attachments.js';

/** SHA-256 в шестнадцатеричном виде — единственная допустимая адресация раздачи. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики (структурно совместим с core/backend AuthKit). */
export interface StagingAttachmentRoutesAuth {
  requireAuth: Middleware;
  /** Пользователь/сервис-ключ запроса — только для аудита (необязательно). */
  getCurrentUser?: (
    c: Context,
  ) => { id?: string } | null | Promise<{ id?: string } | null>;
}

/** Информация об успешной staging-загрузке для аудита (best-effort). */
export interface StagingAttachmentAuditInfo {
  meta: UploadedAttachmentMeta;
  /** id пользователя/сервис-ключа, если auth-контракт его отдаёт. */
  userId?: string;
}

export interface StagingAttachmentRoutesDeps {
  service: AttachmentService;
  /**
   * Лимиты вложений (`attachments.*`): статический снимок **или** резолвер
   * (ADR-115) — runtime-настройки из админки применяются на каждый запрос.
   */
  config: AttachmentsConfig | (() => AttachmentsConfig);
  /** Аудит успешной загрузки (best-effort: ошибка не отменяет загрузку). */
  audit?: (info: StagingAttachmentAuditInfo) => void | Promise<void>;
  /** Лог предупреждений (по умолчанию `console.warn`). */
  logger?: (message: string) => void;
}

export interface StagingAttachmentRoutesOptions {
  messages?: Partial<AttachmentRouteMessages>;
  /**
   * Дополнительный guard после `requireAuth` (backend — scope service-key,
   * напр. `scopeGuard('events:ingest')`). Для интерактивных кред guard — no-op.
   */
  guard?: Middleware;
}

/**
 * Роуты staging-загрузки (относительный путь `/`, монтируется на
 * `/api/v2/attachments`).
 */
export function createStagingAttachmentRoutes(
  auth: StagingAttachmentRoutesAuth,
  deps: StagingAttachmentRoutesDeps,
  opts: StagingAttachmentRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: AttachmentRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const log = deps.logger ?? ((message: string) => console.warn(message));
  /** Эффективные настройки на текущий запрос (ADR-115: runtime без рестарта). */
  const resolveConfig = (): AttachmentsConfig =>
    typeof deps.config === 'function' ? deps.config() : deps.config;

  // Гейт навешивается на `/*`: покрывает и `POST /` (загрузка), и
  // `GET /:sha256` (раздача) — `use('/')` матчил бы только корень.
  app.use('/*', auth.requireAuth);
  if (opts.guard) app.use('/*', opts.guard);

  app.post('/', async (c) => {
    const config = resolveConfig();
    if (!config.enabled) {
      getAttachmentMetricsHook()?.onUpload({ outcome: 'unsupported', kind: 'file' });
      return c.json(
        { error: { code: 'attachments_disabled', message: messages.attachmentsDisabled(c) } },
        415,
      );
    }

    const form = await readAttachmentUploadForm(c, config, messages);
    if (!form.ok) return form.response;

    try {
      // Сессии нет: объект живёт до появления ссылки либо до GC (`gcDays`).
      const meta = await deps.service.upload({
        bytes: form.bytes,
        ...(form.name ? { name: form.name } : {}),
        ...(form.declaredMime ? { declaredMime: form.declaredMime } : {}),
      });
      if (deps.audit) {
        const user = (await auth.getCurrentUser?.(c)) ?? null;
        try {
          await deps.audit({ meta, ...(user?.id ? { userId: user.id } : {}) });
        } catch (err) {
          // Аудит не должен отменять уже записанный объект.
          log(
            `[attachments] аудит staging-загрузки не записан: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return c.json(meta, 201);
    } catch (err) {
      if (err instanceof AttachmentError) return attachmentErrorResponse(c, err, messages);
      throw err;
    }
  });

  // GET /:sha256 — байты вложения по sha256 (outbound-контур шлюзов).
  //
  // Адрес объекта выводится из хеша (content-addressed), поэтому раздавать
  // что-то вне `attachments/` через роут нельзя; `AttachmentService.resolve`/
  // `read` дополнительно отказывают на чужих путях. Невалидный sha и
  // отсутствующий объект неотличимы (404) — существование не раскрывается.
  app.get('/:sha256', async (c) => {
    // ADR-094: исход раздачи — `ok`/`not_found`; id и пути в лейблы не идут.
    const metrics = getAttachmentMetricsHook();
    const notFound = () => {
      metrics?.onDownload({ outcome: 'not_found' });
      return c.json({ error: { code: 'NOT_FOUND', message: messages.attachmentNotFound(c) } }, 404);
    };

    const sha256 = c.req.param('sha256').trim().toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) return notFound();

    const blobPath = `${ATTACHMENT_DIR}/${sha256.slice(0, 2)}/${sha256}`;
    const resolved = await deps.service.resolve(blobPath);
    if (!resolved) return notFound();

    // `Cache-Control: private, no-store` — staging-объект не кэшируется
    // посредниками; `Range` не поддерживаем (шлюзу нужен весь файл).
    const headers: Record<string, string> = {
      'Content-Type': resolved.mime,
      'Content-Length': String(resolved.stat.size),
      'Cache-Control': 'private, no-store',
    };

    // HEAD — те же заголовки без тела и без открытия потока (дескриптор файла
    // иначе висел бы до сборки мусора).
    if (c.req.method === 'HEAD') {
      metrics?.onDownload({ outcome: 'ok' });
      return c.body(null, 200, headers);
    }

    const stream = await deps.service.read(blobPath);
    if (!stream) return notFound();
    metrics?.onDownload({ outcome: 'ok' });
    // Отдаём потоком (без буферизации в память), как раздача вложения сессии.
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers,
    });
  });

  return app;
}
