/**
 * ADR-099: единый механизм доверия TLS/CA — конфиг-резолверы секции
 * `security.tls` (ADR-023: приоритет `env > config.yaml > defaults`).
 *
 * Здесь только **чтение и валидация конфигурации** доверия: слияние env/config,
 * взаимоисключение `caFile`/`caPem` и fail-closed проверка явно заданного
 * PEM-файла. Построение dispatcher'а и применение доверия к исходящим запросам —
 * в core (`packages/core/src/security/tls.ts`).
 *
 * Пусто/не задано — системное доверие (системные CA Node), поведение не меняется.
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { SecurityTlsConfig } from './types.js';

/** Минимальный срез конфига, достаточный резолверу (совместим с `SynthConfig`). */
export interface TlsConfigSource {
  security?: { tls?: SecurityTlsConfig } | undefined;
}

/** Источник эффективного значения параметра доверия TLS. */
export type TlsSource = 'env' | 'runtime' | 'config' | 'none';

/** Клиентский материал (mTLS): сертификат + ключ — только парой. */
export interface TlsClientMaterial {
  certFile?: string;
  keyFile?: string;
}

/**
 * Runtime-настройки bootstrap-хранилища `{dataDir}/security-tls.json`.
 * Читаются до подключения к PostgreSQL; редактируются из UI (будущий этап).
 * В JSON — пути к PEM-файлам (кроме публичного `caPem`).
 */
export interface TlsRuntimeSettings {
  caFile?: string;
  caPem?: string;
  rejectUnauthorized?: boolean;
  /** Глобальный клиентский профиль (mTLS) по умолчанию. */
  defaultClient?: TlsClientMaterial;
  /** Per-host клиентские профили (порядок = приоритет первого совпадения). */
  mappings?: TlsMappingSettings[];
}

/** Per-host маппинг клиентского сертификата (runtime). */
export interface TlsMappingSettings {
  id: string;
  hosts: string[];
  certFile: string;
  keyFile: string;
  label?: string;
}

/** Эффективный клиентский TLS-профиль (пути; чтение PEM — на стороне core/драйвера). */
export interface TlsClientProfile {
  /** `default` либо id маппинга. */
  id: string;
  /** Host-паттерны (`[]` для профиля по умолчанию). */
  hosts: string[];
  label?: string;
  certFile: string;
  keyFile: string;
  source: TlsSource;
  /** `true` — источник env/config (UI только показывает, не редактирует). */
  readOnly: boolean;
}

/** Эффективная конфигурация `security.tls` (env > runtime > config.yaml). */
export interface ResolvedTlsConfig {
  /** Путь к PEM-файлу доверенного CA (взаимоисключающ с `caPem`). */
  caFile?: string;
  /** PEM доверенного CA (взаимоисключающ с `caFile`). */
  caPem?: string;
  /** Путь к PEM-файлу клиентского сертификата (mTLS). */
  certFile?: string;
  /** Путь к PEM-файлу приватного ключа клиента (mTLS). */
  keyFile?: string;
  /** Проверять сертификат сервера (по умолчанию `true`). */
  rejectUnauthorized: boolean;
}

/** Эффективное доверие с уже прочитанным и проверенным CA (для построения dispatcher). */
export interface ResolvedTlsTrust {
  /** `true` — доверие явно сконфигурировано (CA/клиентский серт/`rejectUnauthorized: false`). */
  enabled: boolean;
  /** PEM CA: содержимое `caPem` либо прочитанный `caFile`. */
  ca?: string;
  /** Путь к PEM-файлу клиентского сертификата (чтение — на стороне core). */
  certFile?: string;
  /** Путь к PEM-файлу приватного ключа клиента (чтение — на стороне core). */
  keyFile?: string;
  rejectUnauthorized: boolean;
}

/** Эффективные клиентские профили + источники (ADR-099, per-host mTLS). */
export interface ResolvedTlsProfiles {
  /** Глобальный профиль по умолчанию (env/runtime/config). */
  default?: TlsClientProfile;
  /** Per-host маппинги (runtime; порядок сохраняется). */
  mappings: TlsClientProfile[];
  caFile?: string;
  caPem?: string;
  rejectUnauthorized: boolean;
  sources: {
    ca: TlsSource;
    rejectUnauthorized: TlsSource;
    defaultClient: TlsSource;
  };
}

