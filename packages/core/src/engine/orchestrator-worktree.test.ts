/**
 * ADR-114 §3: per-session рабочий каталог (git worktree).
 *
 * Сценарий: сессия привязана к worktree → рабочий каталог хода — каталог
 * worktree (не `project.workspace`); каталог привязки исчез → ход
 * **не стартует** и завершается управляемой ошибкой
 * (`worktree_directory_missing`, повтор не поможет — тихий фоллбек в
 * `project.workspace` запрещён); саб-агент без своей привязки наследует
 * каталог родителя (своя привязка — приоритетнее); сессия без привязки
 * работает как прежде (каталог = `project.workspace`).
 *
 * Образец сборки оркестратора — `orchestrator-workspace.test.ts` (ADR-075).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { z } from 'zod';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { ProjectStore } from '../storage/project-store.js';
import { EventBus } from '../events/bus.js';
import { ProviderFactory, BaseProvider } from '../providers/base.js';
import type { ContextBuilder } from './context/builder.js';
import { createToolRegistry } from './tools/index.js';
import { createAgentRegistry } from './agents/index.js';
import {
  ToolCapability,
  generateId,
  MessageRole,
  nowISO,
  makeTextPart,
  type Message,
  type ToolContext,
  type ToolDefinition,
} from '@itphx/synth-shared';

interface ScriptStep {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content?: string;
}

/** Провайдер, выполняющий заданный сценарий шагов (статический — фабрика создаёт новый инстанс). */
class WorktreeScriptProvider extends BaseProvider {
  private static _script: ScriptStep[] = [];
  private static _step = 0;

  static configure(script: ScriptStep[]): void {
    this._script = script;
    this._step = 0;
  }

  private _currentStep(): ScriptStep {
    const idx = Math.min(WorktreeScriptProvider._step, Math.max(0, WorktreeScriptProvider._script.length - 1));
    return WorktreeScriptProvider._script[idx] ?? {};
  }

