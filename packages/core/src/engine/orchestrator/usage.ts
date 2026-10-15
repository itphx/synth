/**
 * ADR-095 (шаг 6a): usage/cost-хелперы оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет прежние методы-делегации (`_computeMessageCost`,
 * `_estimateUsage`, `_publishLiveUsage`, ...). Тела перенесены дословно,
 * `this._X` заменены на явные параметры.
 */
import type { Session, TokenUsage } from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, SystemPromptPayload } from '../../providers/base.js';
import { computeUsageCost, type UsagePricing } from '../../providers/usage.js';
import { estimatePromptChars as estimatePromptCharsShared } from '../context/token-ratio.js';

/** ADR-070: окно троттлинга live-события `stream.usage` (~300 мс). */
export const STREAM_USAGE_THROTTLE_MS = 300;

/** Загрузчик цен модели (как `_modelPriceLoader` оркестратора). */
export type ModelPriceLoader = (modelName: string) => UsagePricing | null;

/**
 * Стоимость usage сообщения по цене модели (в валюте pricing). `null` — цен
 * нет (в этом случае `metadata.cost_usd`/`cost_currency` не пишутся).
 */
export function computeMessageCost(
  model: string | undefined,
  usage: TokenUsage | undefined,
  modelPriceLoader: ModelPriceLoader | null,
): ReturnType<typeof computeUsageCost> {
  if (!model || !usage) return null;
  return computeUsageCost(usage, modelPriceLoader?.(model) ?? null);
}

/**
 * ADR-070 §2.6: fallback-цепочка модели сообщения. Провайдеры выставляют
 * `model` только в финальном чанке (`isFinal`), поэтому при отмене/сбое
 * `chunkModel`/`finalModel` пусты — берём модель провайдера или настройку
 * сессии, иначе `_computeMessageCost` вернёт null и `cost_usd` потеряется.
 */
export function resolveMessageModel(
  chunkModel: string | undefined,
  finalModel: string | undefined,
  provider: BaseProvider | undefined,
  session: Session,
): string | undefined {
  return chunkModel || finalModel || provider?.model || session.settings.model || undefined;
}

/**
 * ADR-070 §2.6 (Bug 4): best-effort оценка usage, когда провайдер не успел
 * отдать финальный чанк (отмена/сбой). Эвристика `chars / 4` (как в
 * `estTokens`): input — из размера промпта, output — из накопленного
 * контента. Реальные значения не перетираются; при любой дозаполненной
 * части `estimated = true` (вызывающий пишет `metadata.usage_estimated`).
 */
export function estimateUsage(
  usage: TokenUsage | undefined,
  promptChars: number,
  outputChars: number,
): { usage: TokenUsage; estimated: boolean } {
  const base: TokenUsage = usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let inputTokens = base.inputTokens || 0;
  let outputTokens = base.outputTokens || 0;
  let estimated = false;

  if (inputTokens <= 0 && promptChars > 0) {
    inputTokens = Math.ceil(promptChars / 4);
    estimated = true;
  }
  if (outputTokens <= 0 && outputChars > 0) {
    outputTokens = Math.ceil(outputChars / 4);
    estimated = true;
  }

  const totalTokens = base.totalTokens && base.totalTokens > 0
    ? base.totalTokens
    : inputTokens + outputTokens;

  return {
    usage: {
      ...base,
      inputTokens,
      outputTokens,
      totalTokens,
    },
    estimated,
  };
}

/**
 * Оценка размера промпта (символы) для best-effort input-токенов: сообщения
 * (content + toolUse + reasoning) + system prompt + JSON тулов. Зеркалит
 * отправку в провайдер, не мутирует данные.
 */
export function estimatePromptChars(
  messages: LLMMessage[],
  systemPrompt: SystemPromptPayload | string | undefined,
  tools?: Record<string, unknown>[],
): number {
  const systemText = typeof systemPrompt === 'string' ? systemPrompt : (systemPrompt?.text ?? '');
  return estimatePromptCharsShared(messages, systemText, tools);
}

/**
 * Параметры live-публикации usage (`_publishLiveUsage`).
 */
