import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { scheduleInputSchema, SERVICE_SCOPE_SETS } from '@itphx/synth-shared';
import type { ScheduleInputRequest, ScheduleRunStatus, ScheduleTarget } from '@itphx/synth-shared';
import type { ScheduleRepository } from '../../storage/ports/schedule-repository.js';
import type { JobRepository } from '../../storage/ports/job-repository.js';
import type { SchedulerService } from '../../engine/scheduler/scheduler.js';
import { isValidCron } from '../../engine/scheduler/cron.js';
import { parseDurationMs } from '../../engine/scheduler/duration.js';
import { requireScope, checkServiceProjectProjection } from '../service-scope.js';
import type { ScopeGuardFactory, ServiceProjectProjectionGuard } from '../service-scope.js';

/**
 * ADR-051 (минимальный срез) / ADR-089: маршруты управления расписаниями
 * планировщика. Единая реализация для core (standalone) и backend (managed):
 * локализация — через `opts.messages`, скоуп — через `opts.scopeGuard`.
 *
 * PROP-141 (этап 5, B-1): права — **по проекту расписания** (ADR-089 §5.5/§5.8):
 * чтение — `canReadProject`, мутации — `canEditProjectContent` (`VIEWER` читает,
 * но не мутирует — инвариант 21). Проверка — **на границе** через
 * `opts.authorizeProject`; скоуп списка — `opts.listVisibleProjectIds`.
 * Опции не заданы (core/standalone) — прежнее поведение: доступ не разграничен.
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
  /** Нет доступа к проекту расписания (граничная проверка). */
  projectForbidden: (c: Context) => string;
}

export interface SchedulerRoutesDeps {
  scheduleStore: ScheduleRepository;
  scheduler: SchedulerService;
  /** История срабатываний (ADR-051); без неё `GET /:id/jobs` отдаёт `[]`. */
  jobStore?: JobRepository;
}

export interface SchedulerRoutesOptions {
  messages?: Partial<SchedulerRouteMessages>;
  /** Guard на мутации; по умолчанию — `requireAuth` (managed — по правам проекта). */
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
   * ADR-052 (этап I): гейт **проектной проекции service-key**. По умолчанию —
   * `checkServiceProjectProjection` (нет service-key/`allowedProjects` → пропускает).
   * Это не RBAC.
   */
  serviceProjectProjection?: ServiceProjectProjectionGuard;
  /**
   * ADR-052: резолвер `sessionId` → `projectId` цели расписания (`bound`/`queue`).
   * Проект `ephemeral`-цели берётся из `target.project`, проект `pipeline`-цели
   * (ADR-101) — из `target.projectId`. Не задан — проектный гейт для
   * session-целей пропускается.
   */
  resolveSessionProject?: (sessionId: string) => Promise<string | undefined>;
  /**
   * PROP-141 (этап 5, B-1): **скоуп чтения списка** расписаний.
   *
   * Возвращает id проектов, видимых пользователю; `null` — «все» (managed:
   * `ADMIN`/`LEAD` — сквозной обзор; core/standalone — пользователь один).
   * Список ограничен этими проектами **и собственными** расписаниями
   * (`ownerId` совпадает с текущим пользователем) — чужие не раскрываются.
   *
   * Не задана — прежнее поведение (список всех расписаний инстанса).
   */
  listVisibleProjectIds?: (c: Context) => Promise<string[] | null>;
  /**
   * PROP-141 (этап 5, B-1): **проектный доступ на границе** (инвариант 16).
   *
   * - `read` — право чтения проекта (владелец/участник/`LEAD`/`ADMIN`);
   * - `write` — право изменения содержимого (`OWNER`/`EDITOR`/`LEAD`/`ADMIN`;
   *   `VIEWER` читает, но не мутирует — инвариант 21).
   *
   * Возвращает **готовый ответ** (403/404) или `null` — доступ разрешён.
   * Не задана — прежнее поведение (core/standalone: пользователь один, доступ
   * к проекту не разграничивается).
   */
  authorizeProject?: (
    c: Context,
    projectId: string,
    mode: 'read' | 'write',
  ) => Promise<Response | null>;
}

