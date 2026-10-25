/**
 * Этап 1 roadmap 0.13 (блок 4): единый реестр фоновых прогонов
 * (`engine/background/service.ts`) — фоновые саб-агенты (PROP-096).
 *
 * Проверяется жизненный цикл фонового прогона:
 *   • регистрация (`startSubagent`) — запись `running` со всеми полями;
 *   • лимиты сессии (`maxSubagentsPerSession`/`maxRunsPerSession`);
 *   • завершение (`finish`) — терминальный статус, идемпотентность;
 *   • терминальные события `child.completed`/`child.failed`/`child.cancelled`
 *     в канале **родителя**;
 *   • уведомление родителя (сообщение роли USER с конвертом `<subagent …>`);
 *   • остановка (`stop`) — хэндл отмены в памяти процесса;
 *   • восстановление при старте (`recoverOnStart`) — `running → orphaned`;
 *   • retention-очистка (`prune`/`startBackgroundRunPruner`).
 *
 * Изолированно: memory-порт реестра, шина событий без подписчиков, без сети.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageRole } from '@itphx/synth-shared';
import type { Message } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import { MemoryBackgroundRunRepository } from '../../storage/memory/background-runs.js';
import { BackgroundRunService, BACKGROUND_RUN_ID_PREFIX } from './service.js';
import { startBackgroundRunPruner } from './prune.js';
import { BackgroundLimitExceededError, type BackgroundRunLimits } from './types.js';

interface Notification {
  sessionId: string;
  message: Message;
}

/**
 * Собрать сервис на memory-порте. `limits` — по умолчанию без ограничений
 * (0 = «без лимита»), чтобы отдельные кейсы не влияли друг на друга.
 */
function createService(opts?: {
  limits?: Partial<BackgroundRunLimits>;
  onNotifyParent?: (sessionId: string, message: Message) => void | Promise<void>;
}) {
  const repository = new MemoryBackgroundRunRepository();
  const eventBus = new EventBus();
  const notifications: Notification[] = [];
  let counter = 0;
  const service = new BackgroundRunService({
    repository,
    eventBus,
    limits: {
      maxSubagentsPerSession: 0,
      maxRunsPerSession: 0,
      ...(opts?.limits ?? {}),
    },
    // Уникальные id: иначе записи перетирают друг друга в порту.
    generateId: () => `id-${++counter}`,
    onNotifyParent: opts?.onNotifyParent
      ?? ((sessionId: string, message: Message) => {
        notifications.push({ sessionId, message });
      }),
  });
  return { repository, eventBus, service, notifications };
}

describe('BackgroundRunService — регистрация фонового саб-агента', () => {
  it('startSubagent пишет запись running со всеми полями', async () => {
    const { service, repository } = createService();

    const record = await service.startSubagent({
      sessionId: 'parent-1',
      childSessionId: 'child-1',
      agentRole: 'explore',
      description: 'разобрать репозиторий',
      projectId: 'proj-1',
    });

    expect(record.id.startsWith(BACKGROUND_RUN_ID_PREFIX)).toBe(true);
    expect(record.kind).toBe('subagent');
    expect(record.status).toBe('running');
    expect(record.sessionId).toBe('parent-1');
    expect(record.childSessionId).toBe('child-1');
    expect(record.agentRole).toBe('explore');
    expect(record.description).toBe('разобрать репозиторий');
    expect(record.projectId).toBe('proj-1');
    expect(record.startedAt).toBeTruthy();
    expect(record.updatedAt).toBe(record.startedAt);
    expect(record.finishedAt).toBeUndefined();

    // Запись видна через порт (сервис — тонкая обёртка над ним).
    const stored = await repository.get(record.id);
    expect(stored).toMatchObject({ id: record.id, status: 'running' });
  });

  it('запись видна через list({sessionId, status})', async () => {
    const { service } = createService();

    const record = await service.startSubagent({
      sessionId: 'parent-1',
      childSessionId: 'child-1',
    });

    const running = await service.list({ sessionId: 'parent-1', status: 'running' });
    expect(running).toHaveLength(1);
    expect(running[0]!.id).toBe(record.id);

    // Другая сессия/статус — запись не выдаётся (фильтры по «И»).
    expect(await service.list({ sessionId: 'parent-2', status: 'running' })).toHaveLength(0);
    expect(await service.list({ sessionId: 'parent-1', status: 'completed' })).toHaveLength(0);
  });
});

