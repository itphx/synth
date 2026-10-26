/**
 * HTTP-контур единого реестра фоновых прогонов (PROP-096/097).
 *
 * Обслуживает оба вида фоновой работы: фоновые саб-агенты (`kind:'subagent'`)
 * и фоновые шелл-процессы (`kind:'process'`). Записи реестра живут в порте
 * `BackgroundRunRepository` (ADR-096), «живые» хэндлы отмены — в сервисе
 * `BackgroundRunService`, логи процессов — в `ProcessService` (PROP-097).
 *
 * ## Граница доступа (инвариант 16)
 *
 * Доступ к прогону проверяется **на границе**: guard `processGuard` резолвит
 * запись и её сессию-владельца ОДИН раз, проверяет право через `isAllowed` и
 * кладёт запись в контекст Hono (`guardedProcess`). В обработчиках проверок
 * доступа нет — иначе правила разошлись бы (как с ложным 403 у `LEAD`).
 * Вид доступа — по HTTP-методу (`read` — чтение, `write` — мутация): участник
 * проекта с ролью просмотра (`VIEWER`) читает прогон, но не может его
 * остановить или удалить (инвариант 21).
 *
 * ## Список
 *
 * Список прогонов фильтруется по доступу к сессии-владельцу: запись, чью
 * сессию не видно, в выдаче не появляется вовсе (сессии нет — запись тоже
 * скрыта). Сессии кэшируются на один запрос (`Map`), а не на процесс: права
 * меняются, кэш процесса раздавал бы устаревшие решения.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type {
  BackgroundRunKind,
  BackgroundRunRecord,
  BackgroundRunStatus,
  Session,
} from '@itphx/synth-shared';
import type { BackgroundRunRepository } from '../../storage/ports/background-run-repository.js';
import type { BackgroundRunService } from '../../engine/background/service.js';
import type { ProcessService } from '../../engine/processes/service.js';
import type { SessionManager } from '../../sessions/manager.js';
import { accessKindOf, createSessionAccessPredicate } from '../session-access-guard.js';
import type { SessionAccessKind, SessionAccessPredicate } from '../session-access-guard.js';
import type { LocalOwnerResolver } from '../local-owner.js';
import { LOCAL_USER_ID } from '../local-owner.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface ProcessRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения (core — русские литералы, backend — i18n). */
export interface ProcessRouteMessages {
  /** Прогон не найден (404). */
  runNotFound: (c: Context) => string;
  /** Сессия-владелец прогона не найдена (404). */
  sessionNotFound: (c: Context) => string;
  /** Нет доступа к прогону (403). */
  forbidden: (c: Context) => string;
  /** Некорректный фильтр/параметр запроса (400). */
  invalidQuery: (c: Context) => string;
  /** Лог есть только у фоновых процессов (400). */
  invalidKind: (c: Context) => string;
  /** Файл лога не найден (404). */
  logNotFound: (c: Context) => string;
  /** Прогон уже завершён — останавливать нечего (409). */
  alreadyFinished: (c: Context) => string;
  /** Прогон не контролируется этим инстансом — остановить нельзя (409). */
  notStoppable: (c: Context) => string;
  /** Прогон ещё выполняется — удалять нельзя (409). */
  runActive: (c: Context) => string;
}

/** Сообщения по умолчанию (core — русские литералы). */
const DEFAULT_MESSAGES: ProcessRouteMessages = {
  runNotFound: () => 'Фоновый прогон не найден',
  sessionNotFound: () => 'Сессия фонового прогона не найдена',
  forbidden: () => 'Доступ запрещён',
  invalidQuery: () => 'Некорректные параметры запроса',
  invalidKind: () => 'Логи доступны только для фоновых процессов',
  logNotFound: () => 'Лог фонового процесса не найден',
  alreadyFinished: () => 'Фоновый прогон уже завершён',
  notStoppable: () => 'Фоновый прогон не контролируется этим инстансом',
  runActive: () => 'Фоновый прогон ещё выполняется',
};

/** Зависимости фабрики: порт реестра (ADR-096) + сервисы фоновой работы. */
export interface ProcessRoutesDeps {
  /** Порт реестра фоновых прогонов (ADR-096) — источник истины. */
  backgroundRuns: BackgroundRunRepository;
  /** Сервис реестра фоновых прогонов (PROP-096/097) — остановка прогона. */
  background: BackgroundRunService;
  /** Сервис фоновых шелл-процессов (PROP-097) — чтение лога. */
  processes: ProcessService;
  /** Загрузка сессии-владельца прогона (нужна для проверки доступа). */
  sessionManager: Pick<SessionManager, 'getSession'>;
}

