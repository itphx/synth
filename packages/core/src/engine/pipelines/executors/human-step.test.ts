/**
 * Тесты исполнителя шага вида `human` (ADR-101 §6, Э4.2).
 *
 * Проверяются: пауза с вопросом оператору, активный таймаут ожидания
 * (таймер в процессе → шаг `failed` с `pipeline.gate_timeout`) и применение
 * решения оператора при повторном исполнении узла.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PipelineNode, StepResult } from '@itphx/synth-shared';

import { isStepGateOutcome, type PipelineGate, type StepExecutionContext } from '../types.js';
import { humanStepExecutor } from './human-step.js';

function makeNode(overrides: Partial<PipelineNode> = {}): PipelineNode {
  return { id: 'approve', kind: 'human', prompt: 'Подтверди публикацию?', ...overrides };
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

afterEach(() => {
  vi.useRealTimers();
});

describe('исполнитель human-шага (ADR-101 §6)', () => {
  it('шаг без решения → пауза с вопросом оператору', async () => {
    const outcome = await humanStepExecutor.execute(makeCtx(makeNode()));

    expect(isStepGateOutcome(outcome)).toBe(true);
    if (!isStepGateOutcome(outcome)) return;
    expect(outcome.gate.kind).toBe('human');
    expect(outcome.gate.nodeId).toBe('approve');
    expect(outcome.gate.question).toBe('Подтверди публикацию?');
  });

  it('таймаут узла попадает в данные гейта', async () => {
    const outcome = await humanStepExecutor.execute(makeCtx(makeNode({ timeoutSec: 30 })));

    expect(isStepGateOutcome(outcome)).toBe(true);
    if (!isStepGateOutcome(outcome)) return;
    expect(outcome.gate.timeoutSec).toBe(30);
  });

  it('активный таймаут: по истечении шаг failed с pipeline.gate_timeout', async () => {
    vi.useFakeTimers();
    const onGateTimeout = vi.fn((_gate: PipelineGate, _result: StepResult) => {
      // Фикстура: движок обрабатывает таймаут гейта.
    });
    const ctx = makeCtx(makeNode({ timeoutSec: 10 }), { onGateTimeout });

    await humanStepExecutor.execute(ctx);

    expect(onGateTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onGateTimeout).toHaveBeenCalledTimes(1);

    const [, result] = onGateTimeout.mock.calls[0]!;
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('pipeline.gate_timeout');
  });

  it('одобрение оператора → шаг ok с выходом гейта и комментарием', async () => {
    const outcome = await humanStepExecutor.execute(
      makeCtx(makeNode(), {
        gateDecision: { approved: true, output: { ok: true }, comment: 'всё хорошо' },
      }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('ok');
    expect(outcome.output?.ok).toBe(true);
    expect(outcome.output?.comment).toBe('всё хорошо');
  });

  it('отклонение оператором → шаг failed с pipeline.gate_rejected', async () => {
    const outcome = await humanStepExecutor.execute(
      makeCtx(makeNode(), { gateDecision: { approved: false, comment: 'не надо' } }),
    );

    expect(isStepGateOutcome(outcome)).toBe(false);
    if (isStepGateOutcome(outcome)) return;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('pipeline.gate_rejected');
  });
});
