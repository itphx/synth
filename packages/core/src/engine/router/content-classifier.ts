/**
 * ContentClassifier — классификатор запросов по содержимому (ADR-034).
 * Определяет категорию запроса: coding, research, chat.
 * Ключевые слова загружаются из DictionaryStore (YAML-файлы с языковой поддержкой).
 */
import type { DictionaryStore } from './dictionary-store.js';

export type ContentCategory = 'coding' | 'chat' | 'research';

export interface ClassifyRequest {
  userMessage: string;
  systemPrompt?: string;
  toolCalls?: string[];
  language?: string;
  /** PROP-085 задел: изображения текущего запроса (для decision-классификатора). */
  images?: string[];
  /** PROP-085 задел: видео текущего запроса (для decision-классификатора). */
  videos?: string[];
}

export interface ClassifyResult {
  category: ContentCategory;
  confidence: number;
  signals: string[];
}

export class ContentClassifier {
  private readonly _dict: DictionaryStore;
  private _codingKeywordsCache: string[] | null = null;
  private _researchKeywordsCache: string[] | null = null;
  private _langCache: string | null = null;

  constructor(dictionaryStore: DictionaryStore) {
    this._dict = dictionaryStore;
  }

  classify(request: ClassifyRequest): ClassifyResult {
    const { userMessage, toolCalls, language } = request;
    const signals: string[] = [];
    const lower = userMessage.toLowerCase();

    // Загружаем ключевые слова (с кешированием по языку)
    const lang = language || 'ru';
    if (this._langCache !== lang) {
      this._codingKeywordsCache = null;
      this._researchKeywordsCache = null;
      this._langCache = lang;
    }
    const codingKeywords = this._codingKeywordsCache ??= this._dict.getKeywords('coding', lang);
    const researchKeywords = this._researchKeywordsCache ??= this._dict.getKeywords('research', lang);

    // 1. Если есть tool calls — приоритет coding
    if (toolCalls && toolCalls.length > 0) {
      const codingTools = this._dict.getCodingTools();
      const hasCodingTool = toolCalls.some((t) => {
        const lowerT = t.toLowerCase();
        return codingTools.some((ct) => lowerT === ct || lowerT.includes(ct));
      });
      if (hasCodingTool) {
        return {
          category: 'coding',
          confidence: 0.9,
          signals: [`tool_call: ${toolCalls.join(', ')}`],
        };
      }
    }

    // 2. Проверка coding-ключевых слов
    for (const kw of codingKeywords) {
      if (lower.includes(kw)) {
        signals.push(`keyword:${kw}`);
      }
    }
    if (signals.length > 0) {
      return {
        category: 'coding',
        confidence: Math.min(0.5 + signals.length * 0.1, 1.0),
        signals,
      };
    }

    // 3. Проверка research-ключевых слов
    const researchSignals: string[] = [];
    for (const kw of researchKeywords) {
      if (lower.includes(kw)) {
        researchSignals.push(`keyword:${kw}`);
      }
    }
    if (researchSignals.length > 0) {
      return {
        category: 'research',
        confidence: Math.min(0.5 + researchSignals.length * 0.1, 1.0),
        signals: researchSignals,
      };
    }

    // 4. Fallback: chat
    return {
      category: 'chat',
      confidence: 0.3,
      signals: ['fallback'],
    };
  }
}
