/**
 * PROP-132: мастер-выключатель терминалов — приоритет источников.
 *
 * Значение `terminal.enabled` (секция `config.yaml`, env
 * `SYNTH_TERMINAL_ENABLED`, runtime-override в `settings.json`/PG) читается
 * **одной** функцией — и стартом процесса (композиция сервиса в `deps.ts`),
 * и HTTP-роутом `/api/v2/settings/terminal`. Поэтому правило приоритета
 * живёт здесь, а не дублируется в двух местах.
 *
 * ## Приоритет
 *
 * `env` > `runtime` (UI) > `config.yaml` > `default` (`enabled: true`).
 *
 * - **env** — `SYNTH_TERMINAL_ENABLED` (`true`/`1`/`false`/`0`; пусто или
 *   нераспознанное значение — «не задано»). Env-значение **фиксирует**
 *   выключатель: runtime из UI его не перекрывает (в UI — 409 `CONFLICT`).
 * - **runtime** — значение, сохранённое через `/api/v2/settings/terminal`
 *   (`settings.json`/PG).
 * - **config** — значение из `config.yaml` (`terminal.enabled`).
 * - **default** — `enabled: true` (контур включён по умолчанию).
 *
 * ## Почему `configEnabled` может быть `undefined`
 *
 * Секция `terminal` в конфиге **необязательна** (`terminalConfigSchema` без
 * дефолта на `enabled`): «не задано в config.yaml» и «явно задано `true`» —
 * разные вещи. Иначе источник значения в API всегда был бы `config`, и
 * admin-UI не мог бы отличить «оператор ничего не настраивал» от «оператор
 * явно включил контур».
 *
 * ## Второй флаг секции — `autoRestore`
 *
 * `terminal.autoRestore` (env `SYNTH_TERMINAL_AUTO_RESTORE`) — восстанавливать
 * ли терминалы из снимков после рестарта ядра. Правило приоритета **то же**
 * (`env` > `runtime` > `config` > `default`), но env-фиксация проверяется
 * **по полю**: зафиксированное env значение блокирует только свою настройку.
 */

/** Env-имя мастер-выключателя терминалов (ADR-023). */
export const TERMINAL_ENABLED_ENV = 'SYNTH_TERMINAL_ENABLED';

/** Env-имя флага восстановления терминалов из снимков (ADR-023). */
export const TERMINAL_AUTO_RESTORE_ENV = 'SYNTH_TERMINAL_AUTO_RESTORE';

/** Значение по умолчанию: терминальный контур включён. */
export const DEFAULT_TERMINAL_ENABLED = true;

/** Значение по умолчанию: терминалы восстанавливаются из снимков. */
export const DEFAULT_TERMINAL_AUTO_RESTORE = true;

/** Источник эффективного значения `terminal.enabled`. */
export type TerminalEnabledSource = 'env' | 'runtime' | 'config' | 'default';

/** Результат резолвинга `terminal.enabled` (env > runtime > config > default). */
export interface ResolvedTerminalEnabled {
  /** Эффективное значение мастер-выключателя. */
  enabled: boolean;
  /** Источник значения. */
  source: TerminalEnabledSource;
  /** Значение задано через env: runtime его не перекрывает. */
  envLocked: boolean;
}

/**
 * Разбор env-флага `SYNTH_TERMINAL_ENABLED` (`true`/`1`/`false`/`0`).
 * Пустое/нераспознанное значение — «не задано» (как у остальных флагов).
 */
export function parseTerminalEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  return parseBooleanEnv(env[TERMINAL_ENABLED_ENV]);
}

/**
 * Разбор env-флага `SYNTH_TERMINAL_AUTO_RESTORE` (`true`/`1`/`false`/`0`).
 * Пустое/нераспознанное значение — «не задано».
 */
export function parseTerminalEnvAutoRestore(
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  return parseBooleanEnv(env[TERMINAL_AUTO_RESTORE_ENV]);
}

/** Общий разбор булева env-флага (`true`/`1`/`false`/`0`). */
function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Эффективное значение мастер-выключателя терминалов — приоритет
 * **env > runtime > config.yaml > default (`true`)**.
 *
 * Функция чистая (без I/O): её читает и старт процесса, и роут
 * `/api/v2/settings/terminal`.
 */
export function resolveTerminalEnabled(params: {
  /** Значение `terminal.enabled` из config.yaml; `undefined` — не задано. */
  configEnabled?: boolean;
  /** Runtime-override (`settings.json`/PG); `undefined` — не задан. */
  runtimeEnabled?: boolean;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}): ResolvedTerminalEnabled {
  const fromEnv = parseTerminalEnvEnabled(params.env ?? process.env);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env', envLocked: true };
  if (params.runtimeEnabled !== undefined) {
    return { enabled: params.runtimeEnabled, source: 'runtime', envLocked: false };
  }
  if (params.configEnabled !== undefined) {
    return { enabled: params.configEnabled, source: 'config', envLocked: false };
  }
  return { enabled: DEFAULT_TERMINAL_ENABLED, source: 'default', envLocked: false };
}

