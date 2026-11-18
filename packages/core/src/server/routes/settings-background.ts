/**
 * Этап 1 roadmap 0.13 (блок 4): настройки секции `background` (единый реестр
 * фоновых прогонов) — `/api/v2/settings/background`.
 *
 * Контракт:
 * - `GET    /api/v2/settings/background` — эффективные значения секции
 *   (`enabled`, `maxSubagentsPerSession`, `maxProcessesPerSession`,
 *   `maxRunsPerSession`, `logMaxBytes`, `retentionDays`), источник по каждому
 *   полю (`sources`) и общий (`source`), сохранённый runtime-патч (`saved`),
 *   база без runtime (`defaults`), env-фиксация (`envLocked` + `envLockedFields`);
 * - `PUT    /api/v2/settings/background` `{…частичный патч…}` — runtime-override
 *   (**частичное** обновление), применяется **сразу**: сервисы реестра и
 *   процессов читают лимиты на каждый запуск, pruner'ы — retention на каждом
 *   тике; рестарт не нужен (`restartRequired: false`);
 * - `DELETE /api/v2/settings/background` — сброс runtime всех полей к
 *   env/config/default.
 *
 * ## Приоритет
 *
 * У каждого поля **свой** слой: env (`SYNTH_BACKGROUND_*`) > runtime
 * (`settings.json`/PG) > config.yaml `background.*` > дефолт схемы
 * (ADR-023). Env-фиксация проверяется **по полю**: зафиксированное env
 * значение блокирует только свою настройку (`PUT {enabled}` не блокируется
 * фиксацией `retentionDays`).
 *
 * ## Коды ошибок
 *
 * - `400 VALIDATION_ERROR` — неизвестный ключ, неверный тип/границы
 *   (лимиты и `logMaxBytes` — целые ≥ 0; `enabled` — boolean;
 *   `retentionDays` — любое целое, `<= 0` — «без ограничения»);
 * - `409 ENV_LOCKED` с `fields: BackgroundSettingsField[]` — поле
 *   зафиксировано env; **ни одно** поле запроса при этом не применяется
 *   (частичный отказ не оставляет «половину» изменений).
 *
 * Образец — `settings-terminal.ts`/`settings-limits.ts`; общий код 409 для
 * env-фиксации в проекте — `ENV_LOCKED` (см. `settings-terminal.ts`).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { BackgroundConfig } from '@itphx/synth-shared/config';
import { generateId, nowISO } from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  BACKGROUND_SETTINGS_FIELDS,
  resolveBackgroundConfig,
  type BackgroundRuntimeSettings,
  type BackgroundSettingsField,
  type BackgroundSettingsSource,
  type LiveBackgroundSettings,
  type ResolvedBackgroundConfig,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости фабрики. */
export interface BackgroundSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Секция `background` из config.yaml (без runtime; может быть частичной). */
  config?: Partial<BackgroundConfig>;
  /** Живое состояние (тот же экземпляр, что у сервисов и pruner'ов). */
  live?: LiveBackgroundSettings;
  /** Аудит изменений (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
  /** Env (для env-фиксации значения). */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface BackgroundSettingsMessages {
  /** Общее сообщение валидации поля (`field` — имя поля запроса). */
  invalidField?: (c: Context, field: BackgroundSettingsField) => string;
  envLocked?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface BackgroundSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: BackgroundSettingsMessages;
}

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface BackgroundSettingsView {
  enabled: boolean;
  maxSubagentsPerSession: number;
  maxProcessesPerSession: number;
  maxRunsPerSession: number;
  logMaxBytes: number;
  retentionDays: number;
  /** Сохранённый runtime-патч (`null` — не задан). */
  saved: BackgroundRuntimeSettings | null;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: BackgroundConfig;
  /** Источник эффективных значений — наиболее специфичный слой среди полей. */
  source: BackgroundSettingsSource;
  /** Источник **каждого** поля секции. */
  sources: Record<BackgroundSettingsField, BackgroundSettingsSource>;
  /** Env зафиксировал хотя бы одно из значений (runtime его не перекрывает). */
  envLocked: boolean;
  /** Поля, зафиксированные env: из UI они `disabled` и не уходят в `PUT`. */
  envLockedFields: BackgroundSettingsField[];
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

const DEFAULT_INVALID_FIELD = (_c: Context, field: BackgroundSettingsField): string =>
  `background.${field}: некорректное значение`;
const DEFAULT_ENV_LOCKED = (): string =>
  'background: задано через переменную окружения — изменение из UI недоступно';

/** Разбор патча: либо валидное частичное обновление, либо ошибка валидации. */
type ParsedPatch =
  | { ok: true; patch: BackgroundRuntimeSettings; fields: BackgroundSettingsField[] }
  | { ok: false; field: BackgroundSettingsField | null; unknownKey: string | null };

/** Известно ли поле секции. */
function isSettingsField(value: string): value is BackgroundSettingsField {
  return (BACKGROUND_SETTINGS_FIELDS as readonly string[]).includes(value);
}

/**
 * Валидация значения поля.
 *
 * Лимиты и `logMaxBytes` — целые ≥ 0 (`0` — «без ограничения»);
 * `retentionDays` — любое целое (`<= 0` — «без ограничения»); `enabled` —
 * boolean. Дробные/строки/`null` отклоняются.
 */
function isValidFieldValue(field: BackgroundSettingsField, value: unknown): boolean {
  if (field === 'enabled') return typeof value === 'boolean';
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return false;
  }
  return field === 'retentionDays' ? true : value >= 0;
}

