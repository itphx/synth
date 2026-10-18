/**
 * ADR-084: единый decision-каскад `primary → escalation`.
 *
 * Точка переиспользования для трёх потребителей decision-слоя — микро-модели
 * (`DecisionModel`), классификатора категории (`DecisionContentClassifier`) и
 * маршрутизации событий (`DecisionRuleProvider`). Устраняет дублирование логики
 * «провайдер → запрос → ответ → валидация → порог» и единообразно добавляет
 * необязательный тир эскалации (вторая пара provider/model, напр. Clef).
 *
 * Fail-safe: исключения наружу НЕ пробрасываются — ошибка тира перехватывается и
 * фиксируется как attempt `error`, каскад идёт к следующему тиру. Хелпер не
 * создаёт сессий и не эмитит хуки.
 */
import type { DecisionQuestion, DecisionResponse } from '@itphx/synth-shared';
import type {
  DecisionConfigLike,
  DecisionProviderResolver,
} from './micro/models/decision-model.js';
import { DecisionMetrics, decisionMetrics } from './decision-metrics.js';
import type { AnalyticsRecorder } from '../../analytics/recorder.js';
import { info, warning } from '../../logger.js';

/** Тир каскада: основной или эскалация. */
export type DecisionTier = 'primary' | 'escalation';

/**
 * Статус попытки тира:
 * - `ok` — уверенный валидный ответ, каскад принял решение;
 * - `low_confidence` — уверенность ниже порога;
 * - `invalid` — метка не прошла `validate`;
 * - `no_answer` — нет `choice`-ответа на вопрос;
 * - `no_provider` — резолвер не нашёл провайдера;
 * - `error` — исключение при запросе.
 */
export type DecisionAttemptStatus =
  | 'ok'
  | 'low_confidence'
  | 'invalid'
  | 'no_answer'
  | 'no_provider'
  | 'error';

/** Результат одной попытки тира (для метрик/диагностики). */
export interface DecisionAttempt {
  tier: DecisionTier;
  providerName: string;
  modelName: string;
  status: DecisionAttemptStatus;
  confidence?: number;
  latencyMs: number;
  label?: string;
  error?: string;
}

/** Итог каскада: принятое решение либо причина отказа (последний тир). */
export interface DecisionCascadeOutcome {
  accepted: boolean;
  label?: string;
  confidence?: number;
  tier?: DecisionTier;
  providerName?: string;
  modelName?: string;
  /** Суммарная задержка по всем опрошенным тирам, мс. */
  latencyMs: number;
  attempts: DecisionAttempt[];
  /** Причина отказа при `accepted: false` (статус последней попытки). */
  lastStatus: DecisionAttemptStatus;
  lastLabel?: string;
  lastError?: string;
}

/** Опции `decideChoiceCascade`. */
export interface DecideChoiceCascadeOptions {
  resolver: DecisionProviderResolver;
  config: DecisionConfigLike;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  questionId: string;
  /** Проверка допустимости метки для конкретного потребителя. */
  validate: (label: string) => boolean;
  /** PROP-085 задел: медиа-вложения (изображения). */
  images?: string[];
  /** PROP-085 задел: медиа-вложения (видео). */
  videos?: string[];
  /** Метка потребителя для логов (напр. `микро`/`классификатор`/`маршрутизация события`). */
  logLabel?: string;
  /** Сборщик метрик; по умолчанию — process-wide синглтон. */
  metrics?: DecisionMetrics;
  /**
   * PROP-102: сборщик персистентных decision-роллапов (ось `provider`/`model`) —
   * зеркало счётчиков `decisionMetrics`. Не задан — запись не выполняется.
   */
  analytics?: AnalyticsRecorder;
}

/** Тир каскада с резолвнутой парой provider/model. */
interface CascadeTier {
  tier: DecisionTier;
  providerName: string;
  modelName: string;
}

/**
 * Прогоняет decision-каскад по тирам, возвращает итог. Метрики пишутся в конце
 * (в т.ч. при отказе). Исключения наружу не пробрасываются.
 */
