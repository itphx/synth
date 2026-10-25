import { describe, it, expect } from 'vitest';
import {
  gitRepoConfigSchema,
  normalizeGitRepoConfig,
  projectCreateSchema,
  projectUpdateSchema,
  sshKeyCreateSchema,
  sshKeyUpdateSchema,
  sessionCreateSchema,
  sessionUpdateSchema,
  normalizeIconKey,
  normalizeColorKey,
  isProjectIconKey,
  isProjectColorKey,
  synthEventSchema,
  eventIdentitySchema,
  eventBindingSchema,
  sessionRequestSchema,
  scheduleTargetSchema,
  scheduleInputSchema,
  scheduleSchema,
  scheduleJobSchema,
  eventRouteTargetSchema,
} from './index.js';
import { PROJECT_ICON_KEYS, PROJECT_COLOR_KEYS } from '../types/index.js';

describe('normalizeGitRepoConfig (ADR-076)', () => {
  it('строка → { path }', () => {
    expect(normalizeGitRepoConfig('repos/app')).toEqual({ path: 'repos/app' });
  });

  it('пустая строка → null', () => {
    expect(normalizeGitRepoConfig('')).toBeNull();
  });

  it('объект с path → нормализованная запись', () => {
    const raw = { path: 'repos/app', name: 'app', type: 'ssh', sshKeyId: 'k1' };
    expect(normalizeGitRepoConfig(raw)).toEqual(raw);
  });

  it('legacy-объект { path, defaultBranch } сохраняется', () => {
    expect(normalizeGitRepoConfig({ path: 'r', defaultBranch: 'main' })).toEqual({
      path: 'r',
      defaultBranch: 'main',
    });
  });

  it('невалидный объект (без path) → null', () => {
    expect(normalizeGitRepoConfig({ name: 'app' })).toBeNull();
  });

  it('невалидный type → null', () => {
    expect(normalizeGitRepoConfig({ path: 'r', type: 'git' })).toBeNull();
  });

  it('не-строка/не-объект → null', () => {
    expect(normalizeGitRepoConfig(42)).toBeNull();
    expect(normalizeGitRepoConfig(null)).toBeNull();
    expect(normalizeGitRepoConfig(['r'])).toBeNull();
  });
});

describe('gitRepoConfigSchema (ADR-076)', () => {
  it('path обязателен', () => {
    expect(gitRepoConfigSchema.safeParse({}).success).toBe(false);
    expect(gitRepoConfigSchema.safeParse({ path: 'r' }).success).toBe(true);
  });

  it('type ограничен https/ssh', () => {
    expect(gitRepoConfigSchema.safeParse({ path: 'r', type: 'https' }).success).toBe(true);
    expect(gitRepoConfigSchema.safeParse({ path: 'r', type: 'ssh' }).success).toBe(true);
    expect(gitRepoConfigSchema.safeParse({ path: 'r', type: 'ftp' }).success).toBe(false);
  });
});

