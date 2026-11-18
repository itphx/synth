/**
 * ADR-023: резолвер защиты от indirect prompt injection (`security.promptInjection`).
 *
 * Приоритет эффективного значения — **env > runtime (`settings.json`/PG) >
 * config.yaml > дефолт схемы** (`enabled: true`, `wrapContent: true`,
 * `mode: 'flag'`).
 *
 * `wrapContent` runtime-настройкой **не управляется**: это deployment-политика
 * обёртки tool-контента (`[CONTENT | SOURCE: … | trust: …]`), она берётся из
 * config.yaml (или дефолта), а не из UI.
 *
 * Env-ключи (`SYNTH_SECURITY_PROMPT_INJECTION_ENABLED`/`…_MODE`) намеренно
 * **не** входят в `ENV_OVERRIDES` (`env-overrides.ts`): там только двухуровневые
 * пути `<section>.<key>`, а у `promptInjection` два поля и нужен
 * `envLockedFields` (фиксация проверяется **по полю**, как у `resolveSshMode`).
 * Невалидное env-значение — warn + игнор (fail-soft).
 */
import type { PromptInjectionConfig } from './types.js';

/** Режим детекции подозрительных паттернов (канон схемы). */
export type PromptInjectionMode = PromptInjectionConfig['mode'];

/** Канонические режимы (для валидации env/API). */
export const PROMPT_INJECTION_MODES: readonly PromptInjectionMode[] = ['flag', 'sanitize', 'block'];

/** Поля секции, управляемые runtime-настройкой (и env-фиксацией). */
export type PromptInjectionField = 'enabled' | 'mode';

/** Канонический порядок полей (для `envLockedFields` и обхода). */
export const PROMPT_INJECTION_FIELDS: readonly PromptInjectionField[] = ['enabled', 'mode'];

/**
 * Runtime-патч защиты от prompt injection (раздел «Безопасность» в UI).
 *
 * `wrapContent` сюда не входит осознанно — runtime его не перекрывает.
 */
export interface PromptInjectionRuntimePatch {
  enabled?: boolean;
  mode?: PromptInjectionMode;
}

/** Источник эффективного значения (по полям, наиболее специфичный). */
export type PromptInjectionSource = 'env' | 'runtime' | 'config' | 'default';

/** Результат резолвинга `security.promptInjection` (env > runtime > config > default). */
export interface ResolvedPromptInjectionConfig {
  /** Эффективная секция (все поля заданы) — её читают guard и оркестратор. */
  config: PromptInjectionConfig;
  /** Наиболее специфичный источник среди полей `enabled`/`mode`. */
  source: PromptInjectionSource;
  /** Хотя бы одно поле задано через env: runtime его не перекрывает. */
  envLocked: boolean;
  /** Поля, зафиксированные env: из UI они `disabled` и не уходят в `PUT`. */
  envLockedFields: PromptInjectionField[];
  /** База без runtime и env (к чему вернёт сброс) — для `defaults` в ответе API. */
  defaults: PromptInjectionConfig;
}

/** Env-имя выключателя защиты (ADR-023). */
export const PROMPT_INJECTION_ENABLED_ENV = 'SYNTH_SECURITY_PROMPT_INJECTION_ENABLED';

/** Env-имя режима детекции (ADR-023). */
export const PROMPT_INJECTION_MODE_ENV = 'SYNTH_SECURITY_PROMPT_INJECTION_MODE';

/** Дефолты схемы — совпадают с `defaultConfig.security.promptInjection`. */
export const DEFAULT_PROMPT_INJECTION_CONFIG: PromptInjectionConfig = {
  enabled: true,
  wrapContent: true,
  mode: 'flag',
};

/** Прочитать boolean из env (`true`/`1`, `false`/`0`); пусто/невалидно — «не задано». */
export function parsePromptInjectionEnabledEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const raw = env[PROMPT_INJECTION_ENABLED_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  console.warn(
    `[config] невалидное значение ${PROMPT_INJECTION_ENABLED_ENV}="${raw}" (ожидается boolean) — игнорируется`,
  );
  return undefined;
}

