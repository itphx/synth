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
 */

/** Env-имя мастер-выключателя терминалов (ADR-023). */
export const TERMINAL_ENABLED_ENV = 'SYNTH_TERMINAL_ENABLED';

/** Значение по умолчанию: терминальный контур включён. */
export const DEFAULT_TERMINAL_ENABLED = true;

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
  const raw = env[TERMINAL_ENABLED_ENV];
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
