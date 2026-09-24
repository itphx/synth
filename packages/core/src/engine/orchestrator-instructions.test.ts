/**
 * AD-069 Фаза 1: интеграция проектных инструкций с оркестратором.
 *
 * Проверяем: инструкции попадают в system prompt (блок `instructions`), их
 * изменение инвалидирует `promptStates` (generation bump, т.к. блок в тире
 * `context`), `enabled:false` и сессия без проекта инструкции не грузят.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstructionsConfig, Message, Project, Session, TokenUsage } from '@itphx/synth-shared';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { ProjectStoreLike } from './orchestrator.js';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';

class InstrProvider extends BaseProvider {
  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return {
      content: 'ok',
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const usage: TokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    yield { content: 'ok', isFinal: true, usage, model: this.model };
  }

  getProviderName(): string {
    return 'instrstub';
  }
}

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
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

function makeInstructionsConfig(overrides: Partial<InstructionsConfig> = {}): InstructionsConfig {
  return {
    enabled: true,
    claudeCompat: true,
    contextCompat: false,
    headRatio: 0.7,
    tailRatio: 0.2,
    windowRatio: 0.06,
    minChars: 20_000,
    maxCharsCeiling: 500_000,
    lazy: {
      enabled: true,
      maxAncestors: 5,
      maxChars: 8_000,
      excludeDirs: ['node_modules', '.git'],
    },
    fetch: { timeoutMs: 5_000, cacheTtlSec: 3_600, maxBytes: 262_144 },
    sources: [],
    excludeProjects: [],
    allowInstallTreeFallback: false,
    ...overrides,
  };
}

describe('ChatOrchestrator — проектные инструкции (AD-069 Фаза 1)', () => {
  let tmpDir: string;
  let wsDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStoreLike;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-instr-'));
    wsDir = join(tmpDir, 'ws');
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, 'AGENTS.md'), 'V1-INSTRUCTIONS', 'utf-8');
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    ProviderFactory.register('instrstub', InstrProvider);
    projectStore = {
      load: async (id: string) =>
        ({
          id,
          name: 'Proj',
          workspace: wsDir,
          invariants: '',
          plan: { version: 1, updatedAt: nowISO(), columns: [], items: [] },
        }) as unknown as Project,
    };
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('instrstub');
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(config?: InstructionsConfig): ChatOrchestrator {
    return new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      projectStore,
      defaultWorkingDir: wsDir,
      workspacesRoot: tmpDir,
      providerLoader: (name: string) =>
        ({
          name,
          type: 'instrstub',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      instructionsConfig: config,
      // AD-069 Фаза 2a: project-trust гейт — доверяем temp-workspace.
      instructionsTrustedProjectDirs: [wsDir],
    });
  }

  async function createSession(withProject: boolean): Promise<Session> {
    return sessionManager.createSession({
      title: 'Instr',
      projectId: withProject ? 'p1' : undefined,
      settings: { provider: 'instrstub', model: 'm', agentRole: 'developer' },
    });
  }

  async function runTurn(orchestrator: ChatOrchestrator, sessionId: string): Promise<Session> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return (await sessionManager.getSession(sessionId))!;
  }

  it('грузит AGENTS.md проекта и показывает блок instructions в манифесте', async () => {
    const orchestrator = makeOrchestrator(makeInstructionsConfig());
    const session = await createSession(true);

    const after = await runTurn(orchestrator, session.id);
    expect(after.promptStates!.developer!.generation).toBe(1);

    const info = await orchestrator.getPromptInfo(after);
    const entry = info.manifest.entries.find((e) => e.key === 'instructions');
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe('context');
    expect(entry!.chars).toBeGreaterThan(0);
  });

  it('смена AGENTS.md инвалидирует promptStates (generation bump) при неизменном stable-префиксе', async () => {
    const orchestrator = makeOrchestrator(makeInstructionsConfig());
    const session = await createSession(true);

    const first = await runTurn(orchestrator, session.id);
    expect(first.promptStates!.developer!.generation).toBe(1);
    const stablePrefixBefore = first.promptStates!.developer!.staticPrefix;

    // Контент инструкций изменился; stable-префикс — нет.
    await writeFile(join(wsDir, 'AGENTS.md'), 'V2-INSTRUCTIONS', 'utf-8');

    const second = await runTurn(orchestrator, session.id);
    const state = second.promptStates!.developer!;
    expect(state.generation).toBe(2);
    expect(state.reason).toBe('generation-change');
    expect(state.staticPrefix).toBe(stablePrefixBefore);

    // Повторный ход с тем же контентом — без нового bump.
    const third = await runTurn(orchestrator, session.id);
    expect(third.promptStates!.developer!.generation).toBe(2);
  });

  it('instructions.enabled=false: инструкции не грузятся и generation не растёт', async () => {
    const orchestrator = makeOrchestrator(makeInstructionsConfig({ enabled: false }));
    const session = await createSession(true);

    await runTurn(orchestrator, session.id);
    await writeFile(join(wsDir, 'AGENTS.md'), 'V2-INSTRUCTIONS', 'utf-8');
    const second = await runTurn(orchestrator, session.id);

    expect(second.promptStates!.developer!.generation).toBe(1);
    const info = await orchestrator.getPromptInfo(second);
    expect(info.manifest.entries.find((e) => e.key === 'instructions')).toBeUndefined();
  });

  it('сессия без проекта: проектные инструкции не грузятся (AD-040)', async () => {
    const orchestrator = makeOrchestrator(makeInstructionsConfig());
    const session = await createSession(false);

    const after = await runTurn(orchestrator, session.id);
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.entries.find((e) => e.key === 'instructions')).toBeUndefined();
  });

  it('systemPrompt override: инструкции не добавляются', async () => {
    const orchestrator = makeOrchestrator(makeInstructionsConfig());
    const session = await sessionManager.createSession({
      title: 'Override',
      projectId: 'p1',
      settings: {
        provider: 'instrstub',
        model: 'm',
        agentRole: 'developer',
        systemPrompt: 'MY-OVERRIDE',
      },
    });

    const after = await runTurn(orchestrator, session.id);
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.entries.find((e) => e.key === 'instructions')).toBeUndefined();
    expect(info.manifest.entries.find((e) => e.key === 'override')).toBeDefined();
  });

  it('excludeProjects: проект из списка не грузит инструкции', async () => {
    const orchestrator = makeOrchestrator(makeInstructionsConfig({ excludeProjects: ['p1'] }));
    const session = await createSession(true);

    const after = await runTurn(orchestrator, session.id);
    const info = await orchestrator.getPromptInfo(after);
    expect(info.manifest.entries.find((e) => e.key === 'instructions')).toBeUndefined();
  });
});
