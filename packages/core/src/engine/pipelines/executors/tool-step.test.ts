/**
 * Тесты исполнителя шага вида `tool` (ADR-101 §4, Э4.2).
 *
 * Проверяются: разрешение права → вызов инструмента → результат шага; отказ по
 * правам (`deny`) → шаг `failed`; эскалация `ask` → пауза с данными гейта;
 * ошибка тула → `failed`. Без LLM, без сети и без записи в хранилище.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { PipelineNode, ToolContext, ToolDefinition } from '@itphx/synth-shared';

import { isStepGateOutcome, type StepExecutionContext } from '../types.js';
import { createToolStepExecutor } from './tool-step.js';

/** Инструмент без файловых параметров — проверка прав не зацепает пути. */
function makeTool(
  name: string,
  execute: ToolDefinition['execute'] = async () => ({ content: 'ок' }),
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: z.object({ value: z.string().optional() }),
    capabilities: [ToolCapability.SEARCH],
    execute,
  };
}

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'step1', kind: 'tool', tool: 'noop', ...overrides };
}

function makeCtx(
  node: PipelineNode,
  overrides: Partial<StepExecutionContext> = {},
): StepExecutionContext {
  return {
    runId: 'prun_1',
    pipelineId: 'p1',
    version: 1,
    node,
    spec: {
      id: 'p1',
      name: 'Пайплайн',
      version: 1,
      status: 'published',
      mode: 'act',
      nodes: [node],
      exits: [{ kind: 'none' }],
    },
    trigger: { kind: 'manual' },
    input: {},
    vars: {},
    signal: new AbortController().signal,
    attempt: 1,
    mode: 'act',
    ...overrides,
  };
}

describe('исполнитель tool-шага (ADR-101 §4)', () => {
  it('allow → инструмент вызван, результат в output', async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: ToolContext) => ({
      content: 'готово',
      metadata: { exitCode: 0 },
    }));
    const tool = makeTool('noop', execute);
    const executor = createToolStepExecutor({
      toolRegistry: { get: (name) => (name === 'noop' ? tool : undefined) },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode({ toolArgs: { value: 'x' } })),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(outcome.output?.content).toBe('готово');
    expect(outcome.output?.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    // Аргументы шага уходят в инструмент как есть.
    expect(execute.mock.calls[0]?.[0]).toEqual({ value: 'x' });
  });

  it('инструмент получает ToolContext пайплайна (рабочий каталог, сигнал)', async () => {
    let seen: unknown;
    const tool = makeTool('noop', async (_args, ctx) => {
      seen = ctx;
      return { content: 'ок' };
    });
    const executor = createToolStepExecutor({
      toolRegistry: { get: () => tool },
    });

    await executor.execute(makeCtx(makeNode()));

    const ctx = seen as { sessionId?: string; workingDir?: string; abortSignal?: AbortSignal };
    expect(ctx.sessionId).toBe('pipeline:prun_1');
    expect(ctx.workingDir).toBeTruthy();
    expect(ctx.abortSignal).toBeDefined();
  });

  it('deny → шаг failed с причиной permission.denied, инструмент не вызван', async () => {
    const execute = vi.fn(async () => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const executor = createToolStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'deny' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('permission.denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('ask → пауза с данными гейта (инструмент и аргументы)', async () => {
    const execute = vi.fn(async () => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const executor = createToolStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(makeCtx(makeNode({ toolArgs: { value: 'y' } })));

    expect(isStepGateOutcome(outcome)).toBe(true);
    if (!isStepGateOutcome(outcome)) return;
    expect(outcome.gate.kind).toBe('tool_approval');
    expect(outcome.gate.nodeId).toBe('step1');
    expect(outcome.gate.toolName).toBe('noop');
    expect(outcome.gate.args).toEqual({ value: 'y' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('после одобрения оператора инструмент исполняется без повторной проверки прав', async () => {
    const execute = vi.fn(async () => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const executor = createToolStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), { gateDecision: { approved: true } }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('отклонение оператором → шаг failed с pipeline.gate_rejected, инструмент не вызван', async () => {
    const execute = vi.fn(async () => ({ content: 'ок' }));
    const tool = makeTool('noop', execute);
    const executor = createToolStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: { permissionConfig: { rules: { noop: 'ask' }, askTimeoutMs: 1000 } },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), { gateDecision: { approved: false } }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.gate_rejected');
    expect(execute).not.toHaveBeenCalled();
  });

  it('ошибка тула → шаг failed с pipeline.tool_failed', async () => {
    const tool = makeTool('noop', async () => ({ content: 'сломалось', isError: true }));
    const executor = createToolStepExecutor({
      toolRegistry: { get: () => tool },
    });

    const outcome = await executor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.tool_failed');
  });

  it('инструмент не зарегистрирован → шаг failed с pipeline.tool_not_found', async () => {
    const executor = createToolStepExecutor({ toolRegistry: { get: () => undefined } });

    const outcome = await executor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.tool_not_found');
  });

  it('режим plan запрещает write-тул (тот же permission-слой)', async () => {
    const execute = vi.fn(async () => ({ content: 'ок' }));
    const tool: ToolDefinition = {
      ...makeTool('write_file', execute),
      capabilities: [ToolCapability.FILE_WRITE],
    };
    const executor = createToolStepExecutor({ toolRegistry: { get: () => tool } });

    const outcome = await executor.execute(
      makeCtx(makeNode({ tool: 'write_file' }), { mode: 'plan' }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('permission.denied');
    expect(execute).not.toHaveBeenCalled();
  });
});
