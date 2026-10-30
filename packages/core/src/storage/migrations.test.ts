import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, type Message } from '@itphx/synth-shared';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from './file-store.js';
import { ProjectStore } from './project-store.js';
import { RuntimeSettingsStore } from './runtime-settings.js';
import {
  MESSAGE_STREAM_V2_MIGRATION,
  migrateMessageStreamV2,
  migrateSessionScopeSnapshots,
  planMessageStreamMigration,
  SESSION_SCOPE_SNAPSHOT_MIGRATION,
} from './migrations.js';

describe('migrateSessionScopeSnapshots (ADR-071 §2.4 / ADR-046 §4.5)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let settingsStore: RuntimeSettingsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-migrate-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeProject(): Promise<string> {
    const project = projectStore.create('P', 'local');
    project.skills = { enabled: ['a'], defaultOn: ['a'] };
    project.mcp = { enabled: ['s'], defaultOn: ['s'] };
    await projectStore.save(project);
    return project.id;
  }

  it('материализует снапшоты у существующих сессий и идемпотентна', async () => {
    const projectId = await makeProject();
    const withProject = await sessionManager.createSession({ projectId });
    const noProject = await sessionManager.createSession({});
    expect(withProject.settings.skillsDefaultOn).toBeUndefined();

    const resolveSystemDefaults = async () => ({ mcpDefaultOn: ['sys'], skillsDefaultOn: ['x'] });
    const first = await migrateSessionScopeSnapshots({ sessionManager, projectStore, settingsStore, resolveSystemDefaults });
    expect(first).toBe(2);

    const loadedWithProject = await sessionManager.getSession(withProject.id);
    expect(loadedWithProject!.settings.skillsDefaultOn).toEqual(['a']);
    expect(loadedWithProject!.settings.mcpDefaultOn).toEqual(['s']);

    const loadedNoProject = await sessionManager.getSession(noProject.id);
    expect(loadedNoProject!.settings.skillsDefaultOn).toEqual(['x']);
    expect(loadedNoProject!.settings.mcpDefaultOn).toEqual(['sys']);

    // Маркер выставлен; повторный вызов — no-op.
    expect(await settingsStore.getMigrationMarker(SESSION_SCOPE_SNAPSHOT_MIGRATION)).toBe(true);
    const second = await migrateSessionScopeSnapshots({ sessionManager, projectStore, settingsStore, resolveSystemDefaults });
    expect(second).toBe(0);

    const afterSecond = await sessionManager.getSession(withProject.id);
    expect(afterSecond!.settings.skillsDefaultOn).toEqual(['a']);
  });

  it('не перетирает уже существующие снапшоты', async () => {
    const projectId = await makeProject();
    const session = await sessionManager.createSession({
      projectId,
      settings: { skillsDefaultOn: ['custom'], mcpDefaultOn: ['custom'] },
    });
    await migrateSessionScopeSnapshots({
      sessionManager,
      projectStore,
      settingsStore,
      resolveSystemDefaults: async () => ({ mcpDefaultOn: ['sys'], skillsDefaultOn: ['x'] }),
    });
    const loaded = await sessionManager.getSession(session.id);
    expect(loaded!.settings.skillsDefaultOn).toEqual(['custom']);
    expect(loaded!.settings.mcpDefaultOn).toEqual(['custom']);
  });
});

