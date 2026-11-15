/**
 * PROP-132 (Ф5): механика запусков команд в терминале
 * (`engine/terminal/runs.ts`).
 *
 * Проверяется:
 *   • **маркер завершения**: невидимый OSC (`ESC ] 7770 ; synth-run ; …`),
 *     разбор потока (в т.ч. маркер, разорванный границей чанка), вырезание
 *     маркера из текста;
 *   • **реестр запусков**: один активный запуск на терминал (`run_busy`),
 *     накопление вывода, код возврата из маркера, таймаут, закрытие
 *     терминала, кап объёма вывода и числа записей;
 *   • **уведомление сессии**: сообщение роли USER с обрамлением `[CONTENT]` и
 *     метаданными запуска.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildRunMarkerCommand,
  buildTerminalRunNotification,
  scanRunMarkers,
  TerminalRunBusyError,
  TerminalRunRegistry,
  TERMINAL_RUN_MARKER_PREFIX,
  type TerminalRunRecord,
} from './runs.js';

/** Текст маркера завершения запуска (как его печатает `printf`). */
function marker(nonce: string, code: string): string {
  return `${TERMINAL_RUN_MARKER_PREFIX}${nonce};${code}\u0007`;
}

/** Собрать реестр с поддельными часами и таймерами. */
function createRegistry(
  options: { now?: () => number; maxRuns?: number; maxOutputBytes?: number } = {},
): TerminalRunRegistry {
  let counter = 0;
  return new TerminalRunRegistry({
    now: options.now ?? (() => 1_000),
    generateId: () => `uuid-${++counter}`,
    timers: {
      setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => globalThis.clearInterval(handle as never),
    },
    ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    logger: { warn: () => {}, error: () => {} },
  });
}

describe('Маркер завершения запуска', () => {
  it('команда маркера — printf с кодом возврата и nonce', () => {
    const command = buildRunMarkerCommand('abc123');
    expect(command).toContain('printf');
    expect(command).toContain('abc123');
    expect(command).toContain('"$?"');
    // Видимых `echo`-маркеров нет — только невидимая OSC-последовательность.
    expect(command).not.toContain('echo');
  });

  it('разбирает поток: текст и маркер', () => {
    const scan = scanRunMarkers(`before${marker('n1', '0')}after`, '');
    expect(scan.pending).toBe('');
    expect(scan.parts).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'marker', nonce: 'n1', code: '0' },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('маркер, разорванный границей чанка, не теряется', () => {
    const full = `out${marker('n1', '3')}tail`;
    const cut = 6;
    const first = scanRunMarkers(full.slice(0, cut), '');
    expect(first.parts.every((part) => part.kind === 'text')).toBe(true);
    const second = scanRunMarkers(full.slice(cut), first.pending);
    const markers = second.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce: 'n1', code: '3' });
  });

  it('незавершённый маркер удерживается до следующего чанка', () => {
    const scan = scanRunMarkers(`${TERMINAL_RUN_MARKER_PREFIX}n1;0`, '');
    expect(scan.parts).toEqual([]);
    expect(scan.pending).toBe(`${TERMINAL_RUN_MARKER_PREFIX}n1;0`);
  });

  it('чужой текст с префиксом маркера не удерживается бесконечно', () => {
    const scan = scanRunMarkers(`${TERMINAL_RUN_MARKER_PREFIX}`.repeat(200), '');
    expect(scan.pending.length).toBeLessThanOrEqual(512);
  });

  it('обычный текст не меняется', () => {
    const scan = scanRunMarkers('hello\nworld\n', '');
    expect(scan.parts).toEqual([{ kind: 'text', text: 'hello\nworld\n' }]);
    expect(scan.pending).toBe('');
  });
});

