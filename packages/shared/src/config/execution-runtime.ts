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
 * ## Каталог профилей — merge, а не замена
 *
 * Эффективный каталог = **config-профили + runtime-профили − отключённые**
 * (аддендум §11):
 *
 * - runtime-запись **переопределяет** одноимённую config-запись целиком
 *   (не дополняет её);
 * - config-записи, которых нет в runtime, **сохраняются** — поэтому
 *   администратор может отредактировать один профиль, не переписывая каталог;
 * - профили из `config.yaml` **не удаляются** — их можно **отключить**
 *   (`disabledProfiles`); профиль, созданный в runtime, удаляется удалением
 *   из `profiles`.
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
  ExecutionProfileOrigin,
  ExecutionProfileResources,
} from '../types/execution.js';
import { EXECUTION_ENV } from './execution.js';
import type {
  ResolvedExecutionConfig,
  ResolvedExecutionProfile,
} from './execution.js';
import { effectiveProfileClass } from './execution.js';

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
  // Объявленный класс профиля (ADR-135, аддендум §11).
  if (profile.class !== undefined) resolved.class = profile.class;
  // MCP-серверы runtime-каталога — полное описание (имя + команда): команда
  // нужна provisioner'у, чтобы запустить сервер в поде. Строковая форма
  // (legacy-запись) нормализуется в `{ name }`.
  const mcpServers = normalizeMcpServers(profile.mcpServers);
  if (mcpServers.length > 0) resolved.mcpServers = mcpServers;
  return resolved;
}

/**
 * Нормализация MCP-серверов профиля: строки (legacy) → `{ name }`, объекты —
 * как есть (имя/команда/аргументы/env). Пустые имена отбрасываются.
 */
