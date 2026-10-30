/**
 * Суммаризация контекста — aux-LLM-вызов, который идёт через ту же обвязку,
 * что и основной ход: конфиг провайдера собирается общим `toCoreProviderConfig`,
 * поэтому `compatibility` из каталога провайдера доезжает до провайдера
 * суммаризации (ADR-117).
 *
 * Регрессия, которую держит тест: раньше в `optimizer.ts` жила собственная
 * копия `toCoreProviderConfig`, и правки общего шва (например поле
 * `compatibility`) в суммаризацию не попадали.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOptimizer } from './optimizer.js';
import { ContextConfig } from './config.js';
import { BaseProvider, ProviderFactory } from '../../providers/base.js';
import { MessageRole, makeTextPart } from '@itphx/synth-shared';
import type {
  LLMChunk,
  LLMResponse,
  ProviderConfig as SharedProviderConfig,
  Session,
} from '@itphx/synth-shared';

const MOCK_TYPE = 'mock-compat-sum';

/** Провайдер-заглушка: суммы не важны, важна собранная конфигурация. */
class CapturingProvider extends BaseProvider {
  async chat(): Promise<LLMResponse> {
    return {
      content: 'summary',
      model: this.model,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: 'summary', isFinal: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  getProviderName(): string {
    return MOCK_TYPE;
  }
}

function makeSession(overrides: Partial<Session['settings']> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: 'opt-compat',
    sessionOrigin: 'user',
    userId: 'u1',
    title: 'compat',
    messages: [
      { id: 'm1', role: MessageRole.USER, seq: 1, origin: 'local', parts: [makeTextPart('привет')], content: 'привет', createdAt: now, disabled: false, pinned: false, hidden: false },
      { id: 'm2', role: MessageRole.ASSISTANT, seq: 2, origin: 'local', parts: [makeTextPart('здравствуй')], content: 'здравствуй', createdAt: now, disabled: false, pinned: false, hidden: false },
      { id: 'm3', role: MessageRole.USER, seq: 3, origin: 'local', parts: [makeTextPart('как дела?')], content: 'как дела?', createdAt: now, disabled: false, pinned: false, hidden: false },
      { id: 'm4', role: MessageRole.ASSISTANT, seq: 4, origin: 'local', parts: [makeTextPart('хорошо')], content: 'хорошо', createdAt: now, disabled: false, pinned: false, hidden: false },
    ],
    pendingMessages: [],
    status: {},
    settings: {
      provider: 'compat-provider',
      model: 'deepseek-chat',
      language: 'ru',
      summarizationEnabled: true,
      summarizationHeadMessages: 2,
      summarizationTailMessages: 2,
      ...overrides,
    },
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  } as unknown as Session;
}

describe('ContextOptimizer: compatibility провайдера в суммаризации (ADR-117)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    ProviderFactory.register(MOCK_TYPE, CapturingProvider);
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-compat-'));
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete(MOCK_TYPE);
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOptimizer(shared: SharedProviderConfig): ContextOptimizer {
    const contextConfig = new ContextConfig({ userDataDir: tmpDir });
    return new ContextOptimizer(
      contextConfig,
      (name: string) => (name === shared.name ? shared : null),
      { provider: shared.name, model: 'deepseek-chat', temperature: 0.2, promptFile: 'SUMMARIZER' },
    );
  }

  it('provider.compatibility доезжает до провайдера суммаризации', () => {
    const optimizer = makeOptimizer({
      name: 'compat-provider',
      type: MOCK_TYPE,
      baseUrl: 'http://mock',
      apiKey: 'k',
      compatibility: { requireReasoning: true },
    } as unknown as SharedProviderConfig);

    const prep = optimizer.prepareSummarizationForOrchestrator(makeSession(), 'ru');

    expect(prep.provider).toBeInstanceOf(CapturingProvider);
    expect(prep.provider.model).toBe('deepseek-chat');
    expect(prep.provider.compatibility).toEqual({ requireReasoning: true });
  });

  it('без compatibility в каталоге поле не выдумывается (прежнее поведение)', () => {
    const optimizer = makeOptimizer({
      name: 'compat-provider',
      type: MOCK_TYPE,
      baseUrl: 'http://mock',
      apiKey: 'k',
    } as unknown as SharedProviderConfig);

    const prep = optimizer.prepareSummarizationForOrchestrator(makeSession(), 'ru');
    expect(prep.provider.compatibility).toBeUndefined();
  });
});
