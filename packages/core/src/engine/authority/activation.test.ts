/**
 * ADR-106 Ф5: тесты активации контента полномочий пакета в политику инстанца.
 *
 * Проверяются три правила из ADR-106 §«Правила безопасности контента»:
 * 1. **Пересечение, а не дарование** — грант пакета действует только там, где
 *    политика инстанца его разрешает; явный `deny` инстанца сильнее.
 * 2. **Trust-floor** — мутирующие гранты не активируются при доверии ниже
 *    `trusted` (PROP-068 §4.1); `community` получает только чтение.
 * 3. **Политика — источник истины** — роль, уже объявленная в политике
 *    инстанца, контентом пакета **не перезаписывается**.
 *
 * Плюс снятие контента (удаление пакета) — идемпотентно и не трогает роли,
 * которые приносит другой установленный пакет.
 */
import { describe, expect, it } from 'vitest';

import type {
  AuthorityAction,
  AuthorityPolicy,
  AuthorityRole,
  AuthorityTargetDeclaration,
} from '@itphx/synth-shared';

import {
  activatePackAuthority,
  deactivatePackAuthority,
  type PackAuthorityContent,
} from './activation.js';

/** Политика инстанца без ограничений (ось инстанца не применима). */
function emptyPolicy(over: Partial<AuthorityPolicy> = {}): AuthorityPolicy {
  return { actions: [], roles: [], targets: [], ceilings: [], agents: [], ...over };
}

/** Контент пакета: роль + действие + вид цели + агент. */
function content(over: Partial<PackAuthorityContent> = {}): PackAuthorityContent {
  return {
    actions: [{ id: 'read', mutating: false, requires: [] }] as AuthorityAction[],
    roles: [
      {
        id: 'clinician',
        domain: 'clinic',
        grants: [{ action: 'read', targetPattern: 'record:*', effect: 'allow' }],
      },
    ] as AuthorityRole[],
    targets: [{ kind: 'record', resolver: 'record-resolver' }] as AuthorityTargetDeclaration[],
    agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['read'] }],
    ...over,
  };
}

/** Роль пакета с одним грантом. */
function role(id: string, grant: AuthorityRole['grants'][number]): AuthorityRole {
  return { id, domain: 'test', grants: [grant] };
}

describe('activatePackAuthority (ADR-106 Ф5) — активация контента пакета', () => {
  describe('пересечение с потолком инстанца', () => {
    it('грант пакета сохраняется, если потолок инстанца его разрешает', () => {
      const policy = emptyPolicy({
        ceilings: [
          {
            source: 'instance',
            grants: [{ action: 'read', targetPattern: 'record:**', effect: 'allow' }],
          },
        ],
      });

      const result = activatePackAuthority({ content: content(), policy, trustLevel: 'trusted' });

      expect(result.activated.roles).toEqual(['clinician']);
      expect(result.policy.roles[0]?.grants).toEqual([
        { action: 'read', targetPattern: 'record:*', effect: 'allow' },
      ]);
      expect(result.skipped).toHaveLength(0);
    });

    it('deny инстанца сильнее: грант пакета отбрасывается, роль остаётся без него', () => {
      const policy = emptyPolicy({
        ceilings: [
          {
            source: 'instance',
            grants: [{ action: 'read', targetPattern: 'record:**', effect: 'deny' }],
          },
        ],
      });

      const result = activatePackAuthority({ content: content(), policy, trustLevel: 'trusted' });

      // Роль объявлена (пакет её принёс), но грант не активирован.
      expect(result.activated.roles).toEqual(['clinician']);
      expect(result.policy.roles[0]?.grants).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: 'grant', id: 'read', reason: 'instance_deny' }),
      );
    });

    it('область, которую инстанс не разрешает, пакетом не разрешается', () => {
      const policy = emptyPolicy({
        ceilings: [
          {
            source: 'instance',
            grants: [{ action: 'read', targetPattern: 'path:**', effect: 'allow' }],
          },
        ],
      });

      const result = activatePackAuthority({ content: content(), policy, trustLevel: 'trusted' });

      expect(result.policy.roles[0]?.grants).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: 'grant', id: 'read', reason: 'instance_not_allowed' }),
      );
    });

    it('потолок инстанца не шире потолка пакета: содержимое не может расширять потолок', () => {
      const policy = emptyPolicy({
        ceilings: [
          {
            source: 'instance',
            grants: [{ action: 'read', targetPattern: 'record:one', effect: 'allow' }],
          },
        ],
      });

      const result = activatePackAuthority({ content: content(), policy, trustLevel: 'trusted' });

      expect(result.policy.roles[0]?.grants).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: 'grant', id: 'read', reason: 'instance_not_allowed' }),
      );
    });

    it('без потолка инстанца ограничений нет (ось не применима)', () => {
      const result = activatePackAuthority({
        content: content(),
        policy: emptyPolicy(),
        trustLevel: 'trusted',
      });

      expect(result.policy.roles[0]?.grants).toHaveLength(1);
      expect(result.skipped).toHaveLength(0);
    });
  });

  describe('trust-floor (PROP-068 §4.1)', () => {
    const mutatingContent = content({
      roles: [
        role('writer', { action: 'write', targetPattern: 'path:**', effect: 'allow' }),
        role('reader', { action: 'read', targetPattern: 'path:**', effect: 'allow' }),
      ],
    });

    it('community: мутирующий грант не активируется, роль без него', () => {
      const result = activatePackAuthority({
        content: mutatingContent,
        policy: null,
        trustLevel: 'community',
      });

      const writer = result.policy.roles.find((r) => r.id === 'writer');
      expect(writer?.grants).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: 'grant', id: 'write', reason: 'trust_floor' }),
      );
    });

    it('community: грант чтения активируется', () => {
      const result = activatePackAuthority({
        content: mutatingContent,
        policy: null,
        trustLevel: 'community',
      });

      const reader = result.policy.roles.find((r) => r.id === 'reader');
      expect(reader?.grants).toEqual([
        { action: 'read', targetPattern: 'path:**', effect: 'allow' },
      ]);
    });

    it('trusted: мутирующий грант активируется', () => {
      const result = activatePackAuthority({
        content: mutatingContent,
        policy: null,
        trustLevel: 'trusted',
      });

      const writer = result.policy.roles.find((r) => r.id === 'writer');
      expect(writer?.grants).toEqual([
        { action: 'write', targetPattern: 'path:**', effect: 'allow' },
      ]);
    });
  });

  describe('роль из политики не перезаписывается', () => {
    it('существующая роль остаётся, роль пакета — skipped(role_exists)', () => {
      const policy = emptyPolicy({
        roles: [
          {
            id: 'clinician',
            domain: 'core',
            grants: [{ action: 'read', targetPattern: 'core:**', effect: 'allow' }],
          },
        ],
      });

      const result = activatePackAuthority({ content: content(), policy, trustLevel: 'trusted' });

      expect(result.policy.roles).toHaveLength(1);
      expect(result.policy.roles[0]?.domain).toBe('core');
      expect(result.policy.roles[0]?.grants).toEqual([
        { action: 'read', targetPattern: 'core:**', effect: 'allow' },
      ]);
      expect(result.activated.roles).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: 'role', id: 'clinician', reason: 'role_exists' }),
      );
    });
  });

  describe('привязки агентов', () => {
    it('агент с неизвестной ролью — skipped(unknown_role)', () => {
      const result = activatePackAuthority({
        content: content({ agents: [{ id: 'doctor', roles: ['nope'], ceiling: [] }] }),
        policy: null,
        trustLevel: 'trusted',
      });

      expect(result.activated.agents).toEqual([]);
      expect(result.policy.agents).toEqual([]);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ kind: 'agent', id: 'doctor', reason: 'unknown_role' }),
      );
    });

    it('агент с известной ролью попадает в политику (роли + потолок)', () => {
      const result = activatePackAuthority({
        content: content(),
        policy: null,
        trustLevel: 'trusted',
      });

      expect(result.activated.agents).toEqual(['doctor']);
      expect(result.policy.agents).toEqual([
        { id: 'doctor', roles: ['clinician'], ceiling: ['read'] },
      ]);
    });
  });
});

