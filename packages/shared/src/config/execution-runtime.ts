/**
 * ADR-135: runtime-каталог профилей исполнения — слияние, применение и
 * отпечаток для `restartRequired`.
 *
 * ## Где живёт каталог
 *
 * Каталог профилей и дефолты исполнения — **runtime-настройка инстанца**
 * (`settings.json`/PG, секция `execution`), которой управляет администратор
 * через `GET/PUT/DELETE /api/v2/settings/execution`.
 *
 * ## Приоритет
 *
 * **env/CLI > runtime > config.yaml** (ADR-023). Env/CLI разрешаются внутри
 * `resolveExecutionConfig` — поэтому runtime-override применяется **поверх
 * config-уровня, но под env**: поле, заданное переменной окружения, runtime
 * не перекрывает.
 *
 * ## Каталог профилей
 *
 * `profiles` в runtime-секции — **полная замена** каталога config.yaml (как
 * `profiles`/`rules` прокси, ADR-099): администратор может и добавить профиль,
 * и удалить профиль из конфига (не задав его в runtime-каталоге). Пока
 * runtime-каталог не задан, действует каталог config.yaml.
 *
 * ## Когда применяется
 *
 * `execution` — **параметр запуска** (инвариант 24): порты пулов и роутер
 * создаются на старте процесса. Поэтому изменение каталога требует рестарта —
 * API честно отдаёт `restartRequired`.
 */
import { executionRuntimeSettingsSchema } from '../types/execution.js';
import type {
  ExecutionRuntimeProfile,
  ExecutionRuntimeSettings,
  ExecutionProfileResources,
} from '../types/execution.js';
import { EXECUTION_ENV } from './execution.js';
import type {
  ResolvedExecutionConfig,
  ResolvedExecutionProfile,
} from './execution.js';

/**
 * Разобрать сохранённую runtime-секцию исполнения.
 *
 * Валидация — Zod (`:strict()`): неизвестное поле → невалидная секция.
 * Невалидная секция **игнорируется** (fail-soft): испорченный `settings.json`
 * не должен ронять инстанс — применяется config-уровень (как при деградации
 * хранилища).
 */
export function parseExecutionRuntimeSettings(raw: unknown): ExecutionRuntimeSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = executionRuntimeSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Env-значение задано явно (непустая строка) — runtime его не перекрывает. */
function envSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  return raw !== undefined && raw.trim() !== '';
}

/**
 * Материализовать runtime-профиль в форму эффективного профиля.
 *
 * Незаданные поля наследуют общие параметры секции (`url`/`timeoutMs`/
 * `concurrency`/`failMode`) — ровно как профили config.yaml.
 */
