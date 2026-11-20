import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from '../orchestrator.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { EventBus } from '../../events/bus.js';
import { createToolRegistry } from '../tools/index.js';
import { ProviderFactory, BaseProvider } from '../../providers/base.js';
import { PermissionEvaluator } from './evaluator.js';
import { resolveEffectivePermission } from './effective.js';
import type { ContextBuilder } from '../context/builder.js';
import type { LLMMessage, CancellationToken } from '../../providers/base.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import { generateId, MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';

/**
 * ADR-029 (chain-no-copy): наследование грантов родителя дочерними сессиями —
 * **живое**. Правила читаются по цепочке `parentId` в момент проверки, поэтому
 * грант/отзыв у родителя виден ребёнку без пересоздания ребёнка.
 */

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
    parts: [makeTextPart('напиши файл')],
    content: 'напиши файл',
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    author: 'user',
    metadata: { stream_id: generateId() },
  };
}

/** Провайдер, который на первом вызове «зовёт» `write_file`, затем отвечает текстом. */
function makeWriteProvider() {
  return class extends BaseProvider {
    private _calls = 0;

    private _next(): { content: string; toolCalls?: Record<string, unknown>[] } {
      if (this._calls === 0) {
        return {
          content: '',
          toolCalls: [{
            id: 'call_write',
            function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'smoke.txt', content: 'x' }) },
          }],
        };
      }
      return { content: 'Готово' };
    }

    async chat(
      _messages: LLMMessage[],
      _systemPrompt?: string,
      _tools?: Record<string, unknown>[],
      _stream?: boolean,
      _debugCollector?: unknown,
    ): Promise<import('@itphx/synth-shared').LLMResponse> {
      const next = this._next();
      this._calls++;
      return {
        ...next,
        model: this.model,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
      this._calls++;
      yield {
        ...next,
        isFinal: true,
        model: this.model,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }

    getProviderName(): string {
      return 'mockinherit';
    }
  };
}

describe('ADR-029 (chain-no-copy): живое наследование прав по цепочке parentId', () => {
  let store: FileStore;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let projectId: string;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-inherit-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    projectStore = new ProjectStore({ dataDir: tmpDir });
    const project = projectStore.create('Inherit', 'u1', { workspace: tmpDir });
    await projectStore.save(project);
    projectId = project.id;
    eventBus = new EventBus();
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockinherit');
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Родитель + дочерняя сессия (без собственных правил, если не заданы). */
  async function makePair(childPermission?: PermissionConfig): Promise<{ parentId: string; childId: string }> {
    const parent = await sessionManager.createSession({ title: 'Parent', projectId });
    const child = await sessionManager.createSession({
      title: 'Child',
      projectId,
      parentId: parent.id,
      settings: childPermission ? { permission: childPermission } : {},
    });
    return { parentId: parent.id, childId: child.id };
  }

  /** Ход дочерней сессии через оркестратор: создан ли `smoke.txt`, был ли отказ. */
  async function runChildTurn(childId: string): Promise<{ denied: boolean; fileCreated: boolean }> {
    ProviderFactory.register('mockinherit', makeWriteProvider());
    const orchestrator = new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      providerLoader: (name: string) => ({
        name,
        type: 'mockinherit',
        baseUrl: '',
        apiKey: '',
        defaultModel: 'm',
      }) as unknown as import('@itphx/synth-shared').ProviderConfig,
      toolRegistry: createToolRegistry(),
      // Глобальный конфиг инстанса пуст: всё, что видит ребёнок, приходит
      // из цепочки `parentId` + собственных правил сессии.
      permissionConfig: { rules: {}, askTimeoutMs: 30_000 },
      projectStore,
      defaultWorkingDir: tmpDir,
    });

    const session = (await sessionManager.getSession(childId))!;
    if (!session.settings.provider) {
      await sessionManager.mutateMeta(childId, (meta) => {
        meta.settings = {
          ...meta.settings,
          provider: 'mockinherit',
          model: 'm',
          systemPrompt: 'test',
          agentRole: 'fixer',
        };
        // Ход начинается с чистого места: файл прошлого прогона удаляем.
      });
    }
    await rm(join(tmpDir, 'smoke.txt'), { force: true });
    const msg = makeMessage();
    await sessionManager.addMessage(childId, msg);
    const fresh = (await sessionManager.getSession(childId))!;

    const chunks: Array<{ event: string; data: Record<string, unknown> }> = [];
    const processMessage = orchestrator.createProcessMessage();
    const result = await processMessage(fresh, msg, new AbortController().signal, (event, data) => {
      chunks.push({ event, data });
    });
    expect(result.error).toBeUndefined();

    const toolResults = chunks
      .filter((c) => c.event === 'tool_call.result')
      .map((c) => c.data.result as { content: string; isError?: boolean });
    const denied = toolResults.some((r) => r.isError === true && r.content.includes('Permission denied'));

    let fileCreated = false;
    try {
      await access(join(tmpDir, 'smoke.txt'));
      fileCreated = true;
    } catch {
      fileCreated = false;
    }
    return { denied, fileCreated };
  }

  async function setPermission(sessionId: string, permission: PermissionConfig): Promise<void> {
    await sessionManager.mutateMeta(sessionId, (meta) => {
      meta.settings = { ...meta.settings, permission };
    });
  }

  it('грант родителя, выданный ПОСЛЕ создания ребёнка, виден ребёнку', async () => {
    const { parentId, childId } = await makePair();
    await setPermission(parentId, { rules: { write_file: 'deny' }, askTimeoutMs: 30_000 });

    // Ребёнок создан раньше гранта и своих правил не имеет — запрет родителя
    // действует через цепочку.
    const blocked = await runChildTurn(childId);
    expect(blocked.denied).toBe(true);
    expect(blocked.fileCreated).toBe(false);

    // Грант выдан родителю уже после создания ребёнка — копий в ребёнке нет.
    await setPermission(parentId, { rules: { write_file: 'allow' }, askTimeoutMs: 30_000 });
    const child = (await sessionManager.getSession(childId))!;
    expect(child.settings.permission).toBeUndefined();

    const allowed = await runChildTurn(childId);
    expect(allowed.denied).toBe(false);
    expect(allowed.fileCreated).toBe(true);
  });

  it('снятие allow у родителя видно ребёнку', async () => {
    const { parentId, childId } = await makePair();
    await setPermission(parentId, { rules: { write_file: 'allow' }, askTimeoutMs: 30_000 });
    const allowed = await runChildTurn(childId);
    expect(allowed.denied).toBe(false);
    expect(allowed.fileCreated).toBe(true);

    // Отзыв: родитель больше не разрешает запись — копии `write_file: allow`
    // в ребёнке нет, поэтому отзыв виден ребёнку без пересоздания.
    await setPermission(parentId, { rules: { '*': 'deny' }, askTimeoutMs: 30_000 });
    const child = (await sessionManager.getSession(childId))!;
    expect(child.settings.permission).toBeUndefined();
    const denied = await runChildTurn(childId);
    expect(denied.denied).toBe(true);
    expect(denied.fileCreated).toBe(false);
  });

  it('deny ребёнка приоритетнее allow родителя', async () => {
    const { parentId, childId } = await makePair({ rules: { write_file: 'deny' }, askTimeoutMs: 30_000 });
    await setPermission(parentId, { rules: { write_file: 'allow' }, askTimeoutMs: 30_000 });

    const r = await runChildTurn(childId);
    expect(r.denied).toBe(true);
    expect(r.fileCreated).toBe(false);
  });
});

