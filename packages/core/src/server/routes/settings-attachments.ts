/**
 * ADR-115: админ-раздел «Вложения» — runtime-настройки мультимодального ввода.
 *
 * Контракт (согласован с UI):
 * - `GET    /api/v2/settings/attachments` — эффективные настройки, дефолты,
 *   сохранённый runtime-патч (`saved`), источник, env-зафиксированные поля,
 *   live-значение;
 * - `PUT    /api/v2/settings/attachments` `{attachments: AttachmentsRuntimeSettings}`
 *   — runtime-override (применяется **сразу**, без рестарта); в
 *   `modalityModels` значение `null` снимает запись семейства;
 * - `DELETE /api/v2/settings/attachments` — сброс runtime к env/config/default.
 *
 * Приоритет эффективного значения: env > runtime (`settings.json`/PG) >
 * config.yaml `attachments` > defaults. Поля, заданные env, попадают в
 * `envLocked` и не перезаписываются runtime; попытка задать их другим
 * значением → 409 `CONFLICT`. `restartRequired` — всегда `false`: сервис
 * вложений, промпт и GC читают резолвер на каждый вызов.
 *
 * `modalityModels` (ADR-115) — модели обработки по семействам вложений: до
 * записи проверяются по каталогу (провайдер + модель + известные модальности
 * модели), иначе `400 VALIDATION_ERROR`; частичных сохранений нет.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  ATTACHMENT_FAMILIES,
  generateId,
  nowISO,
  type AttachmentFamily,
  type AttachmentsConfig,
  type ModelConfig,
  type ProviderConfig,
} from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import type { DocumentRepository } from '../../storage/ports/document-repository.js';
import {
  resolveAttachmentsSettings,
  type AttachmentsRuntimeSettings,
  type AttachmentsSettings,
  type LiveAttachmentsSettings,
  type ModalityModelsRuntimePatch,
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
  'modalityModels',
  'gcDays',
]);

const MODALITY_KEYS = ATTACHMENT_FAMILIES;

/**
 * Результат проверки модели в каталоге (ADR-115).
 *
 * `modalities` не задано/пусто — модальности модели **неизвестны**: настройка
 * aux-модели бессмысленна (нельзя понять, принимает ли она семейство),
 * поэтому `PUT` отвечает 400 и просит синхронизировать каталог.
 */
export type ModalityModelCatalogEntry =
  | { found: false; reason: 'provider' | 'model' }
  | { found: true; modalities?: readonly string[] };

/** Проверка «провайдер + модель» по каталогу (ADR-115). */
export type ModalityModelLookup = (
  provider: string,
  model: string,
) => Promise<ModalityModelCatalogEntry>;

/**
 * Собрать проверку каталога для `modalityModels` из портов «провайдеры» и
 * «модели» (ключ модели — `<provider>/<model>`, как у модели по умолчанию).
 * Одна реализация на core и backend — правила не разъедутся.
 */
export function createModalityModelLookup(stores: {
  providers: DocumentRepository<ProviderConfig>;
  models: DocumentRepository<ModelConfig>;
}): ModalityModelLookup {
  return async (provider, model) => {
    const providerConfig = await stores.providers.load(provider);
    if (!providerConfig) return { found: false, reason: 'provider' };
    const modelConfig = await stores.models.load(`${provider}/${model}`);
    if (!modelConfig) return { found: false, reason: 'model' };
    return { found: true, modalities: modelConfig.modalities };
  };
}

/** Что модель заявляет (для текста ошибки; пусто — ничего). */
function describeModalities(modalities: readonly string[]): string {
  return modalities.length > 0 ? modalities.join(', ') : 'ничего не заявлено';
}

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
  /**
   * Каталог моделей/провайдеров для проверки `modalityModels` (ADR-115).
   * Не передан — проверка пропускается (урезанные сборки/тесты).
   */
  lookupModel?: ModalityModelLookup;
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

/**
 * Дефолтное сообщение об ошибке валидации: причина **всегда** включается —
 * без неё админ не поймёт, какое поле и почему отклонено (в частности,
 * несовместимая aux-модель в `modalityModels`).
 */
