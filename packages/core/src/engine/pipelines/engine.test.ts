/**
 * Тесты движка пайплайнов (ADR-101, Э3).
 *
 * Движок проверяется на мок-исполнителях и in-memory репозиториях: без LLM и
 * без обращения к диску. Покрываются: линейный прогон, ветвление по результату
 * шага, ретраи, падение шага без перехода, HITL-пауза/возобновление, отмена,
 * последовательность событий журнала и самодостаточность прогона.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  PipelineNode,
  PipelineNodeKind,
  PipelineRunTrigger,
  PipelineSpec,
  StepResult,
} from '@itphx/synth-shared';

import {
  MemoryPipelineRunRepository,
  MemoryProjectPipelineRepository,
} from '../../storage/memory/index.js';
import { PipelineEngine } from './engine.js';
import { PipelineEngineError, type StepExecutionContext, type StepExecutor } from './types.js';

const trigger: PipelineRunTrigger = {
  kind: 'manual',
  payload: { issue: 'что-то сломалось', branch: 'main', token: 'секрет' },
};

function spec(nodes: PipelineNode[], overrides: Partial<PipelineSpec> = {}): PipelineSpec {
  return {
    id: 'p1',
    name: 'Тестовый пайплайн',
    version: 1,
    status: 'published',
    mode: 'act',
    nodes,
    exits: [{ kind: 'none' }],
    ...overrides,
  };
}

/** Исполнитель-мок: результат задаётся функцией. */
function executor(
  kind: PipelineNodeKind,
  fn: (ctx: StepExecutionContext) => StepResult | Promise<StepResult>,
): StepExecutor {
  return { kind, execute: async (ctx) => fn(ctx) };
}

