/**
 * PROP-132: параметры выполнения терминалов — приоритет источников.
 *
 * Значения секции `terminal` (config.yaml, env `SYNTH_TERMINAL_*`, runtime-override
 * в `settings.json`/PG) читаются **одной** функцией — и стартом процесса
 * (композиция сервиса в `deps.ts`), и HTTP-роутом `/api/v2/settings/terminal`.
 * Поэтому правило приоритета живёт здесь, а не дублируется в двух местах.
 *
 * ## Поля секции и границы
 *
 * | поле            | env-имя                          | default | границы       |
 * |-----------------|----------------------------------|---------|---------------|
 * | `enabled`       | `SYNTH_TERMINAL_ENABLED`         | `true`  | —             |
 * | `autoRestore`   | `SYNTH_TERMINAL_AUTO_RESTORE`    | `true`  | —             |
 * | `idleMinutes`   | `SYNTH_TERMINAL_IDLE_MINUTES`    | `2880`  | 30…10080      |
 * | `maxPerProject` | `SYNTH_TERMINAL_MAX_PER_PROJECT` | `8`     | 1…64          |
 * | `maxPerInstance`| `SYNTH_TERMINAL_MAX_PER_INSTANCE`| `32`    | 1…256         |
 * | `shell`         | `SYNTH_TERMINAL_SHELL`           | `null`  | паттерн ниже  |
 * | `auditInput`    | `SYNTH_TERMINAL_AUDIT_INPUT`     | `true`  | —             |
 *
 * Имена env совпадают с общим правилом `ENV_OVERRIDES` (`SYNTH_<SECTION>_<KEY>`,
 * camelCase → SNAKE_CASE): те же переменные читает загрузчик конфига, что и
 * резолвер — один путь на переменную, второй не заводится.
 *
 * ## Приоритет
 *
 * `env` > `runtime` (UI) > `config.yaml` > `default` — **по каждому полю**
 * отдельно. Объектные `config`/`runtime` приоритетнее плоских параметров
 * (`configEnabled`/`configAutoRestore`/`runtimeEnabled`/`runtimeAutoRestore`):
 * плоские оставлены для совместимости существующих вызовов и помечены
 * `@deprecated`.
 *
 * - **env** — значения разбираются по типу (boolean — `true`/`1`/`false`/`0`;
 *   number — целое в границах поля; string — trim). Пустое или нераспознанное
 *   значение = «не задано» (как у булевых флагов). Env-значение **фиксирует**
 *   поле: runtime из UI его не перекрывает (в UI — 409 `CONFLICT`), причём
 *   фиксация проверяется **по полю** (`envLock`): зафиксированный `enabled` не
 *   блокирует правку `idleMinutes`.
 * - **runtime** — значение, сохранённое через `/api/v2/settings/terminal`
 *   (`settings.json`/PG).
 * - **config** — значение из `config.yaml` (`terminal.*`).
 * - **default** — константы `DEFAULT_TERMINAL_*` этого модуля.
 *
 * ## Невалидные значения runtime/config
 *
 * Функция **чистая** (без I/O и без записи в лог): значение слоя вне границ
 * (или неверного типа) просто **игнорируется** — действует следующий по
 * приоритету слой. Валидацию пользовательского ввода делает роут (400
 * `VALIDATION_ERROR`), здесь — только защита резолвера от «мусора» в
 * `settings.json`/конфиге (например, после ручной правки файла).
 *
 * ## Почему `configEnabled` может быть `undefined`
 *
 * Секция `terminal` в конфиге **необязательна** (`terminalConfigSchema` без
 * дефолтов): «не задано в config.yaml» и «явно задано значение по умолчанию» —
 * разные вещи. Иначе источник значения в API всегда был бы `config`, и
 * admin-UI не мог бы отличить «оператор ничего не настраивал» от явной
 * настройки.
 */
import type { TerminalConfig } from '@itphx/synth-shared/config';
import type { TerminalRuntimeSettings } from '../../storage/runtime-settings.js';

// --- Env-имена (ADR-023) ---

/** Env-имя мастер-выключателя терминалов (ADR-023). */
export const TERMINAL_ENABLED_ENV = 'SYNTH_TERMINAL_ENABLED';

/** Env-имя флага восстановления терминалов из снимков (ADR-023). */
export const TERMINAL_AUTO_RESTORE_ENV = 'SYNTH_TERMINAL_AUTO_RESTORE';

