/**
 * AD-071 §2.6: instance-wide отключение инструментов (`tools.disabled`) —
 * жёсткое исключение из запроса независимо от `tools.policy`, пометка в
 * `toolsDetail`, отсутствие unavailable-подсказок, защита `runtime`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
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
  type SessionMode,
} from '@itphx/synth-shared';

const UNAVAILABLE_MARKER = '[НЕДОСТУПНЫЕ ТУЛЫ]';

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

class ToolCaptureProvider extends BaseProvider {
  static lastTools: Array<Record<string, unknown>> | undefined;

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'ok', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: unknown,
    tools?: Array<Record<string, unknown>>,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    ToolCaptureProvider.lastTools = tools;
    yield { content: 'ok', isFinal: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: this.model };
  }

  getProviderName(): string {
    return 'toolcapture';
  }
}

describe('ChatOrchestrator — tools.disabled (AD-071 §2.6)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let projectId: string;
  let orchestrator: ChatOrchestrator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-disabled-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    // AD-075: file/shell/git-тулы доступны только при заданном workspace проекта.
    const project = projectStore.create('Disabled', 'u1', { workspace: tmpDir });
    await projectStore.save(project);
    projectId = project.id;
    ToolCaptureProvider.lastTools = undefined;
    ProviderFactory.register('toolcapture', ToolCaptureProvider);

    const toolRegistry = createToolRegistry();
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      contextConfig: makeContextConfig(),
      providerLoader: (name: string) =>
        ({
          name,
          type: 'toolcapture',
          baseUrl: '',
          apiKey: '',
          defaultModel: 'm',
        }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      defaultWorkingDir: tmpDir,
      projectStore,
      toolRegistry,
      agentRegistry: createAgentRegistry(toolRegistry),
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('toolcapture');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createSession(mode: SessionMode = 'act'): Promise<Session> {
    return sessionManager.createSession({
      title: 'tools disabled',
      projectId,
      settings: { provider: 'toolcapture', model: 'm', agentRole: 'developer' },
    }).then(async (session) => {
      session.mode = mode;
      await sessionManager.saveSession(session);
      return session;
    });
  }

  async function runTurn(sessionId: string): Promise<Session> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    await orchestrator.createProcessMessage()(fresh, msg, new AbortController().signal, () => {});
    return (await sessionManager.getSession(sessionId))!;
  }

  function toolNames(): string[] {
    return (ToolCaptureProvider.lastTools ?? []).map(
      (t) => (t.function as { name: string }).name,
    );
  }

  it('отключение по capability: git_read исчезает из запроса, остальное остаётся', async () => {
    orchestrator.setToolsDisabled({ capabilities: ['git_read'], tools: [] });
    const session = await createSession();
    await runTurn(session.id);

    const names = toolNames();
    expect(names).not.toContain('git_status');
    expect(names).not.toContain('git_diff');
    expect(names).not.toContain('git_log');
    expect(names).toContain('read_file');
    expect(names).toContain('git_commit'); // git_write не тронут
  });

  it('отключение по имени: web_search исчезает, web_fetch остаётся', async () => {
    orchestrator.setToolsDisabled({ capabilities: [], tools: ['web_search'] });
    const session = await createSession();
    await runTurn(session.id);

    const names = toolNames();
    expect(names).not.toContain('web_search');
    expect(names).toContain('web_fetch');
  });

  it('admin-disabled помечается в toolsDetail с причиной admin_disabled и chars/estTokens', async () => {
    orchestrator.setToolsDisabled({ capabilities: ['git_read'], tools: [] });
    const session = await createSession();
    await runTurn(session.id);

    const info = await orchestrator.getPromptInfo(session);
    const git = info.toolsDetail.find((t) => t.name === 'git_status')!;
    expect(git.adminDisabled).toBe(true);
    expect(git.available).toBe(false);
    expect(git.reason).toBe('admin_disabled');
    expect(git.chars).toBeGreaterThan(0);
    expect(git.estTokens).toBe(Math.ceil(git.chars! / 4));
    expect(git.ratio).toBe(4);

    const read = info.toolsDetail.find((t) => t.name === 'read_file')!;
    expect(read.adminDisabled).toBeUndefined();
    expect(read.available).toBe(true);
    expect(read.chars).toBeGreaterThan(0);
  });

  it('runtime-тулы защищены: capability runtime игнорируется, plan_read остаётся', async () => {
    orchestrator.setToolsDisabled({ capabilities: ['runtime'], tools: [] });
    const session = await createSession('plan');
    await runTurn(session.id);

    const names = toolNames();
    expect(names).toContain('plan_read');
    expect(names).toContain('todo_list');
    expect(names).toContain('classify_conversation');

    const info = await orchestrator.getPromptInfo(session);
    const planRead = info.toolsDetail.find((t) => t.name === 'plan_read')!;
    expect(planRead.adminDisabled).toBeUndefined();
  });

  it('admin-disabled не попадают в unavailable-подсказки', async () => {
    orchestrator.setToolsDisabled({ capabilities: ['file_write'], tools: [] });
    const session = await createSession('plan');
    await runTurn(session.id);

    const after = (await sessionManager.getSession(session.id))!;
    const marker = after.messages.find((m) => m.content.includes(UNAVAILABLE_MARKER));
    expect(marker).toBeDefined();
    // write-тулы административно отключены — о них не подсказываем.
    expect(marker!.content).not.toContain('write_file');
    // git_write всё ещё недоступен по режиму — подсказка остаётся.
    expect(marker!.content).toContain('git_commit');
  });
  it('отключение по capability web убирает оба web-тула', async () => {
    orchestrator.setToolsDisabled({ capabilities: ['web'], tools: [] });
    const session = await createSession();
    await runTurn(session.id);
    const names = toolNames();
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('web_search');
  });
});
