import { describe, it, expect } from 'vitest';
import type { ProjectPlan, Session, SessionSettings, TodoItem } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import { stubContextFiles } from '../../test-helpers/storage-stubs.js';
import type { ContextFileRepository } from '../../storage/ports/context-file-repository.js';
import {
  syncStateMessages,
  createStateMessage,
  wrapStateContent,
  buildModeChangeContent,
  buildPlanUpdatedContent,
  buildTodosUpdatedContent,
  findLastStateMessage,
  type SyncStateMessagesDeps,
} from './state-messages.js';

interface SessionOverrides {
  mode?: Session['mode'];
  planApproved?: boolean;
  todos?: TodoItem[];
  planMode?: SessionSettings['planMode'];
  messages?: Session['messages'];
  language?: string;
}

/** Минимальная сессия: syncStateMessages читает режим/настройки/todos/messages. */
function makeSession(overrides: SessionOverrides = {}): Session {
  return {
    id: 's1',
    mode: overrides.mode,
    planApproved: overrides.planApproved,
    todos: overrides.todos,
    messages: overrides.messages ?? [],
    settings: {
      language: overrides.language ?? 'ru',
      planMode: overrides.planMode,
    },
  } as unknown as Session;
}

/** Стаб `ContextFileRepository` (реализация — ContextConfig): маркеры вместо prompt-файлов. */
function makeContextConfig(): ContextFileRepository {
  return stubContextFiles({
    getModePrompt: (mode: string) => `[MODE: ${mode.toUpperCase()}]`,
    getPlanModePrompt: (planMode: string, approved: boolean) =>
      `[PLAN MODE: ${planMode.toUpperCase()}${approved ? ' APPROVED' : ''}]`,
  });
}

function makeTodos(): TodoItem[] {
  return [{ id: 't1', content: 'шаг 1', status: 'pending', priority: 'high' }];
}

