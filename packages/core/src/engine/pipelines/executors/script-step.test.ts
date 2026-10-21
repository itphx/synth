/**
 * Тесты исполнителя шага вида `script` (ADR-101 §4, Э4.2).
 *
 * Проверяются: команда уходит в shell-тул (не в голый `child_process`),
 * permission-проверка с той же политикой, эскалация `ask` → пауза, ненулевой
 * код выхода → шаг `failed`. Без LLM и без записи в хранилище.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { PipelineNode, ToolDefinition } from '@itphx/synth-shared';

import { isStepGateOutcome, type StepExecutionContext } from '../types.js';
import { buildShellCommand, createScriptStepExecutor } from './script-step.js';

/** Подменный shell-тул: команда фиксируется, выход — задан тестом. */
function makeShellTool(
  result: { content?: string; isError?: boolean; exitCode?: number } = {},
): { tool: ToolDefinition; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const tool: ToolDefinition = {
    name: 'execute_shell',
    description: 'shell',
    parameters: z.object({ command: z.string(), timeout: z.number().optional() }),
    capabilities: [ToolCapability.SHELL],
    execute: async (args) => {
      calls.push(args as Record<string, unknown>);
      return {
        content: result.content ?? 'stdout',
        ...(result.isError ? { isError: true } : {}),
        metadata: { command: (args as { command: string }).command, exitCode: result.exitCode ?? 0 },
      };
    },
  };
  return { tool, calls };
}

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'build', kind: 'script', command: 'npm', ...overrides };
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

describe('исполнитель script-шага (ADR-101 §4)', () => {
  it('команда исполняется через shell-тул, аргументы добавляются к команде', async () => {
    const { tool, calls } = makeShellTool({ content: 'готово' });
    const executor = createScriptStepExecutor({ toolRegistry: { get: () => tool } });

    const outcome = await executor.execute(
      makeCtx(makeNode({ command: 'npm', args: ['run', 'build'] })),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(calls[0]?.command).toBe('npm run build');
    expect(outcome.output?.content).toBe('готово');
    expect(outcome.output?.exitCode).toBe(0);
  });

  it('аргументы с пробелами экранируются', () => {
    expect(buildShellCommand('echo', ['привет мир'])).toBe("echo 'привет мир'");
    expect(buildShellCommand('echo', ["it's"])).toBe("echo 'it'\\''s'");
    expect(buildShellCommand('ls', ['-la'])).toBe('ls -la');
  });

  it('deny → шаг failed с permission.denied, команда не запускается', async () => {
    const { tool, calls } = makeShellTool();
    const executor = createScriptStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: {
        permissionConfig: { rules: { execute_shell: 'deny' }, askTimeoutMs: 1000 },
      },
    });

    const outcome = await executor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('permission.denied');
    expect(calls).toHaveLength(0);
  });

  it('ask → пауза с данными гейта (инструмент и команда)', async () => {
    const { tool, calls } = makeShellTool();
    const executor = createScriptStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: {
        permissionConfig: { rules: { execute_shell: 'ask' }, askTimeoutMs: 1000 },
      },
    });

    const outcome = await executor.execute(makeCtx(makeNode({ command: 'rm', args: ['-rf', 'build'] })));

    expect(isStepGateOutcome(outcome)).toBe(true);
    if (!isStepGateOutcome(outcome)) return;
    expect(outcome.gate.kind).toBe('tool_approval');
    expect(outcome.gate.toolName).toBe('execute_shell');
    expect((outcome.gate.args as { command?: string })?.command).toBe('rm -rf build');
    expect(calls).toHaveLength(0);
  });

  it('ненулевой код выхода → шаг failed с кодом выхода', async () => {
    const { tool } = makeShellTool({ content: 'boom', isError: true, exitCode: 3 });
    const executor = createScriptStepExecutor({ toolRegistry: { get: () => tool } });

    const outcome = await executor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.script_failed');
    expect(outcome.error?.message).toContain('3');
  });

  it('после одобрения оператора команда исполняется без повторной проверки прав', async () => {
    const { tool, calls } = makeShellTool();
    const executor = createScriptStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: {
        permissionConfig: { rules: { execute_shell: 'ask' }, askTimeoutMs: 1000 },
      },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), { gateDecision: { approved: true } }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('отклонение оператором → шаг failed с pipeline.gate_rejected, команда не запускается', async () => {
    const { tool, calls } = makeShellTool();
    const executor = createScriptStepExecutor({
      toolRegistry: { get: () => tool },
      permissions: {
        permissionConfig: { rules: { execute_shell: 'ask' }, askTimeoutMs: 1000 },
      },
    });

    const outcome = await executor.execute(
      makeCtx(makeNode(), { gateDecision: { approved: false } }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.gate_rejected');
    expect(calls).toHaveLength(0);
  });

  it('таймаут узла уходит в shell-тул как timeout', async () => {
    const { tool, calls } = makeShellTool();
    const executor = createScriptStepExecutor({ toolRegistry: { get: () => tool } });

    await executor.execute(makeCtx(makeNode({ timeoutSec: 5 })));

    expect(calls[0]?.timeout).toBe(5000);
  });

  it('без команды узла → шаг failed', async () => {
    const { tool, calls } = makeShellTool();
    const executor = createScriptStepExecutor({ toolRegistry: { get: () => tool } });

    const outcome = await executor.execute(
      makeCtx({ id: 'build', kind: 'script' }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.script_failed');
    expect(calls).toHaveLength(0);
  });
});
