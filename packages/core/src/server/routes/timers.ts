/**
 * PROP-141 (этап 5, B-2): HTTP-роуты таймеров и будильников.
 *
 * Единая фабрика для core (standalone) и backend (managed) — по образцу
 * расписаний (`createSchedulerRoutes`). Права — **по проекту таймера**
 * (ADR-089 §5.5/§5.8, инвариант 21): чтение — право чтения проекта, мутации —
 * право изменения содержимого (`VIEWER` читает, но не мутирует). Проверка —
 * **на границе** (`opts.authorizeProject`), скоуп списка —
 * `opts.listVisibleProjectIds`. Опции не заданы (core/standalone) — прежнее
 * поведение: доступ к проекту не разграничивается (пользователь один).
 *
 * Ключевые решения:
 *
 * - **Проект таймера обязателен** (инстансных автоматизаций нет, PROP-141) и
 *   выводится из сессии (`opts.resolveSessionProject`): переданный в теле
 *   `projectId` обязан совпадать с выведенным — иначе `400 VALIDATION_ERROR`
 *   (цель и проект противоречат друг другу).
 * - **Владелец — текущий пользователь** (`ownerId` в теле нет): для
 *   service-key — синтетический `service:<keyId>`.
 * - **Мутации идут через движок** (`TimerService`): лимиты, валидация и
 *   пересчёт `firesAt` при смене правила повтора — его дело; роут в порт
 *   напрямую не пишет (инвариант 2).
 * - **Списки — страницы-сводки** (ADR-118 §4): `{timers,total,offset,limit,
 *   next_offset}` через общие `parseBoundedInt`/`paginate`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  SERVICE_SCOPE_SETS,
  TIMER_KINDS,
  TIMER_STATUSES,
  timerIntentRequestSchema,
  timerPatchRequestSchema,
} from '@itphx/synth-shared';
import type { TimerKind, TimerStatus } from '@itphx/synth-shared';
import type { TimerFiringRepository, TimerRepository } from '../../storage/ports/timer-repository.js';
import { TIMER_LIST_MAX_LIMIT } from '../../storage/timer-utils.js';
import type { TimerService } from '../../engine/timers/service.js';
import { TimerLimitExceededError, TimerValidationError } from '../../engine/timers/types.js';
import { requireScope, checkServiceProjectProjection } from '../service-scope.js';
import type { ScopeGuardFactory, ServiceProjectProjectionGuard } from '../service-scope.js';
import { paginate, parseBoundedInt } from '../pagination.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface TimerRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт t(), core — русские литералы. */
export interface TimerRouteMessages {
  invalidTimer: (c: Context) => string;
  timerNotFound: (c: Context) => string;
  /** Нет доступа к проекту таймера (граничная проверка). */
  projectForbidden: (c: Context) => string;
  /** Проект таймера не удалось вывести из сессии. */
  projectRequired: (c: Context) => string;
  /** Переданный `projectId` не совпадает с проектом сессии. */
  projectMismatch: (c: Context) => string;
  /** Таймер в терминальном статусе (`fired`/`cancelled`) — пауза/возобновление недопустимы. */
  timerNotMutable: (c: Context) => string;
  /** Превышен лимит активных таймеров сессии (50). */
  limitExceeded: (c: Context) => string;
}

/** Зависимости роутов таймеров. */
export interface TimerRoutesDeps {
  /** Движок таймеров (валидация, лимиты, пересчёт `firesAt`, аудит, live-события). */
  timerService: TimerService;
  /** Порт реестра таймеров — выборка и чтение записей (ADR-096). */
  timers: TimerRepository;
  /** Порт истории срабатываний (append-only). */
  firings: TimerFiringRepository;
}

