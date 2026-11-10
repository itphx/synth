/**
 * ADR-133: админ-раздел «Обновления» — runtime-настройка автопроверки.
 *
 * Контракт:
 * - `GET    /api/v2/settings/updates` — эффективное значение `check`, источник,
 *   env-фиксация, канал и реестры (из config.yaml/env);
 * - `PUT    /api/v2/settings/updates` `{check: boolean}` — runtime-override
 *   (`settings.json`/PG); применяется **сразу** — планировщик перечитывает
 *   значение на каждом тике (`restartRequired: false`);
 * - `DELETE /api/v2/settings/updates` — сброс runtime к env/config/default.
 *
 * Приоритет: env `SYNTH_UPDATES_CHECK` > runtime > config.yaml `updates.check` >
 * default `false`. При env-значении запись из UI запрещена → 409 `CONFLICT`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { defaultConfig, type UpdatesConfig } from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import {
  UPDATES_CHECK_ENV,
  resolveUpdatesCheck,
  type ResolvedUpdatesCheck,
} from '../../storage/runtime-settings.js';

type Middleware = ReturnType<typeof createMiddleware>;

export interface UpdatesSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Секция `updates` из config.yaml/env (без runtime). */
  config?: Partial<UpdatesConfig>;
  /** Env (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface UpdatesSettingsMessages {
  invalidCheck?: (c: Context) => string;
  envLocked?: (c: Context) => string;
}

export interface UpdatesSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. */
  writeGuard?: Middleware;
  messages?: UpdatesSettingsMessages;
}

export interface UpdatesSettingsView {
  check: boolean;
  source: ResolvedUpdatesCheck['source'];
  envLocked: boolean;
  channel: UpdatesConfig['channel'];
  intervalHours: number;
  stableRegistry: string;
  betaRegistry: string;
  restartRequired: false;
}

const DEFAULT_INVALID_CHECK = 'updates.check: ожидается boolean';
const DEFAULT_ENV_LOCKED = `updates.check задан через ${UPDATES_CHECK_ENV} (env) — изменение из UI недоступно`;

export function createUpdatesSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: UpdatesSettingsDeps,
  opts: UpdatesSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidCheck = opts.messages?.invalidCheck ?? (() => DEFAULT_INVALID_CHECK);
  const envLockedMessage = opts.messages?.envLocked ?? (() => DEFAULT_ENV_LOCKED);

  const effectiveConfig = (): UpdatesConfig => ({ ...defaultConfig.updates, ...(deps.config ?? {}) });

  const buildView = async (): Promise<UpdatesSettingsView> => {
    const runtime = await deps.settingsStore.getUpdates();
    const runtimeCheck = typeof runtime.check === 'boolean' ? runtime.check : undefined;
    const cfg = effectiveConfig();
    const resolved = resolveUpdatesCheck(cfg.check, runtimeCheck, env);
    return {
      check: resolved.check,
      source: resolved.source,
      envLocked: resolved.envLocked,
      channel: cfg.channel,
      intervalHours: cfg.intervalHours,
      stableRegistry: cfg.stableRegistry,
      betaRegistry: cfg.betaRegistry,
      restartRequired: false,
    };
  };

  app.get('/updates', readGuard, async (c) => c.json(await buildView()));

  app.put('/updates', writeGuard, async (c) => {
    if (resolveUpdatesCheck(undefined, undefined, env).envLocked) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    const body = await c.req.json().catch(() => ({}));
    const raw =
      (body as { check?: unknown; updates?: { check?: unknown } }).check
      ?? (body as { updates?: { check?: unknown } }).updates?.check;
    if (typeof raw !== 'boolean') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalidCheck(c) } }, 400);
    }

    await deps.settingsStore.setUpdates({ check: raw });
    return c.json(await buildView());
  });

  app.delete('/updates', writeGuard, async (c) => {
    await deps.settingsStore.clearUpdates();
    return c.json(await buildView());
  });

  return app;
}
