/**
 * ADR-094: метрики одного LLM-вызова (GatewayProvider).
 *
 * Контракт лейблов ограничен: `provider`/`model`/`outcome` и `kind` токенов.
 * Значения берутся из фактического вызова; `usage` — финальный (у стрима —
 * последний чанк с usage). Ошибки метрик не влияют на вызов.
 */
import type { TokenUsage } from '@itphx/synth-shared';
import type { MetricsRegistry } from '../registry.js';

/** Исход одного LLM-вызова (контракт ADR-094). */
export type LlmCallOutcome = 'ok' | 'error' | 'cancelled' | 'rate_limited' | 'blocked';

/** Информация о завершённом LLM-вызове. */
export interface LlmCallInfo {
  provider: string;
  model: string;
  outcome: LlmCallOutcome;
  durationMs: number;
  usage?: TokenUsage;
}

/** Набор метрик одного LLM-вызова (ленивая идемпотентная регистрация). */
export function createLlmCallRecorder(registry: MetricsRegistry): (info: LlmCallInfo) => void {
  const requests = registry.counter(
    'synth_llm_requests_total',
    'Total number of LLM requests.',
    ['provider', 'model', 'outcome'],
  );
  const durations = registry.histogram(
    'synth_llm_duration_seconds',
    'LLM request duration in seconds.',
    ['provider', 'model'],
  );
  const tokens = registry.counter(
    'synth_llm_tokens_total',
    'Total number of LLM tokens.',
    ['provider', 'model', 'kind'],
  );

  return (info: LlmCallInfo): void => {
    try {
      const provider = info.provider || 'unknown';
      const model = info.model || 'unknown';
      requests.inc({ provider, model, outcome: info.outcome });
      if (Number.isFinite(info.durationMs)) {
        durations.observe({ provider, model }, Math.max(0, info.durationMs) / 1000);
      }

      const usage = info.usage;
      if (!usage) return;
      const kinds: Array<[string, number | undefined]> = [
        ['input', usage.inputTokens],
        ['output', usage.outputTokens],
        ['cache_read', usage.cacheReadTokens],
        ['cache_write', usage.cacheWriteTokens],
        ['reasoning', usage.reasoningTokens],
      ];
      for (const [kind, value] of kinds) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          tokens.inc({ provider, model, kind }, value);
        }
      }
    } catch {
      // Метрики не должны ломать LLM-вызов.
    }
  };
}