/** Env-имена секции `security.tls` (ADR-023). */
export const TLS_ENV = {
  caFile: 'SYNTH_TLS_CA_FILE',
  caPem: 'SYNTH_TLS_CA_PEM',
  certFile: 'SYNTH_TLS_CERT_FILE',
  keyFile: 'SYNTH_TLS_KEY_FILE',
  rejectUnauthorized: 'SYNTH_TLS_REJECT_UNAUTHORIZED',
} as const;

/** PEM-маркер блока (заголовок `-----BEGIN <TYPE>-----`). */
const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----/;

/** `true`, если строка содержит PEM-блок. */
export function isPemContent(value: string): boolean {
  return PEM_BLOCK_RE.test(value);
}

/**
 * Сливает env, runtime (bootstrap) и config.yaml для `security.tls`
 * (ADR-023): приоритет **поле-уровнево** `env > runtime > config`. Пустая
 * строка env — «не задано». `caFile` и `caPem` взаимоисключащи: после слияния
 * оба непусты (в т.ч. из разных источников) → ошибка конфигурации (fail-closed).
 */
export function resolveTlsConfig(
  config: TlsConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: TlsRuntimeSettings,
): ResolvedTlsConfig {
  const resolved = resolveTlsProfiles(config, env, runtime);
  const result: ResolvedTlsConfig = { rejectUnauthorized: resolved.rejectUnauthorized };
  if (resolved.caFile !== undefined) result.caFile = resolved.caFile;
  if (resolved.caPem !== undefined) result.caPem = resolved.caPem;
  if (resolved.default !== undefined) {
    result.certFile = resolved.default.certFile;
    result.keyFile = resolved.default.keyFile;
  }
  return result;
}

/** Значение с источником (для статуса/приоритетов). */
function pickWithSource(
  envValue: string | undefined,
  runtimeValue: string | undefined,
  configValue: string | undefined,
): { value?: string; source: TlsSource } {
  if (envValue !== undefined && envValue !== '') return { value: envValue, source: 'env' };
  if (runtimeValue !== undefined && runtimeValue !== '') return { value: runtimeValue, source: 'runtime' };
  if (configValue !== undefined && configValue !== '') return { value: configValue, source: 'config' };
  return { source: 'none' };
}

/**
 * Эффективные клиентские профили (mTLS) + CA/rejectUnauthorized с источниками.
 *
 * Приоритет поле-уровневый: `env > runtime > config`. Клиентская пара
 * `certFile`/`keyFile` собирается по полям; неполная пара (серт без ключа или
 * наоборот) — fail-closed: mTLS без ключа/серта не работает, а «тихий» выбор
 * одного источника скрыл бы опечатку. Маппинги — только runtime (редактируемые).
 */
