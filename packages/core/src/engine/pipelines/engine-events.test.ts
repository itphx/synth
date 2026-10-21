/**
 * ADR-101 §2.12 (Э5): события прогона в шине.
 *
 * Проверяется контракт:
 * - `pipeline.run.*` публикуются на переходах (старт/шаг/ожидание/финиш/провал);
 * - полезная нагрузка события **не содержит** payload прогона, секретов и сырых
 *   путей — только идентификаторы и технические поля (ADR-094/ADR-101 §2.9).
 */
import { describe, it, expect } from 'vitest';

import type { EventType } from '@itphx/synth-shared';
import type { PipelineNode, PipelineSpec, StepResult } from '@itphx/synth-shared';

import {
  MemoryPipelineRunRepository,
  MemoryProjectPipelineRepository,
} from '../../storage/memory/index.js';
import { PipelineEngine } from './engine.js';
import { humanStepExecutor } from './executors/index.js';
import type { StepExecutor } from './types.js';

/** Публикатор инстансных событий — собирает всё, что ушло в шину. */
function eventCollector(): {
  events: Array<{ type: EventType; data: Record<string, unknown> }>;
  publishInstance: (type: EventType, data?: Record<string, unknown>) => void;
} {
  const events: Array<{ type: EventType; data: Record<string, unknown> }> = [];
  return {
    events,
    publishInstance: (type, data) => {
      events.push({ type, data: data ?? {} });
    },
  };
}

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

async function setup(pipelineSpec: PipelineSpec, executors: StepExecutor[]) {
  const pipelines = new MemoryProjectPipelineRepository();
  const runs = new MemoryPipelineRunRepository();
  const now = new Date().toISOString();
  await pipelines.savePipeline({
    id: pipelineSpec.id,
    scope: 'project',
    projectId: 'proj-1',
    name: pipelineSpec.name,
    draftVersion: 2,
    publishedVersion: pipelineSpec.version,
    createdAt: now,
    updatedAt: now,
  });
  await pipelines.saveVersion({
    pipelineId: pipelineSpec.id,
    version: pipelineSpec.version,
    spec: pipelineSpec,
    publishedAt: now,
  });
  const collector = eventCollector();
  const engine = new PipelineEngine({
    pipelines,
    runs,
    executors,
    eventBus: { publishInstance: collector.publishInstance },
  });
  return { engine, collector };
}

/** Исполнитель-мок с заданным результатом. */
function executor(
  kind: PipelineNode['kind'],
  fn: () => StepResult | Promise<StepResult>,
): StepExecutor {
  return { kind, execute: async () => fn() };
}

describe('события прогона пайплайна', () => {
  it('публикуются на переходах: старт, шаг, финиш', async () => {
    const { engine, collector } = await setup(
      spec([
        { id: 'first', kind: 'tool', tool: 'noop' },
        { id: 'second', kind: 'tool', tool: 'noop' },
      ]),
      [executor('tool', () => ({ status: 'ok', attempt: 1, output: { text: 'готово' } }))],
    );

    const run = await engine.run({
      pipelineId: 'p1',
      trigger: { kind: 'manual' },
      projectId: 'proj-1',
    });

    expect(collector.events.map((event) => event.type)).toEqual([
      'pipeline.run.started',
      'pipeline.run.node_started',
      'pipeline.run.node_finished',
      'pipeline.run.node_started',
      'pipeline.run.node_finished',
      'pipeline.run.finished',
    ]);
    // Базовые поля события — идентификаторы прогона и узла (без payload'а).
    expect(collector.events[0]!.data).toMatchObject({
      runId: run.id,
      pipelineId: 'p1',
      version: 1,
      projectId: 'proj-1',
      triggerKind: 'manual',
    });
    expect(collector.events[1]!.data).toMatchObject({ node: 'first', nodeKind: 'tool', attempt: 1 });
    expect(collector.events[2]!.data).toMatchObject({ node: 'first', status: 'ok' });
    expect(collector.events[5]!.data).toMatchObject({ status: 'done', exits: 1 });
  });

  it('ожидание человека публикуется отдельным событием', async () => {
    const { engine, collector } = await setup(
      spec([{ id: 'ask', kind: 'human', prompt: 'Подтверди?' }]),
      // Исполнитель human-шага запрашивает гейт — движок ставит прогон на паузу.
      [humanStepExecutor],
    );

    const run = await engine.run({
      pipelineId: 'p1',
      trigger: { kind: 'manual' },
      projectId: 'proj-1',
    });

    expect(run.status).toBe('awaiting_human');
    expect(collector.events.map((event) => event.type)).toEqual([
      'pipeline.run.started',
      'pipeline.run.node_started',
      'pipeline.run.awaiting_human',
    ]);
    // Вопрос оператора и аргументы инструмента в событие не попадают.
    expect(collector.events[2]!.data).toMatchObject({ node: 'ask', gateKind: 'human' });
    expect(JSON.stringify(collector.events)).not.toContain('Подтверди?');
  });

  it('провал шага публикуется как pipeline.run.failed', async () => {
    const { engine, collector } = await setup(
      spec([{ id: 'first', kind: 'tool', tool: 'noop' }]),
      [
        executor('tool', () => ({
          status: 'failed',
          attempt: 1,
          error: { code: 'pipeline.tool_failed', message: 'тул упал' },
        })),
      ],
    );

    const run = await engine.run({
      pipelineId: 'p1',
      trigger: { kind: 'manual' },
      projectId: 'proj-1',
    });

    expect(run.status).toBe('failed');
    const failed = collector.events.find((event) => event.type === 'pipeline.run.failed');
    expect(failed).toBeDefined();
    expect(failed!.data).toMatchObject({ status: 'failed', node: 'first' });
  });

  it('payload прогона, секреты и сырые пути в события не попадают', async () => {
    const secret = 'sk-super-secret-value';
    const rawPath = '/var/lib/synth/secrets/master.key';
    const { engine, collector } = await setup(
      spec([{ id: 'first', kind: 'tool', tool: 'noop' }]),
      [executor('tool', () => ({ status: 'ok', attempt: 1, output: { text: 'ок' } }))],
    );

    await engine.run({
      pipelineId: 'p1',
      trigger: {
        kind: 'manual',
        payload: { issue: 'что-то', token: secret, path: rawPath },
      },
      projectId: 'proj-1',
    });

    const dump = JSON.stringify(collector.events);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(rawPath);
    // Ключ с секретом вырезается даже из записи прогона (санитизация, инвариант 13).
    expect(dump).not.toContain('token');
  });
});
