/**
 * ADR-095 (шаг 6a): usage/cost-хелперы оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет прежние методы-делегации (`_computeMessageCost`,
 * `_estimateUsage`, ...). Тела перенесены дословно, `this._X` заменены на
 * явные параметры.
 *
 * ADR-118 §4: live-публикация расхода (`stream.usage`) удалена вместе с
 * событием — расход шага публикуется в `step.finished` (usage/модель/стоимость).
 */
import type { Session, TokenUsage } from '@itphx/synth-shared';
import type { BaseProvider, LLMMessage, SystemPromptPayload } from '../../providers/base.js';
import { computeUsageCost, type UsagePricing } from '../../providers/usage.js';
import { estimatePromptChars as estimatePromptCharsShared } from '../context/token-ratio.js';

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
 * ADR-102: сумма двух расходов (`usage`).
 *
 * Расход **хода** = сумма расходов его шагов: с ADR-118 шаг — отдельный
 * вызов LLM, поэтому расход промежуточных шагов иначе терялся бы в
 * статистике сессии/аналитике (в финальное сообщение попадал только
 * последний вызов). Складываются токены и кеш-поля; `totalTokens` — сумма
 * сумм, а при нуле — `input + output` (как в `estimateUsage`).
 */
export function addTokenUsage(base: TokenUsage, add: TokenUsage | undefined): TokenUsage {
  if (!add) return base;
  const inputTokens = (base.inputTokens || 0) + (add.inputTokens || 0);
  const outputTokens = (base.outputTokens || 0) + (add.outputTokens || 0);
  const totalTokens = (base.totalTokens || 0) + (add.totalTokens || 0);
  const cacheReadTokens = (base.cacheReadTokens ?? 0) + (add.cacheReadTokens ?? 0);
  const cacheWriteTokens = (base.cacheWriteTokens ?? 0) + (add.cacheWriteTokens ?? 0);
  const reasoningTokens = (base.reasoningTokens ?? 0) + (add.reasoningTokens ?? 0);
  // ADR-102: провайдерская стоимость суммируется в той же валюте; разные
  // валюты не складываем (тогда стоимость хода — по каталогу).
  const cost = base.cost && add.cost
    ? (base.cost.currency === add.cost.currency
      ? { amount: base.cost.amount + add.cost.amount, currency: base.cost.currency }
      : undefined)
    : (base.cost ?? add.cost);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    ...(base.cacheReadTokens !== undefined || add.cacheReadTokens !== undefined
      ? { cacheReadTokens }
      : {}),
    ...(base.cacheWriteTokens !== undefined || add.cacheWriteTokens !== undefined
      ? { cacheWriteTokens }
      : {}),
    ...(base.reasoningTokens !== undefined || add.reasoningTokens !== undefined
      ? { reasoningTokens }
      : {}),
    ...(cost ? { cost } : {}),
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
 * Срез одной задачи саб-агента для агрегатов (`task`-результат хода).
 */
interface SubagentTaskUsage {
  childSessionId?: string;
  usage?: TokenUsage;
  model?: string;
  /** Тип саб-агента (`metadata.subagent_type`) — ось `agent` роллапа. */
  agent?: string;
}

/** Единый разбор `task`-результатов: поля `child_session_id`/`subagent_usage`/`subagent_model`. */
function forEachSubagentTask(
  toolResults: Array<Record<string, unknown>>,
  callback: (entry: SubagentTaskUsage) => void,
): void {
  for (const raw of toolResults) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (entry.name !== 'task') continue;
    const resultMeta = (entry.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    if (!resultMeta) continue;
    const childSessionId = resultMeta.child_session_id;
    const usage = resultMeta.subagent_usage as TokenUsage | undefined;
    if (!childSessionId && !usage) continue;
    callback({
      childSessionId: typeof childSessionId === 'string' ? childSessionId : undefined,
      usage,
      model:
        (resultMeta.subagent_model as string | undefined)
        || (resultMeta.routing_model as string | undefined),
      agent: typeof resultMeta.subagent_type === 'string' ? resultMeta.subagent_type : undefined,
    });
  }
}

/**
 * ADR-102: usage саб-агентов в разбивке по моделям — для роллапа `usage`
 * (ось `model`/`agent`). Считается тем же разбором `task`-результатов, что и
 * `aggregateSubagentStats`, и тем же `computeCost`; группы «модель+агент+валюта»
 * суммируются, `sessions` — число задач саб-агента в группе (для `requests`).
 */
export function collectSubagentUsageByModel(
  toolResults: Array<Record<string, unknown>>,
  computeCost: (model: string | undefined, usage: TokenUsage | undefined) => ReturnType<typeof computeUsageCost>,
): Array<{
  model?: string;
  agent?: string;
  sessions: number;
  usage: TokenUsage;
  costByCurrency: Record<string, number>;
}> {
  const groups = new Map<
    string,
    {
      model?: string;
      agent?: string;
      sessions: number;
      usage: TokenUsage;
      costByCurrency: Record<string, number>;
    }
  >();

  forEachSubagentTask(toolResults, (entry) => {
    if (!entry.usage) return;
    const cost = computeCost(entry.model, entry.usage);
    const key = `${entry.model ?? ''}\u0000${entry.agent ?? ''}\u0000${cost?.currency ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        model: entry.model,
        agent: entry.agent,
        sessions: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        costByCurrency: {},
      };
      groups.set(key, group);
    }
    group.sessions += 1;
    group.usage.inputTokens += entry.usage.inputTokens || 0;
    group.usage.outputTokens += entry.usage.outputTokens || 0;
    group.usage.totalTokens += entry.usage.totalTokens || 0;
    group.usage.cacheReadTokens = (group.usage.cacheReadTokens ?? 0) + (entry.usage.cacheReadTokens || 0);
    group.usage.cacheWriteTokens = (group.usage.cacheWriteTokens ?? 0) + (entry.usage.cacheWriteTokens || 0);
    group.usage.reasoningTokens = (group.usage.reasoningTokens ?? 0) + (entry.usage.reasoningTokens || 0);
    if (cost) group.costByCurrency[cost.currency] = (group.costByCurrency[cost.currency] || 0) + cost.costUsd;
  });

  return [...groups.values()];
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

  forEachSubagentTask(toolResults, (entry) => {
    sessions += 1;
    if (!entry.usage) return;
    input += entry.usage.inputTokens || 0;
    output += entry.usage.outputTokens || 0;
    cacheRead += entry.usage.cacheReadTokens || 0;
    cacheWrite += entry.usage.cacheWriteTokens || 0;
    reasoning += entry.usage.reasoningTokens || 0;
    const c = computeCost(entry.model, entry.usage);
    if (c) {
      cost += c.costUsd;
      costByCurrency[c.currency] = (costByCurrency[c.currency] || 0) + c.costUsd;
    }
  });

  if (sessions === 0) return undefined;
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
