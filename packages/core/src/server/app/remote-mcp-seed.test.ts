/**
 * PROP-125 §2: сид серверных MCP-серверов в проекты (новые — через
 * `mergeMcpSeedDefaults`, существующие — через `seedRemoteMcpProjects`).
 *
 * Проверяет: дедуп имён, авто-сид (`enabled`/`defaultOn`/`remoteSeeded`),
 * идемпотентность (повторный прогон — 0 изменений), «выключенный
 * пользователем сервер не возвращается» и вызов `onUpdated`.
 */
import { describe, it, expect } from 'vitest';
import type { Project } from '@itphx/synth-shared';
import { mergeMcpSeedDefaults, seedRemoteMcpProjects } from './remote-mcp-seed.js';

/** Минимальный проект (только поля, нужные сиду). */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Проект',
    ownerId: 'local',
    members: {},
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Подставной порт хранилища проектов: `mutate` применяет мутатор к копии
 * проекта (как `ProjectRepository.mutate` — атомарный read-modify-write).
 */
function makeMutate(projects: Project[]) {
  const store = new Map(projects.map((p) => [p.id, p]));
  const calls: string[] = [];
  return {
    calls,
    mutate: async (id: string, mutator: (project: Project) => void): Promise<Project | null> => {
      const current = store.get(id);
      if (!current) return null;
      const copy: Project = { ...current, mcp: current.mcp ? { ...current.mcp } : undefined };
      mutator(copy);
      store.set(id, copy);
      calls.push(id);
      return copy;
    },
    get: (id: string): Project | undefined => store.get(id),
  };
}