export function resolveTlsProfiles(
  config: TlsConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: TlsRuntimeSettings,
): ResolvedTlsProfiles {
  const e = env;
  const cfg: SecurityTlsConfig = config?.security?.tls ?? {};
  const rt = runtime ?? {};

  const caFile = pickWithSource(e[TLS_ENV.caFile], rt.caFile, cfg.caFile);
  const caPem = pickWithSource(e[TLS_ENV.caPem], rt.caPem, cfg.caPem);
  if (caFile.value !== undefined && caPem.value !== undefined) {
    throw new Error(
      `[config] security.tls: 'caFile' и 'caPem' взаимоисключащи — задайте ровно один ` +
        `источник CA (${TLS_ENV.caFile} ИЛИ ${TLS_ENV.caPem}); конфликт между источниками ` +
        '(env/runtime/config) не разрешается автоматически',
    );
  }
  const caSource: TlsSource = caFile.value !== undefined ? caFile.source : caPem.source;

  const reject = resolveRejectUnauthorizedWithSource(
    e[TLS_ENV.rejectUnauthorized],
    rt.rejectUnauthorized,
    cfg.rejectUnauthorized,
  );

  const certFile = pickWithSource(e[TLS_ENV.certFile], rt.defaultClient?.certFile, cfg.certFile);
  const keyFile = pickWithSource(e[TLS_ENV.keyFile], rt.defaultClient?.keyFile, cfg.keyFile);
  let defaultClient: TlsClientProfile | undefined;
  if (certFile.value !== undefined || keyFile.value !== undefined) {
    if (certFile.value === undefined || keyFile.value === undefined) {
      throw new Error(
        '[config] security.tls: mTLS требует и certFile, и keyFile (задайте оба либо ни одного; ' +
          'неполная пара между env/runtime/config — fail-closed)',
      );
    }
    const clientSource: TlsSource =
      certFile.source === 'env' || keyFile.source === 'env'
        ? 'env'
        : certFile.source === 'runtime' || keyFile.source === 'runtime'
          ? 'runtime'
          : 'config';
    defaultClient = {
      id: 'default',
      hosts: [],
      certFile: certFile.value,
      keyFile: keyFile.value,
      source: clientSource,
      readOnly: clientSource !== 'runtime',
    };
  }

  const mappings: TlsClientProfile[] = (rt.mappings ?? []).map((mapping) => ({
    id: mapping.id,
    hosts: [...mapping.hosts],
    ...(mapping.label !== undefined && mapping.label !== '' ? { label: mapping.label } : {}),
    certFile: mapping.certFile,
    keyFile: mapping.keyFile,
    source: 'runtime',
    readOnly: false,
  }));

  const resolved: ResolvedTlsProfiles = {
    mappings,
    rejectUnauthorized: reject.value,
    sources: {
      ca: caSource,
      rejectUnauthorized: reject.source,
      defaultClient: defaultClient?.source ?? 'none',
    },
  };
  if (defaultClient !== undefined) resolved.default = defaultClient;
  if (caFile.value !== undefined) resolved.caFile = caFile.value;
  if (caPem.value !== undefined) resolved.caPem = caPem.value;
  return resolved;
}

/** `rejectUnauthorized` с источником; невалидный env — warn + фоллбэк ниже. */
function resolveRejectUnauthorizedWithSource(
  rawEnv: string | undefined,
  runtimeValue: boolean | undefined,
  cfgValue: boolean | undefined,
): { value: boolean; source: TlsSource } {
  if (rawEnv !== undefined && rawEnv !== '') {
    const v = rawEnv.toLowerCase();
    if (v === 'true' || v === '1') return { value: true, source: 'env' };
    if (v === 'false' || v === '0') return { value: false, source: 'env' };
    console.warn(
      `[config] невалидное значение ${TLS_ENV.rejectUnauthorized}="${rawEnv}" (ожидается true/1/false/0) — игнорируется`,
    );
  }
  if (runtimeValue !== undefined) return { value: runtimeValue, source: 'runtime' };
  if (cfgValue !== undefined) return { value: cfgValue, source: 'config' };
  return { value: true, source: 'none' };
}

/**
 * Выбирает клиентский профиль по host: точное совпадение, `*.suffix` (поддомены)
 * либо `*` (все хосты), регистронезависимо; **первое** совпадение в порядке
 * маппингов, затем профиль по умолчанию, иначе `undefined` (без клиентского серта).
 */
export function selectTlsClientProfile(
  profiles: Pick<ResolvedTlsProfiles, 'default' | 'mappings'>,
  host: string | undefined,
): TlsClientProfile | undefined {
  const normalized = normalizeTlsHost(host);
  if (normalized !== undefined) {
    for (const mapping of profiles.mappings) {
      if (mapping.hosts.some((pattern) => matchTlsHostPattern(pattern, normalized))) {
        return mapping;
      }
    }
  }
  return profiles.default;
}

/** Матчинг одного паттерна (`host` | `*.suffix` | `*`); регистронезависимо. */
export function matchTlsHostPattern(pattern: string, rawHost: string): boolean {
  const host = normalizeTlsHost(rawHost);
  if (host === undefined) return false;
  const value = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (value === '*') return true;
  if (value.startsWith('*.')) {
    const suffix = value.slice(2);
    return suffix !== '' && host.endsWith(`.${suffix}`);
  }
  return host === value;
}