/** Прочитать режим из env; невалидное — warn + игнор (fail-soft). */
export function parsePromptInjectionModeEnv(
  env: NodeJS.ProcessEnv = process.env,
): PromptInjectionMode | undefined {
  const raw = env[PROMPT_INJECTION_MODE_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim();
  if ((PROMPT_INJECTION_MODES as readonly string[]).includes(value)) {
    return value as PromptInjectionMode;
  }
  console.warn(
    `[config] невалидное значение ${PROMPT_INJECTION_MODE_ENV}="${raw}" (ожидается ${PROMPT_INJECTION_MODES.join('|')}) — игнорируется`,
  );
  return undefined;
}

/**
 * Эффективная секция `security.promptInjection` — приоритет
 * **env > runtime > config.yaml > дефолт схемы**.
 *
 * **«Задано явно» vs «дефолт».** Схема конфига префилит секцию
 * (`promptInjectionConfigSchema.prefault({})`), поэтому на чистом инстансе
 * `config` уже равен дефолтам — хотя в `config.yaml` значений нет. Поле,
 * значение которого равно дефолту схемы, отдаётся с `source:'default'`
 * (UI показывает бейдж «по умолчанию»); явное значение в конфиге, совпавшее с
 * дефолтом, неотличимо от его отсутствия — эффективное значение одно и то же
 * (тот же приём, что у `resolveBackgroundConfig`/`resolveSessionOpsPerMinute`).
 *
 * Функция чистая (без I/O): её читают точка сборки (старт процесса), роут
 * `/api/v2/settings/security` и live-применение из UI — расхождений в
 * приоритете быть не должно.
 */
export function resolvePromptInjection(
  config?: Partial<PromptInjectionConfig>,
  runtime?: PromptInjectionRuntimePatch,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPromptInjectionConfig {
  const envEnabled = parsePromptInjectionEnabledEnv(env);
  const envMode = parsePromptInjectionModeEnv(env);

  const configEnabled = config?.enabled;
  const configMode = config?.mode;
  const runtimeEnabled = runtime?.enabled;
  const runtimeMode = runtime?.mode;

  const sources: Record<PromptInjectionField, PromptInjectionSource> = {
    enabled: 'default',
    mode: 'default',
  };
  const effective: Pick<PromptInjectionConfig, 'enabled' | 'mode'> = {
    enabled: DEFAULT_PROMPT_INJECTION_CONFIG.enabled,
    mode: DEFAULT_PROMPT_INJECTION_CONFIG.mode,
  };

  if (envEnabled !== undefined) {
    effective.enabled = envEnabled;
    sources.enabled = 'env';
  } else if (runtimeEnabled !== undefined) {
    effective.enabled = runtimeEnabled;
    sources.enabled = 'runtime';
  } else if (
    configEnabled !== undefined &&
    configEnabled !== DEFAULT_PROMPT_INJECTION_CONFIG.enabled
  ) {
    effective.enabled = configEnabled;
    sources.enabled = 'config';
  }

  if (envMode !== undefined) {
    effective.mode = envMode;
    sources.mode = 'env';
  } else if (runtimeMode !== undefined) {
    effective.mode = runtimeMode;
    sources.mode = 'runtime';
  } else if (configMode !== undefined && configMode !== DEFAULT_PROMPT_INJECTION_CONFIG.mode) {
    effective.mode = configMode;
    sources.mode = 'config';
  }

  const envLockedFields = PROMPT_INJECTION_FIELDS.filter((field) => sources[field] === 'env');
  const order: PromptInjectionSource[] = ['env', 'runtime', 'config', 'default'];
  const source = order.find((layer) => PROMPT_INJECTION_FIELDS.some((f) => sources[f] === layer))
    ?? 'default';

  return {
    config: {
      enabled: effective.enabled,
      // `wrapContent` — только база (config.yaml/дефолт), runtime не управляет.
      wrapContent: config?.wrapContent ?? DEFAULT_PROMPT_INJECTION_CONFIG.wrapContent,
      mode: effective.mode,
    },
    source,
    envLocked: envLockedFields.length > 0,
    envLockedFields,
    defaults: {
      enabled: configEnabled ?? DEFAULT_PROMPT_INJECTION_CONFIG.enabled,
      wrapContent: config?.wrapContent ?? DEFAULT_PROMPT_INJECTION_CONFIG.wrapContent,
      mode: configMode ?? DEFAULT_PROMPT_INJECTION_CONFIG.mode,
    },
  };
}
