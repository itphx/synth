import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@itphx/synth-shared';
import { skillTool } from './skill.js';
import { toSkillSummary } from '../skills/catalog.js';
import type { DiscoveredSkill, LoadedSkill, SkillRuntime } from '../skills/types.js';
import { SKILL_MAX_LINES } from '../skills/loader.js';

function discovered(name: string, opts?: { trusted?: boolean; requiresCapabilities?: string[] }): DiscoveredSkill {
  return {
    name,
    meta: {
      name,
      description: `${name} desc`,
      userInvocable: true,
      disableModelInvocation: false,
      invocation: 'both',
      ...(opts?.requiresCapabilities ? { requiresCapabilities: opts.requiresCapabilities as never } : {}),
    },
    body: `Body of ${name}`,
    dir: `/skills/${name}`,
    file: `/skills/${name}/SKILL.md`,
    source: { scope: 'instance', level: 'system', origin: 'instance', dir: '/skills', trusted: opts?.trusted ?? true },
    trusted: opts?.trusted ?? true,
    mtimeMs: 0,
  };
}

function loaded(skill: DiscoveredSkill, files: string[] = []): LoadedSkill {
  return { summary: toSkillSummary(skill), meta: skill.meta, body: skill.body, dir: skill.dir, files };
}

function makeRuntime(skill: DiscoveredSkill, files: string[] = [], supporting: Record<string, string> = {}): SkillRuntime {
  return {
    buildCatalog: async () => ({ stable: [], session: [] }),
    get: async (name) => (name === skill.name ? skill : undefined),
    load: async (name) => (name === skill.name ? loaded(skill, files) : undefined),
    readSupportingFile: async (name, rel) => (name === skill.name ? supporting[rel] : undefined),
  };
}

function ctx(extra: Record<string, unknown>, agentRole?: string): ToolContext {
  return {
    sessionId: 's1',
    messageId: 'm1',
    workingDir: '/work',
    agentRole,
    extra,
  };
}

describe('core-тул skill (AD-046 §5)', () => {
  it('возвращает <skill_content> + base directory + ≤10 файлов', async () => {
    const skill = discovered('api-review');
    const files = Array.from({ length: 14 }, (_, i) => `references/f${i}.md`);
    const runtime = makeRuntime(skill, files);
    const res = await skillTool.execute({ name: 'api-review' }, ctx({ skillRuntime: runtime }));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('<skill_content name="api-review">');
    expect(res.content).toContain('Body of api-review');
    expect(res.content).toContain('Base directory for this skill: file:///skills/api-review');
    expect(res.content).toContain('<skill_files>');
    // не более 10 путей, формат <file>путь</file> (AD-046 §5)
    expect((res.content.match(/<file>references\/f\d+\.md<\/file>/g) ?? []).length).toBe(10);
    expect(res.content).not.toContain('references/f10.md');
  });

  it('обрезает вывод до 2000 строк', async () => {
    const skill = discovered('big');
    skill.body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const res = await skillTool.execute({ name: 'big' }, ctx({ skillRuntime: makeRuntime(skill) }));
    const lines = res.content.split('\n');
    // ≤ 2000 строк тела + служебные строки обёртки/marker
    expect(lines.length).toBeLessThan(SKILL_MAX_LINES + 15);
    expect(res.content).toContain('output truncated');
  });

  it('обрезает вывод до 50 KB', async () => {
    const skill = discovered('huge');
    skill.body = 'x'.repeat(120 * 1024);
    const res = await skillTool.execute({ name: 'huge' }, ctx({ skillRuntime: makeRuntime(skill) }));
    expect(Buffer.byteLength(res.content, 'utf-8')).toBeLessThanOrEqual(50 * 1024 + 64);
    expect(res.content).toContain('output truncated');
  });

  it('file_path читает supporting-файл', async () => {
    const skill = discovered('s');
    const runtime = makeRuntime(skill, [], { 'references/a.md': 'FILE CONTENT' });
    const res = await skillTool.execute({ name: 's', file_path: 'references/a.md' }, ctx({ skillRuntime: runtime }));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('FILE CONTENT');
  });

  it('file_path не найден → ошибка', async () => {
    const skill = discovered('s');
    const res = await skillTool.execute({ name: 's', file_path: 'nope.md' }, ctx({ skillRuntime: makeRuntime(skill) }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('nope.md');
  });

  it('скилл не найден', async () => {
    const res = await skillTool.execute({ name: 'ghost' }, ctx({ skillRuntime: makeRuntime(discovered('other')) }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('ghost');
  });

  it('недоверенный скилл не загружается', async () => {
    const skill = discovered('p', { trusted: false });
    const res = await skillTool.execute({ name: 'p' }, ctx({ skillRuntime: makeRuntime(skill) }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('untrusted');
  });

  it('capability-aware: делегирование через task', async () => {
    const skill = discovered('db', { requiresCapabilities: ['shell', 'file_write'] });
    const runtime = makeRuntime(skill);
    const agentRegistry = { get: () => ({ capabilities: ['file_read'] }) };
    const res = await skillTool.execute({ name: 'db' }, ctx({ skillRuntime: runtime, agentRegistry }, 'reviewer'));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('shell');
    expect(res.content).toContain('task');
    expect(res.content).toContain('reviewer');
  });

  it('без runtime — ошибка зависимостей', async () => {
    const res = await skillTool.execute({ name: 'x' }, ctx({}));
    expect(res.isError).toBe(true);
  });

  it('нет имени в аргументах — args_error', async () => {
    const res = await skillTool.execute({}, ctx({ skillRuntime: makeRuntime(discovered('x')) }));
    expect(res.isError).toBe(true);
  });

  it('AD-046 §4.5: projectEnabled=[] → skill.scope_disabled (reason=project)', async () => {
    const runtime = makeRuntime(discovered('a'));
    const res = await skillTool.execute(
      { name: 'a' },
      ctx({ skillRuntime: runtime, skillScope: { projectEnabled: [], defaultOn: ['a'] } }),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('disabled');
    expect(res.content).toContain('project');
    expect(res.metadata).toMatchObject({ disabledReason: 'project' });
  });

  it('AD-046 §4.5: системный hard-gate → skill.scope_disabled (reason=system)', async () => {
    const runtime = makeRuntime(discovered('a'));
    const res = await skillTool.execute(
      { name: 'a' },
      ctx({ skillRuntime: runtime, skillScope: { systemDisabled: { skills: ['a'] }, defaultOn: ['a'] } }),
    );
    expect(res.isError).toBe(true);
    expect(res.metadata).toMatchObject({ disabledReason: 'system' });
  });

  it('AD-046 §4.5: скилл вне снапшота и без включения → scope_disabled (reason=session)', async () => {
    const runtime = makeRuntime(discovered('a'));
    const res = await skillTool.execute(
      { name: 'a' },
      ctx({ skillRuntime: runtime, skillScope: { defaultOn: [] } }),
    );
    expect(res.isError).toBe(true);
    expect(res.metadata).toMatchObject({ disabledReason: 'session' });
  });

  it('AD-046 §4.5: снапшот включает скилл → загружается', async () => {
    const runtime = makeRuntime(discovered('a'));
    const res = await skillTool.execute(
      { name: 'a' },
      ctx({ skillRuntime: runtime, skillScope: { defaultOn: ['a'] } }),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Body of a');
  });
});