/** Нормализует host (нижний регистр, без точки в конце и скобок IPv6). */
export function normalizeTlsHost(rawHost: string | undefined): string | undefined {
  if (typeof rawHost !== 'string') return undefined;
  let host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host === '' ? undefined : host;
}

/**
 * Эффективное доверие с прочитанным CA. Fail-closed: `caFile` задан, но файл
 * отсутствует/не читается/не PEM → внятная ошибка (никакого тихого фоллбэка на
 * системное доверие, иначе опечатка в пути молча ломает доверие к корпоративному CA).
 * `caPem` также проверяется на PEM-блок.
 */
export function resolveTlsTrust(
  config: TlsConfigSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: TlsRuntimeSettings,
): ResolvedTlsTrust {
  const resolved = resolveTlsConfig(config, env, runtime);
  const profiles = resolveTlsProfiles(config, env, runtime);

  let ca: string | undefined;
  if (resolved.caFile !== undefined) {
    let content: string;
    try {
      content = readFileSync(resolved.caFile, 'utf-8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[config] security.tls.caFile: не удалось прочитать файл "${resolved.caFile}": ${reason}`,
      );
    }
    if (!isPemContent(content)) {
      throw new Error(
        `[config] security.tls.caFile: файл "${resolved.caFile}" не содержит PEM-сертификат ` +
          `(ожидается блок "-----BEGIN CERTIFICATE-----")`,
      );
    }
    ca = content;
  } else if (resolved.caPem !== undefined) {
    if (!isPemContent(resolved.caPem)) {
      throw new Error(
        '[config] security.tls.caPem: значение не содержит PEM-сертификат ' +
          '(ожидается блок "-----BEGIN CERTIFICATE-----")',
      );
    }
    ca = resolved.caPem;
  }

  const enabled =
    ca !== undefined ||
    resolved.certFile !== undefined ||
    resolved.keyFile !== undefined ||
    resolved.rejectUnauthorized === false ||
    profiles.mappings.length > 0;

  const trust: ResolvedTlsTrust = { enabled, rejectUnauthorized: resolved.rejectUnauthorized };
  if (ca !== undefined) trust.ca = ca;
  if (resolved.certFile !== undefined) trust.certFile = resolved.certFile;
  if (resolved.keyFile !== undefined) trust.keyFile = resolved.keyFile;
  return trust;
}

// ─── PostgreSQL: TLS-опции соединения (ADR-099 × PROP-032) ─────────────────────

/**
 * Эффективный TLS-режим PostgreSQL (`storage.postgres.sslmode`).
 * `verify-ca` — **алиас** `verify-full` (см. `normalizePostgresSslMode`).
 */
export type PostgresSslMode = 'disable' | 'require' | 'verify-full';

/** Допустимые значения `sslmode` (в порядке документации; `verify-ca` — алиас). */
export const POSTGRES_SSL_MODES: readonly PostgresSslMode[] = ['disable', 'require', 'verify-full'];

/**
 * Алиасы `sslmode`, нормализуемые к канонической форме. `verify-ca`
 * (`pg-connection-string` v2 трактует его как `verify-full`) — принимаем как
 * `verify-full` **с предупреждением**: тихая трактовка «с проверкой hostname»
 * сюрпризом не будет.
 */
export const POSTGRES_SSL_MODE_ALIASES: Readonly<Record<string, PostgresSslMode>> = {
  'verify-ca': 'verify-full',
};

/**
 * Нормализует `sslmode` (`disable`/`require`/`verify-full`, алиас `verify-ca` →
 * `verify-full` с warn). Пусто — `undefined` (прежнее поведение, без TLS).
 * Неизвестное значение — `undefined` (вызывающий решает: env → warn + игнор,
 * config — Zod отвергает на схеме).
 */
export function normalizePostgresSslMode(raw: string | undefined): PostgresSslMode | undefined {
  if (raw === undefined || raw === '') return undefined;
  if ((POSTGRES_SSL_MODES as readonly string[]).includes(raw)) return raw as PostgresSslMode;
  const alias = POSTGRES_SSL_MODE_ALIASES[raw];
  if (alias !== undefined) {
    console.warn(
      `[config] storage.postgres.sslmode="${raw}" принят как алиас "${alias}" ` +
        `(проверка имени хоста включена)`,
    );
    return alias;
  }
  return undefined;
}

