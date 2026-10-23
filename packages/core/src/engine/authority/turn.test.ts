/**
 * ADR-106 Ф4 (шаг B2): потолок хода.
 *
 * Проверяются инварианты шага «потолок хода»:
 * - **оси считаются один раз на ход**: потолок и оси кладутся в контекст хода
 *   и не пересчитываются на каждый вызов;
 * - **потолок по роли участника**: `viewer` — только чтение, `editor`/`owner` —
 *   обычный потолок; два участника получают **разные** решения на одно и то же
 *   действие;
 * - **сообщение другого участника не поднимает потолок начатого хода**:
 *   `viewer`, отправивший сообщение в сессию, где идёт ход `editor`, не
 *   меняет решение этого хода;
 * - **прежнее поведение**: без участников (`participants` пуст) потолок по
 *   роли не применяется; `shadow`-режим считает решение, но не применяет его.
 */
import { describe, expect, it } from 'vitest';

import type { PermissionConfig, SessionParticipant } from '@itphx/synth-shared';

import { MemoryAuthorityDecisionJournal } from '../../storage/memory/authority-decision-journal.js';
import { PermissionEvaluator } from '../permission/evaluator.js';
import { AuthorityGuard } from './guard.js';
import { createAuthorityTurnContext, type AuthorityTurnContext } from './turn.js';

const CWD = '/workspace/project';

const ALLOW_ALL: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 30_000 };

const PARTICIPANTS: SessionParticipant[] = [
  { userId: 'editor-1', role: 'editor' },
  { userId: 'viewer-1', role: 'viewer' },
];

/** Guard в enforced-режиме (слой применяет решение). */
function makeGuard() {
  const journal = new MemoryAuthorityDecisionJournal();
  const guard = new AuthorityGuard({ enabled: true, shadow: false, journal });
  return { journal, guard };
}

/** Guard в shadow-режиме (решение считается, но не применяется). */
function makeShadowGuard() {
  const journal = new MemoryAuthorityDecisionJournal();
  const guard = new AuthorityGuard({ enabled: true, shadow: true, journal });
  return { journal, guard };
}

/** Контекст хода для участника сессии. */
function turnContext(
  userId: string,
  overrides: {
    participants?: readonly SessionParticipant[];
    turnId?: string;
    agentId?: string;
  } = {},
): AuthorityTurnContext {
  return createAuthorityTurnContext({
    sessionId: 's1',
    principal: { kind: 'user', id: userId, roles: [] },
    turnId: overrides.turnId ?? 'turn-1',
    ...(overrides.agentId ? { agentId: overrides.agentId } : {}),
    participants: overrides.participants ?? PARTICIPANTS,
  });
}

/** Проверка права `write_file` в контексте хода. */
function checkWrite(context: AuthorityTurnContext, evaluator: PermissionEvaluator) {
  return evaluator.check({
    toolName: 'write_file',
    params: { file_path: 'src/a.ts', content: 'x' },
    workingDir: CWD,
    sessionMode: 'act',
    authorityContext: {
      sessionId: context.sessionId,
      principal: context.principal,
      agentId: context.agentId,
      turnId: context.id,
      turnContext: context,
    },
  });
}

describe('Authority — потолок хода (Ф4, шаг B2)', () => {
  it('два участника получают разные решения на одно и то же действие', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const editor = checkWrite(turnContext('editor-1'), evaluator);
    const viewer = checkWrite(turnContext('viewer-1'), evaluator);
    await guard.flush();

    // `editor` мутирует, `viewer` — только чтение (инвариант 21).
    expect(editor.action).toBe('allow');
    expect(viewer.action).toBe('deny');
    expect(viewer.matchedRule).toBe('authority.deny');
  });

  it('viewer не поднимает потолок уже начатого хода', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    // Ход `editor` начат: потолок посчитан один раз на ход.
    const editorTurn = turnContext('editor-1');
    expect(checkWrite(editorTurn, evaluator).action).toBe('allow');
    expect(editorTurn.ceiling).toBeDefined();
    expect(editorTurn.effective).toBeDefined();
    // Снимок потолка и осей хода — до сообщения другого участника.
    const editorCeiling = editorTurn.ceiling;
    const editorEffective = editorTurn.effective;

    // Сообщение другого участника (`viewer`) приходит в сессию, где идёт ход.
    const viewerTurn = turnContext('viewer-1', { turnId: 'turn-2' });
    expect(viewerTurn.participantRole).toBe('viewer');
    expect(checkWrite(viewerTurn, evaluator).action).toBe('deny');

    // Ход `editor` не изменился: его потолок и оси те же, решение прежнее.
    expect(checkWrite(editorTurn, evaluator).action).toBe('allow');
    expect(editorTurn.ceiling).toBe(editorCeiling);
    expect(editorTurn.effective).toBe(editorEffective);
  });

  it('editor работает как раньше: чтение и запись разрешены', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });
    const context = turnContext('editor-1');

    expect(checkWrite(context, evaluator).action).toBe('allow');
    const read = evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'act',
      authorityContext: {
        sessionId: context.sessionId,
        principal: context.principal,
        turnId: context.id,
        turnContext: context,
      },
    });
    await guard.flush();

    expect(read.action).toBe('allow');
  });

  it('без участников — прежнее поведение (потолок по роли не применяется)', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const context = turnContext('editor-1', { participants: [] });
    expect(context.participantRole).toBeUndefined();

    expect(checkWrite(context, evaluator).action).toBe('allow');
    await guard.flush();
  });

  it('standalone: владелец сессии `local` — полный потолок', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const context = createAuthorityTurnContext({
      sessionId: 's1',
      principal: { kind: 'user', id: 'local', roles: [] },
      turnId: 'turn-1',
      participants: [{ userId: 'local', role: 'owner' }],
    });
    expect(context.participantRole).toBe('owner');
    expect(checkWrite(context, evaluator).action).toBe('allow');
    await guard.flush();
  });

  it('shadow-режим: решение считается, но не применяется', async () => {
    const { journal, guard } = makeShadowGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const context = turnContext('viewer-1');
    const decision = checkWrite(context, evaluator);
    await guard.flush();

    // Права не меняются…
    expect(decision.action).toBe('allow');
    // …но решение посчитано и записано в журнал.
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.mode).toBe('shadow');
  });

  it('оси хода считаются один раз на ход (потолок не пересчитывается)', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const context = turnContext('editor-1');
    checkWrite(context, evaluator);
    const ceiling = context.ceiling;
    const effective = context.effective;
    checkWrite(context, evaluator);
    await guard.flush();

    expect(context.ceiling).toBe(ceiling);
    expect(context.effective).toBe(effective);
  });
});
