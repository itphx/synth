/**
 * ADR-099: API настроек доверия TLS/CA (`/api/v2/settings/tls`).
 *
 * Изменения пишутся в bootstrap-хранилище `{dataDir}/security-tls.json` и
 * **применяются при следующем старте** процесса (TLS/CA и dispatcher строятся
 * один раз, до первого исходящего запроса и до подключения к PostgreSQL).
 *
 * Безопасность:
 * - PEM-содержимое приватных ключей/сертификатов **никогда** не возвращается,
 *   не логируется и не пишется в аудит; в ответах — только subject/пути/флаги;
 * - файлы материалов — `{dataDir}/secrets/tls/` (0600, каталог 0700, атомарно);
 * - CA и глобальный default-клиент, заданные через env/config, read-only → 409;
 *   per-host mappings разрешены всегда.
 */
import { rm } from 'node:fs/promises';
import { Hono } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { AuthKit } from '../../auth/local.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  TLS_ENV,
  certificateSubjectFromFile,
  certificateSubjectFromPem,
  certificateSubjectsFromPem,
  countCertificates,
  generateId,
  isValidHostPattern,
  nowISO,
  readTlsRuntimeSettings,
  resolveTlsProfiles,
  tlsSecretFilePath,
  validateCaPem,
  validateClientPem,
  validateTlsRuntimeSettings,
  writeTlsRuntimeSettings,
  writeTlsSecretFile,
  type SecurityTlsConfig,
  type TlsMappingSettings,
  type TlsRuntimeSettings,
} from '@itphx/synth-shared';
import { getTlsStatus, type TlsStatus } from '../../security/tls.js';

type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости TLS-роутов (выделены из общего `SettingsRoutesDeps`). */
export interface TlsSettingsDeps {
  /** Каталог данных (`{dataDir}/security-tls.json`, `secrets/tls/`). */
  dataDir?: string;
  /** Env (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** `config.yaml security.tls` — read-only слой для UI (env приоритетнее). */
  fallbackTls?: SecurityTlsConfig;
  /** Аудит изменений security-политик (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
}

export interface TlsSettingsOptions {
  /** Guard на мутации; по умолчанию `auth.requireAuth` (managed — ADMIN). */
  writeGuard?: Middleware;
}

/** Состояние TLS для ответа: статус + сохранённое/запущенное + дефолты. */
interface TlsView {
  status: TlsStatus;
  defaults: TlsStatus;
  saved: TlsStatus['saved'] | null;
  running: TlsStatus['running'] | null;
  restartRequired: boolean;
}

/**
 * Создаёт роутер `/tls` (монтируется под `/api/v2/settings`).
 */