export interface ProcessRoutesOptions {
  /**
   * Правило доступа к прогону (через сессию-владельца): владелец →
   * роль → участие в проекте. По умолчанию — standalone-предикат
   * (`createSessionAccessPredicate`): владелец `local` или сессия без
   * владельца.
   */
  isAllowed?: SessionAccessPredicate;
  /** userId запроса (core — `local`, backend — id из AuthKit). */
  resolveUserId?: (c: Context) => string | Promise<string>;
  /**
   * ADR-089 (standalone): нормализация legacy-владельца локального профиля
   * (UUID `ProfileData.id`) к `local` — иначе такие сессии были бы не видны
   * в списке прогонов.
   */
  localOwnerResolver?: LocalOwnerResolver;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<ProcessRouteMessages>;
  /**
   * Предел размера выдачи лога за один запрос, байт (по умолчанию 64 КиБ).
   *
   * Значение может только **уменьшить** жёсткий потолок `MAX_LOG_LIMIT`
   * (256 КиБ) — поднять его нельзя: иначе клиент утащил бы весь лог.
   * Не путать с `background.logMaxBytes` — это потолок **записи** лога.
   */
  maxLogBytes?: number;
}

/** Статусы фонового прогона (валидация фильтра `status`). */
const RUN_STATUSES: readonly BackgroundRunStatus[] = [
  'running',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
];

/** Виды фоновой работы (валидация фильтра `kind`). */
const RUN_KINDS: readonly BackgroundRunKind[] = ['subagent', 'process'];

/** Потолок выборки списка прогонов. */
const MAX_LIST_LIMIT = 200;
/** Потолок выдачи лога за один запрос, байт. */
const MAX_LOG_LIMIT = 262_144;

/**
 * Разбор числового параметра выборки: мусор → дефолт, излишек → потолок.
 *
 * Неизвестное значение не должно ломать выдачу: клиент безобидно спрашивает
 * «дай побольше» — сервер отдаёт столько, сколько уместно.
 */
function parseBoundedInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * HTTP-фабрика единого реестра фоновых прогонов (core + backend).
 *
 * Маршруты (все под `auth.requireAuth`):
 * - `GET /` — список прогонов (фильтры `sessionId`/`projectId`/`kind`/
 *   `status`/`limit`; выдача фильтруется по доступу к сессии-владельцу);
 * - `GET /:id` — деталь прогона;
 * - `GET /:id/logs` — отрезок лога фонового процесса;
 * - `POST /:id/stop` — остановить прогон;
 * - `DELETE /:id` — удалить терминальную запись реестра.
 */
