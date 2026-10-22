import { describe, it, expect } from 'vitest';
import {
  eventMatchSchema,
  pipelineDefinitionSchema,
  pipelineInstanceSchema,
  pipelineInstanceStatusSchema,
  pipelineStepKindSchema,
  pipelineStepSchema,
  pipelineStepStateSchema,
} from './pipeline.js';

describe('Контракт пайплайна (ADR-051 / ADR-100)', () => {
  it('принимает валидное определение пайплайна', () => {
    const parsed = pipelineDefinitionSchema.safeParse({
      id: 'release-flow',
      name: 'Релизный поток',
      description: 'Сборка → ревью → публикация',
      version: '1.0.0',
      steps: [
        {
          id: 'trigger',
          title: 'Ждём релиз',
          waitsFor: { source: 'ci', type: 'release.created' },
        },
        {
          id: 'review',
          kind: 'agent',
          agent: 'publisher',
          skill: 'media-hub',
          prompt: 'Подготовь черновик',
          waitsFor: { type: 'draft_approved' },
          artifact: { kind: 'draft', from: 'review' },
          timeoutSec: 600,
        },
      ],
      onError: 'retry',
      maxAttempts: 3,
      ttl: '24h',
    });
    expect(parsed.success).toBe(true);
  });

  it('по умолчанию считает вид шага «agent»', () => {
    const parsed = pipelineStepSchema.parse({ id: 'step-1' });
    expect(parsed.kind).toBe('agent');
  });

  it('принимает зарезервированный вид шага «loop» (PROP-057)', () => {
    const parsed = pipelineStepSchema.parse({ id: 'step-1', kind: 'loop' });
    expect(parsed.kind).toBe('loop');
  });

  it('отклоняет неизвестный вид шага', () => {
    expect(pipelineStepSchema.safeParse({ id: 'step-1', kind: 'workflow' }).success).toBe(false);
    expect(pipelineStepKindSchema.safeParse('agent').success).toBe(true);
    expect(pipelineStepKindSchema.safeParse('loop').success).toBe(true);
    expect(pipelineStepKindSchema.safeParse('nope').success).toBe(false);
  });

  it('отклоняет пустой список шагов', () => {
    const parsed = pipelineDefinitionSchema.safeParse({
      id: 'empty',
      name: 'Пустой',
      steps: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет неизвестную политику onError', () => {
    const parsed = pipelineDefinitionSchema.safeParse({
      id: 'flow',
      name: 'Поток',
      steps: [{ id: 'step-1' }],
      onError: 'ignore',
    });
    expect(parsed.success).toBe(false);
  });

  it('принимает все политики onError', () => {
    for (const onError of ['fail', 'retry', 'rollback']) {
      const parsed = pipelineDefinitionSchema.safeParse({
        id: 'flow',
        name: 'Поток',
        steps: [{ id: 'step-1' }],
        onError,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('требует id и name у определения', () => {
    expect(pipelineDefinitionSchema.safeParse({ name: 'Поток', steps: [{ id: 's' }] }).success).toBe(
      false,
    );
    expect(pipelineDefinitionSchema.safeParse({ id: 'flow', steps: [{ id: 's' }] }).success).toBe(
      false,
    );
  });

  it('требует id у шага', () => {
    expect(pipelineStepSchema.safeParse({ title: 'Без id' }).success).toBe(false);
  });
});

describe('Совпадение с событием (триггер шага)', () => {
  it('принимает source и type', () => {
    const parsed = eventMatchSchema.safeParse({ source: 'ci', type: 'release.created' });
    expect(parsed.success).toBe(true);
  });

  it('принимает пустое совпадение', () => {
    expect(eventMatchSchema.safeParse({}).success).toBe(true);
  });

  it('отбрасывает поля роутера, не относящиеся к триггеру', () => {
    // `eventRouteMatchSchema` (ADR-089) несёт поля смысла роутера
    // (`chatKey`/`threadKey`/`principalId`/`label`/`keywords`) — в триггере
    // пайплайна их нет, схема их отбрасывает.
    const parsed = eventMatchSchema.safeParse({ source: 'ci', chatKey: 'chat-1' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ source: 'ci' });
    }
  });
});

describe('Экземпляр пайплайна', () => {
  it('принимает валидный экземпляр', () => {
    const parsed = pipelineInstanceSchema.safeParse({
      id: 'run-1',
      pipelineId: 'release-flow',
      pipelineVersion: '1.0.0',
      status: 'waiting',
      trigger: { source: 'ci', type: 'release.created', dedupKey: 'ci:release:42' },
      steps: [
        {
          id: 'trigger',
          status: 'done',
          sessionId: 'ses-1',
          startedAt: '2026-10-20T10:00:00.000Z',
          finishedAt: '2026-10-20T10:00:01.000Z',
        },
        { id: 'review', status: 'pending' },
      ],
      currentStep: 'review',
      attempts: 0,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:01.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('перечисляет статусы экземпляра', () => {
    expect(pipelineInstanceStatusSchema.options).toEqual([
      'pending',
      'running',
      'waiting',
      'done',
      'failed',
      'cancelled',
    ]);
  });

  it('отклоняет неизвестный статус экземпляра', () => {
    const parsed = pipelineInstanceSchema.safeParse({
      id: 'run-1',
      pipelineId: 'release-flow',
      status: 'paused',
      steps: [],
      attempts: 0,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });

  it('отклоняет шаг без id', () => {
    expect(pipelineStepStateSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });

  it('принимает статусы шага', () => {
    for (const status of ['pending', 'running', 'done', 'failed', 'skipped']) {
      expect(pipelineStepStateSchema.safeParse({ id: 's1', status }).success).toBe(true);
    }
  });
});
