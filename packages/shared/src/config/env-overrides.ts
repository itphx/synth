/**
 * ADR-023: декларативные env-оверрайды скалярных ключей конфигурации.
 *
 * Имя переменной собирается по правилу `SYNTH_<SECTION>_<KEY>`, где camelCase
 * ключа переводится в SNAKE_CASE (`autoBind` → `SYNTH_EVENTS_AUTO_BIND`,
 * `ephemeralTtl` → `SYNTH_EVENTS_EPHEMERAL_TTL`). Реестр `ENV_OVERRIDES` —
 * единственный источник истины; применяется **в одном месте** (`loadConfig`,
 * после слияния defaults + config.yaml и до CLI-overrides), поэтому все
 * потребители `@itphx/synth-shared/config` получают поддержку автоматически.
 *
 * Приоритет (ADR-023): CLI-флаги (`overrides`) > env (`SYNTH_*`) > config.yaml > defaults.
 */
import { bootstrapServiceKeysSchema } from './types.js';

export type EnvOverrideType = 'boolean' | 'number' | 'string';

export interface EnvOverrideDefinition {
  /** Секция верхнего уровня конфига (`events`, `scheduler`, `webhooks`, `decision`). */
  section: string;
  /** Ключ внутри секции (camelCase, как в `types.ts`). */
  key: string;
  /** Тип значения для парсинга env-строки. */
  type: EnvOverrideType;
}

/**
 * Реестр env-оверрайдов скалярных ключей вложенных секций (ADR-023).
 *
 * Объектные/нескалярные ключи (`events.allowedSources`, `events.identityMap`,
 * `events.dedupStore`, `events.unknownAgentTemplate`, `scheduler.leaderElection`,
 * `scheduler.crossProcessLocks`, `mcp.servers`, …) намеренно не входят: у них нет
 * плоского строкового представления — они остаются в config.yaml.
 */
