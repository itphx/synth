/**
 * ADR-106 Ф3: **матрица подтверждений** — кто может подтвердить действие.
 *
 * Инвариант (ADR-106 §«Многопользовательская сессия», §«Резолвинг и решение»):
 * ответ на запрос подтверждения принимает **носитель покрывающего гранта**, а не
 * «кто видит сессию». До Ф3 любой участник с правом чтения мог подтвердить
 * мутирующий тул — дыра «`VIEWER` подтверждает запись».
 *
 * Матрица построена по образцу `packages/backend/src/routes/session-idor-matrix.test.ts`
 * (инвариант 17): единая таблица «актор → ожидание», прогон по всем клеткам.
 *
 * Акторы:
 * - `owner` — владелец сессии;
 * - `editor` — участник проекта с ролью `EDITOR`;
 * - `viewer` — участник проекта с ролью `VIEWER` (читает, но не мутирует —
 *   инвариант 21);
 * - `projectOwner` — владелец проекта (не владелец сессии);
 * - `admin` / `lead` — глобальные роли инстанса (сквозной обзор);
 * - `auditor` — глобальная роль «только чтение»;
 * - `stranger` — посторонний пользователь;
 * - `serviceWriter` / `serviceReader` — service-key (ADR-052): покрытие
 *   определяется **своей ролью/скоупом** (роль политики инстанца → гранты),
 *   а не фактом «видит сессию».
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectRole } from '@itphx/synth-shared';
import type { AuthorityPolicy, AuthorityPrincipal, AuthorityTarget } from '@itphx/synth-shared';

import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { ApprovalRegistry } from '../permission/approval.js';
import { buildApprovalResponderProfile, coversApproval, createApprovalCoverageResolver } from './approval.js';
import { computeAuthorityApprovalDigest } from './resolve.js';

// ---------------------------------------------------------------------------
// Акторы и ожидания
// ---------------------------------------------------------------------------

type Actor =
  | 'owner'
  | 'editor'
  | 'viewer'
  | 'projectOwner'
  | 'admin'
  | 'lead'
  | 'auditor'
  | 'stranger'
  | 'serviceWriter'
  | 'serviceReader';

const ALL_ACTORS: Actor[] = [
  'owner',
  'editor',
  'viewer',
  'projectOwner',
  'admin',
  'lead',
  'auditor',
  'stranger',
  'serviceWriter',
  'serviceReader',
];

/** Глобальные роли инстанса, предъявляемые принципалом. */
const INSTANCE_ROLES: Record<string, string[]> = {
  admin: ['ADMIN'],
  lead: ['LEAD'],
  auditor: ['AUDITOR'],
};

/** Принципал актора (то, что предъявляет носитель). */
function principalOf(actor: Actor): AuthorityPrincipal {
  if (actor === 'serviceWriter') return { kind: 'service', id: 'service:key-writer', roles: ['svc-writer'] };
  if (actor === 'serviceReader') return { kind: 'service', id: 'service:key-reader', roles: ['svc-reader'] };
  return { kind: 'user', id: actor, roles: INSTANCE_ROLES[actor] ?? ['USER'] };
}

/**
 * Матрица покрытия для **мутирующего** действия (`write`).
 *
 * Подтверждают: владелец сессии, `EDITOR`/`OWNER` проекта, `ADMIN`/`LEAD`,
 * service-key с ролью, дающей грант на запись.
 * Не подтверждают: `VIEWER` (read не расширяет права на изменение —
 * инвариант 21), `AUDITOR` (только чтение), посторонний, service-key без
 * подходящей роли.
 */
const WRITE_COVERAGE: Record<Actor, boolean> = {
  owner: true,
  editor: true,
  viewer: false,
  projectOwner: true,
  admin: true,
  lead: true,
  auditor: false,
  stranger: false,
  serviceWriter: true,
  serviceReader: false,
};

/**
 * Матрица покрытия для **чтения** (`read`).
 *
 * `VIEWER` и `AUDITOR` читают — значит, могут подтвердить и чтение.
 * Service-key — по своей роли: `svc-reader` читает, `svc-writer` (грант только
 * на запись) — нет.
 */
const READ_COVERAGE: Record<Actor, boolean> = {
  owner: true,
  editor: true,
  viewer: true,
  projectOwner: true,
  admin: true,
  lead: true,
  auditor: true,
  stranger: false,
  serviceWriter: false,
  serviceReader: true,
};

