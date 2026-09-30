import { describe, it, expect } from 'vitest';
import type { PermissionConfig } from '@itphx/synth-shared';
import { PermissionEvaluator, resolveSkillRule } from './evaluator.js';
import { deriveSubagentPermission } from './derive.js';

function config(rules: PermissionConfig['rules']): PermissionConfig {
  return { rules, askTimeoutMs: 30_000 };
}

describe('resolveSkillRule (AD-046 §8.1)', () => {
  it('строка — действие для всех скиллов', () => {
    expect(resolveSkillRule(config({ skill: 'deny' }), 'any')?.action).toBe('deny');
    expect(resolveSkillRule(config({ skill: 'ask' }), 'any')?.action).toBe('ask');
  });

  it('glob-паттерны по имени скилла', () => {
    const cfg = config({ skill: { 'api-*': 'allow', 'db-*': 'deny', '*': 'ask' } });
    expect(resolveSkillRule(cfg, 'api-review')?.action).toBe('allow');
    expect(resolveSkillRule(cfg, 'db-migration')?.action).toBe('deny');
    expect(resolveSkillRule(cfg, 'misc')?.action).toBe('ask');
  });

  it('нет правила → undefined', () => {
    expect(resolveSkillRule(config({}), 'x')).toBeUndefined();
    expect(resolveSkillRule(undefined, 'x')).toBeUndefined();
  });

  it('конфиг без rules (permission: {}) — трактуется как «нет правил», не бросает', () => {
    expect(resolveSkillRule({} as PermissionConfig, 'x')).toBeUndefined();
  });
});

describe('PermissionEvaluator для тула skill', () => {
  it('deny по имени скилла', () => {
    const evaluator = new PermissionEvaluator(config({ skill: { 'secret-*': 'deny' } }));
    const decision = evaluator.check({
      toolName: 'skill',
      params: { name: 'secret-thing' },
      workingDir: '/work',
      capabilities: ['file_read'],
    });
    expect(decision.action).toBe('deny');
    expect(decision.matchedRule).toBe('skill.secret-*');
  });

  it('ask по скиллу', () => {
    const evaluator = new PermissionEvaluator(config({ skill: 'ask' }));
    const decision = evaluator.check({
      toolName: 'skill',
      params: { name: 'any' },
      workingDir: '/work',
      capabilities: ['file_read'],
    });
    expect(decision.action).toBe('ask');
  });

  it('без правил — allow по умолчанию', () => {
    const evaluator = new PermissionEvaluator(config({}));
    const decision = evaluator.check({
      toolName: 'skill',
      params: { name: 'any' },
      workingDir: '/work',
      capabilities: ['file_read'],
    });
    expect(decision.action).toBe('allow');
  });

  it('конфиг без rules (permission: {}) — не бросает, allow по умолчанию', () => {
    const evaluator = new PermissionEvaluator({} as PermissionConfig);
    const decision = evaluator.check({
      toolName: 'skill',
      params: { name: 'any' },
      workingDir: '/work',
      capabilities: ['file_read'],
    });
    expect(decision.action).toBe('allow');
  });
});

describe('deriveSubagentPermission — наследование skill-правил (AD-046 §8.1)', () => {
  it('skill-правила родителя сохраняются + собственные deny тулов', () => {
    const parent = config({ skill: { 'db-*': 'deny' } });
    const child = deriveSubagentPermission(parent);
    expect(resolveSkillRule(child, 'db-migration')?.action).toBe('deny');
    expect(child.rules.task).toBe('deny');
    expect(child.rules.plan_enter).toBe('deny');
  });
});