export interface PublishLiveUsageParams {
  publishChunk: (event: string, data: Record<string, unknown>) => void;
  state: {
    lastPublishedAt: number;
    lastSignature: string;
    /** Опубликован точный output (output>0/reasoning) — форсируем один раз. */
    exactPublished: boolean;
    /** Опубликован точный input (Anthropic message_start) — форсируем один раз. */
    inputExactPublished: boolean;
  };
  sessionId: string;
  streamId: string;
  iteration: number;
  agentRole?: string;
  model?: string;
  provider?: string;
  usage: TokenUsage;
  estimated: boolean;
  force?: boolean;
}

/**
 * ADR-070 §2.6: публикация live-статистики стрима (`stream.usage`) через
 * существующий транспорт (publishChunk → EventBus, ADR-024).
 *
 * Троттлинг ~300 мс + дедуп по подписи usage (не спамим одинаковыми
 * значениями). Точный usage (`estimated: false`) приоритетнее оценки и
 * публикуется принудительно при первой же возможности, чтобы панель быстро
 * получила реальные токены. `cost_usd`/`cost_breakdown` добавляются только
 * если у модели заданы цены (иначе `computeUsageCost` возвращает null).
 *
 * Live-значения эфемерны: в сессию/агрегаты НЕ пишутся (персистится только
 * финальное сообщение/`stream.done`).
 */
export function publishLiveUsage(
  params: PublishLiveUsageParams,
  computeCost: (model: string | undefined, usage: TokenUsage | undefined) => ReturnType<typeof computeUsageCost>,
): void {
  const signature = [
    params.estimated ? 'e' : 'x',
    params.usage.inputTokens,
    params.usage.outputTokens,
    params.usage.totalTokens,
    params.usage.cacheReadTokens ?? 0,
    params.usage.cacheWriteTokens ?? 0,
    params.usage.reasoningTokens ?? 0,
  ].join(':');
  const now = Date.now();
  if (!params.force && signature === params.state.lastSignature) return;
  if (!params.force && now - params.state.lastPublishedAt < STREAM_USAGE_THROTTLE_MS) return;
  params.state.lastPublishedAt = now;
  params.state.lastSignature = signature;

  const cost = params.model ? computeCost(params.model, params.usage) : null;

  params.publishChunk('stream.usage', {
    session_id: params.sessionId,
    stream_id: params.streamId,
    iteration: params.iteration,
    ...(params.agentRole ? { agent_role: params.agentRole } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    // Копия: провайдеры мутируют объект running total in place — событие
    // должно нести снимок значений на момент публикации.
    usage: { ...params.usage },
    ...(cost ? { cost_usd: cost.costUsd, cost_currency: cost.currency, cost_breakdown: cost.breakdown } : {}),
    estimated: params.estimated,
  });
}

/**
 * ADR-070 §2.6: агрегация per-message статистики сабагентов из tool-результатов
 * `task` (`result.metadata.subagent_usage`/`subagent_model`). Возвращает
 * breakdown для `metadata.subagents` финального assistant-сообщения; `cost_usd`
 * — номинальная сумма, `cost_by_currency` — разбивка по валютам. `undefined`,
 * если в сообщении нет ни одного task-результата с usage/child_session_id.
 */
export function aggregateSubagentStats(
  toolResults: Array<Record<string, unknown>>,
  computeCost: (model: string | undefined, usage: TokenUsage | undefined) => ReturnType<typeof computeUsageCost>,
): {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  cost_by_currency: Record<string, number>;
} | undefined {
  let sessions = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let cost = 0;
  const costByCurrency: Record<string, number> = {};
  let found = false;

  for (const raw of toolResults) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (entry.name !== 'task') continue;
    const resultMeta = (entry.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    if (!resultMeta) continue;
    const childId = resultMeta.child_session_id;
    const usage = resultMeta.subagent_usage as TokenUsage | undefined;
    if (!childId && !usage) continue;

    found = true;
    sessions += 1;
    if (usage) {
      input += usage.inputTokens || 0;
      output += usage.outputTokens || 0;
      cacheRead += usage.cacheReadTokens || 0;
      cacheWrite += usage.cacheWriteTokens || 0;
      reasoning += usage.reasoningTokens || 0;
      const model = (resultMeta.subagent_model as string | undefined)
        || (resultMeta.routing_model as string | undefined);
      const c = computeCost(model, usage);
      if (c) {
        cost += c.costUsd;
        costByCurrency[c.currency] = (costByCurrency[c.currency] || 0) + c.costUsd;
      }
    }
  }

  if (!found) return undefined;
  return {
    sessions,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    cost_usd: cost,
    cost_by_currency: costByCurrency,
  };
}
