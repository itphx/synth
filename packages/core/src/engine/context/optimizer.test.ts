import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOptimizer } from './optimizer.js';
import { ContextConfig } from './config.js';
import { BaseProvider } from '../../providers/base.js';
import type { LLMChunk, LLMResponse, Session } from '@itphx/synth-shared';

/** Мок провайдера: delta-чанки + финальный чанк с ПОЛНЫМ контентом (как реальный openai.ts). */
class MockStreamProvider extends BaseProvider {
  async chat(): Promise<LLMResponse> {
    return { content: 'итог', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(): AsyncGenerator<LLMChunk> {
    yield { content: 'ит', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { content: 'ог', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { content: 'итог', isFinal: true, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  getProviderName(): string {
    return 'mock-sum';
  }
}

function makeSession(): Session {
  return {
    id: 's1',
    parent_id: null,
    project_id: null,
    agent: 'developer',
    title: 'test',
    mode: 'act',
    settings: {
      language: 'ru',
      provider: 'mock',
      model: 'mock-model',
      temperature: 0.7,
      summarizationEnabled: true,
      summarizationTriggerMode: 'manual',
    },
    messages: [
      { id: 'm1', role: 'user', content: 'привет', seq: 1, origin: 'local', created_at: new Date().toISOString(), disabled: false, pinned: false, hidden: false },
      { id: 'm2', role: 'assistant', content: 'здравствуй', seq: 2, origin: 'local', created_at: new Date().toISOString(), disabled: false, pinned: false, hidden: false },
    ],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Session;
}

describe('ContextOptimizer.summarizeStream', () => {
  let tmpDir: string;
  let optimizer: ContextOptimizer;
  let mockProvider: MockStreamProvider;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-opt-'));
    mockProvider = new MockStreamProvider({ url: 'http://mock', apiKey: 'k', model: 'mock-model' });
    const config = new ContextConfig({ userDataDir: tmpDir });
    optimizer = new ContextOptimizer(config, () => null, {
      provider: 'mock',
      model: 'mock-model',
      temperature: 0.3,
      promptFile: 'SUMMARIZER',
    });
    // Подменяем фабрику провайдера: всегда возвращаем мок с delta + финальным чанком.
    const proto = ContextOptimizer.prototype as unknown as {
      _createSummarizationProvider: () => BaseProvider;
    };
    vi.spyOn(proto, '_createSummarizationProvider').mockReturnValue(mockProvider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('финальный чанк полного контента НЕ дублирует суммаризацию', async () => {
    const session = makeSession();
    const chunks: string[] = [];
    let doneContent = '';

    for await (const ev of optimizer.summarizeStream(session)) {
      if (ev.type === 'chunk') chunks.push(ev.content);
      if (ev.type === 'done') doneContent = ev.content;
    }

    // Финальный чанк («итог») не отдаётся как отдельный фрагмент UI
    expect(chunks.join('')).toBe('итог');
    // Итоговый контент — однократный (не «итогитог»)
    expect(doneContent).toBe('итог');
  });

  it('без финального чанка суммаризация собирается из delta-чанков', async () => {
    mockProvider.chatAsync = async function* () {
      yield { content: 'а', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { content: 'б', isFinal: false, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };

    const session = makeSession();
    const chunks: string[] = [];
    let doneContent = '';

    for await (const ev of optimizer.summarizeStream(session)) {
      if (ev.type === 'chunk') chunks.push(ev.content);
      if (ev.type === 'done') doneContent = ev.content;
    }

    expect(chunks.join('')).toBe('аб');
    expect(doneContent).toBe('аб');
  });
});
