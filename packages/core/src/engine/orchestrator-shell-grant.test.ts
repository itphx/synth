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
  askKind?: 'dynamic' | 'protected' | 'mutation' | 'cwd' | 'external';
  paths?: string[];
};

const proto = ChatOrchestrator.prototype as unknown as {
  _applyShellAllow: (cfg: PermissionConfig | undefined, patterns: string[]) => PermissionConfig;
  _applyDirectoryAllow: (
    cfg: PermissionConfig | undefined,
    directories: readonly string[],
  ) => PermissionConfig;
  _applyToolAllow: (
    cfg: PermissionConfig | undefined,
    toolName: string,
    paths: string[],
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

/** Лёгкий снимок сессии для фейковых менеджеров гранта. */
type GrantSession = {
  id: string;
  ownerId?: string;
  parentId?: string;
  updatedAt?: string;
  settings: { permission: PermissionConfig };
};

/** Фейковое хранилище: id → документ сессии. */
type GrantStore = Map<string, GrantSession>;

/**
 * Фейк `SessionManager.mutateMeta` с семантикой порта: мутатор работает со
 * **свежим** документом из стора, `touchUpdatedAt:false` не двигает `updatedAt`,
 * `shouldWrite:false` — записи нет. `calls` собирает вызовы (вместо прежнего
 * шпиона `saveSession`).
 */
function fakeMutateMeta(
  store: GrantStore,
  calls?: Array<{ sessionId: string; touchUpdatedAt?: boolean }>,
) {
  return async (
    sessionId: string,
    mutator: (meta: GrantSession) => unknown,
    opts?: { touchUpdatedAt?: boolean; shouldWrite?: (value: unknown) => boolean },
  ): Promise<
    | { found: false }
    | { found: true; value: unknown; session: GrantSession }
  > => {
    calls?.push({ sessionId, ...(opts?.touchUpdatedAt !== undefined ? { touchUpdatedAt: opts.touchUpdatedAt } : {}) });
    const current = store.get(sessionId);
    if (!current) return { found: false };
    const meta = structuredClone(current);
    const value = mutator(meta);
    if (opts?.shouldWrite && !opts.shouldWrite(value)) {
      return { found: true, value, session: structuredClone(current) };
    }
    if (opts?.touchUpdatedAt !== false) meta.updatedAt = new Date().toISOString();
    store.set(sessionId, structuredClone(meta));
    return { found: true, value, session: meta };
  };
}

/** Стор с одной сессией (клон: правки идут в стор, не в объект вызывающего). */
function grantStore(session: GrantSession): GrantStore {
  return new Map([[session.id, structuredClone(session)]]);
}

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
    const session: GrantSession = {
      id: 's1',
      ownerId: 'user1',
      parentId: undefined,
      settings: { permission: { rules: { execute_shell: 'ask' }, askTimeoutMs: 30_000 } as PermissionConfig },
    };
    const store = grantStore(session);
    const mutateCalls: Array<{ sessionId: string; touchUpdatedAt?: boolean }> = [];
    const publish = vi.fn();
    const granted: unknown[] = [];
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: { mutateMeta: fakeMutateMeta(store, mutateCalls) },
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
    expect(mutateCalls).toHaveLength(0);
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
    const session: GrantSession = {
      id: 's1',
      ownerId: 'user1',
      parentId: undefined,
      settings: { permission: { rules: { execute_shell: 'ask' }, askTimeoutMs: 30_000 } as PermissionConfig },
    };
    const store = grantStore(session);
    const mutateCalls: Array<{ sessionId: string; touchUpdatedAt?: boolean }> = [];
    const publish = vi.fn();
    const granted: unknown[] = [];
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: { mutateMeta: fakeMutateMeta(store, mutateCalls) },
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
    expect(mutateCalls).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(granted).toHaveLength(0);
    // Fallback на `_applyToolAllow` (грант по путям) не вызывался.
    expect((ctx._applyToolAllow as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('сценарий: `cd "$HOME" && ls -la` — командный паттерн external-ask НЕ снимает', () => {
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
    });
    // `cd $HOME` — реальный доступ вне периметра: снимается только правилом
    // `external_directory` на каталог (грант каталогом), не паттерном команды.
    const d = decision(command);
    expect(d.action).toBe('ask');
    expect(d.askKind).toBe('external');
    expect(decision('rm -rf x').action).toBe('ask');
  });

  it('сценарий: грант паттернами для команд внутри периметра — повтор разрешён', () => {
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
    };
    const command = 'cd sub && ls -la';
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
  const baseSession = (): GrantSession => ({
    id: 's1',
    ownerId: 'user1',
    parentId: undefined,
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
      const store = grantStore(session);
      let writes = 0;
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
          // Запись — только точечная мутация метаданных, без `touchUpdatedAt`.
          mutateMeta: async (
            id: string,
            mutator: (meta: GrantSession) => unknown,
            opts?: { touchUpdatedAt?: boolean },
          ) => {
            writes += 1;
            expect(id).toBe('s1');
            expect(opts?.touchUpdatedAt).toBe(false);
            return fakeMutateMeta(store)(id, mutator, opts);
          },
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
      expect(writes).toBe(1);
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

  it('external-ask: грант — каталог из askPaths, execute_shell не пишется', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-grant-ext-'));
    const outside = await mkdtemp(join(tmpdir(), 'synth-grant-ext-out-'));
    try {
      const outsideFile = join(outside, 'a.txt');
      await writeFile(outsideFile, 'x');
      const session = baseSession();
      const store = grantStore(session);
      const granted: Array<{ patterns: string[]; directories: string[] }> = [];
      const ctx = {
        _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
        _sessionManager: { mutateMeta: fakeMutateMeta(store) },
        _eventBus: { publish: () => {} },
        _onPermissionGrant: (entry: { patterns: string[]; directories: string[] }) => {
          granted.push(entry);
        },
        _applyShellAllow: proto._applyShellAllow,
        _applyDirectoryAllow: proto._applyDirectoryAllow,
        _applyToolAllow: vi.fn(),
      };

      const command = `cat ${outsideFile}`;
      const config = await proto._grantSessionToolAllow.call(
        ctx,
        session,
        'execute_shell',
        { command },
        root,
        { params: { path: outsideFile }, askKind: 'external', paths: [outsideFile] },
      );

      // Командный паттерн не выдан: грант — каталогом внешнего файла.
      expect(config.rules.execute_shell).toBeUndefined();
      expect(config.rules.external_directory).toEqual({ [`${outside}/*`]: 'allow' });
      expect(granted[0]?.patterns).toEqual([]);
      expect(granted[0]?.directories).toEqual([outside]);

      // Повтор той же команды снят правилом external_directory.
      const decision = new PermissionEvaluator(config).check({
        toolName: 'execute_shell',
        params: { command },
        workingDir: root,
        sessionMode: 'act',
        planMode: 'auto',
        planApproved: false,
        shellPolicy: SHELL_POLICY,
      });
      expect(decision.action).toBe('allow');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('каталог гранта считается от рабочего каталога + cwd тула', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synth-grant-cwd-'));
    try {
      const session = baseSession();
      const store = grantStore(session);
      const granted: Array<{ directories: string[] }> = [];
      const ctx = {
        _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
        _sessionManager: { mutateMeta: fakeMutateMeta(store) },
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
    const store = grantStore(session);
    const mutateCalls: Array<{ sessionId: string; touchUpdatedAt?: boolean }> = [];
    const publish = vi.fn();
    const granted: unknown[] = [];
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: { mutateMeta: fakeMutateMeta(store, mutateCalls) },
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
    expect(mutateCalls).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(granted).toHaveLength(0);
  });

  it('сессия не найдена → ошибка (паритет с `withLock`), а не молчаливый пропуск', async () => {
    const session: GrantSession = {
      id: 's-missing',
      settings: { permission: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig },
    };
    const publish = vi.fn();
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      // Пустой стор: мутация вернёт `found:false`.
      _sessionManager: { mutateMeta: fakeMutateMeta(new Map()) },
      _eventBus: { publish },
      _applyShellAllow: proto._applyShellAllow,
      _applyDirectoryAllow: proto._applyDirectoryAllow,
      _applyToolAllow: proto._applyToolAllow,
    };

    await expect(proto._grantSessionToolAllow.call(
      ctx,
      session,
      'read_file',
      { file_path: 'a.txt' },
      '/workspace/project',
    )).rejects.toThrow('Session s-missing not found');
    expect(publish).not.toHaveBeenCalled();
  });

  it('родитель не найден → ошибка (паритет с `withLock`)', async () => {
    const child: GrantSession = {
      id: 's-child',
      parentId: 's-absent',
      settings: { permission: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig },
    };
    const store = grantStore(child);
    const publish = vi.fn();
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: { mutateMeta: fakeMutateMeta(store) },
      _eventBus: { publish },
      _applyShellAllow: proto._applyShellAllow,
      _applyDirectoryAllow: proto._applyDirectoryAllow,
      _applyToolAllow: proto._applyToolAllow,
    };

    await expect(proto._grantSessionToolAllow.call(
      ctx,
      child,
      'read_file',
      { file_path: 'a.txt' },
      '/workspace/project',
    )).rejects.toThrow('Session s-absent not found');
    // Грант ребёнка при этом записан (мутация прошла до ошибки по родителю).
    expect(store.get('s-child')!.settings.permission.rules.read_file).toEqual({
      '/workspace/project/a.txt': 'allow',
    });
  });
});

/**
 * Гонка «несколько одобрений подряд»: вызывающий держит **снимок** сессии
 * (у живого хода это объект хода, у HTTP-ответа — загруженный ранее документ),
 * а `mutateMeta` отдаёт свежий документ из хранилища. Грант обязан считаться от
 * свежей базы внутри мутатора, иначе второй грант затирает первый (в панели
 * «Сессионные одобрения» виден только последний пункт).
 */
describe('грант сессии: последовательные одобрения не затирают друг друга', () => {
  const baseSession = (): GrantSession => ({
    id: 's1',
    ownerId: 'user1',
    settings: { permission: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig },
  });

  /** Фейк менеджера сессий с настоящей семантикой: мутатор видит копию из стора. */
  const storeBackedCtx = (initial: GrantSession) => {
    const store = grantStore(initial);
    const mutateCalls: Array<{ sessionId: string; touchUpdatedAt?: boolean }> = [];
    const publish = vi.fn();
    const ctx = {
      _permissionConfig: { rules: {}, askTimeoutMs: 30_000 } as PermissionConfig,
      _sessionManager: { mutateMeta: fakeMutateMeta(store, mutateCalls) },
      _eventBus: { publish },
      _applyShellAllow: proto._applyShellAllow,
      _applyDirectoryAllow: proto._applyDirectoryAllow,
      _applyToolAllow: proto._applyToolAllow,
    };
    return { ctx, store, mutateCalls, publish };
  };

  it('файловый тул: два пути из одного устаревшего снимка — оба правила в сессии', async () => {
    const session = baseSession();
    const { ctx, store, mutateCalls } = storeBackedCtx(session);

    const first = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'read_file',
      { file_path: 'a.txt' },
      '/workspace/project',
    );
    // Второй вызов идёт с **тем же** объектом `session` (снимок до первого лока).
    const second = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'read_file',
      { file_path: 'b.txt' },
      '/workspace/project',
    );

    const expected = {
      '/workspace/project/a.txt': 'allow',
      '/workspace/project/b.txt': 'allow',
    };
    expect(first.rules.read_file).toEqual({ '/workspace/project/a.txt': 'allow' });
    expect(second.rules.read_file).toEqual(expected);
    // В хранилище — оба пути, второй грант первый не затёр.
    expect(store.get('s1')!.settings.permission.rules.read_file).toEqual(expected);
    expect(mutateCalls).toHaveLength(2);
    // Время сессии не двигается: грант — служебная правка прав.
    expect(mutateCalls.every((c) => c.touchUpdatedAt === false)).toBe(true);
    // Сам снимок вызывающего не мутирован (правило живёт в сторе).
    expect(session.settings.permission.rules.read_file).toBeUndefined();
  });

  it('shell: два каталога из одного устаревшего снимка — оба правила в сессии', async () => {
    const session = baseSession();
    const { ctx, store } = storeBackedCtx(session);

    const first = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'execute_shell',
      { command: 'grep -l x a/*.js' },
      '/workspace/project',
      { params: { path: 'a/*.js' }, askKind: 'dynamic' },
    );
    const second = await proto._grantSessionToolAllow.call(
      ctx,
      session,
      'execute_shell',
      { command: 'grep -l x b/*.js' },
      '/workspace/project',
      { params: { path: 'b/*.js' }, askKind: 'dynamic' },
    );

    const expected = {
      '/workspace/project/a/*': 'allow',
      '/workspace/project/b/*': 'allow',
    };
    expect(first.rules.external_directory).toEqual({ '/workspace/project/a/*': 'allow' });
    expect(second.rules.external_directory).toEqual(expected);
    expect(store.get('s1')!.settings.permission.rules.external_directory).toEqual(expected);
    // Командный паттерн по-прежнему не выдаётся.
    expect(store.get('s1')!.settings.permission.rules.execute_shell).toBeUndefined();
  });
});
