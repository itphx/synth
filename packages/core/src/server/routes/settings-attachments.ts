/**
 * ADR-115: админ-раздел «Вложения» — runtime-настройки мультимодального ввода.
 *
 * Контракт (согласован с UI):
 * - `GET    /api/v2/settings/attachments` — эффективные настройки, дефолты,
 *   источник, env-зафиксированные поля, live-значение;
 * - `PUT    /api/v2/settings/attachments` `{attachments: Partial<AttachmentsSettings>}`
 *   — runtime-override (применяется **сразу**, без рестарта);
 * - `DELETE /api/v2/settings/attachments` — сброс runtime к env/config/default.
 *
 * Приоритет эффективного значения: env > runtime (`settings.json`/PG) >
 * config.yaml `attachments` > defaults. Поля, заданные env, попадают в
 * `envLocked` и не перезаписываются runtime; попытка задать их другим
 * значением → 409 `CONFLICT`. `restartRequired` — всегда `false`: сервис
 * вложений, промпт и GC читают резолвер на каждый вызов.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { generateId, nowISO, type AttachmentsConfig } from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  resolveAttachmentsSettings,
  type AttachmentsSettings,
  type LiveAttachmentsSettings,
  type ResolvedAttachmentsSettings,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Известные поля секции `attachments` (неизвестные ключи PUT игнорируются). */
const SETTINGS_KEYS = new Set<keyof AttachmentsSettings>([
  'enabled',
  'modalities',
  'maxBytesPerFile',
  'maxFilesPerMessage',
  'maxBytesPerSession',
  'allowedMimePrefixes',
  'workspaceFallback',
  'gcDays',
]);

const MODALITY_KEYS = ['image', 'pdf', 'audio', 'video'] as const;

/** Зависимости фабрики. */
export interface AttachmentsSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Секция `attachments` из config.yaml (без runtime). */
  config?: Partial<AttachmentsConfig>;
  /**
   * Живое состояние настроек процесса (тот же экземпляр, что у сервиса
   * вложений и pruner'а): после PUT/DELETE обновляется без рестарта.
   */
  live?: LiveAttachmentsSettings;
  /** Аудит изменений настроек (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
  /** Env (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface AttachmentsSettingsMessages {
  invalidSettings?: (c: Context, detail: string) => string;
  envLocked?: (c: Context, field: string) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface AttachmentsSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: AttachmentsSettingsMessages;
}

const DEFAULT_INVALID_SETTINGS = 'attachments: некорректные настройки';
const DEFAULT_ENV_LOCKED = (field: string) =>
  `attachments.${field}: задано через переменную окружения — изменение из UI недоступно`;

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface AttachmentsSettingsView {
  attachments: AttachmentsSettings;
  defaults: AttachmentsSettings;
  isOverridden: boolean;
  source: ResolvedAttachmentsSettings['source'];
  envLocked: string[];
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
  running: AttachmentsSettings;
}

/** Разбор PUT-тела: частичный патч секции `attachments`. */
function validateAttachmentsSettings(
  value: unknown,
): { ok: true; value: Partial<AttachmentsSettings> } | { ok: false; detail: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'ожидается объект настроек' };
  }
  const source = value as Record<string, unknown>;
  const result: Partial<AttachmentsSettings> = {};

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey as keyof AttachmentsSettings;
    if (!SETTINGS_KEYS.has(key)) continue; // неизвестные ключи игнорируем (как у событий)

    switch (key) {
      case 'enabled':
      case 'workspaceFallback':
        if (typeof rawValue !== 'boolean') return { ok: false, detail: `${rawKey}: ожидается boolean` };
        result[key] = rawValue;
        break;
      case 'modalities': {
        if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
          return { ok: false, detail: 'modalities: ожидается объект {image,pdf,audio,video}' };
        }
        const modalities: Partial<AttachmentsSettings['modalities']> = {};
        for (const [modality, enabled] of Object.entries(rawValue as Record<string, unknown>)) {
          if (!(MODALITY_KEYS as readonly string[]).includes(modality)) continue;
          if (typeof enabled !== 'boolean') {
            return { ok: false, detail: `modalities.${modality}: ожидается boolean` };
          }
          modalities[modality as (typeof MODALITY_KEYS)[number]] = enabled;
        }
        result.modalities = modalities as AttachmentsSettings['modalities'];
        break;
      }
      case 'maxBytesPerFile':
      case 'maxFilesPerMessage':
      case 'maxBytesPerSession':
        if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 1) {
          return { ok: false, detail: `${rawKey}: ожидается целое > 0` };
        }
        result[key] = rawValue;
        break;
      case 'gcDays':
        if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 0) {
          return { ok: false, detail: 'gcDays: ожидается целое ≥ 0' };
        }
        result.gcDays = rawValue;
        break;
      case 'allowedMimePrefixes': {
        if (!Array.isArray(rawValue)) {
          return { ok: false, detail: 'allowedMimePrefixes: ожидается массив строк' };
        }
        const prefixes: string[] = [];
        for (const entry of rawValue) {
          if (typeof entry !== 'string' || entry.trim() === '') {
            return { ok: false, detail: 'allowedMimePrefixes: элементы — непустые строки' };
          }
          prefixes.push(entry.trim());
        }
        result.allowedMimePrefixes = prefixes;
        break;
      }
    }
  }

  return { ok: true, value: result };
}

