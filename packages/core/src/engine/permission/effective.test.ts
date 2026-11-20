import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveEffectivePermission, MAX_PERMISSION_PARENT_DEPTH } from './effective.js';
import { DEFAULT_ASK_TIMEOUT_MS, deriveSubagentPermission } from './derive.js';
import type { PermissionChainSession } from './effective.js';
import type { PermissionConfig } from '@itphx/synth-shared';

const cfg = (rules: PermissionConfig['rules'], askTimeoutMs = 30_000): PermissionConfig => ({ rules, askTimeoutMs });

/** Фейковый загрузчик сессий по id (как `SessionManager.getSession`). */
function loader(map: Record<string, PermissionChainSession>) {
  return async (id: string): Promise<PermissionChainSession | null> => map[id] ?? null;
}

describe('resolveEffectivePermission — цепочка parentId (ADR-029, chain-no-copy)', () => {
  it('пустая цепочка (нет своего конфига и родителя) — fallback, иначе дефолт', async () => {
    const session: PermissionChainSession = { id: 's1', settings: {} };
    const withFallback = await resolveEffectivePermission({
      session,
      getSession: loader({}),
      fallback: cfg({ read: 'allow' }, 5000),
    });
    expect(withFallback.rules).toEqual({ read: 'allow' });
    expect(withFallback.askTimeoutMs).toBe(5000);

    const withoutFallback = await resolveEffectivePermission({ session, getSession: loader({}) });
    expect(withoutFallback.rules).toEqual({});
    expect(withoutFallback.askTimeoutMs).toBe(DEFAULT_ASK_TIMEOUT_MS);
  });

  it('слияние root → leaf: правила всех уровней, ключ ребёнка перекрывает родительский', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      child: { id: 'child', parentId: 'parent', settings: { permission: cfg({ write_file: 'deny', task: 'deny' }) } },
      parent: {
        id: 'parent',
        parentId: 'root',
        settings: { permission: cfg({ '*': 'ask', write_file: 'allow', execute_shell: 'allow' }) },
      },
      root: { id: 'root', settings: { permission: cfg({ read_file: 'allow', write_file: 'ask' }) } },
    };
    const resolved = await resolveEffectivePermission({
      session: sessions.child!,
      getSession: loader(sessions),
      fallback: cfg({ skill: 'deny' }),
    });
    expect(resolved.rules).toEqual({
      // fallback — самый нижний слой
      skill: 'deny',
      // root
      read_file: 'allow',
      // parent перекрывает root, child перекрывает parent
      '*': 'ask',
      execute_shell: 'allow',
      write_file: 'deny',
      task: 'deny',
    });
  });

  it('askTimeoutMs: свой у сессии приоритетнее предка и fallback', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      child: { id: 'child', parentId: 'parent', settings: { permission: cfg({}, 777) } },
      parent: { id: 'parent', settings: { permission: cfg({}, 555) } },
    };
    const resolved = await resolveEffectivePermission({
      session: sessions.child!,
      getSession: loader(sessions),
      fallback: cfg({}, 111),
    });
    expect(resolved.askTimeoutMs).toBe(777);
  });

  it('askTimeoutMs: нет своего — берётся ближайший предок, у которого задан', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      // У ребёнка своего конфига нет вовсе.
      child: { id: 'child', parentId: 'parent', settings: {} },
      parent: {
        id: 'parent',
        parentId: 'root',
        // `permission` без поля `askTimeoutMs` — как у старых документов.
        settings: { permission: { rules: { read: 'allow' } } as PermissionConfig },
      },
      root: { id: 'root', settings: { permission: cfg({}, 444) } },
    };
    const resolved = await resolveEffectivePermission({
      session: sessions.child!,
      getSession: loader(sessions),
      fallback: cfg({}, 222),
    });
    expect(resolved.askTimeoutMs).toBe(444);

    // Родитель задал таймаут — он ближе к листу, чем корень.
    sessions.parent!.settings.permission = cfg({ read: 'allow' }, 333);
    const nearest = await resolveEffectivePermission({
      session: sessions.child!,
      getSession: loader(sessions),
      fallback: cfg({}, 222),
    });
    expect(nearest.askTimeoutMs).toBe(333);
  });

  it('askTimeoutMs: ни в цепочке, ни в fallback — DEFAULT_ASK_TIMEOUT_MS', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      child: { id: 'child', parentId: 'parent', settings: {} },
      parent: { id: 'parent', settings: { permission: { rules: {} } as PermissionConfig } },
    };
    const resolved = await resolveEffectivePermission({ session: sessions.child!, getSession: loader(sessions) });
    expect(resolved.askTimeoutMs).toBe(DEFAULT_ASK_TIMEOUT_MS);
  });

  it('лимит глубины: подъём обрезается, исключения нет', async () => {
    // Бесконечная (без цикла по id) цепочка: каждый узел ведёт на следующий.
    const sessions: Record<string, PermissionChainSession> = {};
    const total = MAX_PERMISSION_PARENT_DEPTH + 5;
    for (let i = 0; i < total; i += 1) {
      sessions[`s${i}`] = {
        id: `s${i}`,
        ...(i + 1 < total ? { parentId: `s${i + 1}` } : {}),
        settings: { permission: cfg({ [`tool${i}`]: 'allow' }) },
      };
    }
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resolved = await resolveEffectivePermission({ session: sessions.s0!, getSession: loader(sessions) });
    expect(Object.keys(resolved.rules)).toHaveLength(MAX_PERMISSION_PARENT_DEPTH);
    // Самый глубокий доступный узел присутствует, за пределом — нет.
    expect(resolved.rules[`tool${MAX_PERMISSION_PARENT_DEPTH - 1}`]).toBe('allow');
    expect(resolved.rules[`tool${MAX_PERMISSION_PARENT_DEPTH}`]).toBeUndefined();
    warn.mockRestore();
  });

  it('цикл a → b → a: подъём прекращается, обе сессии учтены по одному разу', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      a: { id: 'a', parentId: 'b', settings: { permission: cfg({ a_tool: 'allow' }) } },
      b: { id: 'b', parentId: 'a', settings: { permission: cfg({ b_tool: 'allow' }) } },
    };
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resolved = await resolveEffectivePermission({ session: sessions.a!, getSession: loader(sessions) });
    expect(resolved.rules).toEqual({ a_tool: 'allow', b_tool: 'allow' });
    warn.mockRestore();
  });

  it('отсутствующий родитель (висячий parentId) — работаем с собранным', async () => {
    const session: PermissionChainSession = {
      id: 'child',
      parentId: 'ghost',
      settings: { permission: cfg({ read: 'deny' }, 1000) },
    };
    const resolved = await resolveEffectivePermission({
      session,
      getSession: loader({}),
      fallback: cfg({ write_file: 'allow' }, 9000),
    });
    expect(resolved.rules).toEqual({ write_file: 'allow', read: 'deny' });
    expect(resolved.askTimeoutMs).toBe(1000);
  });

  it('упавший getSession — ошибка не пробрасывается, резолв fail-open', async () => {
    const session: PermissionChainSession = {
      id: 'child',
      parentId: 'parent',
      settings: { permission: cfg({ read: 'deny' }, 1000) },
    };
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resolved = await resolveEffectivePermission({
      session,
      getSession: async () => {
        throw new Error('storage unavailable');
      },
      fallback: cfg({ '*': 'ask' }, 9000),
    });
    expect(resolved.rules).toEqual({ '*': 'ask', read: 'deny' });
    expect(resolved.askTimeoutMs).toBe(1000);
    warn.mockRestore();
  });

  it('не мутирует входные конфиги и не кеширует (живое чтение)', async () => {
    const parentPermission = cfg({ write_file: 'deny' }, 1000);
    const sessions: Record<string, PermissionChainSession> = {
      child: { id: 'child', parentId: 'parent', settings: { permission: cfg({}) } },
      parent: { id: 'parent', settings: { permission: parentPermission } },
    };
    const first = await resolveEffectivePermission({ session: sessions.child!, getSession: loader(sessions) });
    expect(first.rules).toEqual({ write_file: 'deny' });
    // Входы не тронуты.
    expect(parentPermission.rules).toEqual({ write_file: 'deny' });
    expect(sessions.child!.settings.permission!.rules).toEqual({});

    // Грант родителя, выданный **после** первого резолва, виден следующему.
    sessions.parent!.settings.permission = cfg({ write_file: 'deny', execute_shell: 'allow' }, 1000);
    const second = await resolveEffectivePermission({ session: sessions.child!, getSession: loader(sessions) });
    expect(second.rules).toEqual({ write_file: 'deny', execute_shell: 'allow' });
    // Возвращённый объект не разделяет ссылку с входным правилом родителя.
    expect(second.rules).not.toBe(sessions.parent!.settings.permission!.rules);
  });
});