export function createTlsSettingsRoutes(
  auth: AuthKit,
  deps: TlsSettingsDeps,
  opts: TlsSettingsOptions = {},
): Hono {
  const app = new Hono();
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const env = deps.env ?? process.env;
  const config = { security: { tls: deps.fallbackTls } };

  /** dataDir обязателен для мутаций (bootstrap/материалы). */
  const requireDataDir = (): string | undefined => deps.dataDir;

  /** Текущие сохранённые bootstrap-настройки (fail-closed на битом файле). */
  const readRuntime = (dataDir: string): TlsRuntimeSettings | undefined =>
    readTlsRuntimeSettings(dataDir);

  /** Статус для явно заданного runtime (`null` — не читать dataDir). */
  const statusFor = (runtime: TlsRuntimeSettings | undefined): TlsStatus =>
    getTlsStatus({ config, env, runtime: runtime ?? null, dataDir: deps.dataDir });

  /** Собирает ответ GET/мутаций. */
  const viewFor = (runtime: TlsRuntimeSettings | undefined, restartRequired?: boolean): TlsView => {
    const status = statusFor(runtime);
    const defaults = getTlsStatus({ config, env, runtime: null, dataDir: deps.dataDir });
    return {
      status,
      defaults,
      saved: status.saved ?? null,
      running: status.running ?? null,
      restartRequired: restartRequired ?? status.restartRequired ?? false,
    };
  };

  /** Актор изменения (core без RBAC — `local`). */
  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

  /** Best-effort аудит: ошибка записи не ломает операцию. */
  const auditTls = async (
    c: { get(key: 'user'): unknown },
    action: 'update' | 'reset',
    before: unknown,
    after: unknown,
  ): Promise<void> => {
    if (!deps.securityAudit) return;
    try {
      await deps.securityAudit.append({
        id: `sa_${generateId()}`,
        ts: nowISO(),
        actor: actorOf(c),
        scope: 'tls',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит TLS не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** CA задан env → он приоритетнее runtime и read-only для UI. */
  const envCaConfigured = (): boolean =>
    (env[TLS_ENV.caFile] !== undefined && env[TLS_ENV.caFile] !== '')
    || (env[TLS_ENV.caPem] !== undefined && env[TLS_ENV.caPem] !== '');

  /**
   * Глобальный default-клиент задан env/config → read-only (override возможен
   * только per-host mapping'ом). Ошибки конфигурации (неполная пара) — 400.
   */
  const defaultClientReadOnly = (): boolean | { error: string } => {
    try {
      const profiles = resolveTlsProfiles(config, env, undefined);
      return profiles.default?.source === 'env' || profiles.default?.source === 'config';
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** Валидация merged runtime; ошибки — без PEM. */
  const validateMerged = (settings: TlsRuntimeSettings): string | undefined => {
    try {
      validateTlsRuntimeSettings(settings);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  /** Парсит/нормализует host-паттерны. */
  const normalizeHosts = (raw: unknown): { hosts?: string[]; error?: string } => {
    if (!Array.isArray(raw) || raw.length === 0) {
      return { error: 'hosts: ожидается непустой массив паттернов (host | *.suffix | *)' };
    }
    const hosts: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || !isValidHostPattern(item)) {
        return { error: `hosts: недопустимый паттерн "${String(item)}"` };
      }
      const normalized = item.trim().toLowerCase();
      if (!hosts.includes(normalized)) hosts.push(normalized);
    }
    return { hosts };
  };

  /** Безопасное удаление материала из `secrets/tls` (внешние пути не трогаем). */
  const removeMaterial = async (dataDir: string, name: string, expectedPath?: string): Promise<void> => {
    const path = tlsSecretFilePath(dataDir, name);
    if (expectedPath !== undefined && expectedPath !== path) return;
    await rm(path, { force: true }).catch(() => {});
  };

  /** Сводка настроек для аудита — пути/hosts/subject, без PEM и ключей. */
  const sanitizeForAudit = (settings: TlsRuntimeSettings | undefined): unknown => {
    if (!settings) return null;
    const caPem = settings.caPem;
    return {
      ...(settings.caFile !== undefined ? { caFile: settings.caFile } : {}),
      hasCaPem: caPem !== undefined,
      ...(caPem !== undefined
        ? {
            caCount: countCertificates(caPem),
            caSubjects: certificateSubjectsFromPem(caPem),
          }
        : settings.caFile !== undefined
          ? { caSubject: certificateSubjectFromFile(settings.caFile) }
          : {}),
      ...(settings.rejectUnauthorized !== undefined
        ? { rejectUnauthorized: settings.rejectUnauthorized }
        : {}),
      ...(settings.defaultClient !== undefined
        ? {
            defaultClient: {
              certFile: settings.defaultClient.certFile,
              keyFile: settings.defaultClient.keyFile,
              certSubject: certificateSubjectFromFile(settings.defaultClient.certFile),
            },
          }
        : {}),
      mappings: (settings.mappings ?? []).map((mapping) => ({
        id: mapping.id,
        hosts: [...mapping.hosts],
        ...(mapping.label !== undefined ? { label: mapping.label } : {}),
        certFile: mapping.certFile,
        keyFile: mapping.keyFile,
        certSubject: certificateSubjectFromFile(mapping.certFile),
      })),
    };
  };

  /** Сводка mapping для ответа API (без PEM). */
  const mappingView = (mapping: TlsMappingSettings) => ({
    id: mapping.id,
    hosts: [...mapping.hosts],
    ...(mapping.label !== undefined ? { label: mapping.label } : {}),
    certSubject: certificateSubjectFromFile(mapping.certFile),
    source: 'runtime' as const,
    readOnly: false,
  });

  const viewJson = (view: TlsView) => ({
    status: view.status,
    // Плоская форма (по стилю `/settings/proxy`) — те же поля статуса.
    ...view.status,
    saved: view.saved,
    running: view.running,
    defaults: view.defaults,
    restartRequired: view.restartRequired,
  });

  // ── GET: статус (без секретов) ────────────────────────────────────────────
  app.get('/', auth.requireAuth, (c) => {
    const dataDir = requireDataDir();
    if (!dataDir) {
      // Без dataDir runtime-настроек нет — отдаём только config/env-статус.
      return c.json(viewJson(viewFor(undefined)));
    }
    try {
      return c.json(viewJson(viewFor(readRuntime(dataDir))));
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `security-tls.json: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        400,
      );
    }
  });

  // ── PUT: несекретные поля (CA-путь/PEM, rejectUnauthorized) ───────────────
  app.put('/', writeGuard, async (c) => {
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { tls?: unknown }).tls;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'tls: ожидается объект { caFile?, caPem?, rejectUnauthorized? }' } }, 400);
    }
    const patch = raw as Record<string, unknown>;
    const unknownField = Object.keys(patch).find(
      (key) => key !== 'caFile' && key !== 'caPem' && key !== 'rejectUnauthorized',
    );
    if (unknownField !== undefined) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `tls.${unknownField}: неизвестное поле (сертификаты/ключи задаются отдельными эндпоинтами)` } }, 400);
    }
    if (patch.caFile !== undefined && (typeof patch.caFile !== 'string' || patch.caFile.trim() === '')) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'tls.caFile: ожидается непустой путь' } }, 400);
    }
    if (patch.caPem !== undefined && (typeof patch.caPem !== 'string' || patch.caPem.trim() === '')) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'tls.caPem: ожидается непустой PEM-бандл' } }, 400);
    }
    if (patch.caFile !== undefined && patch.caPem !== undefined) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: "tls: 'caFile' и 'caPem' взаимоисключащи" } }, 400);
    }
    if (typeof patch.caPem === 'string') {
      try {
        validateCaPem(patch.caPem);
      } catch (err) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
      }
    }
    if (patch.rejectUnauthorized !== undefined && typeof patch.rejectUnauthorized !== 'boolean') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'tls.rejectUnauthorized: ожидается boolean' } }, 400);
    }

    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const next: TlsRuntimeSettings = { ...(before ?? {}) };
    if (typeof patch.caFile === 'string') {
      next.caFile = patch.caFile.trim();
      delete next.caPem;
    }
    if (typeof patch.caPem === 'string') {
      next.caPem = patch.caPem;
      delete next.caFile;
    }
    if (typeof patch.rejectUnauthorized === 'boolean') {
      next.rejectUnauthorized = patch.rejectUnauthorized;
    }

    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'update', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({ status: statusFor(next), restartRequired: true });
  });

  // ── CA: загрузка/удаление runtime-CA ──────────────────────────────────────
  app.put('/ca', writeGuard, async (c) => {
    if (envCaConfigured()) {
      return c.json({
        error: {
          code: 'CONFLICT',
          message: `${TLS_ENV.caFile}/${TLS_ENV.caPem} задан в окружении — CA управляется деплоем и read-only`,
        },
      }, 409);
    }
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    const body = await c.req.json().catch(() => ({}));
    const pem = (body as { pem?: unknown }).pem;
    if (typeof pem !== 'string' || pem.trim() === '') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'pem: ожидается непустой PEM-бандл (1+ сертификатов)' } }, 400);
    }
    try {
      validateCaPem(pem);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }

    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const caFile = await writeTlsSecretFile(dataDir, 'ca.pem', pem);
    const next: TlsRuntimeSettings = { ...(before ?? {}), caFile };
    delete next.caPem;
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'update', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({ status: statusFor(next), restartRequired: true });
  });

  app.delete('/ca', writeGuard, async (c) => {
    if (envCaConfigured()) {
      return c.json({
        error: {
          code: 'CONFLICT',
          message: `${TLS_ENV.caFile}/${TLS_ENV.caPem} задан в окружении — CA управляется деплоем и read-only`,
        },
      }, 409);
    }
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const next: TlsRuntimeSettings = { ...(before ?? {}) };
    delete next.caFile;
    delete next.caPem;
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await removeMaterial(dataDir, 'ca.pem', before?.caFile);
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'reset', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({ status: statusFor(next), restartRequired: true });
  });

  // ── Default client (mTLS) ─────────────────────────────────────────────────
  app.put('/client', writeGuard, async (c) => {
    const readOnly = defaultClientReadOnly();
    if (typeof readOnly === 'object') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: readOnly.error } }, 400);
    }
    if (readOnly) {
      return c.json({
        error: {
          code: 'CONFLICT',
          message: 'default client задан через env/config — он read-only; переопределение возможно только per-host mapping\'ом',
        },
      }, 409);
    }
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    const body = await c.req.json().catch(() => ({}));
    const certPem = (body as { certPem?: unknown }).certPem;
    const keyPem = (body as { keyPem?: unknown }).keyPem;
    if (typeof certPem !== 'string' || typeof keyPem !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'certPem и keyPem: ожидаются PEM-строки' } }, 400);
    }
    try {
      validateClientPem(certPem, keyPem);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }

    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const certFile = await writeTlsSecretFile(dataDir, 'client.crt', certPem);
    const keyFile = await writeTlsSecretFile(dataDir, 'client.key', keyPem);
    const next: TlsRuntimeSettings = { ...(before ?? {}), defaultClient: { certFile, keyFile } };
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'update', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({ status: statusFor(next), restartRequired: true });
  });

  app.delete('/client', writeGuard, async (c) => {
    const readOnly = defaultClientReadOnly();
    if (typeof readOnly === 'object') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: readOnly.error } }, 400);
    }
    if (readOnly) {
      return c.json({
        error: {
          code: 'CONFLICT',
          message: 'default client задан через env/config — он read-only; удаление из UI невозможно',
        },
      }, 409);
    }
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const next: TlsRuntimeSettings = { ...(before ?? {}) };
    const old = next.defaultClient;
    delete next.defaultClient;
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    if (old) {
      await removeMaterial(dataDir, 'client.crt', old.certFile);
      await removeMaterial(dataDir, 'client.key', old.keyFile);
    }
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'reset', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({ status: statusFor(next), restartRequired: true });
  });

  // ── Per-host mappings (разрешены всегда) ──────────────────────────────────
  app.post('/mappings', writeGuard, async (c) => {
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    const body = await c.req.json().catch(() => ({}));
    const hostsResult = normalizeHosts((body as { hosts?: unknown }).hosts);
    if (hostsResult.error !== undefined || hostsResult.hosts === undefined) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: hostsResult.error ?? 'hosts: невалидны' } }, 400);
    }
    const certPem = (body as { certPem?: unknown }).certPem;
    const keyPem = (body as { keyPem?: unknown }).keyPem;
    if (typeof certPem !== 'string' || typeof keyPem !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'certPem и keyPem: ожидаются PEM-строки' } }, 400);
    }
    try {
      validateClientPem(certPem, keyPem);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const labelRaw = (body as { label?: unknown }).label;
    if (labelRaw !== undefined && labelRaw !== null && typeof labelRaw !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'label: ожидается строка' } }, 400);
    }

    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const existing = before?.mappings ?? [];
    let id = `m_${generateId()}`;
    while (existing.some((mapping) => mapping.id === id)) id = `m_${generateId()}`;

    const certFile = await writeTlsSecretFile(dataDir, `${id}.crt`, certPem);
    const keyFile = await writeTlsSecretFile(dataDir, `${id}.key`, keyPem);
    const mapping: TlsMappingSettings = {
      id,
      hosts: hostsResult.hosts,
      certFile,
      keyFile,
      ...(typeof labelRaw === 'string' && labelRaw.trim() !== '' ? { label: labelRaw.trim() } : {}),
    };
    const next: TlsRuntimeSettings = { ...(before ?? {}), mappings: [...existing, mapping] };
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'update', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({
      mapping: mappingView(mapping),
      status: statusFor(next),
      restartRequired: true,
    });
  });

  app.put('/mappings/:id', writeGuard, async (c) => {
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    const id = c.req.param('id');
    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const existing = before?.mappings ?? [];
    const index = existing.findIndex((mapping) => mapping.id === id);
    if (index < 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: `mapping "${id}" не найден` } }, 404);
    }
    const current = existing[index]!;

    const body = await c.req.json().catch(() => ({}));
    const patch = body as Record<string, unknown>;

    let hosts = current.hosts;
    if (patch.hosts !== undefined) {
      const hostsResult = normalizeHosts(patch.hosts);
      if (hostsResult.error !== undefined || hostsResult.hosts === undefined) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: hostsResult.error ?? 'hosts: невалидны' } }, 400);
      }
      hosts = hostsResult.hosts;
    }

    let label: string | undefined = current.label;
    if (patch.label !== undefined) {
      if (patch.label === null || patch.label === '') {
        label = undefined;
      } else if (typeof patch.label === 'string') {
        label = patch.label.trim() === '' ? undefined : patch.label.trim();
      } else {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'label: ожидается строка или null' } }, 400);
      }
    }

    let certFile = current.certFile;
    let keyFile = current.keyFile;
    const hasCert = patch.certPem !== undefined;
    const hasKey = patch.keyPem !== undefined;
    if (hasCert !== hasKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'certPem и keyPem: задайте оба либо ни одного' } }, 400);
    }
    if (hasCert && hasKey) {
      if (typeof patch.certPem !== 'string' || typeof patch.keyPem !== 'string') {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'certPem и keyPem: ожидаются PEM-строки' } }, 400);
      }
      try {
        validateClientPem(patch.certPem, patch.keyPem);
      } catch (err) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
      }
      certFile = await writeTlsSecretFile(dataDir, `${id}.crt`, patch.certPem);
      keyFile = await writeTlsSecretFile(dataDir, `${id}.key`, patch.keyPem);
    }

    const updated: TlsMappingSettings = {
      id,
      hosts,
      certFile,
      keyFile,
      ...(label !== undefined ? { label } : {}),
    };
    const mappings = [...existing];
    mappings[index] = updated;
    const next: TlsRuntimeSettings = { ...(before ?? {}), mappings };
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'update', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({
      mapping: mappingView(updated),
      status: statusFor(next),
      restartRequired: true,
    });
  });

  app.delete('/mappings/:id', writeGuard, async (c) => {
    const dataDir = requireDataDir();
    if (!dataDir) {
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'dataDir не задан — настройки TLS недоступны' } }, 500);
    }
    const id = c.req.param('id');
    let before: TlsRuntimeSettings | undefined;
    try {
      before = readRuntime(dataDir);
    } catch (err) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : String(err) } }, 400);
    }
    const existing = before?.mappings ?? [];
    const mapping = existing.find((item) => item.id === id);
    if (!mapping) {
      return c.json({ error: { code: 'NOT_FOUND', message: `mapping "${id}" не найден` } }, 404);
    }
    const next: TlsRuntimeSettings = {
      ...(before ?? {}),
      mappings: existing.filter((item) => item.id !== id),
    };
    const invalid = validateMerged(next);
    if (invalid) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: invalid } }, 400);
    }
    await removeMaterial(dataDir, `${id}.crt`, mapping.certFile);
    await removeMaterial(dataDir, `${id}.key`, mapping.keyFile);
    await writeTlsRuntimeSettings(dataDir, next);
    await auditTls(c, 'reset', sanitizeForAudit(before), sanitizeForAudit(next));
    return c.json({ status: statusFor(next), restartRequired: true });
  });

  // ── Валидация без записи ──────────────────────────────────────────────────
  app.post('/validate', auth.requireAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = body as {
      caPem?: unknown;
      certPem?: unknown;
      keyPem?: unknown;
      hosts?: unknown;
    };
    const errors: string[] = [];
    let caCount: number | undefined;
    let caSubjects: string[] | undefined;
    let certSubject: string | undefined;
    let keyMatches: boolean | undefined;
    let hostPatternsValid: boolean | undefined;

    if (input.caPem !== undefined) {
      if (typeof input.caPem !== 'string') {
        errors.push('caPem: ожидается PEM-строка');
      } else {
        try {
          const parsed = validateCaPem(input.caPem);
          caCount = parsed.count;
          caSubjects = parsed.subjects;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    const hasCert = input.certPem !== undefined;
    const hasKey = input.keyPem !== undefined;
    if (hasCert || hasKey) {
      if (!hasCert || !hasKey) {
        errors.push('certPem и keyPem: задайте оба либо ни одного');
        keyMatches = false;
      } else if (typeof input.certPem !== 'string' || typeof input.keyPem !== 'string') {
        errors.push('certPem и keyPem: ожидаются PEM-строки');
        keyMatches = false;
      } else {
        try {
          const parsed = validateClientPem(input.certPem, input.keyPem);
          certSubject = parsed.certSubject;
          keyMatches = true;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
          keyMatches = false;
          certSubject = certificateSubjectFromPem(input.certPem);
        }
      }
    }

    if (input.hosts !== undefined) {
      const hostsResult = normalizeHosts(input.hosts);
      if (hostsResult.error !== undefined) {
        hostPatternsValid = false;
        errors.push(hostsResult.error);
      } else {
        hostPatternsValid = true;
      }
    }

    return c.json({
      ok: errors.length === 0,
      ...(caCount !== undefined ? { caCount } : {}),
      ...(caSubjects !== undefined ? { caSubjects } : {}),
      ...(certSubject !== undefined ? { certSubject } : {}),
      ...(keyMatches !== undefined ? { keyMatches } : {}),
      ...(hostPatternsValid !== undefined ? { hostPatternsValid } : {}),
      errors,
    });
  });

  return app;
}
