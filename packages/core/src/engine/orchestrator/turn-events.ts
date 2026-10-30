/**
 * ADR-118 §1/§4: события модели «ход как последовательность шагов».
 *
 * Единая точка публикации `turn.*`/`step.*`/`part.*` и идентификаторов
 * частей — иначе разъезжаются `partId` (детерминированные: `msg:text:N`
 * для текста, `msg:reasoning:N` для рассуждений, `callId` для вызова
 * инструмента) и payload'ы событий.
 *
 * Заменяет удалённые без dual-emit события v1 (ADR-118 §4):
 * - `stream.chunk` → `part.delta` (upsert по `{messageId, partId}`);
 * - `stream.usage` → `step.finished` (`usage`, `provider`, `model`, стоимость);
 * - `stream.done` → `step.finished` + `turn.finished`;
 * - `stream.interrupted` → `step.finished` со статусом `cancelled`.
 */
import type {
  MessageStatus,
  Part,
  PartDeltaPayload,
  PartUpdatedPayload,
  StepFinishedPayload,
  StepStartedPayload,
  TurnFinishedPayload,
  TurnStartedPayload,
} from '@itphx/synth-shared';

/** Публикация события в шину сессии (тот же шов, что `publishChunk`). */
export type PublishEvent = (event: string, data: Record<string, unknown>) => void;

/** Идентификатор текстовой части сообщения (ADR-118 §1). */
export function textPartId(ordinal: number): string {
  return `msg:text:${ordinal}`;
}

/** Идентификатор части рассуждений (ADR-118 §1). */
export function reasoningPartId(ordinal: number): string {
  return `msg:reasoning:${ordinal}`;
}

/** Идентификатор части вызова инструмента — `callId` провайдера (ADR-118 §1). */
export function toolCallPartId(callId: string): string {
  return callId;
}

/**
 * `callId` провайдера из данных части вызова инструмента.
 *
 * Часть приходит либо из стрима (сырые данные провайдера — `{id, type, function}`),
 * либо из legacy-разбора хранилища (`{name, args}` — там `callId` неизвестен).
 */
function toolCallIdOf(part: Part): string | undefined {
  const data = part.data as { id?: unknown } | null | undefined;
  return typeof data?.id === 'string' && data.id !== '' ? data.id : undefined;
}

/**
 * ADR-118 §1: детерминированные идентификаторы частей при персисте.
 *
 * Персист assistant-сообщения обязан выдавать те же `partId`, что и стрим
 * (`part.delta`/`part.updated`): клиент мержит части по id, поэтому случайный
 * id даёт две текстовые части одного ответа — текст отрисовывается дважды.
 *
 * Правила: текст — `msg:text:<ordinal>` (по порядку текстовых частей),
 * рассуждения — `msg:reasoning:<ordinal>`, вызов инструмента — `callId`
 * провайдера; остальные части (медиа ADR-115 и пр.) — без изменений.
 *
 * Функция идемпотентна: повторный вызов на уже размеченных частях ничего
 * не меняет.
 */
export function withDeterministicPartIds(parts: readonly Part[]): Part[] {
  let textOrdinal = 0;
  let reasoningOrdinal = 0;
  return parts.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'text') {
      return { ...part, id: textPartId(textOrdinal++) };
    }
    if (part.type === 'reasoning') {
      return { ...part, id: reasoningPartId(reasoningOrdinal++) };
    }
    if (part.type === 'tool_use') {
      const callId = toolCallIdOf(part);
      return callId ? { ...part, id: toolCallPartId(callId) } : part;
    }
    return part;
  });
}

/** `turn.started` — ход начался (реплика пользователя). */
export function publishTurnStarted(publish: PublishEvent, payload: TurnStartedPayload): void {
  publish('turn.started', { ...payload });
}

/** `turn.finished` — ход завершён терминальным статусом. */
export function publishTurnFinished(publish: PublishEvent, payload: TurnFinishedPayload): void {
  publish('turn.finished', { ...payload });
}

/** `step.started` — шаг (один вызов LLM) начался; создаётся его сообщение. */
export function publishStepStarted(publish: PublishEvent, payload: StepStartedPayload): void {
  publish('step.started', { ...payload });
}

/** `step.finished` — шаг завершён: статус сообщения + расход шага. */
export function publishStepFinished(publish: PublishEvent, payload: StepFinishedPayload): void {
  publish('step.finished', { ...payload });
}

/**
 * `part.delta` — дельта одной части сообщения.
 *
 * Доставка — **upsert** по `{messageId, partId}` (ADR-118 §«Идемпотентность
 * доставки»), поэтому клиент не различает «дописать» и «заменить».
 */
export function publishPartDelta(publish: PublishEvent, payload: PartDeltaPayload): void {
  publish('part.delta', { ...payload });
}

/** `part.updated` — часть сообщения обновлена целиком. */
export function publishPartUpdated(publish: PublishEvent, payload: PartUpdatedPayload): void {
  publish('part.updated', { ...payload });
}

/**
 * Часть вызова инструмента для `part.updated`.
 *
 * Данные — как их отдал провайдер (`{id, type:'function', function:{...}}`),
 * чтобы клиент собрал ту же карточку вызова, что и из истории.
 */
export function toolCallPart(callId: string, raw: Record<string, unknown>): Part {
  return { id: callId, type: 'tool_use', data: raw };
}

/**
 * Статус хода (`turn.finished`) по статусу финального сообщения.
 *
 * `limit`/`stopped` — ход остановлен без ошибки → `stopped`; `interrupted` —
 * генерация прервана, но ход продолжается → `completed`; остальное — как есть.
 */
export function turnStatusFromMessageStatus(status: string | undefined): TurnFinishedPayload['status'] {
  switch (status) {
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    case 'stopped':
    case 'limit':
      return 'stopped';
    default:
      return 'completed';
  }
}

/**
 * Статус сообщения шага (`step.finished`) по статусу финального сообщения.
 *
 * Статусы ядра (`completed`/`cancelled`/`stopped`/`error`/`limit`/
 * `interrupted`) сводятся к контракту ADR-118 (`streaming`/`completed`/
 * `cancelled`/`error`): «остановлен без ошибки» — это `completed` шага
 * (ошибки не было), терминальный статус хода несёт `stopped`.
 */
export function stepStatusFromMessageStatus(status: string | undefined): MessageStatus {
  switch (status) {
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    default:
      return 'completed';
  }
}