// ---------------------------------------------------------------------------
// Песочница: сессия владельца `owner` в проекте с участниками
// ---------------------------------------------------------------------------

const WRITE_TARGET: AuthorityTarget = { kind: 'path', ref: 'src/app.ts' };
const READ_TARGET: AuthorityTarget = { kind: 'path', ref: 'src/app.ts' };

/**
 * Политика инстанса: роли service-key (доменные роли из контента — ADR-106
 * §«Доменная нейтральность»). `svc-writer` пишет, `svc-reader` читает.
 */
const POLICY: AuthorityPolicy = {
  actions: [],
  roles: [
    {
      id: 'svc-writer',
      domain: 'test',
      grants: [{ action: 'write', targetPattern: 'path:**', effect: 'allow' }],
    },
    {
      id: 'svc-reader',
      domain: 'test',
      grants: [{ action: 'read', targetPattern: 'path:**', effect: 'allow' }],
    },
  ],
  targets: [],
  ceilings: [],
};

interface World {
  sessionManager: SessionManager;
  projectStore: ProjectStore;
  sessionId: string;
  projectId: string;
  registry: ApprovalRegistry;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'synth-authority-approval-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function buildWorld(): Promise<World> {
  const sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
  const projectStore = new ProjectStore({ dataDir: tmpDir });

  // Проект: владелец `projectOwner`, участники `viewer` (VIEWER) и `editor` (EDITOR).
  const project = projectStore.create('Shared', 'projectOwner');
  project.members['viewer'] = ProjectRole.VIEWER;
  project.members['editor'] = ProjectRole.EDITOR;
  await projectStore.save(project);

  const session = await sessionManager.createSession({
    title: 'S',
    userId: 'owner',
    ownerId: 'owner',
    projectId: project.id,
  });

  // Реестр подтверждений — резолвер профиля ровно как в проде
  // (`server/app/deps.ts`): сессия + проект сессии, роли — из принципала.
  const registry = new ApprovalRegistry({
    coverage: createApprovalCoverageResolver({
      policy: POLICY,
      profile: async (sessionId, principal) => {
        const s = await sessionManager.getSession(sessionId);
        const p = s?.projectId ? await projectStore.load(s.projectId) : null;
        return buildApprovalResponderProfile({ principal, sources: { session: s, project: p } });
      },
    }),
  });

  return { sessionManager, projectStore, sessionId: session.id, projectId: project.id, registry };
}

/** Зарегистрировать привязку подтверждения и попытаться её подтвердить. */
async function tryClaim(
  world: World,
  actor: Actor,
  action: 'read' | 'write',
): Promise<{ ok: boolean; reason: string }> {
  const approvalId = `approval_${actor}_${action}`;
  const turnId = 'turn_1';
  const target = action === 'write' ? WRITE_TARGET : READ_TARGET;
  const digest = computeAuthorityApprovalDigest({ turnId, action, target });
  world.registry.open(approvalId, {
    principal: { kind: 'user', id: 'owner', roles: [] },
    turnId,
    action,
    target,
    digest,
  });
  const claim = await world.registry.claim(approvalId, world.sessionId, principalOf(actor), {
    turnId,
    digest,
  });
  return { ok: claim.ok, reason: claim.reason };
}

// ---------------------------------------------------------------------------
// 1. Матрица подтверждений
// ---------------------------------------------------------------------------

