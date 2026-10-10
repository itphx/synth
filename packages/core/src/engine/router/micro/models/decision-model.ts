/**
 * DecisionModel — микро-модель на decision-модели (AD-084).
 * Уровень каскада AD-035 между embedding и локальной LLM: decision пытается
 * первым, `micro_llm` остаётся фоллбеком.
 *
 * Decision-модель (System One: Clef/Jev/…) за один forward-pass отвечает на
 * типизированные вопросы (`choice`) по тексту запроса. Fail-safe: любая ошибка,
 * отключённый конфиг, отсутствие провайдера или низкая уверенность → `UNSURE`
 * (каскад идёт дальше), исключения наружу не пробрасываются.
 *
 * Конфиг приходит геттером (closure) — значения читаются в момент вызова, что
 * позволяет обновлять runtime-настройки без пересоздания модели (Ф5).
 */
import type { DecisionQuestion, DecisionResponse } from '@itphx/synth-shared';
import { decideChoiceCascade, type DecisionCascadeOutcome } from '../../decision-cascade.js';
import type { MicroInput, MicroResult, MicroTaskClass } from '../types.js';
import type { MicroModel } from './base.js';
import { INTENT_DESCRIPTIONS, CLASSIFY_ANSWERS } from '../tasks/classify-intent.js';
import { VALID_LABELS, ENUM_ANSWERS } from '../tasks/enum-decision.js';
import { info } from '../../../../logger.js';

/** Идентификатор decision-вопроса (ответ — метка задачи). */
export const DECISION_QUESTION_ID = 'label';

/**
 * Подмножество конфига decision-слоя, нужное модели. Структурно совместимо с
 * `DecisionConfig` из `@itphx/synth-shared` (позволяет замкнуть геттер на
 * `config.decision` без лишних приведений).
 */
export interface DecisionConfigLike {
  /** Мастер-выключатель decision-слоя. */
  enabled: boolean;
  /** Имя провайдера типа `decision`. */
  provider: string;
  /** Модель decision-слоя (напр. `clef-flash`). */
  model: string;
  /** Порог уверенности: ниже — `UNSURE` (fail-safe). */
  confidenceThreshold: number;
  /** AD-084: провайдер тира эскалации (необязательный точный тир). */
  escalationProvider?: string;
  /** AD-084: модель тира эскалации (необязательный точный тир). */
  escalationModel?: string;
}

/** Провайдер, умеющий decision-запрос (совместим с `BaseProvider.decide`). */
export interface DecisionProviderLike {
  decide(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts?: { model?: string; images?: string[]; videos?: string[] },
  ): Promise<DecisionResponse>;
}

/**
 * Резолвер decision-провайдера. Структурно совместим с `ProviderPool`
 * (`getDecisionProvider` возвращает провайдера, уже обёрнутого в gateway).
 */
export interface DecisionProviderResolver {
  getDecisionProvider(providerName: string, modelName: string): DecisionProviderLike | null;
}

export class DecisionModel implements MicroModel {
  readonly kind = 'decision' as const;
  readonly name = 'decision-classifier';
  private readonly _resolver: DecisionProviderResolver;
  private readonly _getConfig: () => DecisionConfigLike | undefined;

  constructor(
    resolver: DecisionProviderResolver,
    getConfig: () => DecisionConfigLike | undefined,
  ) {
    this._resolver = resolver;
    this._getConfig = getConfig;
  }

  canHandle(taskClass: MicroTaskClass): boolean {
    return taskClass === 'classify' || taskClass === 'enum_decision';
  }

