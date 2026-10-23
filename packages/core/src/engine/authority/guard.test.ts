/**
 * ADR-106 Ф2: тесты принуждения Authority-слоя.
 *
 * Проверяются инварианты этапа «Ф2 — принуждение в движке»:
 * - **fail-closed**: новый тул без отображения на действие → `deny`;
 * - **потолок**: `yolo` **не** снимает `ask`, который требует потолок сессии
 *   (внешний каталог) — иначе участник с write-доступом снимал бы
 *   подтверждения для всех;
 * - **пересечение осей**: `deny`/`ask` по грантам (политика инстанса, роль
 *   принципала, потолок режима `plan`);
 * - **права только сужаются**: `allow` слоя не расширяет решение
 *   permission-слоя (защищённый путь остаётся `deny`);
 * - **журнал**: в enforced-режиме запись помечается `mode:'enforced'` и не
 *   содержит `permissionEffect` (в shadow — содержит).
 */
import { describe, expect, it } from 'vitest';

import type { AuthorityPolicy, PermissionConfig } from '@itphx/synth-shared';

import { MemoryAuthorityDecisionJournal } from '../../storage/memory/authority-decision-journal.js';
import { PermissionEvaluator } from '../permission/evaluator.js';
import { AuthorityGuard } from './guard.js';

const CWD = '/workspace/project';

const ALLOW_ALL: PermissionConfig = { rules: { '*': 'allow' }, askTimeoutMs: 30_000 };

/** Guard в enforced-режиме (слой применяет решение). */
function makeGuard(policy: AuthorityPolicy | null = null) {
  const journal = new MemoryAuthorityDecisionJournal();
  const guard = new AuthorityGuard({ enabled: true, shadow: false, journal, policy });
  return { journal, guard };
}

/** Guard в shadow-режиме (решение считается, но не применяется). */
function makeShadowGuard(policy: AuthorityPolicy | null = null) {
  const journal = new MemoryAuthorityDecisionJournal();
  const guard = new AuthorityGuard({ enabled: true, shadow: true, journal, policy });
  return { journal, guard };
}

describe('Authority-guard (Ф2) — fail-closed', () => {
  it('новый тул без маппинга → deny (действие неизвестно)', async () => {
    const { journal, guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'brand_new_tool',
      params: { anything: 1 },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await guard.flush();

    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('authority.deny');

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.reason).toBe('unknown');
    expect(entries[0]!.mode).toBe('enforced');
  });

  it('shadow-режим: неизвестный тул НЕ запрещается (решение прав не меняется)', async () => {
    const { journal, guard } = makeShadowGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'brand_new_tool',
      params: { anything: 1 },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await guard.flush();

    expect(decision.action).toBe('allow');
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.mode).toBe('shadow');
    expect(entries[0]!.permissionEffect).toBe('allow');
  });
});

describe('Authority-guard (Ф2) — потолок сессии', () => {
  it('yolo НЕ снимает ask, который требует потолок сессии (путь вне workspace)', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: '/etc/hosts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'yolo',
    });
    await guard.flush();

    // Permission-слой в `yolo` поднимает свой `ask` до `allow`…
    const withoutAuthority = new PermissionEvaluator(ALLOW_ALL).check({
      toolName: 'write_file',
      params: { file_path: '/etc/hosts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'yolo',
    });
    expect(withoutAuthority.action).toBe('allow');

    // …но потолок сессии требует подтверждения — `yolo` его не снимает.
    expect(decision.action).toBe('ask');
  });

  it('ask потолка помечен как требующий подтверждения (requiresConfirm)', async () => {
    const { guard } = makeGuard();
    const result = guard.gate({
      toolName: 'write_file',
      params: { file_path: '/etc/hosts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'yolo',
      config: ALLOW_ALL,
      decision: { action: 'allow', reason: '' },
    });

    expect(result?.effect).toBe('ask');
    expect(result?.source).toBe('session');
    expect(result?.requiresConfirm).toBe(true);
    expect(result?.enforced).toBe(true);
  });

  it('внутри workspace подтверждение не требуется', async () => {
    const { guard } = makeGuard();
    const result = guard.gate({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'yolo',
      config: ALLOW_ALL,
      decision: { action: 'allow', reason: '' },
    });

    expect(result?.effect).toBe('allow');
    expect(result?.requiresConfirm).toBe(false);
  });
});

