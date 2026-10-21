/**
 * Тесты движка пайплайнов (ADR-101, Э3).
 *
 * Движок проверяется на мок-исполнителях и in-memory репозиториях: без LLM и
 * без обращения к диску. Покрываются: линейный прогон, ветвление по результату
 * шага, ретраи, падение шага без перехода, HITL-пауза/возобновление, отмена,
 * последовательность событий журнала и самодостаточность прогона.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  PipelineNode,
  PipelineNodeKind,
  PipelineRunTrigger,
  PipelineSpec,
  StepResult,
  ToolDefinition,
} from '@itphx/synth-shared';

import {
  MemoryPipelineRunRepository,
  MemoryProjectPipelineRepository,
} from '../../storage/memory/index.js';
import { PipelineEngine } from './engine.js';
import { createToolStepExecutor, humanStepExecutor } from './executors/index.js';
import type { PermissionEvaluator } from '../permission/evaluator.js';
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

  it('таймаут гейта: активный таймер в процессе проваливает прогон сам (pipeline.gate_timeout)', async () => {
    const { runs, engine } = await setup(
      spec([{ id: 'approve', kind: 'human', timeoutSec: 1 }]),
      [],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    expect(paused.status).toBe('awaiting_human');

    // Активный таймер (unref) живёт в процессе: по истечении таймаута прогон
    // продолжается с провалом шага — перехода нет, значит прогон падает.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const stored = await runs.getRun(paused.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('approve');
    const events = await runs.listEvents(paused.id);
    const failed = events.find((event) => event.type === 'run.failed');
    expect(failed?.payload?.code).toBe('pipeline.gate_timeout');
  });

  it('таймаут гейта: проверка по времени ожидания ловит истёкший гейт при resume', async () => {
    vi.useFakeTimers();
    try {
      const { engine } = await setup(
        spec([{ id: 'approve', kind: 'human', timeoutSec: 60 }]),
        [],
      );

      const paused = await engine.run({ pipelineId: 'p1', trigger });
      expect(paused.status).toBe('awaiting_human');

      // Процесс перезапустился: активного таймера нет, но время ожидания истекло.
      vi.setSystemTime(Date.now() + 61_000);

      const resumed = await engine.resume(paused.id, { approved: true });

      expect(resumed.status).toBe('failed');
      expect(resumed.error).toContain('approve');
    } finally {
      vi.useRealTimers();
    }
  });

  it('неизвестный пайплайн — ошибка pipeline.not_found', async () => {    const { engine } = await setup(spec([{ id: 'a', kind: 'tool', tool: 'noop' }]), []);
    await expect(engine.run({ pipelineId: 'other', trigger })).rejects.toBeInstanceOf(
      PipelineEngineError,
    );
    await expect(engine.run({ pipelineId: 'other', trigger })).rejects.toMatchObject({
      code: 'pipeline.not_found',
    });
  });

  it('эскалация ask: шаг tool ставит прогон на паузу, одобрение выполняет инструмент', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      parameters: z.object({ value: z.string().optional() }),
      capabilities: [ToolCapability.SEARCH],
      execute: async (args) => {
        calls.push(args as Record<string, unknown>);
        return { content: 'готово' };
      },
    };
    // Первая проверка — `ask` (эскалация в гейт), дальше — `allow`.
    let checks = 0;
    const evaluator = {
      check: () => {
        checks += 1;
        return checks === 1
          ? { action: 'ask' as const, reason: 'нужно подтверждение' }
          : { action: 'allow' as const, reason: 'ok' };
      },
    } as unknown as PermissionEvaluator;

    const { runs, engine } = await setup(
      spec([
        { id: 'ask', kind: 'tool', tool: 'noop', toolArgs: { value: 'x' } },
        { id: 'after', kind: 'tool', tool: 'noop' },
      ]),
      [
        createToolStepExecutor({
          toolRegistry: { get: () => tool },
          permissions: { evaluator },
        }),
      ],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    expect(paused.status).toBe('awaiting_human');
    expect(paused.currentNode).toBe('ask');
    expect(calls).toHaveLength(0);

    const gate = (await runs.listEvents(paused.id)).find((event) => event.type === 'gate.awaiting');
    expect(gate?.payload?.kind).toBe('tool_approval');
    expect(gate?.payload?.toolName).toBe('noop');

    const resumed = await engine.resume(paused.id, { approved: true });

    expect(resumed.status).toBe('done');
    // Инструмент исполнен один раз — уже с выданным правом.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ value: 'x' });
  });

  it('эскалация ask: отклонение оператором → шаг failed с pipeline.gate_rejected', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool: ToolDefinition = {
      name: 'noop',
      description: 'noop',
      parameters: z.object({ value: z.string().optional() }),
      capabilities: [ToolCapability.SEARCH],
      execute: async (args) => {
        calls.push(args as Record<string, unknown>);
        return { content: 'готово' };
      },
    };
    let checks = 0;
    const evaluator = {
      check: () => {
        checks += 1;
        return checks === 1
          ? { action: 'ask' as const, reason: 'нужно подтверждение' }
          : { action: 'allow' as const, reason: 'ok' };
      },
    } as unknown as PermissionEvaluator;

    const { runs, engine } = await setup(
      spec([
        {
          id: 'ask',
          kind: 'tool',
          tool: 'noop',
          toolArgs: { value: 'x' },
          on: [
            {
              when: { path: 'prev.error.code', op: 'eq', value: 'pipeline.gate_rejected' },
              then: 'after',
            },
          ],
        },
        { id: 'after', kind: 'tool', tool: 'noop' },
      ]),
      [
        createToolStepExecutor({
          toolRegistry: { get: () => tool },
          permissions: { evaluator },
        }),
      ],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    expect(paused.status).toBe('awaiting_human');

    const resumed = await engine.resume(paused.id, { approved: false, comment: 'не надо' });

    // Отклонение — провал шага; явный переход по условию ведёт дальше.
    expect(resumed.status).toBe('done');
    // Инструмент узла «ask» не вызывался (у него свои аргументы).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({});
    const finished = (await runs.listEvents(paused.id)).find((event) => event.type === 'node.finished');
    expect((finished?.payload?.error as { code?: string } | undefined)?.code).toBe(
      'pipeline.gate_rejected',
    );
  });

  it('эскалация ask: одобрение оператора передаёт исполнителю данные гейта (инструмент и аргументы)', async () => {
    const seen: Array<{ toolName?: string; args?: Record<string, unknown> }> = [];
    // Исполнитель: первый проход — эскалация ask, второй (после resume) —
    // применяет решение оператора (одобрение) к тому же вызову.
    let first = true;
    const askExecutor: StepExecutor = {
      kind: 'tool',
      execute: async (ctx: StepExecutionContext) => {
        if (first) {
          first = false;
          return {
            kind: 'gate',
            gate: {
              kind: 'tool_approval',
              nodeId: ctx.node.id,
              toolName: 'noop',
              args: { value: 'x' },
            },
          };
        }
        seen.push({ ...(ctx.gate?.toolName ? { toolName: ctx.gate.toolName } : {}), ...(ctx.gate?.args ? { args: ctx.gate.args } : {}) });
        return { status: 'ok', attempt: ctx.attempt, output: { approved: ctx.gateDecision?.approved } };
      },
    };

    const { engine } = await setup(spec([{ id: 'ask', kind: 'tool', tool: 'noop' }]), [askExecutor]);

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    expect(paused.status).toBe('awaiting_human');

    const resumed = await engine.resume(paused.id, { approved: true });

    expect(resumed.status).toBe('done');
    // Данные гейта восстановлены из журнала прогона и переданы исполнителю.
    expect(seen).toEqual([{ toolName: 'noop', args: { value: 'x' } }]);
  });

  it('human-исполнитель: одобрение оператора превращается в результат шага', async () => {
    const { engine } = await setup(
      spec([
        { id: 'approve', kind: 'human', prompt: 'Подтверди?' },
        { id: 'after', kind: 'tool', tool: 'noop' },
      ]),
      [
        humanStepExecutor,
        executor('tool', (ctx) => ({ status: 'ok', attempt: ctx.attempt, output: { node: ctx.node.id } })),
      ],
    );

    const paused = await engine.run({ pipelineId: 'p1', trigger });
    expect(paused.status).toBe('awaiting_human');
    expect(paused.currentNode).toBe('approve');

    const resumed = await engine.resume(paused.id, { approved: true, output: { answer: 'да' } });
    expect(resumed.status).toBe('done');
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

  it('buildStepContext собирает контекст шага из зависимостей движка (ADR-101 §10)', async () => {
    const pipelines = new MemoryProjectPipelineRepository();
    const runs = new MemoryPipelineRunRepository();
    const engine = new PipelineEngine({
      pipelines,
      runs,
      executors: [],
      projectStore: {
        load: async (id: string) =>
          ({
            id,
            name: 'Проект',
            workspace: '/ws/proj',
          }) as never,
      },
    });

    const pipelineSpec = spec([{ id: 'a', kind: 'agent', agent: 'implementer' }]);
    const ctx: StepExecutionContext = {
      runId: 'prun_1',
      pipelineId: 'p1',
      version: pipelineSpec.version,
      node: pipelineSpec.nodes[0]!,
      spec: pipelineSpec,
      projectId: 'proj-1',
      trigger,
      input: {},
      vars: {},
      signal: new AbortController().signal,
      attempt: 1,
      mode: 'act',
    };

    const stepContext = await engine.buildStepContext(ctx);

    expect(stepContext.project?.id).toBe('proj-1');
    expect(stepContext.workspace).toBe('/ws/proj');
    expect(stepContext.workspaceReady).toBe(true);
    expect(stepContext.mode).toBe('act');
  });
});
