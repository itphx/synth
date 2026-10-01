/**
 * fs.changed: после успешного мутирующего тула оркестратор публикует событие
 * для UI (обновление дерева Files / открытых редакторов / Git-вкладки).
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
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import { generateId, MessageRole, nowISO, makeTextPart, type Message } from '@itphx/synth-shared';

interface ScriptStep {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content?: string;
}

class FsScriptProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _step = 0;

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._step = 0;
  }

  private _currentStep(): ScriptStep {
    const idx = Math.min(FsScriptProvider._step, Math.max(0, FsScriptProvider._script.length - 1));
    return FsScriptProvider._script[idx] ?? {};
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = this._currentStep();
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${FsScriptProvider._step}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    FsScriptProvider._step++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls,
    };
  }

  getProviderName(): string {
    return 'fsscript';
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

function makeUserMessage(content = 'выполни задачу'): Message {
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

type RecordedEvent = { type: string; data: Record<string, unknown> };

describe('ChatOrchestrator — fs.changed после мутирующих тулов', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let defaultWorkingDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let eventBus: EventBus;
  let orchestrator: ChatOrchestrator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-change-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    defaultWorkingDir = join(tmpDir, 'default-ws');
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    ProviderFactory.register('fsscript', FsScriptProvider);
    eventBus = new EventBus();

    const toolRegistry = createToolRegistry();
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'fsscript',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      toolRegistry,
      agentRegistry: createAgentRegistry(toolRegistry),
      permissionConfig: { rules: {}, askTimeoutMs: 1000 },
      projectStore,
      dataDir: tmpDir,
      workspacesRoot,
      defaultWorkingDir,
    });
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('fsscript');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(sessionId: string): Promise<RecordedEvent[]> {
    const events: RecordedEvent[] = [];
    const unsubscribe = eventBus.subscribeAll((e) => {
      events.push({ type: e.type, data: e.data });
    });
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    const result = await orchestrator.createProcessMessage()(
      fresh, msg, new AbortController().signal, () => {},
    );
    unsubscribe();
    expect(result.error).toBeUndefined();
    return events;
  }

  it('успешный write_file → fs.changed scope=file с относительным путём', async () => {
    const project = projectStore.create('P', 'u1', { workspace: 'ws-fs' });
    await projectStore.save(project);
    FsScriptProvider.configure([
      { toolCalls: [{ name: 'write_file', args: { file_path: 'sub/hello.txt', content: 'data' } }] },
      { content: 'готово' },
    ]);
    const session = await sessionManager.createSession({
      title: 'FsChange',
      userId: 'u1',
      projectId: project.id,
      settings: { provider: 'fsscript', model: 'm', agentRole: 'developer' },
    });

    const events = await runTurn(session.id);
    const changes = events.filter((e) => e.type === 'fs.changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.data).toMatchObject({
      session_id: session.id,
      project_id: project.id,
      scope: 'file',
      paths: ['sub/hello.txt'],
      tool: 'write_file',
    });
  });

  it('успешный project_workspace_set → fs.changed scope=all, workspace_changed', async () => {
    const project = projectStore.create('P2', 'u1');
    await projectStore.save(project);
    FsScriptProvider.configure([
      { toolCalls: [{ name: 'project_workspace_set', args: { workspace: 'ws-fs-2' } }] },
      { content: 'готово' },
    ]);
    const session = await sessionManager.createSession({
      title: 'FsChangeWs',
      userId: 'u1',
      projectId: project.id,
      settings: { provider: 'fsscript', model: 'm', agentRole: 'developer' },
    });

    const events = await runTurn(session.id);
    const changes = events.filter((e) => e.type === 'fs.changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.data).toMatchObject({
      project_id: project.id,
      scope: 'all',
      workspace_changed: true,
      tool: 'project_workspace_set',
    });
  });
});
