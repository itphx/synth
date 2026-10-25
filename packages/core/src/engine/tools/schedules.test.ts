/**
 * ADR-051: тесты встроенных тулов расписаний (`engine/tools/schedules.ts`).
 *
 * Контекст — по образцу `pipeline-authoring.test.ts`: настоящий `SessionManager` +
 * `FileStore` (сессия и её атрибуция), `ProjectStore` (проект и его роли) и
 * порты в памяти (`MemoryScheduleRepository`/`MemoryJobRepository`/
 * `MemoryProjectPipelineRepository`) — чтобы тест не зависел от ФС и проверял
 * тулы, а не хранилище. Планировщик — фейк (`refreshNextRun`/`runNow`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Schedule, ScheduleJob, ToolContext } from '@itphx/synth-shared';
import { generateId, ProjectRole } from '@itphx/synth-shared';
import {
  scheduleListTool,
  scheduleGetTool,
  scheduleSaveTool,
  scheduleDeleteTool,
  scheduleRunTool,
  scheduleJobsTool,
} from './schedules.js';
import { SessionManager } from '../../sessions/manager.js';
import { FileStore } from '../../storage/file-store.js';
import { ProjectStore } from '../../storage/project-store.js';
import { MemoryScheduleRepository, MemoryJobRepository } from '../../storage/memory/scheduler.js';
import { MemoryProjectPipelineRepository } from '../../storage/memory/pipelines.js';
import type { SchedulerService } from '../scheduler/scheduler.js';

/** Фейк планировщика: пересчёт `nextRunAt` и принудительный запуск. */
class FakeScheduler {
  refreshCalls: string[] = [];
  runCalls: string[] = [];

  constructor(private readonly _schedules: MemoryScheduleRepository) {}

  async refreshNextRun(id: string): Promise<Schedule | null> {
    this.refreshCalls.push(id);
    return this._schedules.get(id);
  }

  async runNow(id: string): Promise<Schedule | null> {
    this.runCalls.push(id);
    const schedule = await this._schedules.get(id);
    if (!schedule) return null;
    return this._schedules.markRun(id, { at: new Date().toISOString(), status: 'ok' });
  }
}

/** Запись Job-истории для проверок журнала. */
function makeJob(scheduleId: string, startedAt: string, trigger: ScheduleJob['trigger'] = 'cron'): ScheduleJob {
  return {
    id: `job_${generateId()}`,
    scheduleId,
    scheduleName: 'Расписание',
    trigger,
    status: 'ok',
    startedAt,
    finishedAt: startedAt,
    durationMs: 12,
    target: { mode: 'bound', sessionId: 's1' },
    decision: 'bound',
  };
}

