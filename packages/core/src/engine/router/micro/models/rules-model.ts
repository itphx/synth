/**
 * RulesModel — микро-модель на правилах + словаре (AD-035).
 * Расширяет DictionaryStore. Для каждого task class — свои словари и правила.
 *
 * Уровень 1 каскада: самый быстрый (0 токенов, мс).
 */
import type { MicroInput, MicroResult, MicroTaskClass } from '../types.js';
import type { MicroModel } from './base.js';
import type { TaskClassifier } from '../task-classifier.js';

export class RulesModel implements MicroModel {
  readonly kind = 'rules' as const;
  readonly name = 'rules-classifier';
  private readonly _classifier: TaskClassifier;

  constructor(classifier: TaskClassifier) {
    this._classifier = classifier;
  }

  canHandle(taskClass: MicroTaskClass): boolean {
    // Rules-модель может обработать все классы кроме llm_task
    return taskClass !== 'llm_task';
  }

  async handle(input: MicroInput, taskClass: MicroTaskClass): Promise<MicroResult> {
    const startTime = performance.now();
    const lang = input.language || 'ru';
    const lower = input.userMessage.toLowerCase().trim();
    const threshold = input.sessionSettings.microConfidenceThreshold || 0.8;

    switch (taskClass) {
      case 'small_talk':
        return this._handleSmallTalk(lower, lang, threshold, startTime);
      case 'classify':
        return this._handleClassify(lower, lang, threshold, startTime);
      case 'enum_decision':
        return this._handleEnumDecision(lower, lang, threshold, startTime);
      default:
        return this._unsure(taskClass, startTime, ['unsupported_task_class']);
    }
  }

  // ── private handlers ──

  private _handleSmallTalk(lower: string, lang: string, threshold: number, startTime: number): MicroResult {
    const categories = this._classifier.getCategorizedKeywords('small-talk', lang);
    const signals: string[] = [];

    for (const [catName, kws] of Object.entries(categories)) {
      if (!catName.endsWith('_keywords')) continue;
      const baseCatName = catName.replace(/_keywords$/, '');

      for (const kw of kws) {
        if (lower.includes(kw.toLowerCase())) {
          signals.push(`signal:${kw}`);
        }
      }

      if (signals.length > 0) {
        // Нашли категорию — берём готовый ответ
        const answersKey = `${baseCatName}_answers`;
        const answers = categories[answersKey] ?? [];
        const answer = answers.length > 0
          ? answers[Math.floor(Math.random() * answers.length)]!
          : this._getDefaultAnswer(baseCatName);

        const confidence = Math.min(0.7 + signals.length * 0.15, 0.99);
        return {
          status: confidence >= threshold ? 'OK' : 'UNSURE',
          taskClass: 'small_talk',
          label: baseCatName,
          confidence,
          answer: answer || undefined,
          latencyMs: Math.max(1, Math.round(performance.now() - startTime)),
          signals,
        };
      }
    }

    // Не нашли точную категорию, но small_talk — используем общий ответ
    return {
      status: 'OK',
      taskClass: 'small_talk',
      label: 'greeting',
      confidence: 0.75,
      answer: 'Привет! Чем могу помочь?',
      latencyMs: Math.max(1, Math.round(performance.now() - startTime)),
      signals: ['fallback_greeting'],
    };
  }

  private _handleClassify(lower: string, lang: string, threshold: number, startTime: number): MicroResult {
    const categories = this._classifier.getCategorizedKeywords('intents', lang);
    const signals: string[] = [];
    let bestCategory = '';
    let bestScore = 0;

    for (const [catName, kws] of Object.entries(categories)) {
      if (!catName.endsWith('_keywords')) continue;
      const baseCatName = catName.replace(/_keywords$/, '');
      let score = 0;

      for (const kw of kws) {
        if (lower.includes(kw.toLowerCase())) {
          score++;
          signals.push(`signal:${kw}`);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCategory = baseCatName;
      }
    }

    if (bestCategory && bestScore > 0) {
      const confidence = Math.min(0.5 + bestScore * 0.15, 0.95);
      return {
        status: confidence >= threshold ? 'OK' : 'UNSURE',
        taskClass: 'classify',
        label: bestCategory,
        confidence,
        latencyMs: Math.max(1, Math.round(performance.now() - startTime)),
        signals,
      };
    }

    return this._unsure('classify', startTime, ['no_intent_signals']);
  }

  private _handleEnumDecision(lower: string, lang: string, threshold: number, startTime: number): MicroResult {
    const categories = this._classifier.getCategorizedKeywords('enum', lang);
    let bestCategory = '';
    let bestSignal = '';
    let bestScore = 0;

    for (const [catName, kws] of Object.entries(categories)) {
      if (!catName.endsWith('_keywords')) continue;
      const baseCatName = catName.replace(/_keywords$/, '');

      for (const kw of kws) {
        // Для коротких enum-запросов — точное совпадение или строгое включение
        if (lower === kw.toLowerCase() || lower.startsWith(kw.toLowerCase()) || lower.endsWith(kw.toLowerCase())) {
          if (kw.length > bestScore) {
            bestScore = kw.length;
            bestSignal = kw;
            bestCategory = baseCatName;
          }
        }
      }
    }

    if (bestCategory && bestScore > 0) {
      const confidence = 0.85; // высокая уверенность для точных совпадений
        return {
            status: 'OK',
            taskClass: 'enum_decision',
            label: bestCategory,
            confidence,
            latencyMs: Math.max(1, Math.round(performance.now() - startTime)),
            signals: [`signal:${bestSignal}`],
          };
    }

    // Пробуем fuzzy match — contains (выбираем самое длинное/специфичное совпадение)
    let fuzzyCategory = '';
    let fuzzySignal = '';
    let fuzzyScore = 0;
    for (const [catName, kws] of Object.entries(categories)) {
      if (!catName.endsWith('_keywords')) continue;
      const baseCatName = catName.replace(/_keywords$/, '');

      for (const kw of kws) {
        if (lower.includes(kw.toLowerCase()) && kw.length > fuzzyScore) {
          fuzzyScore = kw.length;
          fuzzySignal = kw;
          fuzzyCategory = baseCatName;
        }
      }
    }

    if (fuzzyCategory) {
      return {
        status: 'OK',
        taskClass: 'enum_decision',
        label: fuzzyCategory,
        confidence: 0.7,
        latencyMs: Math.max(1, Math.round(performance.now() - startTime)),
        signals: [`signal:${fuzzySignal}`],
      };
    }

    return this._unsure('enum_decision', startTime, ['no_enum_match']);
  }

  private _unsure(taskClass: MicroTaskClass, startTime: number, signals: string[]): MicroResult {
    return {
      status: 'UNSURE',
      taskClass,
      confidence: 0.3,
      latencyMs: Math.max(1, Math.round(performance.now() - startTime)),
      signals,
    };
  }

  private _getDefaultAnswer(category: string): string {
    switch (category) {
      case 'greeting':
        return 'Привет! Чем могу помочь?';
      case 'farewell':
        return 'До свидания! Обращайтесь, если понадоблюсь.';
      case 'thanks':
        return 'Пожалуйста! Рад помочь.';
      default:
        return 'Привет! Чем могу помочь?';
    }
  }
}
