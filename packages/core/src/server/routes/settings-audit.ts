/**
 * Настройки журнала **решений по подтверждениям прав** (`scope:'permission'`
 * security-аудита) — `/api/v2/settings/audit`.
 *
 * Контракт:
 * - `GET    /api/v2/settings/audit` — эффективные значения секции
 *   (`permission.mode`/`permission.retentionDays`), источник по каждому полю
 *   (`sources`) и общий (`source`), база без runtime (`defaults`), env-фиксация
 *   (`envLocked` + список полей `envLockedFields`);
 * - `PUT    /api/v2/settings/audit` `{permission?: {mode?, retentionDays?}}` —
 *   runtime-override (**частичное** обновление: незаданное поле сохраняется),
 *   применяется **сразу** (`refresh()` живого состояния + retention-прогон
 *   журнала, рестарт не нужен);
 * - `DELETE /api/v2/settings/audit` — сброс runtime-секции к env/дефолту с тем
 *   же живым применением.
 *
 * ## Приоритет
 *
 * У каждого поля **свой** слой: env > runtime (`settings.json`/PG) > дефолт.
 * Секции в `config.yaml` нет (решение владельца), поэтому слоя `config` в
 * `sources` не бывает. Env-фиксация проверяется **по полю**: зафиксированный
 * `SYNTH_AUDIT_PERMISSION_MODE` блокирует только `mode` (`PUT
 * {permission:{retentionDays}}` проходит).
 *
 * ## Коды ошибок
 *
 * - `400 VALIDATION_ERROR` — неизвестный ключ, неверный тип, `mode` вне
 *   `decisions|all`, `retentionDays` вне `AUDIT_RETENTION_DAYS_RANGE`;
 * - `409 ENV_LOCKED` с `fields: AuditSettingsField[]` — поле зафиксировано
 *   env; **ни одно** поле запроса при этом не применяется (частичный отказ не
 *   оставляет «половину» изменений).
 *
 * ## Аудита правки нет
 *
 * Это настройка **самого** журнала решений: подходящего `scope` в
 * `SECURITY_AUDIT_SCOPES` нет, а расширять перечень ради одной настройки
 * нельзя — запись не создаётся (как у `PUT /settings/security`).
 *
 * Образец — `settings-terminal.ts`/`settings-background.ts`; правило
 * приоритета — в `storage/runtime-settings.ts` (`resolveAuditSettings` —
 * единственный источник истины и для этого роута, и для шва журнала).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  AUDIT_PERMISSION_MODES,
  AUDIT_RETENTION_DAYS_RANGE,
  AUDIT_SETTINGS_FIELDS,
  resolveAuditSettings,
  type AuditPermissionMode,
  type AuditPermissionRuntimeSettings,
  type AuditPermissionSettings,
  type AuditRuntimeSettings,
  type AuditSettingsField,
  type AuditSettingsSource,
  type LiveAuditSettings,
  type ResolvedAuditSettings,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости фабрики. */
export interface AuditSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /**
   * Живое состояние секции `audit` (тот же экземпляр, что читают шов журнала
   * решений и retention-прунер): после `PUT`/`DELETE` обновляется без рестарта.
   */
  live?: LiveAuditSettings;
  /**
   * Журнал security-аудита — только ради `prune(retentionDays)` (опциональный
   * метод порта, best-effort). Запись аудита правки не создаётся.
   */
  securityAudit?: SecurityAuditRepository;
  /** Env (для env-фиксации значения). */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface AuditSettingsMessages {
  /** Общее сообщение валидации поля (`field` — имя поля запроса). */
  invalidField?: (c: Context, field: AuditSettingsField) => string;
  envLocked?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface AuditSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: AuditSettingsMessages;
}

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface AuditSettingsView {
  /** Эффективные значения секции `audit.permission`. */
  permission: AuditPermissionSettings;
  /** Источник эффективных значений — наиболее специфичный слой среди полей. */
  source: AuditSettingsSource;
  /** Источник **каждого** поля секции. */
  sources: Record<AuditSettingsField, AuditSettingsSource>;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: AuditPermissionSettings;
  /** Env зафиксировал хотя бы одно из значений (runtime его не перекрывает). */
  envLocked: boolean;
  /** Поля, зафиксированные env: из UI они `disabled` и не уходят в `PUT`. */
  envLockedFields: AuditSettingsField[];
}

const DEFAULT_INVALID_FIELD = (_c: Context, field: AuditSettingsField): string =>
  `audit.permission.${field}: некорректное значение`;
const DEFAULT_ENV_LOCKED = (): string =>
  'audit.permission: задано через переменную окружения — изменение из UI недоступно';

/** Разбор патча: либо валидное частичное обновление, либо ошибка валидации. */
type ParsedPatch =
  | { ok: true; patch: AuditPermissionRuntimeSettings; fields: AuditSettingsField[] }
  | { ok: false; field: AuditSettingsField | null; unknownKey: string | null };

/** Известно ли поле секции. */
function isSettingsField(value: string): value is AuditSettingsField {
  return (AUDIT_SETTINGS_FIELDS as readonly string[]).includes(value);
}

/** Валидация `mode`: только канонические значения журнала решений. */
function isAuditPermissionMode(value: unknown): value is AuditPermissionMode {
  return typeof value === 'string' && (AUDIT_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Валидация `retentionDays`: целое в границах `AUDIT_RETENTION_DAYS_RANGE`
 * (дробные/строки/`null` отклоняются — «без ограничения» у журнала решений нет).
 */
function isRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= AUDIT_RETENTION_DAYS_RANGE.min
    && value <= AUDIT_RETENTION_DAYS_RANGE.max
  );
}