  async handle(input: MicroInput, taskClass: MicroTaskClass): Promise<MicroResult> {
    const startTime = performance.now();

    const config = this._getConfig();
    // Мастер-выключатель config — обязателен; session-флаг `decisionFirst`
    // может только дополнительно отключить уровень (fail-safe).
    if (!config || !config.enabled || input.sessionSettings.decisionFirst === false) {
      return this._unsure(taskClass, startTime, ['decision_disabled']);
    }

    const providerName = config.provider;
    const modelName = config.model;
    if (!providerName || !modelName) {
      return this._unsure(taskClass, startTime, ['decision_no_provider']);
    }

    const questions = this._buildQuestions(taskClass);
    info('DECISION', `Запрос decision-модели ${providerName}/${modelName} (${taskClass})`);

    // Единый каскад primary → escalation (AD-084); fail-safe внутри.
    const outcome = await decideChoiceCascade({
      resolver: this._resolver,
      config,
      state: input.userMessage,
      questions,
      questionId: DECISION_QUESTION_ID,
      validate: (label) => this._isValidLabel(taskClass, label),
      ...(input.images ? { images: input.images } : {}),
      ...(input.videos ? { videos: input.videos } : {}),
      logLabel: 'микро',
    });

    if (outcome.accepted) {
      const signals = [`decision:${outcome.label}`];
      if (outcome.tier === 'escalation') signals.push('decision_escalated');
      return {
        status: 'OK',
        taskClass,
        label: outcome.label,
        confidence: outcome.confidence ?? 0,
        latencyMs: outcome.latencyMs,
        signals,
      };
    }

    return this._unsure(taskClass, startTime, [this._failSignal(outcome)], outcome.latencyMs);
  }

  // ── private ──

  /** Сигнал отказа каскада по статусу последней попытки (AD-084). */
  private _failSignal(outcome: DecisionCascadeOutcome): string {
    const last = outcome.attempts[outcome.attempts.length - 1];
    switch (outcome.lastStatus) {
      case 'no_provider':
        return last
          ? `decision_provider_not_found:${last.providerName}/${last.modelName}`
          : 'decision_provider_not_found';
      case 'invalid':
        return `decision_invalid_label:${outcome.lastLabel ?? ''}`;
      case 'error':
        return `decision_error:${outcome.lastError ?? ''}`;
      case 'low_confidence':
        return 'decision_low_confidence';
      case 'no_answer':
      default:
        return 'decision_no_answer';
    }
  }

  /** Строит decision-вопрос (`choice`) по классу задачи. */
  private _buildQuestions(taskClass: MicroTaskClass): Record<string, DecisionQuestion> {
    if (taskClass === 'classify') {
      const criteria: Record<string, string | null> = {};
      for (const label of Object.keys(CLASSIFY_ANSWERS)) {
        criteria[label] = INTENT_DESCRIPTIONS[label] ?? null;
      }
      return {
        [DECISION_QUESTION_ID]: {
          type: 'choice',
          instructions: 'Определи намерение пользователя по его запросу.',
          criteria,
        },
      };
    }

    // enum_decision
    const criteria: Record<string, string | null> = {};
    for (const label of VALID_LABELS) {
      criteria[label] = ENUM_ANSWERS[label]?.variants[0] ?? null;
    }
    return {
      [DECISION_QUESTION_ID]: {
        type: 'choice',
        instructions: 'Определи, какой из вариантов соответствует запросу пользователя.',
        criteria,
      },
    };
  }

  /** Проверяет, что метка входит в допустимый набор класса задачи. */
  private _isValidLabel(taskClass: MicroTaskClass, label: string): boolean {
    if (taskClass === 'classify') {
      return Object.prototype.hasOwnProperty.call(CLASSIFY_ANSWERS, label);
    }
    if (taskClass === 'enum_decision') {
      return VALID_LABELS.has(label);
    }
    return false;
  }

  private _unsure(
    taskClass: MicroTaskClass,
    startTime: number,
    signals: string[],
    latencyMs?: number,
  ): MicroResult {
    return {
      status: 'UNSURE',
      taskClass,
      confidence: 0.3,
      latencyMs: latencyMs ?? Math.round(performance.now() - startTime),
      signals,
    };
  }
}