describe('resolveEffectivePermission × deriveSubagentPermission (роль саб-агента)', () => {
  it('deny-дополнения роли не отменяются allow родителя, полученным по цепочке', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      child: { id: 'child', parentId: 'parent', settings: { permission: deriveSubagentPermission() } },
      parent: { id: 'parent', settings: { permission: cfg({ '*': 'allow', question: 'allow', task: 'allow' }) } },
    };
    const resolved = await resolveEffectivePermission({ session: sessions.child!, getSession: loader(sessions) });
    // Правило по конкретному имени перекрывает `'*'` — `task` остаётся deny.
    expect(resolved.rules['*']).toBe('allow');
    expect(resolved.rules.task).toBe('deny');
    expect(resolved.rules.question).toBe('deny');
    expect(resolved.rules.plan_enter).toBe('deny');
    expect(resolved.rules.plan_exit).toBe('deny');
  });
});

// Проверка, что резолвер действительно не пишет в хранилище: единственный шов —
// `getSession`, и он вызывается только на чтение.
describe('resolveEffectivePermission — только чтение', () => {
  let getSession: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    getSession = vi.fn(async (id: string) => ({ id, settings: {} }) as PermissionChainSession);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('корневая сессия не делает ни одного чтения хранилища', async () => {
    await resolveEffectivePermission({ session: { id: 'root', settings: {} }, getSession });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('цепочка читается по одному разу на узел', async () => {
    const sessions: Record<string, PermissionChainSession> = {
      child: { id: 'child', parentId: 'parent', settings: {} },
      parent: { id: 'parent', parentId: 'root', settings: {} },
      root: { id: 'root', settings: {} },
    };
    getSession.mockImplementation(async (id: string) => sessions[id] ?? null);
    await resolveEffectivePermission({ session: sessions.child!, getSession });
    expect(getSession.mock.calls.map((c) => c[0])).toEqual(['parent', 'root']);
  });
});
