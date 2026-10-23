/**
 * ADR-090: контракт фильтра LLM-вызовов.
 *
 * Модуль browser-safe (только типы и чистые функции) — его используют и ядро
 * (`GatewayProvider`), и будущий пакет `@itphx/synth-plugin`.
 *
 * **Границы контракта.**
 * - Вход фильтра — **узкий DTO**: ни портов, ни функций, ни внутренних полей
 *   сообщений (как `PromptBlockContext` в точке `promptBlocks`).
 * - Тип сообщения — `LlmFilterMessage`, а не `LLMMessage` из core
 *   (`packages/core/src/providers/base.ts`): контракт живёт в `shared`, а
 *   `LLMMessage` — внутренний тип ядра с полями служебного назначения
 *   (`branchId`/`pinned`/`usage`). Дублировать `LLMMessage` в `shared` нельзя —
 *   он разошёлся бы с ядром; поэтому фильтр видит только роль и текст.
 * - Поведение при сбое/таймауте задаёт `failMode`; **по умолчанию** — по
 *   классу фильтра: блокирующий (`closed`) — наблюдательный (`open`).
 * - **Право вето — только у доверенных**: фильтр с trust ниже `trusted` не
 *   может заблокировать или переписать вызов — хост понижает его вердикт до
 *   `allow` (ADR-090).
 */
import type { TokenUsage } from './llm.js';

/**
 * Фазы фильтра LLM-вызовов.
 *
 * - `pre_request` — до отправки запроса провайдеру (запрос уже обфусцирован);
 * - `post_response` — после ответа провайдера (наблюдение: буферизация ответа
 *   запрещена, ADR-036);
 * - `embedding` — перед вызовом эмбеддинга.
 */
export const LLM_FILTER_PHASES = ['pre_request', 'post_response', 'embedding'] as const;
export type LlmFilterPhase = (typeof LLM_FILTER_PHASES)[number];

/**
 * Поведение фильтра при сбое/таймауте:
 * - `closed` — вызов **не уходит** провайдеру (fail-closed);
 * - `open` — вызов идёт как есть (fail-open), факт сбоя — в аудите.
 */
export const LLM_FILTER_FAIL_MODES = ['open', 'closed'] as const;
export type LlmFilterFailMode = (typeof LLM_FILTER_FAIL_MODES)[number];

/**
 * Вердикт фильтра:
 * - `allow` — пропустить вызов;
 * - `deny` — заблокировать вызов (вызов не уходит провайдеру);
 * - `redact` — заменить содержимое (`post_response`/`embedding`).
 */
export const LLM_FILTER_VERDICTS = ['allow', 'deny', 'redact'] as const;
export type LlmFilterVerdictKind = (typeof LLM_FILTER_VERDICTS)[number];

/**
 * Сообщение запроса в виде узкого DTO (без служебных полей `LLMMessage`).
 */
export interface LlmFilterMessage {
  /** Роль сообщения (`user`/`assistant`/`system`/`tool`). */
  readonly role: string;
  /** Текст сообщения. */
  readonly content: string;
  /** Вызовы инструментов сообщения (структура провайдера — как есть). */
  readonly toolCalls?: readonly Record<string, unknown>[];
}

/**
 * Вход фильтра — узкий DTO (без портов и функций).
 *
 * Поля по фазам:
 * - `pre_request`: `messages`/`systemPrompt`/`tools`;
 * - `post_response`: `content`/`usage`;
 * - `embedding`: `texts`.
 */
export interface LlmFilterInput {
  /** Фаза, в которой вызван фильтр. */
  readonly phase: LlmFilterPhase;
  /** Имя провайдера. */
  readonly provider: string;
  /** Модель. */
  readonly model: string;
  /** Сессия (пусто — вызов вне сессии: пул провайдеров, суммаризация). */
  readonly sessionId?: string;
  /** `pre_request`: сообщения запроса (уже обфусцированные). */
  readonly messages?: readonly LlmFilterMessage[];
  /** `pre_request`: текст системного промпта. */
  readonly systemPrompt?: string;
  /** `pre_request`: описание инструментов. */
  readonly tools?: readonly Record<string, unknown>[];
  /** `post_response`: полный текст ответа. */
  readonly content?: string;
  /** `post_response`: расход токенов. */
  readonly usage?: TokenUsage;
  /** `embedding`: тексты, уходящие в эмбеддинг. */
  readonly texts?: readonly string[];
}

/**
 * Вердикт фильтра.
 *
 * `redactedContent` — только для `redact` в `post_response`, `redactedTexts` —
 * только для `redact` в `embedding`.
 */
export interface LlmFilterVerdict {
  /** Вердикт. */
  readonly verdict: LlmFilterVerdictKind;
  /** Человекочитаемая причина (попадает в аудит и в текст ответа). */
  readonly reason?: string;
  /** Машиночитаемый код причины. */
  readonly code?: string;
  /** Новое содержимое ответа (`redact` в `post_response`). */
  readonly redactedContent?: string;
  /** Новые тексты (`redact` в `embedding`). */
  readonly redactedTexts?: readonly string[];
}

/**
 * Фильтр LLM-вызовов (точка расширения `llmFilters`).
 *
 * Идентификатор — `plugin:<pluginName>:<filterName>`: префикс проверяет хост
 * (чужой плагин не может занять id другого).
 */
export interface LlmCallFilter {
  /** Идентификатор фильтра: `plugin:<pluginName>:<filterName>`. */
  readonly id: string;
  /** Фаза вызова фильтра. */
  readonly phase: LlmFilterPhase;
  /**
   * Поведение при сбое/таймауте. Не задан — по классу фильтра:
   * блокирующий (`closed`) / наблюдательный (`open`).
   */
  readonly failMode?: LlmFilterFailMode;
  /** Бюджет времени на вызов фильтра, мс. Не задан — из политики плагинов. */
  readonly timeoutMs?: number;
  /** Проверка. Возвращает вердикт. */
  inspect(input: LlmFilterInput): Promise<LlmFilterVerdict> | LlmFilterVerdict;
}

/**
 * Бюджет времени на один вызов фильтра по умолчанию, мс
 * (`plugins.llmFilterTimeoutMs` в конфиге).
 *
 * Единый источник истины для конфига (`config/defaults.ts`) и для хоста
 * (реестр фильтров). Точное значение — вопрос владельца (ADR-090,
 * «Бюджет времени фильтра»): механизм fail-closed/open реализован, число
 * подтверждается отдельно.
 */
export const DEFAULT_LLM_FILTER_TIMEOUT_MS = 1000;

/** Фаза — известное значение перечня. */
export function isLlmFilterPhase(value: unknown): value is LlmFilterPhase {
  return (LLM_FILTER_PHASES as readonly unknown[]).includes(value);
}

/** Режим отказа — известное значение перечня. */
export function isLlmFilterFailMode(value: unknown): value is LlmFilterFailMode {
  return (LLM_FILTER_FAIL_MODES as readonly unknown[]).includes(value);
}

/** Вердикт — известное значение перечня. */
export function isLlmFilterVerdictKind(value: unknown): value is LlmFilterVerdictKind {
  return (LLM_FILTER_VERDICTS as readonly unknown[]).includes(value);
}

/**
 * Может ли фильтр в этой фазе **заблокировать** вызов.
 *
 * `post_response` — не может: блокировка/правка ответа требует буферизации,
 * а ADR-036 прямо запрещает буферы и задержки. В первой волне фаза
 * `post_response` — только наблюдение.
 */
export function phaseCanBlock(phase: LlmFilterPhase): boolean {
  return phase === 'pre_request' || phase === 'embedding';
}