async function setup(
  pipelineSpec: PipelineSpec,
  executors: StepExecutor[],
  options: { published?: boolean; sleep?: (ms: number) => Promise<void> } = {},
) {
  const pipelines = new MemoryProjectPipelineRepository();
  const runs = new MemoryPipelineRunRepository();
  const now = new Date().toISOString();
  await pipelines.savePipeline({
    id: pipelineSpec.id,
    scope: 'project',
    projectId: 'proj-1',
    name: pipelineSpec.name,
    draftVersion: 2,
    ...(options.published === false ? {} : { publishedVersion: pipelineSpec.version }),
    createdAt: now,
    updatedAt: now,
  });
  if (options.published !== false) {
    await pipelines.saveVersion({
      pipelineId: pipelineSpec.id,
      version: pipelineSpec.version,
      spec: pipelineSpec,
      publishedAt: now,
    });
  }
  const engine = new PipelineEngine({
    pipelines,
    runs,
    executors,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return { pipelines, runs, engine };
}

async function eventTypes(runs: MemoryPipelineRunRepository, runId: string): Promise<string[]> {
  const events = await runs.listEvents(runId);
  return events.map((event) => event.type);
}

describe('PipelineEngine', () => {
  it('линейный прогон: шаги выполняются по порядку, прогон завершён', async () => {
    const order: string[] = [];
    const { runs, engine } = await setup(
      spec([
        { id: 'first', kind: 'tool', tool: 'noop' },
        { id: 'second', kind: 'tool', tool: 'noop' },
      ]),
      [
        executor('tool', (ctx) => {
          order.push(ctx.node.id);
          return { status: 'ok', attempt: ctx.attempt, output: { done: ctx.node.id } };
        }),
      ],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger, projectId: 'proj-1' });

    expect(run.status).toBe('done');
    expect(order).toEqual(['first', 'second']);
    expect(run.finishedAt).toBeTruthy();
    expect(await eventTypes(runs, run.id)).toEqual([
      'run.started',
      'node.started',
      'node.finished',
      'edge.taken',
      'node.started',
      'node.finished',
      'run.finished',
    ]);
  });

  it('прогон самодостаточен: в записи — снимок спецификации', async () => {
    const pipelineSpec = spec([{ id: 'first', kind: 'tool', tool: 'noop' }]);
    const { runs, engine } = await setup(pipelineSpec, [
      executor('tool', () => ({ status: 'ok', attempt: 1 })),
    ]);

    const run = await engine.run({ pipelineId: 'p1', trigger });
    const stored = await runs.getRun(run.id);

    expect(stored?.spec).toEqual(pipelineSpec);
    expect(stored?.version).toBe(1);
    expect(stored?.pipelineId).toBe('p1');
  });

  it('ветвление: переход выбирается по результату шага', async () => {
    const visited: string[] = [];
    const { engine } = await setup(
      spec([
        {
          id: 'check',
          kind: 'tool',
          tool: 'noop',
          on: [
            { when: { path: 'prev.output.status', op: 'eq', value: 'failed' }, then: 'repair' },
            { when: { path: 'prev.output.status', op: 'eq', value: 'ok' }, then: 'publish' },
          ],
        },
        { id: 'repair', kind: 'tool', tool: 'noop' },
        { id: 'publish', kind: 'tool', tool: 'noop' },
      ]),
      [
        executor('tool', (ctx) => {
          visited.push(ctx.node.id);
          return { status: 'ok', attempt: 1, output: { status: 'ok' } };
        }),
      ],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(visited).toEqual(['check', 'publish']);
    expect(run.status).toBe('done');
  });

  it('ретрай шага: попытки повторяются, пауза берётся из backoffSec', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const { engine } = await setup(
      spec([
        {
          id: 'flaky',
          kind: 'tool',
          tool: 'noop',
          retry: { max: 2, backoffSec: 3 },
        },
      ]),
      [
        executor('tool', (ctx) => {
          attempts += 1;
          if (attempts < 3) return { status: 'failed', attempt: ctx.attempt, error: { code: 'x', message: 'пока нет' } };
          return { status: 'ok', attempt: ctx.attempt };
        }),
      ],
      { sleep: async (ms) => { sleeps.push(ms); } },
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(attempts).toBe(3);
    expect(sleeps).toEqual([3000, 3000]);
    expect(run.status).toBe('done');
  });

  it('падение шага без перехода — прогон failed', async () => {
    const { runs, engine } = await setup(
      spec([{ id: 'boom', kind: 'tool', tool: 'noop' }]),
      [
        executor('tool', () => ({
          status: 'failed',
          attempt: 1,
          error: { code: 'tool_error', message: 'сломалось' },
        })),
      ],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(run.status).toBe('failed');
    expect(run.error).toContain('boom');
    expect(await eventTypes(runs, run.id)).toEqual([
      'run.started',
      'node.started',
      'node.finished',
      'run.failed',
    ]);
  });

  it('исключение исполнителя не выходит наружу: шаг failed, прогон продолжается по переходам', async () => {
    const visited: string[] = [];
    const { engine } = await setup(
      spec([
        {
          id: 'a',
          kind: 'tool',
          tool: 'noop',
          on: [{ when: { path: 'prev.status', op: 'eq', value: 'failed' }, then: 'b' }],
        },
        { id: 'b', kind: 'tool', tool: 'noop' },
      ]),
      [
        executor('tool', (ctx) => {
          visited.push(ctx.node.id);
          if (ctx.node.id === 'a') throw new Error('исключение исполнителя');
          return { status: 'ok', attempt: 1 };
        }),
      ],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(visited).toEqual(['a', 'b']);
    expect(run.status).toBe('done');
  });

  it('нет исполнителя для вида шага — шаг failed с кодом pipeline.executor_missing', async () => {
    const { engine } = await setup(spec([{ id: 'a', kind: 'script', command: 'ls' }]), []);
    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(run.status).toBe('failed');
    expect(run.error).toContain('script');
  });

  it('HITL: гейт ставит прогон на паузу, resume продолжает прогон', async () => {
    const visited: string[] = [];
    const { runs, engine } = await setup(
      spec([
        { id: 'prepare', kind: 'tool', tool: 'noop' },
        { id: 'approve', kind: 'human', prompt: 'Подтверди публикацию' },
        { id: 'publish', kind: 'tool', tool: 'noop' },
      ]),
      [
        executor('tool', (ctx) => {
          visited.push(ctx.node.id);
          return { status: 'ok', attempt: 1, output: { ready: true } };
        }),
      ],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });

    expect(paused.status).toBe('awaiting_human');
    expect(paused.currentNode).toBe('approve');
    expect(visited).toEqual(['prepare']);
    expect(await eventTypes(runs, paused.id)).toEqual([
      'run.started',
      'node.started',
      'node.finished',
      'edge.taken',
      'gate.awaiting',
    ]);

    const resumed = await engine.resume(paused.id, { approved: true, output: { ok: true } });

    expect(resumed.status).toBe('done');
    expect(visited).toEqual(['prepare', 'publish']);
    const types = await eventTypes(runs, paused.id);
    expect(types.slice(0, 5)).toEqual([
      'run.started',
      'node.started',
      'node.finished',
      'edge.taken',
      'gate.awaiting',
    ]);
    expect(types).toContain('node.finished');
    expect(types[types.length - 1]).toBe('run.finished');
  });

  it('HITL: отклонение гейта — шаг failed, перехода нет — прогон failed', async () => {
    const { engine } = await setup(
      spec([
        { id: 'approve', kind: 'human' },
        { id: 'publish', kind: 'tool', tool: 'noop' },
      ]),
      [executor('tool', () => ({ status: 'ok', attempt: 1 }))],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    const resumed = await engine.resume(paused.id, { approved: false, comment: 'не надо' });

    expect(resumed.status).toBe('failed');
    expect(resumed.error).toContain('approve');
  });

  it('отмена через AbortSignal — прогон cancelled', async () => {
    const controller = new AbortController();
    const { runs, engine } = await setup(
      spec([{ id: 'long', kind: 'tool', tool: 'noop' }]),
      [
        executor('tool', async (ctx) => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (ctx.signal.aborted) throw new Error('отменено');
          return { status: 'ok', attempt: 1 };
        }),
      ],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger, signal: controller.signal });

    expect(run.status).toBe('cancelled');
    const events = await runs.listEvents(run.id);
    const failed = events.find((event) => event.type === 'run.failed');
    expect(failed?.payload?.code).toBe('pipeline.cancelled');
  });

  it('в журнал не попадают секреты из payload триггера', async () => {
    const { runs, engine } = await setup(
      spec([{ id: 'a', kind: 'tool', tool: 'noop' }]),
      [executor('tool', () => ({ status: 'ok', attempt: 1 }))],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(run.trigger?.payload?.token).toBeUndefined();
    expect(run.trigger?.payload?.issue).toBe('что-то сломалось');
    const events = await runs.listEvents(run.id);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('секрет');
  });

  it('выходы пайплайна фиксируются в журнале, обработчики вызываются', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const runs = new MemoryPipelineRunRepository();
    const now = new Date().toISOString();
    const pipelineSpec = spec([{ id: 'a', kind: 'tool', tool: 'noop' }], {
      exits: [{ kind: 'file', file: { path: 'report.md' } }],
    });
    await pipelines.savePipeline({
      id: 'p1',
      scope: 'project',
      projectId: 'proj-1',
      name: pipelineSpec.name,
      draftVersion: 2,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await pipelines.saveVersion({
      pipelineId: 'p1',
      version: 1,
      spec: pipelineSpec,
      publishedAt: now,
    });
    const handle = vi.fn();
    const engine = new PipelineEngine({
      pipelines,
      runs,
      executors: [executor('tool', () => ({ status: 'ok', attempt: 1, output: { report: 'x' } }))],
      exits: [{ handle }],
    });

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(run.status).toBe('done');
    expect(handle).toHaveBeenCalledTimes(1);
    const events = await runs.listEvents(run.id);
    const finished = events.find((event) => event.type === 'run.finished');
    const exits = finished?.payload?.exits as Array<Record<string, unknown>>;
    expect(exits[0]?.kind).toBe('file');
  });

  it('неопубликованный пайплайн — ошибка pipeline.not_published', async () => {
    const { engine } = await setup(spec([{ id: 'a', kind: 'tool', tool: 'noop' }]), [], {
      published: false,
    });

    await expect(engine.run({ pipelineId: 'p1', trigger })).rejects.toMatchObject({
      code: 'pipeline.not_published',
    });
  });

  it('таймаут шага: исполнитель не ответил — шаг failed с кодом pipeline.step_timeout', async () => {
    const { runs, engine } = await setup(
      spec([{ id: 'slow', kind: 'tool', tool: 'noop', timeoutSec: 1 }]),
      [
        executor('tool', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return { status: 'ok', attempt: 1 };
        }),
      ],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(run.status).toBe('failed');
    const events = await runs.listEvents(run.id);
    const finished = events.find((event) => event.type === 'node.finished');
    const error = finished?.payload?.error as { code?: string } | undefined;
    expect(error?.code).toBe('pipeline.step_timeout');
  });

  it('таймаут гейта: ожидание человека истекло — прогон failed (pipeline.gate_timeout)', async () => {
    const { engine } = await setup(
      spec([{ id: 'approve', kind: 'human', timeoutSec: 1 }]),
      [],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    expect(paused.status).toBe('awaiting_human');

    // Ожидание истекло: ждём дольше таймаута гейта.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const resumed = await engine.resume(paused.id, { approved: true });

    expect(resumed.status).toBe('failed');
    expect(resumed.error).toContain('approve');
  });

  it('неизвестный пайплайн — ошибка pipeline.not_found', async () => {    const { engine } = await setup(spec([{ id: 'a', kind: 'tool', tool: 'noop' }]), []);
    await expect(engine.run({ pipelineId: 'other', trigger })).rejects.toBeInstanceOf(
      PipelineEngineError,
    );
    await expect(engine.run({ pipelineId: 'other', trigger })).rejects.toMatchObject({
      code: 'pipeline.not_found',
    });
  });

  it('невалидная спецификация — ошибка pipeline.invalid_spec', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const runs = new MemoryPipelineRunRepository();
    const now = new Date().toISOString();
    const broken = spec([{ id: 'a', kind: 'tool' }]);
    await pipelines.savePipeline({
      id: 'p1',
      scope: 'project',
      name: 'p',
      draftVersion: 2,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await pipelines.saveVersion({
      pipelineId: 'p1',
      version: 1,
      spec: broken,
      publishedAt: now,
    });
    const engine = new PipelineEngine({ pipelines, runs, executors: [] });

    await expect(engine.run({ pipelineId: 'p1', trigger })).rejects.toMatchObject({
      code: 'pipeline.invalid_spec',
    });
  });

  it('бесконечный цикл упирается в лимит переходов (pipeline.loop_limit)', async () => {
    const { runs, engine } = await setup(
      spec([
        {
          id: 'loop',
          kind: 'tool',
          tool: 'noop',
          on: [{ when: { path: 'prev.output.keep', op: 'eq', value: true }, then: 'loop' }],
        },
      ]),
      [executor('tool', () => ({ status: 'ok', attempt: 1, output: { keep: true } }))],
    );

    const run = await engine.run({ pipelineId: 'p1', trigger });

    expect(run.status).toBe('failed');
    expect(run.error).toContain('100');
    const events = await runs.listEvents(run.id);
    const failed = events.find((event) => event.type === 'run.failed');
    expect(failed?.payload?.code).toBe('pipeline.loop_limit');
  });
});
