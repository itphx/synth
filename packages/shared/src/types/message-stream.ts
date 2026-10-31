/**
 * ADR-118 «Поток сообщений v2» — контрактная часть: модель хода
 * (Turn → Step → Part), контракт приёма сообщения и payload'ы новых событий
 * шины сессии.
 *
 * Модуль browser-safe: только типы и чистые функции, без node-зависимостей —
 * используется и в ядре, и в UI (сверка возможностей инстанса).
 *
 * Решения ADR-118, которые здесь закреплены:
 * - п. 3 — `POST /api/v2/sessions/:id/prompt` всегда отвечает `202
 *   {messageId, mode, position}` (см. `PromptAcceptedResponse`);
 * - п. 4 — набор новых событий (`message.accepted`/`queue.state`/
 *   `message.delivered`/`turn.*`/`step.*`/`part.*`) с payload'ами ниже;
 * - п. 5 — «финал» = смена статуса сообщения (`MessageStatus`), а не замена
 *   объекта;
 * - п. 8 — сверка возможностей клиента и сервера (fail-closed) через
 *   `GET /api/v2/meta` → `InstanceCapabilities`.
 */

import type { TokenUsage } from './llm.js';
import type { AuthorityPrincipal } from './authority.js';
import type { MessageRole, Part } from './message.js';

/**
 * ADR-118 §5: статус сообщения-хода. Assistant-сообщение создаётся на
 * `step.started` и живёт до `step.finished`; «финал» — это смена статуса.
 */
export type MessageStatus = 'streaming' | 'completed' | 'cancelled' | 'error';

/**
 * ADR-118 §3 / ADR-104: режим приёма сообщения.
 * - `queue` — по умолчанию: сообщение ждёт окончания текущего хода;
 * - `steer` — вмешательство в активный ход (применяется на границе шага);
 * - `interrupt` — прерывание генерации с продолжением того же хода.
 */
export type PromptMode = 'queue' | 'steer' | 'interrupt';

/**
 * ADR-118 §1: терминальный статус хода (`turn.finished`).
 * `stopped` — ход остановлен без ошибки (например, пустой содержательный ответ).
 */
export type TurnStatus = 'completed' | 'cancelled' | 'error' | 'stopped';

/**
 * ADR-118 §3: ответ `202` на `POST /api/v2/sessions/:id/prompt`.
 *
 * `position` — позиция в очереди; `null`, если сообщение уже материализовано
 * в истории (тогда `ord` уже выдан).
 */
export type PromptAcceptedResponse = {
  /** Идентификатор сообщения (выдаётся при приёме, ADR-118 §«Порядок»). */
  messageId: string;
  /** Режим приёма. */
  mode: PromptMode;
  /** Позиция в очереди либо `null` (сообщение уже в истории). */
  position: number | null;
};

/**
 * ADR-118 §4: payload адресного события `message.accepted`
 * (доставляется подписчику с `recipient === userId` отправителя).
 */
export type MessageAcceptedPayload = {
  messageId: string;
  mode: PromptMode;
  position: number | null;
};

/**
 * ADR-118 §4: payload события `queue.state` (канал сессии).
 * Несёт **только счётчики** — ни текста, ни автора (устранение утечки
 * `message.queued`).
 */
export type QueueStatePayload = {
  /** Сообщений в очереди. */
  pendingCount: number;
  /** Сообщений-вмешательств (`steer`/`interrupt`), ждущих применения. */
  steerCount: number;
};

/**
 * ADR-118 §4: payload события `message.delivered` (канал сессии) —
 * сообщение материализовано в истории сессии.
 */
export type MessageDeliveredPayload = {
  /** Идентификатор сообщения. */
  messageId: string;
  /** Монотонный порядок записи (`Message.ord`). */
  ord: number;
  /** Роль сообщения. */
  role: MessageRole;
  /** Автор (display-строка) — для видимости очереди/вмешательств. */
  author?: string;
  /** Принципал ввода (ADR-106) — машиночитаемая атрибуция. */
  principal?: AuthorityPrincipal;
};

/**
 * ADR-118 §1/§4: payload события `turn.started` (канал сессии) —
 * ход начался.
 */
export type TurnStartedPayload = {
  /** Идентификатор хода. */
  turnId: string;
  /** Сообщение, которым ход начат (реплика пользователя). */
  messageId: string;
};

/**
 * ADR-118 §1/§4: payload события `turn.finished` (канал сессии) —
 * ход завершён терминальным статусом.
 */
export type TurnFinishedPayload = {
  turnId: string;
  status: TurnStatus;
};

/**
 * ADR-118 §1/§4: payload события `step.started` (канал сессии) —
 * шаг (один вызов LLM) начался; assistant-сообщение создаётся здесь.
 */
export type StepStartedPayload = {
  turnId: string;
  /** Индекс шага внутри хода (0-based). */
  stepIndex: number;
  /** Сообщение шага. */
  messageId: string;
};

/**
 * ADR-118 §4: вложение ответа шага (ADR-115, outbound) — **метаданные**
 * объекта, без байтов. Шлюз (Telegram/VK) забирает байты по sha256
 * (`GET /api/v2/attachments/:sha256`) и не обращается к сессии.
 */
