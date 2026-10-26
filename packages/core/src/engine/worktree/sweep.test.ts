/**
 * Тесты стартового sweep'а осиротевших записей worktree'ов (ADR-114 §7.4).
 *
 * Проверяем два свойства стартового хука:
 *
 * 1. sweep **вызывается** (запись инвентаря без каталога чистится при старте);
 * 2. ошибка sweep **не роняет старт** — она уходит в лог, процесс продолжает жить.
 */
import { describe, expect, it, vi } from 'vitest';

import { startWorktreeSweeper } from './sweep.js';

/** Прогнать очередь микро-задач (обработчик `.catch` срабатывает асинхронно). */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('startWorktreeSweeper (ADR-114 §7.4)', () => {
  it('вызывает sweep осиротевших записей', async () => {
    const sweepOrphans = vi.fn().mockResolvedValue({ recordsRemoved: 0 });

    startWorktreeSweeper({ sweepOrphans });

    await vi.waitFor(() => expect(sweepOrphans).toHaveBeenCalledTimes(1));
  });

  it('не роняет старт при ошибке sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sweepOrphans = vi.fn().mockRejectedValue(new Error('порт недоступен'));

    try {
      expect(() => startWorktreeSweeper({ sweepOrphans })).not.toThrow();
      await flush();
      expect(sweepOrphans).toHaveBeenCalledTimes(1);
      // Ошибка ушла в лог, а не наружу.
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('sweep');
    } finally {
      warn.mockRestore();
    }
  });

  it('сообщает о вычищенных записях', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      startWorktreeSweeper({ sweepOrphans: vi.fn().mockResolvedValue({ recordsRemoved: 3 }) });
      await flush();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('3');
    } finally {
      warn.mockRestore();
    }
  });
});
