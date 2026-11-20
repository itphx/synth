/**
 * PROP-143: причина остановки хода — durable служебное сообщение в истории.
 *
 * Модуль — **нормализатор**: одна точка, где терминальная причина остановки
 * превращается в машиночитаемый конверт и в запись истории. Точки записи
 * (оркестратор, цикл сабагента, фоновые прогоны) подключают её позже —
 * здесь только формат, чтобы тексты не расходились между сценариями.
 *
 * Конверт — то, что видит модель:
 *
 * ```text
 * <execution_stopped reason="provider_error" error_type="rate_limit" retryable="true" attempts="3">
 * <текст провайдера>
 * </execution_stopped>
 * ```
 *
 * Тело: сырой текст провайдера (если он есть) иначе локализованный текст
 * по причине (`shared/i18n`, ADR-041). UI локализует подпись **по `reason`**,
 * поэтому i18n-метаданные в записи не нужны.
 */
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { t as sm } from './system-messages.js';

/** Маркер служебного сообщения остановки (`metadata.type`). */
export const STOP_MESSAGE_TYPE = 'execution_stopped';

/**
 * Нормализованная причина остановки хода.
 *
 * `provider_error` — сбой провайдера; `steps_limit` — исчерпан лимит шага;
 * `context_budget` — исчерпан предохранитель объёма промпта;
 * `stopped_by_user` — ход прерван человеком; `denied` — отказ прав;
 * `empty` — модель завершила ответ без содержимого (пустой финал, не успех);
 * `output_limit` — ответ остался обрезанным лимитом вывода после всех
 * продолжений (серия `finish: 'length'` исчерпана);
 * `internal` — внутренняя ошибка движка; `restart` — рестарт инстанса;
 * `orphaned` — прогон потерян.
 */
export type StopReason =
  | 'provider_error'
  | 'steps_limit'
  | 'context_budget'
  | 'stopped_by_user'
  | 'denied'
  | 'empty'
  | 'output_limit'
  | 'internal'
  | 'restart'
  | 'orphaned';

/** Вход нормализатора: причина + машинно-читаемые детали остановки. */
export interface StopRecordInput {
  /** Нормализованная причина остановки. */
  reason: StopReason;
  /** Тип ошибки провайдера (`classifyLlmError`) — `error_type` в конверте. */
  errorType?: string;
  /** Восстановима ли ошибка (повтор имеет смысл). */
  retryable?: boolean;
  /** Сделано попыток вызова провайдера. */
  attempts?: number;
  /** Всего попыток разрешено (лимит ретраев). */
  maxRetries?: number;
  /** Сырой текст ошибки провайдера — тело конверта (без локализации). */
  error?: string;
  /** Лимит шага (для `steps_limit`). */
  limit?: number;
  /** Оценка объёма промпта в токенах (для `context_budget`). */
  tokens?: number;
  /** Выполнено шагов (для `context_budget`). */
  steps?: number;
  /**
   * Нормализованная причина завершения ответа модели (`LlmFinishReason`:
   * `max_tokens`, `end_turn`, …) — для пустого финала объясняет, что именно
   * произошло (бюджет вывода исчерпан или модель «промолчала»).
   */
  finishReason?: string;
  /** Провайдер хода. */
  provider?: string;
  /** Модель хода. */
  model?: string;
  /** Роль агента хода. */
  agentRole?: string;
  /** Id хода (turn) — запись встаёт сразу после упавшего шага. */
  turnId?: string;
  /** Id потока (stream) хода. */
  streamId?: string;
  /**
   * Получен ли содержательный отчёт прогона к моменту остановки (для
   * `steps_limit`).
   *
   * Это **внутренняя метаинформация** для UI (пустой отчёт по лимиту шагов —
   * не провал прогона, но и отчёта нет): в конверт-сигнал модели она **не**
   * идёт — модель уже видит сам отчёт (или его отсутствие).
   */
  reportDelivered?: boolean;
}

/** Экранирование значения XML-атрибута (`&`, `<`, `>`, `"`). */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Локализованное тело конверта — по причине остановки.
 *
 * Тексты **нейтральны к типу сессии** (свои ключи `stop.*`): запись причины
 * остановки может лежать в основной сессии, и шаблон про «subagent» или
 * «отчёт модели отсутствует» был бы там неверным. Тексты провайдера здесь
 * нет: он приходит отдельно (`input.error`) и подставляется «как есть».
 */