const DEFAULT_MESSAGES: SchedulerRouteMessages = {
  invalidSchedule: () => 'Некорректное тело расписания',
  scheduleNotFound: () => 'Расписание не найдено',
  projectForbidden: () => 'Нет доступа к проекту расписания',
};

/** Статусы последнего запуска — допустимые значения фильтра `status`. */
const SCHEDULE_RUN_STATUSES: readonly ScheduleRunStatus[] = ['ok', 'error', 'skipped'];

/** Фильтры списка расписаний (`GET /api/v2/schedules`). */
interface ScheduleListFilters {
  /** Цель `bound`/`queue` — id сессии. */
  sessionId?: string;
  /** Проект расписания. */
  projectId?: string;
  /** Включено/выключено. */
  enabled?: boolean;
  /** Статус последнего запуска. */
  status?: ScheduleRunStatus;
}

/** Сессия цели расписания (`bound`/`queue`); у `ephemeral`/`pipeline` — нет. */
function targetSessionId(target: ScheduleTarget): string | undefined {
  return target.mode === 'bound' || target.mode === 'queue' ? target.sessionId : undefined;
}

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
  const serviceProjectProjection = opts.serviceProjectProjection ?? checkServiceProjectProjection;

  /**
   * projectId цели расписания (проектная проекция service-key, ADR-052).
   * - `ephemeral` — сам target;
   * - `pipeline` (ADR-101) — проект-владелец пайплайна;
   * - `bound`/`queue` — проект сессии (`resolveSessionProject`).
   */
  const projectForTarget = async (
    target: ScheduleInputRequest['target'],
  ): Promise<string | undefined> => {
    if (target.mode === 'ephemeral') return target.project;
    if (target.mode === 'pipeline') return target.projectId;
    return opts.resolveSessionProject
      ? await opts.resolveSessionProject(target.sessionId)
      : undefined;
  };

  /**
   * PROP-141: проект расписания — **обязателен** (инстансных автоматизаций
   * нет, каждое расписание принадлежит проекту).
   *
   * Проект выводится из цели (`projectForTarget`); переданный в теле
   * `projectId`, если он есть, должен совпадать с выведенным — иначе цель и
   * проект противоречат друг другу. Вывести нельзя (сессия-цель вне проекта
   * или не найдена) — запись не создаётся: без проекта она всё равно не
   * срабатывала бы.
   */
  const resolveProjectId = async (
    input: ScheduleInputRequest,
  ): Promise<{ ok: true; projectId: string } | { ok: false; message: string }> => {
    const projectId = await projectForTarget(input.target);
    if (!projectId) {
      return { ok: false, message: 'Не удалось определить проект расписания по цели' };
    }
    if (input.projectId !== undefined && input.projectId !== projectId) {
      return { ok: false, message: 'Проект расписания не совпадает с проектом цели' };
    }
    return { ok: true, projectId };
  };

  const invalid = (c: Context, message?: string) =>
    c.json(
      { error: { code: 'VALIDATION_ERROR', message: message ?? messages.invalidSchedule(c) } },
      400,
    );

  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.scheduleNotFound(c) } }, 404);

  /**
   * Граничная проверка доступа к проекту расписания (инвариант 16):
   * возвращает готовый ответ (403/404) или `null` — доступ разрешён.
   *
   * Опция не задана — проверки нет (core/standalone: пользователь один).
   * Сбой проверки — **fail-closed** (403): исключение не должно превращаться
   * в разрешение.
   */
  const authorize = async (
    c: Context,
    projectId: string,
    mode: 'read' | 'write',
  ): Promise<Response | null> => {
    if (!opts.authorizeProject) return null;
    try {
      return await opts.authorizeProject(c, projectId, mode);
    } catch {
      return c.json(
        { error: { code: 'FORBIDDEN', message: messages.projectForbidden(c) } },
        403,
      );
    }
  };

  /** id текущего пользователя (для «своих» расписаний) — из контекста. */
  const currentUserId = (c: Context): string => {
    const user = c.get('user' as never) as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : '';
  };

  /**
   * Разбор query-фильтров списка (`GET /api/v2/schedules`).
   * Некорректное значение — 400 `VALIDATION_ERROR`.
   */
  const parseListFilters = (
    c: Context,
  ): { ok: true; filters: ScheduleListFilters } | { ok: false; message: string } => {
    const filters: ScheduleListFilters = {};

    const sessionId = c.req.query('sessionId');
    if (sessionId !== undefined) {
      const trimmed = sessionId.trim();
      if (!trimmed) return { ok: false, message: 'Некорректный фильтр sessionId' };
      filters.sessionId = trimmed;
    }

    const projectId = c.req.query('projectId');
    if (projectId !== undefined) {
      const trimmed = projectId.trim();
      if (!trimmed) return { ok: false, message: 'Некорректный фильтр projectId' };
      filters.projectId = trimmed;
    }

    const enabled = c.req.query('enabled');
    if (enabled !== undefined) {
      if (enabled === 'true' || enabled === '1') filters.enabled = true;
      else if (enabled === 'false' || enabled === '0') filters.enabled = false;
      else return { ok: false, message: 'Некорректный фильтр enabled (ожидается true/false)' };
    }

    const status = c.req.query('status');
    if (status !== undefined) {
      const found = SCHEDULE_RUN_STATUSES.find((value) => value === status);
      if (!found) {
        return {
          ok: false,
          message: `Некорректный фильтр status (ожидается ${SCHEDULE_RUN_STATUSES.join('/')})`,
        };
      }
      filters.status = found;
    }

    return { ok: true, filters };
  };

  // GET /api/v2/schedules — список расписаний.
  // Фильтры: `sessionId` (цель bound/queue), `projectId`, `enabled`, `status`.
  // Скоуп видимости (managed) — `listVisibleProjectIds`: проекты пользователя
  // + собственные расписания; чужие не раскрываются.
  app.get('/', auth.requireAuth, scoped('schedules:read'), async (c) => {
    const parsed = parseListFilters(c);
    if (!parsed.ok) return invalid(c, parsed.message);
    const filters = parsed.filters;

    let schedules = await deps.scheduler.list();

    // Скоуп видимости (PROP-141, managed): без опции — все расписания.
    if (opts.listVisibleProjectIds) {
      const visible = await opts.listVisibleProjectIds(c);
      if (visible) {
        const allowed = new Set(visible);
        const ownerId = currentUserId(c);
        schedules = schedules.filter(
          (schedule) =>
            (schedule.projectId !== '' && allowed.has(schedule.projectId))
            || (ownerId !== '' && schedule.ownerId === ownerId),
        );
      }
    }

    if (filters.sessionId !== undefined) {
      schedules = schedules.filter(
        (schedule) => targetSessionId(schedule.target) === filters.sessionId,
      );
    }
    if (filters.projectId !== undefined) {
      schedules = schedules.filter((schedule) => schedule.projectId === filters.projectId);
    }
    if (filters.enabled !== undefined) {
      schedules = schedules.filter((schedule) => schedule.enabled === filters.enabled);
    }
    if (filters.status !== undefined) {
      schedules = schedules.filter((schedule) => schedule.lastStatus === filters.status);
    }

    return c.json({ schedules });
  });

  // POST /api/v2/schedules — создание расписания.
  // ADR-052: зонтичный `automation:install` (установщик пакета) — альтернатива
  // `schedules:write` (достаточно любого из двух).
  app.post('/', writeGuard, scoped(...SERVICE_SCOPE_SETS.schedulesWrite), async (c) => {
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

    // PROP-141: проект расписания обязателен — выводится из цели.
    const project = await resolveProjectId(parsed.data);
    if (!project.ok) return invalid(c, project.message);

    // Граничная проверка прав на проект расписания (инвариант 16): право
    // изменения содержимого проекта (`VIEWER` не мутирует — инвариант 21).
    const deniedProject = await authorize(c, project.projectId, 'write');
    if (deniedProject) return deniedProject;

    // ADR-052: проектная проекция — цель расписания адресует проект/сессию.
    const denied = serviceProjectProjection(c, project.projectId);
    if (denied) return denied;

    const created = await deps.scheduleStore.create({
      ...parsed.data,
      projectId: project.projectId,
    });
    const schedule = await deps.scheduler.refreshNextRun(created.id);
    return c.json({ schedule: schedule ?? created }, 201);
  });

  // PUT /api/v2/schedules/:id — обновление расписания.
  app.put('/:id', writeGuard, scoped(...SERVICE_SCOPE_SETS.schedulesWrite), async (c) => {
    const id = c.req.param('id');

    // Ресурс резолвится ДО разбора тела: доступ проверяется на границе, а
    // тело чужого расписания не разбирается вовсе (не раскрываем его форму).
    const existing = await deps.scheduleStore.get(id);
    if (!existing) return notFound(c);

    const deniedProject = await authorize(c, existing.projectId, 'write');
    if (deniedProject) return deniedProject;

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

    // PROP-141: проект расписания обязателен — выводится из цели.
    const project = await resolveProjectId(parsed.data);
    if (!project.ok) return invalid(c, project.message);

    // Перенос расписания в другой проект — право нужно и на него (иначе
    // `EDITOR` одного проекта создал бы расписание в чужом).
    if (project.projectId !== existing.projectId) {
      const deniedTarget = await authorize(c, project.projectId, 'write');
      if (deniedTarget) return deniedTarget;
    }

    // ADR-052: проектная проекция — цель расписания адресует проект/сессию.
    const denied = serviceProjectProjection(c, project.projectId);
    if (denied) return denied;

    const updated = await deps.scheduleStore.update(id, {
      ...parsed.data,
      projectId: project.projectId,
    });
    if (!updated) return notFound(c);

    const schedule = await deps.scheduler.refreshNextRun(id);
    return c.json({ schedule: schedule ?? updated });
  });

  // DELETE /api/v2/schedules/:id — удаление расписания.
  app.delete('/:id', writeGuard, scoped(...SERVICE_SCOPE_SETS.schedulesWrite), async (c) => {
    const id = c.req.param('id');
    const existing = await deps.scheduleStore.get(id);
    if (!existing) return notFound(c);

    const deniedProject = await authorize(c, existing.projectId, 'write');
    if (deniedProject) return deniedProject;

    const removed = await deps.scheduleStore.remove(id);
    if (!removed) return notFound(c);
    return c.body(null, 204);
  });

  // GET /api/v2/schedules/:id/jobs — история срабатываний (ADR-051).
  app.get('/:id/jobs', auth.requireAuth, scoped('schedules:read'), async (c) => {
    const id = c.req.param('id');
    const schedule = await deps.scheduleStore.get(id);
    if (!schedule) return notFound(c);

    // Чтение — право чтения проекта расписания (`VIEWER` читает).
    const deniedProject = await authorize(c, schedule.projectId, 'read');
    if (deniedProject) return deniedProject;

    if (!deps.jobStore) return c.json({ jobs: [] });

    const rawLimit = c.req.query('limit');
    const parsed = rawLimit !== undefined ? Number(rawLimit) : Number.NaN;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 200) : 20;
    const jobs = await deps.jobStore.list({ scheduleId: id, limit });
    return c.json({ jobs });
  });

  // POST /api/v2/schedules/:id/run — принудительный запуск (force, в т.ч.
  // выключенного расписания). `runMiddleware` — дополнительный слой (rate limit).
  app.post('/:id/run', runGuard, scoped(...SERVICE_SCOPE_SETS.schedulesWrite), ...(opts.runMiddleware ?? []), async (c) => {
    const id = c.req.param('id');
    const existing = await deps.scheduleStore.get(id);
    if (!existing) return notFound(c);

    // Запуск — мутация: право изменения содержимого проекта расписания.
    const deniedProject = await authorize(c, existing.projectId, 'write');
    if (deniedProject) return deniedProject;

    // ADR-052: проектная проекция — проект существующего расписания
    // (денормализованное поле, PROP-141: проект у расписания обязателен).
    const denied = serviceProjectProjection(c, existing.projectId);
    if (denied) return denied;

    const schedule = await deps.scheduler.runNow(id);
    if (!schedule) return notFound(c);
    return c.json({ schedule });
  });

  return app;
}
