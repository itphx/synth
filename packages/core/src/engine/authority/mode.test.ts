/**
 * ADR-106 Ф4 (шаг C): режим сессии как потолок.
 *
 * Проверяются инварианты шага C:
 * - **режим — свойство принципала хода**: переопределение (`modeByPrincipal`)
 *   действует только на ходы своего принципала; чужие ходы — базовый режим
 *   сессии;
 * - **`yolo` не снимает `ask` потолка**: требование потолка (выход за рабочий
 *   каталог, роль `viewer`) остаётся `ask`/`deny` даже в режиме `yolo`
 *   (enforced-режим Authority-слоя);
 * - **смена режима не поднимает потолок**: базовый `session.mode` при
 *   per-principal смене не меняется;
 * - **прежнее поведение**: без участников (или с одним) режим меняется для
 *   сессии; `plan`/`act` работают как раньше.
 */
import { describe, expect, it } from 'vitest';

import type { PermissionConfig, Session, SessionParticipant } from '@itphx/synth-shared';

import { PermissionEvaluator } from '../permission/evaluator.js';
import { AuthorityGuard } from './guard.js';
import type { AuthorityTurnContext } from './turn.js';
import {
  applySessionMode,
  decideSessionModeScope,
  resolveTurnMode,
} from './mode.js';

const CWD = '/workspace/project';

/** Правила сессии: всё разрешено — `ask` даёт только потолок/роль. */
const ALLOW_ALL: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 30_000 };

/** Правила с подтверждением на запись — `yolo` снимает `ask` оси «пользователь». */
const ASK_WRITE: PermissionConfig = { rules: { '*': 'allow', write_file: 'ask' }, askTimeoutMs: 30_000 };

const PARTICIPANTS: SessionParticipant[] = [
  { userId: 'owner-1', role: 'owner' },
  { userId: 'editor-1', role: 'editor' },
  { userId: 'viewer-1', role: 'viewer' },
];

/** Сессия с базовым режимом и переопределениями по принципалу. */
function makeSession(overrides: {
  mode?: Session['mode'];
  modeByPrincipal?: Record<string, 'plan' | 'act' | 'yolo'>;
} = {}): Session {
  return {
    id: 's1',
    sessionOrigin: 'user',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {} as Session['settings'],
    ...(overrides.mode ? { mode: overrides.mode } : {}),
    ...(overrides.modeByPrincipal ? { modeByPrincipal: overrides.modeByPrincipal } : {}),
  } as unknown as Session;
}

/** Решение permission-слоя для `write_file` в режиме принципала. */
function checkWrite(
  session: Session,
  principalId: string,
  evaluator: PermissionEvaluator,
  turnContext?: AuthorityTurnContext,
): { action: string } {
  const principal = { kind: 'user' as const, id: principalId, roles: [] };
  return evaluator.check({
    toolName: 'write_file',
    params: { file_path: 'src/a.ts', content: 'x' },
    workingDir: CWD,
    sessionMode: resolveTurnMode(session, principal),
    authorityContext: {
      sessionId: session.id,
      principal,
      turnId: 'turn-1',
      ...(turnContext ? { turnContext } : {}),
    },
  });
}