function localizedBody(input: StopRecordInput): string {
  switch (input.reason) {
    case 'steps_limit':
      return sm('stop.steps_limit', { limit: String(input.limit ?? '-') });
    case 'context_budget':
      return sm('stop.context_budget', {
        tokens: String(input.tokens ?? '-'),
        steps: String(input.steps ?? '-'),
      });
    case 'stopped_by_user':
      return sm('stop.stopped_by_user');
    case 'denied':
      return sm('stop.denied');
    case 'empty':
      return sm('stop.empty');
    case 'output_limit':
      return sm('stop.output_limit');
    case 'restart':
      return sm('stop.restarted');
    case 'orphaned':
      return sm('stop.orphaned');
    case 'internal':
    case 'provider_error':
    default:
      return sm('stop.internal');
  }
}

/**
 * Конверт причины остановки — текст, который видит модель.
 *
 * Атрибут, у которого нет значения, опускается (нет «пустых» `error_type=""`).
 * Тело: сырой текст провайдера (`input.error`), иначе локализованный текст
 * по причине.
 */
export function renderStopEnvelope(input: StopRecordInput): string {
  const attrs: string[] = [`reason="${escapeXmlAttr(input.reason)}"`];
  if (input.errorType !== undefined) {
    attrs.push(`error_type="${escapeXmlAttr(input.errorType)}"`);
  }
  if (input.retryable !== undefined) {
    attrs.push(`retryable="${input.retryable ? 'true' : 'false'}"`);
  }
  if (input.attempts !== undefined) {
    attrs.push(`attempts="${input.attempts}"`);
  }
  if (input.finishReason !== undefined) {
    attrs.push(`finish_reason="${escapeXmlAttr(input.finishReason)}"`);
  }
  // Тело: сырой текст провайдера (`input.error`), иначе локализованный текст
  // по причине. Пустая строка — не «задан»: тело оставляем непустым.
  const body =
    input.error !== undefined && input.error !== ''
      ? input.error
      : localizedBody(input);
  return `<execution_stopped ${attrs.join(' ')}>\n${body}\n</execution_stopped>`;
}

/**
 * Служебная запись истории о причине остановки хода.
 *
 * `role: 'user'` — иначе причина не попадёт в контекст следующего хода;
 * `author: 'System'` — системный автор (как у `Timer`/`Process`).
 * Маркер `metadata.type = 'execution_stopped'` отличает запись от реплики
 * человека (`sessions/user-messages.ts`).
 */
export function buildStopRecord(input: StopRecordInput): Message {
  const content = renderStopEnvelope(input);
  const stoppedAt = nowISO();
  const metadata: Record<string, unknown> = {
    type: STOP_MESSAGE_TYPE,
    reason: input.reason,
    stopped_at: stoppedAt,
  };
  if (input.errorType !== undefined) metadata.error_type = input.errorType;
  if (input.retryable !== undefined) metadata.retryable = input.retryable;
  if (input.attempts !== undefined) metadata.attempts = input.attempts;
  if (input.maxRetries !== undefined) metadata.max_retries = input.maxRetries;
  if (input.finishReason !== undefined) metadata.finish_reason = input.finishReason;
  // Отчёт по лимиту шагов доставлен/нет — только metadata (UI), в конверт
  // (`renderStopEnvelope`) поле намеренно не попадает: для модели это не сигнал.
  if (input.reportDelivered !== undefined) metadata.report_delivered = input.reportDelivered;
  if (input.provider !== undefined) metadata.provider = input.provider;
  if (input.model !== undefined) metadata.model = input.model;
  if (input.agentRole !== undefined) metadata.agent_role = input.agentRole;
  if (input.turnId !== undefined) metadata.turn_id = input.turnId;
  if (input.streamId !== undefined) metadata.stream_id = input.streamId;

  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    author: 'System',
    createdAt: stoppedAt,
    disabled: false,
    pinned: false,
    hidden: false,
    ephemeral: false,
    metadata,
    // Id хода — на самом сообщении: сериализатор отдаёт из него `turn_id`,
    // а по нему лента группирует сообщения в блок хода. В `metadata.turn_id`
    // остаётся та же метка для аналитики.
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
  };
}