export interface TimerRoutesOptions {
  messages?: Partial<TimerRouteMessages>;
  /** Guard на мутации; по умолчанию — `requireAuth` (managed — по правам проекта). */
  writeGuard?: Middleware;
  /** Дополнительные middleware на мутации (rate limit и т.п.). */
  writeMiddleware?: Middleware[];
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
   * PROP-141: резолвер `sessionId` → `projectId` (проект таймера). Не задан —
   * проект берётся из тела (`projectId`); вывести нельзя — `400`.
   */
  resolveSessionProject?: (sessionId: string) => Promise<string | undefined>;
  /**
   * PROP-141 (этап 5): **скоуп чтения списка** таймеров.
   *
   * Возвращает id проектов, видимых пользователю; `null` — «все» (managed:
   * `ADMIN`/`LEAD` — сквозной обзор; core/standalone — пользователь один).
   * Список ограничен этими проектами **и собственными** таймерами
   * (`ownerId` совпадает с текущим пользователем) — чужие не раскрываются.
   *
   * Не задана — прежнее поведение (список всех таймеров инстанса).
   */
  listVisibleProjectIds?: (c: Context) => Promise<string[] | null>;
  /**
   * PROP-141 (этап 5): **проектный доступ на границе** (инвариант 16).
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

const DEFAULT_MESSAGES: TimerRouteMessages = {
  invalidTimer: () => 'Некорректные данные таймера',
  timerNotFound: () => 'Таймер не найден',
  projectForbidden: () => 'Нет доступа к проекту таймера',
  projectRequired: () => 'Не удалось определить проект таймера по сессии',
  projectMismatch: () => 'Проект таймера не совпадает с проектом сессии',
  timerNotMutable: () => 'Таймер в завершённом состоянии — действие недоступно',
  limitExceeded: () => 'Достигнут лимит активных таймеров на сессию',
};

/** Потолок выборки списка таймеров. */
const MAX_LIST_LIMIT = 200;

/** Дефолтный размер страницы списка таймеров. */
const DEFAULT_LIST_LIMIT = 50;

/** Потолок выборки истории срабатываний. */
const MAX_FIRINGS_LIMIT = 200;

/** Дефолтный размер страницы истории срабатываний. */
const DEFAULT_FIRINGS_LIMIT = 20;

/** Статусы, в которых таймер уже отработал (пауза/возобновление недопустимы). */
const TERMINAL_STATUSES: readonly TimerStatus[] = ['fired', 'cancelled'];

/** Фильтры списка таймеров (`GET /api/v2/timers`). */
interface TimerListFilters {
  /** Сессия-получатель. */
  sessionId?: string;
  /** Проект автоматизации. */
  projectId?: string;
  /** Статус записи. */
  status?: TimerStatus;
  /** Вид автоматизации. */
  kind?: TimerKind;
}

/**
 * PROP-141 (этап 5, B-2): HTTP-контур таймеров и будильников.
 *
 * `GET /` — список (страницы-сводки); `POST /` — создание; `PATCH /:id` —
 * правка (`name`/`comment`/`repeat`); `POST /:id/pause` / `POST /:id/resume` —
 * пауза и возобновление; `DELETE /:id` — удаление; `GET /:id/firings` —
 * история срабатываний (страницы-сводки).
 */
export function createTimerRoutes(
  auth: TimerRoutesAuth,
  deps: TimerRoutesDeps,
  opts: TimerRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: TimerRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const writeMiddleware: Middleware[] = opts.writeMiddleware ?? [];
  // ADR-052 (этап I): scope-гейты service-key и проектная проекция.
  const scoped = opts.scopeGuard ?? requireScope;
  const serviceProjectProjection = opts.serviceProjectProjection ?? checkServiceProjectProjection;

  const invalid = (c: Context, message?: string) =>
    c.json(
      { error: { code: 'VALIDATION_ERROR', message: message ?? messages.invalidTimer(c) } },
      400,
    );

  const notFound = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.timerNotFound(c) } }, 404);

  const conflict = (c: Context, message: string) =>
    c.json({ error: { code: 'CONFLICT', message } }, 409);

  /**
   * Граничная проверка доступа к проекту таймера (инвариант 16): возвращает
   * готовый ответ (403/404) или `null` — доступ разрешён.
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

  /** id текущего пользователя (владелец таймера) — из контекста. */
  const currentUserId = (c: Context): string => {
    const user = c.get('user' as never) as { id?: unknown } | undefined;
    return typeof user?.id === 'string' && user.id ? user.id : '';
  };

  /**
   * Разбор query-фильтров списка (`GET /api/v2/timers`).
   * Некорректное значение — 400 `VALIDATION_ERROR`.
   */
  const parseListFilters = (
    c: Context,
  ): { ok: true; filters: TimerListFilters } | { ok: false; message: string } => {
    const filters: TimerListFilters = {};

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

    const status = c.req.query('status');
    if (status !== undefined) {
      const found = TIMER_STATUSES.find((value) => value === status);
      if (!found) {
        return {
          ok: false,
          message: `Некорректный фильтр status (ожидается ${TIMER_STATUSES.join('/')})`,
        };
      }
      filters.status = found;
    }

    const kind = c.req.query('kind');
    if (kind !== undefined) {
      const found = TIMER_KINDS.find((value) => value === kind);
      if (!found) {
        return {
          ok: false,
          message: `Некорректный фильтр kind (ожидается ${TIMER_KINDS.join('/')})`,
        };
      }
      filters.kind = found;
    }

    return { ok: true, filters };
  };

  /**
   * Ошибка движка таймеров → ответ HTTP.
   *
   * - `TimerLimitExceededError` — 409 `TIMER_LIMIT_EXCEEDED` (лимит активных
   *   таймеров на сессию — 50, PROP-141);
   * - `TimerValidationError` — 400 `VALIDATION_ERROR` (комментарий, интервал,
   *   время, часовой пояс, горизонт).
   *
   * Остальные ошибки — не наш случай: пробрасываются наружу (500).
   */
  const engineError = (c: Context, err: unknown): Response | null => {
    if (err instanceof TimerLimitExceededError) {
      return c.json(
        { error: { code: 'TIMER_LIMIT_EXCEEDED', message: err.message || messages.limitExceeded(c) } },
        409,
      );
    }
    if (err instanceof TimerValidationError) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: err.message || messages.invalidTimer(c) } },
        400,
      );
    }
    return null;
  };

  // GET /api/v2/timers — список таймеров (страницы-сводки, ADR-118 §4).
  // Фильтры: `sessionId`, `projectId`, `status`, `kind`.
  // Скоуп видимости (managed) — `listVisibleProjectIds`: видимые проекты +
  // собственные таймеры; чужие не раскрываются.
  app.get('/', auth.requireAuth, scoped(...SERVICE_SCOPE_SETS.timersRead), async (c) => {
    const parsed = parseListFilters(c);
    if (!parsed.ok) return invalid(c, parsed.message);

    const limit = parseBoundedInt(c.req.query('limit'), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) return invalid(c, 'Некорректные параметры пагинации');

    // Выборка — портом (фильтры по «И»); потолок порта (1000) — граница
    // выборки, страница режется уже здесь.
    const found = await deps.timers.list({
      ...parsed.filters,
      limit: TIMER_LIST_MAX_LIMIT,
    });

    // Скоуп видимости (PROP-141, managed): без опции — все таймеры.
    let visible = found;
    if (opts.listVisibleProjectIds) {
      const projects = await opts.listVisibleProjectIds(c);
      if (projects) {
        const allowed = new Set(projects);
        const ownerId = currentUserId(c);
        visible = found.filter(
          (timer) => allowed.has(timer.projectId) || (ownerId !== '' && timer.ownerId === ownerId),
        );
      }
    }

    const page = paginate(visible, offset, limit);
    return c.json({
      timers: page.page,
      total: page.total,
      offset,
      limit,
      next_offset: page.next_offset,
    });
  });

  // POST /api/v2/timers — создание таймера/будильника.
  app.post(
    '/',
    writeGuard,
    scoped(...SERVICE_SCOPE_SETS.timersWrite),
    ...writeMiddleware,
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return invalid(c);
      }

      const parsed = timerIntentRequestSchema.safeParse(body);
      if (!parsed.success) return invalid(c);
      const input = parsed.data;

      // Проект таймера обязателен (инстансных автоматизаций нет, PROP-141) и
      // выводится из сессии; переданный в теле — обязан совпадать.
      const projectId = opts.resolveSessionProject
        ? await opts.resolveSessionProject(input.sessionId)
        : input.projectId;
      if (!projectId) return invalid(c, messages.projectRequired(c));
      if (input.projectId !== undefined && input.projectId !== projectId) {
        return invalid(c, messages.projectMismatch(c));
      }

      // Граничная проверка прав на проект таймера (инвариант 16): право
      // изменения содержимого проекта (`VIEWER` не мутирует — инвариант 21).
      const deniedProject = await authorize(c, projectId, 'write');
      if (deniedProject) return deniedProject;

      // ADR-052: проектная проекция — таймер адресует проект.
      const denied = serviceProjectProjection(c, projectId);
      if (denied) return denied;

      try {
        const timer = await deps.timerService.createTimer({
          kind: input.kind,
          ...(input.name !== undefined ? { name: input.name } : {}),
          comment: input.comment,
          projectId,
          sessionId: input.sessionId,
          // Владелец — текущий пользователь (service-key → `service:<keyId>`).
          ownerId: currentUserId(c) || 'local',
          repeat: input.repeat,
          ...(input.delaySec !== undefined ? { delaySec: input.delaySec } : {}),
          ...(input.at !== undefined ? { at: input.at } : {}),
        });
        return c.json({ timer }, 201);
      } catch (err) {
        const response = engineError(c, err);
        if (response) return response;
        throw err;
      }
    },
  );

  // PATCH /api/v2/timers/:id — правка таймера (`name`/`comment`/`repeat`).
  // Пересчёт ближайшего срабатывания при смене правила повтора — дело
  // движка (`TimerService.updateTimer`).
  app.patch(
    '/:id',
    writeGuard,
    scoped(...SERVICE_SCOPE_SETS.timersWrite),
    ...writeMiddleware,
    async (c) => {
      const id = c.req.param('id');

      // Ресурс резолвится ДО разбора тела: доступ проверяется на границе, а
      // тело чужого таймера не разбирается вовсе.
      const existing = await deps.timers.get(id);
      if (!existing) return notFound(c);

      const deniedProject = await authorize(c, existing.projectId, 'write');
      if (deniedProject) return deniedProject;

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return invalid(c);
      }

      const parsed = timerPatchRequestSchema.safeParse(body);
      if (!parsed.success) return invalid(c);
      const patch = parsed.data;
      if (Object.keys(patch).length === 0) {
        return invalid(c, 'Не указаны поля для изменения');
      }

      const denied = serviceProjectProjection(c, existing.projectId);
      if (denied) return denied;

      try {
        const updated = await deps.timerService.updateTimer(id, patch);
        if (!updated) return notFound(c);
        return c.json({ timer: updated });
      } catch (err) {
        const response = engineError(c, err);
        if (response) return response;
        throw err;
      }
    },
  );

  // POST /api/v2/timers/:id/pause — пауза (срабатывание не наступит).
  app.post(
    '/:id/pause',
    writeGuard,
    scoped(...SERVICE_SCOPE_SETS.timersWrite),
    ...writeMiddleware,
    async (c) => {
      const id = c.req.param('id');
      const existing = await deps.timers.get(id);
      if (!existing) return notFound(c);

      const deniedProject = await authorize(c, existing.projectId, 'write');
      if (deniedProject) return deniedProject;

      // Таймер, который уже отработал, не «приостанавливается»: иначе
      // возобновление воскресило бы его повторным срабатыванием.
      if (TERMINAL_STATUSES.includes(existing.status)) {
        return conflict(c, messages.timerNotMutable(c));
      }

      const denied = serviceProjectProjection(c, existing.projectId);
      if (denied) return denied;

      const paused = await deps.timerService.pauseTimer(id);
      if (!paused) return notFound(c);
      return c.json({ timer: paused });
    },
  );

  // POST /api/v2/timers/:id/resume — снятие с паузы (повторяющиеся
  // пересчитывают ближайшее срабатывание от текущего времени).
  app.post(
    '/:id/resume',
    writeGuard,
    scoped(...SERVICE_SCOPE_SETS.timersWrite),
    ...writeMiddleware,
    async (c) => {
      const id = c.req.param('id');
      const existing = await deps.timers.get(id);
      if (!existing) return notFound(c);

      const deniedProject = await authorize(c, existing.projectId, 'write');
      if (deniedProject) return deniedProject;

      if (TERMINAL_STATUSES.includes(existing.status)) {
        return conflict(c, messages.timerNotMutable(c));
      }

      const denied = serviceProjectProjection(c, existing.projectId);
      if (denied) return denied;

      const resumed = await deps.timerService.resumeTimer(id);
      if (!resumed) return notFound(c);
      return c.json({ timer: resumed });
    },
  );

  // DELETE /api/v2/timers/:id — удаление (история срабатываний остаётся).
  app.delete(
    '/:id',
    writeGuard,
    scoped(...SERVICE_SCOPE_SETS.timersWrite),
    ...writeMiddleware,
    async (c) => {
      const id = c.req.param('id');
      const existing = await deps.timers.get(id);
      if (!existing) return notFound(c);

      const deniedProject = await authorize(c, existing.projectId, 'write');
      if (deniedProject) return deniedProject;

      const denied = serviceProjectProjection(c, existing.projectId);
      if (denied) return denied;

      const removed = await deps.timerService.removeTimer(id);
      if (!removed) return notFound(c);
      return c.body(null, 204);
    },
  );

  // GET /api/v2/timers/:id/firings — история срабатываний (страницы-сводки).
  app.get('/:id/firings', auth.requireAuth, scoped(...SERVICE_SCOPE_SETS.timersRead), async (c) => {
    const id = c.req.param('id');
    const timer = await deps.timers.get(id);
    if (!timer) return notFound(c);

    // Чтение — право чтения проекта таймера (`VIEWER` читает).
    const deniedProject = await authorize(c, timer.projectId, 'read');
    if (deniedProject) return deniedProject;

    const limit = parseBoundedInt(
      c.req.query('limit'),
      DEFAULT_FIRINGS_LIMIT,
      MAX_FIRINGS_LIMIT,
    );
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) return invalid(c, 'Некорректные параметры пагинации');

    const firings = await deps.firings.list(timer.id);
    const page = paginate(firings, offset, limit);
    return c.json({
      firings: page.page,
      total: page.total,
      offset,
      limit,
      next_offset: page.next_offset,
    });
  });

  return app;
}
