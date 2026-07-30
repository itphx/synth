/**
 * ContentClassifier — классификатор запросов по содержимому (AD-034).
 * Определяет категорию запроса: coding, research, chat.
 * На первых порах — эвристики по ключевым словам.
 */

export type ContentCategory = 'coding' | 'chat' | 'research';

export interface ClassifyRequest {
  userMessage: string;
  systemPrompt?: string;
  toolCalls?: string[];
}

export interface ClassifyResult {
  category: ContentCategory;
  confidence: number;
  signals: string[];
}

const CODING_KEYWORDS = [
  'напиши', 'исправь', 'рефакторинг', 'функцию', 'компонент',
  'баг', 'ошибка', 'тест', 'код', 'реализуй', 'добавь', 'почини',
  'fix', 'implement', 'refactor', 'function', 'component',
  'bug', 'error', 'test', 'code',
];

const RESEARCH_KEYWORDS = [
  'исследуй', 'проанализируй', 'архитектур', 'почему', 'объясни',
  'как работает', 'найди', 'покажи', 'explain', 'analyze',
  'research', 'investigate', 'what is', 'how does',
];

const CODING_TOOLS = new Set([
  'write_file', 'edit_file', 'create_file', 'delete_file',
  'write', 'edit', 'patch', 'replace',
]);

export class ContentClassifier {
  classify(request: ClassifyRequest): ClassifyResult {
    const { userMessage, toolCalls } = request;
    const signals: string[] = [];
    const lower = userMessage.toLowerCase();

    // Если есть tool calls — приоритет coding
    if (toolCalls && toolCalls.length > 0) {
      const hasCodingTool = toolCalls.some((t) => {
        const lowerT = t.toLowerCase();
        return CODING_TOOLS.has(lowerT) || lowerT.includes('write') || lowerT.includes('edit');
      });
      if (hasCodingTool) {
        return {
          category: 'coding',
          confidence: 0.9,
          signals: [`tool_call: ${toolCalls.join(', ')}`],
        };
      }
    }

    // Проверка coding-ключевых слов
    for (const kw of CODING_KEYWORDS) {
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

    // Проверка research-ключевых слов
    const researchSignals: string[] = [];
    for (const kw of RESEARCH_KEYWORDS) {
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

    // Fallback: chat
    return {
      category: 'chat',
      confidence: 0.3,
      signals: ['fallback'],
    };
  }
}
