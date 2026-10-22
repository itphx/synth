/**
 * ADR-098 (W5): HTTP-слой деградированного хранилища.
 *
 * Общий модуль для standalone-core (`server/app.ts`) и managed backend
 * (`backend/src/app.ts`): guard (ADMIN-only + strict read-only) и диагностический
 * эндпоинт `GET /api/v2/storage/status` (проверка соединения + «нужен рестарт»).
 *
 * Экспортируется отдельным subpath (`@itphx/synth-core/server/storage-degraded.js`),
 * чтобы backend мог переиспользовать ровно ту же реализацию (без дублей).
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';
import type { StorageContext, StorageDegradedInfo } from '../storage/storage-context.js';

/** Тип состояния деградации (переэкспорт для потребителей backend). */
export type { StorageDegradedInfo };

/** HTTP-методы, мутирующие состояние домена. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Путь начинается с одного из разрешённых префиксов (segment-граница)? */
function pathAllowed(path: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  return allowlist.some((prefix) => {
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return path === base || path.startsWith(`${base}/`);
  });
}

/**
 * Поля для `/health`: аддитивно к текущему контракту `{status, version, time}`.
 * В норме — `{status:'healthy'}`; при деградации — `{status:'degraded', storage:{…}}`.
 */
export function storageHealthFields(
  degraded: StorageDegradedInfo | null | undefined,
): { status: 'healthy' } | { status: 'degraded'; storage: Record<string, unknown> } {
  if (!degraded) return { status: 'healthy' };
  return {
    status: 'degraded',
    storage: {
      degraded: true,
      backend: degraded.backend,
      fallbackDir: degraded.fallbackDir,
      reason: degraded.reason,
      since: degraded.since,
      // ADR-098 (W5): возврат к БД не автоматический — нужен рестарт; те же
      // признаки, что и у `GET /api/v2/storage/status` (recovery.restartRequired).
      restartRequired: true,
      autoRecovery: false,
    },
  };
}

export interface StorageDegradedGuardOptions {
  /** Актуальное состояние деградации (`null` — хранилище в норме). */
  getDegraded: () => StorageDegradedInfo | null;
  /**
   * Является ли текущий запрос администратором (standalone — единственный
   * владелец; managed — роль ADMIN). Не-admin в деградации получает 503.
   */
  isAdmin: (c: Context) => boolean;
  /**
   * Префиксы путей, которые разрешены даже для мутирующих методов (ремонтные
   * операции: диагностика/бэкап/выгрузка-перенос данных). По умолчанию пусто.
   */
  mutationAllowlist?: readonly string[];
  /** Тексты ошибок (i18n): по умолчанию — русские литералы. */
  messages?: {
    degraded: (c: Context) => string;
    readOnly: (c: Context) => string;
  };
}

const DEFAULT_DEGRADED_MESSAGE =
  'Хранилище недоступно: сервис работает в аварийном режиме. Доступ разрешён только администраторам.';
const DEFAULT_READONLY_MESSAGE =
  'Хранилище недоступно: сервис работает в аварийном read-only режиме. Изменяющие операции запрещены до восстановления БД и перезапуска.';

/**
 * ADR-098 (W5): guard деградированного хранилища.
 *
 * - хранилище в норме → `next()`;
 * - не-администратор → `503 STORAGE_DEGRADED`;
 * - мутирующий метод вне allowlist → `503 STORAGE_DEGRADED_READONLY`;
 * - иначе (GET/HEAD, диагностика, ремонтные операции) → `next()`.
 *
 * Вешается после аутентификации (нужен `user` для admin-проверки).
 */
export function createStorageDegradedGuard(
  opts: StorageDegradedGuardOptions,
): MiddlewareHandler {
  const degradedMessage = opts.messages?.degraded ?? (() => DEFAULT_DEGRADED_MESSAGE);
  const readOnlyMessage = opts.messages?.readOnly ?? (() => DEFAULT_READONLY_MESSAGE);

  return createMiddleware(async (c, next) => {
    const degraded = opts.getDegraded();
    if (!degraded) {
      await next();
      return;
    }

    if (!opts.isAdmin(c)) {
      return c.json(
        { error: { code: 'STORAGE_DEGRADED', message: degradedMessage(c) } },
        503,
      );
    }

    const method = c.req.method.toUpperCase();
    if (MUTATING_METHODS.has(method) && !pathAllowed(c.req.path, opts.mutationAllowlist)) {
      return c.json(
        { error: { code: 'STORAGE_DEGRADED_READONLY', message: readOnlyMessage(c) } },
        503,
      );
    }

    await next();
  });
}

export interface StorageStatusRoutesOptions {
  /** Актуальное состояние деградации (`null` — хранилище в норме). */
  getDegraded: () => StorageDegradedInfo | null;
}

/**
 * ADR-098 (W5): диагностический эндпоинт `GET /api/v2/storage/status`.
 *
 * Авто-возврата к БД нет (контекст хранилища замкнут в deps) — возврат требует
 * рестарта; эндпоинт **проверяет** соединение с исходным backend'ом и сообщает,
 * что нужен рестарт (и почему). В норме возвращает `{status:'healthy'}`.
 *
 * Доступ — только администраторам (в деградации — через guard; в норме —
 * доступен аутентифицированным).
 */
export function createStorageStatusRoutes(opts: StorageStatusRoutesOptions): Hono {
  const app = new Hono();

  app.get('/api/v2/storage/status', async (c) => {
    const degraded = opts.getDegraded();
    if (!degraded) {
      return c.json({ status: 'healthy', degraded: false });
    }

    const probe = degraded.probe ? await degraded.probe() : undefined;
    return c.json({
      status: 'degraded',
      degraded: true,
      backend: degraded.backend,
      fallbackDir: degraded.fallbackDir,
      reason: degraded.reason,
      since: degraded.since,
      recovery: {
        // Авто-возврат не реализован намеренно: StorageContext замкнут в deps,
        // живая подмена бэкенда рискованна (split-brain/гонки). Возврат — рестарт.
        autoRecovery: false,
        restartRequired: true,
        hint:
          'Восстановите соединение с БД (сеть/креды/схема — synth doctor), затем перезапустите сервис. ' +
          'Данные, созданные в файловом фоллбеке, не переносятся в БД.',
        connection: probe
          ? { ok: probe.ok, latencyMs: probe.latencyMs, error: probe.error }
          : undefined,
      },
    });
  });

  return app;
}

/** Хелпер: `degraded` из контекста хранения (или `null`). */
export function degradedOf(storage: StorageContext | undefined): StorageDegradedInfo | null {
  return storage?.degraded ?? null;
}