  async chat(): Promise<import('@itphx/synth-shared').LLMResponse> {
    return { content: 'done', model: this.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  }

  async *chatAsync(): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    const step = this._currentStep();
    const toolCalls = step.toolCalls?.map((t) => ({
      id: `call_${t.name}_${WorktreeScriptProvider._step}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }));
    WorktreeScriptProvider._step++;
    yield {
      content: step.content ?? '',
      isFinal: true,
      model: this.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls,
    };
  }

  getProviderName(): string {
    return 'wtscript';
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

/** Снимок контекста тула, в котором был вызван зонд `probe_cwd`. */
interface ProbeCall {
  workingDir: string;
  worktreeId?: string;
  worktreeRepoPath?: string;
}

describe('ChatOrchestrator — per-session cwd привязки к worktree (ADR-114 §3)', () => {
  let tmpDir: string;
  let workspacesRoot: string;
  let defaultWorkingDir: string;
  let projectWorkspace: string;
  let worktreeDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let orchestrator: ChatOrchestrator;
  /** Вызовы зонда (последний — актуальный). */
  let probeCalls: ProbeCall[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-wt-cwd-'));
    workspacesRoot = join(tmpDir, 'workspaces');
    defaultWorkingDir = join(tmpDir, 'default-ws');
    projectWorkspace = join(workspacesRoot, 'proj-ws');
    worktreeDir = join(tmpDir, 'worktrees', 'feature-x');
    await mkdir(projectWorkspace, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });

    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    ProviderFactory.register('wtscript', WorktreeScriptProvider);
    probeCalls = [];

    const toolRegistry = createToolRegistry();
    // Зонд: единственный тул, дающий доступ к `ToolContext.workingDir` и
    // привязке сессии (ADR-114) — их и проверяем.
    const probeTool: ToolDefinition = {
      name: 'probe_cwd',
      description: 'Probe the working directory of the current tool context.',
      parameters: z.object({}),
      capabilities: [ToolCapability.FILE_READ],
      async execute(_args, ctx: ToolContext) {
        probeCalls.push({
          workingDir: ctx.workingDir,
          worktreeId: ctx.worktreeId,
          worktreeRepoPath: ctx.worktreeRepoPath,
        });
        return { content: ctx.workingDir, metadata: { workingDir: ctx.workingDir } };
      },
    };
    toolRegistry.register(probeTool);

    orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus: new EventBus(),
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'wtscript',
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
    ProviderFactory['_providers'].delete('wtscript');
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Проект с заданным workspace (абсолютный путь — резолвится как есть). */
  async function seedProject(name = 'P'): Promise<string> {
    const project = projectStore.create(name, 'u1', { workspace: projectWorkspace });
    await projectStore.save(project);
    return project.id;
  }

  /** Привязка сессии к worktree (ADR-114 §1.3). */
  async function bindWorktree(
    sessionId: string,
    directory: string,
    projectId: string,
    repoPath?: string,
  ): Promise<void> {
    await sessionManager.withLock(sessionId, async (s) => {
      s.worktree = {
        worktreeId: 'wkt_test',
        projectId,
        ...(repoPath !== undefined ? { repoPath } : {}),
        directory,
        branch: 'feature/x',
      };
      await sessionManager.saveSession(s);
    });
  }

  /** Сценарий хода: один вызов зонда, затем финальный ответ. */
  function configureProbeScript(): void {
    WorktreeScriptProvider.configure([
      { toolCalls: [{ name: 'probe_cwd', args: {} }] },
      { content: 'готово' },
    ]);
  }

  /** Прогоняет ход и возвращает результат (без требования отсутствия ошибки). */
  async function runTurn(sessionId: string): Promise<{
    result: { error?: string; errorType?: string; canRetry?: boolean };
    chunks: Array<{ event: string; data: Record<string, unknown> }>;
  }> {
    const msg = makeUserMessage();
    await sessionManager.addMessage(sessionId, msg);
    const fresh = (await sessionManager.getSession(sessionId))!;
    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await orchestrator.createProcessMessage()(
      fresh,
      msg,
      new AbortController().signal,
      (event, data) => chunks.push({ event, data }),
    );
    return { result, chunks };
  }

  it('сессия с привязкой: рабочий каталог хода — каталог worktree, а не project.workspace', async () => {
    const projectId = await seedProject();
    const session = await sessionManager.createSession({
      title: 'Bound',
      userId: 'u1',
      projectId,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    await bindWorktree(session.id, worktreeDir, projectId);
    configureProbeScript();

    const { result } = await runTurn(session.id);
    expect(result.error).toBeUndefined();

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.workingDir).toBe(normalize(worktreeDir));
    // Приоритет: каталог worktree, а не workspace проекта.
    expect(probeCalls[0]!.workingDir).not.toBe(normalize(projectWorkspace));
    // Привязка видна тулам (containment от каталога worktree, поиск записи
    // реестра git по `worktreeRepoPath`).
    expect(probeCalls[0]!.worktreeId).toBe('wkt_test');
    expect(probeCalls[0]!.worktreeRepoPath).toBe('.');
  });

  it('каталог привязки исчез: ход завершается управляемой ошибкой, повтор не предлагается', async () => {
    const projectId = await seedProject();
    const session = await sessionManager.createSession({
      title: 'Missing',
      userId: 'u1',
      projectId,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    const missingDir = join(tmpDir, 'worktrees', 'deleted');
    await bindWorktree(session.id, missingDir, projectId);
    configureProbeScript();

    // Исключение не вылетает наружу — ход возвращает управляемую ошибку.
    const { result } = await runTurn(session.id);

    expect(result.error).toBeDefined();
    expect(result.errorType).toBe('worktree_directory_missing');
    expect(result.canRetry).toBe(false);
    // Текст — i18n-сообщение движка, а не «internal»/500.
    expect(result.error).toContain('worktree');
    expect(result.error).toContain(missingDir);
    expect(result.error).not.toMatch(/internal|500/i);
    // Инструменты не запускались: каталога нет — ход не стартовал.
    expect(probeCalls).toHaveLength(0);

    // Assistant-сообщение об ошибке сохранено с i18n-ключом (ADR-041).
    const stored = (await sessionManager.getSession(session.id))!;
    const errorMessage = [...stored.messages].reverse().find((m) => m.role === MessageRole.ASSISTANT);
    expect(errorMessage).toBeDefined();
    expect((errorMessage!.metadata as { i18n?: { key?: string } })?.i18n?.key)
      .toBe('worktree.directory_missing');
  });

  it('саб-агент без своей привязки наследует каталог родителя', async () => {
    const projectId = await seedProject();
    const parent = await sessionManager.createSession({
      title: 'Parent',
      userId: 'u1',
      projectId,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    await bindWorktree(parent.id, worktreeDir, projectId);

    const child = await sessionManager.createSession({
      title: 'Child',
      userId: 'u1',
      projectId,
      parentId: parent.id,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    configureProbeScript();

    const { result } = await runTurn(child.id);
    expect(result.error).toBeUndefined();
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.workingDir).toBe(normalize(worktreeDir));
  });

  it('собственная привязка саб-агента важнее привязки родителя', async () => {
    const projectId = await seedProject();
    const parent = await sessionManager.createSession({
      title: 'Parent',
      userId: 'u1',
      projectId,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    await bindWorktree(parent.id, worktreeDir, projectId);

    const childDir = join(tmpDir, 'worktrees', 'child-x');
    await mkdir(childDir, { recursive: true });
    const child = await sessionManager.createSession({
      title: 'Child',
      userId: 'u1',
      projectId,
      parentId: parent.id,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    await bindWorktree(child.id, childDir, projectId);
    configureProbeScript();

    const { result } = await runTurn(child.id);
    expect(result.error).toBeUndefined();
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.workingDir).toBe(normalize(childDir));
    expect(probeCalls[0]!.workingDir).not.toBe(normalize(worktreeDir));
  });

  it('привязка с repoPath: тулам передаётся путь репозитория worktree (worktreeRepoPath)', async () => {
    const projectId = await seedProject();
    const session = await sessionManager.createSession({
      title: 'BoundRepo',
      userId: 'u1',
      projectId,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    await bindWorktree(session.id, worktreeDir, projectId, 'repo');
    configureProbeScript();

    const { result } = await runTurn(session.id);
    expect(result.error).toBeUndefined();
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.workingDir).toBe(normalize(worktreeDir));
    // Путь репозитория worktree относительно `project.workspace` — по нему
    // git-тулы ищут запись реестра `project.repos` (ADR-114 §4).
    expect(probeCalls[0]!.worktreeRepoPath).toBe('repo');
  });

  it('сессия без привязки: рабочий каталог — project.workspace (прежнее поведение)', async () => {
    const projectId = await seedProject();
    const session = await sessionManager.createSession({
      title: 'Plain',
      userId: 'u1',
      projectId,
      settings: { provider: 'wtscript', model: 'm', agentRole: 'developer' },
    });
    configureProbeScript();

    const { result } = await runTurn(session.id);
    expect(result.error).toBeUndefined();
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]!.workingDir).toBe(normalize(projectWorkspace));
    // Привязки нет — и тулы её не видят (прежнее поведение).
    expect(probeCalls[0]!.worktreeId).toBeUndefined();
    expect(probeCalls[0]!.worktreeRepoPath).toBeUndefined();
  });
});
