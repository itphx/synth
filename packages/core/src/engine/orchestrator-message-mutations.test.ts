/**
 * Этап 2b-2b-1: точечные мутации сообщений в оркестраторе (порт
 * `mutateMessage`/`mutateMeta`) — паритет `updatedAt` и целостность истории.
 *
 * Контракты (паритет с прежними `saveSession`/`updateSession`/`withLock`):
 *  - служебные метки (`turnId`, `last_error`, маркер resume, гранты прав) пишутся
 *    **без** `touchUpdatedAt`: `updatedAt` сессии не двигается;
 *  - пользовательские правки (`/`-команда, `$`-скилл, эфемерная команда) —
 *    **с** бампом `updatedAt` (как `updateSession`);
 *  - пишется ровно одно сообщение по `id`: остальная история («свидетель») цела.
 *
 * Все проверки — на реальных `SessionManager` + `FileStore` (как
 * `task-resume.test.ts`/`manager-mutations.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from '../storage/file-store.js';
import { EventBus } from '../events/bus.js';
import { DebugCollector } from '../debug.js';
import { PermissionEvaluator } from './permission/evaluator.js';
import { handleLlmFailure } from './orchestrator/errors.js';
import { finishLocalCommand, publishLocalCompletion } from './orchestrator/commands.js';
import { BaseProvider, ProviderFactory } from '../providers/base.js';
import { createToolRegistry } from './tools/index.js';
import { toSkillSummary } from './skills/catalog.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ContextBuilder } from './context/builder.js';
import type { CancellationToken } from '../providers/base.js';
import type { DiscoveredSkill, LoadedSkill, SkillRuntime } from './skills/types.js';
import type { BusEvent, Session, SessionMeta, SessionSettings } from '@itphx/synth-shared';
import {
  MessageRole,
  generateId,
  makeTextPart,
  nowISO,
} from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { stubContextFiles } from '../test-helpers/storage-stubs.js';

/** Время сессии «до» правки: любая запись с бампом его сдвинет. */
const OLD_STAMP = '2024-01-01T00:00:00.000Z';

const proto = ChatOrchestrator.prototype as unknown as {
  _markTurnUserMessage: (sessionId: string, message: Message, turnId: string) => Promise<void>;
  _handleCommand: (args: Record<string, unknown>) => Promise<unknown>;
  _handleDollarSkills: (args: Record<string, unknown>) => Promise<unknown>;
  _grantSessionToolAllow: (
    session: Session,
    toolName: string,
    toolArgs: Record<string, unknown>,
    workingDir: string,
  ) => Promise<{ rules: Record<string, unknown> }>;
};

function makeCtxBuilder(): ContextBuilder {
  return {
    buildSystemPrompt: async () => 'system prompt',
    buildBaseBlocks: async () => [],
  } as unknown as ContextBuilder;
}

function makeMockAgentRegistry(): AgentRegistry {
  return {
    get: (id: string) =>
      id === 'explore' ? { id, agentMode: ['subagent'], maxSteps: 2 } : undefined,
    getSubagents: () => [{ id: 'explore' }],
    getToolsForAgent: () => [],
  } as unknown as AgentRegistry;
}

function makeUserMessage(content: string, metadata: Record<string, unknown> = {}): Message {
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
    metadata: { stream_id: generateId(), ...metadata },
  };
}

/** Провайдер, висящий в стриме до явной отмены (маркер resume не снимается сам). */
class MockResumeSlowProvider extends BaseProvider {
  constructor() {
    super({ url: '', apiKey: '', model: 'm', name: 'mockslowmut', type: 'mockslowmut' });
  }

  async chat(): Promise<never> {
    throw new Error('not used');
  }

