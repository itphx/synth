/**
 * Админ-раздел «Заметки сессии» — instance-wide лимиты `context.stickyNotes`.
 *
 * Контракт (согласован с UI):
 * - `GET    /api/v2/settings/sticky-notes` — эффективные лимиты (runtime поверх
 *   config.yaml), сохранённый runtime-патч, источник;
 * - `PUT    /api/v2/settings/sticky-notes` `{limits: Partial<StickyNotesLimits>}`
 *   — runtime-override (мёржится поверх config; применяется **сразу**:
 *   core-фабрика сессий читает резолвер при каждой операции с заметкой);
 * - `DELETE /api/v2/settings/sticky-notes` — сброс runtime к config/default.
 *
 * Приоритет эффективного значения: runtime (`settings.json`/PG) > config.yaml
 * `context.stickyNotes` > default схемы. Это **ограничения инстанса**, а не
 * дефолты сессии: применяются ко всем сессиям; существующие заметки не
 * удаляются и не обрезаются.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  generateId,
  nowISO,
  patchObjectSchema,
  stickyNotesLimitsSchema,
  type StickyNotesLimits,
} from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  resolveStickyNotesLimits,
  type LiveStickyNotesLimits,
  type ResolvedStickyNotesLimits,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Схема частичного патча: ключи/границы из `stickyNotesLimitsSchema`, без дефолтов. */
const stickyNotesLimitsPatchSchema = patchObjectSchema(stickyNotesLimitsSchema).strict();

/** Зависимости фабрики. */
export interface StickyNotesSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Значение `context.stickyNotes` из config.yaml (без runtime). */
  config?: Partial<StickyNotesLimits>;
  /**
   * Живое состояние лимитов процесса (тот же экземпляр, что читает
   * core-фабрика сессий): после PUT/DELETE обновляется без рестарта.
   */
  live?: LiveStickyNotesLimits;
  /** Аудит изменений (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface StickyNotesSettingsMessages {
  invalidLimits?: (c: Context, detail: string) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface StickyNotesSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: StickyNotesSettingsMessages;
}

const DEFAULT_INVALID_LIMITS = (detail: string) => `context.stickyNotes: ${detail}`;

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface StickyNotesSettingsView {
  /** Эффективные лимиты (runtime > config > default). */
  limits: StickyNotesLimits;
  /** Сохранённый runtime-патч (`null` — runtime-значение не задано). */
  saved: Partial<StickyNotesLimits> | null;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: StickyNotesLimits;
  /** Источник эффективного значения. */
  source: ResolvedStickyNotesLimits['source'];
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

/**
 * Фабрика роутов `/api/v2/settings/sticky-notes`.
 * `auth.requireAuth` — обязательный guard по умолчанию.
 */
export function createStickyNotesSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: StickyNotesSettingsDeps,
  opts: StickyNotesSettingsOptions = {},
): Hono {
  const app = new Hono();
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidLimits =
    opts.messages?.invalidLimits ??
    ((_c: Context, detail: string) => DEFAULT_INVALID_LIMITS(detail));

  /** Актор изменения (id пользователя; core без RBAC — `local`). */
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
        scope: 'sticky-notes',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит лимитов заметок не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Снимок: эффективные значения, runtime-патч, база без runtime, источник. */
  const buildView = async (): Promise<StickyNotesSettingsView> => {
    const runtime = await deps.settingsStore.getStickyNotesLimits();
    const resolved = resolveStickyNotesLimits(deps.config, runtime);
    return {
      limits: resolved.value,
      saved: runtime ?? null,
      defaults: resolveStickyNotesLimits(deps.config, undefined).value,
      source: resolved.source,
      restartRequired: false,
    };
  };

  app.get('/sticky-notes', readGuard, async (c) => c.json(await buildView()));

  app.put('/sticky-notes', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { limits?: unknown }).limits;
    const parsed = stickyNotesLimitsPatchSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: invalidLimits(c, detail || 'ожидается объект с полями maxCount/maxChars'),
          },
        },
        400,
      );
    }

    // PUT — частичный патч: мержим поверх сохранённого runtime-значения.
    const current = (await deps.settingsStore.getStickyNotesLimits()) ?? {};
    const before = resolveStickyNotesLimits(deps.config, current);
    const next = { ...current, ...parsed.data } as Partial<StickyNotesLimits>;
    await deps.settingsStore.setStickyNotesLimits(next);
    deps.live?.setRuntime(next);

    const view = await buildView();
    await audit(c, 'update', before.value, view.limits);
    return c.json(view);
  });

  app.delete('/sticky-notes', writeGuard, async (c) => {
    const before = resolveStickyNotesLimits(
      deps.config,
      await deps.settingsStore.getStickyNotesLimits(),
    );

    await deps.settingsStore.clearStickyNotesLimits();
    deps.live?.setRuntime(undefined);

    const view = await buildView();
    await audit(c, 'reset', before.value, null);
    return c.json(view);
  });

  return app;
}
