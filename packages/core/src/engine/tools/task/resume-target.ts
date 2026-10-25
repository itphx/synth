/**
 * Общие помощники продолжения дочерней сессии саб-агента (этап 1 roadmap 0.13 —
 * блок 4, п. 5: `task_id`).
 *
 * Логика «загрузить ребёнка → проверить → добавить маркер → собрать историю»
 * нужна **двум** путям:
 *  - HTTP-resume прерванного ребёнка (`task-resume.ts`, ADR-089 B2);
 *  - продолжение ребёнка **из тула** `task` (`task_id`) — синхронно, в текущем
 *    ходе родителя.
 *
 * Поэтому она вынесена сюда и не дублируется (ADR-095: разрез по швам).
 */
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message, Session } from '@itphx/synth-shared';
import type { LLMMessage } from '../../../providers/base.js';
import type { SessionManager } from '../../../sessions/manager.js';
import type { EventBus } from '../../../events/bus.js';
import { t as sm, i18n as i18nMeta } from '../../system-messages.js';
import { publishMessageAdded } from './child-session.js';
import { messageToLLMMessage } from './prompt.js';

/** Коды ошибок resume — route маппит их в HTTP-статусы (400/404/409). */
export type SubagentResumeErrorCode =
  | 'NOT_FOUND'
  | 'NO_PARENT'
  | 'PARENT_NOT_FOUND'
  | 'LOCKED'
  | 'AGENT_NOT_FOUND'
  | 'NO_PROVIDER';

export class SubagentResumeError extends Error {
  constructor(
    readonly code: SubagentResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubagentResumeError';
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'NOT_FOUND': return 404;
      case 'LOCKED': return 409;
      default: return 400;
    }
  }
}

/**
 * Загрузить дочернюю сессию для продолжения и проверить её состояние.
 *
 * Проверки: сессия существует, у неё есть родитель, она не заблокирована и не
 * активна (`currentStream`). Бросает `SubagentResumeError`.
 */
export async function loadResumeChild(
  sessionManager: SessionManager,
  childSessionId: string,
): Promise<Session> {
  const child = await sessionManager.getSession(childSessionId);
  if (!child) {
    throw new SubagentResumeError('NOT_FOUND', sm('task.resume_session_not_found', { id: childSessionId }));
  }
  if (!child.parentId) {
    throw new SubagentResumeError('NO_PARENT', sm('task.resume_no_parent', { id: childSessionId }));
  }
  if (child.status.blocked || child.currentStream) {
    throw new SubagentResumeError('LOCKED', sm('task.resume_locked', { id: childSessionId }));
  }
  return child;
}

/**
 * Добавить synthetic user-маркер продолжения в историю дочерней сессии.
 *
 * Маркер восстанавливает контекст для LLM (ADR-089 B2). Возвращает обновлённую
 * сессию (с маркером) — её история идёт в LLM.
 */
export async function appendResumeMarker(
  sessionManager: SessionManager,
  eventBus: EventBus | undefined,
  opts: { child: Session; parentSessionId: string; streamId: string },
): Promise<Session> {
  const { child, parentSessionId, streamId } = opts;
  const markerText = sm('task.resume_marker');
  const markerMsg: Message = {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(markerText)],
    content: markerText,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: {
      resume: true,
      stream_id: streamId,
      i18n: i18nMeta('task.resume_marker'),
    },
  };
  const updated = await sessionManager.addMessage(child.id, markerMsg);
  if (updated && eventBus) {
    const idx = updated.messages.length - 1;
    await publishMessageAdded(eventBus, parentSessionId, child.id, updated.messages[idx]!, idx, updated);
  }
  return updated ?? child;
}

/**
 * История дочерней сессии → LLM-сообщения (system добавит вызывающий).
 *
 * Скрытые и отключённые сообщения в контекст не идут.
 */
export function resumeInitialMessages(child: Session): LLMMessage[] {
  return child.messages
    .filter((m) => !m.hidden && !m.disabled)
    .map(messageToLLMMessage);
}