describe('ADR-106 Ф3: матрица подтверждений (мутирующее действие)', () => {
  it('VIEWER не подтверждает мутирующий тул (read не расширяет права на изменение)', async () => {
    const world = await buildWorld();
    const claim = await tryClaim(world, 'viewer', 'write');
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('no_grant');
  });

  it('владелец / EDITOR / OWNER проекта / ADMIN / LEAD — подтверждают', async () => {
    const world = await buildWorld();
    for (const actor of ['owner', 'editor', 'projectOwner', 'admin', 'lead'] as Actor[]) {
      const claim = await tryClaim(world, actor, 'write');
      expect(claim.ok, actor).toBe(true);
      expect(claim.reason, actor).toBe('ok');
    }
  });

  it('AUDITOR и посторонний — не подтверждают', async () => {
    const world = await buildWorld();
    for (const actor of ['auditor', 'stranger'] as Actor[]) {
      const claim = await tryClaim(world, actor, 'write');
      expect(claim.ok, actor).toBe(false);
      expect(claim.reason, actor).toBe('no_grant');
    }
  });

  it('service-key подтверждает по своей роли (скоупу), а не по факту видимости', async () => {
    const world = await buildWorld();
    // Роль `svc-writer` даёт грант на запись → подтверждает.
    expect((await tryClaim(world, 'serviceWriter', 'write')).ok).toBe(true);
    // Роль `svc-reader` — только чтение → запись не подтверждает.
    const reader = await tryClaim(world, 'serviceReader', 'write');
    expect(reader.ok).toBe(false);
    expect(reader.reason).toBe('no_grant');
  });

  it('полная матрица: ожидание по каждому актору (write)', async () => {
    const world = await buildWorld();
    for (const actor of ALL_ACTORS) {
      const claim = await tryClaim(world, actor, 'write');
      expect(claim.ok, `${actor} → write`).toBe(WRITE_COVERAGE[actor]);
    }
  });

  it('полная матрица: ожидание по каждому актору (read)', async () => {
    const world = await buildWorld();
    for (const actor of ALL_ACTORS) {
      const claim = await tryClaim(world, actor, 'read');
      expect(claim.ok, `${actor} → read`).toBe(READ_COVERAGE[actor]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Профиль носителя: как считается покрытие
// ---------------------------------------------------------------------------

describe('ADR-106 Ф3: профиль носителя подтверждения', () => {
  it('владелец сессии — sessionOwner, роли проекта — по роли в проекте', async () => {
    const world = await buildWorld();
    const session = await world.sessionManager.getSession(world.sessionId);

    const owner = buildApprovalResponderProfile({
      principal: principalOf('owner'),
      sources: { session, project: await world.projectStore.load(world.projectId) },
    });
    expect(owner.sessionOwner).toBe(true);

    const viewer = buildApprovalResponderProfile({
      principal: principalOf('viewer'),
      sources: { session, project: await world.projectStore.load(world.projectId) },
    });
    expect(viewer.projectRole).toBe('viewer');
    expect(viewer.sessionOwner).toBeUndefined();

    const projectOwner = buildApprovalResponderProfile({
      principal: principalOf('projectOwner'),
      sources: { session, project: await world.projectStore.load(world.projectId) },
    });
    expect(projectOwner.projectRole).toBe('owner');

    const stranger = buildApprovalResponderProfile({
      principal: principalOf('stranger'),
      sources: { session, project: await world.projectStore.load(world.projectId) },
    });
    expect(stranger.projectRole).toBeUndefined();
    expect(stranger.sessionOwner).toBeUndefined();
  });

  it('покрытие — по паре «действие × цель»: грант на другой вид цели не покрывает', () => {
    // Носитель с узким грантом (роль `svc-writer` → `write` по `path:**`).
    const profile = buildApprovalResponderProfile({ principal: principalOf('serviceWriter') });
    const binding = {
      principal: principalOf('serviceWriter'),
      turnId: 'turn_1',
      action: 'write',
      target: WRITE_TARGET,
      digest: 'd',
    };
    // `path:**` покрывает цель вида `path`.
    expect(coversApproval(profile, binding, POLICY), 'грант на path покрывает path').toBe(true);
    // Цель другого вида (`session:`) — не покрыта грантом на `path:`.
    expect(
      coversApproval(profile, { ...binding, target: { kind: 'session', ref: 's1' } }, POLICY),
      'грант на path не покрывает session',
    ).toBe(false);
    // Другое действие (`read`) грантом на запись не покрыто.
    expect(
      coversApproval(profile, { ...binding, action: 'read' }, POLICY),
      'грант на write не покрывает read',
    ).toBe(false);
  });

  it('роль политики инстанца даёт гранты только своему service-key', async () => {
    const writer = buildApprovalResponderProfile({ principal: principalOf('serviceWriter') });
    const reader = buildApprovalResponderProfile({ principal: principalOf('serviceReader') });
    const binding = {
      principal: principalOf('serviceWriter'),
      turnId: 'turn_1',
      action: 'write' as const,
      target: WRITE_TARGET,
      digest: 'd',
    };
    expect(coversApproval(writer, binding, POLICY)).toBe(true);
    expect(coversApproval(reader, binding, POLICY)).toBe(false);
  });
});