/** Env-имя простоя терминала в минутах (он же TTL снимков). */
export const TERMINAL_IDLE_MINUTES_ENV = 'SYNTH_TERMINAL_IDLE_MINUTES';

/** Env-имя предела живых терминалов на проект. */
export const TERMINAL_MAX_PER_PROJECT_ENV = 'SYNTH_TERMINAL_MAX_PER_PROJECT';

/** Env-имя предела живых терминалов на инстанс. */
export const TERMINAL_MAX_PER_INSTANCE_ENV = 'SYNTH_TERMINAL_MAX_PER_INSTANCE';

/** Env-имя оболочки терминала (имя программы или абсолютный путь). */
export const TERMINAL_SHELL_ENV = 'SYNTH_TERMINAL_SHELL';

/** Env-имя флага журналирования ввода в терминал (`terminal.input`). */
export const TERMINAL_AUDIT_INPUT_ENV = 'SYNTH_TERMINAL_AUDIT_INPUT';

// --- Дефолты ---

/** Значение по умолчанию: терминальный контур включён. */
export const DEFAULT_TERMINAL_ENABLED = true;

/** Значение по умолчанию: терминалы восстанавливаются из снимков. */
export const DEFAULT_TERMINAL_AUTO_RESTORE = true;

/** Значение по умолчанию: простой до закрытия терминала — 2 дня. */
export const DEFAULT_TERMINAL_IDLE_MINUTES = 2880;

/** Значение по умолчанию: предел живых терминалов на проект. */
export const DEFAULT_TERMINAL_MAX_PER_PROJECT = 8;

/** Значение по умолчанию: предел живых терминалов на инстанс. */
export const DEFAULT_TERMINAL_MAX_PER_INSTANCE = 32;

/** Значение по умолчанию: журналировать ввод в терминал. */
export const DEFAULT_TERMINAL_AUDIT_INPUT = true;

// --- Границы и паттерны ---

/** Целочисленный диапазон значения (включительно). */
export interface TerminalNumericBounds {
  /** Нижняя граница (включительно). */
  readonly min: number;
  /** Верхняя граница (включительно). */
  readonly max: number;
}

/** Границы `terminal.idleMinutes` — минуты (30 минут … 7 дней). */
export const TERMINAL_IDLE_MINUTES_RANGE: TerminalNumericBounds = { min: 30, max: 10_080 };

/** Границы `terminal.maxPerProject`. */
export const TERMINAL_MAX_PER_PROJECT_RANGE: TerminalNumericBounds = { min: 1, max: 64 };

/** Границы `terminal.maxPerInstance`. */
export const TERMINAL_MAX_PER_INSTANCE_RANGE: TerminalNumericBounds = { min: 1, max: 256 };

/**
 * Паттерн `terminal.shell`: имя программы или абсолютный путь без пробелов
 * (`bash`, `/bin/zsh`, `./bin/sh`). Пробелы/аргументы запрещены — оболочка
 * запускается как один argv-элемент.
 */
export const TERMINAL_SHELL_PATTERN = /^[A-Za-z0-9._/+-]{1,200}$/;

// --- Типы ---

/** Источник эффективного значения поля секции `terminal`. */
export type TerminalEnabledSource = 'env' | 'runtime' | 'config' | 'default';

/** Поля секции `terminal`, резолвимые по отдельности. */
export type TerminalSettingsField =
  | 'enabled'
  | 'autoRestore'
  | 'idleMinutes'
  | 'maxPerProject'
  | 'maxPerInstance'
  | 'shell'
  | 'auditInput';

/** Env-фиксация по полям секции `terminal`. */
export type TerminalEnvLock = Record<TerminalSettingsField, boolean>;

/** Источник **каждого** поля секции `terminal`. */
export type TerminalSettingsSources = Record<TerminalSettingsField, TerminalEnabledSource>;

/** База без runtime (к чему вернёт `DELETE /api/v2/settings/terminal`). */
export interface TerminalSettingsDefaults {
  /** Мастер-выключатель (config.yaml либо дефолт). */
  enabled: boolean;
  /** Восстановление терминалов из снимков (config.yaml либо дефолт). */
  autoRestore: boolean;
  /** Простой терминала в минутах (config.yaml либо дефолт). */
  idleMinutes: number;
  /** Предел терминалов на проект (config.yaml либо дефолт). */
  maxPerProject: number;
  /** Предел терминалов на инстанс (config.yaml либо дефолт). */
  maxPerInstance: number;
  /** Оболочка терминала; `null` — платформенный дефолт. */
  shell: string | null;
  /** Журналирование ввода (config.yaml либо дефолт). */
  auditInput: boolean;
}