function normalizeMcpServers(raw: unknown): NonNullable<ResolvedExecutionProfile['mcpServers']> {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<ResolvedExecutionProfile['mcpServers']> = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (name !== '') out.push({ name });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const server = entry as {
      name?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
    };
    const name = typeof server.name === 'string' ? server.name.trim() : '';
    if (name === '') continue;
    const command = typeof server.command === 'string' ? server.command.trim() : '';
    const args = Array.isArray(server.args)
      ? server.args.filter((item): item is string => typeof item === 'string')
      : [];
    const env: Record<string, string> = {};
    if (server.env !== null && typeof server.env === 'object') {
      for (const [key, value] of Object.entries(server.env as Record<string, unknown>)) {
        if (typeof value === 'string') env[key] = value;
      }
    }
    out.push({
      name,
      ...(command !== '' ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return out;
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
 * Эффективный каталог профилей: **config + runtime (override) − отключённые**.
 *
 * Возвращает профили, их происхождение (`config`/`runtime`) и дефолты —
 * единый источник истины для роутера, API и валидации.
 */
export interface EffectiveExecutionCatalog {
  /** Профили эффективного каталога (общие параметры секции уже подставлены). */
  profiles: Record<string, ResolvedExecutionProfile>;
  /** Происхождение профиля: `config` — из `config.yaml`, `runtime` — из UI. */
  origins: Record<string, ExecutionProfileOrigin>;
  /** Профиль по умолчанию (env > runtime > config). */
  defaultProfile: string;
  /** Браузерный профиль по умолчанию (env > runtime > config). */
  browserProfile: string;
  /** Legacy-список браузерных имён (env > runtime > config). */
  browserProfiles: string[];
  /** Отключённые профили config-базы (скрыты из каталога). */
  disabledProfiles: string[];
}

/**
 * Собрать эффективный каталог профилей (ADR-135, аддендум §11).
 *
 * Порядок: env > runtime > config.yaml (ADR-023). Runtime-запись профиля
 * **переопределяет** одноимённую config-запись целиком; config-записи без
 * runtime-пары сохраняются; `disabledProfiles` (только имена из config-базы)
 * убирают профиль из каталога.
 */
export function effectiveExecutionCatalog(
  base: ResolvedExecutionConfig,
  runtime: ExecutionRuntimeSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveExecutionCatalog {
  const remote = base.remote;
  const defaultProfile = envSet(env, EXECUTION_ENV.defaultProfile)
    ? remote.defaultProfile
    : (runtime?.defaultProfile ?? remote.defaultProfile);
  const browserProfile = envSet(env, EXECUTION_ENV.browserProfile)
    ? remote.browserProfile
    : (runtime?.browserProfile ?? remote.browserProfile);
  const browserProfiles = envSet(env, EXECUTION_ENV.browserProfiles)
    ? remote.browserProfiles
    : (runtime?.browserProfiles ?? remote.browserProfiles);
  const common = {
    url: remote.url,
    timeoutMs: remote.timeoutMs,
    concurrency: remote.concurrency,
    failMode: remote.failMode,
  };

  const profiles: Record<string, ResolvedExecutionProfile> = {};
  const origins: Record<string, ExecutionProfileOrigin> = {};
  for (const [name, profile] of Object.entries(remote.profiles ?? {})) {
    profiles[name] = { ...profile };
    origins[name] = 'config';
  }
  for (const [name, profile] of Object.entries(runtime?.profiles ?? {})) {
    profiles[name] = materializeRuntimeProfile(profile, common);
    if (origins[name] === undefined) origins[name] = 'runtime';
  }

  // Отключение — только профили **config-базы** (профиль, созданный в
  // runtime, удаляется удалением из `profiles`).
  const disabledProfiles: string[] = [];
  for (const name of runtime?.disabledProfiles ?? []) {
    const trimmed = name.trim();
    if (trimmed === '' || origins[trimmed] !== 'config') continue;
    delete profiles[trimmed];
    delete origins[trimmed];
    disabledProfiles.push(trimmed);
  }

  return {
    profiles,
    origins,
    defaultProfile,
    browserProfile,
    browserProfiles: [...browserProfiles],
    disabledProfiles,
  };
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
 * Каталог `profiles` runtime-секции **сливается** с каталогом config.yaml
 * (runtime-запись переопределяет одноимённую config-запись целиком), а
 * `disabledProfiles` убирают профили config-базы из эффективного каталога.
 */
export function applyExecutionRuntimeSettings(
  resolved: ResolvedExecutionConfig,
  runtime: ExecutionRuntimeSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutionConfig {
  if (!runtime) return resolved;
  const remote = resolved.remote;

  const catalog = effectiveExecutionCatalog(resolved, runtime, env);
  const pooling = envSet(env, EXECUTION_ENV.pooling)
    ? remote.pooling
    : (runtime.pooling ?? remote.pooling);
  const fallback = envSet(env, EXECUTION_ENV.fallback)
    ? remote.fallback
    : (runtime.fallback ?? remote.fallback);

  return {
    ...resolved,
    remote: {
      ...remote,
      defaultProfile: catalog.defaultProfile,
      browserProfile: catalog.browserProfile,
      browserProfiles: [...catalog.browserProfiles],
      pooling,
      fallback,
      profiles: catalog.profiles,
      ...(catalog.disabledProfiles.length > 0
        ? { disabledProfiles: [...catalog.disabledProfiles] }
        : {}),
      profileOrigins: { ...catalog.origins },
    },
  };
}

/**
 * Снимок эффективной секции `execution` в форме runtime-секции.
 *
 * Нужен админ-API: «что сейчас работает» (`running`) и «что сохранено»
 * (`saved`) сравниваются одним отпечатком. Профили приводятся к runtime-форме
 * (только поля runtime-модели; `url` — фактический адрес профиля, включая
 * унаследованный; `class` — **эффективный** класс профиля; `mcpServers` —
 * имя + команда, если она известна).
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
    // Эффективный класс профиля (ADR-135, аддендум §11): объявленный класс,
    // иначе — выведенный из legacy-списка браузерных имён/`browserProfile`.
    entry.class = effectiveProfileClass(
      profile,
      name,
      remote.browserProfiles,
      remote.browserProfile,
    );
    if (profile.mcpServers !== undefined && profile.mcpServers.length > 0) {
      entry.mcpServers = profile.mcpServers.map((server) => ({
        name: server.name,
        ...(server.command !== undefined && server.command !== ''
          ? { command: server.command }
          : {}),
        ...(server.args !== undefined && server.args.length > 0
          ? { args: [...server.args] }
          : {}),
        ...(server.env !== undefined && Object.keys(server.env).length > 0
          ? { env: { ...server.env } }
          : {}),
      }));
    }
    profiles[name] = entry;
  }
  const snapshot: ExecutionRuntimeSettings = {
    defaultProfile: remote.defaultProfile,
    browserProfile: remote.browserProfile,
    // Legacy-подсказка класса (не эффективный каталог): эффективный класс
    // каждого профиля уже записан в `profiles[name].class`.
    browserProfiles: [...remote.browserProfiles],
    pooling: remote.pooling,
    fallback: remote.fallback,
    profiles,
  };
  if (remote.disabledProfiles !== undefined && remote.disabledProfiles.length > 0) {
    snapshot.disabledProfiles = [...remote.disabledProfiles];
  }
  return snapshot;
}

/**
 * Слить config-уровень и runtime-секцию (runtime > config).
 *
 * `profiles` runtime-секции **сливается** с каталогом base: одноимённая
 * запись runtime переопределяет base целиком, остальные base-записи
 * сохраняются (ADR-135, аддендум §11).
 */
export function mergeExecutionRuntimeSettings(
  base: ExecutionRuntimeSettings | undefined | null,
  runtime: ExecutionRuntimeSettings | undefined | null,
): ExecutionRuntimeSettings {
  const merged: ExecutionRuntimeSettings = {
    ...(base ?? {}),
    ...(runtime ?? {}),
  };
  merged.profiles = { ...(base?.profiles ?? {}), ...(runtime?.profiles ?? {}) };
  const disabled = [
    ...(base?.disabledProfiles ?? []),
    ...(runtime?.disabledProfiles ?? []),
  ].filter((name, index, list) => list.indexOf(name) === index);
  if (disabled.length > 0) merged.disabledProfiles = disabled;
  else delete merged.disabledProfiles;
  return merged;
}

/**
 * Имена профилей **эффективного** каталога (после применения runtime-секции).
 *
 * Каталог = config-профили + runtime-профили (override) − отключённые.
 */
export function effectiveExecutionProfileNames(
  base: ExecutionRuntimeSettings | undefined | null,
  runtime: ExecutionRuntimeSettings | undefined | null,
): string[] {
  const merged = { ...(base?.profiles ?? {}), ...(runtime?.profiles ?? {}) };
  const disabled = new Set([
    ...(base?.disabledProfiles ?? []),
    ...(runtime?.disabledProfiles ?? []),
  ]);
  return Object.keys(merged).filter((name) => !disabled.has(name));
}

/**
 * Отпечаток runtime-секции — для сравнения «сохранено» vs «работает»
 * (`restartRequired`).
 *
 * Нормализация: имена профилей — по алфавиту, ключи профиля — по алфавиту,
 * списки (`url`, `mcpServers`, `disabledProfiles`) — по алфавиту (порядок
 * элементов и ключей не влияет на отпечаток). Пустая секция и `null` — один
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
        entry[key] = normalizeFingerprintValue(value);
      }
      return { name, profile: entry };
    });
  return JSON.stringify({
    defaultProfile: settings.defaultProfile ?? null,
    browserProfile: settings.browserProfile ?? null,
    browserProfiles: [...(settings.browserProfiles ?? [])].sort(),
    disabledProfiles: [...(settings.disabledProfiles ?? [])].sort(),
    pooling: settings.pooling ?? null,
    fallback: settings.fallback ?? null,
    profiles,
  });
}

/**
 * Нормализация значения для отпечатка: объекты — по алфавиту ключей, списки —
 * по алфавиту (строковое представление). Порядок не влияет на сравнение
 * «сохранено» vs «работает».
 */
function normalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeFingerprintValue(item))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeFingerprintValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
