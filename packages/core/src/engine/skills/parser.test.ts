import { describe, it, expect } from 'vitest';
import { parseSkillFile } from './parser.js';

function md(frontmatter: string, body = 'Body'): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

describe('parseSkillFile (AD-046 §3.2)', () => {
  it('валидный минимальный SKILL.md', () => {
    const { skill, issues } = parseSkillFile(md('name: api-review\ndescription: Проверяет API'), 'api-review');
    expect(issues).toEqual([]);
    expect(skill?.name).toBe('api-review');
    expect(skill?.meta.invocation).toBe('both');
    expect(skill?.meta.userInvocable).toBe(true);
    expect(skill?.meta.disableModelInvocation).toBe(false);
    expect(skill?.body).toBe('\nBody');
  });

  it('отсутствие frontmatter — missing-frontmatter, скилла нет', () => {
    const { skill, issues } = parseSkillFile('# only markdown', 'x');
    expect(skill).toBeUndefined();
    expect(issues.map((i) => i.code)).toEqual(['missing-frontmatter']);
  });

  it('невалидный YAML — invalid-frontmatter, скилла нет', () => {
    const { skill, issues } = parseSkillFile('---\nname: [oops\n---\nbody', 'x');
    expect(skill).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain('invalid-frontmatter');
  });

  it('неизвестные ключи не ошибка и попадают в extra', () => {
    const { skill, issues } = parseSkillFile(
      md('name: x\ndescription: y\nfuture-key: 42\nanother: {a: 1}'),
      'x',
    );
    expect(issues).toEqual([]);
    expect(skill?.meta.extra).toEqual({ 'future-key': 42, another: { a: 1 } });
  });

  it('name не совпадает с каталогом — name-mismatch', () => {
    const { skill, issues } = parseSkillFile(md('name: other\ndescription: y'), 'dir');
    expect(skill).toBeUndefined();
    expect(issues.map((i) => i.code)).toEqual(['name-mismatch']);
  });

  it('невалидный name (regex) — invalid-name', () => {
    for (const bad of ['Bad_Name', 'UPPER', 'with space', '-leading', 'trailing-']) {
      const { skill, issues } = parseSkillFile(md(`name: ${bad}\ndescription: y`), bad);
      expect(skill).toBeUndefined();
      expect(issues.map((i) => i.code)).toContain('invalid-name');
    }
  });

  it('границы name: 1 и 64 валидны, 65 — нет', () => {
    const n1 = 'a';
    const n64 = 'a'.repeat(64);
    const n65 = 'a'.repeat(65);
    expect(parseSkillFile(md(`name: ${n1}\ndescription: d`), n1).skill).toBeDefined();
    expect(parseSkillFile(md(`name: ${n64}\ndescription: d`), n64).skill).toBeDefined();
    const over = parseSkillFile(md(`name: ${n65}\ndescription: d`), n65);
    expect(over.skill).toBeUndefined();
    expect(over.issues.map((i) => i.code)).toContain('invalid-name');
  });

  it('границы description: 1 и 1024 валидны, 1025 — нет', () => {
    expect(parseSkillFile(md(`name: x\ndescription: ${'d'}`), 'x').skill).toBeDefined();
    expect(parseSkillFile(md(`name: x\ndescription: ${'d'.repeat(1024)}`), 'x').skill).toBeDefined();
    const over = parseSkillFile(md(`name: x\ndescription: ${'d'.repeat(1025)}`), 'x');
    expect(over.skill).toBeUndefined();
    expect(over.issues.map((i) => i.code)).toContain('invalid-description');
  });

  it('отсутствие name/description', () => {
    const noName = parseSkillFile(md('description: y'), 'x');
    expect(noName.issues.map((i) => i.code)).toContain('missing-name');
    const noDesc = parseSkillFile(md('name: x'), 'x');
    expect(noDesc.issues.map((i) => i.code)).toContain('missing-description');
  });

  it('invocation из двух флагов: 4 комбинации (§6.1)', () => {
    const parse = (fm: string) => parseSkillFile(md(fm), 'x').skill?.meta.invocation;
    expect(parse('name: x\ndescription: d')).toBe('both');
    expect(parse('name: x\ndescription: d\nuser-invocable: true\ndisable-model-invocation: true')).toBe('user');
    expect(parse('name: x\ndescription: d\nuser-invocable: false\ndisable-model-invocation: false')).toBe('model');
    expect(parse('name: x\ndescription: d\nuser-invocable: false\ndisable-model-invocation: true')).toBe('none');
  });

  it('none-invocation — предупреждение, скилл остаётся в реестре', () => {
    const { skill, issues } = parseSkillFile(
      md('name: x\ndescription: d\nuser-invocable: false\ndisable-model-invocation: true'),
      'x',
    );
    expect(skill).toBeDefined();
    expect(issues.map((i) => i.code)).toEqual(['none-invocation']);
  });

  it('metadata.synth.* парсится (tags/category/agents/groups/requires_capabilities)', () => {
    const fm = [
      'name: x',
      'description: d',
      'metadata:',
      '  synth:',
      '    tags: [a, b]',
      '    category: quality',
      '    agents: [reviewer]',
      '    groups: [review]',
      '    requires_capabilities: [shell, file_write]',
      '    requires_toolsets: [git]',
      '    scope: project',
      '    trigger: auto',
      '    mode: plan',
      '    command: x-cmd',
    ].join('\n');
    const { skill } = parseSkillFile(md(fm), 'x');
    expect(skill?.meta.tags).toEqual(['a', 'b']);
    expect(skill?.meta.category).toBe('quality');
    expect(skill?.meta.agents).toEqual(['reviewer']);
    expect(skill?.meta.groups).toEqual(['review']);
    expect(skill?.meta.requiresCapabilities).toEqual(['shell', 'file_write']);
    expect(skill?.meta.requiresToolsets).toEqual(['git']);
    expect(skill?.meta.scope).toBe('project');
    expect(skill?.meta.trigger).toBe('auto');
    expect(skill?.meta.mode).toBe('plan');
    expect(skill?.meta.command).toBe('x-cmd');
  });

  it('allowed-tools принимает строку и массив', () => {
    expect(parseSkillFile(md('name: x\ndescription: d\nallowed-tools: read_file'), 'x').skill?.meta.allowedTools)
      .toEqual(['read_file']);
    expect(parseSkillFile(md('name: x\ndescription: d\nallowed-tools: [a, b]'), 'x').skill?.meta.allowedTools)
      .toEqual(['a', 'b']);
  });
});
