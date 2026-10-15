import { describe, it, expect } from 'vitest';
import { resolveCatalog, parseCommandInput } from './resolver.js';
import type { CommandSkillEntry, TemplateCommand } from './types.js';
import type { SkillBundle } from '@itphx/synth-shared';

function template(name: string): TemplateCommand {
  return { name, description: `tmpl ${name}`, body: 'b', file: `/c/${name}.md`, dir: '/c', origin: 'instance', trusted: true, mtimeMs: 1 };
}
function skill(commandName: string, skillName = commandName): CommandSkillEntry {
  return {
    commandName, skillName, description: `skill ${skillName}`,
    userInvocable: true, modelInvocable: true, trusted: true,
    requiresCapabilities: [], requiresToolsets: [], available: true,
  };
}
function bundle(name: string, skills: string[]): SkillBundle {
  return { name, description: `bundle ${name}`, skills };
}

describe('resolver: режимы конфликта (ADR-046 §7.1/§7.3)', () => {
  it('bundle-wins: bundle > builtin > template > skill', () => {
    const r = resolveCatalog({
      templates: [template('shared')],
      skills: [skill('shared')],
      bundles: [bundle('shared', ['shared'])],
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
    });
    const entry = r.entries.find((e) => e.summary.name === 'shared');
    expect(entry?.kind).toBe('bundle');
    // проигравшие — shadowed
    expect(r.diagnostics.filter((d) => d.code === 'shadowed').length).toBeGreaterThanOrEqual(2);
  });

  it('bundle-wins: при отсутствии bundle побеждает builtin над template+skill', () => {
    const r = resolveCatalog({
      templates: [template('help')],
      skills: [skill('help')],
      bundles: [],
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
    });
    expect(r.entries.find((e) => e.summary.name === 'help')?.kind).toBe('builtin');
  });

  it('conservative: builtin > template > bundle > skill; bundle↔builtin — error', () => {
    const r = resolveCatalog({
      templates: [template('help'), template('t')],
      skills: [skill('help'), skill('t'), skill('s')],
      bundles: [bundle('help', ['help']), bundle('t', ['t'])],
      conflict: { mode: 'conservative', namespacePrefix: false },
    });
    expect(r.entries.find((e) => e.summary.name === 'help')?.kind).toBe('builtin');
    expect(r.entries.find((e) => e.summary.name === 't')?.kind).toBe('template');
    expect(r.entries.find((e) => e.summary.name === 's')?.kind).toBe('skill');
    expect(r.diagnostics.some((d) => d.code === 'collision' && d.command === 'help')).toBe(true);
  });

  it('namespace: bare — builtin > skill; templates/bundles не перекрывают', () => {
    const r = resolveCatalog({
      templates: [template('t')],
      skills: [skill('s'), skill('help')],
      bundles: [bundle('b', ['s'])],
      conflict: { mode: 'namespace', namespacePrefix: false },
    });
    expect(r.entries.find((e) => e.summary.name === 'help')?.kind).toBe('builtin');
    expect(r.entries.find((e) => e.summary.name === 's')?.kind).toBe('skill');
    expect(r.entries.find((e) => e.summary.name === 't')).toBeUndefined();
    expect(r.entries.find((e) => e.summary.name === 'b')).toBeUndefined();
  });

  it('namespace + namespacePrefix: <bundle>:<skill> только для конфликтующих имён, без template:', () => {
    const r = resolveCatalog({
      templates: [template('t')],
      skills: [skill('s'), skill('help')],
      bundles: [bundle('b', ['s', 'help', 'ghost'])],
      conflict: { mode: 'namespace', namespacePrefix: true },
    });
    // 'help' конфликтует с builtin → доступен как b:help
    expect(r.entries.find((e) => e.summary.name === 'b:help')?.kind).toBe('skill');
    // 's' не конфликтует → префикс не добавляется
    expect(r.entries.find((e) => e.summary.name === 'b:s')).toBeUndefined();
    // 'ghost' отсутствует → диагностика
    expect(r.diagnostics.some((d) => d.code === 'missing-skill')).toBe(true);
    // никаких изобретённых 'template:'
    expect(r.entries.some((e) => e.summary.name.startsWith('template:'))).toBe(false);
  });

  it('parseCommandInput: имя и аргументы; не-команда → undefined', () => {
    expect(parseCommandInput('/review a/b')).toEqual({ name: 'review', args: 'a/b' });
    expect(parseCommandInput('/help')).toEqual({ name: 'help', args: '' });
    expect(parseCommandInput('/bundle:skill x')).toEqual({ name: 'bundle:skill', args: 'x' });
    expect(parseCommandInput('plain text')).toBeUndefined();
  });
});