/**
 * TLS-параметры, запрещённые в `dsn`. `pg` накладывает распарсенный
 * `connectionString` **поверх** явного конфига (`Object.assign({}, config,
 * parse(connectionString))`), поэтому `sslmode`/`sslrootcert`/… из DSN молча
 * перекрывают переданный `ssl`-объект — вплоть до отключения TLS. Запрещаем их
 * в DSN, чтобы политика доверия задавалась **только** в `storage.postgres.sslmode`
 * + `security.tls`.
 */
export const DSN_TLS_PARAMS = [
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslnegotiation',
  'uselibpqcompat',
  'ssl',
] as const;

/**
 * Находит TLS-параметры в строке подключения (URL-форма `?sslmode=…` и
 * libpq-подобная `sslmode=…`). Возвращает уникальные имена (нижний регистр);
 * пусто — DSN «чистый» по TLS.
 */
export function findDsnTlsParams(dsn: string | undefined): string[] {
  if (dsn === undefined || dsn.trim() === '') return [];
  const names = new Set<string>();

  try {
    const url = new URL(dsn);
    for (const key of url.searchParams.keys()) {
      const k = key.toLowerCase();
      if ((DSN_TLS_PARAMS as readonly string[]).includes(k)) names.add(k);
    }
  } catch {
    // не URL — проверим regex'ом ниже (libpq-подобная форма)
  }

  const re = /(?:^|[\s?&])(sslmode|sslrootcert|sslcert|sslkey|sslnegotiation|uselibpqcompat|ssl)\s*=/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(dsn)) !== null) {
    if (match[1]) names.add(match[1].toLowerCase());
  }
  return [...names];
}

/** Вход построителя TLS-опций PostgreSQL-соединения (единый источник доверия). */
export interface PostgresSslBuildInput {
  /** `storage.postgres.sslmode` (сырое значение; нормализуется внутри). */
  sslmode?: string;
  /** Legacy `storage.postgres.ssl` (используется, только если `sslmode` не задан). */
  ssl?: boolean;
  /** Строка подключения (из DSN берётся host, если он не задан в `host`). */
  connectionString?: string;
  /** Host (для `servername` в `verify-full`, если не задан DSN). */
  host?: string;
  /** `security.tls` (источник CA/mTLS). */
  config?: TlsConfigSource;
  /** Env для резолва `security.tls` (ADR-023). */
  env?: NodeJS.ProcessEnv;
  /**
   * ADR-099: runtime bootstrap-настройки TLS (`{dataDir}/security-tls.json`) —
   * per-host клиентские профили и CA/rejectUnauthorized (env > runtime > config).
   */
  runtime?: TlsRuntimeSettings;
}

/** Результат построителя: значение для `pg`-конфига `ssl` (если задано). */
export interface PostgresSslBuildResult {
  /**
   * Значение `ssl` для `pg`: `false` (без TLS), `true` (системное доверие) либо
   * объект опций (`rejectUnauthorized`/`ca`/`cert`/`key`/`servername`).
   * Не задано — `ssl` в `pg`-конфиг не проставляется (прежнее поведение).
   */
  ssl?: boolean | Record<string, unknown>;
}

/**
 * Собирает `ssl`-опции `pg` из **единого** источника доверия (ADR-099):
 *
 *   | sslmode        | ssl-опции `pg`                                                       |
 *   |----------------|----------------------------------------------------------------------|
 *   | не задан       | прежнее поведение: `ssl` из legacy-поля либо ничего (без TLS)         |
 *   | `disable`      | `false` (TLS выключен явно)                                           |
 *   | `require`      | `{ rejectUnauthorized: false }` (+ `cert`/`key` при mTLS)             |
 *   | `verify-full`  | `{ rejectUnauthorized: true, ca, cert?, key?, servername? }`           |
 *   | `verify-ca`    | алиас `verify-full` (нормализуется с предупреждением)                 |
 *
 * **Fail-closed**: `verify-full` без сконфигурированного CA (`security.tls`)
 * бросает ошибку — никакого тихого `rejectUnauthorized: false`.
 * mTLS (`certFile`/`keyFile`) добавляется в `require`/`verify-full`.
 * Для `verify-full` без DSN `servername` = host (кроме IP — SNI по IP запрещён);
 * `pg` и сам выводит `servername` из host, явное значение — для прозрачности.
 */
