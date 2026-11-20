import { describe, it, expect } from 'vitest';
import type { PermissionConfig } from '@itphx/synth-shared';
import { PermissionEvaluator, resolveScriptRule } from './evaluator.js';
import { applySubagentRoleDenies } from './derive.js';
import { resolveEffectivePermission } from './effective.js';

function config(rules: PermissionConfig['rules']): PermissionConfig {
  return { rules, askTimeoutMs: 30_000 };
}

describe('resolveScriptRule (ADR-126 §5)', () => {
  it('строка — действие для всех скриптов', () => {
    expect(resolveScriptRule(config({ script: 'deny' }), 'any')?.action).toBe('deny');
    expect(resolveScriptRule(config({ script: 'ask' }), 'any')?.action).toBe('ask');
  });

  it('glob-паттерны по имени скрипта', () => {
    const cfg = config({ script: { 'dev-*': 'allow', 'deploy*': 'deny', '*': 'ask' } });
    expect(resolveScriptRule(cfg, 'dev-server')?.action).toBe('allow');
    expect(resolveScriptRule(cfg, 'deploy-prod')?.action).toBe('deny');
    expect(resolveScriptRule(cfg, 'misc')?.action).toBe('ask');
  });

  it('нет правила → undefined', () => {
    expect(resolveScriptRule(config({}), 'x')).toBeUndefined();
    expect(resolveScriptRule(undefined, 'x')).toBeUndefined();
  });

  it('конфиг без rules (permission: {}) — трактуется как «нет правил», не бросает', () => {
    expect(resolveScriptRule({} as PermissionConfig, 'x')).toBeUndefined();
  });
});

describe('PermissionEvaluator для тула script_run', () => {
  it('deny по имени скрипта', () => {
    const evaluator = new PermissionEvaluator(config({ script: { 'deploy*': 'deny' } }));
    const decision = evaluator.check({
      toolName: 'script_run',
      params: { name: 'deploy-prod' },
      workingDir: '/work',
      capabilities: ['shell'],
    });
    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('script.deploy*');
  });

  it('allow по имени скрипта — пропускает', () => {
    const evaluator = new PermissionEvaluator(config({ script: { 'deploy*': 'deny' } }));
    const decision = evaluator.check({
      toolName: 'script_run',
      params: { name: 'dev-server' },
      workingDir: '/work',
      capabilities: ['shell'],
    });
    expect(decision.action).toBe('allow');
  });

  it('ask по скрипту', () => {
    const evaluator = new PermissionEvaluator(config({ script: 'ask' }));
    const decision = evaluator.check({
      toolName: 'script_run',
      params: { name: 'any' },
      workingDir: '/work',
      capabilities: ['shell'],
    });
    expect(decision.action).toBe('ask');
  });

  it('без правил — allow по умолчанию', () => {
    const evaluator = new PermissionEvaluator(config({}));
    const decision = evaluator.check({
      toolName: 'script_run',
      params: { name: 'any' },
      workingDir: '/work',
      capabilities: ['shell'],
    });
    expect(decision.action).toBe('allow');
  });

  it('конфиг без rules (permission: {}) — не бросает, allow по умолчанию', () => {
    const evaluator = new PermissionEvaluator({} as PermissionConfig);
    const decision = evaluator.check({
      toolName: 'script_run',
      params: { name: 'any' },
      workingDir: '/work',
      capabilities: ['shell'],
    });
    expect(decision.action).toBe('allow');
  });
});

describe('deriveSubagentPermission — наследование script-правил (ADR-126 §5)', () => {
  /** Правила дочерней сессии так, как их видит прогон (chain-no-copy). */
  const childRules = async (parent: PermissionConfig): Promise<PermissionConfig> => applySubagentRoleDenies(
    await resolveEffectivePermission({
      session: { id: 'child', parentId: 'parent', settings: {} },
      getSession: async (id) => (id === 'parent'
        ? { id: 'parent', settings: { permission: parent } }
        : null),
      fallback: config({}),
    }),
  );

  it('script-правила родителя наследуются по цепочке parentId + собственные deny тулов', async () => {
    const child = await childRules(config({ script: { 'deploy*': 'deny' } }));
    expect(resolveScriptRule(child, 'deploy-prod')?.action).toBe('deny');
    expect(child.rules.task).toBe('deny');
    expect(child.rules.plan_enter).toBe('deny');
  });

  it('deny-скрипта наследуется саб-агентом (проверка permission-слоя ребёнка)', async () => {
    const child = await childRules(config({ script: 'deny' }));
    const evaluator = new PermissionEvaluator(child);
    const decision = evaluator.check({
      toolName: 'script_run',
      params: { name: 'dev' },
      workingDir: '/work',
      capabilities: ['shell'],
    });
    expect(decision.action).toBe('deny');
  });
});
