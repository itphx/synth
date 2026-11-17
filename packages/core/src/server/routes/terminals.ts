/**
 * HTTP-контур интерактивных терминалов (PROP-132, Ф3б).
 *
 * ## Контракт
 *
 * Все маршруты — под `/api/v2/terminals`:
 *
 * | Метод  | Путь                       | Что делает                                   |
 * |--------|----------------------------|----------------------------------------------|
 * | `GET`  | `/`                        | список терминалов (постранично; `include_exited` — вместе с завершёнными) |
 * | `POST` | `/`                        | открыть терминал (PTY на точке исполнения)     |
 * | `GET`  | `/:id`                     | снимок терминала                              |
 * | `PATCH`| `/:id`                     | переименование / привязка к сессии             |
 * | `DELETE`| `/:id`                    | удалить терминал (снимок тоже)                |
 * | `GET`  | `/:id/output?since=N`      | снимок вывода из кольцевого буфера            |
 * | `GET`  | `/:id/stream?since=N`      | поток вывода NDJSON (replay → live)           |
 * | `POST` | `/:id/input`               | ввод в терминал                               |
 * | `POST` | `/:id/resize`              | новый размер терминала                        |
 * | `POST` | `/:id/restart`             | перезапуск завершённого терминала             |
 *
 * Список — **постраничный** (ADR-118): `{terminals, total, offset, limit,
 * next_offset}`; `limit`/`offset` — целые (невалидные → `400
 * VALIDATION_ERROR`, выше потолка — обрезаются).
 *
 * ## Граница доступа (инвариант 16)
 *
 * Права проверяются **на границе** — в guard'ах фабрики, не в обработчиках:
 *
 * - чтение (`GET`) — право **чтения** проекта (`canReadProject`: владелец,
 *   любой участник, `LEAD`/`ADMIN`);
 * - мутация (`POST`/`PATCH`/`DELETE`) — право **изменения содержимого**
 *   (`canEditProjectContent`: `OWNER`/`EDITOR`/`LEAD`/`ADMIN`).
 *
 * Участник с ролью просмотра (`VIEWER`) читает терминал, но не может писать
 * в него (инвариант 21). Правило одно — `resolveProjectAccess` в `shared`
 * (PROP-133); core-фабрика получает его через `opts` (backend подставляет
 * `createProjectAccess`, standalone — один пользователь инстанса).
 *
 * ## Коды ошибок
 *
 * | Код                     | Статус | Когда                                        |
 * |-------------------------|--------|----------------------------------------------|
 * | `TERMINALS_DISABLED`    | 403    | инстансный выключатель `terminal.enabled`     |
 * | `FORBIDDEN`             | 403    | нет права на проект                           |
 * | `NOT_FOUND`             | 404    | нет проекта/сессии                            |
 * | `TERMINAL_NOT_FOUND`    | 404    | нет терминала                                 |
 * | `VALIDATION_ERROR`      | 400    | тело/параметры запроса                       |
 * | `TERMINAL_INVALID_REQUEST` | 400 | некорректные аргументы терминала              |
 * | `TERMINAL_LIMIT`        | 409/429/413 | лимит терминалов (409), скорость ввода (429), кадр ввода (413) |
 * | `TERMINAL_ALREADY_RUNNING` | 409 | перезапуск живого терминала                   |
 * | `TERMINAL_EXITED`       | 409    | терминал завершён (ввод/размер невозможны)    |
 * | `TERMINAL_UNAVAILABLE`  | 503    | PTY недоступен в этой среде                   |
 *
 * ## Рабочий каталог
 *
 * `cwd` в теле запроса **игнорируется**: рабочий каталог терминала
 * вычисляется сервером — `session.worktree.directory` (ADR-114) → `project.workspace`
 * (ADR-075). Произвольный каталог из тела не принимается (иначе терминал
 * уехал бы за периметр проекта).
 */
