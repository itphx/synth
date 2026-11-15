/**
 * PROP-132: настройки терминалов — `/api/v2/settings/terminal`.
 *
 * Контракт:
 * - `GET    /api/v2/settings/terminal` — эффективные значения, источник,
 *   база (config/default), признак env-фиксации;
 * - `PUT    /api/v2/settings/terminal` `{enabled?: boolean, autoRestore?: boolean}` —
 *   runtime-override (**частичное** обновление), применяется **сразу**
 *   (`TerminalService.setEnabled`/`setAutoRestore`: живые терминалы
 *   закрываются, создание новых запрещается, восстановление из снимков
 *   включается/выключается — рестарт не нужен);
 * - `DELETE /api/v2/settings/terminal` — сброс runtime к env/config/default
 *   (с тем же live-применением).
 *
 * ## Приоритет
 *
 * У каждого поля **свой** слой: env > runtime (`settings.json`/PG) >
 * config.yaml > default. Env-фиксация проверяется **по полю**: зафиксированное
 * env значение блокирует только свою настройку (PUT `enabled` не блокируется
 * фиксацией `autoRestore`).
 *
 * ## Что отдаёт `source`
 *
 * Значения полей резолвятся по отдельности, но контракт отдаёт **один**
 * `source` — слой, задавший поведение терминалов: **наиболее специфичный** из
 * двух (`env` > `runtime` > `config` > `default`). Точная привязка поля к
 * слою видна по `envLocked` (env зафиксировал хотя бы одно из значений) и по
 * тому, что `PUT` проверяет env-фиксацию по полю.
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
  resolveTerminalSettings,
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
   * Значение `terminal.autoRestore` из config.yaml (без runtime).
   * `undefined` — не задано в конфиге (дефолт — `autoRestore: true`).
   */
  configAutoRestore?: boolean;
  /**
   * Сервис терминалов инстанса — live-применение мастер-выключателя и флага
   * восстановления. Не задан — значение только сохраняется (тесты/сборка без
   * сервиса).
   */
  terminalService?: TerminalService;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface TerminalSettingsMessages {
  invalidEnabled?: (c: Context) => string;
  invalidAutoRestore?: (c: Context) => string;
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
  /** Эффективное значение флага восстановления терминалов из снимков. */
  autoRestore: boolean;
  /**
   * Источник эффективных значений — наиболее специфичный слой из двух
   * (`env` > `runtime` > `config` > `default`).
   */
  source: TerminalEnabledSource;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: { enabled: boolean; autoRestore: boolean };
  /** Env зафиксировал хотя бы одно из значений (runtime его не перекрывает). */
  envLocked: boolean;
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

const DEFAULT_INVALID_ENABLED = 'terminal.enabled: ожидается boolean';
const DEFAULT_INVALID_AUTO_RESTORE = 'terminal.autoRestore: ожидается boolean';
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
  const invalidAutoRestore =
    opts.messages?.invalidAutoRestore ?? (() => DEFAULT_INVALID_AUTO_RESTORE);
  const envLockedMessage = opts.messages?.envLocked ?? (() => DEFAULT_ENV_LOCKED);

  /** Runtime-значения секции `terminal` (незаданные поля — `undefined`). */
  const readRuntime = async (): Promise<{ enabled?: boolean; autoRestore?: boolean }> => {
    const runtime = await deps.settingsStore.getTerminal();
    return {
      ...(typeof runtime.enabled === 'boolean' ? { enabled: runtime.enabled } : {}),
      ...(typeof runtime.autoRestore === 'boolean' ? { autoRestore: runtime.autoRestore } : {}),
    };
  };

  /** Снимок: эффективные значения, источник, база без runtime, env-фиксация. */
  const buildView = async (): Promise<TerminalSettingsView> => {
    const runtime = await readRuntime();
    const resolved = resolveTerminalSettings({
      ...(deps.configEnabled !== undefined ? { configEnabled: deps.configEnabled } : {}),
      ...(deps.configAutoRestore !== undefined
        ? { configAutoRestore: deps.configAutoRestore }
        : {}),
      ...(runtime.enabled !== undefined ? { runtimeEnabled: runtime.enabled } : {}),
      ...(runtime.autoRestore !== undefined ? { runtimeAutoRestore: runtime.autoRestore } : {}),
      env,
    });
    return {
      enabled: resolved.enabled,
      autoRestore: resolved.autoRestore,
      source: resolved.source,
      defaults: resolved.defaults,
      envLocked: resolved.envLocked,
      restartRequired: false,
    };
  };

  /** Live-применение значений (без рестарта). */
  const applyLive = (enabled: boolean, autoRestore: boolean): void => {
    deps.terminalService?.setEnabled(enabled);
    deps.terminalService?.setAutoRestore(autoRestore);
  };

  app.get('/terminal', readGuard, async (c) => c.json(await buildView()));

  app.put('/terminal', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body ?? {}) as Record<string, unknown>;

    // Частичное обновление: задано только то, что прислали.
    const hasEnabled = 'enabled' in raw;
    const hasAutoRestore = 'autoRestore' in raw;
    if (!hasEnabled && !hasAutoRestore) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: invalidEnabled(c) } },
        400,
      );
    }

    let enabled: boolean | undefined;
    if (hasEnabled) {
      if (typeof raw['enabled'] !== 'boolean') {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: invalidEnabled(c) } },
          400,
        );
      }
      enabled = raw['enabled'];
    }

    let autoRestore: boolean | undefined;
    if (hasAutoRestore) {
      if (typeof raw['autoRestore'] !== 'boolean') {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: invalidAutoRestore(c) } },
          400,
        );
      }
      autoRestore = raw['autoRestore'];
    }

    const runtime = await readRuntime();
    const before = resolveTerminalSettings({
      ...(deps.configEnabled !== undefined ? { configEnabled: deps.configEnabled } : {}),
      ...(deps.configAutoRestore !== undefined
        ? { configAutoRestore: deps.configAutoRestore }
        : {}),
      ...(runtime.enabled !== undefined ? { runtimeEnabled: runtime.enabled } : {}),
      ...(runtime.autoRestore !== undefined ? { runtimeAutoRestore: runtime.autoRestore } : {}),
      env,
    });

    // Env-фиксация проверяется **по полю**: фиксация `enabled` не мешает
    // менять `autoRestore` (и наоборот).
    if (hasEnabled && before.envLock.enabled) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }
    if (hasAutoRestore && before.envLock.autoRestore) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    // Runtime-override — **частичный**: незаданное поле сохраняется (секция
    // пишется целиком, поэтому мержим с текущим значением).
    await deps.settingsStore.setTerminal({
      ...(runtime.enabled !== undefined ? { enabled: runtime.enabled } : {}),
      ...(runtime.autoRestore !== undefined ? { autoRestore: runtime.autoRestore } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(autoRestore !== undefined ? { autoRestore } : {}),
    });

    const after = resolveTerminalSettings({
      ...(deps.configEnabled !== undefined ? { configEnabled: deps.configEnabled } : {}),
      ...(deps.configAutoRestore !== undefined
        ? { configAutoRestore: deps.configAutoRestore }
        : {}),
      ...(enabled !== undefined ? { runtimeEnabled: enabled } : {}),
      ...(autoRestore !== undefined ? { runtimeAutoRestore: autoRestore } : {}),
      env,
    });
    applyLive(after.enabled, after.autoRestore);

    return c.json(await buildView());
  });

  app.delete('/terminal', writeGuard, async (c) => {
    const runtime = await readRuntime();
    const before = resolveTerminalSettings({
      ...(deps.configEnabled !== undefined ? { configEnabled: deps.configEnabled } : {}),
      ...(deps.configAutoRestore !== undefined
        ? { configAutoRestore: deps.configAutoRestore }
        : {}),
      ...(runtime.enabled !== undefined ? { runtimeEnabled: runtime.enabled } : {}),
      ...(runtime.autoRestore !== undefined ? { runtimeAutoRestore: runtime.autoRestore } : {}),
      env,
    });
    // Сброс runtime невозможен, если хотя бы одно из полей зафиксировано env:
    // сброс не дал бы полного эффекта (env всё равно задаёт значение).
    if (before.envLocked) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    await deps.settingsStore.clearTerminal();
    // После сброса эффективные значения — config/default (env заблокировал бы
    // операцию выше): применяем их к живому сервису.
    const after = resolveTerminalSettings({
      ...(deps.configEnabled !== undefined ? { configEnabled: deps.configEnabled } : {}),
      ...(deps.configAutoRestore !== undefined
        ? { configAutoRestore: deps.configAutoRestore }
        : {}),
      env,
    });
    applyLive(after.enabled, after.autoRestore);

    return c.json(await buildView());
  });

  return app;
}
