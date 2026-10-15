import { describe, it, expect } from 'vitest';
import type { SkillMeta } from '@itphx/synth-shared';
import { buildSkillCatalog } from './catalog.js';
import type { DiscoveredSkill } from './types.js';

function mk(name: string, meta: Partial<SkillMeta> = {}): DiscoveredSkill {
  const full: SkillMeta = {
    name,
    description: `${name} description`,
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    ...meta,
  };
  return {
    name,
    meta: full,
    body: `Body ${name}`,
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    source: { scope: 'instance', level: 'system', origin: 'instance', dir: '/skills', trusted: true },
    trusted: true,
    mtimeMs: 0,
  };
}

describe('buildSkillCatalog — гейты системы/проекта/сессии (ADR-046 §4.5)', () => {
  it('opt-in: без снапшота и включения скилл недоступен', () => {
    const cat = buildSkillCatalog([mk('a')], { defaultOn: [] });
    expect(cat.stable).toEqual([]);
    expect(cat.session).toEqual([]);
  });

  it('снапшот (defaultOn) включает скилл → stable', () => {
    const cat = buildSkillCatalog([mk('a'), mk('b')], { defaultOn: ['a'] });
    expect(cat.stable.map((e) => e.name)).toEqual(['a']);
  });

  it('sessionEnabled вне снапшота → session-tier {enabled:true}', () => {
    const cat = buildSkillCatalog([mk('a')], { defaultOn: [], sessionEnabled: ['a'] });
    expect(cat.stable).toEqual([]);
    expect(cat.session[0]).toMatchObject({ name: 'a', enabled: true });
  });

  it('БАГ-КЕЙС: project.enabled=[] блокирует скиллы и в старой сессии (снапшот не спасает)', () => {
    // Старая сессия уже имеет снапшот ['a'], но проект выключил все скиллы.
    const cat = buildSkillCatalog([mk('a')], { projectEnabled: [], defaultOn: ['a'] });
    expect(cat.stable).toEqual([]);
    expect(cat.session).toEqual([]);
  });

  it('project.enabled — allow-list: не вошедшие исключаются, вошедшие остаются', () => {
    const cat = buildSkillCatalog([mk('a'), mk('b')], {
      projectEnabled: ['a'],
      defaultOn: ['a', 'b'],
    });
    expect(cat.stable.map((e) => e.name)).toEqual(['a']);
  });

  it('системный hard-gate (systemDisabled) исключает скилл', () => {
    const cat = buildSkillCatalog([mk('a'), mk('b', { category: 'quality' })], {
      defaultOn: ['a', 'b'],
      systemDisabled: { categories: ['quality'] },
    });
    expect(cat.stable.map((e) => e.name)).toEqual(['a']);
  });

  it('projectEnabled undefined — legacy-режим (гейт не задан)', () => {
    const cat = buildSkillCatalog([mk('a')], {});
    expect(cat.stable.map((e) => e.name)).toEqual(['a']);
  });
});
