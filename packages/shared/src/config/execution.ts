/**
 * ADR-077: резолвер секции `execution` — топология исполнения.
 *
 * Секция — **параметр запуска** (не runtime-настройка): смена `mode` — только
 * рестартом процесса (инвариант 24). Приоритет (ADR-023):
 * **CLI-флаг > env > config.yaml > дефолт**.
 *
 * Env-имена (ровно эти — как зафиксировано в ADR-077):
 * `SYNTH_EXECUTION_MODE`, `SYNTH_EXECUTION_REMOTE_URL`, `SYNTH_EXECUTION_TOKEN`,
 * `SYNTH_EXECUTION_TIMEOUT_MS`, `SYNTH_EXECUTION_CONCURRENCY`,
 * `SYNTH_EXECUTION_FAIL_MODE`.
 *
 * PROP-135 Ф4a (пулы и профили) добавляет ещё три:
 * `SYNTH_EXECUTION_POOLING`, `SYNTH_EXECUTION_DEFAULT_PROFILE`,
 * `SYNTH_EXECUTION_FALLBACK`. Каталог профилей (`execution.remote.profiles`)
 * задаётся **только** в `config.yaml` — env-переопределение профилей на этом
 * шаге не заводим.
 *
 * PROP-135 Ф4b-1 (провайдер пулов) добавляет ещё четыре:
 * `SYNTH_EXECUTION_PROVIDER`, `SYNTH_EXECUTION_PROVISIONER_URL`,
 * `SYNTH_EXECUTION_PROVISIONER_TOKEN` (путь/ссылка, НЕ значение),
 * `SYNTH_EXECUTION_PROVISIONER_TIMEOUT_MS`.
 *
 * Browser-тулы добавляют два: `SYNTH_EXECUTION_BROWSER_PROFILE` (профиль пула
 * класса `browser`; дефолт `browser` — браузер не наследует `defaultProfile`)
 * и `SYNTH_EXECUTION_BROWSER_MCP_SERVER` (имя MCP-сервера браузера в поде).
 *
 * Таймаут одного вызова браузерного MCP-инструмента — ещё одна переменная
 * browser-контура: `SYNTH_EXECUTION_BROWSER_TIMEOUT_MS`
 * (`execution.remote.browserTimeoutMs`).
 *
 * Fail-closed (как `storage.backend`): неизвестное **явное** значение `mode`
 * (опечатка `inlne`), `failMode`, `pooling`, `fallback` или `provider` —
 * ошибка, а не тихий выбор дефолта. Тот же принцип и для `provider: http`
 * без адреса provisioner'а: «куда обращаться» не задано — ошибка конфигурации.
 */
import { availableParallelism, cpus } from 'node:os';
import type { SynthConfig } from './types.js';
import {
  DEFAULT_EXECUTION_BROWSER_MCP_SERVER,
  DEFAULT_EXECUTION_BROWSER_PROFILE,
  DEFAULT_EXECUTION_BROWSER_TIMEOUT_MS,
  DEFAULT_EXECUTION_PROVISIONER_TIMEOUT_MS,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EXECUTION_FAIL_MODES,
  EXECUTION_FALLBACKS,
  EXECUTION_MODES,
  EXECUTION_POOLINGS,
  EXECUTION_POOL_PROVIDERS,
  MAX_EXECUTION_BROWSER_TIMEOUT_MS,
  type ExecutionFailMode,
  type ExecutionFallback,
  type ExecutionMcpServer,
  type ExecutionMode,
  type ExecutionPooling,
  type ExecutionPoolProviderKind,
  type ExecutionProfileClass,
  type ExecutionProfileNetwork,
  type ExecutionProfileOrigin,
  type ExecutionProfileResources,
  type ExecutionProfileToleration,
} from './types.js';

