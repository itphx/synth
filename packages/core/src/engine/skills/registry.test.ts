import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from './registry.js';
import { buildBuiltinSkills, SYNTH_AGENTS_MD_NAME, SYNTH_PIPELINES_NAME, SYNTH_SCHEDULES_NAME, SYNTH_STORAGE_RECOVERY_NAME } from './builtin.js';
import type { SkillSource } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'synth-skills-registry-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, description = `desc-${name}`): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}\n`,
    'utf-8',
  );
}

function instanceSource(dir: string): SkillSource {
  return { scope: 'instance', level: 'system', origin: 'instance', dir, trusted: true };
}

describe('SkillRegistry — builtin (ADR-046 §9.5)', () => {
  it('builtin виден, доверенный, идёт первым', async () => {
    const dataDir = join(root, 'data');
    const instanceDir = join(dataDir, 'skills');
    await writeSkill(instanceDir, 'local-skill');

    const registry = new SkillRegistry({
      builtin: buildBuiltinSkills({ dataDir }),
      sources: () => [instanceSource(instanceDir)],
    });

    const { skills } = await registry.list();
    expect(skills.map((s) => s.name)).toEqual([
      'skill-creator',
      SYNTH_AGENTS_MD_NAME,
      SYNTH_STORAGE_RECOVERY_NAME,
      SYNTH_PIPELINES_NAME,
      SYNTH_SCHEDULES_NAME,
      'local-skill',
    ]);
    expect(skills[0]!.trusted).toBe(true);
    expect(skills[0]!.source.level).toBe('system');

    const got = await registry.get('skill-creator');
    expect(got?.name).toBe('skill-creator');
    expect(got?.body.length).toBeGreaterThan(0);
  });

  it('builtin не перекрывается одноимённым instance-скиллом (shadowed)', async () => {
    const dataDir = join(root, 'data');
    const instanceDir = join(dataDir, 'skills');
    await writeSkill(instanceDir, 'skill-creator', 'instance-override');

    const registry = new SkillRegistry({
      builtin: buildBuiltinSkills({ dataDir }),
      sources: () => [instanceSource(instanceDir)],
    });

    const { skills, diagnostics } = await registry.list();
    expect(skills.filter((s) => s.name === 'skill-creator')).toHaveLength(1);
    // Победил builtin, а не instance-скилл с тем же именем.
    expect(skills.find((s) => s.name === 'skill-creator')!.meta.description)
      .toContain('Scaffold a new project skill');
    expect(diagnostics.some((d) => d.code === 'shadowed' && d.skill === 'skill-creator')).toBe(true);
  });

  it('reload() не теряет builtin', async () => {
    const dataDir = join(root, 'data');
    const instanceDir = join(dataDir, 'skills');
    await mkdir(instanceDir, { recursive: true });

    const registry = new SkillRegistry({
      builtin: buildBuiltinSkills({ dataDir }),
      sources: () => [instanceSource(instanceDir)],
    });
    registry.reload();

    expect((await registry.list()).skills.map((s) => s.name)).toEqual([
      'skill-creator',
      SYNTH_AGENTS_MD_NAME,
      SYNTH_STORAGE_RECOVERY_NAME,
      SYNTH_PIPELINES_NAME,
      SYNTH_SCHEDULES_NAME,
    ]);
  });
});
