/**
 * Админ-раздел «Дефолты оптимизации контекста» — instance-wide значения
 * `context.defaults` для **новых** сессий.
 *
 * Контракт (согласован с UI):
 * - `GET    /api/v2/settings/context-defaults` — эффективные дефолты (runtime
 *   поверх config.yaml), сохранённый runtime-патч, источник;
 * - `PUT    /api/v2/settings/context-defaults` `{defaults: Partial<ContextDefaults>}`
 *   — runtime-override (мёржится поверх config; применяется **сразу**: менеджер
 *   сессий читает резолвер при создании);
 * - `DELETE /api/v2/settings/context-defaults` — сброс runtime к config/default.
 *
 * Приоритет эффективного значения: runtime (`settings.json`/PG) > config.yaml
 * `context.defaults` > default схемы. Явные `settings` при создании сессии
 * приоритетнее любого из источников; существующие сессии не меняются.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  contextDefaultsSchema,
  generateId,
  nowISO,
  patchObjectSchema,
  type ContextDefaults,
} from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  resolveContextDefaults,
  type LiveContextDefaults,
  type ResolvedContextDefaults,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Схема частичного патча: ключи/границы из `contextDefaultsSchema`, без дефолтов. */
const contextDefaultsPatchSchema = patchObjectSchema(contextDefaultsSchema).strict();

/** Зависимости фабрики. */
export interface ContextDefaultsSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Значение `context.defaults` из config.yaml (без runtime). */
  config?: Partial<ContextDefaults>;
  /**
   * Живое состояние дефолтов процесса (тот же экземпляр, что читает
   * `SessionManager`): после PUT/DELETE обновляется без рестарта.
   */
  live?: LiveContextDefaults;
  /** Аудит изменений (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface ContextDefaultsSettingsMessages {
  invalidDefaults?: (c: Context, detail: string) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface ContextDefaultsSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: ContextDefaultsSettingsMessages;
}

const DEFAULT_INVALID_DEFAULTS = (detail: string) => `context.defaults: ${detail}`;

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface ContextDefaultsSettingsView {
  /** Эффективные дефолты (runtime > config > default). */
  defaults: ContextDefaults;
  /** Сохранённый runtime-патч (`null` — runtime-значение не задано). */
  saved: Partial<ContextDefaults> | null;
  /** Источник базы без runtime (к чему вернёт `DELETE`). */
  defaultsSource: Exclude<ResolvedContextDefaults['source'], 'runtime'>;
  source: ResolvedContextDefaults['source'];
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

/**
 * Фабрика роутов `/api/v2/settings/context-defaults`.
 * `auth.requireAuth` — обязательный guard по умолчанию.
 */
export function createContextDefaultsSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: ContextDefaultsSettingsDeps,
  opts: ContextDefaultsSettingsOptions = {},
): Hono {
  const app = new Hono();
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidDefaults =
    opts.messages?.invalidDefaults ??
    ((_c: Context, detail: string) => DEFAULT_INVALID_DEFAULTS(detail));

  /** Актор изменения (id пользователя; core без RBAC — `local`). */
  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

  /** Best-effort аудит изменения: ошибка записи не ломает операцию. */
  const audit = async (
    c: { get(key: 'user'): unknown },
    action: 'update' | 'reset',
    before: unknown,
    after: unknown,
  ): Promise<void> => {
    if (!deps.securityAudit) return;
    try {
      await deps.securityAudit.append({
        id: `sa_${generateId()}`,
        ts: nowISO(),
        actor: actorOf(c),
        scope: 'context-defaults',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит дефолтов контекста не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Снимок: эффективные значения, runtime-патч, источник. */
  const buildView = async (): Promise<ContextDefaultsSettingsView> => {
    const runtime = await deps.settingsStore.getContextDefaults();
    const resolved = resolveContextDefaults(deps.config, runtime);
    return {
      defaults: resolved.value,
      saved: runtime ?? null,
      defaultsSource: resolved.defaultsSource,
      source: resolved.source,
      restartRequired: false,
    };
  };

  app.get('/context-defaults', readGuard, async (c) => c.json(await buildView()));

  app.put('/context-defaults', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { defaults?: unknown }).defaults;
    const parsed = contextDefaultsPatchSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: invalidDefaults(c, detail || 'ожидается объект с полями ContextDefaults'),
          },
        },
        400,
      );
    }

    // PUT — частичный патч: мержим поверх сохранённого runtime-значения.
    const current = (await deps.settingsStore.getContextDefaults()) ?? {};
    const before = resolveContextDefaults(deps.config, current);
    const next = { ...current, ...parsed.data } as Partial<ContextDefaults>;
    await deps.settingsStore.setContextDefaults(next);
    deps.live?.setRuntime(next);

    const view = await buildView();
    await audit(c, 'update', before.value, view.defaults);
    return c.json(view);
  });

  app.delete('/context-defaults', writeGuard, async (c) => {
    const before = resolveContextDefaults(deps.config, await deps.settingsStore.getContextDefaults());

    await deps.settingsStore.clearContextDefaults();
    deps.live?.setRuntime(undefined);

    const view = await buildView();
    await audit(c, 'reset', before.value, null);
    return c.json(view);
  });

  return app;
}