describe('Authority-guard (Ф2) — пересечение осей', () => {
  it('deny по гранту политики инстанса (ось instance)', async () => {
    const policy: AuthorityPolicy = {
      actions: [],
      roles: [],
      targets: [],
      ceilings: [
        {
          source: 'instance',
          grants: [{ action: 'write', targetPattern: 'path:**', effect: 'deny' }],
        },
      ],
      agents: [],
    };
    const { journal, guard } = makeGuard(policy);
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await guard.flush();

    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('authority.deny');

    const entries = await journal.list();
    expect(entries[0]!.effect).toBe('deny');
    expect(entries[0]!.reason).toBe('explicit');
    expect(entries[0]!.source).toBe('instance');
  });

  it('ask по гранту роли принципала (ось user)', async () => {
    const policy: AuthorityPolicy = {
      actions: [],
      roles: [
        {
          id: 'editor',
          domain: 'core',
          grants: [{ action: 'write', targetPattern: 'path:**', effect: 'ask' }],
        },
      ],
      targets: [],
      ceilings: [],
      agents: [],
    };
    const { guard } = makeGuard(policy);
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act',
      authorityContext: {
        sessionId: 's1',
        turnId: 't1',
        principal: { kind: 'user', id: 'u1', roles: ['editor'] },
      },
    });
    await guard.flush();

    expect(decision.action).toBe('ask');
    expect(decision.matchedRule).toBe('authority.ask');
  });

  it('потолок режима plan: запись запрещена (нет гранта — нет права)', async () => {
    const { guard } = makeGuard();
    const result = guard.gate({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'plan',
      config: ALLOW_ALL,
      decision: { action: 'deny', reason: '' },
    });

    expect(result?.effect).toBe('deny');
    expect(result?.reason).toBe('no_grant');
    expect(result?.source).toBe('session');
  });

  it('потолок режима plan: чтение разрешено', async () => {
    const { guard } = makeGuard();
    const result = guard.gate({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'plan',
      config: ALLOW_ALL,
      decision: { action: 'allow', reason: '' },
    });

    expect(result?.effect).toBe('allow');
  });
});

describe('Authority-guard (Ф2) — права только сужаются', () => {
  it('allow слоя НЕ отменяет deny permission-слоя (защищённый путь)', async () => {
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/.env', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act',
      protectedPaths: {
        deniedPaths: [],
        deniedPrefixes: [`${CWD}/src/.env`],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      },
    });
    await guard.flush();

    expect(decision.action).toBe('deny');
    // Запрет пришёл из жёсткого слоя permission-слоя, а не из Authority-слоя.
    expect(decision.matchedRule).not.toBe('authority.deny');
  });

  it('allow слоя НЕ превращает deny правила сессии в allow', async () => {
    const config: PermissionConfig = {
      rules: { '*': 'allow', write_file: 'deny' },
      askTimeoutMs: 30_000,
    };
    const { guard } = makeGuard();
    const evaluator = new PermissionEvaluator(config, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'write_file',
      params: { file_path: 'src/a.ts', content: 'x' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await guard.flush();

    expect(decision.action).toBe('deny');
  });
});

describe('Authority-guard (Ф2) — журнал и отказоустойчивость', () => {
  it('enforced-запись не содержит permissionEffect', async () => {
    const { journal, guard } = makeGuard();
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    evaluator.check({
      toolName: 'read_file',
      params: { file_path: 'src/a.ts' },
      workingDir: CWD,
      sessionMode: 'act',
    });
    await guard.flush();

    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe('enforced');
    expect(entries[0]!.permissionEffect).toBeUndefined();
    expect(entries[0]!.action).toBe('read');
    expect(entries[0]!.effect).toBe('allow');
  });

  it('слой выключен — решение permission-слоя не меняется', async () => {
    const guard = new AuthorityGuard({ enabled: false, shadow: false });
    const evaluator = new PermissionEvaluator(ALLOW_ALL, { authorityGate: guard.gate });

    const decision = evaluator.check({
      toolName: 'brand_new_tool',
      params: {},
      workingDir: CWD,
      sessionMode: 'act',
    });

    expect(decision.action).toBe('allow');
    expect(guard.active).toBe(false);
    expect(guard.enforced).toBe(false);
  });
});