describe('BackgroundRunService — лимиты сессии', () => {
  it('maxSubagentsPerSession: второй фоновый саб-агент той же сессии — BackgroundLimitExceededError', async () => {
    const { service } = createService({ limits: { maxSubagentsPerSession: 1 } });

    await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    const error = await service
      .startSubagent({ sessionId: 'parent-1', childSessionId: 'child-2' })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BackgroundLimitExceededError);
    expect((error as BackgroundLimitExceededError).limitKind).toBe('subagents');
    expect((error as BackgroundLimitExceededError).limit).toBe(1);
    expect((error as BackgroundLimitExceededError).code).toBe('background_limit_exceeded');
  });

  it('лимит другой сессии не мешает', async () => {
    const { service } = createService({ limits: { maxSubagentsPerSession: 1 } });

    await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    const other = await service.startSubagent({ sessionId: 'parent-2', childSessionId: 'child-2' });

    expect(other.status).toBe('running');
    expect(other.sessionId).toBe('parent-2');
  });

  it('после завершения прогона лимит освобождается', async () => {
    const { service } = createService({ limits: { maxSubagentsPerSession: 1 } });

    const first = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    await service.finish(first.id, { status: 'completed', summary: 'ok' });

    const second = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-2' });
    expect(second.status).toBe('running');
  });

  it('maxRunsPerSession: лимит записей реестра на сессию-владельца', async () => {
    const { service } = createService({ limits: { maxRunsPerSession: 1 } });

    await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    const error = await service
      .startSubagent({ sessionId: 'parent-1', childSessionId: 'child-2' })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BackgroundLimitExceededError);
    expect((error as BackgroundLimitExceededError).limitKind).toBe('runs');
  });
});

