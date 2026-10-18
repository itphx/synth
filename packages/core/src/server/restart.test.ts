import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  configureRestart,
  getProcessStartedAt,
  getRestartStatus,
  requestRestart,
  resetRestartForTests,
  resolveRestartMode,
  RESTART_EXIT_CODE,
} from './restart.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('restart module — graceful restart инстанса', () => {
  beforeEach(() => {
    resetRestartForTests();
  });

  afterEach(() => {
    resetRestartForTests();
    vi.restoreAllMocks();
  });

  it('RESTART_EXIT_CODE = 75 (EX_TEMPFAIL)', () => {
    expect(RESTART_EXIT_CODE).toBe(75);
  });

  describe('resolveRestartMode', () => {
    it('без env и override — disabled', () => {
      expect(resolveRestartMode({})).toBe('disabled');
    });

    it('валидные значения из env', () => {
      expect(resolveRestartMode({ SYNTH_RESTART_MODE: 'process' })).toBe('process');
      expect(resolveRestartMode({ SYNTH_RESTART_MODE: 'supervisor' })).toBe('supervisor');
      expect(resolveRestartMode({ SYNTH_RESTART_MODE: 'disabled' })).toBe('disabled');
    });

    it('нормализует регистр и пробелы', () => {
      expect(resolveRestartMode({ SYNTH_RESTART_MODE: '  PROCESS ' })).toBe('process');
    });

    it('override (CLI) приоритетнее env', () => {
      expect(
        resolveRestartMode({ SYNTH_RESTART_MODE: 'disabled' }, 'supervisor'),
      ).toBe('supervisor');
    });

    it('неизвестное значение → disabled + предупреждение', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveRestartMode({ SYNTH_RESTART_MODE: 'sometimes' })).toBe('disabled');
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  describe('getRestartStatus', () => {
    it('disabled: supported=false и причина', () => {
      const status = getRestartStatus();
      expect(status.supported).toBe(false);
      expect(status.mode).toBe('disabled');
      expect(status.reason).toContain('SYNTH_RESTART_MODE');
      expect(status.startedAt).toBe(getProcessStartedAt());
      expect(status.version).toBeTruthy();
    });

    it('process: supported=true, startedAt стабилен', () => {
      configureRestart({ mode: 'process' });
      const first = getRestartStatus();
      const second = getRestartStatus();
      expect(first.supported).toBe(true);
      expect(first.mode).toBe('process');
      expect(first.reason).toBeUndefined();
      expect(second.startedAt).toBe(first.startedAt);
    });

    it('reason из configureRestart отдаётся как есть', () => {
      configureRestart({ mode: 'supervisor', reason: 'dev.sh restarts the process' });
      expect(getRestartStatus().reason).toBe('dev.sh restarts the process');
    });
  });

  describe('requestRestart', () => {
    it('disabled — запрос отклонён, request не вызывается', async () => {
      const request = vi.fn();
      configureRestart({ mode: 'disabled', request });
      const outcome = await requestRestart();
      expect(outcome.accepted).toBe(false);
      expect(outcome.mode).toBe('disabled');
      expect(outcome.restartId).toBeUndefined();
      await tick();
      expect(request).not.toHaveBeenCalled();
    });

    it('process — отложенный вызов request с restartId', async () => {
      const request = vi.fn();
      configureRestart({ mode: 'process', request, delayMs: 0 });

      const outcome = await requestRestart();
      expect(outcome.accepted).toBe(true);
      expect(outcome.mode).toBe('process');
      expect(outcome.restartId).toMatch(/^rst_/);
      // Отложенность: до таймера запрос ещё не инициирован.
      expect(request).not.toHaveBeenCalled();

      await tick(20);
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(outcome.restartId);
    });

    it('идемпотентность: повторный вызов возвращает тот же restartId, request один', async () => {
      const request = vi.fn();
      configureRestart({ mode: 'supervisor', request, delayMs: 0 });

      const first = await requestRestart();
      const second = await requestRestart();
      expect(second.accepted).toBe(true);
      expect(second.alreadyRequested).toBe(true);
      expect(second.restartId).toBe(first.restartId);

      await tick(20);
      expect(request).toHaveBeenCalledOnce();
    });

    it('beforeRequest получает restartId/mode и вызывается до request', async () => {
      const calls: string[] = [];
      const request = vi.fn(() => {
        calls.push('request');
      });
      configureRestart({ mode: 'process', request, delayMs: 0 });

      const outcome = await requestRestart({
        beforeRequest: (restartId, mode) => {
          calls.push(`before:${mode}:${restartId}`);
        },
      });
      expect(calls).toEqual([`before:process:${outcome.restartId}`]);

      await tick(20);
      expect(calls).toEqual([`before:process:${outcome.restartId}`, 'request']);
    });

    it('ошибка beforeRequest — запрос не инициируется, состояние откатывается', async () => {
      const request = vi.fn();
      configureRestart({ mode: 'process', request, delayMs: 0 });

      await expect(
        requestRestart({
          beforeRequest: () => {
            throw new Error('audit failed');
          },
        }),
      ).rejects.toThrow('audit failed');

      const retry = await requestRestart();
      expect(retry.accepted).toBe(true);
      expect(retry.alreadyRequested).toBeUndefined();
      await tick(20);
      expect(request).toHaveBeenCalledOnce();
    });
  });
});