describe('ADR-106 Ф4 (шаг C) — режим по принципалу', () => {
  it('переопределение режима действует только на ходы своего принципала', () => {
    const session = makeSession({ mode: 'act', modeByPrincipal: { 'editor-1': 'yolo' } });

    expect(resolveTurnMode(session, { kind: 'user', id: 'editor-1', roles: [] })).toBe('yolo');
    // У остальных участников — базовый режим сессии.
    expect(resolveTurnMode(session, { kind: 'user', id: 'owner-1', roles: [] })).toBe('act');
    expect(resolveTurnMode(session, { kind: 'user', id: 'viewer-1', roles: [] })).toBe('act');
    // Машинные принципалы — от своих осей прав, не от режима участника.
    expect(resolveTurnMode(session, { kind: 'service', id: 'editor-1', roles: [] })).toBe('act');
    // Без принципала — базовый режим (прежнее поведение).
    expect(resolveTurnMode(session, undefined)).toBe('act');
  });

  it('yolo одного участника не снимает ask у другого (permission-слой)', () => {
    const session = makeSession({ mode: 'act', modeByPrincipal: { 'editor-1': 'yolo' } });
    const evaluator = new PermissionEvaluator(ASK_WRITE);

    // `editor-1` в yolo: его `ask` снимается (ось «пользователь»).
    expect(checkWrite(session, 'editor-1', evaluator).action).toBe('allow');
    // `owner-1` — базовый режим: `ask` остаётся (смена режима одним участником
    // не меняет решения для ходов другого).
    expect(checkWrite(session, 'owner-1', evaluator).action).toBe('ask');
    expect(checkWrite(session, 'viewer-1', evaluator).action).toBe('ask');
  });

  it('yolo не снимает ask потолка (выход за рабочий каталог)', async () => {
    const guard = new AuthorityGuard({ enabled: true, shadow: false });
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });
    const session = makeSession({ mode: 'act', modeByPrincipal: { 'editor-1': 'yolo' } });
    const principal = { kind: 'user' as const, id: 'editor-1', roles: [] };

    const decision = evaluator.check({
      toolName: 'read_file',
      params: { file_path: '/etc/hosts' },
      workingDir: CWD,
      sessionMode: resolveTurnMode(session, principal),
      authorityContext: { sessionId: session.id, principal, turnId: 'turn-1' },
    });
    await guard.flush();

    // Потолок требует подтверждения — `yolo` его не снимает.
    expect(decision.action).toBe('ask');
  });

  it('yolo не поднимает потолок роли viewer', async () => {
    const guard = new AuthorityGuard({ enabled: true, shadow: false });
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });
    const session = makeSession({ mode: 'act', modeByPrincipal: { 'viewer-1': 'yolo' } });
    const principal = { kind: 'user' as const, id: 'viewer-1', roles: [] };

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: resolveTurnMode(session, principal),
      authorityContext: {
        sessionId: session.id,
        principal,
        turnId: 'turn-1',
        turnContext: {
          id: 'turn-1',
          sessionId: session.id,
          principal,
          participants: PARTICIPANTS,
          participantRole: 'viewer',
          startedAt: new Date().toISOString(),
        },
      },
    });
    await guard.flush();

    expect(decision.action).toBe('deny');
  });

  it('область режима: одиночная сессия — режим сессии, многопользовательская — принципала', () => {
    // Без участников — прежнее поведение (режим для сессии).
    expect(decideSessionModeScope({ participants: [], userId: 'local' })).toEqual({
      allowed: true,
      scope: { kind: 'session' },
    });
    // Один участник (standalone `local`, личная сессия) — тоже режим сессии.
    expect(
      decideSessionModeScope({ participants: [{ userId: 'local', role: 'owner' }], userId: 'local' }),
    ).toEqual({ allowed: true, scope: { kind: 'session' } });

    // Несколько участников — режим только того, кто его выставил.
    expect(decideSessionModeScope({ participants: PARTICIPANTS, userId: 'editor-1' })).toEqual({
      allowed: true,
      scope: { kind: 'principal', userId: 'editor-1' },
    });
    expect(decideSessionModeScope({ participants: PARTICIPANTS, userId: 'owner-1' })).toEqual({
      allowed: true,
      scope: { kind: 'principal', userId: 'owner-1' },
    });
    // `viewer` — не может (право чтения не расширяет права на изменение).
    expect(decideSessionModeScope({ participants: PARTICIPANTS, userId: 'viewer-1' })).toEqual({
      allowed: false,
      reason: 'read_only',
    });
    // Не участник — не может (fail-closed).
    expect(decideSessionModeScope({ participants: PARTICIPANTS, userId: 'stranger' })).toEqual({
      allowed: false,
      reason: 'not_participant',
    });
    // Сквозной доступ (ADMIN/LEAD) — режим сессии (их доступ к чужим сессиям
    // — осознанное решение, матрица IDOR).
    expect(
      decideSessionModeScope({ participants: PARTICIPANTS, userId: 'admin', elevated: true }),
    ).toEqual({ allowed: true, scope: { kind: 'session' } });
  });

  it('смена режима одним участником не меняет базовый режим сессии', () => {
    const session = makeSession({ mode: 'act' });

    applySessionMode(session, 'yolo', { kind: 'principal', userId: 'editor-1' });

    // Базовый режим сессии не тронут — чужие ходы не меняются.
    expect(session.mode).toBe('act');
    expect(session.modeByPrincipal).toEqual({ 'editor-1': 'yolo' });
    expect(resolveTurnMode(session, { kind: 'user', id: 'editor-1', roles: [] })).toBe('yolo');
    expect(resolveTurnMode(session, { kind: 'user', id: 'owner-1', roles: [] })).toBe('act');
  });

  it('область session — прежнее поведение (режим меняется для сессии)', () => {
    const session = makeSession({ mode: 'act' });

    applySessionMode(session, 'plan', { kind: 'session' });

    expect(session.mode).toBe('plan');
    expect(session.modeByPrincipal).toBeUndefined();
    // `plan` — только чтение (ADR-025): режим виден всем участникам.
    expect(resolveTurnMode(session, { kind: 'user', id: 'owner-1', roles: [] })).toBe('plan');
  });

  it('возврат к базовому режиму снимает переопределение', () => {
    const session = makeSession({ mode: 'act', modeByPrincipal: { 'editor-1': 'yolo' } });

    applySessionMode(session, 'act', { kind: 'principal', userId: 'editor-1' });

    expect(session.modeByPrincipal).toBeUndefined();
    expect(resolveTurnMode(session, { kind: 'user', id: 'editor-1', roles: [] })).toBe('act');
  });
});