/** Env-имена секции `execution` (ADR-077). */
export const EXECUTION_ENV = {
  mode: 'SYNTH_EXECUTION_MODE',
  remoteUrl: 'SYNTH_EXECUTION_REMOTE_URL',
  token: 'SYNTH_EXECUTION_TOKEN',
  timeoutMs: 'SYNTH_EXECUTION_TIMEOUT_MS',
  concurrency: 'SYNTH_EXECUTION_CONCURRENCY',
  failMode: 'SYNTH_EXECUTION_FAIL_MODE',
  /** PROP-135 Ф4a: режим пула (`instance`|`project`|`session`). */
  pooling: 'SYNTH_EXECUTION_POOLING',
  /** PROP-135 Ф4a: имя профиля по умолчанию. */
  defaultProfile: 'SYNTH_EXECUTION_DEFAULT_PROFILE',
  /** Профиль пула класса `browser` (браузер — свой образ/профиль). */
  browserProfile: 'SYNTH_EXECUTION_BROWSER_PROFILE',
  /** Браузерный контур: явный каталог браузерных профилей (csv). */
  browserProfiles: 'SYNTH_EXECUTION_BROWSER_PROFILES',
  /** Имя MCP-сервера браузера в поде исполнителя. */
  browserMcpServer: 'SYNTH_EXECUTION_BROWSER_MCP_SERVER',
  /** Таймаут одного вызова браузерного MCP-инструмента, мс. */
  browserTimeoutMs: 'SYNTH_EXECUTION_BROWSER_TIMEOUT_MS',
  /** PROP-135 Ф4a: поведение при непригодном профиле (`instance`|`fail`). */
  fallback: 'SYNTH_EXECUTION_FALLBACK',
  /** PROP-135 Ф4b-1: провайдер пулов (`static`|`http`). */
  provider: 'SYNTH_EXECUTION_PROVIDER',
  /** PROP-135 Ф4b-1: адрес provisioner'а пулов. */
  provisionerUrl: 'SYNTH_EXECUTION_PROVISIONER_URL',
  /** PROP-135 Ф4b-1: путь/ссылка на токен provisioner'а (НЕ значение). */
  provisionerToken: 'SYNTH_EXECUTION_PROVISIONER_TOKEN',
  /** PROP-135 Ф4b-1: таймаут обращения к provisioner'у, мс. */
  provisionerTimeoutMs: 'SYNTH_EXECUTION_PROVISIONER_TIMEOUT_MS',
} as const;

/** Имя CLI-флага переключателя топологии (`synth serve --execution-mode`). */
export const EXECUTION_MODE_CLI_FLAG = '--execution-mode';

/**
 * Лимит одновременных exec-вызовов по умолчанию — число CPU процесса.
 * `availableParallelism()` (Node 18.14+) учитывает cgroup/affinity; фолбэк —
 * `os.cpus().length`.
 */
export function defaultExecutionConcurrency(): number {
  const n =
    typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.max(1, n);
}

/**
 * Эффективные параметры **профиля** исполнения (PROP-135 Ф4a).
 *
 * Профиль — «поверх» общих параметров секции: незаданное поле наследует
 * общее (`execution.remote.*`). Пустой `url` профиля наследует общий
 * `execution.remote.url`; если и он пуст — профиль непригоден (решает
 * `execution.remote.fallback`).
 */
export interface ResolvedExecutionProfile {
  /** Адреса исполнителей профиля (пусто — непригоден). */
  url: string[];
  /** Таймаут exec-вызова, мс. */
  timeoutMs: number;
  /** Лимит одновременных exec-вызовов. */
  concurrency: number;
  /** Поведение при недоступном исполнителе. */
  failMode: ExecutionFailMode;
  /**
   * Метаданные профиля (PROP-135, для admin-API/UI). На маршрутизацию и
   * создание портов не влияют; незаданное поле отсутствует.
   */
  description?: string;
  image?: string;
  network?: ExecutionProfileNetwork;
  resources?: ExecutionProfileResources;
  runtimeClass?: string;
  /**
   * Произвольные аннотации пода (`metadata.annotations`).
   *
   * Служебные аннотации provisioner'а (`synth.io/*`) приоритетнее: конфликт
   * решается в пользу служебных (иначе под перестал бы усыновляться).
   */
  annotations?: Record<string, string>;
  /** Пользовательские метки пода (`metadata.labels`). */
  labels?: Record<string, string>;
  /** `spec.nodeSelector` пода — отбор нод по меткам. */
  nodeSelector?: Record<string, string>;
  /** `spec.tolerations` пода — правила размещения на «tainted» нодах. */
  tolerations?: ExecutionProfileToleration[];
  /** `spec.affinity` пода — passthrough (JSON, ≤8 КиБ). */
  affinity?: Record<string, unknown>;
  /** Read-only корневая ФС контейнера пула (ADR-137). */
  readOnlyRootFilesystem?: boolean;
  /**
   * Дополнительные переменные окружения пула (ADR-135, runtime-каталог).
   * **Секретов здесь быть не должно** (инвариант 13) — наружу не отдаются
   * (`GET /api/v2/execution/profiles` отдаёт только метаданные профиля).
   */
  env?: Record<string, string>;
  /**
   * **Объявленный** класс профиля (ADR-135, аддендум §11): `exec` | `browser` |
   * `both`. Не задан — класс выводится (legacy-список `browserProfiles` и
   * профиль по умолчанию `browserProfile` → `browser`, иначе `exec`); см.
   * `effectiveProfileClass`.
   */
  class?: ExecutionProfileClass;
  /**
   * MCP-серверы профиля (имя + команда, если известна).
   *
   * Config-уровень хранит только **имена** (`{ name }`); runtime-каталог —
   * полное описание (команда нужна provisioner'у, чтобы запустить сервер в
   * поде).
   */
  mcpServers?: ExecutionMcpServer[];
}