describe('mergeMcpSeedDefaults', () => {
  it('объединяет локальные и серверные дефолты без дублей', () => {
    expect(mergeMcpSeedDefaults(['local-a'], ['remote-a'])).toEqual(['local-a', 'remote-a']);
  });

  it('дубли между локальными и серверными дефолтами схлопываются', () => {
    expect(mergeMcpSeedDefaults(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeMcpSeedDefaults(['a', 'a'], ['a'])).toEqual(['a']);
  });

  it('пустые списки дают пустой результат', () => {
    expect(mergeMcpSeedDefaults([], [])).toEqual([]);
    expect(mergeMcpSeedDefaults([], ['a'])).toEqual(['a']);
  });
});

describe('seedRemoteMcpProjects', () => {
  it('добавляет серверные дефолты в enabled/defaultOn/remoteSeeded', async () => {
    const project = makeProject({ mcp: { enabled: ['local'], defaultOn: ['local'] } });
    const store = makeMutate([project]);

    const updated = await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a'],
      mutate: store.mutate,
    });

    expect(updated).toBe(1);
    const saved = store.get('proj-1')!;
    expect(saved.mcp).toEqual({
      enabled: ['local', 'remote-a'],
      defaultOn: ['local', 'remote-a'],
      remoteSeeded: ['remote-a'],
    });
  });

  it('проект без mcp получает поле mcp', async () => {
    const project = makeProject();
    const store = makeMutate([project]);

    const updated = await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a'],
      mutate: store.mutate,
    });

    expect(updated).toBe(1);
    expect(store.get('proj-1')!.mcp).toEqual({
      enabled: ['remote-a'],
      defaultOn: ['remote-a'],
      remoteSeeded: ['remote-a'],
    });
  });

  it('legacy-проект без mcp: enabled = все известные серверы + серверный дефолт', async () => {
    // ADR-071: отсутствие `project.mcp` = «гейт не задан» (доступны все).
    // Появление `enabled` — hard-gate, поэтому локальные серверы не должны
    // выпасть из allow-list.
    const project = makeProject();
    const store = makeMutate([project]);

    const updated = await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a'],
      knownServers: ['local-srv'],
      mutate: store.mutate,
    });

    expect(updated).toBe(1);
    expect(store.get('proj-1')!.mcp).toEqual({
      enabled: ['local-srv', 'remote-a'],
      // `defaultOn` — только серверный дефолт (сид новых сессий).
      defaultOn: ['remote-a'],
      remoteSeeded: ['remote-a'],
    });
  });

  it('legacy-проект без mcp и без knownServers — прежнее поведение (только toAdd)', async () => {
    const project = makeProject();
    const store = makeMutate([project]);

    await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a'],
      mutate: store.mutate,
    });

    expect(store.get('proj-1')!.mcp!.enabled).toEqual(['remote-a']);
  });

  it('проект с mcp: knownServers не влияет на enabled (гейт уже задан)', async () => {
    const project = makeProject({ mcp: { enabled: ['own'], defaultOn: ['own'] } });
    const store = makeMutate([project]);

    await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a'],
      knownServers: ['local-srv'],
      mutate: store.mutate,
    });

    expect(store.get('proj-1')!.mcp!.enabled).toEqual(['own', 'remote-a']);
    expect(store.get('proj-1')!.mcp!.defaultOn).toEqual(['own', 'remote-a']);
  });

  it('идемпотентно: второй прогон ничего не меняет', async () => {
    const project = makeProject();
    const store = makeMutate([project]);
    const opts = { defaults: ['remote-a'], mutate: store.mutate };

    expect(await seedRemoteMcpProjects({ ...opts, projects: [project] })).toBe(1);
    const afterFirst = store.get('proj-1')!.mcp;

    // Второй прогон — по сохранённому проекту (как при повторном коннекте).
    expect(await seedRemoteMcpProjects({ ...opts, projects: [store.get('proj-1')!] })).toBe(0);
    expect(store.get('proj-1')!.mcp).toEqual(afterFirst);
    expect(store.calls).toHaveLength(1);
  });

  it('выключенный пользователем сервер не возвращается (маркер remoteSeeded)', async () => {
    // Пользователь выключил сервер: имя в `remoteSeeded`, но нет в `enabled`.
    const project = makeProject({
      mcp: { enabled: [], defaultOn: [], remoteSeeded: ['remote-a'] },
    });
    const store = makeMutate([project]);

    const updated = await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a'],
      mutate: store.mutate,
    });

    expect(updated).toBe(0);
    expect(store.get('proj-1')!.mcp!.enabled).toEqual([]);
    expect(store.get('proj-1')!.mcp!.defaultOn).toEqual([]);
  });

  it('пустой список дефолтов — ничего не меняется', async () => {
    const project = makeProject();
    const store = makeMutate([project]);

    const updated = await seedRemoteMcpProjects({
      projects: [project],
      defaults: [],
      mutate: store.mutate,
    });

    expect(updated).toBe(0);
    expect(store.calls).toHaveLength(0);
  });

  it('onUpdated вызывается для каждого обновлённого проекта', async () => {
    const p1 = makeProject({ id: 'proj-1' });
    const p2 = makeProject({ id: 'proj-2' });
    const store = makeMutate([p1, p2]);
    const seen: string[] = [];

    const updated = await seedRemoteMcpProjects({
      projects: [p1, p2],
      defaults: ['remote-a'],
      mutate: store.mutate,
      onUpdated: async (project) => {
        seen.push(project.id);
      },
    });

    expect(updated).toBe(2);
    expect(seen).toEqual(['proj-1', 'proj-2']);
  });

  it('новый дефолт добавляется, прежний не дублируется', async () => {
    const project = makeProject({
      mcp: { enabled: ['remote-a'], defaultOn: ['remote-a'], remoteSeeded: ['remote-a'] },
    });
    const store = makeMutate([project]);

    const updated = await seedRemoteMcpProjects({
      projects: [project],
      defaults: ['remote-a', 'remote-b'],
      mutate: store.mutate,
    });

    expect(updated).toBe(1);
    // Добавился только новый дефолт; прежний не дублируется.
    expect(store.get('proj-1')!.mcp!.enabled).toEqual(['remote-a', 'remote-b']);
    expect(store.get('proj-1')!.mcp!.remoteSeeded).toEqual(['remote-a', 'remote-b']);
  });
});
