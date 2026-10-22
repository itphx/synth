import { describe, it, expect } from 'vitest';
import {
  // ADR-101: контракты пайплайна как второго движка.
  pipelineSpecSchema,
  pipelineRunSchema,
  pipelineRunEventSchema,
  pipelineStepResultSchema,
  validatePipelineSpec,
  type PipelineSpec,
  type PipelineRun,
  type PipelineRunEvent,
  type StepResult,
  // ADR-051/ADR-100: legacy-контракты не должны исчезнуть из барреля.
  pipelineInstanceSchema,
  pipelineDefinitionSchema,
  type PipelineTrigger,
  type PipelineInstance,
} from './index.js';

describe('Баррель типов (@itphx/synth-shared/types)', () => {
  it('экспортирует контракты ADR-101 (pipeline-engine)', () => {
    expect(pipelineSpecSchema).toBeDefined();
    expect(pipelineRunSchema).toBeDefined();
    expect(pipelineRunEventSchema).toBeDefined();
    expect(pipelineStepResultSchema).toBeDefined();
    expect(typeof validatePipelineSpec).toBe('function');
  });

  it('сохраняет legacy-контракты ADR-051/ADR-100', () => {
    expect(pipelineDefinitionSchema).toBeDefined();
    expect(pipelineInstanceSchema).toBeDefined();
  });

  it('типы ADR-101 доступны из барреля (проверка компиляции)', () => {
    const spec: PipelineSpec = pipelineSpecSchema.parse({
      id: 'p1',
      name: 'Пайплайн',
      version: 1,
      status: 'draft',
      mode: 'act',
      nodes: [{ id: 'n1', kind: 'agent', agent: 'assistant' }],
      exits: [{ kind: 'none' }],
    });
    const run: PipelineRun = {
      id: 'run-1',
      pipelineId: spec.id,
      version: spec.version,
      status: 'pending',
    };
    const event: PipelineRunEvent = {
      runId: run.id,
      ts: '2026-10-21T10:00:00.000Z',
      type: 'run.started',
    };
    const result: StepResult = { status: 'ok', attempt: 1 };
    // Legacy-тип `PipelineTrigger` (ADR-100) — не переименовывался.
    const legacyTrigger: PipelineTrigger = { source: 'ci', type: 'release.created' };
    const legacyInstance: PipelineInstance = {
      id: 'inst-1',
      pipelineId: 'p1',
      status: 'pending',
      steps: [],
      attempts: 0,
      createdAt: '2026-10-21T10:00:00.000Z',
      updatedAt: '2026-10-21T10:00:00.000Z',
    };

    expect(validatePipelineSpec(spec)).toEqual({ ok: true });
    expect(event.runId).toBe(run.id);
    expect(result.status).toBe('ok');
    expect(legacyTrigger.source).toBe('ci');
    expect(legacyInstance.attempts).toBe(0);
  });
});