import { isAbsolute, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Project, Session } from '@itphx/synth-shared';
import type { TerminalService } from '../../engine/terminal/service.js';
import {
  TerminalAlreadyRunningError,
  TerminalDisabledError,
  TerminalExitedError,
  TerminalInvalidRequestError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalUnavailableError,
  toTerminalDto,
  type TerminalRecord,
  type TerminalSubscription,
} from '../../engine/terminal/types.js';
import { parseSinceParam } from '../../events/bus.js';
import { EXECUTION_PTY_UNSUPPORTED_CODE, isExecutionError } from '../../execution/ports/index.js';
import { paginate, parseBoundedInt } from '../pagination.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface TerminalRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения (core — русские литералы, backend — i18n). */
export interface TerminalRouteMessages {
  /** Терминал не найден (404). */
  terminalNotFound: (c: Context) => string;
  /** Проект не найден (404). */
  projectNotFound: (c: Context) => string;
  /** Сессия не найдена (404). */
  sessionNotFound: (c: Context) => string;
  /** Нет права на проект (403). */
  forbidden: (c: Context) => string;
  /** Некорректные параметры запроса (400). */
  invalidQuery: (c: Context) => string;
  /** Некорректное тело запроса (400). */
  invalidBody: (c: Context) => string;
  /** Терминалы на инстансе выключены (403). */
  terminalsDisabled: (c: Context) => string;
  /** PTY недоступен (503). */
  terminalUnavailable: (c: Context) => string;
  /**
   * PTY не поддерживается самой точкой исполнения (503).
   *
   * Пользователю нужно объяснить причину, а не показать общее «терминалы
   * недоступны»: профиль исполнения (браузерный/старый образ без
   * `features.pty`) не умеет интерактивные сессии.
   */
  terminalPtyUnsupported?: (c: Context) => string;
  /** Исчерпан лимит терминалов (409/429/413). */
  terminalLimit: (c: Context) => string;
  /** Терминал ещё работает — перезапуск невозможен (409). */
  terminalAlreadyRunning: (c: Context) => string;
  /** Терминал завершён — ввод/размер невозможны (409). */
  terminalExited: (c: Context) => string;
  /** Сессия не принадлежит проекту терминала (400). */
  sessionNotInProject: (c: Context) => string;
  /** У проекта нет рабочего каталога (400). */
  workspaceMissing: (c: Context) => string;
}

/** Сообщения по умолчанию (core — русские литералы). */
const DEFAULT_MESSAGES: TerminalRouteMessages = {
  terminalNotFound: () => 'Терминал не найден',
  projectNotFound: () => 'Проект не найден',
  sessionNotFound: () => 'Сессия не найдена',
  forbidden: () => 'Доступ запрещён',
  invalidQuery: () => 'Некорректные параметры запроса',
  invalidBody: () => 'Некорректное тело запроса',
  terminalsDisabled: () => 'Терминалы на инстансе выключены',
  terminalUnavailable: () => 'Терминалы недоступны в этой среде',
  terminalPtyUnsupported: () =>
    'Терминалы недоступны в этом профиле исполнения: исполнитель не поддерживает PTY (нет features.pty)',
  terminalLimit: () => 'Исчерпан лимит терминалов',
  terminalAlreadyRunning: () => 'Терминал ещё работает — перезапуск невозможен',
  terminalExited: () => 'Терминал завершён — перезапустите его',
  sessionNotInProject: () => 'Сессия не принадлежит проекту',
  workspaceMissing: () => 'Не удалось вычислить рабочий каталог терминала',
};

/** Зависимости фабрики: сервис терминалов + порты чтения проекта/сессии. */
export interface TerminalRoutesDeps {
  /** Сервис терминалов (реестр, поток вывода, ввод). */
  terminal: TerminalService;
  /** Загрузка проекта (права + рабочий каталог). */
  projects: { load(id: string): Promise<Project | null> };
  /** Загрузка сессии (привязка терминала + worktree). */
  sessions?: { getSession(id: string): Promise<Session | null> };
}

/** Опции фабрики: права, пользователь, сообщения, корень workspace. */
export interface TerminalRoutesOptions {
  /** Право чтения проекта (не задано — разрешено; standalone: один пользователь). */
  canReadProject?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** Право изменения содержимого проекта (не задано — разрешено). */
  canEditProjectContent?: (c: Context, project: Project, userId: string) => boolean | Promise<boolean>;
  /** userId запроса (core — `local`, backend — id пользователя). */
  getCurrentUserId?: (c: Context) => string | Promise<string>;
  /** Сообщения (backend — i18n). */
  messages?: Partial<TerminalRouteMessages>;
  /**
   * Корень каталогов workspace (ADR-075) — для относительного
   * `project.workspace`. Не задан — относительный workspace не резолвится
   * (терминал не создаётся: `400`).
   */
  workspacesRoot?: string;
}