/**
 * Фабрика роутов `/api/v2/settings/background`.
 * `auth.requireAuth` — обязательный guard по умолчанию (core, single-user);
 * managed backend передаёт `requirePermission('ADMIN')`.
 */
export function createBackgroundSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: BackgroundSettingsDeps,
  opts: BackgroundSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidField = opts.messages?.invalidField ?? DEFAULT_INVALID_FIELD;
  const envLockedMessage = opts.messages?.envLocked ?? ((_c: Context) => DEFAULT_ENV_LOCKED());

  /** Эффективные значения секции по runtime-снимку (config + env — из deps). */
  const resolveWith = (runtime: BackgroundRuntimeSettings): ResolvedBackgroundConfig =>
    resolveBackgroundConfig({
      ...(deps.config !== undefined ? { config: deps.config } : {}),
      runtime,
      env,
    });

  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

  /** Best-effort аудит изменения: ошибка записи не ломает операцию. */
  const audit = async (
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
        scope: 'background',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит настроек фоновых прогонов не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Снимок: эффективные значения, источники, база без runtime, env-фиксация. */
  const buildView = async (): Promise<BackgroundSettingsView> => {
    const runtime = await deps.settingsStore.getBackground();
    const resolved = resolveWith(runtime);
    const saved =
      Object.keys(runtime).length > 0 ? { ...runtime } : null;
    return {
      enabled: resolved.effective.enabled,
      maxSubagentsPerSession: resolved.effective.maxSubagentsPerSession,
      maxProcessesPerSession: resolved.effective.maxProcessesPerSession,
      maxRunsPerSession: resolved.effective.maxRunsPerSession,
      logMaxBytes: resolved.effective.logMaxBytes,
      retentionDays: resolved.effective.retentionDays,
      saved,
      defaults: resolved.defaults,
      source: resolved.source,
      sources: resolved.sources,
      envLocked: resolved.envLocked,
      envLockedFields: resolved.envLockedFields,
      restartRequired: false,
    };
  };

  /** Разобрать тело PUT: только известные поля, строгие типы и границы. */
  const parsePatch = (body: unknown): ParsedPatch => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ok: false, field: null, unknownKey: null };
    }
    const raw = body as Record<string, unknown>;
    const keys = Object.keys(raw);
    // Неизвестные ключи запрещены: иначе опечатка (`maxRunsPerSessoin`) молча
    // не применялась бы, а ответ выглядел бы успешным.
    for (const key of keys) {
      if (!isSettingsField(key)) return { ok: false, field: null, unknownKey: key };
    }
    if (keys.length === 0) return { ok: false, field: null, unknownKey: null };

    const patch: BackgroundRuntimeSettings = {};
    const fields: BackgroundSettingsField[] = [];
    for (const key of keys) {
      const field = key as BackgroundSettingsField;
      const value = raw[key];
      if (!isValidFieldValue(field, value)) return { ok: false, field, unknownKey: null };
      (patch as Record<string, unknown>)[field] = value;
      fields.push(field);
    }
    return { ok: true, patch, fields };
  };

  app.get('/background', readGuard, async (c) => c.json(await buildView()));

  app.put('/background', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = parsePatch(body);
    if (!parsed.ok) {
      const message =
        parsed.unknownKey !== null
          ? `background: неизвестное поле "${parsed.unknownKey}"`
          : parsed.field !== null
            ? invalidField(c, parsed.field)
            : 'background: ожидается объект с полями настроек';
      return c.json({ error: { code: 'VALIDATION_ERROR', message } }, 400);
    }

    const runtime = await deps.settingsStore.getBackground();
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
    // пишется целиком, поэтому мержим с текущим значением).
    const merged: BackgroundRuntimeSettings = { ...runtime, ...parsed.patch };
    await deps.settingsStore.setBackground(merged);
    deps.live?.setRuntime(merged);

    const view = await buildView();
    await audit(c, 'update', before.effective, resolveWith(merged).effective);
    return c.json(view);
  });

  app.delete('/background', writeGuard, async (c) => {
    const runtime = await deps.settingsStore.getBackground();
    const before = resolveWith(runtime);

    // Сброс runtime: env-зафиксированные поля продолжат действовать (env
    // приоритетнее), остальные вернутся к config/default — частичного отказа
    // здесь не нужно, как и у `settings-limits`.
    await deps.settingsStore.clearBackground();
    deps.live?.setRuntime(undefined);

    const view = await buildView();
    await audit(c, 'reset', before.effective, null);
    return c.json(view);
  });

  return app;
}