  async *chatAsync(
    _m?: unknown,
    _s?: unknown,
    _t?: unknown,
    _d?: unknown,
    ct?: CancellationToken,
  ): AsyncGenerator<import('@itphx/synth-shared').LLMChunk> {
    yield { isFinal: false, content: 'работаю... ' } as import('@itphx/synth-shared').LLMChunk;
    for (let i = 0; i < 500; i++) {
      if (ct?.cancelled) return;
      yield { isFinal: false, content: `шаг-${i} ` } as import('@itphx/synth-shared').LLMChunk;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  getProviderName(): string {
    return 'mockslowmut';
  }
}

function discovered(name: string): DiscoveredSkill {
  return {
    name,
    meta: {
      name,
      description: `${name} desc`,
      userInvocable: true,
      disableModelInvocation: false,
      invocation: 'both',
    },
    body: `Body of ${name}`,
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    source: { scope: 'instance', level: 'system', origin: 'instance', dir: '/skills', trusted: true },
    trusted: true,
    mtimeMs: 0,
  };
}

function makeSkillRuntime(skills: DiscoveredSkill[]): SkillRuntime {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const load = (skill: DiscoveredSkill): LoadedSkill => ({
    summary: toSkillSummary(skill),
    meta: skill.meta,
    body: skill.body,
    dir: skill.dir,
    files: [],
  });
  return {
    buildCatalog: async () => ({ stable: [], session: [] }),
    get: async (name) => byName.get(name),
    load: async (name) => {
      const skill = byName.get(name);
      return skill ? load(skill) : undefined;
    },
    readSupportingFile: async () => undefined,
  };
}

describe('точечные мутации сообщений оркестратора (этап 2b-2b-1)', () => {
  let tmpDir: string;
  let store: FileStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let events: BusEvent[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-orch-msg-mut-'));
    store = new FileStore({ dataDir: tmpDir });
    sessionManager = new SessionManager(store);
    eventBus = new EventBus();
    events = [];
    eventBus.subscribeAll((e) => events.push(e));
    ProviderFactory.register('mockslowmut', MockResumeSlowProvider);
  });

  afterEach(async () => {
    ProviderFactory['_providers'].delete('mockslowmut');
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сделать сессию «старой» (и, при необходимости, поправить метаданные). */
  async function ageSession(
    sessionId: string,
    mutate?: (meta: SessionMeta) => void,
  ): Promise<void> {
    await sessionManager.mutateMeta(sessionId, (meta) => {
      meta.updatedAt = OLD_STAMP;
      mutate?.(meta);
    }, { touchUpdatedAt: false });
  }

  /** Наблюдатель записи в хранилище (проверка «строка не пишется»). */
  function writeSpy() {
    return vi.spyOn(
      store as unknown as { _writeSession: (s: Session) => Promise<void> },
      '_writeSession',
    );
  }

  function orchestrator(overrides: Record<string, unknown> = {}): ChatOrchestrator {
    return new ChatOrchestrator({
      sessionManager,
      eventBus,
      contextBuilder: makeCtxBuilder(),
      contextConfig: stubContextFiles(),
      providerLoader: () => null,
      defaultWorkingDir: tmpDir,
      permissionConfig: { rules: {}, askTimeoutMs: 30_000 },
      ...overrides,
    });
  }

  describe('_markTurnUserMessage (метка хода)', () => {
    it('пишет currentStream.turnId и messages[].turnId без бампа updatedAt; свидетель цел', async () => {
      const session = await sessionManager.createSession({ title: 'Turn' });
      const witness = makeUserMessage('свидетель');
      const reply = makeUserMessage('реплика', { stream_id: 'st-1' });
      await sessionManager.addMessage(session.id, witness);
      await sessionManager.addMessage(session.id, reply);
      await ageSession(session.id, (meta) => {
        meta.currentStream = {
          streamId: 'st-1',
          message: 'x',
          startedAt: OLD_STAMP,
          cancelled: false,
          owner: 'proc-1',
        };
      });

      const ctx = { _sessionManager: sessionManager };
      await proto._markTurnUserMessage.call(ctx, session.id, reply, 'turn_1');

      let loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.currentStream?.turnId).toBe('turn_1');
      expect(loaded.messages[1]!.turnId).toBe('turn_1');
      // Паритет `saveSession`: метка хода не двигает время сессии.
      expect(loaded.updatedAt).toBe(OLD_STAMP);
      // Свидетель не тронут.
      expect(loaded.messages[0]!.content).toBe('свидетель');
      expect(loaded.messages[0]!.turnId).toBeUndefined();
      // Объект вызывающего размечен (как раньше).
      expect(reply.turnId).toBe('turn_1');

      // Повторный вход в тот же ход: ни метка `currentStream`, ни реплика не
      // меняются — строка сессии не пишется.
      const sameSpy = writeSpy();
      await proto._markTurnUserMessage.call(ctx, session.id, reply, 'turn_1');
      expect(sameSpy.mock.calls).toHaveLength(0);
      sameSpy.mockRestore();

      // Другой ход: `currentStream` обновляется (служебная запись без бампа),
      // а уже проставленный `turnId` реплики не перезаписывается.
      await proto._markTurnUserMessage.call(ctx, session.id, reply, 'turn_2');
      loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.currentStream?.turnId).toBe('turn_2');
      expect(loaded.messages[1]!.turnId).toBe('turn_1');
      // Паритет `saveSession`: время сессии так и не сдвинулось.
      expect(loaded.updatedAt).toBe(OLD_STAMP);
    });
  });

  describe('last_error (сбой LLM)', () => {
    it('точечно по stream_id, без бампа updatedAt; свидетель цел', async () => {
      const session = await sessionManager.createSession({ title: 'Error' });
      const witness = makeUserMessage('свидетель', { stream_id: 'other' });
      const reply = makeUserMessage('вопрос', { stream_id: 'stream1' });
      await sessionManager.addMessage(session.id, witness);
      await sessionManager.addMessage(session.id, reply);
      await ageSession(session.id);

      await handleLlmFailure(
        session.id,
        'stream1',
        new Error('fetch failed'),
        1,
        { durationMs: 5 },
        { sessionManager },
      );

      const loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[1]!.metadata?.last_error).toBeTruthy();
      expect(loaded.messages[1]!.content).toBe('вопрос');
      // Свидетель: ни `last_error`, ни содержимого не тронули.
      expect(loaded.messages[0]!.metadata?.last_error).toBeUndefined();
      expect(loaded.messages[0]!.content).toBe('свидетель');
      // Паритет `saveSession`: сбой не переписывает и не двигает сессию.
      expect(loaded.updatedAt).toBe(OLD_STAMP);
    });
  });

  describe('пользовательские правки реплики (/ и $) — с бампом updatedAt', () => {
    it('/-команда template: content/parts/metadata точечно, updatedAt сдвинут, свидетель цел', async () => {
      const orch = orchestrator({
        commandRuntime: {
          list: async () => ({ commands: [], diagnostics: [] }),
          resolve: async (input: string) =>
            input.startsWith('/plan')
              ? { status: 'template', name: 'plan', args: 'x', kind: 'template', prompt: 'RENDERED' }
              : undefined,
        },
      });
      const session = await sessionManager.createSession({
        title: 'Command',
        settings: { provider: 'mock', model: 'm' } as unknown as Partial<SessionSettings>,
      });
      const witness = makeUserMessage('свидетель');
      const commandMessage = makeUserMessage('/plan x', { stream_id: 'st-cmd' });
      await sessionManager.addMessage(session.id, witness);
      await sessionManager.addMessage(session.id, commandMessage);
      await ageSession(session.id);

      const fresh = (await sessionManager.getSession(session.id))!;
      const result = await proto._handleCommand.call(orch, {
        session: fresh,
        message: fresh.messages[1]!,
        signal: new AbortController().signal,
        publishChunk: () => {},
        debugCollector: new DebugCollector(false),
        streamId: 'st-cmd',
        effectiveAgentRole: 'fixer',
        workingDir: tmpDir,
        permissionEvaluator: new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 }),
        sessionMode: 'act',
        planMode: 'auto',
        planApproved: false,
      });
      // template-команда — не локальный ответ: управление уходит обычному пути.
      expect(result).toBeNull();

      const loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.messages).toHaveLength(2);
      const stored = loaded.messages[1]!;
      expect(stored.content).toBe('RENDERED');
      expect(stored.parts).toHaveLength(1);
      expect(stored.parts[0]!.data).toBe('RENDERED');
      expect(stored.metadata?.command).toEqual({ name: 'plan', kind: 'template', args: 'x' });
      // `updatedAt` сдвинут — паритет `updateSession`.
      expect(loaded.updatedAt).not.toBe(OLD_STAMP);
      // Свидетель цел: ровно одно сообщение изменено.
      expect(loaded.messages[0]!.content).toBe('свидетель');
      expect(loaded.messages[0]!.metadata?.command).toBeUndefined();
    });

