/**
 * ADR-102/ADR-118 (паритет с opencode `session.usage.recorded`): единый шов
 * учёта **aux-вызовов** LLM — тех, что не становятся assistant-сообщением
 * (title, QA self-check, fork-summary, derive вложения, micro/decision, а также
 * неудавшийся LLM-вызов основной сессии — `llm-error`).
 *
 * Инвариант статистики: **сумма usage assistant-сообщений + aux-usage =
 * счётчики сессии** (`Session.inputTokens`/…). Aux-вызовы:
 *  - увеличивают счётчики сессии (токены и стоимость под локом);
 *  - пишут роллап `usage` аналитики с `requests=1` и **без** `messages`
 *    (сообщением они не являются);
 *  - best-effort: ошибки хранилища/аналитики не ломают ход.
 *
 * `source` — только для диагностики/логов, отдельной оси в роллапах нет
 * (схема роллапов не меняется).
 */
import type { TokenUsage } from '@itphx/synth-shared';
import type { SessionManager } from '../sessions/manager.js';
import type { AnalyticsRecorder } from '../analytics/recorder.js';
import { sessionAxes } from '../analytics/recorder.js';
import {
  computeCacheHitRate,
  computeUsageCost,
  type UsageCost,
  type UsagePricing,
} from '../providers/usage.js';
import { warning } from '../logger.js';

/** Причина aux-вызова (диагностика; в аналитику как ось не пишется). */
export type AuxUsageSource =
  | 'title'
  | 'qa-self-check'
  | 'qa-escalation'
  | 'fork-summary'
  | 'attachment-derive'
  | 'micro'
  | 'micro-message'
  /** Терминальная ошибка LLM основной сессии (сообщение не создаётся). */
  | 'llm-error';

/** Зависимости шва (те же, что у персиста сообщений). */
export interface AuxUsageDeps {
  sessionManager: Pick<SessionManager, 'withLock' | 'getSession' | 'saveSession'>;
  analytics?: AnalyticsRecorder | null;
  modelPriceLoader?: ((modelName: string) => UsagePricing | null) | null;
}

/** Вход учёта одного aux-вызова. */
export interface AuxUsageInput {
  sessionId: string;
  usage?: TokenUsage;
  provider?: string;
  model?: string;
  agent?: string;
  durationMs?: number;
  source: AuxUsageSource;
  /**
   * `1` — это запись **сообщения** (микро-ответ): аналитика получает
   * `messages=1`; по умолчанию `0` (aux — без `messages`).
   */
  messages?: 0 | 1;
  /** Готовая стоимость (провайдер/каталог) — иначе считается внутри. */
  cost?: UsageCost | null;
}

/** Есть ли в usage реальные токены (нулевой вызов не создаёт бакет). */
function hasUsageTokens(usage: TokenUsage | undefined): boolean {
  if (!usage) return false;
  return (
    (usage.inputTokens || 0) > 0
    || (usage.outputTokens || 0) > 0
    || (usage.cacheReadTokens || 0) > 0
    || (usage.cacheWriteTokens || 0) > 0
    || (usage.reasoningTokens || 0) > 0
  );
}

/**
 * Записать aux-расход под сессией: счётчики `Session` + роллап аналитики.
 * No-op без сессии, без токенов и при отсутствии провайдер-usage.
 */
export async function recordAuxUsage(
  deps: AuxUsageDeps,
  input: AuxUsageInput,
): Promise<void> {
  const { usage, sessionId } = input;
  const isMessage = input.messages === 1;
  if (!sessionId) return;
  if (!hasUsageTokens(usage) && !isMessage) return;

  const hasTokens = hasUsageTokens(usage);
  const effectiveCost = input.cost !== undefined
    ? input.cost
    : computeUsageCost(usage, deps.modelPriceLoader?.(input.model ?? '') ?? null);

  try {
    let axes: ReturnType<typeof sessionAxes> = {};
    if (hasTokens) {
      await deps.sessionManager.withLock(sessionId, async (session) => {
        axes = sessionAxes(session);
        const effectiveModel = input.model || session.settings.model;
        session.inputTokens += usage!.inputTokens || 0;
        session.outputTokens += usage!.outputTokens || 0;
        session.totalTokens += usage!.totalTokens || 0;
        session.cacheReadTokens += usage!.cacheReadTokens || 0;
        session.cacheWriteTokens += usage!.cacheWriteTokens || 0;
        session.reasoningTokens += usage!.reasoningTokens || 0;
        session.cacheHitRate = computeCacheHitRate(session.cacheReadTokens, session.inputTokens);
        const cost = effectiveCost ?? computeUsageCost(
          usage,
          deps.modelPriceLoader?.(effectiveModel ?? '') ?? null,
        );
        if (cost) {
          session.inputCost += cost.breakdown.input;
          session.outputCost += cost.breakdown.output;
          session.cacheReadCost += cost.breakdown.cacheRead;
          session.cacheWriteCost += cost.breakdown.cacheWrite;
        }
        session.updatedAt = new Date().toISOString();
        await deps.sessionManager.saveSession(session);
      });
    } else {
      const session = await deps.sessionManager.getSession(sessionId);
      axes = sessionAxes(session ?? null);
    }

    if (deps.analytics?.enabled) {
      const costByCurrency: Record<string, number> = {};
      if (effectiveCost) costByCurrency[effectiveCost.currency] = effectiveCost.costUsd;
      void deps.analytics.recordUsage({
        ...axes,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(usage ? { usage } : {}),
        requests: hasTokens ? 1 : undefined,
        ...(isMessage ? { messages: 1 } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(Object.keys(costByCurrency).length > 0 ? { costByCurrency } : {}),
      });
    }
  } catch (err) {
    warning(
      'USAGE',
      `aux-учёт (${input.source}) не выполнен: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Свёртка aux-учёта в колбэк для фаз оркестратора/тулов. */
export type AuxUsageRecorder = (input: Omit<AuxUsageInput, 'sessionId'> & { sessionId: string }) => void | Promise<void>;