/** Эффективные параметры удалённого исполнителя. */
export interface ResolvedExecutionRemoteConfig {
  /** Список адресов исполнителей (пусто — при `remote` fail-closed на старте). */
  url: string[];
  /** Таймаут exec-вызова, мс. */
  timeoutMs: number;
  /** Лимит одновременных exec-вызовов. */
  concurrency: number;
  /** Поведение при недоступном исполнителе. */
  failMode: ExecutionFailMode;
  /** Путь/ссылка на токен исполнителя (НЕ значение — инвариант 13). */
  tokenSecret: string;
  /** Режим пула исполнителей (PROP-135 Ф4a). */
  pooling: ExecutionPooling;
  /** Имя профиля по умолчанию (PROP-135 Ф4a). */
  defaultProfile: string;
  /**
   * Имя профиля для пула класса `browser`: браузер — проектный пул со своим
   * образом, поэтому `class: 'browser'` не наследует `defaultProfile`.
   */
  browserProfile: string;
  /**
   * PROP-135 (браузерный контур): явный каталог браузерных профилей.
   * Пусто — эффективный каталог равен `[browserProfile]` (см.
   * `resolveBrowserProfileNames`).
   */
  browserProfiles: string[];
  /**
   * Отключённые профили config-базы (ADR-135, аддендум §11): имена,
   * скрытые из эффективного каталога. Пусто — отключённых нет.
   */
  disabledProfiles?: string[];
  /**
   * Происхождение профилей эффективного каталога (ADR-135, аддендум §11):
   * `config` — профиль из `config.yaml` (его можно отключить), `runtime` —
   * создан в runtime-каталоге (удаляется удалением из `profiles`).
   *
   * Аддитивное поле для UI; в схему runtime-секции **не** входит.
   */
  profileOrigins?: Record<string, ExecutionProfileOrigin>;
  /** Имя MCP-сервера браузера в поде исполнителя (встроенные `browser_*`). */
  browserMcpServer: string;
  /**
   * Таймаут одного вызова браузерного MCP-инструмента, мс.
   *
   * Общая настройка секции (профили её не переопределяют). Не задана —
   * дефолт клиента удалённого порта (`BROWSER_MCP_CALL_TIMEOUT_MS`).
   */
  browserTimeoutMs?: number;
  /** Эффективные параметры профилей (PROP-135 Ф4a) — по имени профиля. */
  profiles: Record<string, ResolvedExecutionProfile>;
  /** Поведение при непригодном профиле (PROP-135 Ф4a). */
  fallback: ExecutionFallback;
  /** Провайдер пулов (PROP-135 Ф4b-1): `static` — из конфигурации, `http` — provisioner. */
  provider: ExecutionPoolProviderKind;
  /** Параметры provisioner'а пулов (PROP-135 Ф4b-1). */
  provisioner: ResolvedExecutionProvisioner;
}

/**
 * Эффективные параметры provisioner'а пулов (PROP-135 Ф4b-1).
 *
 * `tokenSecret` — **путь/ссылка**, НЕ значение (инвариант 13): значение
 * читается из файла в момент обращения к provisioner'у.
 */
export interface ResolvedExecutionProvisioner {
  /** Адрес provisioner'а (пусто при `provider: http` → fail-closed на старте). */
  url: string;
  /** Путь/ссылка на токен provisioner'а (НЕ значение). */
  tokenSecret: string;
  /** Таймаут обращения к provisioner'у, мс. */
  timeoutMs: number;
}

/** Эффективная секция `execution`. */
export interface ResolvedExecutionConfig {
  /** Топология исполнения. */
  mode: ExecutionMode;
  remote: ResolvedExecutionRemoteConfig;
}

/** Явное значение CLI-флага (приоритетнее env и config.yaml). */
export interface ExecutionCliOverride {
  mode?: string | null;
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

export function isExecutionFailMode(value: unknown): value is ExecutionFailMode {
  return (
    typeof value === 'string' && (EXECUTION_FAIL_MODES as readonly string[]).includes(value)
  );
}

/** Предикат режима пула (PROP-135 Ф4a). */
export function isExecutionPooling(value: unknown): value is ExecutionPooling {
  return (
    typeof value === 'string' && (EXECUTION_POOLINGS as readonly string[]).includes(value)
  );
}

/** Предикат поведения при непригодном профиле (PROP-135 Ф4a). */
export function isExecutionFallback(value: unknown): value is ExecutionFallback {
  return (
    typeof value === 'string' && (EXECUTION_FALLBACKS as readonly string[]).includes(value)
  );
}

/** Предикат провайдера пулов (PROP-135 Ф4b-1). */
export function isExecutionPoolProvider(value: unknown): value is ExecutionPoolProviderKind {
  return (
    typeof value === 'string' && (EXECUTION_POOL_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Разбор списка адресов исполнителей: строка через запятую (`a, b`) — как у
 * прочих списков конфигурации (`proxy.noProxy`). Пустые элементы отбрасываются.
 */
export function parseExecutionUrlList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function invalidModeMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_MODES.map((m) => `'${m}'`).join(', ')}`
  );
}

function invalidFailModeMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_FAIL_MODES.map((m) => `'${m}'`).join(', ')}`
  );
}

function invalidPoolingMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_POOLINGS.map((m) => `'${m}'`).join(', ')}`
  );
}

function invalidFallbackMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_FALLBACKS.map((m) => `'${m}'`).join(', ')}`
  );
}

function invalidProviderMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_POOL_PROVIDERS.map((m) => `'${m}'`).join(', ')}`
  );
}

/**
 * Нормализация списка имён профилей: trim, пустые отбрасываются, дубликаты
 * схлопываются (порядок первого вхождения сохраняется).
 */
export function normalizeProfileNameList(names: readonly string[] | undefined): string[] {
  const list: string[] = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (name === '' || list.includes(name)) continue;
    list.push(name);
  }
  return list;
}

/**
 * Эффективный класс профиля (ADR-135, аддендум §11).
 *
 * Порядок:
 * 1. **объявленный** класс профиля (`class`) — важнее всего;
 * 2. legacy-список `browserProfiles` — профиль из списка браузерный;
 * 3. профиль по умолчанию `browserProfile` — браузерный (у браузера свой
 *    образ/MCP-сервер);
 * 4. иначе — `exec`.
 *
 * Класс определяет каталоги: exec — `exec|both`, браузерный — `browser|both`.
 */
export function effectiveProfileClass(
  profile: { class?: ExecutionProfileClass } | undefined,
  name: string,
  browserProfiles: readonly string[] | undefined,
  browserProfile: string | undefined,
): ExecutionProfileClass {
  const declared = profile?.class;
  if (declared === 'exec' || declared === 'browser' || declared === 'both') return declared;
  const trimmed = name.trim();
  if (trimmed !== '' && (browserProfiles ?? []).includes(trimmed)) return 'browser';
  if (trimmed !== '' && (browserProfile ?? '').trim() === trimmed) return 'browser';
  return 'exec';
}

/**
 * Эффективный каталог **браузерных** профилей (PROP-135, браузерный контур).
 *
 * Состав:
 * - профили с классом `browser`/`both`;
 * - legacy-список `execution.remote.browserProfiles` (подсказка класса);
 * - профиль по умолчанию `browserProfile`.
 *
 * Пустой каталог — когда не задано ни одного имени (браузер не настроен).
 */
export function resolveBrowserProfileNames(
  remote: {
    browserProfiles?: readonly string[];
    browserProfile?: string;
    profiles?: Record<string, { class?: ExecutionProfileClass }>;
  } | undefined,
): string[] {
  const list: string[] = [];
  const push = (name: string | undefined): void => {
    const trimmed = (name ?? '').trim();
    if (trimmed === '' || list.includes(trimmed)) return;
    list.push(trimmed);
  };
  for (const name of normalizeProfileNameList(remote?.browserProfiles)) push(name);
  for (const [name, profile] of Object.entries(remote?.profiles ?? {})) {
    const cls = effectiveProfileClass(profile, name, remote?.browserProfiles, remote?.browserProfile);
    if (cls === 'browser' || cls === 'both') push(name);
  }
  push(remote?.browserProfile);
  return list;
}

/**
 * Каталог профилей **исполнения** (exec) — без имён браузерного каталога.
 *
 * В каталог входят профили с классом `exec`/`both` плюс профиль по умолчанию
 * (`defaultProfile` — единственная точка отката exec-контура, даже если он
 * браузерный). Имена из legacy-списка `browserProfiles` и браузерный профиль
 * по умолчанию в exec-каталог **не** входят.
 */
export function resolveExecutionProfileNames(
  remote: Pick<ResolvedExecutionRemoteConfig, 'profiles' | 'defaultProfile'> & {
    browserProfiles?: readonly string[];
    browserProfile?: string;
  },
): string[] {
  const names = Object.keys(remote.profiles ?? {});
  if (!names.includes(remote.defaultProfile) && remote.defaultProfile.trim() !== '') {
    names.push(remote.defaultProfile);
  }
  return names.filter((name) => {
    if (name === remote.defaultProfile) return true;
    const cls = effectiveProfileClass(
      remote.profiles?.[name],
      name,
      remote.browserProfiles,
      remote.browserProfile,
    );
    return cls !== 'browser';
  });
}

/**
 * Резолвит режим исполнения. Приоритет: CLI-флаг > env `SYNTH_EXECUTION_MODE` >
 * `config.execution.mode` > `inline`.
 *
 * **Fail-closed**: неизвестное явно заданное значение — ошибка (опечатка `inlne`
 * не должна молча оставить инстанс в inline-режиме).
 */
export function resolveExecutionMode(
  config: SynthConfig,
  env: NodeJS.ProcessEnv = process.env,
  cli?: ExecutionCliOverride,
): ExecutionMode {
  const cliMode = cli?.mode;
  if (cliMode !== undefined && cliMode !== null && String(cliMode).trim() !== '') {
    const raw = String(cliMode).trim();
    if (isExecutionMode(raw)) return raw;
    throw new Error(invalidModeMessage(EXECUTION_MODE_CLI_FLAG, raw));
  }

  const envMode = env[EXECUTION_ENV.mode];
  if (envMode !== undefined && envMode !== '') {
    const raw = envMode.trim();
    if (isExecutionMode(raw)) return raw;
    throw new Error(invalidModeMessage(EXECUTION_ENV.mode, envMode));
  }

  const cfgMode = config.execution?.mode;
  if (cfgMode !== undefined) {
    if (isExecutionMode(cfgMode)) return cfgMode;
    throw new Error(invalidModeMessage('execution.mode', String(cfgMode)));
  }

  return 'inline';
}

/**
 * Резолвит секцию `execution` целиком (ADR-077).
 *
 * Приоритет (ADR-023): CLI-флаг (`--execution-mode`) > env `SYNTH_EXECUTION_*` >
 * `config.execution.*` > дефолты. Нечисловые env-значения — warn и фолбэк на
 * config/дефолт (fail-soft, как прочие числовые env-резолверы); неизвестные
 * `mode`/`failMode` — **fail-closed** (ошибка).
 */
export function resolveExecutionConfig(
  config: SynthConfig,
  env: NodeJS.ProcessEnv = process.env,
  cli?: ExecutionCliOverride,
): ResolvedExecutionConfig {
  const mode = resolveExecutionMode(config, env, cli);

  const remoteCfg = config.execution?.remote ?? {};

  // Адреса исполнителей: env (список через запятую) > config.yaml > [].
  const rawUrl = env[EXECUTION_ENV.remoteUrl];
  const url =
    rawUrl !== undefined && rawUrl !== ''
      ? parseExecutionUrlList(rawUrl)
      : [...(remoteCfg.url ?? [])];

  // Таймаут exec-вызова: env > config.yaml > дефолт (30 с).
  const timeoutMs = resolvePositiveInt(
    env[EXECUTION_ENV.timeoutMs],
    remoteCfg.timeoutMs,
    EXECUTION_ENV.timeoutMs,
  ) ?? DEFAULT_EXECUTION_TIMEOUT_MS;

  // Лимит одновременных вызовов: env > config.yaml > число CPU процесса.
  const concurrency =
    resolvePositiveInt(
      env[EXECUTION_ENV.concurrency],
      remoteCfg.concurrency,
      EXECUTION_ENV.concurrency,
    ) ?? defaultExecutionConcurrency();

  // Поведение при недоступности исполнителя: env > config.yaml > `fail`.
  const failMode = resolveFailMode(remoteCfg.failMode, env);

  // Токен исполнителя: env > config.yaml > '' (путь/ссылка, НЕ значение).
  const tokenEnv = env[EXECUTION_ENV.token];
  const tokenSecret =
    tokenEnv !== undefined && tokenEnv !== '' ? tokenEnv : (remoteCfg.tokenSecret ?? '');

  // PROP-135 Ф4a: режим пула, профиль по умолчанию, каталог профилей и
  // поведение при непригодном профиле. Приоритет — как у прочих полей
  // секции: env > config.yaml > дефолт (ADR-023); неизвестное **явное**
  // значение — fail-closed (как `mode`/`failMode`).
  const pooling = resolvePooling(remoteCfg.pooling, env);
  const defaultProfile = resolveDefaultProfile(remoteCfg.defaultProfile, env);
  // Browser-профиль: тот же приоритет (env > config.yaml > дефолт). Пустое
  // значение — «не задано»: берётся следующий источник, иначе `browser`.
  const browserProfile = resolveConfiguredName(
    EXECUTION_ENV.browserProfile,
    remoteCfg.browserProfile,
    DEFAULT_EXECUTION_BROWSER_PROFILE,
    env,
  );
  // Браузерный контур: явный каталог браузерных профилей. Приоритет — env
  // (csv) > config.yaml > [] (эффективный каталог = `[browserProfile]`).
  const browserProfilesRaw = env[EXECUTION_ENV.browserProfiles];
  const browserProfiles =
    browserProfilesRaw !== undefined && browserProfilesRaw.trim() !== ''
      ? normalizeProfileNameList(browserProfilesRaw.split(','))
      : normalizeProfileNameList(remoteCfg.browserProfiles);
  const browserMcpServer = resolveConfiguredName(
    EXECUTION_ENV.browserMcpServer,
    remoteCfg.browserMcpServer,
    DEFAULT_EXECUTION_BROWSER_MCP_SERVER,
    env,
  );
  // Таймаут одного вызова браузерного MCP-инструмента: env > config.yaml >
  // дефолт (2 мин). Явное значение вне потолка (600 000 мс) — **fail-closed**:
  // молча обрезанный таймаут выглядел бы как «применилось», а не как ошибка.
  const browserTimeoutMs = resolveBrowserTimeoutMs(remoteCfg.browserTimeoutMs, env);
  const profiles = resolveExecutionProfiles(remoteCfg.profiles, {
    url,
    timeoutMs,
    concurrency,
    failMode,
  });
  const fallback = resolveFallback(remoteCfg.fallback, env);

  // PROP-135 Ф4b-1: провайдер пулов и параметры provisioner'а. Порядок тот
  // же (env > config.yaml > дефолт); неизвестное **явное** значение провайдера
  // — fail-closed (как `mode`/`failMode`/`pooling`).
  const provider = resolvePoolProvider(remoteCfg.provider, env);
  const provisioner = resolveProvisioner(remoteCfg.provisioner, env);

  // Fail-closed: провайдер `http` без адреса provisioner'а — «куда обращаться»
  // не задано. Молчаливый откат на `static` означал бы, что оператор запросил
  // динамические пулы, а получил статические (изоляция пулов нарушена).
  if (provider === 'http' && provisioner.url.trim() === '') {
    throw new Error(
      `[config] execution.remote.provider="http" требует адрес provisioner'а ` +
        `(execution.remote.provisioner.url / ${EXECUTION_ENV.provisionerUrl})`,
    );
  }

  return {
    mode,
    remote: {
      url,
      timeoutMs,
      concurrency,
      failMode,
      tokenSecret,
      pooling,
      defaultProfile,
      browserProfile,
      browserProfiles,
      browserMcpServer,
      browserTimeoutMs,
      profiles,
      // ADR-135 (аддендум §11): происхождение профилей config-уровня — все
      // они из `config.yaml` (их можно отключить через `disabledProfiles`).
      profileOrigins: Object.fromEntries(
        Object.keys(profiles).map((name) => [name, 'config' as ExecutionProfileOrigin]),
      ),
      fallback,
      provider,
      provisioner,
    },
  };
}

