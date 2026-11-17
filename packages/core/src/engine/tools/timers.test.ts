/**
 * PROP-141 (этап 6): тесты встроенных тулов таймеров и будильников
 * (`engine/tools/timers.ts`).
 *
 * Под движок — настоящий `TimerService` поверх in-memory портов: проверяются
 * тулы (схема, скоуп, тексты отказов), но лимиты и валидация — настоящие
 * (движок в `engine/timers/service.test.ts`).
 *
 * Что проверяется:
 * - регистрация обоих тулов в реестре (capability `schedule`, схема с `action`);
 * - `timer`: create (проект/сессия/владелец), лимит 50 активных на сессию,
 *   `delay` меньше минимума, комментарий длиннее 500 символов, список и отмена;
 * - `alarm`: `at`, `daily` с часовым поясом, `every`, `once` без `at`,
 *   невалидный часовой пояс, правка и отмена;
 * - сессия без проекта — понятный отказ **и ничего не создано**;
 * - список и отмена не показывают чужие автоматизации (другая сессия).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolContext } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';
import { timerTool, alarmTool } from './timers.js';
import { zodToJsonSchema } from './json-schema.js';
import { TimerService } from '../timers/service.js';
import { MemoryTimerFiringRepository, MemoryTimerRepository } from '../../storage/memory/timers.js';
import { createToolRegistry } from './index.js';

describe('Тулы таймеров и будильников (timers.ts)', () => {
  let timers: MemoryTimerRepository;
  let firings: MemoryTimerFiringRepository;
  let service: TimerService;

  /** Контекст вызова тула: сессия `ses_1` проекта `prj_1`. */
  function makeCtx(extra: Record<string, unknown> = {}, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 'ses_1',
      messageId: 'msg_1',
      projectId: 'prj_1',
      workingDir: '/tmp',
      extra: {
        timerService: service,
        timers,
        principal: { userId: 'user_1', roles: [] },
        ...extra,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    timers = new MemoryTimerRepository();
    firings = new MemoryTimerFiringRepository();
    service = new TimerService({ timers, firings, deliver: async () => {} });
  });

  describe('регистрация', () => {
    it('оба тула зарегистрированы с capability schedule', () => {
      const registry = createToolRegistry();
      const timer = registry.get('timer');
      const alarm = registry.get('alarm');
      expect(timer).toBeDefined();
      expect(alarm).toBeDefined();
      expect(timer?.capabilities).toContain(ToolCapability.SCHEDULE);
      expect(alarm?.capabilities).toContain(ToolCapability.SCHEDULE);
    });

    it('схема тулов — дискриминированный union по action', () => {
      const timerSchema = zodToJsonSchema(timerTool.parameters) as {
        properties?: { action?: { enum?: string[] } };
      };
      const alarmSchema = zodToJsonSchema(alarmTool.parameters) as {
        properties?: { action?: { enum?: string[] } };
      };
      expect(timerSchema.properties?.action?.enum).toEqual(['create', 'list', 'cancel']);
      expect(alarmSchema.properties?.action?.enum).toEqual(['create', 'list', 'update', 'cancel']);
    });
  });

  describe('timer', () => {
    it('create создаёт таймер с проектом, сессией и владельцем', async () => {
      const result = await timerTool.execute(
        { action: 'create', delay: 900, comment: 'проверить сборку' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const created = await timers.list({ sessionId: 'ses_1' });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        kind: 'timer',
        projectId: 'prj_1',
        sessionId: 'ses_1',
        ownerId: 'user_1',
        comment: 'проверить сборку',
        status: 'active',
      });
      expect(Date.parse(created[0]!.firesAt)).toBeGreaterThan(Date.now());
    });

    it('create без движка → deps_unavailable', async () => {
      const result = await timerTool.execute(
        { action: 'create', delay: 60, comment: 'x' },
        makeCtx({ timerService: undefined }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('automation service');
    });

    it('create сверх лимита 50 активных таймеров на сессию → ошибка', async () => {
      for (let i = 0; i < 50; i += 1) {
        await service.createTimer({
          kind: 'timer',
          comment: `таймер ${i}`,
          projectId: 'prj_1',
          sessionId: 'ses_1',
          ownerId: 'user_1',
          repeat: { mode: 'once' },
          delaySec: 600,
        });
      }
      const result = await timerTool.execute(
        { action: 'create', delay: 600, comment: 'лишний' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.code).toBe('timer_limit_exceeded');
      expect(result.content).toContain('50');
    });

    it('create с delay меньше 10 секунд → ошибка', async () => {
      const result = await timerTool.execute(
        { action: 'create', delay: 5, comment: 'слишком быстро' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(await timers.list({})).toHaveLength(0);
    });

    it('create с комментарием длиннее 500 символов → ошибка', async () => {
      const result = await timerTool.execute(
        { action: 'create', delay: 60, comment: 'я'.repeat(501) },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(await timers.list({})).toHaveLength(0);
    });

    it('list показывает только активные автоматизации своей сессии', async () => {
      await timerTool.execute({ action: 'create', delay: 600, comment: 'свой' }, makeCtx());
      await service.createTimer({
        kind: 'timer',
        comment: 'чужой',
        projectId: 'prj_2',
        sessionId: 'ses_2',
        ownerId: 'user_2',
        repeat: { mode: 'once' },
        delaySec: 600,
      });

      const result = await timerTool.execute({ action: 'list' }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('свой');
      expect(result.content).not.toContain('чужой');
      expect(result.metadata?.count).toBe(1);
    });

    it('list с include_cancelled показывает и неактивные автоматизации', async () => {
      const created = await timerTool.execute(
        { action: 'create', delay: 600, comment: 'отработал' },
        makeCtx(),
      );
      const id = String(created.metadata?.id);
      await timers.setStatus(id, 'fired');

      const active = await timerTool.execute({ action: 'list' }, makeCtx());
      expect(active.metadata?.count).toBe(0);

      const all = await timerTool.execute({ action: 'list', include_cancelled: true }, makeCtx());
      expect(all.metadata?.count).toBe(1);
      expect(all.content).toContain(id);
    });

    it('cancel снимает свой таймер', async () => {
      const created = await timerTool.execute(
        { action: 'create', delay: 600, comment: 'отмена' },
        makeCtx(),
      );
      const id = String(created.metadata?.id);
      const result = await timerTool.execute({ action: 'cancel', timer_id: id }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(await timers.get(id)).toBeNull();
    });

    it('cancel чужого таймера → «не найден» (существование не раскрывается)', async () => {
      await service.createTimer({
        kind: 'timer',
        comment: 'чужой',
        projectId: 'prj_2',
        sessionId: 'ses_2',
        ownerId: 'user_2',
        repeat: { mode: 'once' },
        delaySec: 600,
      });
      const foreign = await timers.list({ sessionId: 'ses_2' });
      const result = await timerTool.execute(
        { action: 'cancel', timer_id: foreign[0]!.id },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
      expect(await timers.get(foreign[0]!.id)).not.toBeNull();
    });
  });

  describe('alarm', () => {
    it('create с абсолютным временем `at`', async () => {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const result = await alarmTool.execute(
        { action: 'create', at, repeat: 'once', comment: 'позвонить' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const created = await timers.list({ sessionId: 'ses_1' });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        kind: 'alarm',
        projectId: 'prj_1',
        sessionId: 'ses_1',
        ownerId: 'user_1',
        status: 'active',
      });
      expect(created[0]!.repeat).toEqual({ mode: 'once' });
      expect(Date.parse(created[0]!.firesAt)).toBeGreaterThan(Date.now());
    });

    it('create ежедневно в 09:00 с часовым поясом', async () => {
      const result = await alarmTool.execute(
        {
          action: 'create',
          repeat: 'daily',
          time: '09:00',
          timezone: 'Europe/Moscow',
          comment: 'утренний отчёт',
        },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const created = await timers.list({ sessionId: 'ses_1' });
      expect(created[0]!.repeat).toEqual({
        mode: 'daily',
        time: '09:00',
        timezone: 'Europe/Moscow',
      });
    });

    it('create каждые N секунд', async () => {
      const result = await alarmTool.execute(
        { action: 'create', repeat: 'every', every_sec: 600, comment: 'проверка статуса' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const created = await timers.list({ sessionId: 'ses_1' });
      expect(created[0]!.repeat).toEqual({ mode: 'every', everySec: 600 });
    });

    it('create одноразового будильника без `at` → ошибка', async () => {
      const result = await alarmTool.execute(
        { action: 'create', repeat: 'once', comment: 'когда именно?' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(await timers.list({})).toHaveLength(0);
    });

    it('create с невалидным часовым поясом → ошибка движка', async () => {
      const result = await alarmTool.execute(
        {
          action: 'create',
          repeat: 'daily',
          time: '09:00',
          timezone: 'Mars/Olympus',
          comment: 'будильник',
        },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.code).toBe('timer_invalid_timezone');
      expect(await timers.list({})).toHaveLength(0);
    });

    it('list показывает будильники своей сессии', async () => {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      await alarmTool.execute({ action: 'create', at, repeat: 'once', comment: 'мой будильник' }, makeCtx());
      await service.createTimer({
        kind: 'alarm',
        comment: 'чужой будильник',
        projectId: 'prj_2',
        sessionId: 'ses_2',
        ownerId: 'user_2',
        repeat: { mode: 'once' },
        at: new Date(Date.now() + 7_200_000).toISOString(),
      });

      const result = await alarmTool.execute({ action: 'list' }, makeCtx());
      expect(result.content).toContain('мой будильник');
      expect(result.content).not.toContain('чужой будильник');
    });

    it('update меняет комментарий и правило повтора', async () => {
      const created = await alarmTool.execute(
        {
          action: 'create',
          repeat: 'daily',
          time: '09:00',
          timezone: 'Europe/Moscow',
          comment: 'утренний отчёт',
        },
        makeCtx(),
      );
      const id = String(created.metadata?.id);

      const result = await alarmTool.execute(
        { action: 'update', alarm_id: id, comment: 'новый комментарий', timezone: 'Europe/Berlin' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const updated = await timers.get(id);
      expect(updated?.comment).toBe('новый комментарий');
      expect(updated?.repeat).toEqual({
        mode: 'daily',
        time: '09:00',
        timezone: 'Europe/Berlin',
      });
    });

    it('update одноразового будильника на другое время пересчитывает срабатывание', async () => {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const created = await alarmTool.execute(
        { action: 'create', at, repeat: 'once', comment: 'звонок' },
        makeCtx(),
      );
      const id = String(created.metadata?.id);
      const next = new Date(Date.now() + 7_200_000).toISOString();

      const result = await alarmTool.execute(
        { action: 'update', alarm_id: id, at: next },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      const updated = await timers.get(id);
      expect(updated?.firesAt).toBe(new Date(next).toISOString());
    });

    it('update чужого будильника → «не найден»', async () => {
      await service.createTimer({
        kind: 'alarm',
        comment: 'чужой будильник',
        projectId: 'prj_2',
        sessionId: 'ses_2',
        ownerId: 'user_2',
        repeat: { mode: 'once' },
        at: new Date(Date.now() + 7_200_000).toISOString(),
      });
      const foreign = await timers.list({ sessionId: 'ses_2' });
      const result = await alarmTool.execute(
        { action: 'update', alarm_id: foreign[0]!.id, comment: 'подмена' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('cancel снимает свой будильник', async () => {
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const created = await alarmTool.execute(
        { action: 'create', at, repeat: 'once', comment: 'отмена будильника' },
        makeCtx(),
      );
      const id = String(created.metadata?.id);
      const result = await alarmTool.execute({ action: 'cancel', alarm_id: id }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(await timers.get(id)).toBeNull();
    });
  });

  describe('контекст', () => {
    it('сессия без проекта → отказ «автоматизации только в проекте», ничего не создано', async () => {
      const result = await timerTool.execute(
        { action: 'create', delay: 600, comment: 'без проекта' },
        makeCtx({}, { projectId: undefined }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('require a project');
      expect(await timers.list({})).toHaveLength(0);
    });

    it('сессия без проекта → отказ и для будильника', async () => {
      const result = await alarmTool.execute(
        {
          action: 'create',
          at: new Date(Date.now() + 3_600_000).toISOString(),
          repeat: 'once',
          comment: 'без проекта',
        },
        makeCtx({}, { projectId: undefined }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('require a project');
      expect(await timers.list({})).toHaveLength(0);
    });
  });
});