function materializeRuntimeProfile(
  profile: ExecutionRuntimeProfile,
  common: {
    url: string[];
    timeoutMs: number;
    concurrency: number;
    failMode: ResolvedExecutionProfile['failMode'];
  },
): ResolvedExecutionProfile {
  const urls = (profile.url ?? []).map((u) => u.trim()).filter((u) => u.length > 0);
  const resolved: ResolvedExecutionProfile = {
    url: urls.length > 0 ? urls : [...common.url],
    timeoutMs: common.timeoutMs,
    concurrency: common.concurrency,
    failMode: common.failMode,
  };
  const description = profile.description?.trim();
  if (description !== undefined && description !== '') resolved.description = description;
  const image = profile.image?.trim();
  if (image !== undefined && image !== '') resolved.image = image;
  if (profile.network !== undefined) resolved.network = profile.network;
  const resources = normalizeRuntimeResources(profile.resources);
  if (resources !== undefined) resolved.resources = resources;
  const runtimeClass = profile.runtimeClass?.trim();
  if (runtimeClass !== undefined && runtimeClass !== '') resolved.runtimeClass = runtimeClass;
  if (profile.readOnlyRootFilesystem !== undefined) {
    resolved.readOnlyRootFilesystem = profile.readOnlyRootFilesystem;
  }
  if (profile.env !== undefined && Object.keys(profile.env).length > 0) {
    resolved.env = { ...profile.env };
  }
  const mcpServers = (profile.mcpServers ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (mcpServers.length > 0) resolved.mcpServers = mcpServers;
  return resolved;
}

/** Ресурсы профиля: копируются только заданные непустые строки. */
function normalizeRuntimeResources(
  resources: ExecutionProfileResources | undefined,
): ExecutionProfileResources | undefined {
  if (resources === undefined) return undefined;
  const requests = normalizeResourceList(resources.requests);
  const limits = normalizeResourceList(resources.limits);
  if (requests === undefined && limits === undefined) return undefined;
  return {
    ...(requests !== undefined ? { requests } : {}),
    ...(limits !== undefined ? { limits } : {}),
  };
}

function normalizeResourceList(
  list: ExecutionProfileResources['requests'],
): ExecutionProfileResources['requests'] {
  if (list === undefined) return undefined;
  const out: NonNullable<ExecutionProfileResources['requests']> = {};
  const cpu = list.cpu?.trim();
  const memory = list.memory?.trim();
  const ephemeralStorage = list.ephemeralStorage?.trim();
  if (cpu !== undefined && cpu !== '') out.cpu = cpu;
  if (memory !== undefined && memory !== '') out.memory = memory;
  if (ephemeralStorage !== undefined && ephemeralStorage !== '') {
    out.ephemeralStorage = ephemeralStorage;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Применить runtime-каталог к эффективной секции `execution`.
 *
 * Вход — **уже разрешённая** секция (config.yaml + env, ADR-023); выход —
 * секция, с которой работает процесс (config.yaml + env + runtime).
 *
 * Env/CLI выше runtime: поле, явно заданное переменной окружения, не
 * перекрывается (иначе оператор не смог бы зафиксировать значение из
 * `SYNTH_EXECUTION_*`).
 *
 * Каталог `profiles` runtime-секции **заменяет** каталог config.yaml целиком.
 */
export function applyExecutionRuntimeSettings(
  resolved: ResolvedExecutionConfig,
  runtime: ExecutionRuntimeSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutionConfig {
  if (!runtime) return resolved;
  const remote = resolved.remote;

  const defaultProfile = envSet(env, EXECUTION_ENV.defaultProfile)
    ? remote.defaultProfile
    : (runtime.defaultProfile ?? remote.defaultProfile);
  const browserProfile = envSet(env, EXECUTION_ENV.browserProfile)
    ? remote.browserProfile
    : (runtime.browserProfile ?? remote.browserProfile);
  const browserProfiles = envSet(env, EXECUTION_ENV.browserProfiles)
    ? remote.browserProfiles
    : (runtime.browserProfiles ?? remote.browserProfiles);
  const pooling = envSet(env, EXECUTION_ENV.pooling)
    ? remote.pooling
    : (runtime.pooling ?? remote.pooling);
  const fallback = envSet(env, EXECUTION_ENV.fallback)
    ? remote.fallback
    : (runtime.fallback ?? remote.fallback);

  const common = {
    url: remote.url,
    timeoutMs: remote.timeoutMs,
    concurrency: remote.concurrency,
    failMode: remote.failMode,
  };
  const profiles: Record<string, ResolvedExecutionProfile> = {};
  for (const [name, profile] of Object.entries(runtime.profiles ?? {})) {
    profiles[name] = materializeRuntimeProfile(profile, common);
  }

  return {
    ...resolved,
    remote: {
      ...remote,
      defaultProfile,
      browserProfile,
      browserProfiles: [...browserProfiles],
      pooling,
      fallback,
      profiles,
    },
  };
}

/**
 * Снимок эффективной секции `execution` в форме runtime-секции.
 *
 * Нужен админ-API: «что сейчас работает» (`running`) и «что сохранено»
 * (`saved`) сравниваются одним отпечатком. Профили приводятся к runtime-форме
 * (только поля runtime-модели; `url` — фактический адрес профиля, включая
 * унаследованный).
 */
export function executionRuntimeSettingsFromResolved(
  resolved: ResolvedExecutionConfig | undefined | null,
): ExecutionRuntimeSettings | null {
  if (!resolved) return null;
  const remote = resolved.remote;
  const profiles: Record<string, ExecutionRuntimeProfile> = {};
  for (const [name, profile] of Object.entries(remote.profiles ?? {})) {
    const entry: ExecutionRuntimeProfile = {};
    if (profile.description !== undefined && profile.description !== '') {
      entry.description = profile.description;
    }
    if (profile.image !== undefined && profile.image !== '') entry.image = profile.image;
    if (profile.url.length > 0) entry.url = [...profile.url];
    if (profile.network !== undefined) entry.network = profile.network;
    if (profile.resources !== undefined) entry.resources = profile.resources;
    if (profile.runtimeClass !== undefined && profile.runtimeClass !== '') {
      entry.runtimeClass = profile.runtimeClass;
    }
    if (profile.readOnlyRootFilesystem !== undefined) {
      entry.readOnlyRootFilesystem = profile.readOnlyRootFilesystem;
    }
    if (profile.env !== undefined && Object.keys(profile.env).length > 0) {
      entry.env = { ...profile.env };
    }
    if (profile.mcpServers !== undefined && profile.mcpServers.length > 0) {
      entry.mcpServers = [...profile.mcpServers];
    }
    profiles[name] = entry;
  }
  return {
    defaultProfile: remote.defaultProfile,
    browserProfile: remote.browserProfile,
    browserProfiles: [...remote.browserProfiles],
    pooling: remote.pooling,
    fallback: remote.fallback,
    profiles,
  };
}

/**
 * Слить config-уровень и runtime-секцию (runtime > config).
 *
 * `profiles` runtime-секции **заменяет** каталог целиком (см. ADR-135).
 */
export function mergeExecutionRuntimeSettings(
  base: ExecutionRuntimeSettings | undefined | null,
  runtime: ExecutionRuntimeSettings | undefined | null,
): ExecutionRuntimeSettings {
  const merged: ExecutionRuntimeSettings = {
    ...(base ?? {}),
    ...(runtime ?? {}),
  };
  if (runtime?.profiles !== undefined) {
    merged.profiles = { ...runtime.profiles };
  }
  return merged;
}

/**
 * Имена профилей **эффективного** каталога (после применения runtime-секции).
 *
 * Runtime-каталог заменяет config-каталог целиком; если runtime-каталога нет —
 * действует каталог config-уровня.
 */
export function effectiveExecutionProfileNames(
  base: ExecutionRuntimeSettings | undefined | null,
  runtime: ExecutionRuntimeSettings | undefined | null,
): string[] {
  const catalogue = runtime?.profiles ?? base?.profiles ?? {};
  return Object.keys(catalogue);
}

/**
 * Отпечаток runtime-секции — для сравнения «сохранено» vs «работает»
 * (`restartRequired`).
 *
 * Нормализация: имена профилей — по алфавиту, ключи профиля — по алфавиту,
 * списки `url`/`mcpServers` — по алфавиту. Пустая секция и `null` — один
 * отпечаток («ничего не задано»).
 */
export function executionRuntimeFingerprint(
  settings: ExecutionRuntimeSettings | undefined | null,
): string {
  if (!settings) return 'none';
  const profiles = Object.keys(settings.profiles ?? {})
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const profile = settings.profiles?.[name];
      const entry: Record<string, unknown> = {};
      for (const key of Object.keys(profile ?? {}).sort()) {
        const value = (profile as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          entry[key] = [...value].map((item) => String(item)).sort();
        } else if (value !== null && typeof value === 'object') {
          entry[key] = Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, k) => {
              acc[k] = (value as Record<string, unknown>)[k];
              return acc;
            }, {});
        } else {
          entry[key] = value;
        }
      }
      return { name, profile: entry };
    });
  return JSON.stringify({
    defaultProfile: settings.defaultProfile ?? null,
    browserProfile: settings.browserProfile ?? null,
    browserProfiles: [...(settings.browserProfiles ?? [])].sort(),
    pooling: settings.pooling ?? null,
    fallback: settings.fallback ?? null,
    profiles,
  });
}
