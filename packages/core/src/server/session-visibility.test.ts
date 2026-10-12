import { describe, it, expect, vi } from 'vitest';
import { isSessionVisible } from './session-visibility.js';
import type { SessionOwnerCtx } from './session-visibility.js';
import type { ProjectStoreLike } from '../storage/project-store.js';
import { ProjectRole } from '@itphx/synth-shared';
import type { Project, ProjectPlan, Session } from '@itphx/synth-shared';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    engine: 'synth',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {} as Session['settings'],
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  } as Session;
}

function project(id: string, ownerId: string, members: Record<string, ProjectRole> = {}): Project {
  return {
    id,
    name: id,
    ownerId,
    members,
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plan: undefined as unknown as ProjectPlan,
  } as Project;
}

function storeOf(projects: Record<string, Project | null>): ProjectStoreLike & { load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(async (id: string) => projects[id] ?? null);
  return { load } as unknown as ProjectStoreLike & { load: ReturnType<typeof vi.fn> };
}

const ctx = (overrides: Partial<SessionOwnerCtx> = {}): SessionOwnerCtx => ({
  userId: 'u1',
  elevated: false,
  ...overrides,
});

describe('isSessionVisible (AD-089)', () => {
  it('elevated (ADMIN/LEAD) видит всё, даже без владельца/проекта', async () => {
    const store = storeOf({});
    expect(await isSessionVisible(session({ ownerId: 'someone', projectId: 'p1' }), store, ctx({ elevated: true }))).toBe(true);
    expect(store.load).not.toHaveBeenCalled();
  });

  it('владелец видит свою сессию (ownerId)', async () => {
    expect(await isSessionVisible(session({ ownerId: 'u1' }), undefined, ctx())).toBe(true);
  });

  it('владелец по userId (legacy, ownerId не задан)', async () => {
    expect(await isSessionVisible(session({ userId: 'u1' }), undefined, ctx())).toBe(true);
  });

  it('сессия без владельца видна всем (паритет с canAccess)', async () => {
    expect(await isSessionVisible(session({}), undefined, ctx({ userId: 'u2' }))).toBe(true);
  });

  it('чужая личная сессия (без проекта) не видна', async () => {
    expect(await isSessionVisible(session({ ownerId: 'u9' }), storeOf({}), ctx())).toBe(false);
  });

  it('чужая личная сессия не видна и при наличии projectStore', async () => {
    const store = storeOf({});
    expect(await isSessionVisible(session({ ownerId: 'u9' }), store, ctx())).toBe(false);
    expect(store.load).not.toHaveBeenCalled();
  });

  it('сессия проекта видна владельцу проекта', async () => {
    const store = storeOf({ p1: project('p1', 'u1', { u1: ProjectRole.OWNER }) });
    expect(await isSessionVisible(session({ ownerId: 'u9', projectId: 'p1' }), store, ctx())).toBe(true);
  });

  it('сессия проекта видна участнику проекта (любая роль, VIEWER)', async () => {
    const store = storeOf({ p1: project('p1', 'u9', { u1: ProjectRole.VIEWER }) });
    expect(await isSessionVisible(session({ ownerId: 'u9', projectId: 'p1' }), store, ctx())).toBe(true);
  });

  it('сессия чужого проекта не видна постороннему', async () => {
    const store = storeOf({ p1: project('p1', 'u9', { u8: ProjectRole.EDITOR }) });
    expect(await isSessionVisible(session({ ownerId: 'u9', projectId: 'p1' }), store, ctx())).toBe(false);
  });

  it('проект не найден → не видно (не роняем список)', async () => {
    const store = storeOf({});
    expect(await isSessionVisible(session({ ownerId: 'u9', projectId: 'missing' }), store, ctx())).toBe(false);
  });

  it('projectStore не задан и сессия проектная → не видно', async () => {
    expect(await isSessionVisible(session({ ownerId: 'u9', projectId: 'p1' }), undefined, ctx())).toBe(false);
  });

  it('кэш проектов: проект загружается один раз на несколько сессий', async () => {
    const store = storeOf({ p1: project('p1', 'u9', { u1: ProjectRole.EDITOR }) });
    const cache = new Map<string, Project | null>();
    const s1 = session({ id: 's1', ownerId: 'u9', projectId: 'p1' });
    const s2 = session({ id: 's2', ownerId: 'u9', projectId: 'p1' });
    expect(await isSessionVisible(s1, store, ctx(), cache)).toBe(true);
    expect(await isSessionVisible(s2, store, ctx(), cache)).toBe(true);
    expect(store.load).toHaveBeenCalledTimes(1);
  });
});
