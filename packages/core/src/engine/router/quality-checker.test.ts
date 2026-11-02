/**
 * ADR-102: self-check возвращает usage (aux-вызов, не сообщение).
 */
import { describe, expect, it, vi } from 'vitest';
import type { LLMResponse } from '@itphx/synth-shared';
import type { BaseProvider } from '../../providers/base.js';
import { QualityChecker } from './quality-checker.js';

function provider(score: string, usage?: LLMResponse['usage']): BaseProvider {
  return {
    chat: vi.fn(async () => ({ content: score, ...(usage ? { usage } : {}) })),
  } as unknown as BaseProvider;
}

describe('QualityChecker — usage self-check (ADR-102)', () => {
  it('возвращает usage self-check-вызова', async () => {
    const usage = { inputTokens: 7, outputTokens: 1, totalTokens: 8 };
    const checker = new QualityChecker();
    const result = await checker.check({
      content: 'хороший ответ',
      checks: ['self_check'],
      minLength: 1,
      provider: provider('9', usage),
    });

    expect(result.pass).toBe(true);
    expect(result.usage).toEqual(usage);
  });

  it('без self_check usage нет', async () => {
    const checker = new QualityChecker();
    const result = await checker.check({
      content: 'ответ',
      checks: ['min_length'],
      minLength: 1,
    });
    expect(result.usage).toBeUndefined();
  });
});