/** Результат резолвинга `terminal.autoRestore`. */
export interface ResolvedTerminalAutoRestore {
  /** Эффективное значение флага восстановления. */
  autoRestore: boolean;
  /** Источник значения. */
  source: TerminalEnabledSource;
  /** Значение задано через env: runtime его не перекрывает. */
  envLocked: boolean;
}

/**
 * Эффективное значение `terminal.autoRestore` — приоритет
 * **env > runtime > config.yaml > default (`true`)**.
 */
export function resolveTerminalAutoRestore(params: {
  /** Значение `terminal.autoRestore` из config.yaml; `undefined` — не задано. */
  configAutoRestore?: boolean;
  /** Runtime-override (`settings.json`/PG); `undefined` — не задан. */
  runtimeAutoRestore?: boolean;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}): ResolvedTerminalAutoRestore {
  const fromEnv = parseTerminalEnvAutoRestore(params.env ?? process.env);
  if (fromEnv !== undefined) return { autoRestore: fromEnv, source: 'env', envLocked: true };
  if (params.runtimeAutoRestore !== undefined) {
    return { autoRestore: params.runtimeAutoRestore, source: 'runtime', envLocked: false };
  }
  if (params.configAutoRestore !== undefined) {
    return { autoRestore: params.configAutoRestore, source: 'config', envLocked: false };
  }
  return { autoRestore: DEFAULT_TERMINAL_AUTO_RESTORE, source: 'default', envLocked: false };
}

/** Приоритет слоёв: чем больше, тем «специфичнее» источник. */
const SOURCE_RANK: Record<TerminalEnabledSource, number> = {
  env: 3,
  runtime: 2,
  config: 1,
  default: 0,
};

/** Env-фиксация по полям секции `terminal`. */
export interface TerminalEnvLock {
  /** `terminal.enabled` зафиксирован env. */
  enabled: boolean;
  /** `terminal.autoRestore` зафиксирован env. */
  autoRestore: boolean;
}

/** Эффективные значения секции `terminal` (для `/api/v2/settings/terminal`). */
export interface ResolvedTerminalSettings {
  /** Эффективное значение мастер-выключателя. */
  enabled: boolean;
  /** Эффективное значение флага восстановления из снимков. */
  autoRestore: boolean;
  /**
   * Источник эффективных значений — **наиболее специфичный слой** из двух
   * (env > runtime > config > default).
   *
   * Значения секции резолвятся **по полям** (у каждого свой слой), но
   * контракт API отдаёт один `source`: он показывает, какой слой в целом
   * задаёт поведение терминалов. Env-фиксация проверяется **по полю**
   * (`envLocked` + `TerminalEnvLock`) — PUT одного поля не блокируется
   * фиксацией другого.
   */
  source: TerminalEnabledSource;
  /** Env-фиксация по полям (для проверки в `PUT`/`DELETE`). */
  envLock: TerminalEnvLock;
  /** Env зафиксировал хотя бы одно из значений. */
  envLocked: boolean;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: { enabled: boolean; autoRestore: boolean };
}

/**
 * Эффективные значения секции `terminal` — обе настройки по одному правилу
 * приоритета, общий `source` — наиболее специфичный слой.
 */
export function resolveTerminalSettings(params: {
  /** `terminal.enabled` из config.yaml. */
  configEnabled?: boolean;
  /** `terminal.autoRestore` из config.yaml. */
  configAutoRestore?: boolean;
  /** Runtime-override `enabled`. */
  runtimeEnabled?: boolean;
  /** Runtime-override `autoRestore`. */
  runtimeAutoRestore?: boolean;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}): ResolvedTerminalSettings {
  const env = params.env ?? process.env;
  const enabled = resolveTerminalEnabled({
    ...(params.configEnabled !== undefined ? { configEnabled: params.configEnabled } : {}),
    ...(params.runtimeEnabled !== undefined ? { runtimeEnabled: params.runtimeEnabled } : {}),
    env,
  });
  const autoRestore = resolveTerminalAutoRestore({
    ...(params.configAutoRestore !== undefined
      ? { configAutoRestore: params.configAutoRestore }
      : {}),
    ...(params.runtimeAutoRestore !== undefined
      ? { runtimeAutoRestore: params.runtimeAutoRestore }
      : {}),
    env,
  });
  const source: TerminalEnabledSource =
    SOURCE_RANK[enabled.source] >= SOURCE_RANK[autoRestore.source]
      ? enabled.source
      : autoRestore.source;
  const envLock: TerminalEnvLock = {
    enabled: enabled.envLocked,
    autoRestore: autoRestore.envLocked,
  };
  return {
    enabled: enabled.enabled,
    autoRestore: autoRestore.autoRestore,
    source,
    envLock,
    envLocked: envLock.enabled || envLock.autoRestore,
    defaults: {
      enabled: params.configEnabled ?? DEFAULT_TERMINAL_ENABLED,
      autoRestore: params.configAutoRestore ?? DEFAULT_TERMINAL_AUTO_RESTORE,
    },
  };
}