describe('Реестр запусков', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('запуск накапливает вывод и завершается по маркеру (код возврата)', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });

    registry.handleData('term_1', [{ kind: 'text', text: 'file1\n' }]);
    registry.handleData('term_1', [
      { kind: 'text', text: 'file2\n' },
      { kind: 'marker', nonce: run.nonce, code: '0' },
    ]);

    const finished = registry.get(run.runId);
    expect(finished?.status).toBe('done');
    expect(finished?.exitCode).toBe(0);
    expect(finished?.output).toBe('file1\nfile2\n');
    expect(finished?.finishedAt).toBe(1_000);
    registry.dispose();
  });

  it('второй запуск в том же терминале — run_busy', () => {
    const registry = createRegistry();
    registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'pwd', timeoutMs: 30_000 }),
    ).toThrow(TerminalRunBusyError);
    registry.dispose();
  });

  it('после завершения терминал снова свободен', () => {
    const registry = createRegistry();
    const first = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.handleData('term_1', [{ kind: 'marker', nonce: first.nonce, code: '0' }]);
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'pwd', timeoutMs: 30_000 }),
    ).not.toThrow();
    registry.dispose();
  });

  it('маркер чужого запуска не завершает наш', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.handleData('term_1', [{ kind: 'marker', nonce: 'other', code: '0' }]);
    expect(registry.get(run.runId)?.status).toBe('running');
    registry.dispose();
  });

  it('таймаут завершает запуск', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'sleep 100', timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(registry.get(run.runId)?.status).toBe('timeout');
    registry.dispose();
  });

  it('срок <= 0: watchdog-таймер не ставится (запуск без лимита)', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'npm test', timeoutMs: 0 });
    // Ни одного таймера: watchdog не armed — запуск живёт, пока не придёт
    // маркер команды или терминал не закроют.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60 * 60 * 1_000);
    expect(registry.get(run.runId)?.status).toBe('running');
    registry.dispose();
  });

  it('запуск без лимита завершается по маркеру (watchdog не мешает)', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'npm test', timeoutMs: 0 });
    registry.handleData('term_1', [{ kind: 'text', text: 'ok\n' }]);
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    const finished = registry.get(run.runId);
    expect(finished?.status).toBe('done');
    expect(finished?.exitCode).toBe(0);
    expect(finished?.output).toBe('ok\n');
    registry.dispose();
  });

  it('запуск без лимита завершается закрытием терминала', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'npm test', timeoutMs: 0 });
    registry.closeTerminal('term_1');
    expect(registry.get(run.runId)?.status).toBe('closed');
    registry.dispose();
  });

  it('wait без срока ждёт завершения запуска (свой таймер не ставится)', async () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'npm test', timeoutMs: 0 });
    const waiting = registry.wait(run.runId, 0);
    // Ожидание не упирается в таймер: завершение приходит по маркеру.
    expect(vi.getTimerCount()).toBe(0);
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    const finished = await waiting;
    expect(finished?.status).toBe('done');
    expect(finished?.exitCode).toBe(0);
    registry.dispose();
  });

  it('закрытие терминала завершает его запуск статусом closed', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.closeTerminal('term_1');
    expect(registry.get(run.runId)?.status).toBe('closed');
    registry.dispose();
  });

  it('вывод запуска ограничен по объёму (хвост сохраняется)', () => {
    const registry = createRegistry({ maxOutputBytes: 10 });
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.handleData('term_1', [{ kind: 'text', text: 'x'.repeat(50) }]);
    const finished = registry.get(run.runId);
    expect(finished?.truncated).toBe(true);
    expect(finished?.output.length).toBe(10);
    registry.dispose();
  });

  it('реестр ограничен по числу записей (старые вытесняются)', () => {
    const registry = createRegistry({ maxRuns: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const run = registry.start({ terminalId: `term_${i}`, command: 'ls', timeoutMs: 30_000 });
      ids.push(run.runId);
      registry.handleData(`term_${i}`, [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    }
    expect(registry.get(ids[0]!)).toBeNull();
    expect(registry.get(ids[3]!)).not.toBeNull();
    registry.dispose();
  });

  it('wait завершается, когда запуск завершился', async () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    const waiting = registry.wait(run.runId, 30_000);
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    const finished = await waiting;
    expect(finished?.status).toBe('done');
    registry.dispose();
  });

  it('колбэк завершения зовётся ровно один раз', () => {
    const settled: TerminalRunRecord[] = [];
    let counter = 0;
    const registry = new TerminalRunRegistry({
      now: () => 1_000,
      generateId: () => `uuid-${++counter}`,
      timers: {
        setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
        setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
        clearInterval: (handle) => globalThis.clearInterval(handle as never),
      },
      logger: { warn: () => {}, error: () => {} },
      onSettled: (run) => settled.push(run),
    });
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    registry.closeTerminal('term_1');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('done');
    registry.dispose();
  });
});

describe('Уведомление сессии о завершении запуска', () => {
  it('сообщение роли USER с обрамлением [CONTENT] и метаданными', () => {
    const run: TerminalRunRecord = {
      runId: 'run_1',
      terminalId: 'term_1',
      sessionId: 'ses_1',
      nonce: 'n1',
      command: 'npm test',
      status: 'done',
      output: 'ok\n',
      exitCode: 0,
      startedAt: 1_000,
      finishedAt: 2_000,
      timeoutMs: 30_000,
      truncated: false,
    };
    const message = buildTerminalRunNotification(run);

    expect(message.role).toBe('user');
    expect(message.author).toBe('Process');
    expect(message.hidden).toBe(false);
    expect(message.ephemeral).toBe(false);
    expect(message.content).toContain('[CONTENT]');
    expect(message.content).toContain('ok');
    expect(message.content).toContain('[CONTENT END]');
    expect(message.content).toContain('term_1');
    expect(message.content).toContain('exit 0');
    expect(message.metadata).toMatchObject({
      type: 'background_run_result',
      kind: 'terminal',
      terminal_id: 'term_1',
      run_id: 'run_1',
      state: 'done',
      command: 'npm test',
      exit_code: 0,
      started_at: 1_000,
      finished_at: 2_000,
      duration_ms: 1_000,
    });
  });

  it('таймаут и закрытие — свой заголовок и статус', () => {
    const base: TerminalRunRecord = {
      runId: 'run_1',
      terminalId: 'term_1',
      nonce: 'n1',
      command: 'sleep 100',
      status: 'timeout',
      output: 'partial\n',
      startedAt: 1_000,
      finishedAt: 2_000,
      timeoutMs: 30_000,
      truncated: false,
    };
    const timeout = buildTerminalRunNotification(base);
    expect(timeout.metadata?.state).toBe('timeout');
    expect(timeout.content).toContain('timeout');
    expect(timeout.content).toContain('partial');

    const closed = buildTerminalRunNotification({ ...base, status: 'closed' });
    expect(closed.metadata?.state).toBe('closed');
    expect(closed.content).toContain('closed');
  });
});