const DEFAULT_INVALID_SETTINGS = (detail: string) => `attachments: ${detail}`;
const DEFAULT_ENV_LOCKED = (field: string) =>
  `attachments.${field}: задано через переменную окружения — изменение из UI недоступно`;

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface AttachmentsSettingsView {
  /** Эффективные настройки (env > runtime > config > defaults). */
  attachments: AttachmentsSettings;
  /** База без runtime и env (к чему вернёт `DELETE`). */
  defaults: AttachmentsSettings;
  /**
   * Сохранённый runtime-патч как есть (ADR-115): `null` в `modalityModels` —
   * снятая настройка семейства. `{}` — runtime-значения нет.
   */
  saved: AttachmentsRuntimeSettings;
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
): { ok: true; value: AttachmentsRuntimeSettings } | { ok: false; detail: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'ожидается объект настроек' };
  }
  const source = value as Record<string, unknown>;
  const result: AttachmentsRuntimeSettings = {};

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
          modalities[modality as AttachmentFamily] = enabled;
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
      case 'modalityModels': {
        if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
          return {
            ok: false,
            detail: `modalityModels: ожидается объект {${ATTACHMENT_FAMILIES.join(',')}}`,
          };
        }
        const assignments: ModalityModelsRuntimePatch = {};
        for (const [family, entry] of Object.entries(rawValue as Record<string, unknown>)) {
          if (!(ATTACHMENT_FAMILIES as readonly string[]).includes(family)) {
            return {
              ok: false,
              detail: `modalityModels.${family}: неизвестная модальность (ожидается ${ATTACHMENT_FAMILIES.join('|')})`,
            };
          }
          const familyKey = family as AttachmentFamily;
          // `null` — снять настройку семейства (ADR-115).
          if (entry === null) {
            assignments[familyKey] = null;
            continue;
          }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return {
              ok: false,
              detail: `modalityModels.${family}: ожидается {provider, model} или null`,
            };
          }
          const rawProvider = (entry as { provider?: unknown }).provider;
          const rawModel = (entry as { model?: unknown }).model;
          // Пустой объект — эквивалент `null` («обработка не настроена»).
          if (rawProvider === undefined && rawModel === undefined) {
            assignments[familyKey] = null;
            continue;
          }
          const provider = typeof rawProvider === 'string' ? rawProvider.trim() : '';
          const model = typeof rawModel === 'string' ? rawModel.trim() : '';
          if (!provider || !model) {
            return {
              ok: false,
              detail: `modalityModels.${family}: ожидаются непустые provider и model (или null для удаления)`,
            };
          }
          assignments[familyKey] = { provider, model };
        }
        result.modalityModels = assignments;
        break;
      }
    }
  }

  return { ok: true, value: result };
}

/**
 * Проверить назначения aux-моделей по каталогу (ADR-115).
 *
 * Возвращает текст ошибки (что именно не так: модальность, модель, какие
 * модальности у неё заявлены) или `undefined`. Частичных сохранений нет —
 * вызов идёт **до** записи runtime-патча.
 */
async function validateModalityModels(
  patch: ModalityModelsRuntimePatch,
  lookup: ModalityModelLookup,
): Promise<string | undefined> {
  for (const family of ATTACHMENT_FAMILIES) {
    if (!(family in patch)) continue;
    const ref = patch[family];
    if (!ref) continue; // null — снятие настройки, проверять нечего

    const entry = await lookup(ref.provider, ref.model);
    if (!entry.found) {
      return entry.reason === 'provider'
        ? `modalityModels.${family}: провайдер "${ref.provider}" не найден в каталоге`
        : `modalityModels.${family}: модель "${ref.provider}/${ref.model}" не найдена в каталоге`;
    }

    const modalities = entry.modalities ?? [];
    if (modalities.length === 0) {
      return (
        `modalityModels.${family}: у модели "${ref.provider}/${ref.model}" неизвестны модальности — ` +
        'сначала синхронизируйте каталог (POST /api/v2/models/fetch) и повторите: без этого нельзя проверить, ' +
        `принимает ли модель модальность ${family}`
      );
    }
    if (!modalities.includes(family)) {
      return (
        `modalityModels.${family}: модель "${ref.provider}/${ref.model}" не принимает модальность ${family} ` +
        `(заявленные модальности: ${describeModalities(modalities)})`
      );
    }
  }
  return undefined;
}

/**
 * Первое поле патча, заданное через env с другим значением (→ 409).
 * Сравнение — по эффективному значению (env уже применён).
 */
function findEnvConflict(
  patch: AttachmentsRuntimeSettings,
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
    ((_c: Context, detail: string) => DEFAULT_INVALID_SETTINGS(detail));
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
      saved: runtime,
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

    // ADR-115: `modalityModels` проверяется по каталогу **до** записи —
    // несовместимая aux-модель не должна сохраняться (частичных патчей нет).
    if (deps.lookupModel) {
      const detail = await validateModalityModels(
        parsed.value.modalityModels ?? {},
        deps.lookupModel,
      );
      if (detail) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: invalidSettings(c, detail) } },
          400,
        );
      }
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
