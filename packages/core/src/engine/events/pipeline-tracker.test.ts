import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SynthEvent } from '@itphx/synth-shared';
import { MemoryPipelineRepository } from '../../storage/memory/index.js';
import type {
  PipelineDefinitionRecord,
  PipelineRepository,
} from '../../storage/ports/pipeline-repository.js';
import { PipelineTracker } from './pipeline-tracker.js';

/**
 * ADR-089/ADR-051: учёт экземпляров пайплайна (PROP-059) — состояние
 * автомата публикации живёт в ядре, артефакт шага — по id.
 */

const event = (overrides: Partial<SynthEvent> = {}): SynthEvent => ({
  id: 'evt_1',
  source: 'synth-media',
  type: 'draft_approved',
  payload: { draftId: 'dr_42' },
  identity: {},
  dedupKey: 'dedup-1',
  ts: new Date().toISOString(),
  ...overrides,
});

const definition = (): PipelineDefinitionRecord => ({
  id: 'pl_publish',
  name: 'Публикация',
  steps: [
    { id: 'draft', kind: 'agent', agent: 'publisher' },
    { id: 'review', kind: 'agent', agent: 'publisher' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** Порт, который падает на записи экземпляра (ошибка хранилища). */
class FailingSaveRepository implements PipelineRepository {
  constructor(private readonly _inner: PipelineRepository) {}

  async saveDefinition(def: PipelineDefinitionRecord): Promise<void> {
    await this._inner.saveDefinition(def);
  }

  async getDefinition(id: string): Promise<PipelineDefinitionRecord | null> {
    return this._inner.getDefinition(id);
  }

  async listDefinitions(): Promise<PipelineDefinitionRecord[]> {
    return this._inner.listDefinitions();
  }

  async deleteDefinition(id: string): Promise<boolean> {
    return this._inner.deleteDefinition(id);
  }

  async saveInstance(): Promise<void> {
    throw new Error('storage unavailable');
  }

  async getInstance(id: string) {
    return this._inner.getInstance(id);
  }

  async listInstances(filter?: Parameters<PipelineRepository['listInstances']>[0]) {
    return this._inner.listInstances(filter);
  }
}

describe('PipelineTracker (ADR-089/ADR-051)', () => {
  let repository: MemoryPipelineRepository;
  let tracker: PipelineTracker;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    repository = new MemoryPipelineRepository();
    tracker = new PipelineTracker({ repository });
    await repository.saveDefinition(definition());
  });

  it('первое событие (первый шаг) → создан экземпляр, шаг running с сессией и артефактом', async () => {
    const e = event({ id: 'evt_1', dedupKey: 'k1' });
    const instance = await tracker.track({ pipeline: { id: 'pl_publish', step: 'draft' }, event: e, sessionId: 'sess_1' });

    expect(instance).not.toBeNull();
    expect(instance?.status).toBe('running');
    expect(instance?.pipelineId).toBe('pl_publish');
    expect(instance?.currentStep).toBe('draft');
    expect(instance?.attempts).toBe(1);
    expect(instance?.trigger?.source).toBe('synth-media');
    expect(instance?.trigger?.type).toBe('draft_approved');
    expect(instance?.trigger?.dedupKey).toBe('k1');

    const step = instance?.steps.find((s) => s.id === 'draft');
    expect(step?.status).toBe('running');
    expect(step?.sessionId).toBe('sess_1');
    expect(step?.startedAt).toBeDefined();
    // Артефакт шага = payload события.
    expect(step?.artifact?.kind).toBe('event');
    expect(step?.artifact?.payload).toEqual({ draftId: 'dr_42' });
    // Триггер дублирует payload — «артефакт между шагами».
    expect(instance?.trigger?.payload).toEqual({ draftId: 'dr_42' });

    // Остальные шаги — в очереди.
    expect(instance?.steps.find((s) => s.id === 'review')?.status).toBe('pending');

    const stored = await repository.listInstances({ pipelineId: 'pl_publish' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(instance?.id);
  });

  it('второе событие (следующий шаг) → тот же экземпляр: предыдущий шаг done, текущий running', async () => {
    const first = await tracker.track({
      pipeline: { id: 'pl_publish', step: 'draft' },
      event: event({ id: 'evt_1', dedupKey: 'k1' }),
      sessionId: 'sess_1',
    });
    const second = await tracker.track({
      pipeline: { id: 'pl_publish', step: 'review' },
      event: event({ id: 'evt_2', dedupKey: 'k2', type: 'release.approved', payload: { releaseId: 'r_1' } }),
      sessionId: 'sess_2',
    });

    expect(second).not.toBeNull();
    // Экземпляр тот же — новый не создан.
    expect(second?.id).toBe(first?.id);
    expect(second?.status).toBe('running');
    expect(second?.currentStep).toBe('review');
    expect(second?.steps.find((s) => s.id === 'draft')?.status).toBe('done');
    expect(second?.steps.find((s) => s.id === 'draft')?.finishedAt).toBeDefined();
    expect(second?.steps.find((s) => s.id === 'review')?.status).toBe('running');
    expect(second?.steps.find((s) => s.id === 'review')?.sessionId).toBe('sess_2');
    expect(second?.steps.find((s) => s.id === 'review')?.artifact?.payload).toEqual({ releaseId: 'r_1' });

    const stored = await repository.listInstances({ pipelineId: 'pl_publish' });
    expect(stored).toHaveLength(1);
  });

  it('неизвестный пайплайн → экземпляр не создан (fail-soft)', async () => {
    const instance = await tracker.track({
      pipeline: { id: 'pl_unknown', step: 'draft' },
      event: event(),
      sessionId: 'sess_1',
    });

    expect(instance).toBeNull();
    expect(await repository.listInstances({})).toHaveLength(0);
  });

  it('шаг не найден в определении → экземпляр не создан (fail-soft)', async () => {
    const instance = await tracker.track({
      pipeline: { id: 'pl_publish', step: 'ghost' },
      event: event(),
      sessionId: 'sess_1',
    });

    expect(instance).toBeNull();
    expect(await repository.listInstances({})).toHaveLength(0);
  });

  it('ошибка записи экземпляра → исключение пробрасывается вызывающему (гасит funnel)', async () => {
    const failing = new PipelineTracker({ repository: new FailingSaveRepository(repository) });
    await expect(
      failing.track({ pipeline: { id: 'pl_publish', step: 'draft' }, event: event(), sessionId: 'sess_1' }),
    ).rejects.toThrow('storage unavailable');
    expect(await repository.listInstances({})).toHaveLength(0);
  });

  it('fail-safe: нет живого экземпляра, а шаг не первый → новый экземпляр с текущим шагом', async () => {
    const instance = await tracker.track({
      pipeline: { id: 'pl_publish', step: 'review' },
      event: event(),
      sessionId: 'sess_9',
    });

    expect(instance).not.toBeNull();
    expect(instance?.status).toBe('running');
    expect(instance?.currentStep).toBe('review');
    expect(instance?.steps.find((s) => s.id === 'review')?.status).toBe('running');
    expect(instance?.steps.find((s) => s.id === 'review')?.sessionId).toBe('sess_9');
    // Предыдущий шаг не выполнялся — помечен пропущенным.
    expect(instance?.steps.find((s) => s.id === 'draft')?.status).toBe('skipped');
  });

  it('триггер пайплайна — первый шаг с waitsFor (даже если он не первый в определении)', async () => {
    await repository.saveDefinition({
      id: 'pl_waits',
      name: 'С ожиданием',
      steps: [
        { id: 'prepare', kind: 'agent', agent: 'publisher' },
        { id: 'draft', kind: 'agent', agent: 'publisher', waitsFor: { type: 'draft.created' } },
        { id: 'review', kind: 'agent', agent: 'publisher', waitsFor: { type: 'draft.approved' } },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    // Шаг с `waitsFor` — первый такой в определении → триггер: новый экземпляр.
    const instance = await tracker.track({
      pipeline: { id: 'pl_waits', step: 'draft' },
      event: event(),
      sessionId: 'sess_1',
    });
    expect(instance).not.toBeNull();
    expect(instance?.status).toBe('running');
    expect(instance?.currentStep).toBe('draft');
    expect(instance?.steps.find((s) => s.id === 'draft')?.status).toBe('running');
    // Шаг до триггера не выполнялся — помечен пропущенным.
    expect(instance?.steps.find((s) => s.id === 'prepare')?.status).toBe('skipped');
  });

  it('секреты и несериализуемые значения не попадают в артефакт', async () => {    const instance = await tracker.track({
      pipeline: { id: 'pl_publish', step: 'draft' },
      event: event({
        payload: {
          draftId: 'dr_42',
          apiKey: 'secret-value',
          nested: { access_token: 'tok', keep: 'ok' },
          fn: () => undefined,
        },
      }),
      sessionId: 'sess_1',
    });

    const artifact = instance?.steps.find((s) => s.id === 'draft')?.artifact;
    expect(artifact?.payload).toEqual({ draftId: 'dr_42', nested: { keep: 'ok' } });
  });
});
