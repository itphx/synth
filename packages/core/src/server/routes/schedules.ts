import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { scheduleInputSchema } from '@itphx/synth-shared';
import type { ScheduleInputRequest } from '@itphx/synth-shared';
import type { ScheduleStore } from '../../storage/schedule-store.js';
import type { JobStore } from '../../storage/job-store.js';
import type { SchedulerService } from '../../engine/scheduler/scheduler.js';
import { isValidCron } from '../../engine/scheduler/cron.js';
import { parseDurationMs } from '../../engine/scheduler/duration.js';
import { requireScope, checkProjectAccess } from '../service-scope.js';
import type { ScopeGuardFactory, ProjectGuard } from '../service-scope.js';

/**
 * ADR-051 (минимальный срез) / ADR-089: маршруты управления расписаниями
 * планировщика. Единая реализация для core (standalone) и backend (managed):
 * RBAC задаётся через `opts.writeGuard`, локализация — через `opts.messages`.
 */

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface SchedulerRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface SchedulerRouteMessages {
  invalidSchedule: (c: Context) => string;
  scheduleNotFound: (c: Context) => string;
}

export interface SchedulerRoutesDeps {
  scheduleStore: ScheduleStore;
  scheduler: SchedulerService;
  /** История срабатываний (ADR-051); без неё `GET /:id/jobs` отдаёт `[]`. */
  jobStore?: JobStore;
}

export interface SchedulerRoutesOptions {
  messages?: Partial<SchedulerRouteMessages>;
  /** Guard на мутации; по умолчанию — `requireAuth` (backend: requireAdmin). */
  writeGuard?: Middleware;
  /** Guard на `POST /:id/run`; по умолчанию — `writeGuard`. */
  runGuard?: Middleware;
  /** Дополнительные middleware на `POST /:id/run` (rate limit и т.п.). */
  runMiddleware?: Middleware[];
  /**
   * ADR-052 (этап I): фабрика scope-guard'а для service-key. По умолчанию —
   * `requireScope` из core (нет service-key в контексте → пропускает).
   */
  scopeGuard?: ScopeGuardFactory;
  /**
   * ADR-052 (этап I): гейт проектной проекции. По умолчанию — `checkProjectAccess`.
   */
  projectGuard?: ProjectGuard;
  /**
   * ADR-052: резолвер `sessionId` → `projectId` цели расписания (`bound`/`queue`).
   * Проект `ephemeral`-цели берётся из `target.project`. Не задан — проектный
   * гейт для session-целей пропускается.
   */
  resolveSessionProject?: (sessionId: string) => Promise<string | undefined>;
}

const DEFAULT_MESSAGES: SchedulerRouteMessages = {
  invalidSchedule: () => 'Некорректное тело расписания',
  scheduleNotFound: () => 'Расписание не найдено',
};

