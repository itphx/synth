import { describe, it, expect } from 'vitest';
import { resolveCatalog, parseCommandInput } from './resolver.js';
import type { TemplateCommand } from './types.js';
import type { SkillBundle } from '@itphx/synth-shared';

function template(name: string): TemplateCommand {
  return { name, description: `tmpl ${name}`, body: 'b', file: `/c/${name}.md`, dir: '/c', origin: 'instance', trusted: true, mtimeMs: 1 };
}
function bundle(name: string, skills: string[]): SkillBundle {
  return { name, description: `bundle ${name}`, skills };
}

// ADR-126 §7: скиллы в `/`-каталог не входят; порядок — builtin/template/bundle.
describe('resolver: режимы конфликта (ADR-126 §7)', () => {
  it('bundle-wins: bundle > builtin > template', () => {
    const r = resolveCatalog({
      templates: [template('shared')],
      bundles: [bundle('shared', ['a'])],
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
    });
    const entry = r.entries.find((e) => e.summary.name === 'shared');
    expect(entry?.kind).toBe('bundle');
    // проигравшие — shadowed
    expect(r.diagnostics.filter((d) => d.code === 'shadowed').length).toBe(1);
  });

  it('bundle-wins: при отсутствии bundle побеждает builtin над template', () => {
    const r = resolveCatalog({
      templates: [template('help')],
      bundles: [],
      conflict: { mode: 'bundle-wins', namespacePrefix: false },
    });
    expect(r.entries.find((e) => e.summary.name === 'help')?.kind).toBe('builtin');
  });

  it('conservative: builtin > template > bundle; bundle↔builtin — error', () => {
    const r = resolveCatalog({
      templates: [template('help'), template('t')],
      bundles: [bundle('help', ['a']), bundle('t', ['a']), bundle('b', ['a'])],
      conflict: { mode: 'conservative', namespacePrefix: false },
    });
    expect(r.entries.find((e) => e.summary.name === 'help')?.kind).toBe('builtin');
    expect(r.entries.find((e) => e.summary.name === 't')?.kind).toBe('template');
    expect(r.entries.find((e) => e.summary.name === 'b')?.kind).toBe('bundle');
    expect(r.diagnostics.some((d) => d.code === 'collision' && d.command === 'help')).toBe(true);
  });

  it('namespace: bare — builtin > bundle; шаблоны не перекрывают', () => {
    const r = resolveCatalog({
      templates: [template('t')],
      bundles: [bundle('b', ['s'])],
      conflict: { mode: 'namespace', namespacePrefix: false },
    });
    expect(r.entries.find((e) => e.summary.name === 'b')?.kind).toBe('bundle');
    expect(r.entries.find((e) => e.summary.name === 't')).toBeUndefined();
  });

  it('namespace + namespacePrefix больше не создаёт <bundle>:<skill>', () => {
    const r = resolveCatalog({
      templates: [template('t')],
      bundles: [bundle('b', ['s', 'help', 'ghost'])],
      conflict: { mode: 'namespace', namespacePrefix: true },
    });
    // Скиллов в каталоге нет — ни bare-, ни префиксных записей.
    expect(r.entries.some((e) => e.summary.name.includes(':'))).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'missing-skill')).toBe(false);
  });

  it('parseCommandInput: имя и аргументы; не-команда → undefined', () => {
    expect(parseCommandInput('/review a/b')).toEqual({ name: 'review', args: 'a/b' });
    expect(parseCommandInput('/help')).toEqual({ name: 'help', args: '' });
    expect(parseCommandInput('/bundle:skill x')).toEqual({ name: 'bundle:skill', args: 'x' });
    expect(parseCommandInput('plain text')).toBeUndefined();
  });
});
