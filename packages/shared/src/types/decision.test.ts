import { describe, it, expect } from 'vitest';
import {
  decisionRequestSchema,
  decisionResponseSchema,
  decisionQuestionSchema,
} from './decision.js';

describe('decision Zod-схемы (AD-084)', () => {
  it('принимает запрос со всеми типами вопросов', () => {
    const parsed = decisionRequestSchema.safeParse({
      model: 'clef-flash',
      state: { text: 'hello' },
      questions: {
        q1: { type: 'noul', instructions: 'срочно?' },
        q2: { type: 'choice', instructions: 'категория?', criteria: { a: 'A', b: null } },
        q3: { type: 'score', instructions: 'оценка?', criteria: ['low', 'mid', 'high'] },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('отклоняет choice с менее чем 2 вариантами', () => {
    const parsed = decisionQuestionSchema.safeParse({
      type: 'choice',
      instructions: 'x',
      criteria: { a: null },
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет score с более чем 26 позициями', () => {
    const parsed = decisionQuestionSchema.safeParse({
      type: 'score',
      instructions: 'x',
      criteria: Array.from({ length: 27 }, (_, i) => `c${i}`),
    });
    expect(parsed.success).toBe(false);
  });

  it('принимает типизированный ответ', () => {
    const parsed = decisionResponseSchema.safeParse({
      id: 'r1',
      model: 'clef-flash',
      answers: {
        q1: { type: 'noul', noul: 0.5 },
        q2: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
        q3: { type: 'score', score: 1, confidence: 0.7, probabilities: { '0': 0.3, '1': 0.7 }, legend: { '1': 'mid' } },
      },
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(parsed.success).toBe(true);
  });

  it('отклоняет ответ с неизвестным типом', () => {
    const parsed = decisionResponseSchema.safeParse({
      answers: { q1: { type: 'unknown', value: 1 } },
    });
    expect(parsed.success).toBe(false);
  });
});
