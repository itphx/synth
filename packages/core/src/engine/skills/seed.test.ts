import { describe, it, expect } from 'vitest';
import type { SkillSummary } from '@itphx/synth-shared';
import { resolveProjectSkillSeed, resolveProjectMcpSeed } from './seed.js';
import type { SkillService } from './service.js';

function summary(name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} desc`,
    scope: 'instance',
    level: 'system',
    dir: `/skills/${name}`,
    invocation: 'both',
    userInvocable: true,
    modelInvocable: true,
    tags: [],
    agents: [],
    groups: [],
    requiresCapabilities: [],
    trusted: true,
    available: true,
    ...extra,
  };
}

function service(skills: SkillSummary[]): SkillService {
  return {
    listSummaries: async () => ({ skills, diagnostics: [] }),
  } as unknown as SkillService;
}

describe('resolveProjectSkillSeed (ADR-046 §4.5)', () => {
  it('сид = все обнаруженные скиллы, кроме disabledForNewProjects', async () => {
    const seed = await resolveProjectSkillSeed(
      service([
        summary('a'),
        summary('b', { category: 'quality' }),
        summary('c', { groups: ['review'] }),
      ]),
      { categories: ['quality'], groups: ['review'], skills: [] },
    );
    expect(seed.enabled).toEqual(['a']);
    expect(seed.defaultOn).toEqual(['a']);
  });

  it('без disabledForNewProjects — все включены', async () => {
    const seed = await resolveProjectSkillSeed(service([summary('a'), summary('b')]), undefined);
    expect(seed.enabled).toEqual(['a', 'b']);
    expect(seed.defaultOn).toEqual(['a', 'b']);
  });
});

describe('resolveProjectMcpSeed (ADR-071 §2.4)', () => {
  it('сид MCP = серверы enabledByDefault (enabled = defaultOn)', () => {
    const seed = resolveProjectMcpSeed(['s1', 's2']);
    expect(seed).toEqual({ enabled: ['s1', 's2'], defaultOn: ['s1', 's2'] });
  });
});