    it('$‑скилл: content/parts/metadata точечно, updatedAt сдвинут, свидетель цел', async () => {
      const orch = orchestrator({ skillRuntime: makeSkillRuntime([discovered('api-review')]) });
      const session = await sessionManager.createSession({
        title: 'Dollar',
        settings: { provider: 'mock', model: 'm' } as unknown as Partial<SessionSettings>,
      });
      const witness = makeUserMessage('свидетель');
      const skillMessage = makeUserMessage('сделай ревью $api-review', { stream_id: 'st-skill' });
      await sessionManager.addMessage(session.id, witness);
      await sessionManager.addMessage(session.id, skillMessage);
      await ageSession(session.id);

      const fresh = (await sessionManager.getSession(session.id))!;
      const result = await proto._handleDollarSkills.call(orch, {
        session: fresh,
        message: fresh.messages[1]!,
        signal: new AbortController().signal,
        publishChunk: () => {},
        debugCollector: new DebugCollector(false),
        streamId: 'st-skill',
        effectiveAgentRole: 'fixer',
        workingDir: tmpDir,
        permissionEvaluator: new PermissionEvaluator({ rules: {}, askTimeoutMs: 30_000 }),
        sessionMode: 'act',
        planMode: 'auto',
        planApproved: false,
      });
      expect(result).toBeNull();

      const loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.messages).toHaveLength(2);
      const stored = loaded.messages[1]!;
      expect(stored.content).toContain('<skill_content name="api-review">');
      expect(stored.content).toContain('сделай ревью $api-review');
      expect(stored.parts[0]!.data).toBe(stored.content);
      expect(stored.metadata?.dollarSkills).toEqual({ names: ['api-review'] });
      expect(loaded.updatedAt).not.toBe(OLD_STAMP);
      expect(loaded.messages[0]!.content).toBe('свидетель');
    });
  });

  describe('эфемерная команда (commands.ts)', () => {
    it('user помечен ephemeral/commandPrompt, assistant добавлен ровно один раз, updatedAt сдвинут', async () => {
      const session = await sessionManager.createSession({ title: 'Ephemeral' });
      const witness = makeUserMessage('свидетель');
      const userMessage = makeUserMessage('/help', { stream_id: 'stream1' });
      await sessionManager.addMessage(session.id, witness);
      await sessionManager.addMessage(session.id, userMessage);
      await ageSession(session.id);

      const fresh = (await sessionManager.getSession(session.id))!;
      const result = await finishLocalCommand(
        fresh,
        fresh.messages[1]!,
        () => {},
        'вывод /help',
        'stream1',
        { name: 'help' },
        { sessionManager, eventBus, publishLocalCompletion },
      );
      expect(result).toEqual({});

      const loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.messages).toHaveLength(3);
      const storedUser = loaded.messages[1]!;
      expect(storedUser.ephemeral).toBe(true);
      expect(storedUser.metadata?.commandPrompt).toBe(true);
      expect(storedUser.content).toBe('/help');
      // Ответ добавлен ровно один раз.
      expect(loaded.messages.filter((m) => m.role === MessageRole.ASSISTANT)).toHaveLength(1);
      expect(loaded.messages.at(-1)!.content).toBe('вывод /help');
      // Свидетель цел, `updatedAt` сдвинут (паритет `updateSession`).
      expect(loaded.messages[0]!.content).toBe('свидетель');
      expect(loaded.updatedAt).not.toBe(OLD_STAMP);
    });
  });

  describe('грант прав сессии (_grantSessionToolAllow)', () => {
    it('второй грант не затирает первый (правило из свежего settings.permission), updatedAt не двигается', async () => {
      const orch = orchestrator();
      const session = await sessionManager.createSession({ title: 'Grant' });
      await ageSession(session.id);
      // Снимок вызывающего — **до** первого гранта (как у живого хода).
      const staleSnapshot = (await sessionManager.getSession(session.id))!;

      const first = await proto._grantSessionToolAllow.call(
        orch, staleSnapshot, 'read_file', { file_path: 'a.txt' }, tmpDir,
      );
      const second = await proto._grantSessionToolAllow.call(
        orch, staleSnapshot, 'read_file', { file_path: 'b.txt' }, tmpDir,
      );

      const expected = {
        [join(tmpDir, 'a.txt')]: 'allow',
        [join(tmpDir, 'b.txt')]: 'allow',
      };
      expect(first.rules.read_file).toEqual({ [join(tmpDir, 'a.txt')]: 'allow' });
      // Второй грант считается от свежего документа — первый путь сохранён.
      expect(second.rules.read_file).toEqual(expected);

      const loaded = (await sessionManager.getSession(session.id))!;
      expect(loaded.settings.permission?.rules.read_file).toEqual(expected);
      // Грант — служебная правка прав: время сессии не двигается.
      expect(loaded.updatedAt).toBe(OLD_STAMP);
      // Событие несёт настройки (последний грант — оба пути).
      const updated = events.filter((e) => e.type === 'session.updated');
      expect(updated).toHaveLength(2);
      expect(
        (updated.at(-1)!.data as { settings: { permission: { rules: Record<string, unknown> } } })
          .settings.permission.rules.read_file,
      ).toEqual(expected);
    });

    it('грант дочерней сессии распространяется на родителя: правило из свежего документа, updatedAt не двигается', async () => {
      const orch = orchestrator();
      const parent = await sessionManager.createSession({ title: 'Parent' });
      const child = await sessionManager.createSession({ title: 'Child', parentId: parent.id });
      await ageSession(parent.id);
      await ageSession(child.id);

      const childSnapshot = (await sessionManager.getSession(child.id))!;
      await proto._grantSessionToolAllow.call(
        orch, childSnapshot, 'read_file', { file_path: 'a.txt' }, tmpDir,
      );
      // Второй грант (уже от устаревшего снимка ребёнка) — правило родителя тоже
      // накапливается, а не заменяется.
      await proto._grantSessionToolAllow.call(
        orch, childSnapshot, 'read_file', { file_path: 'b.txt' }, tmpDir,
      );

      const expected = {
        [join(tmpDir, 'a.txt')]: 'allow',
        [join(tmpDir, 'b.txt')]: 'allow',
      };
      const parentLoaded = (await sessionManager.getSession(parent.id))!;
      expect(parentLoaded.settings.permission?.rules.read_file).toEqual(expected);
      expect(parentLoaded.updatedAt).toBe(OLD_STAMP);
      const childLoaded = (await sessionManager.getSession(child.id))!;
      expect(childLoaded.settings.permission?.rules.read_file).toEqual(expected);
      expect(childLoaded.updatedAt).toBe(OLD_STAMP);
      // Событие — и по родителю (UI обновляет панель одобрений).
      expect(
        events.some((e) => e.type === 'session.updated' && (e as { sessionId?: string }).sessionId === parent.id),
      ).toBe(true);
    });
  });

  describe('resumeSubagent (маркер currentStream)', () => {
    /** Родитель + дочерняя сессия саб-агента с оборванной историей. */
    async function createInterruptedChild(): Promise<{ parent: string; child: string }> {
      const parent = await sessionManager.createSession({
        title: 'Parent',
        settings: { provider: 'mockslowmut', model: 'm' },
      });
      const child = await sessionManager.createSession({
        title: 'Subtask: analyse',
        parentId: parent.id,
        sessionOrigin: 'subagent',
        settings: { provider: 'mockslowmut', model: 'm', agentRole: 'explore' },
      });
      await sessionManager.addMessage(child.id, makeUserMessage('проанализируй код'));
      await sessionManager.addMessage(child.id, {
        ...makeUserMessage('начал анализ...'),
        role: MessageRole.ASSISTANT,
        metadata: { partial: true, interrupted: true },
      });
      return { parent: parent.id, child: child.id };
    }

    function resumeOrchestrator(): ChatOrchestrator {
      return orchestrator({
        providerLoader: (name: string) =>
          ({ name, type: name, baseUrl: '', apiKey: '', defaultModel: 'm' }) as never,
        agentRegistry: makeMockAgentRegistry(),
        toolRegistry: createToolRegistry(),
      });
    }

    /** Записи мутаций метаданных (проверка паритета `touchUpdatedAt`). */
    function trackMeta(sess: SessionManager): Array<{ sessionId: string; touchUpdatedAt?: boolean }> {
      const calls: Array<{ sessionId: string; touchUpdatedAt?: boolean }> = [];
      const original = sess.mutateMeta.bind(sess);
      vi.spyOn(sess, 'mutateMeta').mockImplementation((async (
        sessionId: string,
        mutator: (meta: never) => unknown,
        opts?: { touchUpdatedAt?: boolean; shouldWrite?: (value: unknown) => boolean },
      ) => {
        calls.push({ sessionId, ...(opts?.touchUpdatedAt !== undefined ? { touchUpdatedAt: opts.touchUpdatedAt } : {}) });
        return original(sessionId, mutator as never, opts as never);
      }) as never);
      return calls;
    }

    it('свой streamId ставится и снимается; метки — без бампа updatedAt', async () => {
      const { parent, child } = await createInterruptedChild();
      const orch = resumeOrchestrator();
      const metaCalls = trackMeta(sessionManager);

      const started = await orch.startSubagentResume(child);
      // Свой маркер выставлен (мутация awaited до старта фонового прогона).
      const afterStart = (await sessionManager.getSession(child))!;
      expect(afterStart.currentStream?.streamId).toBe(started.stream_id);
      // Маркер выставлен служебной мутацией без бампа `updatedAt`.
      const callsAtStart = metaCalls.filter(
        (c) => c.sessionId === child && c.touchUpdatedAt === false,
      );
      expect(callsAtStart.length).toBeGreaterThan(0);

      orch.cancel(started.stream_id);      await vi.waitFor(async () => {
        const s = await sessionManager.getSession(child);
        expect(s!.currentStream).toBeUndefined();
        expect(s!.status.blocked).toBeFalsy();
      }, { timeout: 5000 });

      // Снятие маркера — тоже служебная мутация без бампа.
      const cleanupCalls = metaCalls.filter(
        (c) => c.sessionId === child && c.touchUpdatedAt === false,
      );
      expect(cleanupCalls.length).toBeGreaterThanOrEqual(2);
      // Родитель маркером не трогался.
      expect(metaCalls.some((c) => c.sessionId === parent && c.touchUpdatedAt === false)).toBe(false);
    });

    it('чужой streamId не перетирается снятием маркера', async () => {
      const { child } = await createInterruptedChild();
      const orch = resumeOrchestrator();

      const started = await orch.startSubagentResume(child);
      // Пока прогон идёт, в сессии уже начался другой ход (другой streamId).
      await sessionManager.mutateMeta(child, (meta) => {
        meta.currentStream = {
          streamId: 'st_foreign',
          message: 'другой ход',
          startedAt: nowISO(),
          cancelled: false,
          owner: 'proc-1',
        };
      }, { touchUpdatedAt: false });

      orch.cancel(started.stream_id);
      await vi.waitFor(async () => {
        const s = await sessionManager.getSession(child);
        expect(s!.status.blocked).toBeFalsy();
      }, { timeout: 5000 });

      // .finally() снял только свой маркер: чужой остался на месте.
      const loaded = (await sessionManager.getSession(child))!;
      expect(loaded.currentStream?.streamId).toBe('st_foreign');
    });
  });
});
