/**
 * ADR-106 Ф1: тесты резолвера решений Authority-слоя.
 *
 * Проверяются правила из ADR-106 §«Резолвинг и решение»:
 * неизвестное действие/цель → `deny('unknown')`, явный запрет →
 * `deny('explicit')`, отсутствие гранта → `deny('no_grant')`, `ask`/`
 * requireConfirm` → `ask`, пересечение осей (каждая ось только сужает) и
 * одноразовое подтверждение носителем покрывающего гранта.
 */
import { describe, expect, it } from 'vitest';

import type {
  AuthorityGrant,
  AuthorityPolicy,
  AuthorityPrincipal,
  AuthorityTarget,
  AuthorityTurn,
} from '@itphx/synth-shared';

import { AuthorityResolver, computeAuthorityApprovalDigest } from './resolve.js';

function grant(over: Partial<AuthorityGrant> = {}): AuthorityGrant {
  return {
    action: 'read',
    targetPattern: 'path:**',
    effect: 'allow',
    ...over,
  };
}

function principal(over: Partial<AuthorityPrincipal> = {}): AuthorityPrincipal {
  return { kind: 'user', id: 'user:local', roles: [], ...over };
}

function turn(over: Partial<AuthorityTurn> = {}): AuthorityTurn {
  return {
    id: 'turn-1',
    sessionId: 'sess-1',
    principal: principal(),
    ceiling: [],
    startedAt: new Date().toISOString(),
    ...over,
  };
}

const pathTarget = (ref: string): AuthorityTarget => ({ kind: 'path', ref });

