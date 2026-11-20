import { describe, it, expect } from 'vitest';
import { resolveCommandRule } from './evaluator.js';
import { applySubagentRoleDenies } from './derive.js';
import { resolveEffectivePermission } from './effective.js';
import type { PermissionConfig } from '@itphx/synth-shared';

const cfg = (rules: PermissionConfig['rules']): PermissionConfig => ({ rules, askTimeoutMs: 30_000 });

describe('resolveCommandRule (ADR-126 §10)', () => {
  it('нет правила → undefined', () => {
    expect(resolveCommandRule(cfg({}), 'help')).toBeUndefined();
  });

  it('конфиг без rules (permission: {}) — трактуется как «нет правил», не бросает', () => {
    expect(resolveCommandRule({} as PermissionConfig, 'help')).toBeUndefined();
  });

  it('строковое действие применяется ко всем командам', () => {
    expect(resolveCommandRule(cfg({ command: 'deny' }), 'anything')?.action).toBe('deny');
  });

  it('glob по имени: deny', () => {
    const d = resolveCommandRule(cfg({ command: { 'rev*': 'deny' } }), 'review');
    expect(d?.action).toBe('deny');
    expect(d?.matchedRule).toBe('command.rev*');
  });

  it('glob: ask для конкретной команды', () => {
    expect(resolveCommandRule(cfg({ command: { deploy: 'ask' } }), 'deploy')?.action).toBe('ask');
  });

  it('"*" — fallback, если паттерны не совпали', () => {
    const d = resolveCommandRule(cfg({ command: { 'x*': 'deny', '*': 'allow' } }), 'help');
    expect(d?.action).toBe('allow');
    expect(d?.matchedRule).toBe('command.*');
  });

  it('точный паттерн приоритетнее "*"', () => {
    const d = resolveCommandRule(cfg({ command: { '*': 'allow', help: 'deny' } }), 'help');
    expect(d?.action).toBe('deny');
  });
});

describe('наследование command-правил саб-агентом (ADR-126 §10)', () => {
  it('command/skill-правила родителя наследуются по цепочке parentId', async () => {
    const parent = cfg({ command: { help: 'deny' }, skill: 'allow' });
    const child = applySubagentRoleDenies(await resolveEffectivePermission({
      session: { id: 'child', parentId: 'parent', settings: {} },
      getSession: async (id) => (id === 'parent' ? { id: 'parent', settings: { permission: parent } } : null),
      fallback: cfg({}),
    }));
    expect(child.rules.command).toEqual({ help: 'deny' });
    expect(child.rules.skill).toBe('allow');
  });
});
