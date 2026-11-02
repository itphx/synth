/**
 * MicroPipeline — каскад микро-моделей (ADR-035).
 * rules → embedding → decision (ADR-084) → micro_llm → LLM fallback (через ADR-034).
 *
 * Обрабатывает запрос ПЕРЕД вызовом LLM.
 * Если микро-слой уверен — возвращает готовый ответ без LLM.
 */
import type { MicroInput, MicroResult, PipelineResult } from './types.js';
import type { TokenUsage } from '@itphx/synth-shared';
import type { MicroModel } from './models/base.js';
import { TaskClassifier } from './task-classifier.js';
import { handleSmallTalk } from './tasks/small-talk.js';
import { handleClassifyIntent } from './tasks/classify-intent.js';
import { handleEnumDecision } from './tasks/enum-decision.js';
import { info } from '../../../logger.js';

/** ADR-102: сложить usage двух вызовов (undefined игнорируется). */
function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  // ADR-102: провайдерская стоимость — только в одной валюте.
  const cost = a.cost && b.cost
    ? (a.cost.currency === b.cost.currency
      ? { amount: a.cost.amount + b.cost.amount, currency: a.cost.currency }
      : undefined)
    : (a.cost ?? b.cost);
  return {
    inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0),
    outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
    ...(cost ? { cost } : {}),
  };
}

export class MicroPipeline {
  private readonly _classifier: TaskClassifier;
  private readonly _models: MicroModel[];

  constructor(classifier: TaskClassifier, models: MicroModel[]) {
    this._classifier = classifier;
    this._models = models;
  }

  /**
   * Главный метод: пытается обработать запрос без LLM.
   * @returns PipelineResult с handled=true если микрослой ответил, иначе handled=false.
   */
  async handle(input: MicroInput): Promise<PipelineResult> {
    const startTime = performance.now();

    // 1. TaskClassifier: определяем класс задачи
    const classifyResult = this._classifier.classify(input);
    const taskClass = classifyResult.taskClass;

    info('MICRO', `Запрос классифицирован как: ${taskClass} (сигналы: ${classifyResult.signals.join(', ')})`);

    // 2. Если llm_task — не обрабатываем, сразу возвращаем handled=false
    if (taskClass === 'llm_task') {
      return {
        handled: false,
        microResult: null,
        fallbackSignals: classifyResult.signals,
      };
    }

    // 3. Каскад: проходим по моделям (rules → embedding → decision → micro_llm)
    const threshold = input.sessionSettings.microConfidenceThreshold || 0.8;
    // ADR-084 (метрики): сигналы опрошенных моделей — чтобы на фоллбеке было видно,
    // что decision-уровень участвовал (напр. `decision:<label>` при отсечении по
    // порогу микро-слоя или `decision_low_confidence`). На обработку не влияет.
    const attemptedSignals: string[] = [];
    /** ADR-102: usage опрошенных, но не выбранных вызовов. */
    let auxUsage: TokenUsage | undefined;

    for (const model of this._models) {
      if (!model.canHandle(taskClass)) continue;

      const result = await model.handle(input, taskClass);
      attemptedSignals.push(...result.signals);

      info('MICRO', `Модель ${model.name} (${taskClass}): status=${result.status}, confidence=${result.confidence.toFixed(2)}, latency=${result.latencyMs}ms`);

      if (result.status === 'OK' && result.confidence >= threshold) {
        // Микрослой уверен — применяем обработчик задачи
        const enrichedResult = this._enrichResult(result, taskClass);
        const totalMs = Math.round(performance.now() - startTime);
        // Прочие вызовы каскада (включая отклонённые тиры decision) — aux.
        const selectedAuxUsage = addUsage(auxUsage, result.auxUsage);

        info('MICRO', `OK: ${model.name} ответил за ${totalMs}ms (label=${enrichedResult.label}, confidence=${enrichedResult.confidence.toFixed(2)})`);

        return {
          handled: true,
          microResult: {
            ...enrichedResult,
            latencyMs: totalMs,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(selectedAuxUsage ? { auxUsage: selectedAuxUsage } : {}),
          },
          fallbackSignals: enrichedResult.signals,
          ...(selectedAuxUsage ? { auxUsage: selectedAuxUsage } : {}),
        };
      }

      // Вызов не выбран — его usage (и отклонённые тиры внутри) идёт в aux.
      auxUsage = addUsage(auxUsage, result.usage);
      auxUsage = addUsage(auxUsage, result.auxUsage);
    }

    // 4. Все UNSURE → fallback на LLM
    const totalMs = Math.round(performance.now() - startTime);
    info('MICRO', `UNSURE: все модели не уверены (${totalMs}ms), fallback на LLM`);

    return {
      handled: false,
      microResult: null,
      fallbackSignals: [...new Set([...classifyResult.signals, ...attemptedSignals])],
      ...(auxUsage ? { auxUsage } : {}),
    };
  }

  // ── private ──

  private _enrichResult(result: MicroResult, taskClass: MicroResult['taskClass']): MicroResult {
    switch (taskClass) {
      case 'small_talk':
        return handleSmallTalk(result);
      case 'classify':
        return handleClassifyIntent(result);
      case 'enum_decision':
        return handleEnumDecision(result);
      default:
        return result;
    }
  }
}
