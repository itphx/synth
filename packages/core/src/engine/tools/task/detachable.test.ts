/**
 * Detach идущего прогона саб-агента — ADR-111 §«Перевод идущего прогона в фон».
 *
 * Цикл прогона инжектируется (`run`), поэтому проверяется именно механика
 * перевода: немедленный `tool_result`, независимость от отмены родителя, «Стоп»
 * через запись реестра и через дочернюю сессию, терминальный переход записи и
 * отказ по лимиту.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Session, ToolContext, ToolResult } from '@itphx/synth-shared';
import type { BaseProvider } from '../../../providers/base.js';
import { EventBus } from '../../../events/bus.js';
import { FileStore } from '../../../storage/file-store.js';
import { SessionManager } from '../../../sessions/manager.js';
import { MemoryBackgroundRunRepository } from '../../../storage/memory/background-runs.js';
import { BackgroundRunService } from '../../background/service.js';
import { ActiveRunRegistry } from '../../background/active-runs.js';
import { BackgroundLimitExceededError, type BackgroundRunLimits } from '../../background/types.js';
import { runDetachableSubagent } from './detachable.js';
import type { SubagentRunConfig } from './run-cycle.js';
import type { TaskExtra } from './types.js';

/** Прогон, которым управляет тест: висит, пока его не завершат. */
function controllableRun() {
  let configRef: SubagentRunConfig | undefined;
  let resolveRun: ((result: ToolResult) => void) | undefined;
  const run = vi.fn((config: SubagentRunConfig) => {
    configRef = config;
    return new Promise<ToolResult>((resolve) => { resolveRun = resolve; });
  });
  return {
    run,
    /** Конфигурация прогона (после старта). */
    get config(): SubagentRunConfig {
      if (!configRef) throw new Error('run не запущен');
      return configRef;
    },
    /** Опубликовать событие так, как это делает цикл саб-агента. */
    publish(type: string): void {
      this.config.extra.publish?.(type, { session_id: this.config.parentSessionId });
    },
    /** Завершить прогон. */
    finishWith(result: ToolResult): void {
      if (!resolveRun) throw new Error('run не запущен');
      resolveRun(result);
    },
  };
}

/** Параметры тула `task` (минимально необходимые). */
function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Изучить репозиторий',
    prompt: 'go',
    subagent_type: 'explore',
    ...overrides,
  } as unknown as Parameters<typeof runDetachableSubagent>[0]['params'];
}