describe('migrateMessageStreamV2 (ADR-118 §9: ord/turn_id/step_index)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let settingsStore: RuntimeSettingsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-migrate-stream-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Сообщение в состоянии «до ADR-118»: без `ord`/`turn_id`/`step_index`. */
  function legacyMessage(role: MessageRole, seq: number, overrides: Partial<Message> = {}): Message {
    return {
      id: `msg-${seq}`,
      role,
      seq,
      origin: 'local',
      parts: [{ id: `part-${seq}`, type: 'text', data: `текст ${seq}` }],
      content: `текст ${seq}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    } as Message;
  }

  /** Сессия с готовой legacy-историей (запись через порт, без `saveSession`). */
  async function seedSession(messages: Message[]): Promise<string> {
    const session = await sessionManager.createSession({});
    await sessionManager.saveSession({ ...session, messages });
    return session.id;
  }

  it('проставляет ord/turn_id/step_index и идемпотентна', async () => {
    const sessionId = await seedSession([
      legacyMessage(MessageRole.USER, 1),
      legacyMessage(MessageRole.ASSISTANT, 2),
    ]);

    const updated = await migrateMessageStreamV2({ sessionManager, settingsStore });
    expect(updated).toBe(2);

    const loaded = await sessionManager.getSession(sessionId);
    const messages = loaded!.messages;
    expect(messages.map((m) => m.ord)).toEqual([1, 2]);
    // Ход: user-реплика и следующий assistant — один ход.
    expect(messages[0]!.turnId).toBe(`turn_${sessionId}_1`);
    expect(messages[1]!.turnId).toBe(`turn_${sessionId}_1`);
    // Assistant — шаг 0 хода; у user-сообщения шага нет.
    expect(messages[1]!.stepIndex).toBe(0);
    expect(messages[0]!.stepIndex).toBeUndefined();

    // Маркер выставлен; повторный прогон — no-op.
    expect(await settingsStore.getMigrationMarker(MESSAGE_STREAM_V2_MIGRATION)).toBe(true);
    const second = await migrateMessageStreamV2({ sessionManager, settingsStore });
    expect(second).toBe(0);

    const afterSecond = await sessionManager.getSession(sessionId);
    expect(afterSecond!.messages.map((m) => m.ord)).toEqual([1, 2]);
  });

  it('группирует сообщения по ходам и нумерует шаги внутри хода', async () => {
    const sessionId = await seedSession([
      legacyMessage(MessageRole.USER, 1),
      legacyMessage(MessageRole.ASSISTANT, 2),
      legacyMessage(MessageRole.TOOL, 3),
      legacyMessage(MessageRole.ASSISTANT, 4),
      legacyMessage(MessageRole.USER, 5),
      legacyMessage(MessageRole.ASSISTANT, 6),
    ]);

    await migrateMessageStreamV2({ sessionManager, settingsStore });
    const messages = (await sessionManager.getSession(sessionId))!.messages;

    const turn1 = `turn_${sessionId}_1`;
    const turn2 = `turn_${sessionId}_2`;
    expect(messages.map((m) => m.turnId)).toEqual([turn1, turn1, turn1, turn1, turn2, turn2]);
    // Шаги: assistant-сообщения хода нумеруются подряд; у tool/user шага нет.
    expect(messages.map((m) => m.stepIndex)).toEqual([undefined, 0, undefined, 1, undefined, 0]);
  });

  it('не перенумеровывает уже выданный ord', async () => {
    const sessionId = await seedSession([
      legacyMessage(MessageRole.USER, 1, { ord: 5 }),
      legacyMessage(MessageRole.ASSISTANT, 2),
    ]);

    await migrateMessageStreamV2({ sessionManager, settingsStore });
    const messages = (await sessionManager.getSession(sessionId))!.messages;
    expect(messages.map((m) => m.ord)).toEqual([5, 6]);
  });

  it('выводит шаг из персистящихся признаков итерации', async () => {
    const sessionId = await seedSession([
      legacyMessage(MessageRole.USER, 1),
      legacyMessage(MessageRole.ASSISTANT, 2, {
        metadata: {
          intermediate_text_blocks: [
            { text: 'первый вызов', iteration: 0 },
            { text: 'второй вызов', iteration: 1 },
          ],
        },
      }),
    ]);

    await migrateMessageStreamV2({ sessionManager, settingsStore });
    const messages = (await sessionManager.getSession(sessionId))!.messages;
    // Сообщение свёрнуто из двух вызовов LLM — шаг последнего из них.
    expect(messages[1]!.stepIndex).toBe(1);
  });

  it('не трогает сообщения, уже размеченные движком (ADR-118)', async () => {
    // Сообщение, созданное уже по новой модели: `ord`/`turnId`/`stepIndex`
    // проставлены движком — миграция их не переписывает.
    const sessionId = await seedSession([
      legacyMessage(MessageRole.USER, 1, { ord: 3, turnId: 'turn-runtime' }),
    ]);

    const updated = await migrateMessageStreamV2({ sessionManager, settingsStore });
    expect(updated).toBe(0);

    const messages = (await sessionManager.getSession(sessionId))!.messages;
    expect(messages[0]!.ord).toBe(3);
    expect(messages[0]!.turnId).toBe('turn-runtime');
  });

  it('не трогает уже мигрированные сообщения (повторный прогон — no-op)', async () => {
    const sessionId = await seedSession([
      legacyMessage(MessageRole.USER, 1),
      legacyMessage(MessageRole.ASSISTANT, 2),
    ]);

    await migrateMessageStreamV2({ sessionManager, settingsStore });
    const before = (await sessionManager.getSession(sessionId))!.messages;

    // Маркер снят вручную (как будто миграция не отметилась) — данные уже
    // проставлены, поэтому повторный прогон ничего не меняет.
    await rm(join(tmpDir, 'settings.json'), { force: true });
    const second = await migrateMessageStreamV2({ sessionManager, settingsStore });
    const after = (await sessionManager.getSession(sessionId))!.messages;

    expect(after.map((m) => [m.ord, m.turnId, m.stepIndex])).toEqual(
      before.map((m) => [m.ord, m.turnId, m.stepIndex]),
    );
    expect(second).toBe(0);
  });
});

describe('planMessageStreamMigration (ADR-118 §9: план по истории)', () => {
  const message = (role: MessageRole, seq: number, overrides: Partial<Message> = {}): Message => ({
    id: `msg-${seq}`,
    role,
    seq,
    origin: 'local',
    parts: [],
    content: `текст ${seq}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
    ...overrides,
  } as Message);

  it('ord идёт по порядку истории с единицы', () => {
    const plan = planMessageStreamMigration('sess-1', [
      message(MessageRole.USER, 1),
      message(MessageRole.ASSISTANT, 2),
      message(MessageRole.USER, 3),
    ]);
    expect(plan.map((p) => p.ord)).toEqual([1, 2, 3]);
  });

  it('сообщения до первой user-реплики — предходовая группа (ход 0)', () => {
    const plan = planMessageStreamMigration('sess-1', [
      message(MessageRole.SYSTEM, 1),
      message(MessageRole.USER, 2),
    ]);
    expect(plan.map((p) => p.turnId)).toEqual(['turn_sess-1_0', 'turn_sess-1_1']);
  });

  it('шаг assistant-сообщения без признаков итерации — один сегмент', () => {
    const plan = planMessageStreamMigration('sess-1', [
      message(MessageRole.USER, 1),
      message(MessageRole.ASSISTANT, 2),
    ]);
    expect(plan[1]!.stepIndex).toBe(0);
  });

  it('признаки итерации в tool_calls учитываются', () => {
    const plan = planMessageStreamMigration('sess-1', [
      message(MessageRole.USER, 1),
      message(MessageRole.ASSISTANT, 2, {
        toolCalls: [{ id: 'call-1', iteration: 3 }],
      }),
    ]);
    expect(plan[1]!.stepIndex).toBe(3);
  });
});