describe('deactivatePackAuthority (ADR-106 Ф5) — снятие контента пакета', () => {
  const packContent = content({
    roles: [
      role('clinician', { action: 'read', targetPattern: 'record:*', effect: 'allow' }),
    ],
  });

  it('снятие убирает принесённую роль и привязку агента', () => {
    const policy = emptyPolicy({
      roles: packContent.roles as AuthorityRole[],
      agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['read'] }],
    });

    const result = deactivatePackAuthority({ content: packContent, policy });

    expect(result.removedRoles).toEqual(['clinician']);
    expect(result.removedAgents).toEqual(['doctor']);
    expect(result.policy.roles).toEqual([]);
    expect(result.policy.agents).toEqual([]);
  });

  it('снятие идемпотентно: повтор ничего не убирает', () => {
    const policy = emptyPolicy({
      roles: packContent.roles as AuthorityRole[],
      agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['read'] }],
    });

    const first = deactivatePackAuthority({ content: packContent, policy });
    const second = deactivatePackAuthority({ content: packContent, policy: first.policy });

    expect(first.removedRoles).toEqual(['clinician']);
    expect(second.removedRoles).toEqual([]);
    expect(second.removedAgents).toEqual([]);
    expect(second.policy.roles).toEqual([]);
    expect(second.policy.agents).toEqual([]);
  });

  it('роль, которую приносит другой пакет, остаётся', () => {
    const policy = emptyPolicy({
      roles: packContent.roles as AuthorityRole[],
      agents: [{ id: 'doctor', roles: ['clinician'], ceiling: ['read'] }],
    });

    const result = deactivatePackAuthority({
      content: packContent,
      policy,
      keepRoleIds: ['clinician'],
      keepAgentIds: ['doctor'],
    });

    expect(result.removedRoles).toEqual([]);
    expect(result.removedAgents).toEqual([]);
    expect(result.policy.roles).toHaveLength(1);
    expect(result.policy.agents).toHaveLength(1);
  });

  it('объявления действий и видов целей остаются (они не дают прав)', () => {
    const policy = emptyPolicy({
      roles: packContent.roles as AuthorityRole[],
    });

    const result = deactivatePackAuthority({ content: packContent, policy });

    expect(result.policy.actions).toEqual([]);
    expect(result.policy.targets).toEqual([]);
  });
});
