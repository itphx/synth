import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageRole, type Message, type Session } from '@itphx/synth-shared';
import { SessionManager } from '../sessions/manager.js';
import { FileStore } from './file-store.js';
import { ProjectStore } from './project-store.js';
import { RuntimeSettingsStore } from './runtime-settings.js';
import {
  MESSAGE_STREAM_V2_MIGRATION,
  MESSAGE_STREAM_V2_STEP_PARTS_MIGRATION,
  migrateMessageStreamV2,
  migrateMessageStreamV2StepParts,
  migrateSessionScopeSnapshots,
  planMessageStepPartsCleanup,
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

describe('migrateMessageStreamV2StepParts (ADR-118 §1: содержимое старых ходов)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let settingsStore: RuntimeSettingsStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-migrate-step-parts-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    settingsStore = new RuntimeSettingsStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const REASONING_SEPARATOR = '\n\n---\n\n';

  function reasoningPart(id: string, text: string): { id: string; type: 'reasoning'; data: string } {
    return { id, type: 'reasoning', data: text };
  }

  function msg(role: MessageRole, seq: number, overrides: Partial<Message> = {}): Message {
    return {
      id: `msg-${seq}`,
      role,
      seq,
      origin: 'local',
      parts: [{ id: `part-${seq}`, type: 'text', data: '' }],
      content: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    } as Message;
  }

  /**
   * Старый ход из 3 шагов в форме «до исправления»: финал несёт reasoning всех
   * шагов и `tool_results` всех вызовов, шаги с одним reasoning скрыты
   * `tool_chain`; у финала — `intermediate_text_blocks`.
   */
  function oldTurnMessages(turnId: string): Message[] {
    return [
      msg(MessageRole.USER, 1, { turnId }),
      msg(MessageRole.ASSISTANT, 2, {
        turnId,
        stepIndex: 0,
        parts: [reasoningPart('r-0', 'размышление 0')],
        reasoning: 'размышление 0',
        toolCalls: [{ id: 'call-1', iteration: 0 }],
        metadata: { tool_chain: true, stream_id: 'st' },
      }),
      msg(MessageRole.TOOL, 3, { turnId, toolCallId: 'call-1', metadata: { tool_chain: true } }),
      msg(MessageRole.ASSISTANT, 4, {
        turnId,
        stepIndex: 1,
        parts: [reasoningPart('r-1', 'размышление 1')],
        reasoning: 'размышление 1',
        toolCalls: [{ id: 'call-2', iteration: 1 }],
        metadata: { tool_chain: true },
      }),
      msg(MessageRole.ASSISTANT, 5, {
        turnId,
        stepIndex: 2,
        parts: [
          reasoningPart('f-0', 'размышление 0'),
          reasoningPart('f-1', 'размышление 1'),
          reasoningPart('f-2', 'размышление 2'),
          { id: 'f-text', type: 'text', data: 'ответ' },
        ],
        reasoning: ['размышление 0', 'размышление 1', 'размышление 2'].join(REASONING_SEPARATOR),
        content: 'ответ',
        metadata: {
          stream_id: 'st',
          intermediate_text_blocks: [{ text: 'промежуточный', iteration: 0 }],
          tool_results: [
            { id: 'call-1', name: 'read_file', result: 'r1', iteration: 0 },
            { id: 'call-2', name: 'read_file', result: 'r2', iteration: 1 },
            { id: 'call-3', name: 'read_file', result: 'r3', iteration: 2 },
          ],
        },
      }),
    ];
  }

  async function seedSession(messages: Message[], opts: { parentId?: string } = {}): Promise<string> {
    const session = await sessionManager.createSession(opts.parentId ? { parentId: opts.parentId } : {});
    await sessionManager.saveSession({ ...session, messages });
    return session.id;
  }

  it('переносит tool_results в шаги, чистит reasoning финала и открывает шаги', async () => {
    const sessionId = await seedSession(oldTurnMessages('turn-1'));

    const updated = await migrateMessageStreamV2StepParts({ sessionManager, settingsStore });
    expect(updated).toBe(3); // два шага + финал

    const messages = (await sessionManager.getSession(sessionId))!.messages;
    const step0 = messages[1]!;
    const step1 = messages[3]!;
    const final = messages[4]!;

    // tool_results — у сообщений своих шагов; у финала остаются только свои (шаг 2).
    expect((step0.metadata!.tool_results as Array<{ id: string }>).map((r) => r.id)).toEqual(['call-1']);
    expect((step1.metadata!.tool_results as Array<{ id: string }>).map((r) => r.id)).toEqual(['call-2']);
    expect((final.metadata!.tool_results as Array<{ id: string }>).map((r) => r.id)).toEqual(['call-3']);

    // В финале осталась только reasoning-часть последнего шага; поле пересчитано.
    expect(final.parts.filter((p) => p.type === 'reasoning').map((p) => p.data)).toEqual(['размышление 2']);
    expect(final.reasoning).toBe('размышление 2');

    // intermediate_text_blocks хода удалён.
    expect(final.metadata!.intermediate_text_blocks).toBeUndefined();

    // Шаги с содержимым больше не скрыты tool_chain (иначе размышления пропали бы).
    expect(step0.metadata!.tool_chain).toBeUndefined();
    expect(step1.metadata!.tool_chain).toBeUndefined();
    // Прочие метаданные шага не потеряны.
    expect(step0.metadata!.stream_id).toBe('st');
  });

  it('идемпотентна: повторный прогон — 0 изменений', async () => {
    const sessionId = await seedSession(oldTurnMessages('turn-1'));
    await migrateMessageStreamV2StepParts({ sessionManager, settingsStore });
    const before = (await sessionManager.getSession(sessionId))!.messages;
    expect(await settingsStore.getMigrationMarker(MESSAGE_STREAM_V2_STEP_PARTS_MIGRATION)).toBe(true);

    // Маркер снят вручную — данные уже починены, план пуст.
    await rm(join(tmpDir, 'settings.json'), { force: true });
    const second = await migrateMessageStreamV2StepParts({ sessionManager, settingsStore });
    const after = (await sessionManager.getSession(sessionId))!.messages;

    expect(second).toBe(0);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('legacy-сообщения без turn_id не меняются', async () => {
    const legacy: Message[] = [
      msg(MessageRole.USER, 1),
      msg(MessageRole.ASSISTANT, 2, {
        parts: [reasoningPart('l-0', 'старое размышление')],
        reasoning: 'старое размышление',
        metadata: {
          tool_chain: true,
          intermediate_text_blocks: [{ text: 'блок', iteration: 0 }],
          tool_results: [{ id: 'call-old', result: 'r', iteration: 0 }],
        },
      }),
    ];
    const sessionId = await seedSession(legacy);
    const before = (await sessionManager.getSession(sessionId))!.messages;

    expect(await migrateMessageStreamV2StepParts({ sessionManager, settingsStore })).toBe(0);
    const after = (await sessionManager.getSession(sessionId))!.messages;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after[1]!.metadata!.tool_chain).toBe(true);
    expect(after[1]!.metadata!.tool_results).toEqual([{ id: 'call-old', result: 'r', iteration: 0 }]);
  });

  it('дочерняя сессия (parentId) не меняется — отчёт саб-агента монолитный', async () => {
    const parentId = await seedSession([msg(MessageRole.USER, 1)]);
    const childId = await seedSession(oldTurnMessages('turn-child'), { parentId });
    const before = (await sessionManager.getSession(childId))!.messages;

    expect(await migrateMessageStreamV2StepParts({ sessionManager, settingsStore })).toBe(0);
    const after = (await sessionManager.getSession(childId))!.messages;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // Отчёт ребёнка остаётся монолитным: финал по-прежнему несёт все reasoning.
    expect(after[4]!.metadata!.tool_results).toHaveLength(3);
    expect(after[1]!.metadata!.tool_chain).toBe(true);
  });
});

describe('planMessageStepPartsCleanup (ADR-118 §1: чистая функция плана)', () => {
  const reasoning = (text: string, id: string) => ({ id, type: 'reasoning' as const, data: text });

  function message(role: MessageRole, seq: number, overrides: Partial<Message> = {}): Message {
    return {
      id: `msg-${seq}`,
      role,
      seq,
      origin: 'local',
      parts: [],
      content: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      disabled: false,
      pinned: false,
      hidden: false,
      ...overrides,
    } as Message;
  }

  it('гасит каждое совпадение reasoning не более одного раза', () => {
    const session = {
      id: 'sess-1',
      messages: [
        message(MessageRole.USER, 1, { turnId: 'turn-1' }),
        message(MessageRole.ASSISTANT, 2, {
          turnId: 'turn-1',
          stepIndex: 0,
          parts: [reasoning('А', 'r0')],
          content: 'шаг',
        }),
        message(MessageRole.ASSISTANT, 3, {
          turnId: 'turn-1',
          stepIndex: 1,
          parts: [reasoning('А', 'f0'), reasoning('А', 'f1'), reasoning('С', 'f2')],
          reasoning: ['А', 'А', 'С'].join('\n\n---\n\n'),
        }),
      ],
    } as unknown as Session;

    const plan = planMessageStepPartsCleanup(session);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.index).toBe(2);
    const parts = plan[0]!.patch.parts!;
    expect(parts.map((p) => p.data)).toEqual(['А', 'С']);
    expect(plan[0]!.patch.reasoning).toBe(['А', 'С'].join('\n\n---\n\n'));
  });

  it('финал только из дублей reasoning: части опустошаются, поле сбрасывается', () => {
    const session = {
      id: 'sess-1',
      messages: [
        message(MessageRole.ASSISTANT, 1, { turnId: 'turn-1', stepIndex: 0, parts: [reasoning('А', 'r0')] }),
        message(MessageRole.ASSISTANT, 2, {
          turnId: 'turn-1',
          stepIndex: 1,
          parts: [reasoning('А', 'f0')],
          reasoning: 'А',
        }),
      ],
    } as unknown as Session;

    const plan = planMessageStepPartsCleanup(session);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.patch.parts).toEqual([]);
    expect(plan[0]!.patch.reasoning).toBeUndefined();
  });

  it('не трогает дочернюю сессию и пустую историю', () => {
    const child = {
      id: 'child',
      parentId: 'parent',
      messages: [message(MessageRole.ASSISTANT, 1, { turnId: 't', stepIndex: 0, reasoning: 'x' })],
    } as unknown as Session;
    expect(planMessageStepPartsCleanup(child)).toEqual([]);
    expect(planMessageStepPartsCleanup({ id: 's', messages: [] } as unknown as Session)).toEqual([]);
  });
});
