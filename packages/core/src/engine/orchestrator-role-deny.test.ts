/**
 * ADR-070 §2.9.1: ролевой отказ (`matchedRule: 'role.unavailable'`) останавливает
 * ход после первой же итерации.
 *
 * Регресс бага сессии `mvqh7e8u-3-5lxg77a5`: агент `assistant` (нет capability
 * `shell`) дважды вызывал `execute_shell`, получал deny от permission-слоя,
 * затем возвращал пустой ответ — и пользователь видел общий
 * `session.denied_blocked` («действие заблокировано политикой безопасности»,
 * звучит как инцидент ИБ). Теперь: второго LLM-вызова нет, tool_result отказа
 * остаётся в истории, финальный текст — `session.role_tool_blocked` с tool/agent.
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
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import { ContextConfig } from './context/config.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { LLMMessage, CancellationToken } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import type { PermissionConfig, Message } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import { t as sm } from './system-messages.js';

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [
      { key: 'role', tier: 'stable', order: 10, content: 'system prompt' },
    ],
  } as unknown as ContextBuilder;
}

function makeMessage(): Message {
  return {
    id: generateId(),
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart('посмотри ветку')],
    content: 'посмотри ветку',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/**
 * Провайдер: первый (и единственный ожидаемый) вызов — `execute_shell`
 * (агенту `assistant` недоступен по роли), второй — текст. Второго вызова быть
 * не должно: иначе тест увидит его в `calls`.
 */
class MockRoleDenyProvider extends BaseProvider {
  static calls = 0;

  private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
    if (MockRoleDenyProvider.calls === 0) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_role0',
          function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'git log --oneline' }) },
        }],
      };
    }
    return { content: 'вторая итерация — быть не должно' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockRoleDenyProvider.calls++;
    return {
      content: next.content,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: next.toolCalls,
    };
  }

  async *chatAsync(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
    _debugCollector?: unknown,
    _cancellationToken?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const next = this._next();
    MockRoleDenyProvider.calls++;
    yield {
      content: next.content,
      isFinal: true,
      toolCalls: next.toolCalls,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockroledeny';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'synth-role-deny-'));
  const store = new FileStore({ dataDir: tmpDir });
  const sessionManager = new SessionManager(store);
  const eventBus = new EventBus();
  // ADR-075: file/shell-тулы доступны только при заданном workspace проекта —
  // ролевой слой проверяется раньше, но workspace задаём, чтобы отказ был
  // именно ролевым, а не `workspace`.
  const projectStore = new ProjectStore({ dataDir: tmpDir });
  const project = projectStore.create('RoleDeny', 'u1', { workspace: tmpDir });
  await projectStore.save(project);
  const orchestrator = new ChatOrchestrator({
    sessionManager,
    eventBus,
    contextBuilder: makeCtxBuilder(),
    providerLoader: (name: string) => {
      return {
        name,
        type: 'mockroledeny',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      } as unknown as import('@itphx/synth-shared').ProviderConfig;
    },
    toolRegistry: createToolRegistry(),
    agentRegistry: createAgentRegistry(),
    permissionConfig: { rules: {}, askTimeoutMs: 1000 } as PermissionConfig,
    projectStore,
    defaultWorkingDir: tmpDir,
    contextConfig: new ContextConfig({ userDataDir: join(tmpDir, 'context') }),
  });
  const session = await sessionManager.createSession({
    title: 'RoleDeny',
    projectId: project.id,
    // `assistant` не имеет capability `shell` — `execute_shell` недоступен по роли.
    settings: { provider: 'mockroledeny', model: 'm', systemPrompt: 'test', agentRole: 'assistant' },
  });
  await sessionManager.addMessage(session.id, makeMessage());
  return { orchestrator, sessionManager, eventBus, tmpDir, sessionId: session.id };
}

describe('ChatOrchestrator: ролевой deny останавливает ход', () => {
  let h: Harness;

  beforeEach(async () => {
    ProviderFactory.register('mockroledeny', MockRoleDenyProvider);
    MockRoleDenyProvider.calls = 0;
    h = await makeHarness();
  });

  afterEach(async () => {
    await rm(h.tmpDir, { recursive: true, force: true });
  });

  it('один role.unavailable → нет второй LLM-итерации, tool_result в истории, финал — session.role_tool_blocked', async () => {
    const published: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = h.orchestrator.createProcessMessage();
    const session = (await h.sessionManager.getSession(h.sessionId))!;
    const userMessage = session.messages.find((m) => m.role === MessageRole.USER)!;

    const result = await processMessage(
      session,
      userMessage,
      new AbortController().signal,
      (event, data) => published.push({ event, data }),
    );

    expect(result.error).toBeUndefined();
    // Второго LLM-вызова нет — цикл прерван после итерации с роль-отказом.
    expect(MockRoleDenyProvider.calls).toBe(1);

    const stored = (await h.sessionManager.getSession(h.sessionId))!;
    // tool-chain сохранён: assistant(tool_calls) → tool_result отказа.
    const assistantWithCalls = stored.messages.find(
      (m) => m.role === MessageRole.ASSISTANT && (m.toolCalls?.length ?? 0) > 0,
    );
    expect(assistantWithCalls).toBeDefined();
    const toolResult = stored.messages.find((m) => m.role === MessageRole.TOOL);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolCallId).toBe('call_role0');
    expect((toolResult!.metadata as Record<string, unknown> | undefined)?.permission).toMatchObject({
      action: 'deny',
      matched_rule: 'role.unavailable',
    });

    // Финальное сообщение — новый ключ, а не «заблокировано политикой ИБ».
    const final = stored.messages.filter((m) => m.role === MessageRole.ASSISTANT).at(-1)!;
    const expectedText = sm('session.role_tool_blocked', { tool: 'execute_shell', agent: 'assistant' });
    expect(final.content).toBe(expectedText);
    expect(final.metadata?.i18n).toEqual({
      key: 'session.role_tool_blocked',
      params: { tool: 'execute_shell', agent: 'assistant' },
    });
    expect(final.metadata?.status).toBe('stopped');

    const done = published.find((p) => p.event === 'stream.done');
    expect(done?.data).toMatchObject({ content: expectedText, status: 'stopped' });
    expect(done?.data.stopped_by_deny).toBeUndefined();
  });
});