/** Семантическая проверка триггера (cron/interval) вне Zod-схемы. */
function validateTrigger(input: ScheduleInputRequest): string | null {
  if (input.cron && input.cron.trim() && !isValidCron(input.cron)) {
    return `Некорректное cron-выражение: "${input.cron}"`;
  }
  if (input.every && input.every.trim()) {
    try {
      parseDurationMs(input.every);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}

/**
 * ADR-051 / ADR-089: CRUD расписаний + принудительный запуск + Job-история.
 *
 * `GET /` — список; `POST /` — создание; `PUT /:id` — обновление;
 * `DELETE /:id` — удаление; `POST /:id/run` — принудительный ingest события
 * через `SchedulerService.runNow` (всегда force, в т.ч. для выключенного
 * расписания); `GET /:id/jobs` — история срабатываний (`jobStore`).
 */
export function createSchedulerRoutes(
  auth: SchedulerRoutesAuth,
  deps: SchedulerRoutesDeps,
  opts: SchedulerRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: SchedulerRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const runGuard: Middleware = opts.runGuard ?? writeGuard;
  // ADR-052 (этап I): scope-гейты service-key и проектная проекция цели.
  const scoped = opts.scopeGuard ?? requireScope;
  const projectGuard = opts.projectGuard ?? checkProjectAccess;

  /** projectId цели расписания (ephemeral — сам target, bound/queue — сессия). */
  const projectForTarget = async (
    target: ScheduleInputRequest['target'],
  ): Promise<string | undefined> =>
    target.mode === 'ephemeral'
      ? target.project
      : opts.resolveSessionProject
        ? await opts.resolveSessionProject(target.sessionId)
        : undefined;

  const invalid = (c: Context, message?: string) =>
    c.json(
      { error: { code: 'VALIDATION_ERROR', message: message ?? messages.invalidSchedule(c) } },
      400,
    );

  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.scheduleNotFound(c) } }, 404);

  // GET /api/v2/schedules — список расписаний.
  app.get('/', auth.requireAuth, scoped('schedules:read'), async (c) => {
    return c.json({ schedules: await deps.scheduler.list() });
  });

  // POST /api/v2/schedules — создание расписания.
  app.post('/', writeGuard, scoped('schedules:write'), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }

    const parsed = scheduleInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const triggerError = validateTrigger(parsed.data);
    if (triggerError) return invalid(c, triggerError);

    // ADR-052: проектная проекция — цель расписания адресует проект/сессию.
    const denied = projectGuard(c, await projectForTarget(parsed.data.target));
    if (denied) return denied;

    const created = await deps.scheduleStore.create(parsed.data);
    const schedule = await deps.scheduler.refreshNextRun(created.id);
    return c.json({ schedule: schedule ?? created }, 201);
  });

  // PUT /api/v2/schedules/:id — обновление расписания.
  app.put('/:id', writeGuard, scoped('schedules:write'), async (c) => {
    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return invalid(c);
    }

    const parsed = scheduleInputSchema.safeParse(body);
    if (!parsed.success) return invalid(c);

    const triggerError = validateTrigger(parsed.data);
    if (triggerError) return invalid(c, triggerError);

    // ADR-052: проектная проекция — цель расписания адресует проект/сессию.
    const denied = projectGuard(c, await projectForTarget(parsed.data.target));
    if (denied) return denied;

    const updated = await deps.scheduleStore.update(id, parsed.data);
    if (!updated) return notFound(c);

    const schedule = await deps.scheduler.refreshNextRun(id);
    return c.json({ schedule: schedule ?? updated });
  });

  // DELETE /api/v2/schedules/:id — удаление расписания.
  app.delete('/:id', writeGuard, scoped('schedules:write'), async (c) => {
    const removed = await deps.scheduleStore.remove(c.req.param('id'));
    if (!removed) return notFound(c);
    return c.body(null, 204);
  });

  // GET /api/v2/schedules/:id/jobs — история срабатываний (ADR-051).
  app.get('/:id/jobs', auth.requireAuth, scoped('schedules:read'), async (c) => {
    const id = c.req.param('id');
    const schedule = await deps.scheduleStore.get(id);
    if (!schedule) return notFound(c);

    if (!deps.jobStore) return c.json({ jobs: [] });

    const rawLimit = c.req.query('limit');
    const parsed = rawLimit !== undefined ? Number(rawLimit) : Number.NaN;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 200) : 20;
    const jobs = await deps.jobStore.list({ scheduleId: id, limit });
    return c.json({ jobs });
  });

  // POST /api/v2/schedules/:id/run — принудительный запуск (force, в т.ч.
  // выключенного расписания). `runMiddleware` — дополнительный слой (rate limit).
  app.post('/:id/run', runGuard, scoped('schedules:write'), ...(opts.runMiddleware ?? []), async (c) => {
    const id = c.req.param('id');
    // ADR-052: проектная проекция — цель существующего расписания.
    const existing = await deps.scheduleStore.get(id);
    if (!existing) return notFound(c);
    const denied = projectGuard(c, await projectForTarget(existing.target));
    if (denied) return denied;

    const schedule = await deps.scheduler.runNow(id);
    if (!schedule) return notFound(c);
    return c.json({ schedule });
  });

  return app;
}