export async function decideChoiceCascade(
  opts: DecideChoiceCascadeOptions,
): Promise<DecisionCascadeOutcome> {
  const metrics = opts.metrics ?? decisionMetrics;
  const log = opts.logLabel ? `(${opts.logLabel})` : '';
  const threshold = opts.config.confidenceThreshold;

  const tiers = buildTiers(opts.config);
  const attempts: DecisionAttempt[] = [];

  for (let i = 0; i < tiers.length; i += 1) {
    const { tier, providerName, modelName } = tiers[i]!;

    // Переход на тир эскалации (наблюдаемость ADR-084).
    if (tier === 'escalation') {
      const prev = attempts[attempts.length - 1];
      info(
        'DECISION',
        `каскад${log}: переход на эскалацию ${providerName}/${modelName} (причина primary: ${prev?.status ?? 'n/a'})`,
      );
    }

    const provider = opts.resolver.getDecisionProvider(providerName, modelName);
    if (!provider) {
      attempts.push({ tier, providerName, modelName, status: 'no_provider', latencyMs: 0 });
      warning('DECISION', `каскад${log}: провайдер не найден ${providerName}/${modelName}`);
      continue;
    }

    const startedAt = performance.now();
    let response: DecisionResponse;
    try {
      response = await provider.decide(opts.state, opts.questions, {
        model: modelName,
        ...(opts.images ? { images: opts.images } : {}),
        ...(opts.videos ? { videos: opts.videos } : {}),
      });
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const error = String(err).slice(0, 100);
      attempts.push({ tier, providerName, modelName, status: 'error', latencyMs, error });
      warning('DECISION', `каскад${log}: ошибка тира ${tier} ${providerName}/${modelName}: ${error}`);
      continue;
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    const answer = response.answers[opts.questionId];
    if (!answer || answer.type !== 'choice') {
      attempts.push({ tier, providerName, modelName, status: 'no_answer', latencyMs });
      warning('DECISION', `каскад${log}: нет choice-ответа (${tier} ${providerName}/${modelName})`);
      continue;
    }

    const label = answer.choice;
    const confidence = answer.confidence;

    if (!opts.validate(label)) {
      attempts.push({ tier, providerName, modelName, status: 'invalid', latencyMs, label, confidence });
      warning('DECISION', `каскад${log}: невалидная метка "${label}" (${tier})`);
      continue;
    }

    if (!(confidence >= threshold)) {
      attempts.push({ tier, providerName, modelName, status: 'low_confidence', latencyMs, label, confidence });
      warning(
        'DECISION',
        `каскад${log}: низкая уверенность ${confidence.toFixed(2)} < ${threshold} (${tier} ${providerName}/${modelName})`,
      );
      continue;
    }

    // Успех: принимаем ответ и завершаем каскад.
    attempts.push({ tier, providerName, modelName, status: 'ok', latencyMs, label, confidence });
    info(
      'DECISION',
      `каскад${log}: OK tier=${tier} label=${label} confidence=${confidence.toFixed(2)} (порог ${threshold}) model=${providerName}/${modelName} latency=${latencyMs}ms`,
    );

    const outcome: DecisionCascadeOutcome = {
      accepted: true,
      label,
      confidence,
      tier,
      providerName,
      modelName,
      latencyMs: totalLatency(attempts),
      attempts,
      lastStatus: 'ok',
      lastLabel: label,
    };
    metrics.recordOutcome(outcome);
    void opts.analytics?.recordDecision(outcome);
    return outcome;
  }

  const last = attempts[attempts.length - 1];
  const outcome: DecisionCascadeOutcome = {
    accepted: false,
    latencyMs: totalLatency(attempts),
    attempts,
    lastStatus: last?.status ?? 'no_provider',
    ...(last?.label !== undefined ? { lastLabel: last.label } : {}),
    ...(last?.error !== undefined ? { lastError: last.error } : {}),
  };
  metrics.recordOutcome(outcome);
  void opts.analytics?.recordDecision(outcome);
  return outcome;
}

/** Собирает тиры: primary всегда, escalation — только при заданной и отличной паре. */
function buildTiers(config: DecisionConfigLike): CascadeTier[] {
  const tiers: CascadeTier[] = [
    { tier: 'primary', providerName: config.provider, modelName: config.model },
  ];
  const escProvider = config.escalationProvider ?? '';
  const escModel = config.escalationModel ?? '';
  if (
    escProvider &&
    escModel &&
    (escProvider !== config.provider || escModel !== config.model)
  ) {
    tiers.push({ tier: 'escalation', providerName: escProvider, modelName: escModel });
  }
  return tiers;
}

/** Суммарная задержка по всем попыткам. */
function totalLatency(attempts: DecisionAttempt[]): number {
  return attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
}
