/**
 * ADR-070 §2.9.1 (обновлено 2026-10-29): отказ permission-слоя больше **не**
 * останавливает ход. Модель получает `tool_result` с причиной и продолжает
 * работу — может выбрать другой инструмент или дать текстовый ответ.
 *
 * Регресс бага сессии `mvqh7e8u-3-5lxg77a5`: агент без capability `shell`
 * вызывал `execute_shell`, получал ролевой deny, и ход умирал, хотя доступный
 * `project_repo_clone` мог решить задачу. Теперь: следующий LLM-вызов
 * происходит, доступный тул исполняется, ход завершается штатно. Фоллбек
 * `session.role_tool_blocked` остаётся только на случай пустого финального
 * ответа модели.
 *
 * В тесте роль — `researcher` (read-only, без `shell`): у `assistant` после
 * расширения capability shell появился, и ролевой deny на нём не воспроизвести.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

interface ScriptChunk {
  content: string;
  toolCalls?: Record<string, unknown>[];
}

/**
 * Провайдер: 1-й вызов — `execute_shell` (агенту `researcher` недоступен по
 * роли), 2-й — доступный `read_file`, 3-й — текст. Все три вызова ожидаются:
 * deny не обрывает ход, модель пробует другой инструмент.
 */
class MockRoleDenyProvider extends BaseProvider {
  static calls = 0;

  protected _script(): ScriptChunk[] {
    return [
      {
        content: '',
        toolCalls: [{
          id: 'call_role0',
          function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'git log --oneline' }) },
        }],
      },
      {
        content: '',
        toolCalls: [{
          id: 'call_read0',
          function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'notes.txt' }) },
        }],
      },
      { content: 'shell недоступен — прочитал файл и объяснил' },
    ];
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const script = this._script();
    const next = script[Math.min(MockRoleDenyProvider.calls, script.length - 1)]!;
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
    const script = this._script();
    const next = script[Math.min(MockRoleDenyProvider.calls, script.length - 1)]!;
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

/** Провайдер: 1-й вызов — ролевой deny, 2-й — пустой ответ (фоллбек-текст). */
class MockRoleDenyEmptyProvider extends BaseProvider {
  static calls = 0;

  private _next(): ScriptChunk {
    if (MockRoleDenyEmptyProvider.calls === 0) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_role0',
          function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'git log --oneline' }) },
        }],
      };
    }
    return { content: '' };
  }

  async chat(
    _messages: LLMMessage[],
    _systemPrompt?: string,
    _tools?: Record<string, unknown>[],
  ): Promise<import('@itphx/synth-shared').LLMResponse> {
    const next = this._next();
    MockRoleDenyEmptyProvider.calls++;
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
    MockRoleDenyEmptyProvider.calls++;
    yield {
      content: next.content,
      isFinal: true,
      toolCalls: next.toolCalls,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }

  getProviderName(): string {
    return 'mockroleempty';
  }
}

interface Harness {
  orchestrator: ChatOrchestrator;
  sessionManager: SessionManager;
  eventBus: EventBus;
  tmpDir: string;
  sessionId: string;
}

async function makeHarness(providerName: string): Promise<Harness> {
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
        type: providerName,
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
    // `researcher` не имеет capability `shell` — `execute_shell` недоступен по роли.
    settings: { provider: providerName, model: 'm', systemPrompt: 'test', agentRole: 'researcher' },
  });
  await sessionManager.addMessage(session.id, makeMessage());
  // Доступный тул `read_file` читает этот файл — доказательство, что после
  // deny модель может выполнить другой инструмент.
  await writeFile(join(tmpDir, 'notes.txt'), 'содержимое notes\n', 'utf8');
  return { orchestrator, sessionManager, eventBus, tmpDir, sessionId: session.id };
}

async function runHarness(h: Harness): Promise<{
  result: import('./orchestrator.js').ProcessMessageResult;
  published: Array<{ event: string; data: Record<string, unknown> }>;
}> {
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
  return { result, published };
}

