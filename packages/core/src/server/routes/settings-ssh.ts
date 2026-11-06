/**
 * PROP-124: режим работы инстанса с SSH-ключами (`ssh.mode`).
 *
 * Контракт:
 * - `GET    /api/v2/settings/ssh` — эффективный режим, сохранённое runtime-
 *   значение, база (config/default), источник, признак env-фиксации;
 * - `PUT    /api/v2/settings/ssh` `{mode: 'tools'|'agent'}` — runtime-override,
 *   применяется **сразу** (без рестарта);
 * - `DELETE /api/v2/settings/ssh` — сброс runtime к env/config/default.
 *
 * Приоритет эффективного значения: env `SYNTH_SSH_MODE` > runtime
 * (`settings.json`/PG) > config.yaml `ssh.mode` > `tools`. При env-значении
 * runtime заблокирован → 409 `CONFLICT`. Невалидный env — конфигурационная
 * ошибка (fail-closed, как у `SYNTH_EXECUTION_MODE`): инстанс с такой
 * переменной не поднимается.
 *
 * Режим выбирает администратор инстанса (ADR-076 + PROP-124): `tools` — адресные
 * тулы с обязательной политикой хостов/портов, `agent` — эфемерный `ssh-agent`
 * на время вызова (политика по хостам не применяется).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { generateId, nowISO, SSH_MODES } from '@itphx/synth-shared';
import type { SshMode } from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  resolveSshMode,
  type LiveSshMode,
  type ResolvedSshMode,
} from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Зависимости фабрики. */
export interface SshSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Значение `ssh.mode` из config.yaml (без runtime). */
  config?: SshMode;
  /**
   * Живое состояние режима процесса: после PUT/DELETE обновляется без рестарта.
   */
  live?: LiveSshMode;
  /** Аудит изменений (best-effort). */
  securityAudit?: SecurityAuditRepository;
  /** Актор (id пользователя) для записей аудита. */
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
  /** Env (для env-фиксации значения). */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface SshSettingsMessages {
  invalidMode?: (c: Context, detail: string) => string;
  envLocked?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface SshSettingsOptions {
  /** Guard чтения; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию — `auth.requireAuth`. Managed — ADMIN. */
  writeGuard?: Middleware;
  messages?: SshSettingsMessages;
}

/** Ответ GET/PUT/DELETE — контракт с UI. */
export interface SshSettingsView {
  /** Эффективный режим инстанса. */
  mode: SshMode;
  /** Сохранённое runtime-значение (`null` — не задано). */
  saved: SshMode | null;
  /** База без runtime (к чему вернёт `DELETE`). */
  defaults: SshMode;
  /** Источник эффективного значения. */
  source: ResolvedSshMode['source'];
  /** Режим зафиксирован env — runtime из UI не перекрывается. */
  envLocked: boolean;
  /** Применяется сразу — рестарт не требуется. */
  restartRequired: false;
}

const DEFAULT_INVALID_MODE = (detail: string) => `ssh.mode: ${detail}`;
const DEFAULT_ENV_LOCKED = () =>
  'ssh.mode: задано через переменную окружения — изменение из UI недоступно';

/**
 * Невалидный `SYNTH_SSH_MODE` — конфигурационная ошибка (fail-closed).
 *
 * Инстанс с такой переменной не поднимается (проверка на старте), поэтому
 * ветка защитная: отвечаем 500 с понятным текстом, а не молча отдаём дефолт.
 */
function configError(c: Context, err: unknown): Response {
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    },
    500,
  );
}

/** `true`, если значение — канонический режим инстанса. */
function isSshMode(value: unknown): value is SshMode {
  return typeof value === 'string' && (SSH_MODES as readonly string[]).includes(value);
}

/**
 * Фабрика роутов `/api/v2/settings/ssh`.
 * `auth.requireAuth` — обязательный guard по умолчанию.
 */
export function createSshSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: SshSettingsDeps,
  opts: SshSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidMode =
    opts.messages?.invalidMode ?? ((_c: Context, detail: string) => DEFAULT_INVALID_MODE(detail));
  const envLockedMessage = opts.messages?.envLocked ?? ((_c: Context) => DEFAULT_ENV_LOCKED());

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
        scope: 'ssh',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит режима SSH не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /** Снимок: эффективный режим, runtime-значение, база без runtime, источник. */
  const buildView = async (): Promise<SshSettingsView> => {
    const runtime = await deps.settingsStore.getSshMode();
    const resolved = resolveSshMode(deps.config, runtime, env);
    const defaults = resolveSshMode(deps.config, undefined, {}).value;
    return {
      mode: resolved.value,
      saved: runtime ?? null,
      defaults,
      source: resolved.source,
      envLocked: resolved.envLocked,
      restartRequired: false,
    };
  };

  app.get('/ssh', readGuard, async (c) => {
    try {
      return c.json(await buildView());
    } catch (err) {
      return configError(c, err);
    }
  });

  app.put('/ssh', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { mode?: unknown }).mode;
    if (!isSshMode(raw)) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: invalidMode(c, `ожидается ${SSH_MODES.join('|')}`),
          },
        },
        400,
      );
    }

    try {
      const runtime = await deps.settingsStore.getSshMode();
      const before = resolveSshMode(deps.config, runtime, env);
      if (before.envLocked && raw !== before.value) {
        return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
      }

      await deps.settingsStore.setSshMode(raw);
      deps.live?.setRuntime(raw);

      const view = await buildView();
      await audit(c, 'update', before.value, view.mode);
      return c.json(view);
    } catch (err) {
      return configError(c, err);
    }
  });

  app.delete('/ssh', writeGuard, async (c) => {
    try {
      const before = resolveSshMode(
        deps.config,
        await deps.settingsStore.getSshMode(),
        env,
      );

      await deps.settingsStore.clearSshMode();
      deps.live?.setRuntime(undefined);

      const view = await buildView();
      await audit(c, 'reset', before.value, null);
      return c.json(view);
    } catch (err) {
      return configError(c, err);
    }
  });

  return app;
}