export const ENV_OVERRIDES: readonly EnvOverrideDefinition[] = [
  // events (ADR-089)
  { section: 'events', key: 'enabled', type: 'boolean' },
  { section: 'events', key: 'defaultMode', type: 'string' },
  { section: 'events', key: 'ephemeralTtl', type: 'string' },
  { section: 'events', key: 'journalRetentionDays', type: 'number' },
  { section: 'events', key: 'keyRateLimitPerMinute', type: 'number' },
  { section: 'events', key: 'decisionRouting', type: 'boolean' },
  { section: 'events', key: 'autoBind', type: 'boolean' },
  { section: 'events', key: 'autoBindAgentTemplate', type: 'string' },
  // scheduler (ADR-051 срез / ADR-089)
  { section: 'scheduler', key: 'enabled', type: 'boolean' },
  { section: 'scheduler', key: 'tickSec', type: 'number' },
  { section: 'scheduler', key: 'catchUp', type: 'string' },
  { section: 'scheduler', key: 'jobRetentionDays', type: 'number' },
  // webhooks (ADR-052, этап II)
  { section: 'webhooks', key: 'enabled', type: 'boolean' },
  { section: 'webhooks', key: 'maxAttempts', type: 'number' },
  { section: 'webhooks', key: 'timeoutMs', type: 'number' },
  { section: 'webhooks', key: 'deliveryRetentionDays', type: 'number' },
  // egress (настраиваемая политика + журнал): только скалярные ключи.
  { section: 'egress', key: 'tools.mode', type: 'string' },
  { section: 'egress', key: 'webhooks.mode', type: 'string' },
  { section: 'egress', key: 'log.enabled', type: 'boolean' },
  { section: 'egress', key: 'log.retentionDays', type: 'number' },
  // proxy (ADR-099, D1): скалярные ключи секции; списки (noProxy) — в config/env.
  { section: 'proxy', key: 'enabled', type: 'boolean' },
  { section: 'proxy', key: 'url', type: 'string' },
  { section: 'proxy', key: 'httpProxy', type: 'string' },
  { section: 'proxy', key: 'httpsProxy', type: 'string' },
  { section: 'proxy', key: 'allProxy', type: 'string' },
  { section: 'proxy', key: 'fallbackDirect', type: 'boolean' },
  { section: 'proxy', key: 'connectTimeoutMs', type: 'number' },
  // decision (ADR-084)
  { section: 'decision', key: 'enabled', type: 'boolean' },
  { section: 'decision', key: 'provider', type: 'string' },
  { section: 'decision', key: 'model', type: 'string' },
  { section: 'decision', key: 'confidenceThreshold', type: 'number' },
  { section: 'decision', key: 'escalationProvider', type: 'string' },
  { section: 'decision', key: 'escalationModel', type: 'string' },
  // analytics (ADR-102)
  { section: 'analytics', key: 'retentionDays', type: 'number' },
  // metrics (ADR-094): Helm ставит `SYNTH_METRICS_ENABLED` — имя должно совпадать.
  { section: 'metrics', key: 'enabled', type: 'boolean' },
  // authority (ADR-106 Ф1): мастер-выключатель слоя и режим наблюдения.
  { section: 'authority', key: 'enabled', type: 'boolean' },
  { section: 'authority', key: 'shadow', type: 'boolean' },
  // plugins (PROP-090 §10): политики слоя плагинов. Списки (allowlist/denylist/
  // remoteAllowlist) — объектные, остаются в config.yaml.
  { section: 'plugins', key: 'enabled', type: 'boolean' },
  { section: 'plugins', key: 'runtimeInstall', type: 'string' },
  { section: 'plugins', key: 'trustFloor', type: 'string' },
  { section: 'plugins', key: 'scan', type: 'string' },
  { section: 'plugins', key: 'exactHostExceptions', type: 'string' },
  { section: 'plugins', key: 'promptBlockMaxChars', type: 'number' },
  { section: 'plugins', key: 'executionEnabled', type: 'boolean' },
  { section: 'plugins', key: 'llmFilterTimeoutMs', type: 'number' },
  // Ф5в: деплой-каталог из образа/PVC и «неприкосновенность» management-плагинов.
  { section: 'plugins', key: 'deployDir', type: 'string' },
  { section: 'plugins', key: 'deployTrust', type: 'string' },
  { section: 'plugins', key: 'managedReadonly', type: 'boolean' },
];

/** camelCase → SNAKE_CASE (`autoBind` → `AUTO_BIND`, `ephemeralTtl` → `EPHEMERAL_TTL`). */
export function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Полное env-имя определения: `SYNTH_<SECTION>_<KEY>`. Точки в ключе означают
 * вложенность (`log.enabled` → `SYNTH_EGRESS_LOG_ENABLED`).
 */
export function envOverrideName(def: EnvOverrideDefinition): string {
  const key = def.key.split('.').map(toSnakeCase).join('_');
  return `SYNTH_${toSnakeCase(def.section)}_${key}`;
}

export type ParsedEnvValue =
  | { ok: true; value: boolean | number | string }
  | { ok: false };

/**
 * Парсинг env-строки по типу ключа:
 * - `boolean` — `true`/`1`/`false`/`0` (регистронезависимо);
 * - `number` — `Number()` с проверкой `Number.isFinite`;
 * - `string` — как есть.
 *
 * Пустая строка (переменная задана, но пуста) → `{ok:false}` — трактуется как
 * «не задано» (как `resolveDataDir`/`resolveDecisionProvider` с `if (envVal)`).
 * Нераспознанное значение → `{ok:false}`: потребитель логирует warn и игнорирует.
 */
export function parseEnvValue(raw: string, type: EnvOverrideType): ParsedEnvValue {
  if (raw === '') return { ok: false };

  switch (type) {
    case 'boolean': {
      const v = raw.toLowerCase();
      if (v === 'true' || v === '1') return { ok: true, value: true };
      if (v === 'false' || v === '0') return { ok: true, value: false };
      return { ok: false };
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false };
      return { ok: true, value: n };
    }
    case 'string':
      return { ok: true, value: raw };
  }
}

