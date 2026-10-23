// ADR-106 Ф4 (шаг C): смена режима сессии — решение на ГРАНИЦЕ, а не в
// обработчике (инвариант 16 корневого AGENTS.md).
//
// Доступ к сессии (403/404) решает ЕДИНЫЙ prefix-guard
// (`session-access-guard.ts`) — вид доступа выводится из HTTP-метода. Этот
// guard решает ВТОРУЮ, отдельную привилегию: **кому и в чьём поле** можно
// менять режим сессии.
//
// Правила (ADR-106 §«Многопользовательская сессия»):
//
// - участников нет или один (standalone `local`, личная сессия) → режим
//   меняется **для сессии** — прежнее поведение;
// - участников несколько → режим меняется **только у того, кто его выставил**
//   (`Session.modeByPrincipal`): чужие ходы не меняются, `yolo` одного
//   участника не снимает подтверждения у другого;
// - право менять: участник с мутирующей ролью (`owner`/`editor`); `viewer` —
//   не может (инвариант 21: право чтения не расширяет права на изменение),
//   неучастник — не может (fail-closed);
// - сквозной доступ (ADMIN/LEAD) — режим меняется для сессии (их доступ к
//   чужим сессиям — осознанное решение, матрица IDOR).
//
// Guard только решает и кладёт решение в контекст Hono; обработчик
// `PATCH /sessions/:id` применяет режим по решению (второй копии правил в
// обработчике нет).

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { Session, SessionParticipant } from '@itphx/synth-shared';

import {
  decideSessionModeScope,
  type SessionModeScope,
} from '../engine/authority/mode.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Ключ в контексте Hono, где лежит решение guard'а смены режима. */
export const SESSION_MODE_CONTEXT_KEY = 'sessionMode';

/** Решение guard'а смены режима сессии. */
export interface SessionModeDecision {
  /** Область применения режима (общий режим сессии или режим принципала). */
  scope: SessionModeScope;
  /** Участники сессии (снимок на момент решения). */
  participants: SessionParticipant[];
}

/** Локализуемые сообщения guard'а смены режима. */
export interface SessionModeMessages {
  sessionNotFound: (c: Context) => string;
  forbidden: (c: Context) => string;
}

export interface SessionModeGuardOptions {
  /** Имя path-параметра с id сессии (`id` в sessions). */
  param?: string;
  /** Загрузка сессии по id (обычно `sessionManager.getSession`). */
  resolveSession: (id: string) => Promise<Session | null>;
  /** id пользователя запроса (core — `local`; backend — id из AuthKit). */
  resolveUserId: (c: Context) => string | Promise<string>;
  /**
   * Участники сессии (снимок): выводятся из сессии и проекта
   * (`engine/authority/participants.ts`). Не заданы — участников нет
   * (прежнее поведение: режим меняется для сессии).
   */
  resolveParticipants?: (
    session: Session,
  ) => Promise<SessionParticipant[]> | SessionParticipant[];
  /** Сквозной доступ инстанса (ADMIN/LEAD) — режим меняется для сессии. */
  resolveElevated?: (c: Context) => boolean | Promise<boolean>;
  messages: SessionModeMessages;
  /**
   * id, для которых локальная проверка невозможна (remote-ref `remote:<uuid>`) —
   * запрос пропускается: режим меняет удалённая сторона.
   */
  skipForId?: (id: string) => boolean;
}

/**
 * Тело запроса (для проверки «меняется ли режим»). Тело оригинала не
 * consumed — читается копия (`Request.clone()`), поэтому обработчик может
 * разобрать его как обычно.
 */
async function readRequestBody(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = c.req.raw;
    if (!raw.body) return undefined;
    const parsed = (await raw.clone().json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Guard уровня маршрута для смены режима сессии: решает, **чью** сессию
 * меняет режим, и кладёт решение в контекст Hono
 * (`SESSION_MODE_CONTEXT_KEY`).
 *
 * Работает только для запросов, которые **меняют режим** (в теле есть
 * `mode`): прочие изменения сессии (имя, иконка, настройки) этим правилом не
 * регулируются.
 */
export function createSessionModeGuard(opts: SessionModeGuardOptions): Middleware {
  const param = opts.param ?? 'id';
  return createMiddleware(async (c, next) => {
    const id = c.req.param(param);
    if (!id || opts.skipForId?.(id)) {
      await next();
      return;
    }
    const body = await readRequestBody(c);
    if (!body || body.mode === undefined) {
      // Режим не меняется — правило смены режима не применяется.
      await next();
      return;
    }
    const session = await opts.resolveSession(id);
    if (!session) {
      return c.json({ error: { code: 'NOT_FOUND', message: opts.messages.sessionNotFound(c) } }, 404);
    }
    const userId = await opts.resolveUserId(c);
    const participants = (await opts.resolveParticipants?.(session)) ?? [];
    const elevated = (await opts.resolveElevated?.(c)) ?? false;
    const decision = decideSessionModeScope({ participants, userId, elevated });
    if (!decision.allowed) {
      return c.json({ error: { code: 'FORBIDDEN', message: opts.messages.forbidden(c) } }, 403);
    }
    c.set(SESSION_MODE_CONTEXT_KEY as never, {
      scope: decision.scope,
      participants,
    } as SessionModeDecision as never);
    await next();
  });
}

/**
 * Решение guard'а смены режима из контекста Hono. `undefined` — guard не
 * отработал (режим не меняется либо маршрут зарегистрирован без него).
 */
export function getSessionModeDecision(c: Context): SessionModeDecision | undefined {
  return c.get(SESSION_MODE_CONTEXT_KEY as never) as SessionModeDecision | undefined;
}
