/**
 * PROP-126 §3: резолв `$`-скиллов (пользовательский вызов скилла в тексте
 * сообщения) — дедуп, порядок, гейты trust/scope/capabilities, code-блоки.
 */
import { describe, it, expect } from 'vitest';
import { resolveDollarSkills } from './dollar-skills.js';
import { toSkillSummary } from '../skills/catalog.js';
import type { DiscoveredSkill, LoadedSkill, SkillRuntime } from '../skills/types.js';
import type { SkillMeta } from '@itphx/synth-shared';

interface SkillOpts {
  trusted?: boolean;
  userInvocable?: boolean;
  requiresCapabilities?: string[];
  agents?: string[];
  groups?: string[];
}

function discovered(name: string, opts: SkillOpts = {}): DiscoveredSkill {
  const meta: SkillMeta = {
    name,
    description: `${name} desc`,
    userInvocable: opts.userInvocable ?? true,
    disableModelInvocation: false,
    invocation: opts.userInvocable === false ? 'model' : 'both',
    ...(opts.requiresCapabilities ? { requiresCapabilities: opts.requiresCapabilities as never } : {}),
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.groups ? { groups: opts.groups } : {}),
  };
  return {
    name,
    meta,
    body: `Body of ${name}`,
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    source: { scope: 'instance', level: 'system', origin: 'instance', dir: '/skills', trusted: opts.trusted ?? true },
    trusted: opts.trusted ?? true,
    mtimeMs: 0,
  };
}

function loaded(skill: DiscoveredSkill, files: string[] = []): LoadedSkill {
  return { summary: toSkillSummary(skill), meta: skill.meta, body: skill.body, dir: skill.dir, files };
}

function makeRuntime(skills: DiscoveredSkill[]): SkillRuntime {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    buildCatalog: async () => ({ stable: [], session: [] }),
    get: async (name) => byName.get(name),
    load: async (name) => {
      const skill = byName.get(name);
      return skill ? loaded(skill) : undefined;
    },
    readSupportingFile: async () => undefined,
  };
}

