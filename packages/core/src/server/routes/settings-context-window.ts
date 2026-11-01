/**
 * Админ-раздел «Контекстное окно» — instance-wide политика
 * `context.windowPolicy` (`off` | `warn` | `enforce`).
 *
 * Контракт (согласован с UI):
 * - `GET    /api/v2/settings/context-window` — эффективная политика, дефолт,
 *   сохранённое runtime-значение, источник, env-фиксация;
 * - `PUT    /api/v2/settings/context-window` `{policy}` — runtime-override
 *   (применяется **сразу**: оркестратор читает резолвер перед каждым
 *   LLM-вызовом);
 * - `DELETE /api/v2/settings/context-window` — сброс runtime к env/config/default.
 *
 * Приоритет эффективного значения: env `SYNTH_CONTEXT_WINDOW_POLICY` > runtime
 * (`settings.json`/PG) > config.yaml `context.windowPolicy` > default `warn`.
 * При env-значении runtime заблокирован: попытка задать другое значение →
 * 409 `CONFLICT`. `restartRequired` — всегда `false`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  CONTEXT_WINDOW_POLICIES,
  generateId,
  nowISO,
  type ContextWindowPolicy,
} from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  DEFAULT_CONTEXT_WINDOW_POLICY,
  resolveContextWindowPolicy,
  type LiveContextWindowPolicy,
  type ResolvedContextWindowPolicy,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости фабрики. */
export interface ContextWindowSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Значение `context.windowPolicy` из config.yaml (без runtime). */
  config?: ContextWindowPolicy;
  /**
   * Живое состояние политики процесса (тот же экземпляр, что читает
   * оркестратор): после PUT/DELETE обновляется без рестарта.
   */
  live?: LiveContextWindowPolicy;
  /** Аудит изменений политики (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
  /** Env (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface ContextWindowSettingsMessages {
  invalidPolicy?: (c: Context, detail: string) => string;
  envLocked?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface ContextWindowSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: ContextWindowSettingsMessages;
}

const DEFAULT_INVALID_POLICY = (detail: string) => `context.windowPolicy: ${detail}`;
const DEFAULT_ENV_LOCKED = () =>
  'context.windowPolicy: задано через переменную окружения — изменение из UI недоступно';

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface ContextWindowSettingsView {
  /** Эффективная политика (env > runtime > config > default). */
  policy: ContextWindowPolicy;
  /** Сохранённое runtime-значение (`null` — runtime-значение не задано). */
  saved: ContextWindowPolicy | null;
  /** База без runtime и env (к чему вернёт `DELETE`). */
  defaults: ContextWindowPolicy;
  source: ResolvedContextWindowPolicy['source'];
  /** Политика зафиксирована env-переменной (runtime её не перекрывает). */
  envLocked: boolean;
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

/** Проверка значения политики (400 при неизвестном). */
function isContextWindowPolicy(value: unknown): value is ContextWindowPolicy {
  return typeof value === 'string'
    && (CONTEXT_WINDOW_POLICIES as readonly string[]).includes(value);
}

/**
 * Фабрика роутов `/api/v2/settings/context-window`.
 * `auth.requireAuth` — обязательный guard по умолчанию.
 */
export function createContextWindowSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: ContextWindowSettingsDeps,
  opts: ContextWindowSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidPolicy =
    opts.messages?.invalidPolicy ??
    ((_c: Context, detail: string) => DEFAULT_INVALID_POLICY(detail));
  const envLockedMessage =
    opts.messages?.envLocked ?? ((_c: Context) => DEFAULT_ENV_LOCKED());

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
        scope: 'context-window',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит политики контекстного окна не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Снимок: эффективное значение, база (без runtime/env), источник, envLocked. */
  const buildView = async (): Promise<ContextWindowSettingsView> => {
    const runtime = await deps.settingsStore.getContextWindowPolicy();
    const resolved = resolveContextWindowPolicy(deps.config, runtime, env);
    // `defaults` — база config.yaml (или дефолт схемы), без runtime и env.
    const defaults = resolveContextWindowPolicy(deps.config, undefined, {});
    return {
      policy: resolved.value,
      saved: runtime ?? null,
      defaults: defaults.value,
      source: resolved.source,
      envLocked: resolved.envLocked,
      restartRequired: false,
    };
  };

  app.get('/context-window', readGuard, async (c) => c.json(await buildView()));

  app.put('/context-window', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { policy?: unknown }).policy;
    if (!isContextWindowPolicy(raw)) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: invalidPolicy(c, `ожидается policy = ${CONTEXT_WINDOW_POLICIES.join('|')}`),
          },
        },
        400,
      );
    }

    const runtime = await deps.settingsStore.getContextWindowPolicy();
    const before = resolveContextWindowPolicy(deps.config, runtime, env);

    // Политика задана env — runtime её не перекрывает (env приоритетнее).
    if (before.envLocked && raw !== before.value) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    await deps.settingsStore.setContextWindowPolicy(raw);
    deps.live?.setRuntime(raw);

    const view = await buildView();
    await audit(c, 'update', before.value, view.policy);
    return c.json(view);
  });

  app.delete('/context-window', writeGuard, async (c) => {
    const runtime = await deps.settingsStore.getContextWindowPolicy();
    const before = resolveContextWindowPolicy(deps.config, runtime, env);

    await deps.settingsStore.clearContextWindowPolicy();
    deps.live?.setRuntime(undefined);

    const view = await buildView();
    await audit(c, 'reset', before.value, null);
    return c.json(view);
  });

  return app;
}

// Дефолт схемы нужен UI/тестам без конфига — реэкспорт из одного места.
export { DEFAULT_CONTEXT_WINDOW_POLICY };