describe('AuthorityResolver', () => {
  describe('decide — неизвестные действие и цель', () => {
    it('неизвестное действие → deny(unknown)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'invoice' })],
      });

      const decision = resolver.decide(turn(), 'invoice', pathTarget('a.md'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('unknown');
    });

    it('неизвестный вид цели → deny(unknown)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ targetPattern: 'invoice:*' })],
      });

      const decision = resolver.decide(turn(), 'read', { kind: 'invoice', ref: '1' });
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('unknown');
    });

    it('действие, объявленное контентом, — известно', () => {
      const policy: AuthorityPolicy = {
        actions: [{ id: 'sign', mutating: true, requires: [] }],
        roles: [],
        targets: [{ kind: 'document' }],
        ceilings: [],
      };
      const resolver = new AuthorityResolver({
        policy,
        principalGrants: [grant({ action: 'sign', targetPattern: 'document:*' })],
      });

      const decision = resolver.decide(turn(), 'sign', { kind: 'document', ref: 'd1' });
      expect(decision.effect).toBe('allow');
    });
  });

  describe('decide — нет гранта', () => {
    it('грант есть только на чтение → запись → deny(no_grant)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'read' })],
      });

      const decision = resolver.decide(turn(), 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('no_grant');
    });

    it('у принципала нет грантов вовсе → deny(no_grant)', () => {
      const resolver = new AuthorityResolver();

      const decision = resolver.decide(turn(), 'read', pathTarget('a.ts'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('no_grant');
    });

    it('грант есть, но под другой вид цели → deny(no_grant)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ targetPattern: 'session:*' })],
      });

      const decision = resolver.decide(turn(), 'read', pathTarget('a.ts'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('no_grant');
    });
  });

  describe('decide — явный запрет', () => {
    it('deny-грант оси инстанца → deny(explicit)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'write' })],
        policy: {
          actions: [],
          roles: [],
          targets: [],
          ceilings: [
            {
              source: 'instance',
              grants: [grant({ action: 'write', effect: 'deny' })],
            },
          ],
        },
      });

      const decision = resolver.decide(turn(), 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('explicit');
      expect(decision.source).toBe('instance');
    });

    it('deny сильнее allow в другой оси', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'write', effect: 'allow' })],
        agentGrants: [grant({ action: 'write', effect: 'deny' })],
      });

      const decision = resolver.decide(turn({ agentId: 'agent-1' }), 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('explicit');
    });
  });

  describe('decide — пересечение осей', () => {
    it('каждая ось только сужает: потолок сессии режет область пользователя', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'write', targetPattern: 'path:**' })],
      });
      const withSessionCeiling = turn({
        ceiling: [
          {
            source: 'session',
            grants: [grant({ action: 'write', targetPattern: 'path:src/**' })],
          },
        ],
      });

      expect(resolver.decide(withSessionCeiling, 'write', pathTarget('src/a.ts')).effect).toBe(
        'allow',
      );
      const outside = resolver.decide(withSessionCeiling, 'write', pathTarget('docs/a.md'));
      expect(outside.effect).toBe('deny');
      expect(outside.reason).toBe('no_grant');
      expect(outside.source).toBe('session');
    });

    it('пустой потолок сессии запрещает всё (нет гранта — нет права)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'write' })],
      });
      const withEmptyCeiling = turn({ ceiling: [{ source: 'session', grants: [] }] });

      const decision = resolver.decide(withEmptyCeiling, 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('deny');
      expect(decision.reason).toBe('no_grant');
    });

    it('ось агента без объявленных прав не применима (не сужает)', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'write' })],
      });

      const decision = resolver.decide(turn({ agentId: 'agent-1' }), 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('allow');
    });

    it('роли принципала дают права из политики инстанса', () => {
      const resolver = new AuthorityResolver({
        policy: {
          actions: [],
          roles: [
            {
              id: 'developer',
              domain: 'base',
              grants: [grant({ action: 'write', targetPattern: 'path:src/**' })],
            },
          ],
          targets: [],
          ceilings: [],
        },
      });
      const asDeveloper = turn({ principal: principal({ roles: ['developer'] }) });

      expect(resolver.decide(asDeveloper, 'write', pathTarget('src/a.ts')).effect).toBe('allow');
      expect(resolver.decide(asDeveloper, 'write', pathTarget('docs/a.md')).effect).toBe('deny');
    });
  });

  describe('decide — ask', () => {
    it('ask-грант → ask', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [grant({ action: 'write', effect: 'ask' })],
      });

      const decision = resolver.decide(turn(), 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('ask');
    });

    it('allow с requireConfirm → ask', () => {
      const resolver = new AuthorityResolver({
        principalGrants: [
          grant({ action: 'write', constraints: { requireConfirm: true } }),
        ],
      });

      const decision = resolver.decide(turn(), 'write', pathTarget('a.ts'));
      expect(decision.effect).toBe('ask');
    });
  });

  describe('approve — одноразовое подтверждение носителем гранта', () => {
    const target = pathTarget('a.ts');
    const action = 'write';

    function approvalFor(over: Partial<{ turnId: string; digest: string }> = {}) {
      const turnId = over.turnId ?? 'turn-1';
      return {
        id: 'ap-1',
        turnId,
        principal: principal(),
        action,
        target,
        digest:
          over.digest ??
          computeAuthorityApprovalDigest({ turnId, action, target }),
        once: true,
      };
    }

    it('подтверждает носитель покрывающего гранта', () => {
      const resolver = new AuthorityResolver({
        principalGrantsById: {
          'user:lead': [grant({ action: 'write' })],
        },
      });

      const outcome = resolver.approve(approvalFor(), principal({ id: 'user:lead' }));
      expect(outcome.effect).toBe('allow');
      expect(outcome.reason).toBe('ok');
    });

    it('не подтверждает принципал без покрывающего гранта', () => {
      const resolver = new AuthorityResolver({
        principalGrantsById: {
          'user:lead': [grant({ action: 'write' })],
        },
      });

      const outcome = resolver.approve(approvalFor(), principal({ id: 'user:viewer' }));
      expect(outcome.effect).toBe('deny');
      expect(outcome.reason).toBe('no_grant');
    });

    it('подтверждение одноразовое: повтор → deny(already_consumed)', () => {
      const resolver = new AuthorityResolver({
        principalGrantsById: {
          'user:lead': [grant({ action: 'write' })],
        },
      });
      const approver = principal({ id: 'user:lead' });

      expect(resolver.approve(approvalFor(), approver).effect).toBe('allow');
      const second = resolver.approve(approvalFor(), approver);
      expect(second.effect).toBe('deny');
      expect(second.reason).toBe('already_consumed');
    });

    it('подтверждение чужого хода → deny(turn_mismatch)', () => {
      const resolver = new AuthorityResolver({
        principalGrantsById: {
          'user:lead': [grant({ action: 'write' })],
        },
      });

      const outcome = resolver.approve(approvalFor(), principal({ id: 'user:lead' }), {
        turn: turn({ id: 'turn-2' }),
      });
      expect(outcome.effect).toBe('deny');
      expect(outcome.reason).toBe('turn_mismatch');
    });

    it('подмена действия/цели ломает отпечаток → deny(digest_mismatch)', () => {
      const resolver = new AuthorityResolver({
        principalGrantsById: {
          'user:lead': [grant({ action: 'write' })],
        },
      });

      const outcome = resolver.approve(
        { ...approvalFor(), action: 'read' },
        principal({ id: 'user:lead' }),
      );
      expect(outcome.effect).toBe('deny');
      expect(outcome.reason).toBe('digest_mismatch');
    });
  });
});