/**
 * Первое поле патча, заданное через env с другим значением (→ 409).
 * Сравнение — по эффективному значению (env уже применён).
 */
function findEnvConflict(
  patch: Partial<AttachmentsSettings>,
  resolved: ResolvedAttachmentsSettings,
): string | undefined {
  const locked = new Set(resolved.envLocked);
  for (const key of Object.keys(patch) as Array<keyof AttachmentsSettings>) {
    if (!locked.has(key)) continue;
    if (JSON.stringify(patch[key]) !== JSON.stringify(resolved.effective[key])) return key;
  }
  return undefined;
}

/**
 * Фабрика роутов `/api/v2/settings/attachments`.
 * `auth.requireAuth` — обязательный guard по умолчанию.
 */
export function createAttachmentsSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: AttachmentsSettingsDeps,
  opts: AttachmentsSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidSettings =
    opts.messages?.invalidSettings ??
    (() => DEFAULT_INVALID_SETTINGS);
  const envLockedMessage =
    opts.messages?.envLocked ??
    ((_c: Context, field: string) => DEFAULT_ENV_LOCKED(field));

  /** Актор изменения (id пользователя; core без RBAC — `local`). */
  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

  /** Best-effort аудит изменения политики: ошибка записи не ломает операцию. */
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
        scope: 'attachments',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит настроек вложений не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Снимок: эффект, дефолты (без runtime и env), источник, envLocked, running. */
  const buildView = async (): Promise<AttachmentsSettingsView> => {
    const runtime = await deps.settingsStore.getAttachments();
    const resolved = resolveAttachmentsSettings({ config: deps.config, runtime, env });
    // `defaults` — база config.yaml (или схема), без runtime и без env: так UI
    // показывает, к чему вернётся настройка после сброса и что зафиксировано env.
    const defaults = resolveAttachmentsSettings({ config: deps.config, runtime: {}, env: {} });
    return {
      attachments: resolved.effective,
      defaults: defaults.effective,
      isOverridden: Object.keys(runtime).length > 0,
      source: resolved.source,
      envLocked: resolved.envLocked,
      // ADR-115: применяется сразу — рестарт не нужен.
      restartRequired: false,
      running: resolved.effective,
    };
  };

  app.get('/attachments', readGuard, async (c) => c.json(await buildView()));

  app.put('/attachments', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = validateAttachmentsSettings((body as { attachments?: unknown }).attachments);
    if (!parsed.ok) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: invalidSettings(c, parsed.detail) } },
        400,
      );
    }

    const runtime = await deps.settingsStore.getAttachments();
    const before = resolveAttachmentsSettings({ config: deps.config, runtime, env });

    // Поле, заданное env, не перезаписывается runtime (env приоритетнее).
    const conflict = findEnvConflict(parsed.value, before);
    if (conflict) {
      return c.json(
        { error: { code: 'CONFLICT', message: envLockedMessage(c, conflict) } },
        409,
      );
    }

    await deps.settingsStore.setAttachments(parsed.value);
    deps.live?.setRuntime(parsed.value);

    const view = await buildView();
    await audit(c, 'update', before.effective, view.attachments);
    return c.json(view);
  });

  app.delete('/attachments', writeGuard, async (c) => {
    const runtime = await deps.settingsStore.getAttachments();
    const before = resolveAttachmentsSettings({ config: deps.config, runtime, env });

    await deps.settingsStore.clearAttachments();
    deps.live?.setRuntime({});

    const view = await buildView();
    await audit(c, 'reset', before.effective, null);
    return c.json(view);
  });

  return app;
}
