// --- Event types ---
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
  | 'error';

export interface BusEvent {
  type: EventType;
  sessionId: string;
  data: Record<string, unknown>;
  timestamp: string;
}