describe('project repos: legacy + новая форма (ADR-076)', () => {
  it('projectCreateSchema принимает string[] и объекты', () => {
    const parsed = projectCreateSchema.safeParse({
      name: 'demo',
      repos: ['repos/old', { path: 'repos/new', url: 'git@host:new.git', type: 'ssh' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('projectUpdateSchema принимает string[] и объекты', () => {
    const parsed = projectUpdateSchema.safeParse({ repos: ['repos/old'] });
    expect(parsed.success).toBe(true);
  });
});

describe('sshKeyCreateSchema (ADR-076)', () => {
  it('валидный минимальный payload', () => {
    const parsed = sshKeyCreateSchema.safeParse({
      name: 'deploy',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('deploy');
      expect(parsed.data.agentIds).toBeUndefined();
    }
  });

  it('валидный payload со всеми полями', () => {
    const parsed = sshKeyCreateSchema.safeParse({
      name: 'deploy',
      type: 'deploy',
      privateKey: 'key',
      passphrase: 'secret',
      agentIds: ['a1', 'a2'],
    });
    expect(parsed.success).toBe(true);
  });

  it('пустое имя → ошибка', () => {
    expect(sshKeyCreateSchema.safeParse({ name: '', privateKey: 'k' }).success).toBe(false);
  });

  it('пустой privateKey → ошибка', () => {
    expect(sshKeyCreateSchema.safeParse({ name: 'x', privateKey: '' }).success).toBe(false);
  });

  it('без privateKey → ошибка', () => {
    expect(sshKeyCreateSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('sshKeyUpdateSchema — частичная схема (пустой объект валиден)', () => {
    expect(sshKeyUpdateSchema.safeParse({}).success).toBe(true);
    expect(sshKeyUpdateSchema.safeParse({ name: 'renamed' }).success).toBe(true);
    // id/createdAt в схему апдейта не входят
    const parsed = sshKeyUpdateSchema.safeParse({ id: 'x', createdAt: 'now' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('id' in parsed.data).toBe(false);
      expect('createdAt' in parsed.data).toBe(false);
    }
  });
});

describe('иконки/цвета проектов и сессий', () => {
  it('канонические списки непустые, уникальные и без дублей', () => {
    expect(PROJECT_ICON_KEYS.length).toBeGreaterThanOrEqual(19 + 18);
    expect(PROJECT_COLOR_KEYS.length).toBe(16);
    expect(new Set(PROJECT_ICON_KEYS).size).toBe(PROJECT_ICON_KEYS.length);
    expect(new Set(PROJECT_COLOR_KEYS).size).toBe(PROJECT_COLOR_KEYS.length);
  });

  it('дефолтные иконки (folder/chat/cpu) входят в канонический список', () => {
    expect(PROJECT_ICON_KEYS).toContain('folder');
    expect(PROJECT_ICON_KEYS).toContain('chat');
    expect(PROJECT_ICON_KEYS).toContain('cpu');
  });

  it('isProjectIconKey/isProjectColorKey: только канонические ключи', () => {
    expect(isProjectIconKey('rocket')).toBe(true);
    expect(isProjectIconKey('🚀')).toBe(false);
    expect(isProjectIconKey(42)).toBe(false);
    expect(isProjectColorKey('a1')).toBe(true);
    expect(isProjectColorKey('primary')).toBe(false);
    expect(isProjectColorKey('blue')).toBe(false);
    expect(isProjectColorKey(null)).toBe(false);
  });

  it('normalizeIconKey: канонический ключ → как есть, всё прочее → undefined', () => {
    expect(normalizeIconKey('code')).toBe('code');
    expect(normalizeIconKey('🚀')).toBeUndefined();
    expect(normalizeIconKey('')).toBeUndefined();
    expect(normalizeIconKey(undefined)).toBeUndefined();
    expect(normalizeIconKey(null)).toBeUndefined();
  });

  it('normalizeColorKey: канонический ключ → как есть, всё прочее → undefined', () => {
    expect(normalizeColorKey('a1')).toBe('a1');
    expect(normalizeColorKey('success')).toBeUndefined();
    expect(normalizeColorKey('blue')).toBeUndefined();
    expect(normalizeColorKey('red')).toBeUndefined();
    expect(normalizeColorKey('green')).toBeUndefined();
    expect(normalizeColorKey('--primary')).toBeUndefined();
    expect(normalizeColorKey('--syntax-keyword')).toBeUndefined();
    expect(normalizeColorKey('weird')).toBeUndefined();
    expect(normalizeColorKey('🚀')).toBeUndefined();
  });

  it('projectCreate/UpdateSchema: enum-валидация icon/color, null — сброс', () => {
    expect(projectCreateSchema.safeParse({ name: 'p', icon: 'rocket', color: 'a11' }).success).toBe(true);
    expect(projectCreateSchema.safeParse({ name: 'p', icon: '🚀' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ name: 'p', color: 'blue' }).success).toBe(false);
    expect(projectCreateSchema.safeParse({ name: 'p', icon: null, color: null }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ icon: 'heart' }).success).toBe(true);
    expect(projectUpdateSchema.safeParse({ color: 'nope' }).success).toBe(false);
  });

  it('sessionCreate/UpdateSchema: icon/color с той же валидацией', () => {
    expect(sessionCreateSchema.safeParse({ icon: 'server', color: 'a3' }).success).toBe(true);
    expect(sessionCreateSchema.safeParse({ icon: 'x' }).success).toBe(false);
    expect(sessionUpdateSchema.safeParse({ color: 'a1' }).success).toBe(true);
    expect(sessionUpdateSchema.safeParse({ color: 'red' }).success).toBe(false);
    expect(sessionUpdateSchema.safeParse({ icon: null, color: null }).success).toBe(true);
  });
});

describe('synthEventSchema (ADR-089)', () => {
  it('валидное событие, identity по умолчанию — пустой объект', () => {
    const parsed = synthEventSchema.safeParse({
      id: 'evt_1',
      source: 'telegram',
      type: 'message',
      payload: { text: 'hi' },
      dedupKey: 'dedup-1',
      ts: '2026-10-08T00:00:00Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity).toEqual({});
      expect(parsed.data.payload).toEqual({ text: 'hi' });
    }
  });

  it('сохраняет переданную identity', () => {
    const parsed = synthEventSchema.safeParse({
      id: 'evt_2',
      source: 'telegram',
      type: 'message',
      payload: null,
      identity: { chatKey: 'chat:telegram:1', roles: ['USER'] },
      dedupKey: 'dedup-2',
      ts: '2026-10-08T00:00:00Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.identity.chatKey).toBe('chat:telegram:1');
      expect(parsed.data.identity.roles).toEqual(['USER']);
    }
  });

  it('отказ на отсутствующих/пустых обязательных полях', () => {
    expect(synthEventSchema.safeParse({ id: 'evt_1' }).success).toBe(false);
    expect(
      synthEventSchema.safeParse({ id: '', source: 's', type: 't', dedupKey: 'k', ts: 'x' }).success,
    ).toBe(false);
  });

  it('eventIdentitySchema: поля опциональны', () => {
    expect(eventIdentitySchema.safeParse({}).success).toBe(true);
    expect(eventIdentitySchema.safeParse({ principalId: 'u1', roles: ['ADMIN'] }).success).toBe(true);
  });
});

describe('eventBindingSchema (ADR-089)', () => {
  it('валидные режимы bound/ephemeral/queue', () => {
    for (const mode of ['bound', 'ephemeral', 'queue'] as const) {
      expect(eventBindingSchema.safeParse({ id: 'b1', source: 'telegram', mode }).success).toBe(true);
    }
  });

  it('отказ на некорректном/отсутствующем mode (drop недопустим в Binding)', () => {
    expect(eventBindingSchema.safeParse({ id: 'b1', source: 'telegram', mode: 'drop' }).success).toBe(false);
    expect(eventBindingSchema.safeParse({ id: 'b1', source: 'telegram' }).success).toBe(false);
    expect(eventBindingSchema.safeParse({ mode: 'bound' }).success).toBe(false);
  });

  it('полная привязка чата/треда к сессии', () => {
    const parsed = eventBindingSchema.safeParse({
      id: 'b1',
      source: 'telegram',
      chatKey: 'chat:telegram:1',
      threadKey: 'thread:telegram:1:2',
      sessionId: 's1',
      mode: 'bound',
      agentTemplate: 'assistant',
      project: 'p1',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('sessionRequestSchema (ADR-089)', () => {
  it('валидный минимальный запрос', () => {
    const parsed = sessionRequestSchema.safeParse({ initiator: 'external', intent: 'event' });
    expect(parsed.success).toBe(true);
  });

  it('валидный запрос со всеми полями', () => {
    const parsed = sessionRequestSchema.safeParse({
      initiator: 'user',
      intent: 'explicit',
      projectId: 'p1',
      parentId: 's0',
      agentTemplate: 'assistant',
      mode: 'ephemeral',
      ttl: '2h',
      title: 'From event',
      icon: 'rocket',
      color: 'a1',
      sessionOrigin: 'subagent',
      settings: { temperature: 0.2 },
      sourceEventId: 'evt_1',
      dedupKey: 'dedup-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('отказ на некорректном mode/initiator/intent', () => {
    expect(
      sessionRequestSchema.safeParse({ initiator: 'external', intent: 'event', mode: 'drop' }).success,
    ).toBe(false);
    expect(sessionRequestSchema.safeParse({ initiator: 'nobody', intent: 'event' }).success).toBe(false);
    expect(sessionRequestSchema.safeParse({ initiator: 'external', intent: 'other' }).success).toBe(false);
    expect(
      sessionRequestSchema.safeParse({ initiator: 'external', intent: 'event', sessionOrigin: 'other' }).success,
    ).toBe(false);
  });

  it('отказ на неканоническом icon/color', () => {
    expect(
      sessionRequestSchema.safeParse({ initiator: 'external', intent: 'event', icon: '🚀' }).success,
    ).toBe(false);
    expect(
      sessionRequestSchema.safeParse({ initiator: 'external', intent: 'event', color: 'blue' }).success,
    ).toBe(false);
  });
});

describe('schedule schemas (ADR-051 / ADR-089)', () => {
  it('scheduleTargetSchema: четыре варианта (ADR-051 / ADR-089 / ADR-101)', () => {
    expect(scheduleTargetSchema.safeParse({ mode: 'bound', sessionId: 's1' }).success).toBe(true);
    expect(scheduleTargetSchema.safeParse({ mode: 'queue', sessionId: 's1' }).success).toBe(true);
    expect(scheduleTargetSchema.safeParse({ mode: 'ephemeral', ttl: '30m' }).success).toBe(true);
    expect(scheduleTargetSchema.safeParse({ mode: 'bound' }).success).toBe(false);
    expect(scheduleTargetSchema.safeParse({ mode: 'other' }).success).toBe(false);
  });

  it('scheduleTargetSchema: pipeline-цель (ADR-101) — проект, пайплайн, версия, payload', () => {
    const parsed = scheduleTargetSchema.safeParse({
      mode: 'pipeline',
      projectId: 'proj_1',
      pipelineId: 'pl_1',
      version: 2,
      payload: { sessionId: 'ses_1' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mode === 'pipeline' && parsed.data.pipelineId).toBe('pl_1');
    // Версия и payload опциональны.
    expect(
      scheduleTargetSchema.safeParse({ mode: 'pipeline', projectId: 'proj_1', pipelineId: 'pl_1' })
        .success,
    ).toBe(true);
  });

  it('scheduleTargetSchema: pipeline-цель — негативные случаи', () => {
    // Пустой pipelineId.
    expect(
      scheduleTargetSchema.safeParse({ mode: 'pipeline', projectId: 'proj_1', pipelineId: '' })
        .success,
    ).toBe(false);
    // Нет projectId.
    expect(
      scheduleTargetSchema.safeParse({ mode: 'pipeline', pipelineId: 'pl_1' }).success,
    ).toBe(false);
    // Пустой projectId.
    expect(
      scheduleTargetSchema.safeParse({ mode: 'pipeline', projectId: '', pipelineId: 'pl_1' })
        .success,
    ).toBe(false);
    // Версия — целое ≥ 1.
    expect(
      scheduleTargetSchema.safeParse({
        mode: 'pipeline',
        projectId: 'proj_1',
        pipelineId: 'pl_1',
        version: 0,
      }).success,
    ).toBe(false);
    expect(
      scheduleTargetSchema.safeParse({
        mode: 'pipeline',
        projectId: 'proj_1',
        pipelineId: 'pl_1',
        version: 1.5,
      }).success,
    ).toBe(false);
  });

  it('eventRouteTargetSchema: четыре варианта, включая bind (ADR-089 auto-bind)', () => {
    expect(eventRouteTargetSchema.safeParse({ mode: 'bound', sessionId: 's1' }).success).toBe(true);
    expect(eventRouteTargetSchema.safeParse({ mode: 'queue', sessionId: 's1' }).success).toBe(true);
    expect(eventRouteTargetSchema.safeParse({ mode: 'ephemeral', ttl: '30m' }).success).toBe(true);
    expect(eventRouteTargetSchema.safeParse({ mode: 'bind' }).success).toBe(true);
    expect(
      eventRouteTargetSchema.safeParse({ mode: 'bind', agentTemplate: 'agent-x', project: 'p1' }).success,
    ).toBe(true);
    expect(eventRouteTargetSchema.safeParse({ mode: 'bind', agentTemplate: 42 }).success).toBe(false);
    expect(eventRouteTargetSchema.safeParse({ mode: 'other' }).success).toBe(false);
  });

  it('eventRouteTargetSchema: pipeline допустим в ephemeral/bind и отвергается в bound/queue', () => {
    const pipeline = { id: 'pl_1', step: 'publish' };
    const ephemeral = eventRouteTargetSchema.safeParse({ mode: 'ephemeral', ttl: '30m', pipeline });
    expect(ephemeral.success).toBe(true);
    expect(ephemeral.success && ephemeral.data.mode === 'ephemeral' && ephemeral.data.pipeline).toEqual(pipeline);

    const bind = eventRouteTargetSchema.safeParse({ mode: 'bind', agentTemplate: 'a', pipeline });
    expect(bind.success).toBe(true);
    expect(bind.success && bind.data.mode === 'bind' && bind.data.pipeline).toEqual(pipeline);

    // В `bound`/`queue` сессия фиксирована — ссылка на шаг пайплайна недопустима
    // и **отвергается** (строгий вариант: лишние поля не игнорируются молча).
    expect(eventRouteTargetSchema.safeParse({ mode: 'bound', sessionId: 's1', pipeline }).success).toBe(false);
    expect(eventRouteTargetSchema.safeParse({ mode: 'queue', sessionId: 's1', pipeline }).success).toBe(false);
    expect(eventRouteTargetSchema.safeParse({ mode: 'bound', sessionId: 's1', extra: 1 }).success).toBe(false);
  });

  it('eventRouteTargetSchema: pipeline требует непустые id/step', () => {
    expect(
      eventRouteTargetSchema.safeParse({ mode: 'ephemeral', pipeline: { id: '', step: 'publish' } }).success,
    ).toBe(false);
    expect(
      eventRouteTargetSchema.safeParse({ mode: 'ephemeral', pipeline: { id: 'pl_1', step: '' } }).success,
    ).toBe(false);
    expect(
      eventRouteTargetSchema.safeParse({ mode: 'bind', pipeline: { id: 'pl_1', step: 'publish' } }).success,
    ).toBe(true);
  });

  it('eventRouteTargetSchema: сериализация/парсинг pipeline round-trip', () => {
    const target = { mode: 'ephemeral' as const, ttl: '30m', pipeline: { id: 'pl_1', step: 'publish' } };
    const parsed = eventRouteTargetSchema.parse(target);
    expect(parsed).toEqual(target);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(target);
  });

  it('scheduleInputSchema: enabled по умолчанию true, ровно один триггер', () => {
    const parsed = scheduleInputSchema.safeParse({
      name: 'job',
      every: '1h',
      target: { mode: 'bound', sessionId: 's1' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.enabled).toBe(true);

    expect(scheduleInputSchema.safeParse({ name: 'x', target: { mode: 'bound', sessionId: 's1' } }).success).toBe(false);
    expect(
      scheduleInputSchema.safeParse({
        name: 'x',
        cron: '* * * * *',
        every: '1h',
        target: { mode: 'bound', sessionId: 's1' },
      }).success,
    ).toBe(false);
    expect(scheduleInputSchema.safeParse({ name: '', every: '1h', target: { mode: 'bound', sessionId: 's1' } }).success).toBe(false);
  });

  it('scheduleSchema: принимает служебные поля', () => {
    const parsed = scheduleSchema.safeParse({
      id: 'sch_1',
      name: 'job',
      enabled: true,
      every: '1h',
      target: { mode: 'ephemeral', agentTemplate: 'triage' },
      payload: { foo: 'bar' },
      catchUp: 'once',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastRunAt: '2026-01-01T01:00:00.000Z',
      nextRunAt: '2026-01-01T02:00:00.000Z',
      lastStatus: 'ok',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.catchUp).toBe('once');
  });

  it('scheduleInputSchema: catchUp опционален (skip/once)', () => {
    const base = { name: 'x', every: '1h', target: { mode: 'bound', sessionId: 's1' } };
    expect(scheduleInputSchema.safeParse(base).success).toBe(true);
    expect(scheduleInputSchema.safeParse({ ...base, catchUp: 'once' }).success).toBe(true);
    expect(scheduleInputSchema.safeParse({ ...base, catchUp: 'skip' }).success).toBe(true);
    expect(scheduleInputSchema.safeParse({ ...base, catchUp: 'never' }).success).toBe(false);
  });

  it('scheduleJobSchema: запись Job-истории', () => {
    const parsed = scheduleJobSchema.safeParse({
      id: 'job_1',
      scheduleId: 'sch_1',
      scheduleName: 'nightly',
      trigger: 'catchup',
      status: 'skipped',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      target: { mode: 'bound', sessionId: 's1' },
      reason: 'missed',
    });
    expect(parsed.success).toBe(true);

    expect(
      scheduleJobSchema.safeParse({
        id: 'job_2',
        scheduleId: 'sch_1',
        scheduleName: 'nightly',
        trigger: 'other',
        status: 'ok',
        startedAt: 'x',
        finishedAt: 'x',
        durationMs: 0,
        target: { mode: 'bound', sessionId: 's1' },
      }).success,
    ).toBe(false);
  });

  it('scheduleJobSchema: pipeline-Job (ADR-101) — decision/pipelineId/runId', () => {
    const parsed = scheduleJobSchema.safeParse({
      id: 'job_3',
      scheduleId: 'sch_1',
      scheduleName: 'pipeline',
      trigger: 'cron',
      status: 'ok',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      target: { mode: 'pipeline', projectId: 'proj_1', pipelineId: 'pl_1' },
      decision: 'pipeline',
      pipelineId: 'pl_1',
      runId: 'run_1',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.runId).toBe('run_1');
  });
});
