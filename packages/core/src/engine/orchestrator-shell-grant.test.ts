import { describe, it, expect, vi } from 'vitest';
import { ChatOrchestrator } from './orchestrator.js';
import { PermissionEvaluator } from './permission/evaluator.js';
import { shellSavePatterns } from './security/shell-guard.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import type { ShellPolicy } from './security/shell-guard.js';

/**
 * Точечные тесты выдачи сессионного shell-гранта: форма правила
 * `execute_shell` (паттерны) и снятие динамического ask следующим check.
 */
const proto = ChatOrchestrator.prototype as unknown as {
  _applyShellAllow: (cfg: PermissionConfig | undefined, patterns: string[]) => PermissionConfig;
  _grantSessionToolAllow: (
    session: unknown,
    toolName: string,
    toolArgs: Record<string, unknown>,
    workingDir: string,
  ) => Promise<PermissionConfig>;
};

const SHELL_POLICY: ShellPolicy = {
  deniedPaths: ['/etc/shadow'],
  deniedPrefixes: ['~/.ssh'],
  approvalPaths: ['~/.ssh/config'],
  deniedCommandPrefixes: ['rm -rf /'],
};

describe('shell-грант сессии (оркестратор)', () => {
  it('_applyShellAllow смёрживает паттерны, не заменяя строковый allow', () => {
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
    };
    const merged = proto._applyShellAllow.call(ctx, undefined, ['git status *', 'ls *']);
    expect(merged.rules.execute_shell).toEqual({
      'git status *': 'allow',
      'ls *': 'allow',
    });

    const keep = proto._applyShellAllow.call(ctx, {
      rules: { execute_shell: 'allow' },
      askTimeoutMs: 30_000,
    }, ['cat *']);
    expect(keep.rules.execute_shell).toBe('allow');
  });

  it('_applyShellAllow: строковый ask сохраняет catch-all, deny не перебивается', () => {
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
    };
    // Строковый `ask` → объект с catch-all: неодобренные команды спрашиваются.
    const merged = proto._applyShellAllow.call(ctx, {
      rules: { execute_shell: 'ask' },
      askTimeoutMs: 30_000,
    }, ['ls *']);
    expect(merged.rules.execute_shell).toEqual({ '*': 'ask', 'ls *': 'allow' });

    // `deny` грантом не перебивается.
    const denied = proto._applyShellAllow.call(ctx, {
      rules: { execute_shell: 'deny' },
      askTimeoutMs: 30_000,
    }, ['ls *']);
    expect(denied.rules.execute_shell).toBe('deny');
  });

  it('грант из строкового ask: одобренная команда — allow, неодобренная — ask', () => {
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
    };
    const merged = proto._applyShellAllow.call(ctx, {
      rules: { execute_shell: 'ask' },
      askTimeoutMs: 30_000,
    }, ['ls *']);
    const decision = (command: string) => new PermissionEvaluator(merged).check({
      toolName: 'execute_shell',
      params: { command },
      workingDir: '/workspace/project',
      sessionMode: 'act',
      planMode: 'auto',
      planApproved: false,
      shellPolicy: SHELL_POLICY,
    }).action;
    expect(decision('ls -la')).toBe('allow');
    expect(decision('rm -rf x')).toBe('ask');
  });

  it('нерезолвимая динамика: грант не выдаётся, конфиг не меняется и не сохраняется', async () => {
    const session = {
      id: 's1',
      ownerId: 'user1',
      parentId: undefined as string | undefined,
      settings: { permission: { rules: { execute_shell: 'ask' }, askTimeoutMs: 30_000 } as PermissionConfig },
    };
    const saveSession = vi.fn(async () => {});
    const publish = vi.fn();
    const granted: unknown[] = [];
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: {
        withLock: async (_id: string, fn: (s: typeof session) => Promise<void>) => fn(session),
        saveSession,
      },
      _eventBus: { publish },
      _onPermissionGrant: (entry: unknown) => {
        granted.push(entry);
      },
      _applyShellAllow: proto._applyShellAllow,
      _applyToolAllow: vi.fn(),
    };

    const config = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'execute_shell',
      { command: "C='cat /etc/shadow'; $C" },
      '/workspace/project',
    );

    // Не `execute_shell: 'allow'` (шире одобренного) и не объект с паттерном.
    expect(config.rules.execute_shell).toBe('ask');
    expect(config).toBe(session.settings.permission);
    // Зря не сохраняем, не паблишим и не пишем аудит.
    expect(saveSession).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(granted).toHaveLength(0);
    // Fallback на `_applyToolAllow` не вызывался.
    expect((ctx._applyToolAllow as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('выдача гранта: паттерны в сессии + следующий check — allow, callback аудита вызван', async () => {
    const session = {
      id: 's1',
      ownerId: 'user1',
      parentId: undefined as string | undefined,
      settings: { permission: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig },
    };
    const saved: PermissionConfig[] = [];
    const granted: Array<{ sessionId: string; actor: string; patterns: string[]; command: string }> = [];
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: {
        withLock: async (_id: string, fn: (s: typeof session) => Promise<void>) => fn(session),
        saveSession: async () => {},
      },
      _eventBus: { publish: () => {} },
      _onPermissionGrant: (entry: { sessionId: string; actor: string; patterns: string[]; command: string }) => {
        granted.push(entry);
      },
      _applyShellAllow: proto._applyShellAllow,
    };

    const config = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'execute_shell',
      { command: 'git status --porcelain' },
      '/workspace/project',
    );
    saved.push(config);
    expect(config.rules.execute_shell).toEqual({ 'git status *': 'allow' });
    expect(granted).toEqual([{
      sessionId: 's1',
      actor: 'user1',
      patterns: ['git status *'],
      command: 'git status --porcelain',
    }]);

    // Следующий check в той же сессии: динамический ask снят грантом.
    const decision = new PermissionEvaluator(config).check({
      toolName: 'execute_shell',
      params: { command: 'git status $BRANCH' },
      workingDir: '/workspace/project',
      sessionMode: 'act',
      planMode: 'auto',
      planApproved: false,
      shellPolicy: SHELL_POLICY,
    });
    expect(decision.action).toBe('allow');
  });

  it('сценарий: одобрение `cd "$HOME" && ls -la` → повтор разрешён, чужая команда — ask', () => {
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
    };
    const command = 'cd "$HOME" && ls -la';
    const patterns = shellSavePatterns(command);
    expect(patterns).toEqual(['cd *', 'ls *']);
    const merged = proto._applyShellAllow.call(ctx, {
      rules: { execute_shell: 'ask' },
      askTimeoutMs: 30_000,
    }, patterns ?? []);
    const decision = (cmd: string) => new PermissionEvaluator(merged).check({
      toolName: 'execute_shell',
      params: { command: cmd },
      workingDir: '/workspace/project',
      sessionMode: 'act',
      planMode: 'auto',
      planApproved: false,
      shellPolicy: SHELL_POLICY,
    }).action;
    expect(decision(command)).toBe('allow');
    expect(decision('rm -rf x')).toBe('ask');
  });
});