function makePlan(): ProjectPlan {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    columns: [{ id: 'backlog', name: 'Бэклог', order: 0 }],
    items: [
      {
        id: 'p1',
        title: 'пункт плана',
        columnId: 'backlog',
        priority: 'high',
        order: 0,
        dependsOn: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('state-messages', () => {
  it('createStateMessage: role system, hidden false, metadata {type, state:true}', () => {
    const msg = createStateMessage('mode_change', 'текст режима');

    expect(msg.role).toBe(MessageRole.SYSTEM);
    expect(msg.hidden).toBe(false);
    expect(msg.disabled).toBe(false);
    expect(msg.content).toBe('текст режима');
    expect(msg.metadata).toEqual({ type: 'mode_change', state: true });
  });

  it('wrapStateContent оборачивает контент в <system-state type="…">', () => {
    expect(wrapStateContent('mode_change', 'тело')).toBe(
      '<system-state type="mode_change">\nтело\n</system-state>',
    );
  });

  it('идемпотентность: повторный sync при неизменном состоянии → changed:false, added:[]', () => {
    const session = makeSession({ mode: 'plan', planMode: 'auto' });
    const deps = { contextConfig: makeContextConfig(), language: 'ru' };

    const first = syncStateMessages(session, deps);
    expect(first.changed).toBe(true);
    expect(first.added).toHaveLength(1);
    expect(first.added[0]!.metadata?.type).toBe('mode_change');
    session.messages.push(...first.added);

    const second = syncStateMessages(session, deps);
    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
  });

  it('смена session.mode plan→act добавляет новый mode_change', () => {
    const session = makeSession({ mode: 'plan', planMode: 'auto' });
    const deps = { contextConfig: makeContextConfig(), language: 'ru' };

    session.messages.push(...syncStateMessages(session, deps).added);

    session.mode = 'act';
    const second = syncStateMessages(session, deps);

    expect(second.changed).toBe(true);
    const added = second.added.find((m) => m.metadata?.type === 'mode_change');
    expect(added).toBeDefined();
    expect(added!.content).toContain('[MODE: ACT]');
    expect(added!.content).not.toContain('[MODE: PLAN]');
  });

  it('контент mode_change содержит текст режима (getModePrompt) и план-режим', () => {
    const session = makeSession({ mode: 'plan', planMode: 'strict', planApproved: true });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode).toBeDefined();
    expect(mode!.content).toContain('[MODE: PLAN]');
    expect(mode!.content).toContain('[PLAN MODE: STRICT APPROVED]');
  });

  it('изменение session.todos добавляет todos_updated, пустой список — нет', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });
    const deps = { contextConfig: makeContextConfig(), language: 'ru' };

    // Пустой список → сообщение не добавляется.
    const empty = syncStateMessages(session, deps);
    expect(empty.added.some((m) => m.metadata?.type === 'todos_updated')).toBe(false);
    session.messages.push(...empty.added);

    // Появились todos → добавлено.
    session.todos = makeTodos();
    const withTodos = syncStateMessages(session, deps);
    const first = withTodos.added.find((m) => m.metadata?.type === 'todos_updated');
    expect(first).toBeDefined();
    expect(first!.content).toContain('- [pending] [high] шаг 1');
    session.messages.push(...withTodos.added);

    // Без изменений → не дублируется.
    const same = syncStateMessages(session, deps);
    expect(same.added.some((m) => m.metadata?.type === 'todos_updated')).toBe(false);

    // Изменение → новое сообщение.
    session.todos = [
      { id: 't1', content: 'шаг 1', status: 'completed', priority: 'high' },
      { id: 't2', content: 'шаг 2', status: 'pending', priority: 'low' },
    ];
    const changed = syncStateMessages(session, deps);
    expect(changed.added.some((m) => m.metadata?.type === 'todos_updated')).toBe(true);
  });

  it('plan_updated добавляется при непустом плане, отсутствует при null/пустом', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });
    const deps = { contextConfig: makeContextConfig(), language: 'ru' };

    const noPlan = syncStateMessages(session, { ...deps, plan: null });
    expect(noPlan.added.some((m) => m.metadata?.type === 'plan_updated')).toBe(false);
    session.messages.push(...noPlan.added);

    const emptyPlan: ProjectPlan = { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', columns: [], items: [] };
    const empty = syncStateMessages(session, { ...deps, plan: emptyPlan });
    expect(empty.added.some((m) => m.metadata?.type === 'plan_updated')).toBe(false);

    const withPlan = syncStateMessages(session, { ...deps, plan: makePlan() });
    const added = withPlan.added.find((m) => m.metadata?.type === 'plan_updated');
    expect(added).toBeDefined();
    expect(added!.content).toContain('[APPROVED PLAN]');
    expect(added!.content).toContain('пункт плана');
  });

  it('findLastStateMessage находит последнее сообщение нужного типа и игнорирует не-state', () => {
    const older = createStateMessage('mode_change', 'old');
    const newer = createStateMessage('mode_change', 'new');
    const other = createStateMessage('todos_updated', 'todos');
    const nonState = createStateMessage('mode_change', 'fake');
    nonState.metadata = { type: 'mode_change' }; // без state:true

    const messages = [older, nonState, other, newer];
    expect(findLastStateMessage(messages, 'mode_change')).toBe(newer);
    expect(findLastStateMessage(messages, 'todos_updated')).toBe(other);
    expect(findLastStateMessage(messages, 'plan_updated')).toBeNull();
  });

  it('build* возвращают пустую строку для пустого состояния', () => {
    expect(buildModeChangeContent('act', 'auto', false, 'ru', null)).toBe('');
    expect(buildPlanUpdatedContent(null)).toBe('');
    expect(buildTodosUpdatedContent([])).toBe('');
  });

  it('mode_change с unavailableTools: имена, причины и подсказки (mode → режим, role → @)', () => {
    const session = makeSession({ mode: 'plan', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      unavailableTools: [
        { name: 'write_file', reason: 'mode' },
        { name: 'execute_shell', reason: 'role' },
      ],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode).toBeDefined();
    expect(mode!.content).toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
    expect(mode!.content).toContain('write_file');
    expect(mode!.content).toContain('переключите режим');
    expect(mode!.content).toContain('execute_shell');
    expect(mode!.content).toContain('делегируйте через @');
  });

  it('unavailable-секция локализуется (en)', () => {
    const session = makeSession({ mode: 'plan', planMode: 'auto', language: 'en' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'en',
      unavailableTools: [{ name: 'write_file', reason: 'mode' }],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode!.content).toContain('[UNAVAILABLE TOOLS]');
    expect(mode!.content).toContain('switch the mode');
  });

  it('пустой unavailableTools: секции недоступных тулов нет', () => {
    const session = makeSession({ mode: 'plan', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      unavailableTools: [],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode!.content).not.toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
  });

  it('mode_change с dependency-тулом: binary и подсказка про установку', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      unavailableTools: [{ name: 'git_status', reason: 'dependency', binary: 'git' }],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode).toBeDefined();
    expect(mode!.content).toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
    expect(mode!.content).toContain('git_status');
    expect(mode!.content).toContain('«git»');
    expect(mode!.content).toContain('установите программу');
  });

  it('mode_change с workspace-тулом: одна агрегированная строка про рабочий каталог проекта', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      unavailableTools: [{ name: 'write_file', reason: 'workspace' }],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode).toBeDefined();
    expect(mode!.content).toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
    expect(mode!.content).toContain('file/shell/git-инструменты');
    expect(mode!.content).toContain('рабочий каталог проекта');
    expect(mode!.content).toContain('Создайте/привяжите проект');
    // Имена workspace-тулов не перечисляются — шумный список схлопнут.
    expect(mode!.content).not.toContain('write_file');
  });

  it('workspace-подсказка локализуется (en)', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto', language: 'en' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'en',
      unavailableTools: [{ name: 'write_file', reason: 'workspace' }],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode!.content).toContain('[UNAVAILABLE TOOLS]');
    expect(mode!.content).toContain('working directory');
    expect(mode!.content).toContain('file/shell/git tools');
    expect(mode!.content).not.toContain('write_file');
  });

  it('несколько workspace-тулов схлопываются в одну строку (первой), остальные — следом', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      unavailableTools: [
        { name: 'read_file', reason: 'workspace' },
        { name: 'execute_shell', reason: 'workspace' },
        { name: 'git_status', reason: 'workspace' },
        { name: 'web_fetch', reason: 'mode' },
      ],
    });

    const mode = added.find((m) => m.metadata?.type === 'mode_change');
    expect(mode).toBeDefined();
    const toolLines = mode!.content.split('\n').filter((l) => l.startsWith('- '));
    // ровно две строки списка: агрегированная workspace + одна mode.
    expect(toolLines).toHaveLength(2);
    expect(toolLines[0]).toContain('file/shell/git-инструменты');
    expect(toolLines[1]).toContain('web_fetch');
    // Имена workspace-тулов не перечисляются.
    expect(mode!.content).not.toContain('read_file');
    expect(mode!.content).not.toContain('execute_shell');
    expect(mode!.content).not.toContain('git_status');
  });

  it('agent_switch не включает dependency-тулы (только role)', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      agentRole: 'analyst',
      unavailableTools: [
        { name: 'write_file', reason: 'role' },
        { name: 'git_status', reason: 'dependency', binary: 'git' },
      ],
    });

    const agent = added.find((m) => m.metadata?.type === 'agent_switch');
    expect(agent).toBeDefined();
    expect(agent!.content).toContain('write_file');
    expect(agent!.content).not.toContain('git_status');
  });

  it('agent_switch добавляется при заданном agentRole и перечисляет только role-недоступные', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
      agentRole: 'analyst',
      unavailableTools: [
        { name: 'write_file', reason: 'role' },
        { name: 'git_commit', reason: 'role' },
        { name: 'edit_file', reason: 'mode' },
      ],
    });

    const agent = added.find((m) => m.metadata?.type === 'agent_switch');
    expect(agent).toBeDefined();
    expect(agent!.content).toContain('Активный агент: analyst');
    expect(agent!.content).toContain('write_file');
    expect(agent!.content).toContain('git_commit');
    expect(agent!.content).toContain('делегируйте через @');
    // mode-недоступные в agent_switch не попадают — только ролевые.
    expect(agent!.content).not.toContain('edit_file');
  });

  it('agent_switch не добавляется без agentRole', () => {
    const session = makeSession({ mode: 'act', planMode: 'auto' });

    const { added } = syncStateMessages(session, {
      contextConfig: makeContextConfig(),
      language: 'ru',
    });

    expect(added.some((m) => m.metadata?.type === 'agent_switch')).toBe(false);
  });

  it('идемпотентность: mode_change/agent_switch не дублируются при неизменном состоянии', () => {
    const session = makeSession({ mode: 'plan', planMode: 'auto' });
    const deps: SyncStateMessagesDeps = {
      contextConfig: makeContextConfig(),
      language: 'ru',
      agentRole: 'analyst',
      unavailableTools: [{ name: 'write_file', reason: 'role' }],
    };

    const first = syncStateMessages(session, deps);
    expect(first.added.filter((m) => m.metadata?.type === 'agent_switch')).toHaveLength(1);
    expect(first.added.filter((m) => m.metadata?.type === 'mode_change')).toHaveLength(1);
    session.messages.push(...first.added);

    const second = syncStateMessages(session, deps);
    expect(second.changed).toBe(false);
    expect(second.added).toEqual([]);
  });
});