/** Результат резолвинга `terminal.enabled` (env > runtime > config > default). */
export interface ResolvedTerminalEnabled {
  /** Эффективное значение мастер-выключателя. */
  enabled: boolean;
  /** Источник значения. */
  source: TerminalEnabledSource;
  /** Значение задано через env: runtime его не перекрывает. */
  envLocked: boolean;
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

/** Эффективные значения секции `terminal` (для `/api/v2/settings/terminal`). */
export interface ResolvedTerminalSettings {
  /** Эффективное значение мастер-выключателя. */
  enabled: boolean;
  /** Эффективное значение флага восстановления из снимков. */
  autoRestore: boolean;
  /** Эффективный простой терминала (минуты, он же TTL снимков). */
  idleMinutes: number;
  /** Эффективный предел живых терминалов на проект. */
  maxPerProject: number;
  /** Эффективный предел живых терминалов на инстанс. */
  maxPerInstance: number;
  /** Эффективная оболочка; `null` — платформенный дефолт. */
  shell: string | null;
  /** Эффективный флаг журналирования ввода (`terminal.input`). */
  auditInput: boolean;
  /**
   * Источник эффективных значений — **наиболее специфичный слой** из полей
   * (env > runtime > config > default).
   *
   * Значения секции резолвятся **по полям** (у каждого свой слой), но
   * контракт API отдаёт один `source`: он показывает, какой слой в целом
   * задаёт поведение терминалов. Точная привязка полей — в `sources`,
   * env-фиксация проверяется **по полю** (`envLock` + `TerminalEnvLock`).
   */
  source: TerminalEnabledSource;
  /** Источник **каждого** поля секции. */
  sources: TerminalSettingsSources;
  /** Env-фиксация по полям (для проверки в `PUT`/`DELETE`). */
  envLock: TerminalEnvLock;
  /** Env зафиксировал хотя бы одно из значений. */
  envLocked: boolean;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: TerminalSettingsDefaults;
}

/** Разобранное значение одного поля: значение, источник, env-фиксация. */
interface ResolvedField<T> {
  value: T;
  source: TerminalEnabledSource;
  envLocked: boolean;
}

// --- Разбор env ---

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
 * Разбор числового env-значения в границах поля: пустое, нечисловое,
 * нецелое или вне диапазона — «не задано».
 */
function readEnvNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  bounds: TerminalNumericBounds,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return normalizeRangeValue(parsed, bounds);
}

/** Разбор env-значения оболочки: пустое/невалидный паттерн — «не задано». */
function readEnvShell(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  return TERMINAL_SHELL_PATTERN.test(trimmed) ? trimmed : undefined;
}

// --- Нормализация значений слоёв ---

/** Boolean-значение слоя; иной тип — «не задано». */
function normalizeBooleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Число в границах поля (целое); `undefined`/иной тип/вне диапазона —
 * «не задано» (слой игнорируется, действует следующий по приоритету).
 */
function normalizeRangeValue(value: unknown, bounds: TerminalNumericBounds): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < bounds.min || value > bounds.max) return undefined;
  return value;
}

/**
 * Оболочка терминала: `null`/пустая строка → `null` («платформенный дефолт»),
 * иначе trim; невалидный паттерн (или не строка) — «не задано»
 * (`undefined` — слой игнорируется).
 */
function normalizeShellValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return TERMINAL_SHELL_PATTERN.test(trimmed) ? trimmed : undefined;
}

// --- Резолвинг поля и секции ---

/** Приоритет слоёв: чем больше, тем «специфичнее» источник. */
const SOURCE_RANK: Record<TerminalEnabledSource, number> = {
  env: 3,
  runtime: 2,
  config: 1,
  default: 0,
};

/**
 * Эффективное значение одного поля: env > runtime > config > default.
 *
 * «Не задано» — `undefined` (env-разбор и нормализация слоёв возвращают
 * `undefined` для невалидных значений), поэтому невалидный слой молча
 * уступает следующему.
 */
function resolveField<T>(params: {
  envValue: T | undefined;
  runtimeValue: T | undefined;
  configValue: T | undefined;
  defaultValue: T;
}): ResolvedField<T> {
  if (params.envValue !== undefined) {
    return { value: params.envValue, source: 'env', envLocked: true };
  }
  if (params.runtimeValue !== undefined) {
    return { value: params.runtimeValue, source: 'runtime', envLocked: false };
  }
  if (params.configValue !== undefined) {
    return { value: params.configValue, source: 'config', envLocked: false };
  }
  return { value: params.defaultValue, source: 'default', envLocked: false };
}

