/**
 * ADR-104: применение очереди инъекций (steering) на границе шага.
 *
 * Общая точка для двух циклов Tool Use, у которых ход ведёт провайдер:
 *   • оркестратор основной сессии (`ChatOrchestrator._applySteerInjections`);
 *   • цикл саб-агента (`engine/tools/task/run-cycle.ts` — дочерняя и фоновая
 *     сессия саб-агента, ADR-111).
 *
 * Семантика инъекции (лимит хода, порядок применения, маркеры, payload
 * событий) живёт здесь; различаются только способ доставки — канал событий,
 * маппинг сообщения в LLM и API персистентности — они вынесены в колбэки.
 */
import { MessageRole, MAX_STEER_INJECTIONS_PER_TURN, STEER_METADATA_KEY, STEERING_ERROR_CODES } from '@itphx/synth-shared';
import type { Message, MessageI18n } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';
import type { SessionManager } from '../../sessions/manager.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

/**
 * Payload события `message.injected` — инъекция применена на границе шага.
 * Type-alias (не interface): payloadassignable в `Record<string, unknown>`
 * (сигнатура `publishChunk`/шины).
 */
export type SteerInjectedEvent = {
  /** id стрима текущего хода. */
  stream_id?: string;
  /** Позиция сообщения в истории сессии (0-based) — как в `GET /:id/messages`. */
  message_index: number;
  /** id применённого сообщения. */
  message_id: string;
  /** Текст инъекции. */
  content: string;
  /** Автор ввода (кто вмешался). */
  author?: string;
  /** Роль агента-получателя. */
  agent_role?: string;
  /** Metadata применённого сообщения (в т.ч. маркеры `steer`/`interrupt`). */
  metadata?: Record<string, unknown>;
};

/** Payload события `steer.dropped` — превышен лимит инъекций на ход. */
export type SteerDroppedEvent = {
  reason: 'limit';
  /** Машинный код — тот же, что отдаёт API (429 STEER_LIMIT_EXCEEDED). */
  code: typeof STEERING_ERROR_CODES.limitExceeded;
  limit: number;
  dropped_count: number;
  error: string;
  i18n: MessageI18n;
};

/** Результат сохранения инъекции в истории сессии. */
export type SteerPersistedInjection = {
  /** Позиция сообщения в истории сессии (0-based). */
  index: number;
};

export interface SteerInjectionApplyOptions {
  /** Менеджер сессий — источник очереди инъекций (`steerInbox`). */
  sessionManager: SessionManager;
  /** Сессия-владелец очереди инъекций (основная или дочерняя). */
  sessionId: string;
  /** Контекст текущего хода (LLM-сообщения) — инъекция дописывается сюда. */
  llmMessages: LLMMessage[];
  /** Маппинг сохранённого сообщения в LLM-сообщения (может дать несколько). */
  toLlmMessages: (message: Message) => LLMMessage[];
  /** Сохранение сообщения в историю сессии → позиция в истории. */
  persist: (message: Message) => Promise<SteerPersistedInjection>;
  /** Публикация `message.injected` — инъекция применена. */
  publishInjected: (event: SteerInjectedEvent) => void;
  /** Публикация `steer.dropped` — превышен лимит инъекций на ход. */
  publishDropped: (event: SteerDroppedEvent) => void;
  /** id стрима текущего хода — попадает в metadata инъекции. */
  streamId?: string;
}

/**
 * Применить очередь инъекций на границе шага.
 *
 * Инъекция персистится как обычная `user`-реплика с `metadata.steer=true`
 * (автор и время сохраняются) — значит, она видна в истории и штатно идёт в
 * LLM-контекст следующих ходов. Текущий ход получает её через `llmMessages`.
 *
 * Порядок применения (ADR-104, этап 3) задаёт `takeSteerMessages`: сначала
 * класс `interrupt`, затем `steer`; внутри класса — FIFO.
 *
 * Превышение лимита инъекций на ход НЕ роняет ход: лишние сообщения
 * отбрасываются, о чём сообщает событие `steer.dropped`.
 */
export async function applySteerInjections(opts: SteerInjectionApplyOptions): Promise<void> {
  const {
    sessionManager, sessionId, llmMessages, toLlmMessages,
    persist, publishInjected, publishDropped, streamId,
  } = opts;

  const { messages, dropped } = await sessionManager.takeSteerMessages(
    sessionId,
    MAX_STEER_INJECTIONS_PER_TURN,
  );

  if (dropped.length > 0) {
    publishDropped({
      reason: 'limit',
      code: STEERING_ERROR_CODES.limitExceeded,
      limit: MAX_STEER_INJECTIONS_PER_TURN,
      dropped_count: dropped.length,
      error: sm('steer.limit_exceeded', { limit: String(MAX_STEER_INJECTIONS_PER_TURN) }),
      i18n: i18nMeta('steer.limit_exceeded', { limit: String(MAX_STEER_INJECTIONS_PER_TURN) }),
    });
  }

  for (const injected of messages) {
    const persisted: Message = {
      ...injected,
      role: MessageRole.USER,
      metadata: {
        ...(injected.metadata ?? {}),
        [STEER_METADATA_KEY]: true,
        stream_id: (injected.metadata?.stream_id as string) || streamId,
      },
    };
    const stored = await persist(persisted);

    // В контекст LLM — тем же маппингом, что и история сессии, чтобы
    // атрибуция совпадала.
    for (const llmMessage of toLlmMessages(persisted)) {
      llmMessages.push(llmMessage);
    }

    publishInjected({
      stream_id: streamId,
      message_index: stored.index,
      message_id: persisted.id,
      content: persisted.content,
      author: persisted.author,
      agent_role: persisted.agentRole,
      metadata: persisted.metadata,
    });
  }
}