describe('task/detachable — перевод идущего прогона в фон (ADR-111)', () => {
  let dir: string;
  let sessionManager: SessionManager;
  let parent: Session;
  let child: Session;
  let eventBus: EventBus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synth-task-detach-'));
    sessionManager = new SessionManager(new FileStore({ dataDir: dir }));
    parent = await sessionManager.createSession({ title: 'Parent' });
    child = await sessionManager.createSession({ title: 'Child' });
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeService(limits?: Partial<BackgroundRunLimits>) {
    const notifications: Message[] = [];
    let counter = 0;
    const service = new BackgroundRunService({
      repository: new MemoryBackgroundRunRepository(),
      eventBus,
      limits: {
        maxSubagentsPerSession: 0,
        maxProcessesPerSession: 0,
        maxRunsPerSession: 0,
        ...(limits ?? {}),
      },
      generateId: () => `id-${++counter}`,
      onNotifyParent: (_sessionId: string, message: Message) => { notifications.push(message); },
    });
    return { service, notifications };
  }

  function makeExtra(opts: {
    service?: BackgroundRunService;
    registry?: ActiveRunRegistry;
    publish?: (type: string, data: Record<string, unknown>) => void;
    backgroundEnabled?: boolean;
    registerCancelToken?: (streamId: string, token: never) => void;
    unregisterCancelToken?: (streamId: string) => void;
  } = {}): TaskExtra {
    return {
      provider: {} as BaseProvider,
      agentRegistry: {} as never,
      sessionManager,
      sessionId: parent.id,
      eventBus,
      streamId: 'stream-foreground',
      callId: 'call-1',
      ...(opts.service ? { backgroundService: opts.service } : {}),
      ...(opts.registry ? { activeRuns: opts.registry } : {}),
      ...(opts.publish ? { publish: opts.publish } : {}),
      ...(opts.backgroundEnabled !== undefined ? { backgroundEnabled: opts.backgroundEnabled } : {}),
      ...(opts.registerCancelToken ? { registerCancelToken: opts.registerCancelToken } : {}),
      ...(opts.unregisterCancelToken ? { unregisterCancelToken: opts.unregisterCancelToken } : {}),
    } as unknown as TaskExtra;
  }

  function makeCtx(signal?: AbortSignal): ToolContext {
    return {
      sessionId: parent.id,
      messageId: 'm1',
      ...(signal ? { abortSignal: signal } : {}),
      workingDir: dir,
    };
  }

  function makeRunConfig(extra: TaskExtra, ctx: ToolContext): SubagentRunConfig {
    return {
      subagentType: 'explore',
      description: 'Изучить репозиторий',
      contextMode: 'none',
      llmSystemPrompt: '',
      initialMessages: [],
      provider: {} as BaseProvider,
      childSessionId: child.id,
      parentSessionId: parent.id,
      extra,
      ctx,
    };
  }

  it('без реестра активных прогонов — обычный блокирующий путь (поведение прежнее)', async () => {
    const { service } = makeService();
    const run = vi.fn(async () => ({ content: 'foreground result' }));
    const extra = makeExtra({ service });
    const ctx = makeCtx();

    const result = await runDetachableSubagent({
      params: makeParams(),
      runConfig: makeRunConfig(extra, ctx),
      extra,
      ctx,
      run,
    });

    expect(result).toEqual({ content: 'foreground result' });
    expect(run).toHaveBeenCalledTimes(1);
    // Прогон не регистрировался в реестре фоновых прогонов.
    expect(await service.list({ sessionId: parent.id })).toEqual([]);
  });

  it('detach посреди прогона: тул возвращает управление сразу, прогон идёт в фоне', async () => {
    const { service, notifications } = makeService();
    const registry = new ActiveRunRegistry();
    const publish = vi.fn();
    const registerCancelToken = vi.fn();
    const unregisterCancelToken = vi.fn();
    const run = controllableRun();
    const extra = makeExtra({ service, registry, publish, registerCancelToken, unregisterCancelToken });
    const ctx = makeCtx();
    const published: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe(parent.id, (e) => { published.push({ type: e.type, data: e.data }); });

    const toolPromise = runDetachableSubagent({
      params: makeParams(),
      runConfig: makeRunConfig(extra, ctx),
      extra,
      ctx,
      run: run.run,
    });
    await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));
    // До detach публикация в родительский стрим идёт как обычно.
    run.publish('subagent.progress');
    expect(publish).toHaveBeenCalledTimes(1);

    // Хэндл виден в реестре активных прогонов сессии.
    expect(registry.list(parent.id).map((r) => r.id)).toEqual([child.id]);

    const detachResult = await registry.detachAll(parent.id);
    expect(detachResult.failed).toEqual([]);
    expect(detachResult.detached).toEqual([
      { id: child.id, kind: 'subagent', title: 'Изучить репозиторий' },
    ]);

    // Блокирующее ожидание проснулось: немедленный `tool_result`.
    const toolResult = await toolPromise;
    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.metadata).toMatchObject({
      child_session_id: child.id,
      status: 'running',
      detached: true,
    });
    expect(String(toolResult.metadata!.background_run_id)).toMatch(/^bgr_/);

    // Запись реестра фоновых прогонов создана и ещё `running`.
    const runId = String(toolResult.metadata!.background_run_id);
    expect((await service.get(runId))?.status).toBe('running');

    // Событие перевода в фон — в канал РОДИТЕЛЬСКОЙ сессии.
    const detachedEvent = published.find((e) => e.type === 'process.detached');
    expect(detachedEvent).toBeTruthy();
    expect(detachedEvent!.data).toMatchObject({
      session_id: parent.id,
      kind: 'subagent',
      id: child.id,
      child_session_id: child.id,
      background_run_id: runId,
      title: 'Изучить репозиторий',
    });
    // `process.started` при detach не публикуется — прогон уже шёл.
    expect(published.some((e) => e.type === 'process.started')).toBe(false);

    // Публикация в родительский стрим после detach отключена.
    run.publish('subagent.progress');
    expect(publish).toHaveBeenCalledTimes(1);

    // «Стоп» переведённого прогона: хэндл реестра фоновых прогонов живёт.
    expect(await service.stop(runId)).toBe(true);
    expect(run.config.ctx.abortSignal?.aborted).toBe(true);

    // «Стоп» дочерней сессии: cancel-токен по НОВОМУ streamId.
    expect(registerCancelToken).toHaveBeenCalledTimes(1);
    const [streamId] = registerCancelToken.mock.calls[0] as unknown as [string];
    expect(streamId).toBeTruthy();
    expect(streamId).not.toBe('stream-foreground');
    expect(run.config.extra.streamId).toBe(streamId);

    // Маркер активности дочерней сессии выставлен.
    const busyChild = await sessionManager.getSession(child.id);
    expect(busyChild?.currentStream?.streamId).toBe(streamId);

    // Завершение фонового прогона: `completed`, уведомление родителя, очистка.
    run.finishWith({ content: 'background done', metadata: { final_content: 'background done' } });
    await vi.waitFor(async () => {
      expect((await service.get(runId))?.status).toBe('completed');
    });
    expect((await service.get(runId))?.summary).toBe('background done');
    expect(notifications).toHaveLength(1);
    await vi.waitFor(() => expect(unregisterCancelToken).toHaveBeenCalledWith(streamId));
    const finishedChild = await sessionManager.getSession(child.id);
    expect(finishedChild?.currentStream).toBeUndefined();
    // Реестр активных прогонов очищен — повторный detach ничего не найдёт.
    expect(registry.list(parent.id)).toEqual([]);
    expect((await registry.detachAll(parent.id)).detached).toEqual([]);
  });

  it('detach: ошибка прогона → запись `failed`', async () => {
    const { service } = makeService();
    const registry = new ActiveRunRegistry();
    const run = controllableRun();
    const extra = makeExtra({ service, registry });
    const ctx = makeCtx();

    const toolPromise = runDetachableSubagent({
      params: makeParams(),
      runConfig: makeRunConfig(extra, ctx),
      extra,
      ctx,
      run: run.run,
    });
    await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));
    await registry.detachAll(parent.id);
    const toolResult = await toolPromise;
    const runId = String(toolResult.metadata!.background_run_id);

    run.finishWith({ content: 'boom', isError: true });
    await vi.waitFor(async () => {
      expect((await service.get(runId))?.status).toBe('failed');
    });
    expect((await service.get(runId))?.summary).toBe('boom');
  });

  it('detach: остановка пользователем → запись `cancelled`', async () => {
    const { service } = makeService();
    const registry = new ActiveRunRegistry();
    const run = controllableRun();
    const extra = makeExtra({ service, registry });
    const ctx = makeCtx();

    const toolPromise = runDetachableSubagent({
      params: makeParams(),
      runConfig: makeRunConfig(extra, ctx),
      extra,
      ctx,
      run: run.run,
    });
    await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));
    await registry.detachAll(parent.id);
    const toolResult = await toolPromise;
    const runId = String(toolResult.metadata!.background_run_id);

    run.finishWith({ content: '', metadata: { stopped_by: 'user', partial_output: 'частично' } });
    await vi.waitFor(async () => {
      expect((await service.get(runId))?.status).toBe('cancelled');
    });
    expect((await service.get(runId))?.summary).toBe('частично');
  });

  it('родительский abort до detach убивает ребёнка, после detach — нет', async () => {
    // ─── До detach: подписка на сигнал родителя активна ───────────────
    {
      const { service } = makeService();
      const registry = new ActiveRunRegistry();
      const run = controllableRun();
      const parentAbort = new AbortController();
      const extra = makeExtra({ service, registry });
      const ctx = makeCtx(parentAbort.signal);

      const toolPromise = runDetachableSubagent({
        params: makeParams(),
        runConfig: makeRunConfig(extra, ctx),
        extra,
        ctx,
        run: run.run,
      });
      await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));

      parentAbort.abort();
      expect(run.config.ctx.abortSignal?.aborted).toBe(true);

      run.finishWith({ content: 'stopped', metadata: { stopped_by: 'user' } });
      await toolPromise;
    }

    // ─── После detach: прогон независим от отмены родителя ───────────
    {
      const { service } = makeService();
      const registry = new ActiveRunRegistry();
      const run = controllableRun();
      const parentAbort = new AbortController();
      const extra = makeExtra({ service, registry });
      const ctx = makeCtx(parentAbort.signal);

      const toolPromise = runDetachableSubagent({
        params: makeParams(),
        runConfig: makeRunConfig(extra, ctx),
        extra,
        ctx,
        run: run.run,
      });
      await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));
      await registry.detachAll(parent.id);
      await toolPromise;

      parentAbort.abort();
      // Ребёнок жив: его сигнал — свой, подписка на родителя снята.
      expect(run.config.ctx.abortSignal?.aborted).toBe(false);

      run.finishWith({ content: 'done' });
      await vi.waitFor(async () => {
        const runs = await service.list({ sessionId: parent.id });
        expect(runs[0]?.status).toBe('completed');
      });
    }
  });

  it('лимит фоновых прогонов: detachAll вернул BACKGROUND_LIMIT, прогон продолжился foreground', async () => {
    const { service } = makeService();
    const registry = new ActiveRunRegistry();
    const run = controllableRun();
    const publish = vi.fn();
    const extra = makeExtra({ service, registry, publish });
    const ctx = makeCtx();
    const published: string[] = [];
    eventBus.subscribe(parent.id, (e) => { published.push(e.type); });
    vi.spyOn(service, 'startSubagent').mockRejectedValue(
      new BackgroundLimitExceededError('subagents', 2, 'Превышен лимит фоновых саб-агентов'),
    );

    const toolPromise = runDetachableSubagent({
      params: makeParams(),
      runConfig: makeRunConfig(extra, ctx),
      extra,
      ctx,
      run: run.run,
    });
    await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));

    const detachResult = await registry.detachAll(parent.id);
    expect(detachResult.detached).toEqual([]);
    expect(detachResult.failed).toHaveLength(1);
    expect(detachResult.failed[0]).toMatchObject({ id: child.id, kind: 'subagent', code: 'BACKGROUND_LIMIT' });

    // Прогон остался блокирующим: публикация в стрим родителя работает,
    // события `process.detached` не было, запись реестра не создана.
    run.publish('subagent.progress');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(published).not.toContain('process.detached');
    expect(await service.list({ sessionId: parent.id })).toEqual([]);

    // Обычный результат блокирующего прогона.
    run.finishWith({ content: 'foreground answer' });
    const result = await toolPromise;
    expect(result.content).toBe('foreground answer');
    expect(result.metadata?.detached).toBeUndefined();
  });

  it('прогон завершился до detach — переводить нечего (запись не создаётся)', async () => {
    const { service } = makeService();
    const registry = new ActiveRunRegistry();
    const run = controllableRun();
    const extra = makeExtra({ service, registry });
    const ctx = makeCtx();

    const toolPromise = runDetachableSubagent({
      params: makeParams(),
      runConfig: makeRunConfig(extra, ctx),
      extra,
      ctx,
      run: run.run,
    });
    await vi.waitFor(() => expect(run.run).toHaveBeenCalledTimes(1));
    // Снимок реестра для detach берём ДО завершения, но detach вызываем после.
    const handles = registry.list(parent.id);
    run.finishWith({ content: 'done' });
    expect((await toolPromise).content).toBe('done');

    for (const handle of handles) await handle.detach();

    expect(await service.list({ sessionId: parent.id })).toEqual([]);
  });
});
