// ADR-098 (W5): деградированное хранилище и ось доступности тулов.
// file/shell/git/`task`/plan/todo → `unavailable(storage)` (плюс жёсткий `deny`
// в permission-слое); безопасные тулы (`skill`/`web_fetch`/`web_search`) — доступны;
// схлопнутая подсказка рендерится в state-сообщении.
import { describe, it, expect, afterEach } from 'vitest';
import type { PermissionConfig } from '@itphx/synth-shared';
import {
  computeToolAvailability,
  isToolAvailableInDegradedMode,
  isWorkspaceDependentTool,
} from './availability.js';
import { PermissionEvaluator } from './evaluator.js';
import { setStorageDegradedState, isStorageDegraded, getStorageDegradedState } from './storage-state.js';
import {
  renderUnavailableTools,
  buildModeChangeContent,
  buildAgentSwitchContent,
  type UnavailableTool,
} from '../context/state-messages.js';

afterEach(() => setStorageDegradedState(null));

describe('computeToolAvailability — degraded storage (ADR-098 W5)', () => {
  const unavailableCases: Array<[string, string[]]> = [
    ['read_file', ['file_read']],
    ['write_file', ['file_write']],
    ['execute_shell', ['shell']],
    ['grep_files', ['search']],
    ['git_status', ['git_read']],
    ['git_commit', ['git_write']],
    ['task', ['task']],
    ['plan_write', ['plan']],
    ['todo_write', ['todo']],
  ];

  it('storageDegraded:true — доменные тулы unavailable(storage)', () => {
    for (const [tool, caps] of unavailableCases) {
      expect(computeToolAvailability(tool, caps, { storageDegraded: true }), tool).toEqual({
        available: false,
        reason: 'storage',
      });
    }
  });

  it('storageDegraded:true — безопасные тулы доступны (skill/web_fetch/web_search)', () => {
    for (const tool of ['skill', 'web_fetch', 'web_search']) {
      expect(computeToolAvailability(tool, [], { storageDegraded: true }), tool).toEqual({
        available: true,
      });
    }
  });

  it('storageDegraded:false — прежнее поведение (доменные тулы доступны)', () => {
    expect(computeToolAvailability('read_file', ['file_read'], { storageDegraded: false })).toEqual({
      available: true,
    });
  });

  it('storage приоритетнее role/mode/dependency/workspace', () => {
    expect(
      computeToolAvailability('write_file', ['file_write'], {
        storageDegraded: true,
        agentCapabilities: ['file_read'], // role
        sessionMode: 'plan', // mode
        workspaceReady: false, // workspace
      }),
    ).toEqual({ available: false, reason: 'storage' });
  });

  it('без opts.storageDegraded — берётся рантайм-состояние (setStorageDegradedState)', () => {
    expect(computeToolAvailability('read_file', ['file_read'], {})).toEqual({ available: true });
    setStorageDegradedState({ degraded: true, fallbackDir: '/tmp/fb', reason: 'boom' });
    expect(isStorageDegraded()).toBe(true);
    expect(computeToolAvailability('read_file', ['file_read'], {})).toEqual({
      available: false,
      reason: 'storage',
    });
    // Безопасные — доступны и из рантайм-состояния.
    expect(computeToolAvailability('web_fetch', ['web'], {})).toEqual({ available: true });
  });

  it('isToolAvailableInDegradedMode — только skill/web_fetch/web_search', () => {
    expect(isToolAvailableInDegradedMode('skill')).toBe(true);
    expect(isToolAvailableInDegradedMode('web_fetch')).toBe(true);
    expect(isToolAvailableInDegradedMode('web_search')).toBe(true);
    expect(isToolAvailableInDegradedMode('read_file')).toBe(false);
    expect(isToolAvailableInDegradedMode('task')).toBe(false);
  });

  it('isWorkspaceDependentTool не затронут деградацией (независимые оси)', () => {
    expect(isWorkspaceDependentTool(['file_read'])).toBe(true);
  });
});

