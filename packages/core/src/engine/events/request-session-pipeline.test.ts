import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteDecision, SynthEvent } from '@itphx/synth-shared';
import { FileStore } from '../../storage/file-store.js';
import { SessionManager } from '../../sessions/manager.js';
import { EventBindingStore } from '../../storage/event-binding-store.js';
import { EventJournalStore } from '../../storage/event-journal-store.js';
import { MemoryPipelineRepository } from '../../storage/memory/index.js';
import { HookBus } from '../hooks/hook-bus.js';
import { EventRouter } from './event-router.js';
import { PipelineTracker, pipelineStepArtifact, pipelineTriggerPayload } from './pipeline-tracker.js';
import { RequestSessionService } from './request-session.js';
import type { EventDelivery } from './types.js';

/**
 * ADR-089/ADR-051: единый funnel ведёт экземпляры пайплайна — решение
 * Router'а с `pipeline: {id, step}` продвигает автомат пайплайна, а учёт
 * экземпляра не должен ломать доставку события.
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

describe('RequestSessionService — учёт экземпляров пайплайна (ADR-089/ADR-051)', () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let bindingStore: EventBindingStore;
  let journal: EventJournalStore;
  let hooks: HookBus;
  let deliver: Mock<EventDelivery>;
  let pipelines: MemoryPipelineRepository;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-request-session-pipeline-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: tmpDir }));
    bindingStore = new EventBindingStore({ dataDir: tmpDir });
    journal = new EventJournalStore({ dataDir: tmpDir });
    hooks = new HookBus();
    deliver = vi.fn<EventDelivery>(async () => {});
    pipelines = new MemoryPipelineRepository();
    await pipelines.saveDefinition({
      id: 'pl_publish',
      name: 'Публикация',
      steps: [
        { id: 'draft', kind: 'agent', agent: 'publisher' },
        { id: 'review', kind: 'agent', agent: 'publisher' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Сервис funnel'а: решение задаётся провайдером правил (как это делает
   * установщик пакета расширения — `server/routes/packs.ts`).
   */
  const service = (
    decide: (e: SynthEvent) => RouteDecision | null,
    tracker?: PipelineTracker,
  ) => {
    const router = new EventRouter({
      bindingStore,
      journal,
      hooks,
      config: { defaultEphemeralTtl: '24h' },
    });
    router.registerRuleProvider({ name: 'pipeline-rule', resolve: ({ event: e }) => decide(e) });
    return new RequestSessionService({
      sessionManager,
      eventRouter: router,
      bindingStore,
      hooks,
      config: { defaultEphemeralTtl: '24h' },
      deliver,
      ...(tracker ? { pipelineTracker: tracker } : {}),
    });
  };

  const ephemeralWithPipeline = (pipeline?: { id: string; step: string }): RouteDecision => ({
    kind: 'ephemeral',
    agentTemplate: 'publisher',
    ttl: '1h',
    ...(pipeline ? { pipeline } : {}),
  });

  it('решение с pipeline → экземпляр создан, шаг running с сессией и артефактом', async () => {
    const tracker = new PipelineTracker({ repository: pipelines });
    const e = event({ dedupKey: 'k1' });

    const { decision, session } = await service(
      () => ephemeralWithPipeline({ id: 'pl_publish', step: 'draft' }),
      tracker,
    ).handleEvent(e);

    expect(decision.kind).toBe('ephemeral');
    expect(session).not.toBeNull();
    expect(deliver).toHaveBeenCalledOnce();

    const instances = await pipelines.listInstances({ pipelineId: 'pl_publish' });
    expect(instances).toHaveLength(1);
    const instance = instances[0]!;
    expect(instance.status).toBe('running');
    expect(instance.currentStep).toBe('draft');
    const step = instance.steps.find((s) => s.id === 'draft');
    expect(step?.status).toBe('running');
    expect(step?.sessionId).toBe(session!.id);
    expect(pipelineStepArtifact(step!)?.payload).toEqual({ draftId: 'dr_42' });
    expect(pipelineTriggerPayload(instance)).toEqual({ draftId: 'dr_42' });
  });

  it('второе событие (следующий шаг) → экземпляр тот же, предыдущий шаг done', async () => {
    const tracker = new PipelineTracker({ repository: pipelines });
    let step = 'draft';
    const svc = service(() => ephemeralWithPipeline({ id: 'pl_publish', step }), tracker);

    const first = await svc.handleEvent(event({ dedupKey: 'k1' }));
    const firstId = (await pipelines.listInstances({ pipelineId: 'pl_publish' }))[0]!.id;
    step = 'review';
    const second = await svc.handleEvent(
      event({ id: 'evt_2', dedupKey: 'k2', type: 'release.approved', payload: { releaseId: 'r_1' } }),
    );

    const instances = await pipelines.listInstances({ pipelineId: 'pl_publish' });
    expect(instances).toHaveLength(1);
    const instance = instances[0]!;
    // Экземпляр тот же — новый не создан.
    expect(instance.id).toBe(firstId);
    expect(instance.steps.find((s) => s.id === 'draft')?.status).toBe('done');
    expect(instance.steps.find((s) => s.id === 'review')?.status).toBe('running');
    expect(instance.steps.find((s) => s.id === 'review')?.sessionId).toBe(second.session!.id);
    const reviewStep = instance.steps.find((s) => s.id === 'review')!;
    expect(pipelineStepArtifact(reviewStep)?.payload).toEqual({ releaseId: 'r_1' });
    expect(first.session!.id).not.toBe(second.session!.id);
  });

  it('неизвестный пайплайн → экземпляров нет, доставка события не сломана', async () => {
    const tracker = new PipelineTracker({ repository: pipelines });
    const e = event({ dedupKey: 'k1' });

    const { session } = await service(
      () => ephemeralWithPipeline({ id: 'pl_unknown', step: 'draft' }),
      tracker,
    ).handleEvent(e);

    expect(session).not.toBeNull();
    expect(deliver).toHaveBeenCalledOnce();
    expect(await pipelines.listInstances({})).toHaveLength(0);
  });

  it('шаг не найден в определении → экземпляров нет, доставка не сломана', async () => {
    const tracker = new PipelineTracker({ repository: pipelines });
    const e = event({ dedupKey: 'k1' });

    const { session } = await service(
      () => ephemeralWithPipeline({ id: 'pl_publish', step: 'ghost' }),
      tracker,
    ).handleEvent(e);

    expect(session).not.toBeNull();
    expect(deliver).toHaveBeenCalledOnce();
    expect(await pipelines.listInstances({})).toHaveLength(0);
  });

  it('ошибка записи экземпляра → доставка продолжается, ошибка не пробрасывается', async () => {
    const failing = {
      getDefinition: (id: string) => pipelines.getDefinition(id),
      saveInstance: async () => {
        throw new Error('storage unavailable');
      },
    } as unknown as MemoryPipelineRepository;
    const tracker = new PipelineTracker({ repository: failing });
    const e = event({ dedupKey: 'k1' });

    const { session } = await service(
      () => ephemeralWithPipeline({ id: 'pl_publish', step: 'draft' }),
      tracker,
    ).handleEvent(e);

    expect(session).not.toBeNull();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('решение без pipeline → экземпляров не создаётся (регресс)', async () => {
    const tracker = new PipelineTracker({ repository: pipelines });
    const e = event({ dedupKey: 'k1' });

    const { session } = await service(() => ephemeralWithPipeline(), tracker).handleEvent(e);

    expect(session).not.toBeNull();
    expect(deliver).toHaveBeenCalledOnce();
    expect(await pipelines.listInstances({})).toHaveLength(0);
  });
});