describe('ADR-029 (chain-no-copy): резолв по цепочке на реальном SessionManager', () => {
  let sessionManager: SessionManager;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-chain-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('родитель → ребёнок → внук: правила всех уровней, грант родителя виден внуку', async () => {
    const root = await sessionManager.createSession({
      title: 'root',
      settings: { permission: { rules: { read_file: 'allow' }, askTimeoutMs: 1000 } },
    });
    const child = await sessionManager.createSession({ title: 'child', parentId: root.id });
    const grandchild = await sessionManager.createSession({
      title: 'grandchild',
      parentId: child.id,
      // Внук саб-агента ставит свой грант.
      settings: { permission: { rules: { write_file: 'allow' }, askTimeoutMs: 2000 } },
    });

    const loaded = (await sessionManager.getSession(grandchild.id))!;
    const resolved = await resolveEffectivePermission({
      session: loaded,
      getSession: (id) => sessionManager.getSession(id),
      fallback: { rules: { '*': 'ask' }, askTimeoutMs: 9000 },
    });
    expect(resolved.rules).toEqual({ '*': 'ask', read_file: 'allow', write_file: 'allow' });
    // `askTimeoutMs` — свой у сессии.
    expect(resolved.askTimeoutMs).toBe(2000);

    // Грант родителя, выданный после создания внука, виден следующему резолву.
    await sessionManager.mutateMeta(root.id, (meta) => {
      meta.settings = {
        ...meta.settings,
        permission: { rules: { read_file: 'allow', execute_shell: 'allow' }, askTimeoutMs: 1000 },
      };
    });
    const after = await resolveEffectivePermission({
      session: (await sessionManager.getSession(grandchild.id))!,
      getSession: (id) => sessionManager.getSession(id),
      fallback: { rules: {}, askTimeoutMs: 9000 },
    });
    expect(after.rules.execute_shell).toBe('allow');
    expect(new PermissionEvaluator(after).check({
      toolName: 'execute_shell',
      params: { command: 'ls' },
      workingDir: tmpDir,
      sessionMode: 'act',
      planMode: 'auto',
      planApproved: false,
    }).action).toBe('allow');
  });
});
