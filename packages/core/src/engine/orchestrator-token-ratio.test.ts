/**
 * AD-071 §2.6: калибровка chars-per-token из фактического usage и применение
 * к последующим оценкам (`toolsDetail`/манифест).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { ContextConfig } from './context/config.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import {
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  type Message,
  type Session,
} from '@itphx/synth-shared';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeContextConfig(): ContextConfig {
  return {
    getModePrompt: () => '[MODE]',
    getPlanModePrompt: () => '[PLAN MODE]',
    getModePolicy: () => '[MODE POLICY]',
    getPlanGuide: () => '[PLAN GUIDE]',
  } as unknown as ContextConfig;
}

function makeUserMessage(content = 'Привет'): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/**
 * Провайдер, который отдаёт usage с inputTokens = promptChars / 6 (>= 500),
 * эмулируя фактический ratio ≈ 6.
 */
class RatioProvider extends BaseProvider {
  static observed = 6;
  static lastInputTokens = 0;
  static inputOverride: number | null = null;

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 1000, outputTokens: 1, totalTokens: 1001 } };
  }

  async *chatAsync(
    messages: LLMMessage[],
    systemPrompt?: unknown,
    tools?: Array<Record<string, unknown>>,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const systemText = typeof systemPrompt === 'string'
      ? systemPrompt
      : ((systemPrompt as { text?: string } | undefined)?.text ?? '');
    let chars = systemText.length;
    for (const m of messages) chars += m.content?.length ?? 0;
    if (tools && tools.length > 0) chars += JSON.stringify(tools).length;
    const inputTokens = RatioProvider.inputOverride ?? Math.max(500, Math.ceil(chars / RatioProvider.observed));
    RatioProvider.lastInputTokens = inputTokens;
    yield {
      content: 'ok',
      isFinal: true,
      usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
      model: this.model,
    };
  }

  getProviderName(): string {
    return 'ratiotest';
  }
}

describe('ChatOrchestrator — калибровка chars-per-token (AD-071 §2.6)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let orchestrator: ChatOrchestrator;
  let ratios: Map<string, number>;
  let calibrated: Array<{ model: string; ratio: number }>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-ratio-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ratios = new Map();
    calibrated = [];
    ProviderFactory.register('ratiotest', RatioProvider);

    const toolRegistry = createToolRegistry();
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      contextConfig: makeContextConfig(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'ratiotest',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      toolRegistry,
      agentRegistry: createAgentRegistry(toolRegistry),
      tokenRatioLoader: async (model) => ratios.get(model),
      onTokenRatioCalibrated: (model, ratio) => { ratios.set(model, ratio); calibrated.push({ model, ratio }); },
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('ratiotest');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createSession(): Promise<Session> {
    return sessionManager.createSession({
      title: 'ratio',
      settings: { provider: 'ratiotest', model: 'm', agentRole: 'developer' },
    });
  }

  async function runTurn(sessionId: string): Promise<void> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
  }

  it('без калибровки ratio = 4 по умолчанию', async () => {
    const session = await createSession();
    const info = await orchestrator.getPromptInfo(session);
    expect(info.manifest.ratio).toBe(4);
    const tool = info.toolsDetail.find((t) => t.name === 'read_file')!;
    expect(tool.ratio).toBe(4);
    expect(tool.estTokens).toBe(Math.ceil(tool.chars! / 4));
  });

  it('после ответа ratio калибруется из usage и применяется к оценкам', async () => {
    const session = await createSession();
    await runTurn(session.id);

    expect(calibrated.length).toBeGreaterThan(0);
    expect(RatioProvider.lastInputTokens).toBeGreaterThanOrEqual(500);
    const ratio = ratios.get('m');
    expect(ratio).toBeDefined();
    // observed ≈ 6 (в пределах 1.5..16), первый семпл — как есть.
    expect(ratio!).toBeGreaterThan(5);
    expect(ratio!).toBeLessThanOrEqual(8);

    const info = await orchestrator.getPromptInfo(session);
    expect(info.manifest.ratio).toBeCloseTo(ratio!, 5);
    const tool = info.toolsDetail.find((t) => t.name === 'read_file')!;
    expect(tool.ratio).toBeCloseTo(ratio!, 5);
    expect(tool.estTokens).toBe(Math.ceil(tool.chars! / ratio!));
    // Оценка по ratio 6 меньше, чем по дефолтному 4.
    expect(tool.estTokens!).toBeLessThan(Math.ceil(tool.chars! / 4));
  });

  it('маленький input (<500) не калибруется', async () => {
    RatioProvider.inputOverride = 100;
    try {
      const session = await createSession();
      await runTurn(session.id);
      expect(RatioProvider.lastInputTokens).toBe(100);
      expect(calibrated).toHaveLength(0);
      expect(ratios.get('m')).toBeUndefined();
    } finally {
      RatioProvider.inputOverride = null;
    }
  });
});
