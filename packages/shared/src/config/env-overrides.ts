/**
 * AD-023: декларативные env-оверрайды скалярных ключей конфигурации.
 *
 * Имя переменной собирается по правилу `SYNTH_<SECTION>_<KEY>`, где camelCase
 * ключа переводится в SNAKE_CASE (`autoBind` → `SYNTH_EVENTS_AUTO_BIND`,
 * `ephemeralTtl` → `SYNTH_EVENTS_EPHEMERAL_TTL`). Реестр `ENV_OVERRIDES` —
 * единственный источник истины; применяется **в одном месте** (`loadConfig`,
 * после слияния defaults + config.yaml и до CLI-overrides), поэтому все
 * потребители `@itphx/synth-shared/config` получают поддержку автоматически.
 *
 * Приоритет (AD-023): CLI-флаги (`overrides`) > env (`SYNTH_*`) > config.yaml > defaults.
 */

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
 * Реестр env-оверрайдов скалярных ключей вложенных секций (AD-023).
 *
 * Объектные/нескалярные ключи (`events.allowedSources`, `events.identityMap`,
 * `events.dedupStore`, `events.unknownAgentTemplate`, `scheduler.leaderElection`,
 * `scheduler.crossProcessLocks`, `mcp.servers`, …) намеренно не входят: у них нет
 * плоского строкового представления — они остаются в config.yaml.
 */
export const ENV_OVERRIDES: readonly EnvOverrideDefinition[] = [
  // events (AD-089)
  { section: 'events', key: 'enabled', type: 'boolean' },
  { section: 'events', key: 'defaultMode', type: 'string' },
  { section: 'events', key: 'ephemeralTtl', type: 'string' },
  { section: 'events', key: 'journalRetentionDays', type: 'number' },
  { section: 'events', key: 'keyRateLimitPerMinute', type: 'number' },
  { section: 'events', key: 'decisionRouting', type: 'boolean' },
  { section: 'events', key: 'autoBind', type: 'boolean' },
  { section: 'events', key: 'autoBindAgentTemplate', type: 'string' },
  // scheduler (AD-051 срез / AD-089)
  { section: 'scheduler', key: 'enabled', type: 'boolean' },
  { section: 'scheduler', key: 'tickSec', type: 'number' },
  { section: 'scheduler', key: 'catchUp', type: 'string' },
  { section: 'scheduler', key: 'jobRetentionDays', type: 'number' },
  // webhooks (AD-052, этап II)
  { section: 'webhooks', key: 'enabled', type: 'boolean' },
  { section: 'webhooks', key: 'maxAttempts', type: 'number' },
  { section: 'webhooks', key: 'timeoutMs', type: 'number' },
  { section: 'webhooks', key: 'allowPrivateTargets', type: 'boolean' },
  { section: 'webhooks', key: 'deliveryRetentionDays', type: 'number' },
  // decision (AD-084)
  { section: 'decision', key: 'enabled', type: 'boolean' },
  { section: 'decision', key: 'provider', type: 'string' },
  { section: 'decision', key: 'model', type: 'string' },
  { section: 'decision', key: 'confidenceThreshold', type: 'number' },
  { section: 'decision', key: 'escalationProvider', type: 'string' },
  { section: 'decision', key: 'escalationModel', type: 'string' },
];

/** camelCase → SNAKE_CASE (`autoBind` → `AUTO_BIND`, `ephemeralTtl` → `EPHEMERAL_TTL`). */
export function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Полное env-имя определения: `SYNTH_<SECTION>_<KEY>`. */
export function envOverrideName(def: EnvOverrideDefinition): string {
  return `SYNTH_${toSnakeCase(def.section)}_${toSnakeCase(def.key)}`;
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
    section[def.key] = parsed.value;
    (config as Record<string, unknown>)[def.section] = section;
  }

  return config;
}
