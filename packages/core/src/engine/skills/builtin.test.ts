import { describe, it, expect } from 'vitest';
import { ToolCapability } from '@itphx/synth-shared';
import {
  BUILTIN_SKILLS_DIRNAME,
  BUILTIN_SOURCE,
  SKILL_CREATOR_NAME,
  SYNTH_AGENTS_MD_COMMAND,
  SYNTH_AGENTS_MD_NAME,
  SYNTH_PIPELINES_COMMAND,
  SYNTH_PIPELINES_NAME,
  SYNTH_INSTANCE_COMMAND,
  SYNTH_INSTANCE_NAME,
  SYNTH_SCHEDULES_COMMAND,
  SYNTH_SCHEDULES_NAME,
  SYNTH_SERVICE_COMMAND,
  SYNTH_SERVICE_NAME,
  SYNTH_STORAGE_RECOVERY_NAME,
  buildBuiltinSkills,
  buildSkillCreatorMeta,
  buildSynthAgentsMdMeta,
  buildSynthInstanceMeta,
  buildSynthPipelinesMeta,
  buildSynthSchedulesMeta,
  buildSynthServiceMeta,
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

describe('builtin skills автоматизации: synth-pipelines и synth-schedules', () => {
  it('оба скилла есть в buildBuiltinSkills: system-уровень, trusted', () => {
    const skills = buildBuiltinSkills({ dataDir: '/data' });
    for (const name of [SYNTH_PIPELINES_NAME, SYNTH_SCHEDULES_NAME]) {
      const skill = skills.find((s) => s.name === name);
      expect(skill, `скилл ${name} должен быть встроенным`).toBeDefined();
      expect(skill!.trusted).toBe(true);
      expect(skill!.mtimeMs).toBe(0);
      expect(skill!.source).toBe(BUILTIN_SOURCE);
      expect(skill!.source.level).toBe('system');
      expect(skill!.source.scope).toBe('instance');
      expect(skill!.meta.name).toBe(name);
      expect(skill!.meta.description.length).toBeGreaterThan(0);
    }
  });

  it('команды: pipelines/schedules, capability и мета — как задумано', () => {
    const skills = buildBuiltinSkills();
    const pipelines = skills.find((s) => s.name === SYNTH_PIPELINES_NAME)!;
    const schedules = skills.find((s) => s.name === SYNTH_SCHEDULES_NAME)!;

    expect(pipelines.meta.command).toBe(SYNTH_PIPELINES_COMMAND);
    expect(pipelines.meta.command).toBe('pipelines');
    expect(pipelines.meta.requiresCapabilities).toEqual([ToolCapability.PIPELINE]);
    expect(pipelines.meta.category).toBe('automation');
    expect(pipelines.meta.scope).toBe('instance');
    expect(pipelines.meta.mode).toBe('any');
    expect(pipelines.meta.trigger).toBe('manual');
    expect(pipelines.meta.invocation).toBe('both');
    expect(pipelines.meta.userInvocable).toBe(true);
    expect(pipelines.meta.disableModelInvocation).toBe(false);
    expect(pipelines.meta.relatedSkills).toEqual([SYNTH_SCHEDULES_NAME]);

    expect(schedules.meta.command).toBe(SYNTH_SCHEDULES_COMMAND);
    expect(schedules.meta.command).toBe('schedules');
    expect(schedules.meta.requiresCapabilities).toEqual([ToolCapability.SCHEDULE]);
    expect(schedules.meta.category).toBe('automation');
    expect(schedules.meta.scope).toBe('instance');
    expect(schedules.meta.mode).toBe('any');
    expect(schedules.meta.trigger).toBe('manual');
    expect(schedules.meta.invocation).toBe('both');
    expect(schedules.meta.userInvocable).toBe(true);
    expect(schedules.meta.disableModelInvocation).toBe(false);
    expect(schedules.meta.relatedSkills).toEqual([SYNTH_PIPELINES_NAME]);
  });

  it('все команды встроенных скиллов уникальны (иначе resolveCatalog → shadowed)', () => {
    const commands = buildBuiltinSkills()
      .map((s) => s.meta.command ?? s.name)
      .filter((c): c is string => Boolean(c));
    expect(new Set(commands).size).toBe(commands.length);
    // Команды не пересекаются с встроенными slash-командами (`/init` и др.).
    expect(commands).not.toContain('init');
    expect(commands).not.toContain('help');
    expect(commands).not.toContain('skills');
    expect(commands).not.toContain('commands');
    expect(commands).not.toContain('summary');
  });

  it('тела непустые и называют ключевые тулы', () => {
    const skills = buildBuiltinSkills();
    const pipelines = skills.find((s) => s.name === SYNTH_PIPELINES_NAME)!;
    const schedules = skills.find((s) => s.name === SYNTH_SCHEDULES_NAME)!;

    expect(pipelines.body.length).toBeGreaterThan(0);
    expect(pipelines.body).toContain('## When to use');
    expect(pipelines.body).toContain('## Tools');
    expect(pipelines.body).toContain('## Steps');
    expect(pipelines.body).toContain('## Rules');
    expect(pipelines.body).toContain('## Verify');
    expect(pipelines.body).toContain('pipeline_run');
    expect(pipelines.body).toContain('pipeline_publish');
    expect(pipelines.body).toContain('pipeline_run_resume');
    expect(pipelines.body).toContain('pipeline_instantiate');
    expect(pipelines.body).toContain('already_running');
    expect(pipelines.body).toContain('awaiting_human');

    expect(schedules.body.length).toBeGreaterThan(0);
    expect(schedules.body).toContain('## When to use');
    expect(schedules.body).toContain('## Tools');
    expect(schedules.body).toContain('## Steps');
    expect(schedules.body).toContain('## Rules');
    expect(schedules.body).toContain('## Verify');
    expect(schedules.body).toContain('schedule_save');
    expect(schedules.body).toContain('schedule_run');
    expect(schedules.body).toContain('schedule_jobs');
    expect(schedules.body).toContain('UTC');
  });

  it('мета-сборщики не переиспользуют объект между вызовами', () => {
    expect(buildSynthPipelinesMeta()).not.toBe(buildSynthPipelinesMeta());
    expect(buildSynthSchedulesMeta()).not.toBe(buildSynthSchedulesMeta());
  });
});

/**
 * Workstream A1/A2: встроенный скилл `synth-instance` — self-help по инстансу и
 * MCP (вход, реестр MCP, проекты/сессии, сетевая политика, перезапуск).
 */
describe('builtin skill synth-instance (Workstream A1/A2)', () => {
  it('присутствует, trusted/system, команда instance, category ops, trigger auto', () => {
    const skill = buildBuiltinSkills({ dataDir: '/data' }).find((s) => s.name === SYNTH_INSTANCE_NAME);
    expect(skill).toBeDefined();
    expect(skill!.trusted).toBe(true);
    expect(skill!.mtimeMs).toBe(0);
    expect(skill!.source).toBe(BUILTIN_SOURCE);
    expect(skill!.source.level).toBe('system');

    const meta = skill!.meta;
    expect(meta.name).toBe(SYNTH_INSTANCE_NAME);
    expect(meta.command).toBe(SYNTH_INSTANCE_COMMAND);
    expect(meta.category).toBe('ops');
    expect(meta.trigger).toBe('auto');
    expect(meta.scope).toBe('instance');
    expect(meta.mode).toBe('any');
    expect(meta.invocation).toBe('both');
    expect(meta.userInvocable).toBe(true);
    expect(meta.disableModelInvocation).toBe(false);
    expect(meta.requiresCapabilities).toEqual([]);
    expect(meta.relatedSkills).toEqual([SYNTH_STORAGE_RECOVERY_NAME]);
    expect(meta.tags).toEqual(expect.arrayContaining([
      'synth-instance', 'setup', 'admin', 'mcp', 'troubleshooting', 'self-help',
    ]));
  });

  it('body содержит обязательные разделы и маркеры', () => {
    const skill = buildBuiltinSkills().find((s) => s.name === SYNTH_INSTANCE_NAME)!;
    for (const section of [
      '## When to use',
      '## Know the instance',
      '## Auth in standalone',
      '## MCP model',
      '## MCP tools',
      '## Add and enable a server',
      '## Projects and sessions',
      '## Troubleshooting',
      '## Recipe: Playwright MCP',
      '## Verify',
      '## Safety',
    ]) {
      expect(skill.body, section).toContain(section);
    }
    for (const marker of [
      'synth_info',
      'synth_mcp_add',
      'project_attach',
      'list_projects',
      'Session not found',
      '{dataDir}/secrets/api-key',
      'Playwright',
    ]) {
      expect(skill.body, marker).toContain(marker);
    }

    // Порядок в «Add and enable a server»: list → add → test → enable.
    const start = skill.body.indexOf('## Add and enable a server');
    const end = skill.body.indexOf('## Projects and sessions', start);
    const section = skill.body.slice(start, end);
    const order = ['synth_mcp_list', 'synth_mcp_add', 'synth_mcp_test', 'synth_mcp_enable']
      .map((marker) => section.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('buildSynthInstanceMeta не переиспользует объект между вызовами', () => {
    expect(buildSynthInstanceMeta()).not.toBe(buildSynthInstanceMeta());
  });
});

/**
 * ADR-134: встроенный скилл `synth-service` — регистрация userspace-сервиса
 * systemd (`/service`). Unit пишется только CLI, агент файлов не трогает.
 */
describe('builtin skill synth-service (ADR-134)', () => {
  it('присутствует, trusted/system, команда service, category instance, trigger manual', () => {
    const skill = buildBuiltinSkills({ dataDir: '/data' }).find((s) => s.name === SYNTH_SERVICE_NAME);
    expect(skill).toBeDefined();
    expect(skill!.trusted).toBe(true);
    expect(skill!.mtimeMs).toBe(0);
    expect(skill!.source.level).toBe('system');

    const meta = skill!.meta;
    expect(meta.name).toBe(SYNTH_SERVICE_NAME);
    expect(meta.command).toBe(SYNTH_SERVICE_COMMAND);
    expect(meta.category).toBe('instance');
    expect(meta.trigger).toBe('manual');
    expect(meta.scope).toBe('instance');
    expect(meta.mode).toBe('any');
    expect(meta.invocation).toBe('both');
    expect(meta.userInvocable).toBe(true);
    expect(meta.disableModelInvocation).toBe(false);
    expect(meta.requiresCapabilities).toEqual([ToolCapability.SHELL, ToolCapability.QUESTION]);
    expect(meta.relatedSkills).toEqual([SYNTH_INSTANCE_NAME]);
    expect(meta.tags).toEqual(expect.arrayContaining(['synth-service', 'systemd', 'autostart']));
  });

  it('body содержит обязательные разделы и маркеры', () => {
    const skill = buildBuiltinSkills().find((s) => s.name === SYNTH_SERVICE_NAME)!;
    for (const section of [
      '## When to use',
      '## Ask the user first',
      '## Steps',
      '## Verify',
      '## Safety',
    ]) {
      expect(skill.body, section).toContain(section);
    }
    for (const marker of [
      'synth service install --print-unit',
      'synth service status --json',
      'synth connect --backend',
      'question',
      'loginctl enable-linger',
      'sudo',
      '--system',
      '/health',
    ]) {
      expect(skill.body, marker).toContain(marker);
    }
  });

  it('buildSynthServiceMeta не переиспользует объект между вызовами', () => {
    expect(buildSynthServiceMeta()).not.toBe(buildSynthServiceMeta());
  });
});
