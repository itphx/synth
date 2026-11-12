/**
 * ADR-094 / PROP-136b: метрики **зеркального** чекера команд в control plane
 * (слайс 136b-2a).
 *
 * Каталог:
 * - `synth_command_policy_total{outcome,provider}` — проверки чекера по исходу
 *   (`allow`/`deny`/`unavailable`; кэш-попадания считаются исходом вердикта);
 * - `synth_command_policy_seconds{provider}` — длительность сетевой проверки
 *   (секунды; кэш-попадания не меряются).
 *
 * ## Контракт ADR-094
 *
 * - имена — только `synth_*`; лейблы — `outcome`/`provider` (конечные наборы:
 *   неизвестное значение → `other`); текстов команд, правил, id сессий и
 *   адресов чекера в лейблах нет;
 * - ошибка метрик не влияет на решение чекера (вызовы обёрнуты в try/catch);
 * - сторона счёта — control plane; на исполнителе свои счётчики, суммировать
 *   серии нельзя (разные лейблы `job`).
 *
 * Модуль **browser-safe**: только реестр метрик, ни `node:*`.
 */
import type { MetricsRegistry } from '../registry.js';

/** Исход проверки (лейбл `outcome`). */
export type CommandPolicyMetricOutcome = 'allow' | 'deny' | 'unavailable';

/** Провайдер чекера (лейбл `provider`). */
export type CommandPolicyMetricProvider = 'http' | 'opa';

/** Счётчики/гистограмма чекера (sink для провайдера командной политики). */
export interface CommandPolicyMetricsSink {
  onChecked(outcome: CommandPolicyMetricOutcome, provider: CommandPolicyMetricProvider): void;
  onLatency(provider: CommandPolicyMetricProvider, durationMs: number): void;
}

const OUTCOMES: readonly string[] = ['allow', 'deny', 'unavailable'];

/** Приведение исхода к конечному набору: неизвестное → `unavailable`. */
export function normalizeCommandPolicyOutcome(value: string): CommandPolicyMetricOutcome {
  return (OUTCOMES.includes(value) ? value : 'unavailable') as CommandPolicyMetricOutcome;
}

/** Приведение провайдера к конечному набору: неизвестное → `http`. */
export function normalizeCommandPolicyProvider(value: string): CommandPolicyMetricProvider {
  return value === 'opa' ? 'opa' : 'http';
}

/** Создать sink метрик чекера команд (один на реестр). */
export function createCommandPolicyMetrics(registry: MetricsRegistry): CommandPolicyMetricsSink {
  const checks = registry.counter(
    'synth_command_policy_total',
    'Command policy checks by outcome and provider.',
    ['outcome', 'provider'],
  );
  const duration = registry.histogram(
    'synth_command_policy_seconds',
    'Command policy check duration (provider request).',
    ['provider'],
  );

  return {
    onChecked(outcome, provider) {
      try {
        checks.inc(
          {
            outcome: normalizeCommandPolicyOutcome(outcome),
            provider: normalizeCommandPolicyProvider(provider),
          },
          1,
        );
      } catch {
        // Метрики не ломают решение.
      }
    },
    onLatency(provider, durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      try {
        duration.observe({ provider: normalizeCommandPolicyProvider(provider) }, durationMs / 1000);
      } catch {
        // Метрики не ломают решение.
      }
    },
  };
}