describe('PROP-126 §3: resolveDollarSkills ($name)', () => {
  it('нет $ — пустой результат, prompt не собирается', async () => {
    const res = await resolveDollarSkills({
      text: 'просто текст без скиллов',
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    expect(res.skills).toEqual([]);
    expect(res.unavailable).toEqual([]);
    expect(res.prompt).toBeUndefined();
  });

  it('один $ — тело скилла в prompt, имя в skills', async () => {
    const res = await resolveDollarSkills({
      text: 'сделай ревью $api-review',
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    expect(res.skills).toEqual(['api-review']);
    expect(res.unavailable).toEqual([]);
    expect(res.prompt).toContain('[skills requested by user: api-review]');
    expect(res.prompt).toContain('<skill_content name="api-review">');
    expect(res.prompt).toContain('Body of api-review');
  });

  it('несколько $ — все загружены, порядок вызова сохранён', async () => {
    const res = await resolveDollarSkills({
      text: '$zeta и $alpha и $mid',
      skillRuntime: makeRuntime([discovered('zeta'), discovered('alpha'), discovered('mid')]),
    });
    expect(res.skills).toEqual(['zeta', 'alpha', 'mid']);
    const prompt = res.prompt!;
    expect(prompt.indexOf('name="zeta"')).toBeLessThan(prompt.indexOf('name="alpha"'));
    expect(prompt.indexOf('name="alpha"')).toBeLessThan(prompt.indexOf('name="mid"'));
  });

  it('дубликаты $ схлопываются', async () => {
    const res = await resolveDollarSkills({
      text: '$alpha $alpha и ещё $alpha',
      skillRuntime: makeRuntime([discovered('alpha')]),
    });
    expect(res.skills).toEqual(['alpha']);
    expect((res.prompt!.match(/<skill_content name="alpha">/g) ?? []).length).toBe(1);
  });

  it('неизвестный скилл → unavailable, тело не грузится', async () => {
    const res = await resolveDollarSkills({
      text: '$ghost',
      skillRuntime: makeRuntime([discovered('other')]),
    });
    expect(res.skills).toEqual([]);
    expect(res.unavailable).toEqual(['ghost']);
    expect(res.reasons?.ghost).toBe('unknown');
    expect(res.prompt).toBeUndefined();
  });

  it('недоверенный скилл → unavailable (untrusted)', async () => {
    const res = await resolveDollarSkills({
      text: '$untrusted',
      skillRuntime: makeRuntime([discovered('untrusted', { trusted: false })]),
    });
    expect(res.unavailable).toEqual(['untrusted']);
    expect(res.reasons?.untrusted).toBe('untrusted');
    expect(res.prompt).toBeUndefined();
  });

  it('скилл без user-invocable → unavailable (invocation)', async () => {
    const res = await resolveDollarSkills({
      text: '$model-only',
      skillRuntime: makeRuntime([discovered('model-only', { userInvocable: false })]),
    });
    expect(res.unavailable).toEqual(['model-only']);
    expect(res.reasons?.['model-only']).toBe('invocation');
  });

  it('scope: отключённый сессией скилл → unavailable (scope)', async () => {
    const res = await resolveDollarSkills({
      text: '$off',
      skillRuntime: makeRuntime([discovered('off')]),
      scope: { sessionDisabled: ['off'] },
    });
    expect(res.unavailable).toEqual(['off']);
    expect(res.reasons?.off).toBe('scope');
  });

  it('scope: проектный hard-gate → unavailable (scope)', async () => {
    const res = await resolveDollarSkills({
      text: '$proj',
      skillRuntime: makeRuntime([discovered('proj')]),
      scope: { projectEnabled: [] },
    });
    expect(res.reasons?.proj).toBe('scope');
  });

  it('binding: скилл не привязан к агенту → unavailable (binding)', async () => {
    const res = await resolveDollarSkills({
      text: '$bound',
      skillRuntime: makeRuntime([discovered('bound', { agents: ['leader'] })]),
      agent: { id: 'fixer' },
    });
    expect(res.unavailable).toEqual(['bound']);
    expect(res.reasons?.bound).toBe('binding');
  });

  it('capabilities: не хватает → unavailable (capabilities)', async () => {
    const res = await resolveDollarSkills({
      text: '$db',
      skillRuntime: makeRuntime([discovered('db', { requiresCapabilities: ['shell'] })]),
      capabilities: ['file_read'],
    });
    expect(res.unavailable).toEqual(['db']);
    expect(res.reasons?.db).toBe('capabilities');
  });

  it('permission deny по скиллу → unavailable (permission)', async () => {
    const res = await resolveDollarSkills({
      text: '$denied',
      skillRuntime: makeRuntime([discovered('denied')]),
      permissionConfig: { rules: { skill: 'deny' } } as never,
    });
    expect(res.unavailable).toEqual(['denied']);
    expect(res.reasons?.denied).toBe('permission');
  });

  it('$ внутри code-блока не распознаётся', async () => {
    const res = await resolveDollarSkills({
      text: 'смотри код:\n```bash\necho $api-review\n```\nвсё',
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    expect(res.skills).toEqual([]);
    expect(res.prompt).toBeUndefined();
  });

  it('$ внутри inline-кода не распознаётся', async () => {
    const res = await resolveDollarSkills({
      text: 'переменная `$api-review` — не скилл',
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    expect(res.skills).toEqual([]);
  });

  it('экранированный \\$ не распознаётся', async () => {
    const res = await resolveDollarSkills({
      text: 'напиши \\$api-review буквально',
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    expect(res.skills).toEqual([]);
  });

  it('часть скиллов доступна, часть — нет: в prompt только доступные', async () => {
    const res = await resolveDollarSkills({
      text: '$good $ghost',
      skillRuntime: makeRuntime([discovered('good')]),
    });
    expect(res.skills).toEqual(['good']);
    expect(res.unavailable).toEqual(['ghost']);
    expect(res.prompt).toContain('name="good"');
    expect(res.prompt).not.toContain('ghost');
  });

  it('исходный текст не меняется — резолвер только возвращает prompt', async () => {
    const text = 'сделай ревью $api-review';
    const res = await resolveDollarSkills({
      text,
      skillRuntime: makeRuntime([discovered('api-review')]),
    });
    expect(text).toBe('сделай ревью $api-review');
    // В prompt — тело скилла, а не переписанный текст сообщения.
    expect(res.prompt).toContain('<skill_content name="api-review">');
    expect(res.prompt).not.toContain('сделай ревью');
  });
});
