/**
 * PROP-108 Ф3: реестр подтверждений — привязка, одноразовость, fail-closed.
 *
 * Реестр — **единственное** место, где решается, можно ли принять ответ на
 * запрос подтверждения (`engine/permission/approval.ts`). Инварианты:
 *
 * 1. **одноразовость**: принятое подтверждение списывается; повторный ответ —
 *    отказ (`already_consumed`);
 * 2. **привязка к ходу**: ответ с чужим `turn_id`/`digest` — отказ;
 * 3. **носитель покрывающего гранта**: ответ без гранта — отказ (`no_grant`);
 * 4. **fail-closed**: без резолвера покрытия ни одно подтверждение не
 *    принимается.
 *
 * Отдельно проверяется инвариант PROP-098: инъекция (`steer`) в активный ход
 * **не создаёт новый ход** — `turnId` не меняется, привязка подтверждения
 * остаётся валидной.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MessageRole, nowISO, makeTextPart } from '@itphx/synth-shared';
import type { AuthorityPrincipal, AuthorityTarget, Message } from '@itphx/synth-shared';

import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { computeAuthorityApprovalDigest } from '../authority/resolve.js';
import { ApprovalRegistry } from './approval.js';

const TARGET: AuthorityTarget = { kind: 'path', ref: 'src/app.ts' };
const TURN_ID = 'turn_1';

const OWNER: AuthorityPrincipal = { kind: 'user', id: 'owner', roles: ['USER'] };
const STRANGER: AuthorityPrincipal = { kind: 'user', id: 'stranger', roles: ['USER'] };

/** Резолвер покрытия: покрывает только владелец сессии. */
const coverage = (sessionId: string, responder: AuthorityPrincipal): boolean =>
  responder.id === 'owner';

function makeRegistry(covered = coverage): ApprovalRegistry {
  return new ApprovalRegistry({ coverage: covered });
}

function openBinding(registry: ApprovalRegistry, approvalId = 'approval_1'): string {
  const digest = computeAuthorityApprovalDigest({ turnId: TURN_ID, action: 'write', target: TARGET });
  registry.open(approvalId, {
    principal: OWNER,
    turnId: TURN_ID,
    action: 'write',
    target: TARGET,
    digest,
  });
  return digest;
}

describe('PROP-108 Ф3: реестр подтверждений — привязка', () => {
  it('привязка (principal, turnId, action, target, digest) сохраняется в реестре', () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);
    const binding = registry.get('approval_1');
    expect(binding).toBeDefined();
    expect(binding?.principal).toEqual(OWNER);
    expect(binding?.turnId).toBe(TURN_ID);
    expect(binding?.action).toBe('write');
    expect(binding?.target).toEqual(TARGET);
    expect(binding?.digest).toBe(digest);
  });

  it('ответ носителя покрывающего гранта принимается и списывает привязку', async () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);
    const claim = await registry.claim('approval_1', 's1', OWNER, { turnId: TURN_ID, digest });
    expect(claim.ok).toBe(true);
    expect(claim.reason).toBe('ok');
    expect(registry.get('approval_1')).toBeUndefined();
  });
});

describe('PROP-108 Ф3: реестр подтверждений — отказы', () => {
  it('повторный ответ на тот же approval_id → deny (already_consumed)', async () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);
    const first = await registry.claim('approval_1', 's1', OWNER, { turnId: TURN_ID, digest });
    expect(first.ok).toBe(true);

    const second = await registry.claim('approval_1', 's1', OWNER, { turnId: TURN_ID, digest });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already_consumed');
  });

  it('ответ без покрывающего гранта → deny (no_grant), привязка остаётся', async () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);
    const claim = await registry.claim('approval_1', 's1', STRANGER, { turnId: TURN_ID, digest });
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('no_grant');
    // Грант не выдан — запрос НЕ списан: носитель гранта может ответить позже.
    expect(registry.get('approval_1')).toBeDefined();
    const ok = await registry.claim('approval_1', 's1', OWNER, { turnId: TURN_ID, digest });
    expect(ok.ok).toBe(true);
  });

  it('ответ с чужим turn_id → deny (turn_mismatch)', async () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);
    const claim = await registry.claim('approval_1', 's1', OWNER, { turnId: 'turn_other', digest });
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('turn_mismatch');
  });

  it('ответ с чужим digest → deny (digest_mismatch)', async () => {
    const registry = makeRegistry();
    openBinding(registry);
    const claim = await registry.claim('approval_1', 's1', OWNER, { turnId: TURN_ID, digest: 'deadbeef' });
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('digest_mismatch');
  });

  it('неизвестный approval_id → deny (unknown_approval)', async () => {
    const registry = makeRegistry();
    const claim = await registry.claim('approval_unknown', 's1', OWNER, {});
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('unknown_approval');
  });

  it('без резолвера покрытия — fail-closed (no_grant для всех)', async () => {
    const registry = new ApprovalRegistry();
    const digest = openBinding(registry);
    const claim = await registry.claim('approval_1', 's1', OWNER, { turnId: TURN_ID, digest });
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('no_grant');
  });
});

describe('PROP-098: инъекция (steer) не создаёт новый ход', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-approval-steer-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    const session = await sessionManager.createSession({ title: 'S', userId: 'owner', ownerId: 'owner' });
    // Активный ход: `turnId` хода = `streamId` (ADR-089/PROP-098).
    await sessionManager.withLock(session.id, async (s) => {
      s.currentStream = {
        streamId: TURN_ID,
        message: 'работаю',
        startedAt: nowISO(),
        cancelled: false,
      };
      await sessionManager.saveSession(s);
    });
    sessionId = session.id;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('инъекция не меняет turnId: привязка подтверждения остаётся валидной', async () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);

    // PROP-098: инъекция в активный ход (очередь `steerInbox`).
    const injected: Message = {
      id: 'msg_steer',
      role: MessageRole.USER,
      seq: 1,
      origin: 'local',
      parts: [makeTextPart('уточнение')],
      content: 'уточнение',
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
    };
    const steer = await sessionManager.enqueueSteerMessage(sessionId, injected);
    expect(steer.accepted).toBe(true);

    // Ход не сменился: `turnId` (streamId) прежний, поток не пересоздан.
    const session = await sessionManager.getSession(sessionId);
    expect(session?.currentStream?.streamId).toBe(TURN_ID);
    expect(session?.steerInbox?.length).toBe(1);

    // Привязка подтверждения по-прежнему валидна для того же хода.
    const claim = await registry.claim('approval_1', sessionId, OWNER, { turnId: TURN_ID, digest });
    expect(claim.ok).toBe(true);
    expect(claim.binding?.turnId).toBe(TURN_ID);
  });

  it('ответ с «нового» turn_id после инъекции → turn_mismatch (старый ход не переоткрывается)', async () => {
    const registry = makeRegistry();
    const digest = openBinding(registry);
    const claim = await registry.claim('approval_1', sessionId, OWNER, { turnId: 'turn_after_steer', digest });
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('turn_mismatch');
  });
});
