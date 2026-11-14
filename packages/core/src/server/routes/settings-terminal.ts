/**
 * PROP-132: мастер-выключатель терминалов — `/api/v2/settings/terminal`.
 *
 * Контракт:
 * - `GET    /api/v2/settings/terminal` — эффективное значение, источник,
 *   база (config/default), признак env-фиксации;
 * - `PUT    /api/v2/settings/terminal` `{enabled: boolean}` — runtime-override,
 *   применяется **сразу** (`TerminalService.setEnabled`: живые терминалы
 *   закрываются, создание новых запрещается — рестарт не нужен);
 * - `DELETE /api/v2/settings/terminal` — сброс runtime к env/config/default
 *   (с тем же live-применением).
 *
 * Приоритет эффективного значения: env `SYNTH_TERMINAL_ENABLED` > runtime
 * (`settings.json`/PG) > config.yaml `terminal.enabled` > default `true`.
 * При env-значении runtime заблокирован → 409 `CONFLICT` (env приоритетнее и
 * не перезаписывается из UI).
 *
 * Образец — `metrics-settings.ts` (ADR-094); правило приоритета — в
 * `engine/terminal/config.ts` (единственный источник истины для обоих
 * вызывающих: старт процесса и этот роут).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { TerminalService } from '../../engine/terminal/service.js';
import {
  DEFAULT_TERMINAL_ENABLED,
  resolveTerminalEnabled,
  type TerminalEnabledSource,
} from '../../engine/terminal/config.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости фабрики. */
export interface TerminalSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /**
   * Значение `terminal.enabled` из config.yaml (без runtime).
   * `undefined` — не задано в конфиге (дефолт — `enabled: true`).
   */
  configEnabled?: boolean;
  /**
   * Сервис терминалов инстанса — live-применение мастер-выключателя.
   * Не задан — значение только сохраняется (тесты/сборка без сервиса).
   */
  terminalService?: TerminalService;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface TerminalSettingsMessages {
  invalidEnabled?: (c: Context) => string;
  envLocked?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface TerminalSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: TerminalSettingsMessages;
}

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface TerminalSettingsView {
  /** Эффективное значение мастер-выключателя. */
  enabled: boolean;
  /** Источник эффективного значения. */
  source: TerminalEnabledSource;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: { enabled: boolean };
  /** Значение зафиксировано env — runtime из UI не перекрывает. */
  envLocked: boolean;
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

const DEFAULT_INVALID_ENABLED = 'terminal.enabled: ожидается boolean';
const DEFAULT_ENV_LOCKED = () =>
  'terminal.enabled: задано через переменную окружения — изменение из UI недоступно';

/**
 * Фабрика роутов `/api/v2/settings/terminal`.
 * `auth.requireAuth` — обязательный guard по умолчанию (core, single-user);
 * managed backend передаёт `requirePermission('ADMIN')`.
 */
export function createTerminalSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: TerminalSettingsDeps,
  opts: TerminalSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidEnabled = opts.messages?.invalidEnabled ?? (() => DEFAULT_INVALID_ENABLED);
  const envLockedMessage = opts.messages?.envLocked ?? (() => DEFAULT_ENV_LOCKED);

  /** Runtime-значение мастер-выключателя (`undefined` — не задано). */
  const readRuntime = async (): Promise<boolean | undefined> => {
    const runtime = await deps.settingsStore.getTerminal();
    return typeof runtime.enabled === 'boolean' ? runtime.enabled : undefined;
  };

  /** Снимок: эффективное значение, источник, база без runtime, env-фиксация. */
  const buildView = async (): Promise<TerminalSettingsView> => {
    const resolved = resolveTerminalEnabled({
      configEnabled: deps.configEnabled,
      runtimeEnabled: await readRuntime(),
      env,
    });
    return {
      enabled: resolved.enabled,
      source: resolved.source,
      defaults: { enabled: deps.configEnabled ?? DEFAULT_TERMINAL_ENABLED },
      envLocked: resolved.envLocked,
      restartRequired: false,
    };
  };

  /** Live-применение значения (закрытие/открытие контура — без рестарта). */
  const applyLive = (enabled: boolean): void => {
    deps.terminalService?.setEnabled(enabled);
  };

  app.get('/terminal', readGuard, async (c) => c.json(await buildView()));

  app.put('/terminal', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const enabled = (body as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: invalidEnabled(c) } },
        400,
      );
    }

    const before = resolveTerminalEnabled({
      configEnabled: deps.configEnabled,
      runtimeEnabled: await readRuntime(),
      env,
    });
    if (before.envLocked) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    await deps.settingsStore.setTerminal({ enabled });
    applyLive(enabled);

    return c.json(await buildView());
  });

  app.delete('/terminal', writeGuard, async (c) => {
    const before = resolveTerminalEnabled({
      configEnabled: deps.configEnabled,
      runtimeEnabled: await readRuntime(),
      env,
    });
    if (before.envLocked) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    await deps.settingsStore.clearTerminal();
    // После сброса эффективное значение — config/default (env заблокировал бы
    // операцию выше): применяем его к живому сервису.
    const after = resolveTerminalEnabled({
      configEnabled: deps.configEnabled,
      runtimeEnabled: undefined,
      env,
    });
    applyLive(after.enabled);

    return c.json(await buildView());
  });

  return app;
}
