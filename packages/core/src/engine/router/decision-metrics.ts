/**
 * ADR-084: агрегатные in-memory метрики decision-слоя.
 *
 * Один `DecisionMetrics` накапливает статистику по каждому вызову
 * `decideChoiceCascade`: сколько обращений, сколько принято (`handled`), сколько
 * ушло в фоллбек, сколько эскалировано, распределение статусов попыток и
 * разбивку по моделям. Process-wide синглтон `decisionMetrics` используется по
 * умолчанию (как `logger`); тесты могут передавать свежий инстанс или звать
 * `reset()`.
 */
import type { DecisionAttemptStatus, DecisionCascadeOutcome } from './decision-cascade.js';

/** Сериализуемый снимок метрик decision-слоя (без функций/Map). */
export interface DecisionMetricsSnapshot {
  /** Обращений к каскаду. */
  calls: number;
  /** Принятых решений (`accepted`). */
  handled: number;
  /** Отказов каскада (`!accepted`). */
  fallback: number;
  /** Принятых на тире `escalation`. */
  escalated: number;
  /** Счётчики попыток по тирам. */
  attempts: { primary: number; escalation: number };
  /** Распределение статусов попыток. */
  rejected: Record<DecisionAttemptStatus, number>;
  /** Разбивка по моделям `'<provider>/<model>'` (latency — по попыткам модели). */
  by_model: Record<
    string,
    { calls: number; handled: number; latency_ms_avg: number; latency_ms_max: number }
  >;
}

/** Внутренние накопители по модели. */
interface ModelAccumulator {
  calls: number;
  handled: number;
  latencySum: number;
  latencyMax: number;
}

/** Пустой реестр статусов попыток. */
function emptyRejected(): Record<DecisionAttemptStatus, number> {
  return { ok: 0, low_confidence: 0, invalid: 0, no_answer: 0, no_provider: 0, error: 0 };
}

/** In-memory агрегатор метрик decision-слоя. */
export class DecisionMetrics {
  private _calls = 0;
  private _handled = 0;
  private _escalated = 0;
  private _attempts = { primary: 0, escalation: 0 };
  private _rejected = emptyRejected();
  private readonly _byModel = new Map<string, ModelAccumulator>();

  /** Учитывает итог одного каскада. */
  recordOutcome(outcome: DecisionCascadeOutcome): void {
    this._calls += 1;
    if (outcome.accepted) {
      this._handled += 1;
      if (outcome.tier === 'escalation') this._escalated += 1;
    }

    for (const attempt of outcome.attempts) {
      this._attempts[attempt.tier] += 1;
      this._rejected[attempt.status] += 1;

      const key = `${attempt.providerName}/${attempt.modelName}`;
      const entry = this._byModel.get(key) ?? { calls: 0, handled: 0, latencySum: 0, latencyMax: 0 };
      entry.calls += 1;
      entry.latencySum += attempt.latencyMs;
      if (attempt.latencyMs > entry.latencyMax) entry.latencyMax = attempt.latencyMs;
      if (attempt.status === 'ok') entry.handled += 1;
      this._byModel.set(key, entry);
    }
  }

  /** Возвращает сериализуемый снимок метрик. */
  snapshot(): DecisionMetricsSnapshot {
    const by_model: DecisionMetricsSnapshot['by_model'] = {};
    for (const [key, entry] of this._byModel) {
      by_model[key] = {
        calls: entry.calls,
        handled: entry.handled,
        latency_ms_avg: entry.calls > 0 ? Math.round(entry.latencySum / entry.calls) : 0,
        latency_ms_max: entry.latencyMax,
      };
    }

    return {
      calls: this._calls,
      handled: this._handled,
      fallback: this._calls - this._handled,
      escalated: this._escalated,
      attempts: { ...this._attempts },
      rejected: { ...this._rejected },
      by_model,
    };
  }

  /** Сбрасывает все накопители. */
  reset(): void {
    this._calls = 0;
    this._handled = 0;
    this._escalated = 0;
    this._attempts = { primary: 0, escalation: 0 };
    this._rejected = emptyRejected();
    this._byModel.clear();
  }
}

/** Process-wide синглтон метрик decision-слоя (используется по умолчанию). */
export const decisionMetrics = new DecisionMetrics();
