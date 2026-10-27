// --- Event types ---
import type { WorktreeUpdateAction } from './worktree.js';

export type EventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.renamed'
  | 'session.forked'
  | 'session.fork.created'
  | 'session.reference.added'
  | 'session.reference.removed'
  | 'session.messages.merged'
  | 'session.moved'
  | 'project.updated'
  // ADR-114: инвентарь git-worktree'ов проекта изменился (создан/удалён/
  // привязан/отвязан). Событие — в существующей шине (ADR-024), новых
  // транспортных каналов нет.
  | 'worktree.updated'
  | 'fs.changed'
  | 'message.added'
  | 'message.updated'
  // ADR-104: форсированная отправка сообщения во время хода (steering).
  // `message.injected` — инъекция применена на границе шага; `steer.dropped` —
  // сообщение отброшено (лимит инъекций на ход); `stream.interrupted` —
  // задел режима `interrupt` (этап 2), пока не эмитится.
  | 'message.injected'
  | 'steer.dropped'
  | 'stream.interrupted'
  | 'child.message.added'
  | 'child.session.updated'
  | 'stream.start'
  | 'stream.chunk'
  | 'stream.usage'
  | 'stream.done'
  | 'stream.ended'
  | 'stream.cancelled'
  | 'stream.error'
  | 'stream.retry'
  | 'queue.stalled'
  | 'message.queued'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.hold'
  | 'question.asked'
  | 'question.replied'
  | 'context.summarization_pending'
  | 'context.summarized'
  | 'context.sliding_window_applied'
  | 'context.limit_warning'
  | 'context.sticky_note_added'
  | 'context.sticky_note_updated'
  | 'context.sticky_note_deleted'
  | 'context.instructions_loaded'
  | 'tool_call.started'
  | 'tool_call.result'
  | 'tool_call.loop'
  | 'subagent.progress'
  | 'subagent.retry'
  | 'subagent.resume.started'
  | 'subagent.resume.finished'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.denied'
  | 'message.quality_check'
  | 'session.routing_category'
  | 'plan.approved'
  | 'todos.updated'
  | 'skill.invoked'
  | 'command.invoked'
  | 'command.inline_shell'
  | 'event.received'
  | 'event.routed'
  | 'binding.changed'
  // ADR-101 (Pipeline Engine): прогон пайплайна — инстансное собыдение
  // (не сессионное), публикуется в существующей шине; новых каналов нет.
  | 'pipeline.run.started'
  | 'pipeline.run.node_started'
  | 'pipeline.run.node_finished'
  | 'pipeline.run.awaiting_human'
  | 'pipeline.run.finished'
  | 'pipeline.run.failed'
  // ADR-101: выход пайплайна вида `gateway` — публикация наружу (ADR-052/ADR-087).
  | 'pipeline.completed'
  // Этап 1 roadmap 0.13 (блок 1.3): «вопрос пользователю». Префикс
  // `user_question.*` — намеренно НЕ `question.*`: `question.asked` уже занят
  // смыслом «очередь зависла» (см. выше).
  | 'user_question.asked'
  | 'user_question.answered'
  | 'user_question.cancelled'
  // Этап 1 roadmap 0.13 (блок 1.2): фоновые шелл-процессы (PROP-097).
  | 'process.started'
  | 'process.exited'
  | 'process.stopped'
  // ADR-111 §detach: идущий блокирующий прогон переведён в фон
  // (`POST /sessions/:id/background`). `process.started` при этом НЕ публикуется —
  // прогон уже шёл.
  | 'process.detached'
  // Этап 1 roadmap 0.13 (блок 1.2): фоновые дочерние сессии саб-агентов
  // (PROP-096).
  | 'child.started'
  | 'child.completed'
  | 'child.failed'
  | 'child.cancelled'
  | 'error';

export interface BusEvent {
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Payload события `worktree.updated` (ADR-114 §6) — инвентарь worktree'ов
 * проекта изменился.
 *
 * Событие идёт в **каналы сессий проекта** (инвентарь — ресурс проекта, а не
 * одной сессии), поэтому подписчики соседних сессий тоже видят изменение.
 * `action` позволяет отличить создание от удаления/привязки без чтения
 * инвентаря; `worktree_id` — конкретная запись (нет — для prune/sweep).
 *
 * Объявлен **type-алиасом** (не интерфейсом): алиас получает неявную
 * index-signature и потомуassignable к `Record<string, unknown>` — payload
 * шины (`EventBus.publish`) именно такой тип.
 */
export type WorktreeUpdatedPayload = {
  /** Проект-владелец инвентаря. */
  project_id: string;
  /** Id записи worktree (не задан — изменение по проекту целиком). */
  worktree_id?: string;
  /** Что произошло (ADR-114 §6). */
  action: WorktreeUpdateAction;
};
