// --- Event types ---
import type { WorktreeUpdateAction } from './worktree.js';
import type {
  MessageAcceptedPayload,
  QueueStatePayload,
  MessageDeliveredPayload,
  MessageEnqueuedPayload,
  TurnStartedPayload,
  TurnFinishedPayload,
  StepStartedPayload,
  StepFinishedPayload,
  StepToolsPayload,
  PartDeltaPayload,
  PartUpdatedPayload,
} from './message-stream.js';

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
  // История сессии очищена (`POST /sessions/:id/clear`): остались только
  // закреплённые сообщения, очередь и счётчики сброшены. Канал сессии.
  | 'session.messages.cleared'
  | 'session.moved'
  | 'project.updated'
  // Проект удалён (`DELETE /projects/:id`): публикуется в каналы его сессий
  // **до** удаления, пока состав сессий ещё перечисляется.
  | 'project.deleted'
  // ADR-114: инвентарь git-worktree'ов проекта изменился (создан/удалён/
  // привязан/отвязан). Событие — в существующей шине (ADR-024), новых
  // транспортных каналов нет.
  | 'worktree.updated'
  | 'fs.changed'
  | 'message.added'
  | 'message.updated'
  // ADR-118 §4: события модели «ход как последовательность шагов».
  // `message.accepted` — адресное (по `BusEvent.recipient`), `queue.state` —
  // счётчики очереди без текста и автора, `message.delivered` — материализация
  // сообщения в истории, `turn.*`/`step.*`/`part.*` — состояние работы агента
  // (канал сессии). Удалённые без dual-emit события v1 (`stream.chunk`,
  // `stream.usage`, `stream.done`, `stream.interrupted`, `message.injected`,
  // `message.queued`) заменены этими — см. таблицу ADR-118 §«Удаляемые
  // события и их замена».
  | 'message.accepted'
  | 'queue.state'
  | 'message.delivered'
  // ADR-118 §4 (аддитивно): сообщение поставлено в очередь/очередь
  // вмешательств и ждёт материализации. Адресное событие со **снимком**
  // сообщения — чтобы лента показала реплику сразу, не дожидаясь
  // `message.delivered` (материализации в истории). `ord` у снимка нет:
  // он выдаётся только при записи в историю.
  | 'message.enqueued'
  // ADR-118 §4/§7: сообщение удалено из истории (`DELETE /messages/:sessionId/:messageId`
  // и batch `action: 'delete'`). Событие — в канале сессии, адресация по `id`
  // (мутации адресуются по id, §7); клиенты убирают сообщение из ленты.
  | 'message.deleted'
  | 'turn.started'
  | 'turn.finished'
  | 'step.started'
  | 'step.finished'
  // ADR-118 §4 (аддитивно): исполнение инструментов шага. `step.finished` —
  // «вызов LLM завершён», `step.tools.*` — «выполняются вызовы этого шага».
  | 'step.tools.started'
  | 'step.tools.finished'
  | 'part.delta'
  | 'part.updated'
  // ADR-104: форсированная отправка сообщения во время хода (steering).
  // `steer.dropped` — сообщение отброшено (лимит инъекций на ход).
  | 'steer.dropped'
  | 'child.message.added'
  | 'child.session.updated'
  | 'stream.start'
  | 'stream.ended'
  | 'stream.cancelled'
  | 'stream.error'
  | 'stream.retry'
  | 'queue.stalled'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.hold'
  | 'question.asked'
  | 'question.replied'
  | 'context.summarization_pending'
  | 'context.summarization_applied'
  // Провал сжатия контекста (ADR-128): сжатие не состоялось — ответ модели
  // не прошёл валидацию, сжатия было нечего делать или вызов упал. Payload:
  // `reason` (`validation`|`error`|`no_coverage`|`overflow`), `message`
  // (локализованный текст ошибки), `mode`, `phase?` (`mid_turn`|`overflow`).
  | 'context.summarization_failed'
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
  // ADR-039/ADR-118 §4: план проекта изменён (`plan_write`) — клиенты
  // перечитывают сессию (полный refresh). Канал сессии.
  | 'plan.updated'
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
  /**
   * ADR-118 §4/§«Гибрид и многопользовательский режим»: идентификатор
   * пользователя-получателя (адресная доставка). Поле отсутствует → broadcast
   * в канал сессии; `message.accepted` — адресное событие.
   */
  recipient?: string;
  /**
   * ADR-118 §«Событийная нумерация»: монотонный номер события **в пределах
   * инстанса** (сквозной по всем сессионным каналам) — по нему работает догон
   * (`Last-Event-ID` / `?since`). Инстансный канал (`pipeline.run.*`) номера
   * не получает.
   */
  eventSeq?: number;
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

// --- ADR-118: payload'ы новых событий модели «ход как последовательность шагов ---
//
// Алиасы (не интерфейсы): алиас объекта получает неявную index-signature и
// потому assignable к `Record<string, unknown>` — payload шины
// (`EventBus.publish`) именно такой тип. Определения — в
// `./message-stream.js` (browser-safe модуль контракта ADR-118).

/** Payload события `message.accepted` (ADR-118 §4) — адресное событие. */
export type MessageAcceptedEventData = MessageAcceptedPayload;

/** Payload события `queue.state` (ADR-118 §4) — только счётчики. */
export type QueueStateEventData = QueueStatePayload;

/** Payload события `message.delivered` (ADR-118 §4) — материализация в истории. */
export type MessageDeliveredEventData = MessageDeliveredPayload;

/** Payload события `message.enqueued` (ADR-118 §4) — адресное, со снимком сообщения. */
export type MessageEnqueuedEventData = MessageEnqueuedPayload;

/** Payload события `turn.started` (ADR-118 §4) — ход начался. */
export type TurnStartedEventData = TurnStartedPayload;

/** Payload события `turn.finished` (ADR-118 §4) — ход завершён. */
export type TurnFinishedEventData = TurnFinishedPayload;

/** Payload события `step.started` (ADR-118 §4) — шаг начался. */
export type StepStartedEventData = StepStartedPayload;

/** Payload события `step.finished` (ADR-118 §4/§5) — шаг завершён. */
export type StepFinishedEventData = StepFinishedPayload;

/** Payload событий `step.tools.started`/`step.tools.finished` (ADR-118 §4). */
export type StepToolsEventData = StepToolsPayload;

/** Payload события `part.delta` (ADR-118 §4) — дельта части (upsert). */
export type PartDeltaEventData = PartDeltaPayload;

/** Payload события `part.updated` (ADR-118 §4) — часть обновлена (upsert). */
export type PartUpdatedEventData = PartUpdatedPayload;

/** Payload события `message.deleted` (ADR-118 §4/§7) — удалённое сообщение. */
export type MessageDeletedEventData = {
  /** id удалённого сообщения (мутации адресуются по id, ADR-118 §7). */
  message_id: string;
};

/** Payload события `message.updated` (ADR-118 §4) — состояние сообщения изменилось. */
export type MessageUpdatedEventData = {
  /** id изменённого сообщения. */
  message_id: string;
  /** Новое значение `pinned` (событие приходит от pin/batch pin). */
  pinned?: boolean;
  /** Новое значение `disabled` (toggle/batch toggle/retry). */
  disabled?: boolean;
};

/** Payload события `session.messages.cleared` — история очищена, кроме закреплённых. */
export type SessionMessagesClearedEventData = {
  session_id: string;
};

/** Payload событий `project.updated`/`project.deleted` — проект сессии изменился. */
export type ProjectChangedEventData = {
  project_id: string;
};