/**
 * Применяет env-оверрайды к уже слитому конфигу (defaults + config.yaml).
 *
 * Мутирует переданный объект (в `loadConfig` это свежий результат `deepMerge`) и
 * возвращает его. Секции клонируются, чтобы не мутировать `defaultConfig`.
 * Неизвестные env игнорируются молча; невалидное значение — warn в console и
 * игнор (как `resolvePort`/`resolveIgnoreRules`, без падения).
 */
export function applyEnvOverrides<T extends Record<string, unknown>>(
  config: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  for (const def of ENV_OVERRIDES) {
    const name = envOverrideName(def);
    const raw = env[name];
    if (raw === undefined) continue;

    const parsed = parseEnvValue(raw, def.type);
    if (!parsed.ok) {
      // Пустая строка — «не задано» (тихий игнор). Нераспознанное значение — warn.
      if (raw !== '') {
        console.warn(
          `[config] невалидное значение ${name}="${raw}" (ожидается ${def.type}) — игнорируется`,
        );
      }
      continue;
    }

    const current = config[def.section];
    const section =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    // `key` может быть вложенным (`log.enabled`): клонируем промежуточные объекты,
    // чтобы не мутировать defaultConfig.
    const path = def.key.split('.');
    let target: Record<string, unknown> = section;
    for (let i = 0; i < path.length - 1; i += 1) {
      const part = path[i]!;
      const child = target[part];
      const copy =
        child !== null && typeof child === 'object' && !Array.isArray(child)
          ? { ...(child as Record<string, unknown>) }
          : {};
      target[part] = copy;
      target = copy;
    }
    target[path[path.length - 1]!] = parsed.value;
    (config as Record<string, unknown>)[def.section] = section;
  }

  return config;
}

/**
 * ADR-052/O1: env-имя JSON-списка installer service-key'ев
 * (`security.bootstrapServiceKeys`). Значение — JSON-массив объектов
 * `{ label, secret, scopes, roles?, description? }`. Приоритет — как у
 * скалярных env-оверрайдов: env > config.yaml (ADR-023), но выше CLI-overrides.
 * Нужен, чтобы секрет installer-ключа не попадал в файл конфигурации
 * (передаётся из env/Secret).
 */
export const BOOTSTRAP_SERVICE_KEYS_ENV = 'SYNTH_BOOTSTRAP_SERVICE_KEYS';

/**
 * Применяет объектные env-оверрайды, у которых нет плоского строкового
 * представления (сейчас — `security.bootstrapServiceKeys`). Значение парсится
 * как JSON и валидируется схемой; при ошибке парсинга/валидации — warn в console
 * и игнор (fail-soft: кривой installer-ключ не должен ронять старт инстанса —
 * ensure-логика приложения просто ничего не бутстрапит, оператор видит warn).
 *
 * Мутирует переданный объект (в `loadConfig` — свежий результат `deepMerge`) и
 * возвращает его; секция `security` клонируется, чтобы не мутировать `defaultConfig`.
 */
export function applyObjectEnvOverrides<T extends Record<string, unknown>>(
  config: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const raw = env[BOOTSTRAP_SERVICE_KEYS_ENV];
  if (raw === undefined || raw === '') return config;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[config] невалидный JSON ${BOOTSTRAP_SERVICE_KEYS_ENV} — игнорируется`);
    return config;
  }

  const validated = bootstrapServiceKeysSchema.safeParse(parsed);
  if (!validated.success) {
    console.warn(`[config] ${BOOTSTRAP_SERVICE_KEYS_ENV} не прошёл валидацию — игнорируется`);
    return config;
  }

  const current = config.security;
  const security =
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  security.bootstrapServiceKeys = validated.data;
  (config as Record<string, unknown>).security = security;
  return config;
}