/**
 * Провайдер пулов: env > config.yaml > `static`.
 * Неизвестное явное значение — **fail-closed**.
 */
function resolvePoolProvider(
  cfgValue: ExecutionPoolProviderKind | undefined,
  env: NodeJS.ProcessEnv,
): ExecutionPoolProviderKind {
  const raw = env[EXECUTION_ENV.provider];
  if (raw !== undefined && raw !== '') {
    const trimmed = raw.trim();
    if (isExecutionPoolProvider(trimmed)) return trimmed;
    throw new Error(invalidProviderMessage(EXECUTION_ENV.provider, raw));
  }
  if (cfgValue !== undefined) {
    if (isExecutionPoolProvider(cfgValue)) return cfgValue;
    throw new Error(invalidProviderMessage('execution.remote.provider', String(cfgValue)));
  }
  return 'static';
}

/**
 * Параметры provisioner'а: env > config.yaml > дефолт (пустой адрес, пустой
 * токен, таймаут 10 с).
 *
 * `tokenSecret` — **путь/ссылка**, НЕ значение (инвариант 13): значение
 * читается из файла в момент обращения к provisioner'у.
 */
function resolveProvisioner(
  cfgValue:
    | { url?: string; tokenSecret?: string; timeoutMs?: number }
    | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedExecutionProvisioner {
  const rawUrl = env[EXECUTION_ENV.provisionerUrl];
  const url =
    rawUrl !== undefined && rawUrl !== ''
      ? rawUrl.trim()
      : (cfgValue?.url ?? '').trim();

  const rawToken = env[EXECUTION_ENV.provisionerToken];
  const tokenSecret =
    rawToken !== undefined && rawToken !== ''
      ? rawToken
      : (cfgValue?.tokenSecret ?? '');

  const timeoutMs =
    resolvePositiveInt(
      env[EXECUTION_ENV.provisionerTimeoutMs],
      cfgValue?.timeoutMs,
      EXECUTION_ENV.provisionerTimeoutMs,
    ) ?? DEFAULT_EXECUTION_PROVISIONER_TIMEOUT_MS;

  return { url, tokenSecret, timeoutMs };
}

/**
 * Режим пула: env > config.yaml > `instance`.
 * Неизвестное явное значение — **fail-closed** (опечатка не должна молча
 * оставить инстанс в instance-пуле).
 */
function resolvePooling(
  cfgValue: ExecutionPooling | undefined,
  env: NodeJS.ProcessEnv,
): ExecutionPooling {
  const raw = env[EXECUTION_ENV.pooling];
  if (raw !== undefined && raw !== '') {
    const trimmed = raw.trim();
    if (isExecutionPooling(trimmed)) return trimmed;
    throw new Error(invalidPoolingMessage(EXECUTION_ENV.pooling, raw));
  }
  if (cfgValue !== undefined) {
    if (isExecutionPooling(cfgValue)) return cfgValue;
    throw new Error(invalidPoolingMessage('execution.remote.pooling', String(cfgValue)));
  }
  return 'instance';
}

/**
 * Поведение при непригодном профиле: env > config.yaml > `instance`.
 * Неизвестное явное значение — **fail-closed**.
 */
function resolveFallback(
  cfgValue: ExecutionFallback | undefined,
  env: NodeJS.ProcessEnv,
): ExecutionFallback {
  const raw = env[EXECUTION_ENV.fallback];
  if (raw !== undefined && raw !== '') {
    const trimmed = raw.trim();
    if (isExecutionFallback(trimmed)) return trimmed;
    throw new Error(invalidFallbackMessage(EXECUTION_ENV.fallback, raw));
  }
  if (cfgValue !== undefined) {
    if (isExecutionFallback(cfgValue)) return cfgValue;
    throw new Error(invalidFallbackMessage('execution.remote.fallback', String(cfgValue)));
  }
  return 'instance';
}

/**
 * Имя профиля по умолчанию: env > config.yaml > `default`.
 *
 * Пустое значение (env или config) — «не задано»: берётся следующий
 * источник, иначе `default`. Имя профиля — обычная строка (каталог задаёт
 * ADMIN), поэтому проверяется только непустота.
 */
function resolveDefaultProfile(
  cfgValue: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return resolveConfiguredName(EXECUTION_ENV.defaultProfile, cfgValue, 'default', env);
}

/**
 * Непустое имя из конфигурации: env > config.yaml > `fallback`.
 *
 * Пустое значение (env или config) — «не задано»: берётся следующий источник.
 * Имя профиля/сервера — обычная строка (каталог задаёт ADMIN), поэтому
 * проверяется только непустота.
 */
function resolveConfiguredName(
  envName: string,
  cfgValue: string | undefined,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  const raw = env[envName];
  if (raw !== undefined && raw.trim() !== '') return raw.trim();
  const cfgTrimmed = (cfgValue ?? '').trim();
  if (cfgTrimmed !== '') return cfgTrimmed;
  return fallback;
}

/**
 * Таймаут одного вызова браузерного MCP-инструмента, мс.
 *
 * env > config.yaml > дефолт (120 с). Явное значение проверяется
 * **fail-closed**: не целое/не положительное/выше потолка (600 000 мс) —
 * ошибка конфигурации, а не тихий откат на дефолт (явная настройка
 * оператора не должна молча превращаться в другую).
 */
function resolveBrowserTimeoutMs(
  cfgValue: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[EXECUTION_ENV.browserTimeoutMs];
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < 1 || value > MAX_EXECUTION_BROWSER_TIMEOUT_MS) {
      throw new Error(
        `[config] невалидное значение ${EXECUTION_ENV.browserTimeoutMs}="${raw}": ` +
          `ожидается целое от 1 до ${MAX_EXECUTION_BROWSER_TIMEOUT_MS}`,
      );
    }
    return value;
  }
  if (cfgValue !== undefined) {
    if (
      !Number.isInteger(cfgValue) ||
      cfgValue < 1 ||
      cfgValue > MAX_EXECUTION_BROWSER_TIMEOUT_MS
    ) {
      throw new Error(
        `[config] невалидное значение execution.remote.browserTimeoutMs="${cfgValue}": ` +
          `ожидается целое от 1 до ${MAX_EXECUTION_BROWSER_TIMEOUT_MS}`,
      );
    }
    return cfgValue;
  }
  return DEFAULT_EXECUTION_BROWSER_TIMEOUT_MS;
}

