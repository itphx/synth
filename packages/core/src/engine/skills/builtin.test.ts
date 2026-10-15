import { describe, it, expect } from 'vitest';
import { ToolCapability } from '@itphx/synth-shared';
import {
  BUILTIN_SKILLS_DIRNAME,
  BUILTIN_SOURCE,
  SKILL_CREATOR_NAME,
  SYNTH_AGENTS_MD_COMMAND,
  SYNTH_AGENTS_MD_NAME,
  buildBuiltinSkills,
  buildSkillCreatorMeta,
  buildSynthAgentsMdMeta,
} from './builtin.js';

describe('builtin skills (ADR-046 §9.5)', () => {
  it('BUILTIN_SOURCE — instance/system/trusted', () => {
    expect(BUILTIN_SOURCE).toMatchObject({
      scope: 'instance',
      level: 'system',
      origin: 'instance',
      trusted: true,
    });
  });

  it('buildBuiltinSkills содержит skill-creator с нужным meta', () => {
    const skill = buildBuiltinSkills({ dataDir: '/data' }).find((s) => s.name === SKILL_CREATOR_NAME);
    expect(skill).toBeDefined();
    expect(skill!.trusted).toBe(true);
    expect(skill!.mtimeMs).toBe(0);
    expect(skill!.source).toBe(BUILTIN_SOURCE);

    const meta = skill!.meta;
    expect(meta.name).toBe('skill-creator');
    expect(meta.userInvocable).toBe(true);
    expect(meta.disableModelInvocation).toBe(false);
    expect(meta.invocation).toBe('both');
    expect(meta.command).toBe('skill-creator');
    expect(meta.requiresCapabilities).toEqual([
      ToolCapability.FILE_READ,
      ToolCapability.FILE_WRITE,
    ]);
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it('body — инструкция про .synth/skills и обязательный frontmatter', () => {
    const skill = buildBuiltinSkills().find((s) => s.name === SKILL_CREATOR_NAME)!;
    expect(skill.body).toContain('.synth/skills');
    expect(skill.body).toContain('name');
    expect(skill.body).toContain('description');
    expect(skill.body).toContain('Supporting files');
  });

  it('синтетические пути: dir/file внутри маркера .builtin, на ФС не сидится', () => {
    const skill = buildBuiltinSkills({ dataDir: '/data' }).find((s) => s.name === SKILL_CREATOR_NAME)!;
    expect(skill.dir).toContain(BUILTIN_SKILLS_DIRNAME);
    expect(skill.dir.endsWith(SKILL_CREATOR_NAME)).toBe(true);
    expect(skill.file.endsWith('SKILL.md')).toBe(true);
  });

  it('buildSkillCreatorMeta не переиспользует объект между вызовами', () => {
    expect(buildSkillCreatorMeta()).not.toBe(buildSkillCreatorMeta());
  });
});

describe('builtin skill synth-agents-md (ADR-069 §8.2)', () => {
  it('присутствует, trusted, instance/agency-meta', () => {
    const skill = buildBuiltinSkills({ dataDir: '/data' }).find((s) => s.name === SYNTH_AGENTS_MD_NAME);
    expect(skill).toBeDefined();
    expect(skill!.trusted).toBe(true);
    expect(skill!.mtimeMs).toBe(0);
    expect(skill!.source).toBe(BUILTIN_SOURCE);

    const meta = skill!.meta;
    expect(meta.name).toBe(SYNTH_AGENTS_MD_NAME);
    expect(meta.category).toBe('meta');
    expect(meta.scope).toBe('instance');
    expect(meta.trigger).toBe('manual');
    expect(meta.mode).toBe('any');
    expect(meta.invocation).toBe('both');
    expect(meta.requiresCapabilities).toEqual([
      ToolCapability.FILE_READ,
      ToolCapability.SEARCH,
      ToolCapability.FILE_WRITE,
    ]);
    expect(meta.relatedSkills).toEqual([SKILL_CREATOR_NAME]);
    // Команда НЕ `init`: имя занято builtin `/init`, иначе была бы коллизия shadowed.
    expect(meta.command).toBe(SYNTH_AGENTS_MD_COMMAND);
    expect(meta.command).not.toBe('init');
  });

  it('тело описывает создание/обновление/аудит AGENTS.md', () => {
    const skill = buildBuiltinSkills().find((s) => s.name === SYNTH_AGENTS_MD_NAME)!;
    expect(skill.body).toContain('AGENTS.md');
    expect(skill.body).toContain('## When to use');
    expect(skill.body).toContain('## Steps');
    expect(skill.body).toContain('audit');
  });

  it('buildSynthAgentsMdMeta не переиспользует объект между вызовами', () => {
    expect(buildSynthAgentsMdMeta()).not.toBe(buildSynthAgentsMdMeta());
  });
});
