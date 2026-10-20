// ADR-036 / security-фикс 0.11.3: решение по экспорту сессии — ОТДЕЛЬНЫЙ
// guard уровня маршрута, а НЕ проверка внутри обработчика.
//
// Доступ к сессии решает ЕДИНЫЙ prefix-guard (`session-access-guard.ts`,
// инвариант 16 корневого AGENTS.md): `app.use('/:id', …)` + `app.use('/:id/*', …)`,
// вид доступа `read`/`write` — из HTTP-метода. Этот guard решает ВТОРУЮ,
// отдельную привилегию — «карту обфускации LLM Gateway» (ADR-036):
//
// - **полный экспорт** (с `obfuscationMap` и `metadata.secrets`) — владелец
//   сессии (`ownerId ?? userId`), `ADMIN` и `AUDITOR` (тот же набор привилегий,
//   что у `GET /:id/secrets`);
// - **очищенный экспорт** (тот же разговор, но без карты) — остальным
//   читателям сессии (участник проекта `VIEWER`/`EDITOR`, владелец проекта,
//   `LEAD`): переносится разговор, который читатель и так видит в UI, но не
//   чужие секреты.
//
// Guard резолвит сессию, решает «полный или очищенный» и кладёт решение в
// контекст Hono; обработчик только форматирует ответ по этому решению. Проверок
// доступа в обработчике нет — иначе правило разошлось бы с общим guard'ом
// (иначе: ложный 403 у `LEAD`, «правило в двух местах»).
//
// Живой сценарий: `GET /api/v2/sessions/:id/export` (backend) и портативный
// экспорт проекта (`projects/portable.ts` — там очистку делает общий хелпер
// `stripSessionSecrets`).

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { Session } from '@itphx/synth-shared';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Ключ в контексте Hono, где лежит решение guard'а экспорта сессии. */
export const SESSION_EXPORT_CONTEXT_KEY = 'sessionExport';

/** Решение guard'а экспорта сессии. */
export interface SessionExportDecision {
  /** Сессия для выгрузки (объект хранилища, без преобразований). */
  session: Session;
  /** Полный экспорт (с картой обфускации) — `true`; очищенный — `false`. */
  withSecrets: boolean;
}

/** Локализуемые сообщения guard'а экспорта сессии. */
export interface SessionExportMessages {
  sessionNotFound: (c: Context) => string;
}

export interface SessionExportGuardOptions {
  /** Имя path-параметра с id сессии (`id` в sessions). */
  param?: string;
  /** Загрузка сессии по id (обычно `sessionManager.getSession`). */
  resolveSession: (id: string) => Promise<Session | null>;
  /** id пользователя запроса (core — `local`; backend — id из AuthKit). */
  resolveUserId: (c: Context) => string | Promise<string>;
  /**
   * Роль администратора инстанса (`ADMIN`) — полный экспорт. Не задана — роли
   * нет (fail-closed: только владелец получает полный экспорт).
   */
  isAdmin?: (c: Context) => boolean | Promise<boolean>;
  /**
   * Роль аудита инстанса (`AUDITOR`) — полный экспорт (тот же набор
   * привилегий, что у `GET /:id/secrets`). Не задана — роли нет.
   */
  isAuditor?: (c: Context) => boolean | Promise<boolean>;
  messages: SessionExportMessages;
}

/**
 * Признак маршрута экспорта сессии (`GET .../export`) — для правил доступа.
 *
 * Нужен там, где «кто читает сессию» отличается от общего правила ресурса:
 * роль аудита инстанса (`AUDITOR`) — читатель сессии именно на маршруте
 * экспорта (карта обфускации ЛЮБОЙ сессии ему и так доступна через
 * `GET /:id/secrets`). Знание о маршруте живёт здесь, рядом с самим guard'ом,
 * чтобы backend и standalone не расходились в трактовке пути.
 */
export function isSessionExportPath(path: string): boolean {
  return /\/export\/?$/.test(path);
}

/**
 * Guard уровня маршрута для экспорта сессии: резолвит сессию, решает «полный
 * экспорт или очищенный» и записывает решение в контекст Hono
 * (`SESSION_EXPORT_CONTEXT_KEY`).
 *
 * Доступ к сессии (403/404) этим guard'ом НЕ решается — это делает общий
 * prefix-guard сессий. Guard экспорта отвечает только за привилегию карты
 * обфускации.
 */
export function createSessionExportGuard(opts: SessionExportGuardOptions): Middleware {
  const param = opts.param ?? 'id';
  return createMiddleware(async (c, next) => {
    const id = c.req.param(param);
    if (!id) {
      await next();
      return;
    }
    const session = await opts.resolveSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: opts.messages.sessionNotFound(c) } }, 404);
    }
    const userId = await opts.resolveUserId(c);
    const owner = session.ownerId ?? session.userId;
    const isOwner = !!owner && owner === userId;
    const isAdmin = opts.isAdmin ? await opts.isAdmin(c) : false;
    const isAuditor = opts.isAuditor ? await opts.isAuditor(c) : false;
    const decision: SessionExportDecision = {
      session,
      withSecrets: isOwner || isAdmin || isAuditor,
    };
    c.set(SESSION_EXPORT_CONTEXT_KEY as never, decision as never);
    await next();
  });
}

/**
 * Решение guard'а экспорта из контекста Hono. `undefined` — guard не
 * отработал (маршрут зарегистрирован без него) — вызывающий обязан это
 * учесть (fail-closed, без «молчаливого» полного экспорта).
 */
export function getSessionExportDecision(c: Context): SessionExportDecision | undefined {
  return c.get(SESSION_EXPORT_CONTEXT_KEY as never) as SessionExportDecision | undefined;
}
