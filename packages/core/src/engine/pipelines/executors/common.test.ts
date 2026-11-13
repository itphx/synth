/**
 * Тесты общего шва исполнителей шагов (ADR-101 §4.3b).
 *
 * Проверяется контур исполнения шага: `buildToolContext` кладёт порт/роутер/
 * per-project subPath в `ToolContext.extra` (тот же шов, что у сессий), поэтому
 * плагинный тул шага получает `ctx.runtime` (PROP-138, ADR-077), а встроенный
 * shell-тул (`sandbox_exec`) находит роутер пулов (PROP-135). Без этих полей
 * поведение прежнее: `extra` не задаётся вовсе.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { PipelineNode, ToolContext, ToolDefinition } from '@itphx/synth-shared';

import type { ExecutionPort } from '../../../execution/ports/index.js';
import type { ExecutionRouter } from '../../../execution/router.js';
import type { StepExecutionContext } from '../types.js';
import { buildToolContext, executeStepTool, stepWorkingDir } from './common.js';

/** Минимальный порт: `isExecutionPort` проверяет только наличие `execute`. */
function fakePort(): ExecutionPort {
  return {
    execute: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 })),
  } as unknown as ExecutionPort;
}

/** Минимальный роутер: `isExecutionRouter` проверяет только `portFor`. */
function fakeRouter(port: ExecutionPort): ExecutionRouter {
  return { portFor: vi.fn(() => port) } as unknown as ExecutionRouter;
}

function makeTool(
  name: string,
  execute: ToolDefinition['execute'],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: z.object({}),
    capabilities: [ToolCapability.SEARCH],
    execute,
    ...overrides,
  };
}

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'step1', kind: 'tool', tool: 'noop', ...overrides };
}

function makeCtx(
  overrides: Partial<StepExecutionContext> = {},
): StepExecutionContext {
  const node = overrides.node ?? makeNode();
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

describe('buildToolContext: контур исполнения шага (ADR-077/PROP-135)', () => {
  it('без порта и роутера `extra` не задаётся (прежнее поведение)', () => {
    const ctx = makeCtx();

    const toolContext = buildToolContext(ctx, '/ws/proj');

    expect(toolContext.sessionId).toBe('pipeline:prun_1');
    expect(toolContext.workingDir).toBe('/ws/proj');
    expect(toolContext.extra).toBeUndefined();
  });

  it('порт, роутер и subPath уходят в `extra`', () => {
    const port = fakePort();
    const router = fakeRouter(port);
    const ctx = makeCtx({
      executionPort: port,
      executionRouter: router,
      executionWorkspaceSubPath: 'proj-slug',
    });

    const toolContext = buildToolContext(ctx, '/ws/proj-slug');

    expect(toolContext.extra).toMatchObject({
      executionPort: port,
      executionRouter: router,
      executionWorkspaceSubPath: 'proj-slug',
    });
  });
});

describe('executeStepTool: контур исполнения в шаге (ADR-077, PROP-138)', () => {
  it('плагинный тул шага получает `ctx.runtime` через порт из контекста', async () => {
    const port = fakePort();
    const ctx = makeCtx({ executionPort: port });
    let seen: ToolContext | undefined;
    const tool = makeTool(
      'plugin_demo_read',
      async (_args, toolCtx) => {
        seen = toolCtx;
        return { content: 'ок' };
      },
      { source: 'plugin', capabilities: [ToolCapability.FILE_READ] },
    );

    const result = await executeStepTool(ctx, tool, tool.name, {});

    expect(result.isError).toBeFalsy();
    // PROP-138: runtime — фасад порта, а не сам `extra` (сужение контекста).
    expect(seen?.runtime).toBeDefined();
    expect(seen?.extra).toBeUndefined();
  });

  it('без порта плагинный тул шага остаётся без runtime (fail-closed)', async () => {
    const ctx = makeCtx();
    let seen: ToolContext | undefined;
    const tool = makeTool(
      'plugin_demo_read',
      async (_args, toolCtx) => {
        seen = toolCtx;
        return { content: 'ок' };
      },
      { source: 'plugin', capabilities: [ToolCapability.FILE_READ] },
    );

    await executeStepTool(ctx, tool, tool.name, {});

    expect(seen?.runtime).toBeUndefined();
  });

  it('встроенный тул шага видит роутер портов (`sandbox_exec` находит пул)', async () => {
    const port = fakePort();
    const router = fakeRouter(port);
    const ctx = makeCtx({
      executionPort: port,
      executionRouter: router,
      executionWorkspaceSubPath: 'proj-slug/.worktrees/f',
    });
    let seen: ToolContext | undefined;
    const tool = makeTool(
      'sandbox_exec',
      async (_args, toolCtx) => {
        seen = toolCtx;
        return { content: 'ок' };
      },
      { capabilities: [ToolCapability.SHELL] },
    );

    await executeStepTool(ctx, tool, tool.name, {});

    expect(seen?.extra?.executionRouter).toBe(router);
    expect(seen?.extra?.executionWorkspaceSubPath).toBe('proj-slug/.worktrees/f');
    expect(stepWorkingDir(ctx)).toBe(process.cwd());
  });
});