export function createProcessRoutes(
  auth: ProcessRoutesAuth,
  deps: ProcessRoutesDeps,
  opts: ProcessRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: ProcessRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const maxLogBytes = Math.max(1, Math.min(opts.maxLogBytes ?? MAX_LOG_LIMIT, MAX_LOG_LIMIT));
  /**
   * Правило доступа к прогону — по доступу к сессии-владельцу. Core —
   * standalone-предикат (единственный пользователь инстанса); backend
   * передаёт правило проекта (владелец|ADMIN + участие в проекте).
   */
  const isAllowed =
    opts.isAllowed ??
    createSessionAccessPredicate({
      localUserId: LOCAL_USER_ID,
      ...(opts.localOwnerResolver ? { localOwnerResolver: opts.localOwnerResolver } : {}),
    });
  const resolveUserId = opts.resolveUserId ?? (() => LOCAL_USER_ID);

  /** Единый ответ об отказе в доступе (fail-closed). */
  const forbidden = (c: Context) =>
    c.json({ error: { code: 'FORBIDDEN', message: messages.forbidden(c) } }, 403);

  /** Прогон не найден (404). */
  const notFoundRun = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.runNotFound(c) } }, 404);

  /** Сессия-владелец прогона не найдена (404). */
  const notFoundSession = (c: Context) =>
    c.json({ error: { code: 'NOT_FOUND', message: messages.sessionNotFound(c) } }, 404);

  /** 400 — некорректный параметр запроса. */
  const invalidQuery = (c: Context) =>
    c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidQuery(c) } }, 400);

  /** 409 — конфликт состояния прогона. */
  const conflict = (c: Context, message: string) =>
    c.json({ error: { code: 'CONFLICT', message } }, 409);

  /** Ключ контекста: запись прогона, разрезолвленная граничным guard'ом. */
  const PROCESS_KEY = 'guardedProcess';

  /**
   * ГРАНИЧНАЯ проверка доступа к прогону (инвариант 16): guard резолвит
   * запись и её сессию-владельца ОДИН раз и кладёт запись в контекст;
   * обработчик берёт запись ТОЛЬКО отсюда.
   *
   * `access` — вид доступа: `read` (чтение) или `write` (остановка/удаление).
   * Если вид не задан — выводится из HTTP-метода (`accessKindOf`).
   */
  const processGuard = (access?: SessionAccessKind): Middleware =>
    createMiddleware(async (c, next) => {
      const kind = access ?? accessKindOf(c.req.method);
      const id = c.req.param('id');
      const record = id ? await deps.backgroundRuns.get(id) : null;
      if (!record) return notFoundRun(c);
      // Сессия-владелец — источник права на прогон. Её нет — прогон не виден.
      const session = await deps.sessionManager.getSession(record.sessionId);
      if (!session) return notFoundSession(c);
      const userId = await resolveUserId(c);
      if (!(await isAllowed(session, c, userId, kind))) return forbidden(c);
      c.set(PROCESS_KEY as never, record as never);
      await next();
    });

  /** Запись прогона из контекста guard'а (единственный источник — инвариант 16). */
  const guardedProcess = (c: Context): BackgroundRunRecord =>
    c.get(PROCESS_KEY as never) as BackgroundRunRecord;

  // GET / — список фоновых прогонов.
  app.get('/', auth.requireAuth, async (c) => {
    const sessionId = c.req.query('sessionId')?.trim() || undefined;
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const rawKind = c.req.query('kind')?.trim();
    const rawStatus = c.req.query('status')?.trim();

    let kind: BackgroundRunKind | undefined;
    if (rawKind) {
      if (!RUN_KINDS.includes(rawKind as BackgroundRunKind)) return invalidQuery(c);
      kind = rawKind as BackgroundRunKind;
    }
    let status: BackgroundRunStatus | undefined;
    if (rawStatus) {
      if (!RUN_STATUSES.includes(rawStatus as BackgroundRunStatus)) return invalidQuery(c);
      status = rawStatus as BackgroundRunStatus;
    }

    const limit = parseBoundedInt(c.req.query('limit'), 50, MAX_LIST_LIMIT);
    const records = await deps.backgroundRuns.list({
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(projectId ? { projectId } : {}),
      limit,
    });

    // Фильтрация по доступу к сессии-владельцу (инвариант 16): запись, чью
    // сессию не видно, в выдаче не появляется. Кэш сессий — на один запрос.
    const userId = await resolveUserId(c);
    const sessions = new Map<string, Session | null>();
    const visible: BackgroundRunRecord[] = [];
    for (const record of records) {
      let session = sessions.get(record.sessionId);
      if (session === undefined) {
        session = await deps.sessionManager.getSession(record.sessionId);
        sessions.set(record.sessionId, session);
      }
      if (!session) continue;
      if (!(await isAllowed(session, c, userId, 'read'))) continue;
      visible.push(record);
    }
    return c.json({ runs: visible });
  });

  // GET /:id/logs — отрезок лога фонового процесса.
  //
  // Регистрируется ДО `/:id` (статический сегмент раньше параметрического).
  app.get('/:id/logs', auth.requireAuth, processGuard('read'), async (c) => {
    const record = guardedProcess(c);
    if (record.kind !== 'process') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: messages.invalidKind(c) } }, 400);
    }
    const offset = parseBoundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
    const limit = parseBoundedInt(c.req.query('limit'), maxLogBytes, maxLogBytes);
    const logs = await deps.processes.logs(record.id, { offset, limit });
    if (!logs) {
      return c.json({ error: { code: 'NOT_FOUND', message: messages.logNotFound(c) } }, 404);
    }
    return c.json(logs);
  });

  // GET /:id — деталь фонового прогона.
  app.get('/:id', auth.requireAuth, processGuard('read'), async (c) => {
    return c.json({ run: guardedProcess(c) });
  });

  // POST /:id/stop — остановить прогон.
  app.post('/:id/stop', auth.requireAuth, processGuard('write'), async (c) => {
    const record = guardedProcess(c);
    const stopped = await deps.background.stop(record.id);
    if (!stopped) {
      // Хэндла отмены нет: прогон уже завершён либо выполняется в другом
      // процессе (тогда отменить его отсюда нельзя).
      return conflict(
        c,
        record.status === 'running' ? messages.notStoppable(c) : messages.alreadyFinished(c),
      );
    }
    return c.json({ status: 'stopping' });
  });

  // DELETE /:id — удалить запись реестра (только терминальная).
  app.delete('/:id', auth.requireAuth, processGuard('write'), async (c) => {
    const record = guardedProcess(c);
    if (record.status === 'running') {
      return conflict(c, messages.runActive(c));
    }
    await deps.backgroundRuns.remove(record.id);
    return c.body(null, 204);
  });

  return app;
}
