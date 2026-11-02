/**
 * Админ-раздел «Пределы саб-агентов» — instance-wide runtime-настройка
 * `agents.subagentMaxInputTokens` (предохранитель объёма промпта саб-агента).
 *
 * Контракт:
 * - `GET    /api/v2/settings/agents-limits` — эффективное значение, сохранённое
 *   runtime, база (config/default), источник, env-фиксация;
 * - `PUT    /api/v2/settings/agents-limits` `{subagentMaxInputTokens: number}` —
 *   runtime-override (целое ≥ 0; `0` — без лимита), применяется к следующим
 *   прогонам без рестарта;
 * - `DELETE /api/v2/settings/agents-limits` — сброс runtime к env/config/default.
 *
 * Приоритет: env `SYNTH_AGENTS_SUBAGENT_MAX_INPUT_TOKENS` > runtime
 * (`settings.json`/PG) > config.yaml `agents.subagentMaxInputTokens` > `0`.
 * При env-значении runtime заблокирован → 409 `CONFLICT`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { generateId, nowISO } from '@itphx/synth-shared';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import type { SecurityAuditRepository } from '../../storage/ports/security-audit-repository.js';
import {
  resolveSubagentMaxInputTokens,
  type LiveSubagentMaxInputTokens,
  type ResolvedSubagentMaxInputTokens,
} from '../../storage/runtime-settings.js';

type Middleware = ReturnType<typeof createMiddleware>;

export interface AgentsLimitsSettingsDeps {
  settingsStore: SettingsRepository;
  /** `agents.subagentMaxInputTokens` из config.yaml (без runtime). */
  config?: number;
  /** Живое состояние (тот же экземпляр, что у оркестратора). */
  live?: LiveSubagentMaxInputTokens;
  securityAudit?: SecurityAuditRepository;
  resolveActor?: (c: { get(key: 'user'): unknown }) => string;
  env?: NodeJS.ProcessEnv;
}

export interface AgentsLimitsSettingsMessages {
  invalidValue?: (c: Context, detail: string) => string;
  envLocked?: (c: Context) => string;
}

export interface AgentsLimitsSettingsOptions {
  readGuard?: Middleware;
  writeGuard?: Middleware;
  messages?: AgentsLimitsSettingsMessages;
}

export interface AgentsLimitsSettingsView {
  subagentMaxInputTokens: number;
  saved: number | null;
  defaults: number;
  source: ResolvedSubagentMaxInputTokens['source'];
  envLocked: boolean;
  restartRequired: false;
}

const DEFAULT_INVALID_VALUE = (detail: string) => `agents.subagentMaxInputTokens: ${detail}`;
const DEFAULT_ENV_LOCKED = () =>
  'agents.subagentMaxInputTokens: задано через переменную окружения — изменение из UI недоступно';

/** Целое ≥ 0 (0 — без лимита; -1/дробное отклоняются). */
function isTokenLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function createAgentsLimitsSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: AgentsLimitsSettingsDeps,
  opts: AgentsLimitsSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidValue =
    opts.messages?.invalidValue ?? ((_c: Context, detail: string) => DEFAULT_INVALID_VALUE(detail));
  const envLockedMessage = opts.messages?.envLocked ?? ((_c: Context) => DEFAULT_ENV_LOCKED());

  const actorOf = (c: { get(key: 'user'): unknown }): string => {
    if (deps.resolveActor) return deps.resolveActor(c);
    const user = c.get('user') as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : 'local';
  };

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
        scope: 'agents',
        action,
        source: 'runtime',
        before,
        after,
        version: 1,
      });
    } catch (err) {
      console.warn(
        `[settings] аудит бюджета саб-агентов не записан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const buildView = async (): Promise<AgentsLimitsSettingsView> => {
    const runtime = await deps.settingsStore.getSubagentMaxInputTokens();
    const resolved = resolveSubagentMaxInputTokens(deps.config, runtime, env);
    const defaults = resolveSubagentMaxInputTokens(deps.config, undefined, {});
    return {
      subagentMaxInputTokens: resolved.value,
      saved: runtime ?? null,
      defaults: defaults.value,
      source: resolved.source,
      envLocked: resolved.envLocked,
      restartRequired: false,
    };
  };

  app.get('/agents-limits', readGuard, async (c) => c.json(await buildView()));

  app.put('/agents-limits', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = (body as { subagentMaxInputTokens?: unknown }).subagentMaxInputTokens;
    if (!isTokenLimit(raw)) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: invalidValue(c, 'ожидается целое число ≥ 0 (0 — без лимита)'),
          },
        },
        400,
      );
    }

    const runtime = await deps.settingsStore.getSubagentMaxInputTokens();
    const before = resolveSubagentMaxInputTokens(deps.config, runtime, env);
    if (before.envLocked && raw !== before.value) {
      return c.json({ error: { code: 'CONFLICT', message: envLockedMessage(c) } }, 409);
    }

    await deps.settingsStore.setSubagentMaxInputTokens(raw);
    deps.live?.setRuntime(raw);

    const view = await buildView();
    await audit(c, 'update', before.value, view.subagentMaxInputTokens);
    return c.json(view);
  });

  app.delete('/agents-limits', writeGuard, async (c) => {
    const runtime = await deps.settingsStore.getSubagentMaxInputTokens();
    const before = resolveSubagentMaxInputTokens(deps.config, runtime, env);

    await deps.settingsStore.clearSubagentMaxInputTokens();
    deps.live?.setRuntime(undefined);

    const view = await buildView();
    await audit(c, 'reset', before.value, null);
    return c.json(view);
  });

  return app;
}