describe('BackgroundRunService — завершение прогона', () => {
  it('finish: терминальный статус, summary и finishedAt', async () => {
    const { service, repository } = createService();

    const record = await service.startSubagent({
      sessionId: 'parent-1',
      childSessionId: 'child-1',
      agentRole: 'explore',
    });
    const finished = await service.finish(record.id, { status: 'completed', summary: 'готово' });

    expect(finished?.status).toBe('completed');
    expect(finished?.summary).toBe('готово');
    expect(finished?.finishedAt).toBeTruthy();
    expect(finished?.updatedAt).toBe(finished?.finishedAt);

    const stored = await repository.get(record.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.summary).toBe('готово');
  });

  it('finish идемпотентен: повторный вызов не меняет запись и не дублирует уведомление', async () => {
    const { service, eventBus, notifications } = createService();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('parent-1', (e) => events.push({ type: e.type, data: e.data }));

    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    const first = await service.finish(record.id, { status: 'completed', summary: 'готово' });
    const second = await service.finish(record.id, { status: 'failed', summary: 'другой итог' });

    // Запись не переписана вторым вызовом.
    expect(second?.status).toBe('completed');
    expect(second?.summary).toBe('готово');
    expect(second?.finishedAt).toBe(first?.finishedAt);

    // Уведомление родителя — ровно одно.
    expect(notifications).toHaveLength(1);
    // Терминальное событие — ровно одно.
    expect(events.filter((e) => e.type === 'child.completed')).toHaveLength(1);
  });

  it('finish для неизвестного прогона → null', async () => {
    const { service } = createService();
    expect(await service.finish('bgr_missing', { status: 'completed' })).toBeNull();
  });

  it('finish failed → событие child.failed в канале родителя', async () => {
    const { service, eventBus } = createService();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('parent-1', (e) => events.push({ type: e.type, data: e.data }));

    const record = await service.startSubagent({
      sessionId: 'parent-1',
      childSessionId: 'child-1',
      description: 'упасть',
    });
    await service.finish(record.id, { status: 'failed', summary: 'boom' });

    const failed = events.find((e) => e.type === 'child.failed');
    expect(failed).toBeDefined();
    expect(failed!.data.child_session_id).toBe('child-1');
    expect(failed!.data.parent_session_id).toBe('parent-1');
    expect(failed!.data.state).toBe('failed');
    expect(failed!.data.background_run_id).toBe(record.id);
  });

  it('finish cancelled → событие child.cancelled в канале родителя', async () => {
    const { service, eventBus } = createService();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    eventBus.subscribe('parent-1', (e) => events.push({ type: e.type, data: e.data }));

    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    await service.finish(record.id, { status: 'cancelled', summary: 'остановлен' });

    const cancelled = events.find((e) => e.type === 'child.cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.data.child_session_id).toBe('child-1');
    expect(cancelled!.data.parent_session_id).toBe('parent-1');
    expect(cancelled!.data.state).toBe('cancelled');
    expect(cancelled!.data.background_run_id).toBe(record.id);
  });
});

describe('BackgroundRunService — уведомление родителя', () => {
  it('onNotifyParent вызван ровно один раз с сообщением-конвертом', async () => {
    const onNotifyParent = vi.fn();
    const { service } = createService({ onNotifyParent });

    const record = await service.startSubagent({
      sessionId: 'parent-1',
      childSessionId: 'child-1',
      description: 'собрать отчёт',
    });
    await service.finish(record.id, { status: 'completed', summary: 'отчёт готов' });

    expect(onNotifyParent).toHaveBeenCalledTimes(1);
    const [sessionId, message] = onNotifyParent.mock.calls[0] as [string, Message];
    expect(sessionId).toBe('parent-1');

    // Сообщение видно модели: роль USER, не скрытое, не эфемерное.
    expect(message.role).toBe(MessageRole.USER);
    expect(message.hidden).not.toBe(true);
    expect(message.ephemeral).not.toBe(true);
    expect(message.author).toBe('Subagent');

    // Конверт результата фонового прогона.
    expect(message.content).toContain('<subagent sessionID="child-1" state="completed"');
    expect(message.content).toContain('отчёт готов');
    expect(message.content).toContain('</subagent>');

    expect(message.metadata?.type).toBe('background_run_result');
    expect(message.metadata?.background_run_id).toBe(record.id);
    expect(message.metadata?.child_session_id).toBe('child-1');
    expect(message.metadata?.state).toBe('completed');
  });

  it('уведомление при сбое несёт state=failed', async () => {
    const { service, notifications } = createService();

    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    await service.finish(record.id, { status: 'failed', summary: 'ошибка' });

    expect(notifications).toHaveLength(1);
    const message = notifications[0]!.message;
    expect(message.metadata?.state).toBe('failed');
    expect(message.content).toContain('state="failed"');
    expect(message.content).toContain('ошибка');
  });

  it('без onNotifyParent сервис работает без уведомлений (точка сборки не задана)', async () => {
    const repository = new MemoryBackgroundRunRepository();
    const service = new BackgroundRunService({
      repository,
      eventBus: new EventBus(),
      limits: { maxSubagentsPerSession: 0, maxRunsPerSession: 0 },
    });

    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    const finished = await service.finish(record.id, { status: 'completed', summary: 'ok' });
    expect(finished?.status).toBe('completed');
  });
});

describe('BackgroundRunService — остановка прогона', () => {
  it('stop вызывает зарегистрированный хэндл отмены с reason', async () => {
    const { service } = createService();
    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    const reasons: Array<string | undefined> = [];
    service.registerAbort(record.id, (reason) => reasons.push(reason));

    expect(await service.stop(record.id, 'user request')).toBe(true);
    expect(reasons).toEqual(['user request']);
  });

  it('stop без зарегистрированного хэндла → false', async () => {
    const { service } = createService();
    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    expect(await service.stop(record.id)).toBe(false);
  });

  it('после finish хэндл отмены снимается (прогон завершён — отменять нечего)', async () => {
    const { service } = createService();
    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    const abort = vi.fn();
    service.registerAbort(record.id, abort);
    await service.finish(record.id, { status: 'completed', summary: 'ok' });

    expect(await service.stop(record.id)).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });
});

describe('BackgroundRunService — восстановление при старте процесса', () => {
  it('running → orphaned с пометкой interrupted by restart', async () => {
    const { service, repository } = createService();

    const running = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });
    const done = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-2' });
    await service.finish(done.id, { status: 'completed', summary: 'ok' });

    const recovered = await service.recoverOnStart();
    expect(recovered).toBe(1);

    const orphan = await repository.get(running.id);
    expect(orphan?.status).toBe('orphaned');
    expect(orphan?.summary).toBe('interrupted by restart');
    expect(orphan?.finishedAt).toBeTruthy();

    // Терминальные записи не тронуты.
    const finished = await repository.get(done.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.summary).toBe('ok');
  });

  it('recoverOnStart идемпотентен', async () => {
    const { service } = createService();
    await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    expect(await service.recoverOnStart()).toBe(1);
    expect(await service.recoverOnStart()).toBe(0);
  });
});

