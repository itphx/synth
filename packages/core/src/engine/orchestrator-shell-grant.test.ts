import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOrchestrator } from './orchestrator.js';
import { PermissionEvaluator } from './permission/evaluator.js';
import { shellSavePatterns } from './security/shell-guard.js';
import type { PermissionConfig } from '@itphx/synth-shared';
import type { ShellPolicy } from './security/shell-guard.js';

/**
 * Точечные тесты выдачи сессионного shell-гранта: форма правила
 * `execute_shell` (паттерны) и снятие динамического ask следующим check.
 */
type ShellTrigger = {
  params?: Record<string, string>;
  askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd';
};

const proto = ChatOrchestrator.prototype as unknown as {
  _applyShellAllow: (cfg: PermissionConfig | undefined, patterns: string[]) => PermissionConfig;
  _applyDirectoryAllow: (
    cfg: PermissionConfig | undefined,
    directories: readonly string[],
  ) => PermissionConfig;
  _grantSessionToolAllow: (
    session: unknown,
    toolName: string,
    toolArgs: Record<string, unknown>,
    workingDir: string,
    trigger?: ShellTrigger,
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

  it('без trigger (восстановленная запись): грант не выдаётся — конфиг не меняется, аудита нет', async () => {
    // ADR-029 (аудит 0.13.8, MEDIUM): виновник неизвестен → командный паттерн
    // «на всю команду» шире одобренного (`rm -rf /srv/data` → вечный `rm *`).
    // Живая ветка всегда передаёт trigger (решение permission-слоя); у
    // восстановленного после рестарта ожидания trigger берётся из снимка, а у
    // старых записей его нет → гранта нет вовсе (fail-closed).
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
      _applyDirectoryAllow: proto._applyDirectoryAllow,
      _applyToolAllow: vi.fn(),
    };

    const config = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'execute_shell',
      { command: 'rm -rf /srv/data' },
      '/workspace/project',
    );

    // Ни `execute_shell: 'allow'`, ни паттерна `rm *` — конфиг не тронут.
    expect(config).toBe(session.settings.permission);
    expect(config.rules.execute_shell).toBe('ask');
    expect(saveSession).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(granted).toHaveLength(0);
    // Fallback на `_applyToolAllow` (грант по путям) не вызывался.
    expect((ctx._applyToolAllow as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
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

/**
 * Грант по сегменту-виновнику: для непроверяемой динамики командный паттерн не
 * выдаётся, вместо него — каталог (`external_directory`). `protected` грантом
 * не снимается (жёсткий слой выше правил, ADR-029).
 */
describe('shell-грант сессии: каталог вместо паттерна', () => {
  const baseSession = () => ({
    id: 's1',
    ownerId: 'user1',
    parentId: undefined as string | undefined,
    settings: { permission: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig },
  });

  it('_applyDirectoryAllow: объект правила, строки allow/deny не понижаются', () => {
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
    };
    const merged = proto._applyDirectoryAllow.call(ctx, undefined, ['/x']);
    expect(merged.rules.external_directory).toEqual({ '/x/*': 'allow' });

    const keep = proto._applyDirectoryAllow.call(ctx, {
      rules: { external_directory: 'allow' },
      askTimeoutMs: 30_000,
    }, ['/x']);
    expect(keep.rules.external_directory).toBe('allow');

    const mergedIntoObject = proto._applyDirectoryAllow.call(ctx, {
      rules: { external_directory: { '/other/*': 'deny' } },
      askTimeoutMs: 30_000,
    }, ['/x']);
    // Существующие ключи сохраняются, добавляется ключ каталога.
    expect(mergedIntoObject.rules.external_directory).toEqual({
      '/other/*': 'deny',
      '/x/*': 'allow',
    });
  });

  it('dynamic-ask: пишется external_directory на каталог, execute_shell не пишется', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-grant-'));
    try {
      await writeFile(join(root, 'a.js'), 'x');
      const session = baseSession();
      const published: string[] = [];
      const saveSession = vi.fn(async () => {});
      const granted: Array<{
        sessionId: string;
        actor: string;
        patterns: string[];
        directories: string[];
        command: string;
      }> = [];
      const ctx = {
        _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
        _sessionManager: {
          withLock: async (_id: string, fn: (s: typeof session) => Promise<void>) => fn(session),
          saveSession,
        },
        _eventBus: { publish: (_s: string, type: string) => { published.push(type); } },
        _onPermissionGrant: (entry: {
          sessionId: string;
          actor: string;
          patterns: string[];
          directories: string[];
          command: string;
        }) => {
          granted.push(entry);
        },
        _applyShellAllow: proto._applyShellAllow,
        _applyDirectoryAllow: proto._applyDirectoryAllow,
        _applyToolAllow: vi.fn(),
      };

      const command = `cd ${root}; grep -l "н" *.js | head -20`;
      const config = await proto._grantSessionToolAllow.call(
        ctx,
        session,
        'execute_shell',
        { command },
        '/workspace/project',
        { params: { path: '*.js' }, askKind: 'dynamic' },
      );

      // Командный паттерн не выдан, каталог — выдан.
      expect(config.rules.execute_shell).toBeUndefined();
      expect(config.rules.external_directory).toEqual({ [`${root}/*`]: 'allow' });
      expect(saveSession).toHaveBeenCalled();
      expect(published).toEqual(['session.updated']);
      expect(granted).toEqual([{
        sessionId: 's1',
        actor: 'user1',
        patterns: [],
        directories: [root],
        command,
      }]);

      // Следующий такой же ask снят каталогом (совпадения внутри разрешённого).
      const decision = new PermissionEvaluator(config).check({
        toolName: 'execute_shell',
        params: { command: `grep -l x ${root}/*.js` },
        workingDir: '/workspace/project',
        sessionMode: 'act',
        planMode: 'auto',
        planApproved: false,
        shellPolicy: SHELL_POLICY,
      });
      expect(decision.action).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('каталог гранта считается от рабочего каталога + cwd тула', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-grant-cwd-'));
    try {
      const session = baseSession();
      const granted: Array<{ directories: string[] }> = [];
      const ctx = {
        _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
        _sessionManager: {
          withLock: async (_id: string, fn: (s: typeof session) => Promise<void>) => fn(session),
          saveSession: async () => {},
        },
        _eventBus: { publish: () => {} },
        _onPermissionGrant: (entry: { directories: string[] }) => { granted.push(entry); },
        _applyShellAllow: proto._applyShellAllow,
        _applyDirectoryAllow: proto._applyDirectoryAllow,
        _applyToolAllow: vi.fn(),
      };

      // `cwd: 'sub'` тула — относительно рабочего каталога, не каталога процесса.
      const config = await proto._grantSessionToolAllow.call(
        ctx,
        session,
        'execute_shell',
        { command: 'grep -l "н" *.js', cwd: 'sub' },
        root,
        { params: { path: '*.js' }, askKind: 'dynamic' },
      );
      expect(config.rules.external_directory).toEqual({ [`${join(root, 'sub')}/*`]: 'allow' });
      expect(granted[0]?.directories).toEqual([join(root, 'sub')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('protected-ask: грант не выдаётся (конфиг не меняется, аудита нет)', async () => {
    const session = baseSession();
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
      _onPermissionGrant: (entry: unknown) => { granted.push(entry); },
      _applyShellAllow: proto._applyShellAllow,
      _applyDirectoryAllow: proto._applyDirectoryAllow,
      _applyToolAllow: vi.fn(),
    };

    const config = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'execute_shell',
      { command: 'cat ~/.ssh/config' },
      '/workspace/project',
      { params: { path: '~/.ssh/config' }, askKind: 'protected' },
    );

    expect(config).toBe(session.settings.permission);
    expect(saveSession).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(granted).toHaveLength(0);
  });
});
