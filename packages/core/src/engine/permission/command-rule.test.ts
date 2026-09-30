import { describe, it, expect } from 'vitest';
import { resolveCommandRule } from './evaluator.js';
import { deriveSubagentPermission } from './derive.js';
import type { PermissionConfig } from '@itphx/synth-shared';

const cfg = (rules: PermissionConfig['rules']): PermissionConfig => ({ rules, askTimeoutMs: 30_000 });

describe('resolveCommandRule (AD-046 §8.1)', () => {
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

describe('наследование command-правил саб-агентом (AD-046 §8.1)', () => {
  it('deriveSubagentPermission сохраняет command-правила родителя', () => {
    const parent = cfg({ command: { help: 'deny' }, skill: 'allow' });
    const child = deriveSubagentPermission(parent);
    expect(child.rules.command).toEqual({ help: 'deny' });
    expect(child.rules.skill).toBe('allow');
  });
});