export type StepAttachmentRef = {
  /** SHA-256 содержимого (адрес объекта в контуре вложений). */
  sha256: string;
  /** MIME по содержимому. */
  mime: string;
  /** Размер в байтах. */
  size: number;
  /** Имя файла (санитайз), если известно. */
  name?: string;
};

/**
 * ADR-118 §4: тайминги шага — снимок счётчика чанков на момент финала шага.
 * Число чанков и моменты первого/последнего чанка (мс от старта хода).
 */
export type StepTimings = {
  /** Число чанков шага. */
  chunks: number;
  /** Мс от старта хода до первого чанка. */
  firstChunkMs?: number;
  /** Мс от старта хода до последнего чанка. */
  lastChunkMs?: number;
};

/**
 * ADR-118 §4/§5: payload события `step.finished` (канал сессии) —
 * шаг завершён: статус сообщения + учёт токенов.
 *
 * Аддитивные поля `provider`/`model`/`costUsd`/`costCurrency` — данные для
 * наблюдаемости (ADR-094): счётчика ретраев (`synth_llm_retries_total`) и
 * стоимости (`synth_llm_cost_total`) больше нечего читать из удалённого
 * `stream.usage`/`stream.done` — шаг несёт их сам (один шаг = один вызов LLM,
 * поэтому сумма по шагам равна стоимости хода).
 *
 * `attachments`/`debugInfo`/`timings`/`agentRole` — перенос данных удалённых
 * `stream.done` в шаг: вложения ответа (ADR-115), отладочные данные
 * (ADR-070), тайминги чанков и роль агента.
 */
export type StepFinishedPayload = {
  turnId: string;
  stepIndex: number;
  messageId: string;
  /** Статус сообщения шага («финал» = смена статуса, ADR-118 §5). */
  status: MessageStatus;
  /** Расход токенов шага (замена `stream.usage`). */
  usage?: TokenUsage;
  /** Провайдер шага — для метрик (ретраи/стоимость), ADR-094. */
  provider?: string;
  /** Модель шага — для метрик (ретраи), ADR-094. */
  model?: string;
  /** Стоимость шага (в валюте `costCurrency`) — для `synth_llm_cost_total`. */
  costUsd?: number;
  /** Валюта стоимости шага (по умолчанию — USD). */
  costCurrency?: string;
  /** Роль агента шага — атрибуция в UI/аналитике. */
  agentRole?: string;
  /** Вложения ответа шага (ADR-115, outbound) — метаданные без байтов. */
  attachments?: StepAttachmentRef[];
  /** Отладочные данные шага (ADR-070) — payload debug-коллектора. */
  debugInfo?: Record<string, unknown>;
  /** Тайминги шага (число чанков, моменты первого/последнего). */
  timings?: StepTimings;
};

/**
 * ADR-118 §4: payload события `part.delta` (канал сессии) —
 * дельта одной части сообщения. Доставка — **upsert** по
 * `{messageId, partId}`, а не append (ADR-118 §«Идемпотентность доставки»).
 */
export type PartDeltaPayload = {
  messageId: string;
  partId: string;
  /** Поле части, которого касается дельта. */
  field: 'text' | 'raw';
  delta: string;
};

/**
 * ADR-118 §4: payload события `part.updated` (канал сессии) —
 * часть сообщения обновлена целиком (upsert по `{messageId, partId}`).
 */
export type PartUpdatedPayload = {
  messageId: string;
  partId: string;
  part: Part;
};

/**
 * ADR-118 §8: версия модели сообщений/потока, которую понимает клиент.
 * Инстанс сообщает свою версию в `GET /api/v2/meta`
 * (`InstanceCapabilities.messageModel`).
 */
export const MESSAGE_MODEL_VERSION = 2;

/**
 * ADR-118 §8: имя query-параметра, которым клиент заявляет свою модель
 * сообщений (`GET /api/v2/events?messageModel=2`).
 *
 * Константа живёт в `shared`, потому что её знают и клиент (UI/SDK), и
 * сервер (гибридный мост `RemoteEventBridge`, `remote/event-bridge.ts`).
 */
export const MESSAGE_MODEL_QUERY_PARAM = 'messageModel';

/**
 * ADR-118 §8: возможности инстанса (`GET /api/v2/meta`).
 *
 * `messageModel` — версия модели сообщений; `eventSeq` — события нумеруются
 * глобально в пределах инстанса (догон по `Last-Event-ID`/`?since`); `replay` —
 * доступен догон по журналу событий; `version` — версия инстанса.
 */
export type InstanceCapabilities = {
  messageModel: number;
  eventSeq: boolean;
  replay: boolean;
  version: string;
};

/**
 * ADR-118 §8: поддерживает ли инстанс текущую модель сообщений.
 *
 * Сверка **fail-closed**: отсутствие поля `messageModel` (старый инстанс) или
 * иное значение → `false` (отказ подключения, а не тихая деградация).
 */
export function supportsMessageModel(
  capabilities: Partial<InstanceCapabilities> | null | undefined,
): boolean {
  return capabilities?.messageModel === MESSAGE_MODEL_VERSION;
}
