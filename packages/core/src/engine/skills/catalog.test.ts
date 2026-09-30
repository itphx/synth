import { describe, it, expect } from 'vitest';
import type { SkillMeta } from '@itphx/synth-shared';
import { buildSkillCatalog, formatSkillsCatalogBlock, toSkillSummary } from './catalog.js';
import { computeInvocation, matchesBinding, missingCapabilities } from './scope.js';
import type { DiscoveredSkill } from './types.js';

function mk(name: string, meta: Partial<SkillMeta> = {}, opts?: { trusted?: boolean; scope?: 'instance' | 'project'; level?: 'system' | 'project' }): DiscoveredSkill {
  const full: SkillMeta = {
    name,
    description: `${name} description`,
    userInvocable: true,
    disableModelInvocation: false,
    invocation: 'both',
    ...meta,
  };
  const scope = opts?.scope ?? 'instance';
  return {
    name,
    meta: full,
    body: `Body ${name}`,
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    source: { scope, level: opts?.level ?? (scope === 'project' ? 'project' : 'system'), origin: scope === 'project' ? 'project' : 'instance', dir: '/skills', trusted: opts?.trusted ?? true },
    trusted: opts?.trusted ?? true,
    mtimeMs: 0,
  };
}

describe('computeInvocation / matchesBinding / missingCapabilities', () => {
  it('computeInvocation — 4 комбинации', () => {
    expect(computeInvocation(true, false)).toBe('both');
    expect(computeInvocation(true, true)).toBe('user');
    expect(computeInvocation(false, false)).toBe('model');
    expect(computeInvocation(false, true)).toBe('none');
  });

  it('matchesBinding: пустой = все, agents/groups фильтруют', () => {
    expect(matchesBinding({}, { id: 'any' })).toBe(true);
    expect(matchesBinding({ agents: ['reviewer'] }, { id: 'developer' })).toBe(false);
    expect(matchesBinding({ agents: ['reviewer'] }, { id: 'reviewer' })).toBe(true);
    expect(matchesBinding({ groups: ['review'] }, { id: 'x', groups: ['other'] })).toBe(false);
    expect(matchesBinding({ groups: ['review'] }, { id: 'x', groups: ['review'] })).toBe(true);
  });

  it('missingCapabilities', () => {
    expect(missingCapabilities({}, ['shell'])).toEqual([]);
    expect(missingCapabilities({ requiresCapabilities: ['shell', 'file_write'] }, ['shell']))
      .toEqual(['file_write']);
  });
});

describe('buildSkillCatalog (AD-046 §4.5/§5/§6)', () => {
  it('доступный model-invocable скилл → stable', () => {
    const cat = buildSkillCatalog([mk('a')], {});
    expect(cat.stable.map((e) => e.name)).toEqual(['a']);
    expect(cat.session).toEqual([]);
  });

  it('user/none invocation не попадают в каталог модели', () => {
    const user = mk('u', { invocation: 'user', disableModelInvocation: true });
    const none = mk('n', { invocation: 'none', userInvocable: false, disableModelInvocation: true });
    const cat = buildSkillCatalog([user, none], {});
    expect(cat.stable).toEqual([]);
    expect(cat.session).toEqual([]);
  });

  it('binding по agents/groups', () => {
    const skill = mk('b', { agents: ['reviewer'], groups: ['quality'] });
    expect(buildSkillCatalog([skill], { agent: { id: 'developer', groups: ['quality'] } }).stable).toEqual([]);
    expect(buildSkillCatalog([skill], { agent: { id: 'reviewer' } }).stable).toHaveLength(0); // groups не совпали
    expect(buildSkillCatalog([skill], { agent: { id: 'reviewer', groups: ['quality'] } }).stable).toHaveLength(1);
  });

  it('недостаток capabilities → volatile session, available=false, делегирование', () => {
    const skill = mk('db', { requiresCapabilities: ['shell', 'file_write'] });
    const cat = buildSkillCatalog([skill], { capabilities: ['file_read'] });
    expect(cat.stable).toEqual([]);
    expect(cat.session).toHaveLength(1);
    expect(cat.session[0]!.available).toBe(false);
    expect(cat.session[0]!.unavailableReason).toBe('capabilities');
    const block = formatSkillsCatalogBlock(cat.session, 'ru', 'session');
    expect(block).toContain('недоступен');
    expect(block).toContain('task');
  });

  it('sessionDisabled по имени/категории/группе → volatile disabled', () => {
    const byName = mk('a');
    const byCat = mk('b', { category: 'quality' });
    const byGroup = mk('c', { groups: ['review'] });
    const cat = buildSkillCatalog([byName, byCat, byGroup], { sessionDisabled: ['a', 'quality', 'review'] });
    expect(cat.stable).toEqual([]);
    expect(cat.session).toHaveLength(3);
    for (const e of cat.session) {
      expect(e.disabled).toBe(true);
      expect(e.disabledReason).toBe('session');
    }
  });

  it('sessionEnabled → volatile enabled', () => {
    const cat = buildSkillCatalog([mk('a')], { sessionEnabled: ['a'] });
    expect(cat.stable).toEqual([]);
    expect(cat.session[0]!.enabled).toBe(true);
  });

  it('deny скрывает скилл полностью, untrusted не грузится', () => {
    const denied = buildSkillCatalog([mk('a')], { isDenied: (n) => n === 'a' });
    expect(denied.stable).toEqual([]);
    expect(denied.session).toEqual([]);

    const untrusted = buildSkillCatalog([mk('p', {}, { trusted: false, scope: 'project' })], {});
    expect(untrusted.stable).toEqual([]);
    expect(untrusted.session).toEqual([]);
  });

  it('project-скилл попадает в stable с level=project', () => {
    const cat = buildSkillCatalog([mk('p', {}, { scope: 'project', level: 'project' })], {});
    expect(cat.stable[0]!.level).toBe('project');
    expect(cat.stable[0]!.scope).toBe('project');
  });
});

describe('formatSkillsCatalogBlock', () => {
  it('заголовок, обрезка описания ≤100 и маркеры', () => {
    const long = 'x'.repeat(200);
    const block = formatSkillsCatalogBlock([
      { name: 'a', description: long, scope: 'instance', level: 'system', available: true },
      { name: 'b', description: 'short', scope: 'project', level: 'project', available: false, unavailableReason: 'capabilities' },
    ], 'ru', 'stable');
    expect(block).toContain('[СКИЛЛЫ]');
    expect(block).not.toContain('x'.repeat(101));
    expect(block).toContain('a: ' + 'x'.repeat(99) + '…');
    expect(block).toContain('b: short');
    expect(block).toContain('task');
  });

  it('пустой список → пустая строка', () => {
    expect(formatSkillsCatalogBlock([], 'ru')).toBe('');
  });
});

describe('toSkillSummary', () => {
  it('capability-aware available/unavailableReason', () => {
    const s = toSkillSummary(mk('a', { requiresCapabilities: ['shell'], agents: ['x'], tags: ['t'] }), { capabilities: [] });
    expect(s.available).toBe(false);
    expect(s.unavailableReason).toBe('capabilities');
    expect(s.requiresCapabilities).toEqual(['shell']);
    expect(s.agents).toEqual(['x']);
    expect(s.tags).toEqual(['t']);
    expect(s.modelInvocable).toBe(true);
  });
});