/** Наиболее специфичный источник среди полей секции. */
function mostSpecificSource(sources: TerminalSettingsSources): TerminalEnabledSource {
  let best: TerminalEnabledSource = 'default';
  for (const source of Object.values(sources) as TerminalEnabledSource[]) {
    if (SOURCE_RANK[source] > SOURCE_RANK[best]) best = source;
  }
  return best;
}

/** Параметры резолвинга эффективных значений секции `terminal`. */
export interface ResolveTerminalSettingsParams {
  /**
   * Секция `terminal` из config.yaml (объектная форма — приоритетнее плоских
   * `configEnabled`/`configAutoRestore`).
   */
  config?: Partial<TerminalConfig>;
  /**
   * Runtime-override (`settings.json`/PG; объектная форма — приоритетнее
   * плоских `runtimeEnabled`/`runtimeAutoRestore`).
   */
  runtime?: TerminalRuntimeSettings;
  /**
   * @deprecated Плоское `terminal.enabled` из config.yaml — совместимость
   * существующих вызовов; используйте `config: { enabled }`.
   */
  configEnabled?: boolean;
  /**
   * @deprecated Плоское `terminal.autoRestore` из config.yaml — используйте
   * `config: { autoRestore }`.
   */
  configAutoRestore?: boolean;
  /**
   * @deprecated Плоский runtime-override `enabled` — используйте
   * `runtime: { enabled }`.
   */
  runtimeEnabled?: boolean;
  /**
   * @deprecated Плоский runtime-override `autoRestore` — используйте
   * `runtime: { autoRestore }`.
   */
  runtimeAutoRestore?: boolean;
  /** Env (тесты); по умолчанию — `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Эффективные значения мастер-выключателя терминалов — приоритет
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
  const resolved = resolveField<boolean>({
    envValue: parseTerminalEnvEnabled(params.env ?? process.env),
    runtimeValue: normalizeBooleanValue(params.runtimeEnabled),
    configValue: normalizeBooleanValue(params.configEnabled),
    defaultValue: DEFAULT_TERMINAL_ENABLED,
  });
  return { enabled: resolved.value, source: resolved.source, envLocked: resolved.envLocked };
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
  const resolved = resolveField<boolean>({
    envValue: parseTerminalEnvAutoRestore(params.env ?? process.env),
    runtimeValue: normalizeBooleanValue(params.runtimeAutoRestore),
    configValue: normalizeBooleanValue(params.configAutoRestore),
    defaultValue: DEFAULT_TERMINAL_AUTO_RESTORE,
  });
  return { autoRestore: resolved.value, source: resolved.source, envLocked: resolved.envLocked };
}

/**
 * Эффективные значения секции `terminal` — все настройки по одному правилу
 * приоритета (env > runtime > config > default, **по каждому полю**), общий
 * `source` — наиболее специфичный слой.
 */
export function resolveTerminalSettings(
  params: ResolveTerminalSettingsParams = {},
): ResolvedTerminalSettings {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const runtime = params.runtime ?? {};

  // Объектная форма приоритетнее плоской (@deprecated) — второй путь не
  // заводит новых вызовов, но и не ломает существующие (`deps.ts`).
  const configEnabled = config.enabled ?? params.configEnabled;
  const configAutoRestore = config.autoRestore ?? params.configAutoRestore;
  const runtimeEnabled = runtime.enabled ?? params.runtimeEnabled;
  const runtimeAutoRestore = runtime.autoRestore ?? params.runtimeAutoRestore;

  // Слой config — нормализованный (невалидное значение = «не задано»);
  // он же база `defaults` (к чему вернёт сброс runtime).
  const configValues = {
    enabled: normalizeBooleanValue(configEnabled),
    autoRestore: normalizeBooleanValue(configAutoRestore),
    idleMinutes: normalizeRangeValue(config.idleMinutes, TERMINAL_IDLE_MINUTES_RANGE),
    maxPerProject: normalizeRangeValue(config.maxPerProject, TERMINAL_MAX_PER_PROJECT_RANGE),
    maxPerInstance: normalizeRangeValue(config.maxPerInstance, TERMINAL_MAX_PER_INSTANCE_RANGE),
    shell: normalizeShellValue(config.shell),
    auditInput: normalizeBooleanValue(config.auditInput),
  };

  const enabled = resolveField<boolean>({
    envValue: parseTerminalEnvEnabled(env),
    runtimeValue: normalizeBooleanValue(runtimeEnabled),
    configValue: configValues.enabled,
    defaultValue: DEFAULT_TERMINAL_ENABLED,
  });
  const autoRestore = resolveField<boolean>({
    envValue: parseTerminalEnvAutoRestore(env),
    runtimeValue: normalizeBooleanValue(runtimeAutoRestore),
    configValue: configValues.autoRestore,
    defaultValue: DEFAULT_TERMINAL_AUTO_RESTORE,
  });
  const idleMinutes = resolveField<number>({
    envValue: readEnvNumber(env, TERMINAL_IDLE_MINUTES_ENV, TERMINAL_IDLE_MINUTES_RANGE),
    runtimeValue: normalizeRangeValue(runtime.idleMinutes, TERMINAL_IDLE_MINUTES_RANGE),
    configValue: configValues.idleMinutes,
    defaultValue: DEFAULT_TERMINAL_IDLE_MINUTES,
  });
  const maxPerProject = resolveField<number>({
    envValue: readEnvNumber(env, TERMINAL_MAX_PER_PROJECT_ENV, TERMINAL_MAX_PER_PROJECT_RANGE),
    runtimeValue: normalizeRangeValue(runtime.maxPerProject, TERMINAL_MAX_PER_PROJECT_RANGE),
    configValue: configValues.maxPerProject,
    defaultValue: DEFAULT_TERMINAL_MAX_PER_PROJECT,
  });
  const maxPerInstance = resolveField<number>({
    envValue: readEnvNumber(env, TERMINAL_MAX_PER_INSTANCE_ENV, TERMINAL_MAX_PER_INSTANCE_RANGE),
    runtimeValue: normalizeRangeValue(runtime.maxPerInstance, TERMINAL_MAX_PER_INSTANCE_RANGE),
    configValue: configValues.maxPerInstance,
    defaultValue: DEFAULT_TERMINAL_MAX_PER_INSTANCE,
  });
  const shell = resolveField<string | null>({
    envValue: readEnvShell(env, TERMINAL_SHELL_ENV),
    runtimeValue: normalizeShellValue(runtime.shell),
    configValue: configValues.shell,
    defaultValue: null,
  });
  const auditInput = resolveField<boolean>({
    envValue: parseBooleanEnv(env[TERMINAL_AUDIT_INPUT_ENV]),
    runtimeValue: normalizeBooleanValue(runtime.auditInput),
    configValue: configValues.auditInput,
    defaultValue: DEFAULT_TERMINAL_AUDIT_INPUT,
  });

  const sources: TerminalSettingsSources = {
    enabled: enabled.source,
    autoRestore: autoRestore.source,
    idleMinutes: idleMinutes.source,
    maxPerProject: maxPerProject.source,
    maxPerInstance: maxPerInstance.source,
    shell: shell.source,
    auditInput: auditInput.source,
  };
  const envLock: TerminalEnvLock = {
    enabled: enabled.envLocked,
    autoRestore: autoRestore.envLocked,
    idleMinutes: idleMinutes.envLocked,
    maxPerProject: maxPerProject.envLocked,
    maxPerInstance: maxPerInstance.envLocked,
    shell: shell.envLocked,
    auditInput: auditInput.envLocked,
  };

  return {
    enabled: enabled.value,
    autoRestore: autoRestore.value,
    idleMinutes: idleMinutes.value,
    maxPerProject: maxPerProject.value,
    maxPerInstance: maxPerInstance.value,
    shell: shell.value,
    auditInput: auditInput.value,
    source: mostSpecificSource(sources),
    sources,
    envLock,
    envLocked: Object.values(envLock).some(Boolean),
    defaults: {
      enabled: configValues.enabled ?? DEFAULT_TERMINAL_ENABLED,
      autoRestore: configValues.autoRestore ?? DEFAULT_TERMINAL_AUTO_RESTORE,
      idleMinutes: configValues.idleMinutes ?? DEFAULT_TERMINAL_IDLE_MINUTES,
      maxPerProject: configValues.maxPerProject ?? DEFAULT_TERMINAL_MAX_PER_PROJECT,
      maxPerInstance: configValues.maxPerInstance ?? DEFAULT_TERMINAL_MAX_PER_INSTANCE,
      shell: configValues.shell ?? null,
      auditInput: configValues.auditInput ?? DEFAULT_TERMINAL_AUDIT_INPUT,
    },
  };
}
