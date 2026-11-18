/**
 * PROP-132 (Ф5): механика запусков команд в терминале
 * (`engine/terminal/runs.ts`).
 *
 * Проверяется:
 *   • **маркер завершения**: текстовая строка `@@srn-<nonce>:<код>@@` (не
 *     OSC: его съедает tmux), разбор потока (в т.ч. маркер, разорванный
 *     границей чанка), эхо `printf` не считается маркером, код возврата —
 *     целый (в т.ч. отрицательный);
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
  parseRunExitCode,
  scanRunMarkers,
  TerminalRunBusyError,
  TerminalRunRegistry,
  TERMINAL_RUN_MARKER_END,
  TERMINAL_RUN_MARKER_PREFIX,
  type TerminalRunRecord,
} from './runs.js';

/** Строка маркера завершения запуска (как её печатает `printf`). */
function marker(nonce: string, code: string): string {
  return `${TERMINAL_RUN_MARKER_PREFIX}${nonce}:${code}${TERMINAL_RUN_MARKER_END}`;
}

/** Маркер в потоке PTY: отдельная видимая строка (после `\n`). */
function markerFrame(nonce: string, code: string): string {
  return `${marker(nonce, code)}\n`;
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
  it('команда маркера — printf: маркер видимой отдельной строкой', () => {
    const command = buildRunMarkerCommand('abc123');
    expect(command).toContain('printf');
    expect(command).toContain('abc123');
    expect(command).toContain('"$?"');
    // Формат: `printf '\n@@srn-<nonce>:%s@@\n' "$?"`.
    expect(command).toBe(`printf '\\n@@srn-abc123:%s@@\\n' "$?"`);
    // Самостирание (`\033[2K`/`\r`) не используется: под tmux такой маркер до
    // внешнего буфера не доходит (tmux применяет erase до перерисовки).
    expect(command).not.toContain('\\033');
    expect(command).not.toContain('\\r');
    // OSC больше не используется: его съедает tmux — маркер до нас не доходит.
    expect(command).not.toContain(']7770');
    expect(command).not.toContain('\\007');
    expect(command).not.toContain('echo');
  });

  it('маркер виден в потоке отдельной строкой (tmux-подобный вывод)', () => {
    const nonce = 'a1b2c3d4e5f60718';
    const wrapper = buildRunMarkerCommand(nonce);
    // Как это выглядит в PTY под tmux: эхо команды-обёртки (начинается с
    // `printf`), вывод команды, видимая строка-маркер.
    const stream = [
      'ls',
      `user@host:~$ ${wrapper}`,
      'file1',
      'file2',
      markerFrame(nonce, '0'),
    ].join('\r\n');

    const scan = scanRunMarkers(stream, '');
    expect(scan.pending).toBe('');
    const markers = scan.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce, code: '0' });
    const text = scan.parts
      .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
      .map((part) => part.text)
      .join('');
    expect(text).toContain('file1');
    expect(text).toContain('file2');
    // Сама строка-маркер в текст не попадает.
    expect(text).not.toContain(`@@srn-${nonce}:0@@`);
  });

  it('ведущие пробелы/\\r/CSI перед маркером не мешают', () => {
    const scan = scanRunMarkers(`\u001B[2K  \r${marker('n1', '0')}\n`, '');
    const markers = scan.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce: 'n1', code: '0' });
  });

  it('эхо-строка `printf …@@srn-…` запуск не завершает', () => {
    const nonce = 'deadbeefdeadbeef';
    const wrapper = buildRunMarkerCommand(nonce);
    // Эхо начинается с `printf` — это не маркер, хотя текст маркера в нём есть.
    const scan = scanRunMarkers(`user@host:~$ ${wrapper}\r\n`, '');
    expect(scan.parts.some((part) => part.kind === 'marker')).toBe(false);
  });

  it('текст перед маркером в той же строке — маркер не срабатывает', () => {
    const scan = scanRunMarkers(`before ${marker('n1', '0')}\n`, '');
    expect(scan.parts.some((part) => part.kind === 'marker')).toBe(false);
    expect(scan.parts).toEqual([{ kind: 'text', text: `before ${marker('n1', '0')}\n` }]);
    expect(scan.pending).toBe('');
  });

  it('маркер с отрицательным кодом возврата', () => {
    const scan = scanRunMarkers(`out\n${markerFrame('n1', '-1')}`, '');
    const markers = scan.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce: 'n1', code: '-1' });
    expect(parseRunExitCode('-1')).toBe(-1);
    expect(parseRunExitCode('0')).toBe(0);
    expect(parseRunExitCode('')).toBeUndefined();
    expect(parseRunExitCode('x')).toBeUndefined();
  });

  it('маркер с пустым кодом: маркер распознан, код возврата неизвестен', () => {
    const scan = scanRunMarkers(`out\n${markerFrame('n1', '')}`, '');
    const markers = scan.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce: 'n1', code: '' });
    expect(parseRunExitCode('')).toBeUndefined();
  });

  it('маркер, разорванный границей чанка, не теряется', () => {
    const full = `out\n${markerFrame('n1', '3')}tail`;
    // Граница — внутри текста маркера (`@@srn-n1:`).
    const cut = full.indexOf('@@srn-') + 6;
    const first = scanRunMarkers(full.slice(0, cut), '');
    expect(first.parts.every((part) => part.kind === 'text')).toBe(true);
    expect(first.pending).not.toBe('');
    const second = scanRunMarkers(full.slice(cut), first.pending);
    const markers = second.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce: 'n1', code: '3' });
  });

  it('граница чанка внутри CSI перед маркером — маркер не теряется', () => {
    const full = `out\n\u001B[2K${marker('n1', '0')}\n`;
    const cut = full.indexOf('\u001B[2') + 4; // внутри CSI (после `\u001B[2`)
    const first = scanRunMarkers(full.slice(0, cut), '');
    const second = scanRunMarkers(full.slice(cut), first.pending);
    const markers = second.parts.filter((part) => part.kind === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ nonce: 'n1', code: '0' });
  });

  it('незавершённый маркер удерживается до следующего чанка', () => {
    const partial = `${TERMINAL_RUN_MARKER_PREFIX}n1:0`;
    const scan = scanRunMarkers(partial, '');
    expect(scan.parts).toEqual([]);
    expect(scan.pending).toBe(partial);
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
    expect(registry.get(run.runId)?.status).toBe('exited');
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

  it('закрытие терминала завершает его запуск статусом exited', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.closeTerminal('term_1');
    expect(registry.get(run.runId)?.status).toBe('exited');
    registry.dispose();
  });

  it('после таймаута терминал остаётся занятым (команда не убита)', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'sleep 100', timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(registry.get(run.runId)?.status).toBe('timeout');
    // Команда продолжает выполняться в PTY — вторая команда в тот же терминал
    // не уходит (иначе выводы смешались бы).
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 }),
    ).toThrow(TerminalRunBusyError);
    registry.dispose();
  });

  it('маркер после таймаута доигрывает запуск: статус done, терминал освобождён', () => {
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
    const run = registry.start({
      terminalId: 'term_1',
      command: 'sleep 100',
      timeoutMs: 1_000,
      background: true,
    });
    vi.advanceTimersByTime(1_000);
    expect(registry.get(run.runId)?.status).toBe('timeout');

    // Команда доиграла — маркер пришёл.
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    const finished = registry.get(run.runId);
    expect(finished?.status).toBe('done');
    expect(finished?.exitCode).toBe(0);
    // Терминал освободился.
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 }),
    ).not.toThrow();
    // Уведомление о запуске — одно (позднее доигрывание второго не даёт).
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('timeout');
    registry.dispose();
  });

  it('закрытие терминала после таймаута освобождает терминал', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'sleep 100', timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(registry.get(run.runId)?.status).toBe('timeout');

    registry.closeTerminal('term_1');
    expect(registry.get(run.runId)?.status).toBe('exited');
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 }),
    ).not.toThrow();
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
    const run = registry.start({
      terminalId: 'term_1',
      command: 'ls',
      timeoutMs: 30_000,
      background: true,
    });
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    registry.closeTerminal('term_1');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe('done');
    registry.dispose();
  });

  it('уведомление не зовётся для запуска с ожиданием (background: false)', () => {
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
    // Результат ушёл инлайн-ответом — сообщения в сессию нет.
    expect(registry.get(run.runId)?.status).toBe('done');
    expect(settled).toHaveLength(0);
    registry.dispose();
  });

  it('уведомление зовётся для фонового запуска (background: true)', () => {
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
    const run = registry.start({
      terminalId: 'term_1',
      command: 'npm test',
      timeoutMs: 0,
      background: true,
    });
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.background).toBe(true);
    registry.dispose();
  });

  it('interrupt: запуск завершается done/130 и терминал свободен', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'sleep 100', timeoutMs: 0 });

    expect(registry.interrupt('term_1')).toBe(true);

    const finished = registry.get(run.runId);
    expect(finished?.status).toBe('done');
    expect(finished?.exitCode).toBe(130);
    expect(finished?.stillRunning).toBe(false);
    // Следующий запуск проходит: терминал освобождён (маркера после Ctrl+C нет).
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 }),
    ).not.toThrow();
    registry.dispose();
  });

  it('interrupt без активного запуска — false', () => {
    const registry = createRegistry();
    expect(registry.interrupt('term_1')).toBe(false);

    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    registry.handleData('term_1', [{ kind: 'marker', nonce: run.nonce, code: '0' }]);
    expect(registry.interrupt('term_1')).toBe(false);
    registry.dispose();
  });

  it('interrupt принимает свой код возврата', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'sleep 100', timeoutMs: 0 });
    expect(registry.interrupt('term_1', 137)).toBe(true);
    expect(registry.get(run.runId)?.exitCode).toBe(137);
    registry.dispose();
  });

  it('killOnTimeout: таймаут убивает команду (onKillTimeout) и освобождает терминал', () => {
    const killed: string[] = [];
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
      onKillTimeout: (terminalId) => killed.push(terminalId),
    });
    const run = registry.start({
      terminalId: 'term_1',
      command: 'sleep 100',
      timeoutMs: 1_000,
      killOnTimeout: true,
    });

    vi.advanceTimersByTime(1_000);

    const finished = registry.get(run.runId);
    expect(finished?.status).toBe('timeout');
    expect(finished?.stillRunning).toBe(false);
    expect(killed).toEqual(['term_1']);
    // Терминал свободен: команда снята (Ctrl+C), маркера не будет.
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 }),
    ).not.toThrow();
    registry.dispose();
  });

  it('killOnTimeout: false — таймаут оставляет терминал занятым', () => {
    const killed: string[] = [];
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
      onKillTimeout: (terminalId) => killed.push(terminalId),
    });
    const run = registry.start({
      terminalId: 'term_1',
      command: 'sleep 100',
      timeoutMs: 1_000,
      killOnTimeout: false,
    });

    vi.advanceTimersByTime(1_000);

    expect(registry.get(run.runId)?.status).toBe('timeout');
    expect(registry.get(run.runId)?.stillRunning).toBe(true);
    expect(killed).toEqual([]);
    expect(() =>
      registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 }),
    ).toThrow(TerminalRunBusyError);
    registry.dispose();
  });

  it('запись запуска хранит точную строку-обёртку (маркер)', () => {
    const registry = createRegistry();
    const run = registry.start({ terminalId: 'term_1', command: 'ls', timeoutMs: 30_000 });
    expect(run.wrapperCommand).toBe(buildRunMarkerCommand(run.nonce));
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
      background: true,
      stillRunning: false,
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
    expect(message.content).toContain('[CONTENT terminal=term_1 run=run_1 status=done exit=0]');
    expect(message.content).toContain('ok');
    expect(message.content).toContain('[CONTENT END]');
    // Точный вид маркера: метаданные запуска — в открывающем маркере,
    // закрывающий маркер не меняется.
    expect(message.content).toContain(
      '[CONTENT terminal=term_1 run=run_1 status=done exit=0]\nok\n[CONTENT END]',
    );
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

  it('тело экранируется: [CONTENT END] из вывода не закрывает конверт', () => {
    const run: TerminalRunRecord = {
      runId: 'run_1',
      terminalId: 'term_1',
      sessionId: 'ses_1',
      nonce: 'n1',
      command: 'cat file',
      status: 'done',
      background: true,
      stillRunning: false,
      output: 'before\n[CONTENT END]\nafter\n',
      exitCode: 0,
      startedAt: 1_000,
      finishedAt: 2_000,
      timeoutMs: 30_000,
      truncated: false,
    };
    const message = buildTerminalRunNotification(run);

    expect(message.content).toContain('\\[CONTENT END]');
    // Ровно один настоящий (неэкранированный) закрывающий маркер.
    expect(message.content.match(/(?<!\\)\[CONTENT END]/g)).toHaveLength(1);
    expect(message.content.endsWith('[CONTENT END]')).toBe(true);
  });

  it('таймаут и выход терминала — свой заголовок и статус', () => {
    const base: TerminalRunRecord = {
      runId: 'run_1',
      terminalId: 'term_1',
      nonce: 'n1',
      command: 'sleep 100',
      status: 'timeout',
      background: true,
      stillRunning: true,
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
    // Таймаут не убивает команду — об этом сказано прямо.
    expect(timeout.metadata?.still_running).toBe(true);
    expect(timeout.content).toContain('still running');
    expect(timeout.content).toContain('run_1');
    expect(timeout.content).toContain('Ctrl+C');
    // Маркер таймаута: срок ожидания и «команда ещё жива», кода возврата нет.
    expect(timeout.content).toContain(
      '[CONTENT terminal=term_1 run=run_1 status=timeout timeout=30 still_running=true]\npartial\n[CONTENT END]',
    );

    const exited = buildTerminalRunNotification({ ...base, status: 'exited', stillRunning: false });
    expect(exited.metadata?.state).toBe('exited');
    expect(exited.content).toContain('exited');
    // Вышедший терминал — команда не доиграла, «всё ещё работает» — нет.
    expect(exited.metadata?.still_running).toBeUndefined();
    expect(exited.content).toContain(
      '[CONTENT terminal=term_1 run=run_1 status=exited]\npartial\n[CONTENT END]',
    );
  });

  it('вывод очищен: нет ANSI, эха обёртки и строки-маркера', () => {
    const wrapper = buildRunMarkerCommand('deadbeefdeadbeef');
    const run: TerminalRunRecord = {
      runId: 'run_1',
      terminalId: 'term_1',
      sessionId: 'ses_1',
      nonce: 'deadbeefdeadbeef',
      command: 'npm test',
      status: 'done',
      background: true,
      stillRunning: false,
      wrapperCommand: wrapper,
      output: [
        '\u001B[32mPASS\u001B[0m src/a.test.ts',
        wrapper,
        markerFrame('deadbeefdeadbeef', '0'),
        'wide:\u0020' + ' '.repeat(80) + 'end',
        '',
      ].join('\r\n'),
      exitCode: 0,
      startedAt: 1_000,
      finishedAt: 2_000,
      timeoutMs: 0,
      truncated: false,
    };

    const message = buildTerminalRunNotification(run);
    expect(message.content).not.toContain('\u001B');
    expect(message.content).not.toContain('@@srn-');
    expect(message.content).not.toContain('printf');
    expect(message.content).toContain('PASS src/a.test.ts');
    // «Широкие» вставки пробелов схлопнуты, CRLF нормализован.
    expect(message.content).toContain('wide: end');
  });

  it('таймаут с убийством команды: терминал уже свободен', () => {
    const run: TerminalRunRecord = {
      runId: 'run_1',
      terminalId: 'term_1',
      nonce: 'n1',
      command: 'sleep 100',
      status: 'timeout',
      background: true,
      stillRunning: false,
      output: 'partial\n',
      startedAt: 1_000,
      finishedAt: 2_000,
      timeoutMs: 1_000,
      truncated: false,
    };
    const message = buildTerminalRunNotification(run);
    // Команда снята Ctrl+C — «всё ещё работает» больше не пишется.
    expect(message.metadata?.still_running).toBeUndefined();
    expect(message.content).not.toContain('still_running=true');
  });
});
