/**
 * DecisionContentClassifier — decision-классификатор категории запроса
 * (AD-084 × AD-034). Дополняет словарный `ContentClassifier`: вызывается только
 * когда keyword-классификатор неуверен и в сессии нет явной `routingCategory`,
 * и возвращает drop-in-совместимый `ClassifyResult`.
 *
 * Decision-модель (System One: Clef/Jev/…) за один forward-pass отвечает на
 * типизированный `choice`-вопрос `{coding|research|chat}`. Fail-safe: любая
 * ошибка, отключённый конфиг, отсутствие провайдера, низкая уверенность или
 * невалидная метка → `null` (роутер откатывается к прежнему keyword-фоллбеку),
 * исключения наружу не пробрасываются.
 *
 * Конфиг приходит геттером (closure) — значения читаются в момент вызова, что
 * позволяет обновлять runtime-настройки без пересоздания классификатора (Ф5).
 */
import type { DecisionQuestion } from '@itphx/synth-shared';
import type { ClassifyRequest, ClassifyResult, ContentCategory } from './content-classifier.js';
import type {
  DecisionConfigLike,
  DecisionProviderResolver,
} from './micro/models/decision-model.js';
import { warning } from '../../logger.js';

/** Идентификатор decision-вопроса (ответ — категория `coding|research|chat`). */
export const DECISION_CATEGORY_QUESTION_ID = 'category';

/** Допустимые категории (синхронно с `ContentCategory`). */
const CATEGORIES: readonly ContentCategory[] = ['coding', 'research', 'chat'];

/** Короткие описания категорий по языку запроса (`request.language`). */
const CATEGORY_CRITERIA: Record<'ru' | 'en', Record<ContentCategory, string>> = {
  ru: {
    coding: 'Написание, изменение или отладка кода; программирование, команды, конфиги.',
    research: 'Поиск и анализ информации, изучение темы, сравнение, объяснение.',
    chat: 'Обычный разговор, приветствие, small talk, личные вопросы без работы с кодом.',
  },
  en: {
    coding: 'Writing, modifying, or debugging code; programming, commands, configs.',
    research: 'Searching and analyzing information, studying a topic, comparing, explaining.',
    chat: 'Everyday conversation, greeting, small talk, personal questions unrelated to code.',
  },
};

/** Проверяет, что метка — валидная категория контента. */
function isContentCategory(value: string): value is ContentCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

export class DecisionContentClassifier {
  private readonly _resolver: DecisionProviderResolver;
  private readonly _getConfig: () => DecisionConfigLike | undefined;

  constructor(
    resolver: DecisionProviderResolver,
    getConfig: () => DecisionConfigLike | undefined,
  ) {
    this._resolver = resolver;
    this._getConfig = getConfig;
  }

  /**
   * Классифицирует запрос через decision-модель.
   * @returns `ClassifyResult` при уверенном ответе, иначе `null` (fail-safe).
   */
  async classify(request: ClassifyRequest): Promise<ClassifyResult | null> {
    const config = this._getConfig();
    if (!config || !config.enabled) return null;

    const providerName = config.provider;
    const modelName = config.model;
    if (!providerName || !modelName) return null;

    const provider = this._resolver.getDecisionProvider(providerName, modelName);
    if (!provider) {
      warning('DECISION', `decision-провайдер не найден: ${providerName}/${modelName}`);
      return null;
    }

    try {
      const question = this._buildQuestion(request.language);
      const response = await provider.decide(
        request.userMessage,
        { [DECISION_CATEGORY_QUESTION_ID]: question },
        { model: modelName },
      );

      const answer = response.answers[DECISION_CATEGORY_QUESTION_ID];
      if (!answer || answer.type !== 'choice') {
        warning('DECISION', 'decision-классификатор: нет choice-ответа');
        return null;
      }

      const category = answer.choice;
      if (!isContentCategory(category)) {
        warning('DECISION', `decision-классификатор: невалидная метка "${category}"`);
        return null;
      }

      const confidence = answer.confidence;
      if (!(confidence >= config.confidenceThreshold)) {
        warning(
          'DECISION',
          `decision-классификатор: низкая уверенность ${confidence.toFixed(2)} < ${config.confidenceThreshold}`,
        );
        return null;
      }

      return {
        category,
        confidence,
        signals: [`decision:${category}`],
      };
    } catch (err) {
      warning('DECISION', `Ошибка decision-классификатора: ${String(err).slice(0, 200)}`);
      return null;
    }
  }

  /** Строит `choice`-вопрос по языку запроса (ru/en, дефолт ru). */
  private _buildQuestion(language?: string): DecisionQuestion {
    const lang = language === 'en' ? 'en' : 'ru';
    const criteria: Record<string, string | null> = {};
    for (const category of CATEGORIES) {
      criteria[category] = CATEGORY_CRITERIA[lang][category];
    }
    return {
      type: 'choice',
      instructions: lang === 'en'
        ? 'Classify the user request into exactly one category.'
        : 'Определи категорию запроса пользователя — ровно одну.',
      criteria,
    };
  }
}
