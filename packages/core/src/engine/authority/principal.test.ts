/**
 * ADR-140 Ф2: принципал хода несёт **снимок групп** пользователя.
 *
 * Группы — это claim IdP (`groups`), зафиксированный **при приёме ввода**
 * вместе с принципалом (ADR-106 Ф4): дальше они не пересчитываются, иначе
 * грант по группе мог бы «поехать» между ходами.
 *
 * Проверяются инварианты:
 * - `resolveUserPrincipal` кладёт группы в принципал (и не мутирует входные
 *   массивы);
 * - старое сохранённое сообщение без поля `groups` нормализуется в «групп нет»
 *   (fail-closed) — иначе снимок групп был бы потерян, а гранты по группам —
 *   не применились бы;
 * - принципал владельца сессии (fallback) — тоже без групп.
 */
import { describe, expect, it } from 'vitest';
import { MessageRole, type AuthorityPrincipal, type Message, type Session } from '@itphx/synth-shared';

import {
  parsePrincipalRef,
  resolveTurnPrincipal,
  resolveUserPrincipal,
  sessionOwnerPrincipal,
  userPrincipal,
} from './principal.js';

/** Сессия с владельцем `local`. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    sessionOrigin: 'direct',
    ownerId: 'local',
    ...overrides,
  } as Session;
}

/** Сообщение с заданным принципалом (как сохраняется в истории). */
function makeMessage(principal?: AuthorityPrincipal): Message {
  return {
    id: 'm1',
    role: MessageRole.USER,
    seq: 1,
    origin: 'local',
    parts: [],
    content: 'привет',
    createdAt: '2026-01-01T00:00:00.000Z',
    disabled: false,
    pinned: false,
    hidden: false,
    ...(principal ? { principal } : {}),
  } as Message;
}

describe('ADR-140 Ф2: принципал хода — снимок групп', () => {
  it('resolveUserPrincipal кладёт группы в принципал', () => {
    const principal = resolveUserPrincipal('u1', ['USER'], ['team']);

    expect(principal).toEqual({
      kind: 'user',
      id: 'u1',
      roles: ['USER'],
      groups: ['team'],
    });
  });

  it('resolveUserPrincipal без групп → groups: [] (групп нет, fail-closed)', () => {
    const principal = resolveUserPrincipal('u1', ['USER']);

    expect(principal?.groups).toEqual([]);
  });

  it('resolveUserPrincipal без пользователя → undefined (принципал не задан)', () => {
    expect(resolveUserPrincipal(undefined, ['USER'], ['team'])).toBeUndefined();
    expect(resolveUserPrincipal(null, ['USER'], ['team'])).toBeUndefined();
    expect(resolveUserPrincipal('', ['USER'], ['team'])).toBeUndefined();
  });

  it('машинный доступ (`service:`) — отдельный вид, группы не теряются', () => {
    const principal = resolveUserPrincipal('service:key-1', ['USER'], ['team']);

    expect(principal).toEqual({
      kind: 'service',
      id: 'key-1',
      roles: ['USER'],
      groups: ['team'],
    });
  });

  it('массивы ролей и групп копируются (вход не мутируется)', () => {
    const roles = ['USER'];
    const groups = ['team'];

    const principal = userPrincipal('u1', roles, groups);
    roles.push('ADMIN');
    groups.push('other');

    expect(principal.roles).toEqual(['USER']);
    expect(principal.groups).toEqual(['team']);
  });

  it('resolveTurnPrincipal: старое сообщение без `groups` → groups: [] (fail-closed)', () => {
    const message = makeMessage({ kind: 'user', id: 'u1', roles: ['USER'] });

    const principal = resolveTurnPrincipal(makeSession(), message);

    expect(principal.groups).toEqual([]);
    expect(principal.id).toBe('u1');
    expect(principal.roles).toEqual(['USER']);
  });

  it('resolveTurnPrincipal: снимок групп сообщения сохраняется', () => {
    const message = makeMessage({
      kind: 'user',
      id: 'u1',
      roles: [],
      groups: ['team-a', 'sre'],
    });

    const principal = resolveTurnPrincipal(makeSession(), message);

    expect(principal.groups).toEqual(['team-a', 'sre']);
  });

  it('resolveTurnPrincipal без сообщения → владелец сессии, групп нет', () => {
    const principal = resolveTurnPrincipal(makeSession(), null);

    expect(principal.kind).toBe('user');
    expect(principal.id).toBe('local');
    expect(principal.groups).toEqual([]);
  });

  it('sessionOwnerPrincipal и parsePrincipalRef — группы пустые', () => {
    expect(sessionOwnerPrincipal(makeSession()).groups).toEqual([]);
    expect(parsePrincipalRef('user:u1')?.groups).toEqual([]);
  });
});
