/**
 * AD-075: workspace-гейт file/shell/git-тулов и мид-ходовая разблокировка.
 *
 * Сценарий: сессия без проекта (или проект без workspace) → file-тул deny
 * (`workspace.unavailable`); после успешного `project_create`/`project_workspace_set`
 * в том же ходе тулы разблокируются, относительный путь пишется в рабочий каталог
 * проекта. Тест ловит и баг рассинхронизации локальной сессии: `attachSessionToProject`
 * меняет `projectId` в свежей копии из хранилища, а не в объекте `_processMessage`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
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

/** Провайдер, выполняющий заданный сценарий шагов (статический — фабрика создаёт новый инстанс). */
class WorkspaceScriptProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _step = 0;

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._step = 0;
  }

  private _currentStep(): ScriptStep {
    const idx = Math.min(WorkspaceScriptProvider._step, Math.max(0, WorkspaceScriptProvider._script.length - 1));
    return WorkspaceScriptProvider._script[idx] ?? {};
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = this._currentStep();
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${WorkspaceScriptProvider._step}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    WorkspaceScriptProvider._step++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls,
    };
  }

  getProviderName(): string {
    return 'wsscript';
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

describe('ChatOrchestrator — workspace-гейт и мид-ходовая разблокировка (AD-075)', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let defaultWorkingDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let orchestrator: ChatOrchestrator;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-ws-gate-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    defaultWorkingDir = join(tmpDir, 'default-ws');
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    ProviderFactory.register('wsscript', WorkspaceScriptProvider);

    const toolRegistry = createToolRegistry();
    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'wsscript',
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
    ProviderFactory['_providers'].delete('wsscript');
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(
    sessionId: string,
  ): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await orchestrator.createProcessMessage()(
      fresh, msg, new AbortController().signal, (event, data) => chunks.push({ event, data }),
    );
    expect(result.error).toBeUndefined();
    return chunks;
  }

  function toolResult(
    chunks: Array<{ event: string; data: Record<string, unknown> }>,
    name: string,
  ): { content: string; isError?: boolean; metadata?: Record<string, unknown> } {
    const chunk = chunks.find((c) => c.event === 'tool_call.result' && c.data.name === name);
    expect(chunk, `нет tool_call.result для ${name}`).toBeDefined();
    return chunk!.data.result as { content: string; isError?: boolean; metadata?: Record<string, unknown> };
  }

  async function exists(file: string): Promise<boolean> {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  }

  it('сессия без проекта: write_file → deny(workspace), файл не создаётся', async () => {
    WorkspaceScriptProvider.configure([
      { toolCalls: [{ name: 'write_file', args: { file_path: 'a.txt', content: 'x' } }] },
      { content: 'готово' },
    ]);
    const session = await sessionManager.createSession({
      title: 'NoProject',
      userId: 'u1',
      settings: { provider: 'wsscript', model: 'm', agentRole: 'developer' },
    });

    const chunks = await runTurn(session.id);
    const res = toolResult(chunks, 'write_file');
    expect(res.isError).toBe(true);
    const permission = res.metadata?.permission as { action?: string; matched_rule?: string } | undefined;
    expect(permission?.action).toBe('deny');
    expect(permission?.matched_rule).toBe('workspace.unavailable');

    // Файл не появился ни в default-, ни в проектном workspace.
    expect(await exists(join(defaultWorkingDir, 'a.txt'))).toBe(false);
    expect(await exists(join(tmpDir, 'a.txt'))).toBe(false);
  });

  it('project_create с workspace в том же ходе разблокирует write_file (файл внутри workspace)', async () => {
    WorkspaceScriptProvider.configure([
      {
        toolCalls: [
          { name: 'project_create', args: { name: 'P', workspace: 'ws-int' } },
          { name: 'write_file', args: { file_path: 'hello.txt', content: 'data' } },
        ],
      },
      { content: 'готово' },
    ]);
    const session = await sessionManager.createSession({
      title: 'CreateThenWrite',
      userId: 'u1',
      settings: { provider: 'wsscript', model: 'm', agentRole: 'developer' },
    });

    const chunks = await runTurn(session.id);
    expect(toolResult(chunks, 'project_create').isError).not.toBe(true);
    // write_file в ТОЙ ЖЕ итерации после project_create — уже разрешён.
    const write = toolResult(chunks, 'write_file');
    expect(write.isError).not.toBe(true);

    // Файл создан внутри рабочего каталога нового проекта.
    const wsDir = join(workspacesRoot, 'ws-int');
    await expect(readFile(join(wsDir, 'hello.txt'), 'utf-8')).resolves.toBe('data');
    // Вне workspace файла нет.
    expect(await exists(join(defaultWorkingDir, 'hello.txt'))).toBe(false);
    expect(await exists(join(tmpDir, 'hello.txt'))).toBe(false);

    // Локальная синхронизация: сессия в хранилище привязана к проекту.
    const updated = (await sessionManager.getSession(session.id))!;
    expect(updated.projectId).toBeDefined();
    const project = await projectStore.load(updated.projectId!);
    expect(project?.workspace).toBe('ws-int');
  });

  it('проект без workspace: первый write_file → deny, project_workspace_set в том же ходе разблокирует', async () => {
    const project = projectStore.create('P2', 'u1');
    await projectStore.save(project);

    WorkspaceScriptProvider.configure([
      { toolCalls: [{ name: 'write_file', args: { file_path: 'first.txt', content: 'x' } }] },
      {
        toolCalls: [
          { name: 'project_workspace_set', args: { workspace: 'ws2' } },
          { name: 'write_file', args: { file_path: 'second.txt', content: 'y' } },
        ],
      },
      { content: 'готово' },
    ]);
    const session = await sessionManager.createSession({
      title: 'SetWorkspace',
      userId: 'u1',
      projectId: project.id,
      settings: { provider: 'wsscript', model: 'm', agentRole: 'developer' },
    });

    const chunks = await runTurn(session.id);
    // Первый write_file — deny.
    const first = chunks.find(
      (c) => c.event === 'tool_call.result' && c.data.name === 'write_file'
        && (c.data.result as { isError?: boolean }).isError === true,
    );
    expect(first).toBeDefined();
    expect(((first!.data.result as { metadata?: Record<string, unknown> }).metadata?.permission as { matched_rule?: string })?.matched_rule)
      .toBe('workspace.unavailable');

    // После project_workspace_set write_file прошёл, файл — в новом workspace.
    const wsDir = join(workspacesRoot, 'ws2');
    await expect(readFile(join(wsDir, 'second.txt'), 'utf-8')).resolves.toBe('y');
    expect(await exists(join(wsDir, 'first.txt'))).toBe(false);
    expect(await exists(join(defaultWorkingDir, 'first.txt'))).toBe(false);
  });
});