describe('ChatOrchestrator: deny не останавливает ход', () => {
  beforeEach(() => {
    ProviderFactory.register('mockroledeny', MockRoleDenyProvider);
    ProviderFactory.register('mockroleempty', MockRoleDenyEmptyProvider);
    MockRoleDenyProvider.calls = 0;
    MockRoleDenyEmptyProvider.calls = 0;
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockroledeny');
    ProviderFactory['_providers'].delete('mockroleempty');
    MockRoleDenyProvider.calls = 0;
    MockRoleDenyEmptyProvider.calls = 0;
  });

  it('ролевой deny → следующая LLM-итерация, доступный тул исполняется, ход завершается нормально', async () => {
    const h = await makeHarness('mockroledeny');
    try {
      const { result, published } = await runHarness(h);

      expect(result.error).toBeUndefined();
      // Первый (deny), второй (read_file) и третий (текст) вызовы состоялись.
      expect(MockRoleDenyProvider.calls).toBe(3);

      const stored = (await h.sessionManager.getSession(h.sessionId))!;
      // tool-chain сохранён: два assistant(tool_calls) и два tool_result.
      const toolResults = stored.messages.filter((m) => m.role === MessageRole.TOOL);
      expect(toolResults).toHaveLength(2);

      const denied = toolResults.find((m) => m.toolCallId === 'call_role0')!;
      expect(denied).toBeDefined();
      expect((denied.metadata as Record<string, unknown> | undefined)?.permission).toMatchObject({
        action: 'deny',
        matched_rule: 'role.unavailable',
      });
      expect(denied.content).toContain('Permission denied');
      // Событие tool_call.result несёт isError (UI/модель видят отказ явно).
      const denyChunk = published.find(
        (p) => p.event === 'tool_call.result'
          && (p.data.result as { isError?: boolean } | undefined)?.isError === true
          && ((p.data.result as { content?: string }).content ?? '').includes('Permission denied'),
      );
      expect(denyChunk).toBeDefined();

      // Доступный тул после deny исполнен (не deny): содержимое файла в результате.
      const ok = toolResults.find((m) => m.toolCallId === 'call_read0')!;
      expect(ok).toBeDefined();
      expect(ok.content).toContain('содержимое notes');

      // Ход завершён содержательным ответом модели, а не фоллбеком отказа.
      const final = stored.messages.filter((m) => m.role === MessageRole.ASSISTANT).at(-1)!;
      expect(final.content).toBe('shell недоступен — прочитал файл и объяснил');
      expect(final.metadata?.i18n).toBeUndefined();
      expect(final.metadata?.status).not.toBe('stopped');

      const done = published.find((p) => p.event === 'stream.done');
      expect(done?.data).toMatchObject({
        content: 'shell недоступен — прочитал файл и объяснил',
        status: 'completed',
      });
      expect(done?.data.stopped_by_deny).toBeUndefined();
      expect(done?.data.deny_reason).toBeUndefined();
    } finally {
      await rm(h.tmpDir, { recursive: true, force: true });
    }
  });

  it('ролевой deny + пустой ответ модели → фоллбек session.role_tool_blocked (status stopped)', async () => {
    const h = await makeHarness('mockroleempty');
    try {
      const { result, published } = await runHarness(h);

      expect(result.error).toBeUndefined();
      // Вторая LLM-итерация состоялась (ход не оборван отказом).
      expect(MockRoleDenyEmptyProvider.calls).toBe(2);

      const expectedText = sm('session.role_tool_blocked', { tool: 'execute_shell', agent: 'researcher' });
      const stored = (await h.sessionManager.getSession(h.sessionId))!;
      const final = stored.messages.filter((m) => m.role === MessageRole.ASSISTANT).at(-1)!;
      expect(final.content).toBe(expectedText);
      expect(final.metadata?.i18n).toEqual({
        key: 'session.role_tool_blocked',
        params: { tool: 'execute_shell', agent: 'researcher' },
      });
      expect(final.metadata?.status).toBe('stopped');

      const done = published.find((p) => p.event === 'stream.done');
      expect(done?.data).toMatchObject({ content: expectedText, status: 'stopped' });
      expect(done?.data.stopped_by_deny).toBeUndefined();
    } finally {
      await rm(h.tmpDir, { recursive: true, force: true });
    }
  });
});