/**
 * Эффективные параметры профилей (PROP-135 Ф4a): профиль **поверх** общих
 * параметров секции.
 *
 * - `url` профиля пуст → наследует общий `execution.remote.url`;
 * - `timeoutMs`/`concurrency`/`failMode` не заданы → наследуют общие.
 *
 * Профили задаются **только** в `config.yaml` (env-переопределение каталога
 * профилей на этом шаге не заводим).
 */
function resolveExecutionProfiles(
  cfgProfiles: Record<
    string,
    {
      url?: string[];
      timeoutMs?: number;
      concurrency?: number;
      failMode?: ExecutionFailMode;
      description?: string;
      image?: string;
      network?: ExecutionProfileNetwork;
      resources?: ExecutionProfileResources;
      runtimeClass?: string;
      class?: ExecutionProfileClass;
      mcpServers?: string[];
      annotations?: Record<string, string>;
      labels?: Record<string, string>;
      nodeSelector?: Record<string, string>;
      tolerations?: ExecutionProfileToleration[];
      affinity?: Record<string, unknown>;
    }
  > | undefined,
  common: {
    url: string[];
    timeoutMs: number;
    concurrency: number;
    failMode: ExecutionFailMode;
  },
): Record<string, ResolvedExecutionProfile> {
  const out: Record<string, ResolvedExecutionProfile> = {};
  for (const [name, profile] of Object.entries(cfgProfiles ?? {})) {
    const profileUrl = (profile.url ?? []).map((u) => u.trim()).filter((u) => u.length > 0);
    const resolved: ResolvedExecutionProfile = {
      url: profileUrl.length > 0 ? profileUrl : [...common.url],
      timeoutMs: profile.timeoutMs ?? common.timeoutMs,
      concurrency: profile.concurrency ?? common.concurrency,
      failMode: profile.failMode ?? common.failMode,
    };
    // Метаданные (не участвуют в маршрутизации): пустые/undefined не задаём.
    const description = profile.description?.trim();
    if (description !== undefined && description !== '') resolved.description = description;
    const image = profile.image?.trim();
    if (image !== undefined && image !== '') resolved.image = image;
    if (profile.network !== undefined) resolved.network = profile.network;
    const resources = resolveProfileResources(profile.resources);
    if (resources !== undefined) resolved.resources = resources;
    const runtimeClass = profile.runtimeClass?.trim();
    if (runtimeClass !== undefined && runtimeClass !== '') resolved.runtimeClass = runtimeClass;
    // Placement профиля (аннотации/метки/отбор нод) — уходит в pod spec
    // пула; пустые блоки не задаём (метаданные не должны шуметь).
    const annotations = normalizeStringMap(profile.annotations);
    if (annotations !== undefined) resolved.annotations = annotations;
    const labels = normalizeStringMap(profile.labels);
    if (labels !== undefined) resolved.labels = labels;
    const nodeSelector = normalizeStringMap(profile.nodeSelector);
    if (nodeSelector !== undefined) resolved.nodeSelector = nodeSelector;
    if (profile.tolerations !== undefined && profile.tolerations.length > 0) {
      resolved.tolerations = profile.tolerations.map((toleration) => ({ ...toleration }));
    }
    if (profile.affinity !== undefined && Object.keys(profile.affinity).length > 0) {
      resolved.affinity = { ...profile.affinity };
    }
    // Объявленный класс профиля (ADR-135, аддендум §11): эффективный класс
    // выводится из него, legacy-списка `browserProfiles` и `browserProfile`.
    if (profile.class !== undefined) resolved.class = profile.class;
    // Config-уровень хранит только **имена** MCP-серверов (команда — в
    // runtime-каталоге): нормализуем в `{ name }`.
    const mcpServers = (profile.mcpServers ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((name) => ({ name }));
    if (mcpServers.length > 0) resolved.mcpServers = mcpServers;
    out[name] = resolved;
  }
  return out;
}

/**
 * Карта строковых значений профиля (аннотации/метки/селектор): копия без
 * пустых ключей и значений; пустая карта — `undefined` (поле не задано).
 */
function normalizeStringMap(
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (map === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    const trimmedKey = key.trim();
    const trimmedValue = typeof value === 'string' ? value.trim() : '';
    if (trimmedKey === '' || trimmedValue === '') continue;
    out[trimmedKey] = trimmedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Ресурсы профиля: копируются только заданные непустые строки; пустой объект
 * (ни одного значения) → `undefined`, чтобы метаданные не шумели в ответе.
 */
function resolveProfileResources(
  resources: ExecutionProfileResources | undefined,
): ExecutionProfileResources | undefined {
  if (resources === undefined) return undefined;
  const requests = resolveResourceList(resources.requests);
  const limits = resolveResourceList(resources.limits);
  if (requests === undefined && limits === undefined) return undefined;
  return {
    ...(requests !== undefined ? { requests } : {}),
    ...(limits !== undefined ? { limits } : {}),
  };
}

function resolveResourceList(
  list: ExecutionProfileResources['requests'],
): ExecutionProfileResources['requests'] {
  if (list === undefined) return undefined;
  // Список **произвольный** (`nvidia.com/gpu` и пр.) — копируются все ключи,
  // а не только cpu/memory/ephemeralStorage.
  const out: NonNullable<ExecutionProfileResources['requests']> = {};
  for (const [key, value] of Object.entries(list)) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed !== '') out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveFailMode(
  cfgValue: ExecutionFailMode | undefined,
  env: NodeJS.ProcessEnv,
): ExecutionFailMode {
  const raw = env[EXECUTION_ENV.failMode];
  if (raw !== undefined && raw !== '') {
    const trimmed = raw.trim();
    if (isExecutionFailMode(trimmed)) return trimmed;
    throw new Error(invalidFailModeMessage(EXECUTION_ENV.failMode, raw));
  }
  if (cfgValue !== undefined) {
    if (isExecutionFailMode(cfgValue)) return cfgValue;
    throw new Error(invalidFailModeMessage('execution.remote.failMode', String(cfgValue)));
  }
  return 'fail';
}

/** Положительное целое из env; невалидно — warn и фолбэк на config (fail-soft). */
function resolvePositiveInt(
  rawEnv: string | undefined,
  cfgValue: number | undefined,
  envName: string,
): number | undefined {
  if (rawEnv !== undefined && rawEnv !== '') {
    const n = Number(rawEnv);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
    console.warn(
      `[config] невалидное значение ${envName}="${rawEnv}" (ожидается целое > 0) — игнорируется`,
    );
  }
  return cfgValue;
}