/** Потолок выборки списка терминалов. */
const MAX_LIST_LIMIT = 200;
/** Размер страницы списка по умолчанию. */
const DEFAULT_LIST_LIMIT = 50;

/** Размер терминала по умолчанию (если поле не задано). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Границы размера терминала — **валидация на границе** (как у остальных роутов).
 *
 * Сервис по-прежнему клампит значения (`clampDimension`) — это защита от
 * абсурдных значений для внутренних вызовов (тулы), но клиент получает честный
 * `400 VALIDATION_ERROR`, а не молча изменённый размер.
 */
const MIN_COLS = 1;
const MAX_COLS = 1000;
const MIN_ROWS = 1;
const MAX_ROWS = 500;

/**
 * Период heartbeat-кадра потока вывода, мс.
 *
 * Нужен, чтобы соединение не выглядело простаивающим для прокси/балансировщика
 * и чтобы запись в мёртвый поток обнаруживалась (ошибка записи → снятие
 * подписки). Кадр пустой: `{"seq":<последний>,"data":""}`.
 */
const STREAM_HEARTBEAT_MS = 15_000;

/** Целое в границах (иначе `null` — клиент получит `400`). */
function parseDimension(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/** Вид доступа к терминалу (выводится из HTTP-метода). */
type TerminalAccess = 'read' | 'write';

/** Права по проекту, посчитанные один раз на проект за запрос. */
interface ProjectAccess {
  read: boolean;
  write: boolean;
}

/**
 * HTTP-фабрика контура терминалов (core + backend).
 *
 * Права — **на границе** (инвариант 16): guard'ы резолвят терминал и проект
 * ОДИН раз и кладут их в контекст Hono; обработчики проверок доступа не
 * содержат.
 */
export function createTerminalRoutes(
  auth: TerminalRoutesAuth,
  deps: TerminalRoutesDeps,
  opts: TerminalRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: TerminalRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };

  const currentUserId = async (c: Context): Promise<string> =>
    opts.getCurrentUserId ? await opts.getCurrentUserId(c) : 'local';

  /** 404 — терминала нет. */
  const terminalNotFound = (c: Context) =>
    c.json({ error: { code: 'TERMINAL_NOT_FOUND', message: messages.terminalNotFound(c) } }, 404);

  /** 403 — нет права на проект. */
  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);

  /** 400 — некорректные параметры запроса. */
  const invalidQuery = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidQuery(c) } }, 400);

  /** 400 — некорректное тело запроса. */
  const invalidBody = (c: Context, message?: string) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: message ?? messages.invalidBody(c) } }, 400);

  /**
   * ГРАНИЧНЫЙ guard мастер-выключателя инстанса (`terminal.enabled`).
   *
   * Выключено — весь контур `/api/v2/terminals*` отвечает `403`
   * `TERMINALS_DISABLED` (PROP-132): закрытие живых терминалов и запрет
   * новых делает сервис, а доступность контура решает граница.
   */
  const enabledGuard: Middleware = createMiddleware(async (c, next) => {
    if (!deps.terminal.isEnabled()) {
      return c.json(
        { error: { code: 'TERMINALS_DISABLED', message: messages.terminalsDisabled(c) } },
        403,
      );
    }
    await next();
  });

  /** Ключ контекста: терминал, разрезолвленный граничным guard'ом. */
  const TERMINAL_KEY = 'guardedTerminal';
  /** Ключ контекста: проект терминала (для резолва рабочего каталога). */
  const PROJECT_KEY = 'guardedTerminalProject';

  /**
   * Права по проекту (один резолвер на проект за запрос — кэш).
   *
   * `read` — право чтения проекта, `write` — право изменения содержимого
   * (инвариант 21: read-доступ не расширяет права на изменение).
   */
  const projectAccessOf = async (
    c: Context,
    project: Project,
    cache: Map<string, ProjectAccess>,
  ): Promise<ProjectAccess> => {
    const cached = cache.get(project.id);
    if (cached) return cached;
    const userId = await currentUserId(c);
    const read = opts.canReadProject ? await opts.canReadProject(c, project, userId) : true;
    const write = opts.canEditProjectContent
      ? await opts.canEditProjectContent(c, project, userId)
      : true;
    const access: ProjectAccess = { read, write };
    cache.set(project.id, access);
    return access;
  };

  /**
   * ГРАНИЧНАЯ проверка доступа к терминалу (инвариант 16): терминал
   * резолвится ОДИН раз, его проект — тоже; вид доступа — по HTTP-методу
   * (`read`/`write`).
   */
  const terminalGuard = (access: TerminalAccess): Middleware =>
    createMiddleware(async (c, next) => {
      const id = c.req.param('id');
      const record = id ? deps.terminal.get(id) : null;
      if (!record) return terminalNotFound(c);
      const project = await deps.projects.load(record.projectId);
      if (!project) return terminalNotFound(c);
      const cache = new Map<string, ProjectAccess>();
      const { read, write } = await projectAccessOf(c, project, cache);
      if (access === 'read' ? !read : !write) return forbidden(c);
      c.set(TERMINAL_KEY as never, record as never);
      c.set(PROJECT_KEY as never, project as never);
      await next();
    });

  /** Терминал из контекста guard'а (единственный источник — инвариант 16). */
  const guardedTerminal = (c: Context): TerminalRecord =>
    c.get(TERMINAL_KEY as never) as TerminalRecord;

  /** Проект терминала из контекста guard'а. */
  const guardedProject = (c: Context): Project =>
    c.get(PROJECT_KEY as never) as Project;

  /**
   * Рабочий каталог терминала — **вычисляется сервером** (тело запроса его
   * не задаёт): `session.worktree.directory` (ADR-114) → `project.workspace`
   * (ADR-075).
   */
  const resolveCwd = async (c: Context, project: Project, session: Session | null): Promise<string> => {
    if (session?.worktree?.directory) return session.worktree.directory;
    const workspace = project.workspace;
    if (!workspace) {
      throw new TerminalInvalidRequestError(messages.workspaceMissing(c));
    }
    if (isAbsolute(workspace)) return normalize(workspace);
    if (!opts.workspacesRoot) {
      throw new TerminalInvalidRequestError(messages.workspaceMissing(c));
    }
    return resolve(opts.workspacesRoot, workspace);
  };

  /**
   * Маппинг типизированных ошибок терминального сервиса в HTTP-коды.
   *
   * Единственное место, где ошибка сервиса становится ответом: обработчики
   * отвечают своими кодами, а «машинные» коды сервиса (`TERMINAL_*`) живут
   * здесь.
   */
  const terminalErrorResponse = (c: Context, err: unknown): Response => {
    if (err instanceof TerminalDisabledError) {
      return c.json(
        { error: { code: 'TERMINALS_DISABLED', message: messages.terminalsDisabled(c) } },
        403,
      );
    }
    if (err instanceof TerminalNotFoundError) return terminalNotFound(c);
    if (err instanceof TerminalExitedError) {
      // Терминал завершён: запись есть, но процесс уже вышел — ввод/размер
      // невозможны, его надо перезапустить (`POST /:id/restart`).
      return c.json(
        { error: { code: 'TERMINAL_EXITED', message: messages.terminalExited(c) } },
        409,
      );
    }
    if (err instanceof TerminalAlreadyRunningError) {
      // Перезапуск живого терминала — конфликт состояния: вторая оболочка
      // в том же каталоге рассинхронила бы вывод (PROP-132).
      return c.json(
        {
          error: {
            code: 'TERMINAL_ALREADY_RUNNING',
            message: messages.terminalAlreadyRunning(c),
          },
        },
        409,
      );
    }
    if (err instanceof TerminalLimitError) {
      // `project`/`instance` — конфликт состояния (409), `rate` — слишком
      // часто (429), `input` — кадр ввода больше лимита (413).
      const status = err.scope === 'input' ? 413 : err.scope === 'rate' ? 429 : 409;
      return c.json(
        {
          error: {
            code: 'TERMINAL_LIMIT',
            message: messages.terminalLimit(c),
            details: { scope: err.scope, limit: err.limit },
          },
        },
        status,
      );
    }
    if (err instanceof TerminalUnavailableError) {
      return c.json(
        {
          error: {
            code: 'TERMINAL_UNAVAILABLE',
            message: messages.terminalUnavailable(c),
            details: { reason: err.reason },
          },
        },
        503,
      );
    }
    if (err instanceof TerminalInvalidRequestError) {
      return c.json(
        { error: { code: 'TERMINAL_INVALID_REQUEST', message: err.message } },
        400,
      );
    }
    // Ошибка порта исполнения: PTY поднимает **исполнитель** (PROP-135), и
    // профиль может его не уметь — `EPTY` (`dependency_missing`, нет
    // `features.pty`) или сбой спавна (`ESPAWN`/`spawn_failed`). Это не
    // внутренняя ошибка ядра: клиенту нужен `503` с причиной, иначе
    // пользователь видит бессмысленное «Внутренняя ошибка терминала».
    if (isExecutionError(err)) {
      const ptyUnsupported = err.code === EXECUTION_PTY_UNSUPPORTED_CODE;
      return c.json(
        {
          error: {
            code: 'TERMINAL_UNAVAILABLE',
            message: ptyUnsupported
              ? (messages.terminalPtyUnsupported ?? messages.terminalUnavailable)(c)
              : messages.terminalUnavailable(c),
            details: {
              reason: ptyUnsupported ? 'pty_unsupported' : 'executor',
              code: err.code,
              detail: err.message,
            },
          },
        },
        503,
      );
    }
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка терминала' } },
      500,
    );
  };

  // GET / — список терминалов (постранично, ADR-118).
  app.get('/', auth.requireAuth, enabledGuard, async (c) => {
    const projectId = c.req.query('project_id')?.trim() || undefined;
    const sessionId = c.req.query('session_id')?.trim() || undefined;
    // Завершённые терминалы (в т.ч. восстановленные из снимков после рестарта
    // ядра) по умолчанию скрыты: клиент видит живые. `include_exited=true`
    // (или `1`) — отдаём и их (терминал завершён, но его можно перезапустить).
    const includeExitedRaw = c.req.query('include_exited')?.trim().toLowerCase();
    const includeExited = includeExitedRaw === 'true' || includeExitedRaw === '1';
    const limit = parseBoundedInt(c.req.query('limit'), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) return invalidQuery(c);

    const cache = new Map<string, ProjectAccess>();
    // Проекты за запрос кэшируются: список терминалов ходит по проектам
    // терминалов, а права по проекту считаются один раз.
    const projectCache = new Map<string, Project | null>();
    const projectOf = async (id: string): Promise<Project | null> => {
      if (projectCache.has(id)) return projectCache.get(id) ?? null;
      const project = await deps.projects.load(id);
      projectCache.set(id, project);
      return project;
    };

    // Явный фильтр по проекту: проект должен существовать и быть читаемым.
    if (projectId) {
      const project = await projectOf(projectId);
      if (!project) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.projectNotFound(c) } }, 404);
      }
      const { read } = await projectAccessOf(c, project, cache);
      if (!read) return forbidden(c);
    }

    // Терминалы чужих проектов в выдаче не появляются (доступ решает проект).
    const visible: Array<{ record: TerminalRecord; project: Project }> = [];
    for (const record of deps.terminal.list({
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(includeExited ? { includeExited: true } : {}),
    })) {
      const project = await projectOf(record.projectId);
      if (!project) continue;
      const { read } = await projectAccessOf(c, project, cache);
      if (!read) continue;
      visible.push({ record, project });
    }

    const page = paginate(visible, offset, limit);
    const terminals = [];
    for (const { record, project } of page.page) {
      const { write } = await projectAccessOf(c, project, cache);
      terminals.push(
        toTerminalDto(record, {
          canWrite: write,
          attachedClients: deps.terminal.attachedClients(record.id),
        }),
      );
    }

    return c.json({
      terminals,
      total: page.total,
      offset,
      limit,
      next_offset: page.next_offset,
    });
  });

  // POST / — открыть терминал.
  app.post('/', auth.requireAuth, enabledGuard, async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidBody(c);
    const raw = body as Record<string, unknown>;

    const projectId = typeof raw['project_id'] === 'string' ? raw['project_id'].trim() : '';
    if (!projectId) return invalidBody(c, 'Поле project_id обязательно');

    const project = await deps.projects.load(projectId);
    if (!project) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.projectNotFound(c) } }, 404);
    }
    const cache = new Map<string, ProjectAccess>();
    const { write } = await projectAccessOf(c, project, cache);
    if (!write) return forbidden(c);

    // Сессия (необязательна) должна существовать и принадлежать проекту.
    const sessionId = typeof raw['session_id'] === 'string' ? raw['session_id'].trim() : '';
    let session: Session | null = null;
    if (sessionId) {
      session = deps.sessions ? await deps.sessions.getSession(sessionId) : null;
      if (!session) {
        return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
      }
      if (session.projectId !== projectId) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.sessionNotInProject(c) } },
          400,
        );
      }
    }

    const cols = parseDimension(raw['cols'] ?? DEFAULT_COLS, MIN_COLS, MAX_COLS);
    const rows = parseDimension(raw['rows'] ?? DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
    if (cols === null) return invalidBody(c);
    if (rows === null) return invalidBody(c);
    const shell = typeof raw['shell'] === 'string' ? raw['shell'].trim() : '';
    const title = typeof raw['title'] === 'string' ? raw['title'].trim() : '';
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';

    try {
      const cwd = await resolveCwd(c, project, session);
      const record = await deps.terminal.create({
        ...(id ? { id } : {}),
        projectId,
        ...(sessionId ? { sessionId } : {}),
        ownerId: await currentUserId(c),
        cwd,
        ...(shell ? { shell } : {}),
        cols,
        rows,
        ...(title ? { title } : {}),
      });
      return c.json(
        {
          terminal: toTerminalDto(record, {
            canWrite: true,
            attachedClients: deps.terminal.attachedClients(record.id),
          }),
        },
        201,
      );
    } catch (err) {
      return terminalErrorResponse(c, err);
    }
  });

  // GET /:id/output — снимок вывода из кольцевого буфера (догон по курсору).
  app.get('/:id/output', auth.requireAuth, enabledGuard, terminalGuard('read'), async (c) => {
    const record = guardedTerminal(c);
    const snapshot = deps.terminal.output(record.id);
    if (!snapshot) return terminalNotFound(c);
    const since = parseSinceParam(c.req.query('since')) ?? 0;
    const chunks = snapshot.chunks.filter((chunk) => chunk.seq > since);
    const data = chunks.map((chunk) => chunk.data).join('');
    const lastSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : since;
    // Вывод был вытеснен из буфера до запрошенного курсора — клиенту нужно
    // перечитать вывод целиком.
    const truncated = snapshot.firstSeq > 0 && since + 1 < snapshot.firstSeq;
    return c.json({
      data,
      seq: chunks.length > 0 ? chunks[0]!.seq : since,
      next_seq: lastSeq,
      truncated,
      total_bytes: snapshot.totalBytes,
      dropped_bytes: snapshot.droppedBytes,
      chunks,
    });
  });

  // GET /:id/foreground — что сейчас на переднем плане терминала.
  //
  // Факт из ядра ОС (`PtyHandle.inspect`, протокол исполнителя 9): в фокусе
  // оболочка, удалённая оболочка (`ssh`), полноэкранное приложение (`vim`) или
  // обычная команда (`sleep`). `null` — «неизвестно»: терминал завершён, PTY
  // не поднят (снимок после рестарта) или точка исполнения не умеет пробу.
  // Это валидный ответ 200, а не ошибка.
  app.get('/:id/foreground', auth.requireAuth, enabledGuard, terminalGuard('read'), async (c) => {
    const record = guardedTerminal(c);
    const foreground = await deps.terminal.getForeground(record.id);
    return c.json({
      foreground: foreground
        ? {
            ...(foreground.shellPid !== undefined ? { shell_pid: foreground.shellPid } : {}),
            ...(foreground.foregroundPgid !== undefined
              ? { foreground_pgid: foreground.foregroundPgid }
              : {}),
            ...(foreground.command !== undefined ? { command: foreground.command } : {}),
            is_shell: foreground.isShell,
          }
        : null,
    });
  });

  // GET /:id/stream — поток вывода NDJSON (replay из буфера → live).
  app.get('/:id/stream', auth.requireAuth, enabledGuard, terminalGuard('read'), async (c) => {
    const record = guardedTerminal(c);
    const since = parseSinceParam(c.req.query('since')) ?? 0;
    // Сигнал запроса: transport абортит его при отключении клиента
    // (`@hono/node-server` — по `close` ответа; standalone-адаптер
    // `server/app/http-server.ts` — тем же событием). Это ОСНОВНОЙ путь
    // снятия подписки — `cancel()` потока вызывается не всеми транспортами.
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();

    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let subscription: TerminalSubscription | null = null;
    let closed = false;
    let lastSeq = since;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    /** Остановить heartbeat-таймер (идемпотентно). */
    function stopHeartbeat(): void {
      if (heartbeat === null) return;
      clearInterval(heartbeat);
      heartbeat = null;
    }

    /**
     * Снять подписку и закрыть поток (идемпотентно).
     *
     * Единственная точка выхода: abort запроса, `cancel()` потока, выход
     * терминала, ошибка записи. Во всех случаях подписчик удаляется из
     * реестра — иначе `attached_clients` растёт и idle-reaper не срабатывает.
     */
    function cleanup(): void {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      const active = subscription;
      subscription = null;
      try {
        active?.unsubscribe();
      } catch {
        // ignore
      }
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // ignore
      }
      try {
        controllerRef?.close();
      } catch {
        // ignore
      }
    }

    /** Клиент отключился — поток закрываем. */
    function onAbort(): void {
      cleanup();
    }

    /**
     * Записать кадр потока (`{"seq":n,"data":"..."}` — NDJSON, строка на кадр).
     *
     * Ошибка записи означает, что поток больше никто не читает: снимаем
     * подписку и завершаем поток (`cleanup`).
     */
    function write(frame: unknown): void {
      if (closed || !controllerRef) return;
      try {
        controllerRef.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      } catch {
        cleanup();
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        // Слушатель ставим ДО подписки: клиент может уйти во время replay.
        signal.addEventListener('abort', onAbort);
        if (signal.aborted) {
          cleanup();
          return;
        }
        try {
          subscription = deps.terminal.subscribe(record.id, { since }, {
            onData: (chunk) => {
              lastSeq = chunk.seq;
              write({ seq: chunk.seq, data: chunk.data });
            },
            onExit: (info) => {
              write({
                seq: lastSeq,
                data: '',
                ...(info.exitCode !== undefined ? { exit_code: info.exitCode } : {}),
                ...(info.signal !== undefined ? { signal: info.signal } : {}),
              });
              cleanup();
            },
          });
        } catch {
          // Терминал исчез между проверкой границы и подпиской — поток пуст.
          cleanup();
          return;
        }
        if (closed) {
          // Клиент ушёл во время replay — подписку уже сняли (или снимем).
          try {
            subscription?.unsubscribe();
          } catch {
            // ignore
          }
          subscription = null;
          return;
        }
        // Heartbeat: пустой кадр раз в 15 с. Держит соединение живым и
        // обнаруживает мёртвый поток (ошибка записи → `cleanup`).
        heartbeat = setInterval(() => {
          if (closed) return;
          write({ seq: lastSeq, data: '' });
        }, STREAM_HEARTBEAT_MS);
        (heartbeat as unknown as { unref?: () => void }).unref?.();
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  // GET /:id — снимок терминала.
  app.get('/:id', auth.requireAuth, enabledGuard, terminalGuard('read'), async (c) => {
    const record = guardedTerminal(c);
    const project = guardedProject(c);
    const cache = new Map<string, ProjectAccess>();
    const { write } = await projectAccessOf(c, project, cache);
    return c.json({
      terminal: toTerminalDto(record, {
        canWrite: write,
        attachedClients: deps.terminal.attachedClients(record.id),
      }),
    });
  });

  // PATCH /:id — переименование / привязка к сессии.
  app.patch('/:id', auth.requireAuth, enabledGuard, terminalGuard('write'), async (c) => {
    const record = guardedTerminal(c);
    const project = guardedProject(c);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidBody(c);
    const raw = body as Record<string, unknown>;

    const patch: { title?: string | null; sessionId?: string | null } = {};

    if ('title' in raw) {
      const title = raw['title'];
      if (title === null) patch.title = null;
      else if (typeof title === 'string') patch.title = title.trim();
      else return invalidBody(c);
    }

    if ('session_id' in raw) {
      const sessionId = raw['session_id'];
      if (sessionId === null) patch.sessionId = null;
      else if (typeof sessionId === 'string' && sessionId.trim()) {
        const session = deps.sessions ? await deps.sessions.getSession(sessionId.trim()) : null;
        if (!session) {
          return c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);
        }
        if (session.projectId !== project.id) {
          return c.json(
            { error: { code: 'VALIDATION_ERROR', message: messages.sessionNotInProject(c) } },
            400,
          );
        }
        patch.sessionId = session.id;
      } else {
        return invalidBody(c);
      }
    }

    if (patch.title === undefined && patch.sessionId === undefined) return invalidBody(c);

    try {
      const updated = deps.terminal.update(record.id, patch);
      const cache = new Map<string, ProjectAccess>();
      const { write } = await projectAccessOf(c, project, cache);
      return c.json({
        terminal: toTerminalDto(updated, {
          canWrite: write,
          attachedClients: deps.terminal.attachedClients(updated.id),
        }),
      });
    } catch (err) {
      return terminalErrorResponse(c, err);
    }
  });

  /**
   * DELETE /:id — удалить терминал (PROP-132).
   *
   * PTY гасится, запись уходит из реестра, **снимок терминала удаляется**:
   * удалённый терминал не должен воскреснуть после рестарта ядра. Публикуются
   * `terminal.exited` + `terminal.deleted`.
   */
  app.delete('/:id', auth.requireAuth, enabledGuard, terminalGuard('write'), async (c) => {
    const record = guardedTerminal(c);
    try {
      await deps.terminal.delete(record.id, { actorId: await currentUserId(c) });
      return c.body(null, 204);
    } catch (err) {
      return terminalErrorResponse(c, err);
    }
  });

  // POST /:id/input — ввод в терминал (кадр ≤ 16 КиБ — лимит сервиса).
  app.post('/:id/input', auth.requireAuth, enabledGuard, terminalGuard('write'), async (c) => {
    const record = guardedTerminal(c);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidBody(c);
    const data = (body as Record<string, unknown>)['data'];
    if (typeof data !== 'string') return invalidBody(c);
    try {
      deps.terminal.write(record.id, data, { actorId: await currentUserId(c) });
      return c.body(null, 204);
    } catch (err) {
      return terminalErrorResponse(c, err);
    }
  });

  // POST /:id/resize — новый размер терминала.
  app.post('/:id/resize', auth.requireAuth, enabledGuard, terminalGuard('write'), async (c) => {
    const record = guardedTerminal(c);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalidBody(c);
    const raw = body as Record<string, unknown>;
    const cols = parseDimension(raw['cols'], MIN_COLS, MAX_COLS);
    const rows = parseDimension(raw['rows'], MIN_ROWS, MAX_ROWS);
    if (cols === null || rows === null) return invalidBody(c);
    try {
      deps.terminal.resize(record.id, cols, rows);
      return c.body(null, 204);
    } catch (err) {
      return terminalErrorResponse(c, err);
    }
  });

  /**
   * POST /:id/restart — перезапуск завершённого терминала (PROP-132).
   *
   * Поднимается **новый** PTY с теми же `cwd`/`shell`/`cols`/`rows`; id
   * терминала сохраняется, буфер вывода очищается, статус — `running`,
   * признак `restored` снимается. Публикуется событие `terminal.updated`.
   *
   * Живой терминал перезапускать нельзя (вторая оболочка в том же каталоге
   * рассинхронила бы вывод) → `409 TERMINAL_ALREADY_RUNNING`.
   */
  app.post('/:id/restart', auth.requireAuth, enabledGuard, terminalGuard('write'), async (c) => {
    const record = guardedTerminal(c);
    try {
      const restarted = await deps.terminal.restart(record.id);
      const project = guardedProject(c);
      const cache = new Map<string, ProjectAccess>();
      const { write } = await projectAccessOf(c, project, cache);
      return c.json({
        terminal: toTerminalDto(restarted, {
          canWrite: write,
          attachedClients: deps.terminal.attachedClients(restarted.id),
        }),
      });
    } catch (err) {
      return terminalErrorResponse(c, err);
    }
  });

  return app;
}
