/**
 * TaskClassifier — классифицирует запрос в один из четырёх классов (ADR-035).
 * small_talk | classify | enum_decision | llm_task
 *
 * Реализация: правила + ключевые слова через DictionaryStore.
 */
import type { MicroTaskClass, MicroInput } from './types.js';
import type { DictionaryStore } from '../dictionary-store.js';

export interface ClassifyOut {
  taskClass: MicroTaskClass;
  signals: string[];
}

export class TaskClassifier {
  private readonly _dict: DictionaryStore;
  private _smallTalkCache: { lang: string; keywords: string[]; categories: Record<string, string[]> } | null = null;
  private _intentsCache: { lang: string; keywords: Record<string, string[]> } | null = null;
  private _enumCache: { lang: string; keywords: Record<string, string[]> } | null = null;

  constructor(dictionaryStore: DictionaryStore) {
    this._dict = dictionaryStore;
  }

  /** Главный метод: классифицируем запрос. */
  classify(input: MicroInput): ClassifyOut {
    const { userMessage, language } = input;
    const lang = language || 'ru';
    const lower = userMessage.toLowerCase().trim();
    // Обновляем кеши при смене языка
    this._refreshCaches(lang);

    // 1. Проверка small_talk: приветствия, прощания, благодарности
    const stKeywords = this._smallTalkCache?.keywords ?? [];
    for (const kw of stKeywords) {
      if (lower.includes(kw)) {
        return { taskClass: 'small_talk', signals: [`keyword:${kw}`] };
      }
    }

    // 2. Вопрос → classify (intent-слова или short_question)
    const isQuestion = lower.includes('?')
      || lower.startsWith('что')
      || lower.startsWith('как')
      || lower.startsWith('почему')
      || lower.startsWith('зачем')
      || lower.startsWith('какой');

    if (isQuestion) {
      return { taskClass: 'classify', signals: ['short_question'] };
    }

    // 3. Intent-ключевые слова (question/command/review/explain/debug/fix/test) → classify
    const intentKeywords = this._intentsCache?.keywords ?? {};
    const allIntentKeywords = [
      ...(intentKeywords.question_keywords ?? []),
      ...(intentKeywords.command_keywords ?? []),
      ...(intentKeywords.review_keywords ?? []),
      ...(intentKeywords.explain_keywords ?? []),
      ...(intentKeywords.debug_keywords ?? []),
      ...(intentKeywords.fix_keywords ?? []),
      ...(intentKeywords.test_keywords ?? []),
    ];
    for (const kw of allIntentKeywords) {
      if (lower.includes(kw)) {
        return { taskClass: 'classify', signals: [`keyword:${kw}`] };
      }
    }

    // 4. Enum-ключевые слова (по границам слов) → enum_decision
    const enumKeywords = this._enumCache?.keywords ?? {};
    const kw = this._matchEnumKeyword(lower, enumKeywords);
    if (kw) {
      return { taskClass: 'enum_decision', signals: [`keyword:${kw}`] };
    }

    // 5. Всё остальное → llm_task (идёт в роутер)
    return { taskClass: 'llm_task', signals: ['fallback:llm_task'] };
  }

  /** Ищет enum-ключевое слово, отдавая приоритет самым длинным (специфичным). */
  private _matchEnumKeyword(lower: string, enumKeywords: Record<string, string[]>): string | null {
    const keywords: string[] = [];
    for (const kws of Object.values(enumKeywords)) {
      if (Array.isArray(kws)) keywords.push(...kws);
    }
    keywords.sort((a, b) => b.length - a.length);
    for (const kw of keywords) {
      if (this._containsWord(lower, kw)) return kw;
    }
    return null;
  }

  /** Матчинг по границам слов: «да» не срабатывает внутри «кода»/«падает». */
  private _containsWord(text: string, keyword: string): boolean {
    // \b не работает с кириллицей даже с флагом u — используем \p{L} с lookaround
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'u').test(text);
  }

  /** Получить категоризированные keywords для запрошенной категории. */
  getCategorizedKeywords(category: string, lang: string): Record<string, string[]> {
    this._refreshCaches(lang);
    if (category === 'small-talk') return this._smallTalkCache?.categories ?? {};
    if (category === 'intents') return this._intentsCache?.keywords ?? {};
    if (category === 'enum') return this._enumCache?.keywords ?? {};
    return {};
  }

  // ── private ──

  private _refreshCaches(lang: string): void {
    if (!this._smallTalkCache || this._smallTalkCache.lang !== lang) {
      const keywords = this._dict.getKeywords('small-talk', lang);
      const categories = this._dict.getCategorizedKeywords('small-talk', lang);
      this._smallTalkCache = { lang, keywords, categories };
    }
    if (!this._intentsCache || this._intentsCache.lang !== lang) {
      const categorizedIntents = this._dict.getCategorizedKeywords('intents', lang);
      this._intentsCache = { lang, keywords: categorizedIntents };
    }
    if (!this._enumCache || this._enumCache.lang !== lang) {
      const categorizedEnum = this._dict.getCategorizedKeywords('enum', lang);
      this._enumCache = { lang, keywords: categorizedEnum };
    }
  }
}
