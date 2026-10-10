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
import type { MicroInput, MicroResult, MicroTaskClass } from '../types.js';
import type { MicroModel } from './base.js';
import { INTENT_DESCRIPTIONS, CLASSIFY_ANSWERS } from '../tasks/classify-intent.js';
import { VALID_LABELS, ENUM_ANSWERS } from '../tasks/enum-decision.js';
import { info, warning } from '../../../../logger.js';

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
}

/** Провайдер, умеющий decision-запрос (совместим с `BaseProvider.decide`). */
export interface DecisionProviderLike {
  decide(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts?: { model?: string },
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

    const provider = this._resolver.getDecisionProvider(providerName, modelName);
    if (!provider) {
      return this._unsure(taskClass, startTime, [`decision_provider_not_found:${providerName}/${modelName}`]);
    }

    try {
      const questions = this._buildQuestions(taskClass);
      info('DECISION', `Запрос decision-модели ${providerName}/${modelName} (${taskClass})`);

      const response = await provider.decide(input.userMessage, questions, { model: modelName });

      const answer = response.answers[DECISION_QUESTION_ID];
      if (!answer || answer.type !== 'choice') {
        return this._unsure(taskClass, startTime, ['decision_no_answer']);
      }

      const label = answer.choice;
      if (!this._isValidLabel(taskClass, label)) {
        return this._unsure(taskClass, startTime, [`decision_invalid_label:${label}`]);
      }

      const confidence = answer.confidence;
      const ok = confidence >= config.confidenceThreshold;
      const latencyMs = Math.round(performance.now() - startTime);

      info(
        'DECISION',
        `${ok ? 'OK' : 'UNSURE'}: label=${label}, confidence=${confidence.toFixed(2)}, latency=${latencyMs}ms`,
      );

      return {
        status: ok ? 'OK' : 'UNSURE',
        taskClass,
        label: ok ? label : undefined,
        confidence,
        usage: response.usage
          ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
          : undefined,
        latencyMs,
        signals: ok ? [`decision:${label}`] : ['decision_low_confidence'],
      };
    } catch (err) {
      warning('DECISION', `Ошибка decision-модели: ${String(err).slice(0, 200)}`);
      return this._unsure(taskClass, startTime, [`decision_error:${String(err).slice(0, 100)}`]);
    }
  }

  // ── private ──

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

  private _unsure(taskClass: MicroTaskClass, startTime: number, signals: string[]): MicroResult {
    return {
      status: 'UNSURE',
      taskClass,
      confidence: 0.3,
      latencyMs: Math.round(performance.now() - startTime),
      signals,
    };
  }
}
