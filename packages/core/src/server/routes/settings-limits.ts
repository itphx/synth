/**
 * Админ-раздел «Лимиты операций с сессиями» — instance-wide runtime-настройка
 * `limits.sessionOpsPerMinute` (лимит тяжёлых операций: import/export/fork/merge).
 *
 * Контракт:
 * - `GET    /api/v2/settings/limits` — эффективное значение, сохранённое
 *   runtime, база (config/default), источник, env-фиксация;
 * - `PUT    /api/v2/settings/limits` `{sessionOpsPerMinute: number}` —
 *   runtime-override (целое ≥ 0; `0` — без лимита), применяется к следующим
 *   запросам без рестарта (лимитер читает резолвер на каждый запрос);
 * - `DELETE /api/v2/settings/limits` — сброс runtime к env/config/default.
 *
 * Приоритет: env `SYNTH_LIMITS_SESSION_OPS_PER_MINUTE` > runtime
 * (`settings.json`/PG) > config.yaml `limits.sessionOpsPerMinute` > `10`.
 * При env-значении runtime заблокирован → 409 `CONFLICT`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { generateId, nowISO } from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  resolveSessionOpsPerMinute,
  type LiveSessionOpsPerMinute,
  type ResolvedSessionOpsPerMinute,
} from '../../storage/runtime-settings.js';

type Middleware = ReturnType<typeof createMiddleware>;

export interface RequestLimitsSettingsDeps {
  settingsStore: SettingsRepository;
  /** `limits.sessionOpsPerMinute` из config.yaml (без runtime). */
  config?: number;
  /** Живое состояние (тот же экземпляр, что у лимитеров). */
  live?: LiveSessionOpsPerMinute;
  securityAudit?: SecurityAuditRepository;
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
  env?: NodeJS.ProcessEnv;
}

export interface RequestLimitsSettingsMessages {
  invalidValue?: (c: Context, detail: string) => string;
  envLocked?: (c: Context) => string;
}

export interface RequestLimitsSettingsOptions {
  readGuard?: Middleware;
  writeGuard?: Middleware;
  messages?: RequestLimitsSettingsMessages;
}

export interface RequestLimitsSettingsView {
  sessionOpsPerMinute: number;
  saved: number | null;
  defaults: number;
  source: ResolvedSessionOpsPerMinute['source'];
  envLocked: boolean;
  restartRequired: false;
}

const DEFAULT_INVALID_VALUE = (detail: string) => `limits.sessionOpsPerMinute: ${detail}`;
const DEFAULT_ENV_LOCKED = () =>
  'limits.sessionOpsPerMinute: задано через переменную окружения — изменение из UI недоступно';

/** Целое ≥ 0 (0 — без лимита; -1/дробное отклоняются). */
function isOpsLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function createRequestLimitsSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: RequestLimitsSettingsDeps,
  opts: RequestLimitsSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidValue =
    opts.messages?.invalidValue ?? ((_c: Context, detail: string) => DEFAULT_INVALID_VALUE(detail));
  const envLockedMessage = opts.messages?.envLocked ?? ((_c: Context) => DEFAULT_ENV_LOCKED());

  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

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
        scope: 'limits',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит лимита операций с сессиями не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const buildView = async (): Promise<RequestLimitsSettingsView> => {
    const runtime = await deps.settingsStore.getSessionOpsPerMinute();
    const resolved = resolveSessionOpsPerMinute(deps.config, runtime, env);
    const defaults = resolveSessionOpsPerMinute(deps.config, undefined, {});
    return {
      sessionOpsPerMinute: resolved.value,
      saved: runtime ?? null,
      defaults: defaults.value,
      source: resolved.source,
      envLocked: resolved.envLocked,
      restartRequired: false,
    };
  };

  app.get('/limits', readGuard, async (c) => c.json(await buildView()));

  app.put('/limits', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { sessionOpsPerMinute?: unknown }).sessionOpsPerMinute;
    if (!isOpsLimit(raw)) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: invalidValue(c, 'ожидается целое число ≥ 0 (0 — без лимита)'),
          },
        },
        400,
      );
    }

    const runtime = await deps.settingsStore.getSessionOpsPerMinute();
    const before = resolveSessionOpsPerMinute(deps.config, runtime, env);
    if (before.envLocked && raw !== before.value) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    await deps.settingsStore.setSessionOpsPerMinute(raw);
    deps.live?.setRuntime(raw);

    const view = await buildView();
    await audit(c, 'update', before.value, view.sessionOpsPerMinute);
    return c.json(view);
  });

  app.delete('/limits', writeGuard, async (c) => {
    const runtime = await deps.settingsStore.getSessionOpsPerMinute();
    const before = resolveSessionOpsPerMinute(deps.config, runtime, env);

    await deps.settingsStore.clearSessionOpsPerMinute();
    deps.live?.setRuntime(undefined);

    const view = await buildView();
    await audit(c, 'reset', before.value, null);
    return c.json(view);
  });

  return app;
}