/**
 * Фабрика роутов `/api/v2/settings/audit`.
 * `auth.requireAuth` — обязательный guard по умолчанию (core, single-user);
 * managed backend передаёт `requirePermission('ADMIN')`.
 */
export function createAuditSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: AuditSettingsDeps,
  opts: AuditSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidField = opts.messages?.invalidField ?? DEFAULT_INVALID_FIELD;
  const envLockedMessage = opts.messages?.envLocked ?? ((_c: Context) => DEFAULT_ENV_LOCKED());

  /** Эффективные значения секции по runtime-снимку (env — из deps). */
  const resolveWith = (runtime: Partial<AuditRuntimeSettings>): ResolvedAuditSettings =>
    resolveAuditSettings({ runtime, env });

  /** Снимок ответа по результату резолвинга. */
  const viewOf = (resolved: ResolvedAuditSettings): AuditSettingsView => ({
    permission: resolved.effective,
    source: resolved.source,
    sources: resolved.sources,
    defaults: resolved.defaults,
    envLocked: resolved.envLocked,
    envLockedFields: resolved.envLockedFields,
  });

  /** Снимок из порта (persisted runtime — источник истины для `GET`). */
  const buildView = async (): Promise<AuditSettingsView> =>
    viewOf(resolveWith(await deps.settingsStore.getAudit()));

  /**
   * Retention-прогон журнала решений после смены настроек (best-effort).
   *
   * `prune` — опциональный метод порта (фейки могут его не иметь); ошибка
   * уборки не ломает применение настройки (как на старте инстанса).
   */
  const pruneJournal = async (retentionDays: number): Promise<void> => {
    const repo = deps.securityAudit;
    if (!repo || typeof repo.prune !== 'function') return;
    try {
      const removed = await repo.prune(retentionDays);
      if (removed > 0) {
        console.info(`[audit] retention журнала решений: удалено ${removed} записей`);
      }
    } catch (err) {
      console.warn(
        `[audit] retention журнала решений не выполнен: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Разобрать тело PUT: только известные поля, строгие типы и границы. */
  const parsePatch = (body: unknown): ParsedPatch => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, field: null, unknownKey: null };
    }
    const raw = (body as { permission?: unknown }).permission;
    if (raw === undefined) return { ok: false, field: null, unknownKey: null };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, field: null, unknownKey: null };
    }

    const fieldsRaw = raw as Record<string, unknown>;
    const keys = Object.keys(fieldsRaw);
    // Неизвестные ключи запрещены: иначе опечатка (`retentionDay`) молча не
    // применялась бы, а ответ выглядел бы успешным.
    for (const key of keys) {
      if (!isSettingsField(key)) return { ok: false, field: null, unknownKey: key };
    }
    if (keys.length === 0) return { ok: false, field: null, unknownKey: null };

    const patch: AuditPermissionRuntimeSettings = {};
    const fields: AuditSettingsField[] = [];
    for (const key of keys) {
      const field = key as AuditSettingsField;
      const value = fieldsRaw[key];
      if (field === 'mode') {
        if (!isAuditPermissionMode(value)) return { ok: false, field, unknownKey: null };
        patch.mode = value;
      } else {
        if (!isRetentionDays(value)) return { ok: false, field, unknownKey: null };
        patch.retentionDays = value;
      }
      fields.push(field);
    }
    return { ok: true, patch, fields };
  };

  app.get('/audit', readGuard, async (c) => c.json(await buildView()));

  app.put('/audit', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = parsePatch(body);
    if (!parsed.ok) {
      const message =
        parsed.unknownKey !== null
          ? `audit.permission: неизвестное поле "${parsed.unknownKey}"`
          : parsed.field !== null
            ? invalidField(c, parsed.field)
            : 'audit: ожидается объект `{ permission: { mode?, retentionDays? } }`';
      return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
    }

    const runtime = await deps.settingsStore.getAudit();
    const before = resolveWith(runtime);

    // Env-фиксация — **по полю**: отказ перечисляет все зафиксированные поля
    // запроса, и ничего не применяется (частичное изменение оставило бы UI с
    // «половиной» патча).
    const locked = parsed.fields.filter((field) => before.envLockedFields.includes(field));
    if (locked.length > 0) {
      return c.json(
        { error: { code: 'ENV_LOCKED', message: envLockedMessage(c), fields: locked } },
        409,
      );
    }

    // Runtime-override — **частичный**: незаданное поле сохраняется (секция
    // `audit.permission` пишется целиком, поэтому мержим с текущим значением).
    const merged: AuditRuntimeSettings = {
      ...runtime,
      permission: { ...(runtime.permission ?? {}), ...parsed.patch },
    };
    await deps.settingsStore.setAudit(merged);

    // Живое состояние: шов журнала читает его на каждое решение, прунер — на
    // каждом тике. Ставим записанный снимок (работает и без привязанного
    // store у `live`), затем перечитываем из порта — единственная асинхронная
    // точка чтения (`refresh()` fail-soft: ошибка хранилища оставляет снимок).
    deps.live?.setRuntime(merged);
    await deps.live?.refresh();

    // Новый retention применяем сразу: уборка журнала — best-effort.
    const after = resolveWith(merged);
    await pruneJournal(deps.live?.getRetentionDays() ?? after.effective.retentionDays);

    return c.json(await buildView());
  });

  app.delete('/audit', writeGuard, async (c) => {
    await deps.settingsStore.clearAudit();
    deps.live?.setRuntime(undefined);
    await deps.live?.refresh();

    return c.json(await buildView());
  });

  return app;
}