describe('BackgroundRunService — retention-очистка', () => {
  it('prune удаляет только терминальные записи старше отсечки', async () => {
    const { service, repository } = createService();

    const oldTerminal = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'old-done' });
    await service.finish(oldTerminal.id, { status: 'completed', summary: 'ok' });
    await repository.save({ ...(await repository.get(oldTerminal.id))!, updatedAt: '2026-01-01T00:00:00.000Z' });

    const freshTerminal = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'fresh-done' });
    await service.finish(freshTerminal.id, { status: 'completed', summary: 'ok' });

    const oldRunning = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'old-running' });
    await repository.save({ ...(await repository.get(oldRunning.id))!, updatedAt: '2026-01-01T00:00:00.000Z' });

    const removed = await service.prune('2026-06-01T00:00:00.000Z');
    expect(removed).toBe(1);

    expect(await repository.get(oldTerminal.id)).toBeNull();
    expect(await repository.get(freshTerminal.id)).not.toBeNull();
    // `running` не терминальный — не удаляется никогда.
    expect(await repository.get(oldRunning.id)).not.toBeNull();
  });

  it('startBackgroundRunPruner чистит по retention при старте', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
      const repository = new MemoryBackgroundRunRepository();

      const base = {
        kind: 'subagent' as const,
        sessionId: 'parent-1',
        childSessionId: 'child-1',
        startedAt: '2026-10-01T00:00:00.000Z',
      };
      // Старая терминальная запись — подлежит очистке (retention 7 дней).
      await repository.save({
        ...base,
        id: 'bgr_old',
        status: 'completed',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });
      // Свежая терминальная — сохраняется.
      await repository.save({
        ...base,
        id: 'bgr_fresh',
        status: 'completed',
        updatedAt: '2026-10-19T00:00:00.000Z',
      });
      // Старая нетерминальная — сохраняется.
      await repository.save({
        ...base,
        id: 'bgr_running',
        status: 'running',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });

      const stop = startBackgroundRunPruner(repository, { getRetentionDays: () => 7 });
      // Первый прогон pruner'а — сразу при старте.
      await vi.advanceTimersByTimeAsync(0);

      expect(await repository.get('bgr_old')).toBeNull();
      expect(await repository.get('bgr_fresh')).not.toBeNull();
      expect(await repository.get('bgr_running')).not.toBeNull();

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('startBackgroundRunPruner при retentionDays <= 0 ничего не чистит', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
      const repository = new MemoryBackgroundRunRepository();
      await repository.save({
        id: 'bgr_old',
        kind: 'subagent',
        status: 'completed',
        sessionId: 'parent-1',
        startedAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      });

      const stop = startBackgroundRunPruner(repository, { getRetentionDays: () => 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(await repository.get('bgr_old')).not.toBeNull();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BackgroundRunService — прочее', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('get проксирует чтение записи из порта', async () => {
    const { service } = createService();
    const record = await service.startSubagent({ sessionId: 'parent-1', childSessionId: 'child-1' });

    expect((await service.get(record.id))?.childSessionId).toBe('child-1');
    expect(await service.get('bgr_missing')).toBeNull();
  });
});