describe('Встроенные тулы расписаний (ADR-051, schedules.ts)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let projectStore: ProjectStore;
  let schedules: MemoryScheduleRepository;
  let jobs: MemoryJobRepository;
  let pipelines: MemoryProjectPipelineRepository;
  let scheduler: FakeScheduler;
  let sessionId: string;
  let projectId: string;

  /**
   * Привязать сессию к проекту с заданной атрибуцией.
   *
   * `targetProjectId: null` — отвязать сессию от проекта (второй аргумент
   * `undefined` означал бы «дефолт», поэтому «нет проекта» — это `null`).
   */
  async function bindSession(
    userId?: string,
    ownerId?: string,
    targetProjectId: string | null = projectId,
  ): Promise<void> {
    await sessionManager.withLock(sessionId, async (s) => {
      s.projectId = targetProjectId ?? undefined;
      s.userId = userId;
      s.ownerId = ownerId;
      await sessionManager.saveSession(s);
    });
  }

  function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
    return {
      sessionId,
      messageId: generateId(),
      abortSignal: new AbortController().signal,
      workingDir: tmpDir,
      extra: {
        sessionManager,
        projectStore,
        sessionId,
        automation: {
          schedules,
          jobs,
          pipelines,
          scheduler: scheduler as unknown as SchedulerService,
        },
        ...extra,
      },
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-schedule-tools-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    projectStore = new ProjectStore({ dataDir: tmpDir });
    schedules = new MemoryScheduleRepository();
    jobs = new MemoryJobRepository();
    pipelines = new MemoryProjectPipelineRepository();
    scheduler = new FakeScheduler(schedules);

    const project = projectStore.create('Schedule Project', 'u1');
    await projectStore.save(project);
    projectId = project.id;

    const session = await sessionManager.createSession({ title: 'Schedules' });
    sessionId = session.id;
    await bindSession('u1', 'u1');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('schedule_list на пустом инстансе → list_empty, не ошибка', async () => {
    const result = await scheduleListTool.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('No schedules');
    expect(result.metadata?.count).toBe(0);
  });

  it('создание своего расписания без проекта у сессии работает; ownerId = userId, refreshNextRun вызван', async () => {
    await bindSession('u1', 'u1', null);

    const created = await scheduleSaveTool.execute(
      {
        name: 'Моё расписание',
        cron: '0 9 * * *',
        target: { mode: 'bound', sessionId },
      },
      makeCtx(),
    );
    expect(created.isError).toBeUndefined();
    const scheduleId = created.metadata?.scheduleId as string;
    expect(scheduleId).toMatch(/^sch_/);

    const stored = await schedules.get(scheduleId);
    expect(stored?.ownerId).toBe('u1');
    expect(stored?.cron).toBe('0 9 * * *');
    expect(stored?.enabled).toBe(true);

    // После записи пересчитан следующий запуск.
    expect(scheduler.refreshCalls).toContain(scheduleId);
  });

  it('schedule_list показывает расписание и скрывает чужие', async () => {
    const mine = await scheduleSaveTool.execute(
      { name: 'Моё', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    const mineId = mine.metadata?.scheduleId as string;

    // Расписание чужого владельца с целью чужого проекта — вне области.
    const foreign = projectStore.create('Чужой проект', 'other');
    await projectStore.save(foreign);
    await schedules.create({
      name: 'Чужое',
      enabled: true,
      cron: '0 9 * * *',
      ownerId: 'other',
      target: { mode: 'pipeline', projectId: foreign.id, pipelineId: 'pl_x' },
    });

    const list = await scheduleListTool.execute({}, makeCtx());
    expect(list.isError).toBeUndefined();
    expect(list.content).toContain(mineId);
    expect(list.content).not.toContain('Чужое');
    expect(list.metadata?.count).toBe(1);
    // Строка списка — id, имя, состояние, триггер, цель, next/last.
    expect(list.content).toContain(`«Моё» [on] 0 9 * * * → session ${sessionId}`);
  });

  it('создание с невалидным cron → invalid с проблемой', async () => {
    const result = await scheduleSaveTool.execute(
      { name: 'Битое', cron: 'bad cron', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid schedule');
    expect(result.content).toContain('cron');
    expect(await schedules.list()).toHaveLength(0);
  });

  it('создание с двумя триггерами → invalid с проблемой', async () => {
    const result = await scheduleSaveTool.execute(
      {
        name: 'Два триггера',
        cron: '0 9 * * *',
        every: '15m',
        target: { mode: 'bound', sessionId },
      },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid schedule');
    expect(await schedules.list()).toHaveLength(0);
  });

  it('bound на чужую сессию → target_forbidden; на текущую — успех', async () => {
    // Сессия другого пользователя в том же проекте.
    const other = await sessionManager.createSession({ title: 'Чужая' });
    await sessionManager.withLock(other.id, async (s) => {
      s.projectId = projectId;
      s.userId = 'u2';
      s.ownerId = 'u2';
      await sessionManager.saveSession(s);
    });

    const forbidden = await scheduleSaveTool.execute(
      { name: 'Чужая цель', cron: '0 9 * * *', target: { mode: 'bound', sessionId: other.id } },
      makeCtx(),
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content).toContain('not allowed');
    expect(await schedules.list()).toHaveLength(0);

    const ok = await scheduleSaveTool.execute(
      { name: 'Своя цель', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    expect(ok.isError).toBeUndefined();
    expect(ok.metadata?.scheduleId).toMatch(/^sch_/);
  });

  it('pipeline-цель: без публикации → not_published; с публикацией — успех; чужой projectId → отказ', async () => {
    const now = new Date().toISOString();
    await pipelines.savePipeline({
      id: 'pl_draft',
      scope: 'project',
      projectId,
      name: 'Черновик',
      draftVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const notPublished = await scheduleSaveTool.execute(
      {
        name: 'Пайплайн',
        cron: '0 9 * * *',
        target: { mode: 'pipeline', projectId, pipelineId: 'pl_draft' },
      },
      makeCtx(),
    );
    expect(notPublished.isError).toBe(true);
    expect(notPublished.content).toContain('no published version');

    await pipelines.savePipeline({
      id: 'pl_published',
      scope: 'project',
      projectId,
      name: 'Опубликованный',
      draftVersion: 2,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const ok = await scheduleSaveTool.execute(
      {
        name: 'Пайплайн',
        cron: '0 9 * * *',
        target: { mode: 'pipeline', projectId, pipelineId: 'pl_published' },
      },
      makeCtx(),
    );
    expect(ok.isError).toBeUndefined();
    expect(ok.metadata?.scheduleId).toMatch(/^sch_/);

    // Чужой проект в цели — писать в чужой проект нельзя.
    const foreign = projectStore.create('Чужой проект', 'other');
    await projectStore.save(foreign);
    const foreignTarget = await scheduleSaveTool.execute(
      {
        name: 'Чужой пайплайн',
        cron: '0 9 * * *',
        target: { mode: 'pipeline', projectId: foreign.id, pipelineId: 'pl_published' },
      },
      makeCtx(),
    );
    expect(foreignTarget.isError).toBe(true);
    expect(foreignTarget.content).toContain('not allowed');
  });

  it('чужое расписание → not_found в schedule_get; расписание проекта читает VIEWER, но мутировать нельзя', async () => {
    // Расписание чужого владельца с целью чужого проекта — вне области.
    const foreign = projectStore.create('Чужой проект', 'other');
    await projectStore.save(foreign);
    const foreignSchedule = await schedules.create({
      name: 'Чужое',
      enabled: true,
      cron: '0 9 * * *',
      ownerId: 'other',
      target: { mode: 'pipeline', projectId: foreign.id, pipelineId: 'pl_x' },
    });

    const get = await scheduleGetTool.execute({ schedule_id: foreignSchedule.id }, makeCtx());
    expect(get.isError).toBe(true);
    expect(get.content).toContain('not found');

    // Расписание проекта — его читает участник с ролью VIEWER.
    const projectSchedule = await schedules.create({
      name: 'Проектное',
      enabled: true,
      cron: '0 9 * * *',
      ownerId: 'u1',
      target: { mode: 'ephemeral', project: projectId },
    });

    const project = (await projectStore.load(projectId))!;
    project.members['u2'] = ProjectRole.VIEWER;
    await projectStore.save(project);
    await bindSession('u2', undefined);

    const read = await scheduleGetTool.execute({ schedule_id: projectSchedule.id }, makeCtx());
    expect(read.isError).toBeUndefined();
    expect(read.metadata?.scheduleId).toBe(projectSchedule.id);
    expect(read.metadata?.enabled).toBe(true);

    const remove = await scheduleDeleteTool.execute({ schedule_id: projectSchedule.id }, makeCtx());
    expect(remove.isError).toBe(true);
    expect(remove.content).toContain('permission');

    const run = await scheduleRunTool.execute({ schedule_id: projectSchedule.id }, makeCtx());
    expect(run.isError).toBe(true);
    expect(run.content).toContain('permission');

    // Расписание не тронуто.
    expect(await schedules.get(projectSchedule.id)).not.toBeNull();
  });

  it('schedule_run → статус в тексте и metadata; без scheduler → deps_unavailable', async () => {
    const created = await scheduleSaveTool.execute(
      { name: 'Запуск', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    const scheduleId = created.metadata?.scheduleId as string;

    const ran = await scheduleRunTool.execute({ schedule_id: scheduleId }, makeCtx());
    expect(ran.isError).toBeUndefined();
    expect(ran.content).toContain('ok');
    expect(ran.metadata?.scheduleId).toBe(scheduleId);
    expect(ran.metadata?.status).toBe('ok');
    expect(scheduler.runCalls).toContain(scheduleId);

    const ctx = makeCtx({ automation: { schedules, jobs, pipelines } });
    const withoutScheduler = await scheduleRunTool.execute({ schedule_id: scheduleId }, ctx);
    expect(withoutScheduler.isError).toBe(true);
    expect(withoutScheduler.content).toContain('schedule runtime is unavailable');
  });

  it('schedule_jobs фильтрует по scheduleId, уважает limit; пусто → jobs_empty', async () => {
    const created = await scheduleSaveTool.execute(
      { name: 'Журнал', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    const scheduleId = created.metadata?.scheduleId as string;

    const empty = await scheduleJobsTool.execute({}, makeCtx());
    expect(empty.isError).toBeUndefined();
    expect(empty.content).toBe('No schedule runs');
    expect(empty.metadata?.count).toBe(0);

    await jobs.append(makeJob(scheduleId, '2026-01-01T00:00:00.000Z'));
    await jobs.append(makeJob(scheduleId, '2026-01-02T00:00:00.000Z'));
    await jobs.append(makeJob('sch_other', '2026-01-03T00:00:00.000Z'));

    const list = await scheduleJobsTool.execute({ schedule_id: scheduleId }, makeCtx());
    expect(list.isError).toBeUndefined();
    expect(list.metadata?.count).toBe(2);
    expect(list.content).toContain('2026-01-01T00:00:00.000Z');
    expect(list.content).not.toContain('2026-01-03T00:00:00.000Z');

    // limit — последние N записей.
    const limited = await scheduleJobsTool.execute({ limit: 1 }, makeCtx());
    expect(limited.metadata?.count).toBe(1);
    expect(limited.content).toContain('2026-01-02T00:00:00.000Z');
    expect(limited.content).not.toContain('2026-01-01T00:00:00.000Z');
  });

  it('schedule_list по умолчанию показывает выключенные; include_disabled: false — только включённые', async () => {
    const enabled = await scheduleSaveTool.execute(
      { name: 'Включено', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    const disabled = await scheduleSaveTool.execute(
      {
        schedule_id: enabled.metadata?.scheduleId as string,
        enabled: false,
      },
      makeCtx(),
    );
    expect(disabled.isError).toBeUndefined();

    const all = await scheduleListTool.execute({}, makeCtx());
    expect(all.metadata?.count).toBe(1);
    expect(all.content).toContain('[off]');

    const onlyEnabled = await scheduleListTool.execute({ include_disabled: false }, makeCtx());
    expect(onlyEnabled.metadata?.count).toBe(0);
    expect(onlyEnabled.content).toBe('No schedules');
  });

  it('schedule_delete удаляет расписание; повторный вызов → not_found', async () => {
    const created = await scheduleSaveTool.execute(
      { name: 'Удаляемое', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    const scheduleId = created.metadata?.scheduleId as string;

    const deleted = await scheduleDeleteTool.execute({ schedule_id: scheduleId }, makeCtx());
    expect(deleted.isError).toBeUndefined();
    expect(deleted.content).toContain(scheduleId);
    expect(await schedules.get(scheduleId)).toBeNull();

    const again = await scheduleDeleteTool.execute({ schedule_id: scheduleId }, makeCtx());
    expect(again.isError).toBe(true);
    expect(again.content).toContain('not found');
  });

  it('schedule_get отдаёт JSON расписания и признак enabled', async () => {
    const created = await scheduleSaveTool.execute(
      { name: 'Деталь', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      makeCtx(),
    );
    const scheduleId = created.metadata?.scheduleId as string;

    const got = await scheduleGetTool.execute({ schedule_id: scheduleId }, makeCtx());
    expect(got.isError).toBeUndefined();
    expect(got.metadata?.scheduleId).toBe(scheduleId);
    expect(got.metadata?.enabled).toBe(true);
    expect(got.content).toContain('"schedule"');
    expect(got.content).toContain('0 9 * * *');
  });

  it('тулы уважают «Стоп»: сигнал отмены до запуска — операция не выполняется', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx();
    ctx.abortSignal = controller.signal;

    const result = await scheduleSaveTool.execute(
      { name: 'Остановлено', cron: '0 9 * * *', target: { mode: 'bound', sessionId } },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('stopped_by_user');
    expect(result.metadata?.interrupted).toBe(true);

    // Расписание не создано.
    expect(await schedules.list()).toHaveLength(0);
  });
});
