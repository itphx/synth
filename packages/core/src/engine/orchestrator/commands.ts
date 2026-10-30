/**
 * ADR-095 (шаг 6a): локальные ответы `/`-команд (ADR-046 §7).
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегации `_publishLocalCompletion`,
 * `_finishLocalCommand`.
 */
import type { Message, Session, TokenUsage } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import { i18n as i18nMeta } from '../system-messages.js';
// ADR-118 §4: локальный ответ — «шаг без вызова LLM»: свой ход и шаг 0.
import {
  publishPartDelta,
  publishStepFinished,
  publishStepStarted,
  publishTurnFinished,
  publishTurnStarted,
  textPartId,
} from './turn-events.js';

/**
 * ADR-046 §7.1: завершение локального ответа (builtin/команда/micro-first) теми
 * же событиями, что обычный стрим — иначе клиент не увидит ни хода, ни его
 * содержимого.
 *
 * ADR-118 §4: `stream.chunk`/`stream.done` удалены без dual-emit — локальный
 * ответ оформляется как **ход из одного шага**: `turn.started` → `step.started`
 * → `part.delta` (текст) → `step.finished` → `turn.finished`. Шаг «без вызова
 * LLM»: `stepIndex` = 0, у него свой `turnId`.
 */
export function publishLocalCompletion(
  publishChunk: (event: string, data: Record<string, unknown>) => void,
  streamId: string,
  content: string,
  opts?: {
    model?: string;
    provider?: string;
    usage?: TokenUsage;
    durationMs?: number;
    metadata?: Record<string, unknown>;
    /** ADR-046 §7.1: index/id сохранённого assistant-сообщения — UI не плодит копии. */
    messageIndex?: number;
    messageId?: string;
  },
): void {
  const turnId = `turn_${streamId}`;
  // Сообщение шага: id сохранённого ответа, иначе — детерминированный запасной
  // (микро-ответ сохраняется после публикации).
  const messageId = opts?.messageId ?? `msg_${streamId}`;
  publishTurnStarted(publishChunk, { turnId, messageId });
  publishStepStarted(publishChunk, { turnId, stepIndex: 0, messageId });
  if (content) {
    publishPartDelta(publishChunk, {
      messageId,
      partId: textPartId(0),
      field: 'text',
      delta: content,
    });
  }
  publishStepFinished(publishChunk, {
    turnId,
    stepIndex: 0,
    messageId,
    status: 'completed',
    ...(opts?.usage ? { usage: opts.usage } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.provider ? { provider: opts.provider } : {}),
  });
  publishTurnFinished(publishChunk, { turnId, status: 'completed' });
}

/** Зависимости `finishLocalCommand`. */
export interface FinishLocalCommandDeps {
  sessionManager: SessionManager;
  eventBus: EventBus;
  publishLocalCompletion: typeof publishLocalCompletion;
}

/**
 * Локальный ответ команды: user сообщение — `ephemeral`, ассистент — `ephemeral`.
 *
 * `command` (ADR-046 §7.1) — имя/аргументы системной (builtin) команды: уходят в
 * `metadata` ассистента, чтобы UI отрисовал нейтральный system-блок, а не ответ
 * агента (бейдж/статистику). `model`/`provider` = `command` — тот же признак для
 * live-стрима. Для `/summary`-нотиса (недоступна суммаризация) передаётся
 * `{ name: 'summary' }`.
 */
export async function finishLocalCommand(
  session: Session,
  userMessage: Message,
  publishChunk: (event: string, data: Record<string, unknown>) => void,
  output: string,
  streamId: string,
  command: { name: string; args?: string; i18nKey?: string } | undefined,
  deps: FinishLocalCommandDeps,
): Promise<{ error?: string; errorType?: string; canRetry?: boolean }> {
  // Признак команды для UI — и в сохранённом assistant-сообщении, и в
  // `stream.done.metadata`: локальный ответ приходит в UI через stream.done
  // (без `message.added`), поэтому без metadata оптимистичное сообщение
  // отрисовалось бы как ответ агента.
  const commandMetadata: Record<string, unknown> = {
    command: true,
    ...(command ? { commandName: command.name, commandArgs: command.args ?? '' } : {}),
    // ADR-041: строки движка локализуются в UI по `metadata.i18n`.
    ...(command?.i18nKey ? { i18n: i18nMeta(command.i18nKey) } : {}),
  };

  const assistant: Message = {
    id: generateId(),
    role: MessageRole.ASSISTANT,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(output)],
    content: output,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    ephemeral: true,
    model: 'command',
    provider: 'command',
    agentRole: userMessage.agentRole || session.settings.agentRole,
    metadata: commandMetadata,
  };

  // Помечаем пользовательское сообщение эфемерным и командным (`commandPrompt` —
  // UI не рисует отдельный user-пузырь: команда объединена с выводом) и сохраняем
  // ДО addMessage, иначе updateSession(session) перезапишет сессию без только что
  // добавленного ответа. Существующие metadata не затираем.
  userMessage.ephemeral = true;
  userMessage.metadata = { ...(userMessage.metadata ?? {}), commandPrompt: true };
  const idx = session.messages.findIndex((m) => m.id === userMessage.id);
  if (idx >= 0) {
    session.messages[idx] = {
      ...session.messages[idx]!,
      ephemeral: true,
      metadata: userMessage.metadata,
    };
  }
  await deps.sessionManager.updateSession(session).catch(() => {});

  // Сохраняем ответ и только потом публикуем завершение: нужны реальные
  // `message_index`/`message_id`, иначе UI в `finishStream` вычислит index
  // fallback'ом и столкнётся с user-командой (дубли ключей в списке).
  const updated = await deps.sessionManager.addMessage(session.id, assistant);
  const messageIndex = updated ? updated.messages.length - 1 : undefined;
  const userIndex = updated
    ? updated.messages.findIndex((m) => m.id === userMessage.id)
    : -1;

  // Обновляем user-команду в UI (upsert по index в `chatStore.addMessage`):
  // live `message.added` из процессора нёс metadata без `commandPrompt`,
  // поэтому без повторной публикации пузырь команды оставался видимым.
  if (userIndex >= 0) {
    deps.eventBus.publish(session.id, 'message.added', {
      message_index: userIndex,
      role: userMessage.role,
      content: userMessage.content ?? '',
      author: userMessage.author,
      agent_role: userMessage.agentRole,
      metadata: userMessage.metadata,
    });
  }

  deps.publishLocalCompletion(publishChunk, streamId, output, {
    model: 'command',
    provider: 'command',
    metadata: commandMetadata,
    messageIndex,
    messageId: assistant.id,
  });
  return {};
}