export function buildPostgresSslOptions(input: PostgresSslBuildInput): PostgresSslBuildResult {
  const env = input.env ?? process.env;
  const mode = normalizePostgresSslMode(input.sslmode);

  if (mode === undefined) {
    return input.ssl === undefined ? {} : { ssl: input.ssl };
  }
  if (mode === 'disable') return { ssl: false };

  // ADR-099: per-host mTLS — профиль выбирается по host БД (явный `host` либо
  // host из DSN), затем default. CA/rejectUnauthorized — общие.
  const profiles = resolveTlsProfiles(input.config, env, input.runtime);
  const pgHost = input.host ?? hostFromDsn(input.connectionString);
  const profile = selectTlsClientProfile(profiles, pgHost);

  if (mode === 'require') {
    // Шифрование без проверки сертификата; mTLS (сертификат клиента) — если задан.
    const ssl: Record<string, unknown> = { rejectUnauthorized: false };
    applyClientIdentity(ssl, profile ?? {});
    return { ssl };
  }

  // verify-full: CA обязателен (fail-closed — не тихий фоллбэк на системное доверие).
  const trust = resolveTlsTrust(input.config, env, input.runtime);
  if (trust.ca === undefined) {
    throw new Error(
      "[config] storage.postgres.sslmode='verify-full' требует доверенный CA: задайте " +
        'security.tls.caFile или security.tls.caPem (иначе проверка сертификата сервера ' +
        'невозможна — fail-closed, тихое rejectUnauthorized:false запрещено)',
    );
  }
  const ssl: Record<string, unknown> = { rejectUnauthorized: true, ca: trust.ca };
  applyClientIdentity(ssl, profile ?? {});

  if (
    input.connectionString === undefined &&
    typeof input.host === 'string' &&
    input.host !== '' &&
    isIP(input.host) === 0
  ) {
    ssl.servername = input.host;
  }
  return { ssl };
}

/** Host из строки подключения (URL-форма); невалидный DSN → `undefined`. */
function hostFromDsn(dsn: string | undefined): string | undefined {
  if (dsn === undefined || dsn.trim() === '') return undefined;
  try {
    return new URL(dsn).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Добавляет клиентский сертификат/ключ (mTLS) в `ssl`-объект. Задан ровно один из
 * `certFile`/`keyFile` — ошибка (нужны оба); читается только при их наличии.
 */
function applyClientIdentity(
  ssl: Record<string, unknown>,
  cfg: { certFile?: string; keyFile?: string },
): void {
  if (cfg.certFile === undefined && cfg.keyFile === undefined) return;
  if (cfg.certFile === undefined || cfg.keyFile === undefined) {
    throw new Error(
      '[config] security.tls: mTLS требует и certFile, и keyFile (задайте оба либо ни одного)',
    );
  }
  ssl.cert = readPemFileContent(
    cfg.certFile,
    'certFile',
    /-----BEGIN CERTIFICATE-----/,
  );
  ssl.key = readPemFileContent(
    cfg.keyFile,
    'keyFile',
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  );
}

/** Читает PEM-файл клиентского сертификата/ключа; нет/не PEM → внятная ошибка. */
function readPemFileContent(path: string, field: string, marker: RegExp): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[config] security.tls.${field}: не удалось прочитать файл "${path}": ${reason}`);
  }
  if (!marker.test(content)) {
    throw new Error(
      `[config] security.tls.${field}: файл "${path}" не содержит PEM ` +
        `(ожидается блок "-----BEGIN ${field === 'keyFile' ? 'PRIVATE KEY' : 'CERTIFICATE'}-----")`,
    );
  }
  return content;
}

