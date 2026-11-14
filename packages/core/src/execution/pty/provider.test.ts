/**
 * План терминалов (Ф1): контракт PTY-порта на подделке провайдера.
 *
 * Тесты не зависят от нативного модуля: провайдер подменяется, поэтому
 * проверяются **контрактные** свойства хэндла:
 *
 * - открытие/запись/изменение размера/закрытие;
 * - `onExit` срабатывает **один раз** (событие выхода одно);
 * - `close()` идемпотентен (повторный вызов не шлёт второй сигнал);
 * - недоступный провайдер → понятная ошибка порта (`EPTY`,
 *   `reason: 'dependency_missing'`), а не падение процесса.
 *
 * Интеграционный прогон с настоящим модулем — `inline-execution-port.pty.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { InlineExecutionPort } from '../inline-execution-port.js';
import { isExecutionError } from '../ports/index.js';
import type { PtyProvider, PtySession, PtySpawnRequest } from './provider.js';
import { PtyUnavailableError } from './provider.js';

/** Подделка PTY-сессии: пишет/читает по командам теста. */
class FakePtySession implements PtySession {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(e: { exitCode?: number; signal?: string }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (e: { exitCode?: number; signal?: string }) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  kill(signal?: string): void {
    this.kills.push(signal);
    // Настоящий процесс от сигнала умирает — сообщаем о выходе, иначе
    // `close()` ждал бы весь таймаут эскалации.
    this.emitExit({ signal: signal ?? 'SIGTERM' });
  }

  /** Отдать кусок вывода подписчикам. */
  emitData(chunk: string): void {
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  /** Сообщить о выходе процесса. */
  emitExit(info: { exitCode?: number; signal?: string }): void {
    for (const listener of [...this.exitListeners]) listener(info);
  }
}

/** Провайдер-подделка: отдаёт заранее подготовленную сессию. */
class FakePtyProvider implements PtyProvider {
  readonly requests: PtySpawnRequest[] = [];
  readonly session = new FakePtySession();

  spawn(req: PtySpawnRequest): PtySession {
    this.requests.push(req);
    return this.session;
  }
}

describe('PTY порта — подделка провайдера', () => {
  it('открытие: сессия создаётся с оболочкой, каталогом, размером и окружением', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    const handle = await port.openPty({
      cwd: process.cwd(),
      shell: '/bin/bash',
      cols: 120,
      rows: 40,
      env: { SYNTH_PTY_TEST: '1' },
    });

    expect(handle.id).toMatch(/^pty_/);
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.shell).toBe('/bin/bash');
    expect(req.cwd).toBe(process.cwd());
    expect(req.cols).toBe(120);
    expect(req.rows).toBe(40);
    expect(req.env.SYNTH_PTY_TEST).toBe('1');
    expect(req.env.TERM).toBe('xterm-256color');
    expect(req.env.COLORTERM).toBe('truecolor');
  });

  it('оболочка по умолчанию: $SHELL окружения, иначе /bin/bash', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    await port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 });
    expect(provider.requests[0]!.shell).toBe(process.env.SHELL?.trim() || '/bin/bash');
  });

  it('запись и изменение размера доходят до сессии', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    const handle = await port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 });
    handle.write('ls -la\n');
    handle.resize(100, 30);

    expect(provider.session.writes).toEqual(['ls -la\n']);
    expect(provider.session.resizes).toEqual([[100, 30]]);
  });

  it('вывод приходит подписчику, отписка отключает доставку', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    const handle = await port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 });
    const chunks: string[] = [];
    const unsubscribe = handle.onData((chunk) => chunks.push(chunk));

    provider.session.emitData('первый');
    unsubscribe();
    provider.session.emitData('второй');

    expect(chunks).toEqual(['первый']);
  });

  it('onExit срабатывает один раз на выход процесса', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    const handle = await port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 });
    const exits: Array<{ exitCode?: number; signal?: string }> = [];
    handle.onExit((info) => exits.push(info));

    provider.session.emitExit({ exitCode: 0 });
    provider.session.emitExit({ exitCode: 1 });

    expect(exits).toEqual([{ exitCode: 0 }]);
  });

  it('подписка на выход после выхода отдаёт тот же результат', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    const handle = await port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 });
    provider.session.emitExit({ exitCode: 3 });

    const exits: Array<{ exitCode?: number }> = [];
    handle.onExit((info) => exits.push(info));
    expect(exits).toEqual([{ exitCode: 3 }]);
  });

  it('close() идемпотентен: сигнал уходит один раз', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    const handle = await port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 });
    const first = handle.close();
    const second = handle.close();
    await Promise.all([first, second]);

    // Группа процессов не существует у подделки — сработал fallback `kill()`.
    expect(provider.session.kills.length).toBeGreaterThan(0);
    expect(provider.session.kills[0]).toBe('SIGTERM');
  });

  it('недоступный провайдер → понятная ошибка порта (EPTY)', async () => {
    const port = new InlineExecutionPort({
      ptyProvider: async () => {
        throw new PtyUnavailableError("PTY недоступен: не удалось загрузить модуль 'x'");
      },
    });

    await expect(port.openPty({ cwd: process.cwd(), cols: 80, rows: 24 })).rejects.toSatisfy(
      (err: unknown) => {
        expect(isExecutionError(err)).toBe(true);
        const execError = err as { code?: string | number | null; reason?: string; message?: string };
        expect(execError.code).toBe('EPTY');
        expect(execError.reason).toBe('dependency_missing');
        expect(execError.message).toContain('PTY недоступен');
        return true;
      },
    );
  });

  it('несуществующий рабочий каталог → отказ порта (spawn_failed)', async () => {
    const provider = new FakePtyProvider();
    const port = new InlineExecutionPort({ ptyProvider: async () => provider });

    await expect(
      port.openPty({ cwd: '/nonexistent-synth-pty-cwd', cols: 80, rows: 24 }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(isExecutionError(err)).toBe(true);
      const execError = err as { code?: string | number | null; reason?: string };
      expect(execError.code).toBe('ENOENT');
      expect(execError.reason).toBe('spawn_failed');
      return true;
    });
    // Провайдер не вызывался: нечего запускать.
    expect(provider.requests).toHaveLength(0);
  });

  it('порт объявляет поддержку PTY', () => {
    expect(new InlineExecutionPort().pty).toBe(true);
    expect(typeof new InlineExecutionPort().openPty).toBe('function');
  });
});