describe('PermissionEvaluator — degraded storage (ADR-098 W5)', () => {
  const evaluator = new PermissionEvaluator({} as PermissionConfig);
  const base = { params: {}, workingDir: '/ws' };

  it('деградация: доменный тул → deny unavailable(storage) с messageId', () => {
    setStorageDegradedState({ degraded: true, reason: 'storage down' });
    const decision = evaluator.check({ ...base, toolName: 'read_file', capabilities: ['file_read'] });
    expect(decision.action).toBe('deny');
    expect(decision.unavailable).toEqual({ reason: 'storage' });
    expect(decision.messageId).toBe('tool-unavailable-storage');
    expect(decision.reason).toBeTruthy();
  });

  it('деградация: skill/web_fetch остаются доступны (allow)', () => {
    setStorageDegradedState({ degraded: true });
    expect(evaluator.check({ ...base, toolName: 'skill', params: { name: 'x' } }).action).toBe('allow');
    expect(evaluator.check({ ...base, toolName: 'web_fetch', capabilities: ['web'] }).action).toBe('allow');
  });

  it('в норме — прежнее поведение (read_file allow по умолчанию)', () => {
    setStorageDegradedState(null);
    expect(evaluator.check({ ...base, toolName: 'read_file', capabilities: ['file_read'] }).action).toBe('allow');
  });
});

describe('storage-state — рантайм-флаг (ADR-098 W5)', () => {
  it('set/is/get: норма ↔ деградация', () => {
    setStorageDegradedState(null);
    expect(isStorageDegraded()).toBe(false);
    expect(getStorageDegradedState()).toEqual({ degraded: false });

    setStorageDegradedState({ degraded: true, fallbackDir: '/fb', reason: 'r' });
    expect(isStorageDegraded()).toBe(true);
    expect(getStorageDegradedState()).toEqual({ degraded: true, fallbackDir: '/fb', reason: 'r' });
  });

  it('setStorageDegradedState({degraded:false}) — тоже норма', () => {
    setStorageDegradedState({ degraded: false });
    expect(isStorageDegraded()).toBe(false);
  });
});

describe('state-messages — схлопнутая подсказка деградации (ADR-098 W5)', () => {
  const unavailable: UnavailableTool[] = [
    { name: 'read_file', reason: 'storage' },
    { name: 'execute_shell', reason: 'storage' },
    { name: 'task', reason: 'storage' },
  ];

  it('renderUnavailableTools: storage-тулы схлопываются в одну строку (ru/en)', () => {
    const ru = renderUnavailableTools(unavailable, 'ru');
    expect(ru).toContain('[НЕДОСТУПНЫЕ ТУЛЫ]');
    expect(ru).toContain('read-only');
    // Имена отдельных тулов не перечисляются.
    expect(ru).not.toContain('read_file');

    const en = renderUnavailableTools(unavailable, 'en');
    expect(en).toContain('[UNAVAILABLE TOOLS]');
    expect(en).toContain('degraded mode');
  });

  it('пустой список → пустая строка', () => {
    expect(renderUnavailableTools([], 'ru')).toBe('');
  });

  it('renderUnavailableTools: деталь состава пула попадает в строку тула (ADR-077)', () => {
    const ru = renderUnavailableTools(
      [
        {
          name: 'git_status',
          reason: 'dependency',
          binary: 'git',
          detail: 'git: отсутствует в 2 из 3 адресов пула',
        },
      ],
      'ru',
    );
    expect(ru).toContain('git_status');
    expect(ru).toContain('git: отсутствует в 2 из 3 адресов пула');

    const en = renderUnavailableTools(
      [
        {
          name: 'git_status',
          reason: 'dependency',
          binary: 'git',
          detail: 'git: отсутствует в 2 из 3 адресов пула',
        },
      ],
      'en',
    );
    expect(en).toContain('git: отсутствует в 2 из 3 адресов пула');
  });

  it('buildModeChangeContent: секция storage подмешивается к промпту режима', () => {
    const content = buildModeChangeContent('act', 'auto', false, 'ru', {
      getModePrompt: () => '[MODE act]',
      getPlanModePrompt: () => '',
    } as never, unavailable);
    expect(content).toContain('[MODE act]');
    expect(content).toContain('хранилище (PostgreSQL) недоступно');
  });

  it('buildAgentSwitchContent: storage-тулы НЕ попадают в секцию роли', () => {
    // Секция агента показывает только reason==='role'; storage-строка туда не идёт.
    const content = buildAgentSwitchContent('assistant', 'ru', unavailable);
    expect(content).toContain('[АГЕНТ]');
    expect(content).not.toContain('read-only');
  });
});
