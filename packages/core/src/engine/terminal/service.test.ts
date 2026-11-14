/**
 * Ф3а: терминальный сервис (`engine/terminal/`).
 *
 * Проверяется:
 *   • кольцевой буфер: монотонный `seq`, replay по `since`, вытеснение старых
 *     данных, **UTF-8-safe** границы (эмодзи/кириллица не рвутся ни по
 *     границе сегмента, ни при вытеснении);
 *   • сервис: создание (id `term_*`, single-flight по `(cwd, shell, backend)`,
 *     идемпотентность по клиентскому id), лимиты (проект/инстанс), ввод
 *     (кап 16 КиБ, rate limit 20 кадров/с), resize, close;
 *   • подписка: replay из буфера → live, несколько подписчиков, сигнал
 *     `onReset` при вытеснении;
 *   • выключатель инстанса: `setEnabled(false)` закрывает всё и запрещает
 *     создание;
 *   • idle-reaper: терминал без подписчиков и без активной сессии убирается;
 *   • аудит: `terminal.open`/`terminal.input`/`terminal.close` — **только**
 *     метаданные (содержимого ввода в записи нет).
 *
 * Изолированно: fake-порт исполнения (никакого реального PTY), fake-таймеры,
 * без сети и без записи на диск.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '@itphx/synth-shared';
import { EventBus } from '../../events/bus.js';
import type {
  ExecRequest,
  ExecResult,
  ExecutionPort,
  PtyHandle,
  PtyOpenRequest,
} from '../../execution/ports/index.js';
import type { TerminalAuditEntry } from './audit.js';
import {
  splitByUtf8Bytes,
  TerminalRingBuffer,
  utf8AlignedSuffix,
} from './ring-buffer.js';
import { TerminalService } from './service.js';
import {
  TerminalDisabledError,
  TerminalLimitError,
  TerminalNotFoundError,
  type TerminalOutputChunk,
} from './types.js';

// ---------------------------------------------------------------------------
// Эмулятор PTY и порта
// ---------------------------------------------------------------------------

/** Выход PTY-сессии (совпадает с контрактом порта). */
interface PtyExitInfo {
  exitCode?: number;
  signal?: string;
}

/** Эмулятор PTY-сессии: пишет куски, выходит по команде теста. */
class FakePtyHandle implements PtyHandle {
  readonly id: string;
  readonly pid = 4242;
  /** Всё, что ушло в терминал. */
  readonly writes: string[] = [];
  /** Все изменения размера. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  /** Сколько раз закрывали. */
  closeCalls = 0;

  private _dataCbs = new Set<(chunk: string) => void>();
  private _exitCbs = new Set<(e: PtyExitInfo) => void>();
  private _exited = false;
  private _exitInfo: PtyExitInfo = {};

  constructor(id: string) {
    this.id = id;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  onData(cb: (chunk: string) => void): () => void {
    this._dataCbs.add(cb);
    return () => {
      this._dataCbs.delete(cb);
    };
  }

  onExit(cb: (e: PtyExitInfo) => void): () => void {
    if (this._exited) {
      cb(this._exitInfo);
      return () => {};
    }
    this._exitCbs.add(cb);
    return () => {
      this._exitCbs.delete(cb);
    };
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.emitExit({ exitCode: 0, signal: 'SIGTERM' });
    return Promise.resolve();
  }

  /** Выдать кусок вывода (как из PTY). */
  emitData(chunk: string): void {
    for (const cb of [...this._dataCbs]) cb(chunk);
  }

  /** Завершить сессию (как из PTY). */
  emitExit(info: PtyExitInfo): void {
    if (this._exited) return;
    this._exited = true;
    this._exitInfo = info;
    for (const cb of [...this._exitCbs]) cb(info);
  }
}

/** Эмулятор порта исполнения: считает открытия PTY, отдаёт эмулятор. */
class FakeExecutionPort implements ExecutionPort {
  readonly pty = true;
  readonly handles: FakePtyHandle[] = [];
  readonly requests: PtyOpenRequest[] = [];

  async execute(_req: ExecRequest): Promise<ExecResult> {
    throw new Error('execute не используется в тестах терминалов');
  }

  async openPty(req: PtyOpenRequest): Promise<PtyHandle> {
    this.requests.push(req);
    const handle = new FakePtyHandle(`pty_${this.handles.length + 1}`);
    this.handles.push(handle);
    return handle;
  }

  /** Последний открытый терминал. */
  get lastHandle(): FakePtyHandle {
    const handle = this.handles[this.handles.length - 1];
    if (!handle) throw new Error('PTY ещё не открывался');
    return handle;
  }
}

/** Есть ли в строке «одиночный» суррогат (след разорванной суррогатной пары). */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Кольцевой буфер
// ---------------------------------------------------------------------------

describe('Кольцевой буфер вывода терминала', () => {
  it('нумерует фрагменты монотонно и отдаёт replay по since', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 4096, segmentBytes: 1024 });

    const first = buffer.append('abc');
    const second = buffer.append('de');
    expect(first).toHaveLength(1);
    expect(first[0]?.seq).toBe(1);
    expect(second[0]?.seq).toBe(2);

    expect(buffer.since(0).map((piece) => piece.data)).toEqual(['abc', 'de']);
    expect(buffer.since(1).map((piece) => piece.data)).toEqual(['de']);
    expect(buffer.since(2)).toEqual([]);

    const snapshot = buffer.snapshot();
    expect(snapshot.chunks).toHaveLength(2);
    expect(snapshot.totalBytes).toBe(5);
    expect(snapshot.droppedBytes).toBe(0);
    expect(snapshot.firstSeq).toBe(1);
    expect(snapshot.lastSeq).toBe(2);
  });

  it('вытесняет старые данные и честно сообщает об этом', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 16, segmentBytes: 4 });

    buffer.append('aaaa');
    buffer.append('bbbb');
    buffer.append('cccc');
    buffer.append('dddd');
    buffer.append('eeee');

    const snapshot = buffer.snapshot();
    expect(snapshot.totalBytes).toBeLessThanOrEqual(16 + 4);
    expect(snapshot.droppedBytes).toBeGreaterThan(0);
    expect(snapshot.firstSeq).toBeGreaterThan(1);
    // Вытесненное клиент уже не получит — буфер честно сообщает границу.
    expect(buffer.since(0)[0]?.seq).toBe(snapshot.firstSeq);
  });

  it('режет кириллицу и эмодзи только по границам кодовых точек', () => {
    // Сегмент 5 байт: кириллица (2 байта) и эмодзи (4 байта) не делятся.
    const parts = splitByUtf8Bytes('Привет😀мир', 5);
    expect(parts.join('')).toBe('Привет😀мир');
    for (const part of parts) {
      expect(hasLoneSurrogate(part)).toBe(false);
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(5);
    }
  });

  it('не рвёт суррогатную пару, пришедшую в двух кусках', () => {
    const buffer = new TerminalRingBuffer({ maxBytes: 4096, segmentBytes: 4096 });

    // PTY отдаёт байты: высокий суррогат в одном куске, низкий — в следующем.
    buffer.append('a\uD83D');
    buffer.append('\uDE00b');

    const joined = buffer.snapshot().chunks.map((piece) => piece.data).join('');
    expect(joined).toBe('a\uD83D\uDE00b');
    expect(joined).not.toContain('\uFFFD');
    expect(hasLoneSurrogate(joined)).toBe(false);
  });

  it('выравнивает суффикс при вытеснении (без битых символов)', () => {
    // «Привет😀» = 16 байт; суффикс до 7 байт — «т😀» (2 + 4 = 6 байт).
    const suffix = utf8AlignedSuffix('Привет😀', 7);
    expect(suffix).toBe('т😀');
    expect(hasLoneSurrogate(suffix)).toBe(false);
    expect(Buffer.byteLength(suffix, 'utf8')).toBeLessThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

describe('Терминальный сервис', () => {
  let clock = 1_700_000_000_000;
  let port: FakeExecutionPort;
  let eventBus: EventBus;
  let auditEntries: TerminalAuditEntry[];
  let events: BusEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_700_000_000_000;
    port = new FakeExecutionPort();
    eventBus = new EventBus();
    auditEntries = [];
    events = [];
    eventBus.subscribe('sess-1', (event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Собрать сервис с тестовыми зависимостями. */
  function createService(
    options: {
      limits?: Record<string, number>;
      now?: () => number;
      isSessionActive?: (sessionId: string) => boolean | Promise<boolean>;
    } = {},
  ): TerminalService {
    return new TerminalService({
      port,
      eventBus,
      audit: {
        record: (entry: TerminalAuditEntry) => {
          auditEntries.push(entry);
        },
      },
      metrics: {
        syncSessions: () => {},
        addBytes: () => {},
      },
      generateId: () => 'uuid-1',
      now: options.now ?? (() => clock),
      ...(options.isSessionActive ? { isSessionActive: options.isSessionActive } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
    });
  }

  /** Базовый вход создания терминала. */
  function createInput(overrides: Record<string, unknown> = {}) {
    return {
      projectId: 'proj-1',
      ownerId: 'user-1',
      cwd: '/work',
      shell: 'bash',
      cols: 80,
      rows: 24,
      ...overrides,
    } as Parameters<TerminalService['create']>[0];
  }

  it('открывает PTY и заводит запись терминала', async () => {
    const service = createService();
    const record = await service.create(createInput({ sessionId: 'sess-1' }));

    expect(record.id).toMatch(/^term_/);
    expect(record.status).toBe('running');
    expect(record.cwd).toBe('/work');
    expect(record.shell).toBe('bash');
    expect(record.cols).toBe(80);
    expect(record.rows).toBe(24);
    expect(record.sessionId).toBe('sess-1');
    expect(record.createdAt).toBe(clock);

    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]?.cwd).toBe('/work');
    expect(port.requests[0]?.shell).toBe('bash');
    expect(port.requests[0]?.cols).toBe(80);

    service.dispose();
  });

  it('публикует terminal.created в канал сессии', async () => {
    const service = createService();
    await service.create(createInput({ sessionId: 'sess-1' }));

    const created = events.find((event) => event.type === ('terminal.created' as never));
    expect(created).toBeDefined();
    expect(created?.data['terminal_id']).toMatch(/^term_/);
    expect(created?.data['project_id']).toBe('proj-1');
    expect(created?.data['status']).toBe('running');

    service.dispose();
  });

  it('не публикует события терминала без привязки к сессии', async () => {
    const service = createService();
    await service.create(createInput());
    expect(events.filter((event) => String(event.type).startsWith('terminal.'))).toHaveLength(0);
    service.dispose();
  });

  it('схлопывает параллельные открытия с одинаковым (cwd, shell, backend)', async () => {
    const service = createService();
    const [first, second] = await Promise.all([
      service.create(createInput()),
      service.create(createInput()),
    ]);

    expect(first.id).toBe(second.id);
    expect(port.requests).toHaveLength(1);
    expect(service.list()).toHaveLength(1);

    service.dispose();
  });

  it('возвращает существующий терминал при повторном создании с тем же id', async () => {
    const service = createService();
    const first = await service.create(createInput({ id: 'term_client-1' }));
    const second = await service.create(createInput({ id: 'term_client-1' }));

    expect(second.id).toBe(first.id);
    expect(port.requests).toHaveLength(1);

    service.dispose();
  });

  it('ограничивает число терминалов проекта', async () => {
    const service = createService({ limits: { maxPerProject: 1 } });
    await service.create(createInput());

    await expect(service.create(createInput())).rejects.toBeInstanceOf(TerminalLimitError);
    await service.create(createInput({ projectId: 'proj-2' })).catch(() => undefined);

    service.dispose();
  });

  it('ограничивает число терминалов инстанса', async () => {
    const service = createService({ limits: { maxPerInstance: 1 } });
    await service.create(createInput({ projectId: 'proj-1' }));

    const error = await service.create(createInput({ projectId: 'proj-2' })).catch((err) => err);
    expect(error).toBeInstanceOf(TerminalLimitError);
    expect((error as TerminalLimitError).scope).toBe('instance');

    service.dispose();
  });

  it('пишет ввод в терминал и аудитирует только метаданные', async () => {
    const service = createService();
    const record = await service.create(createInput());

    service.write(record.id, 'ls -la\n', { actorId: 'user-1' });

    expect(port.lastHandle.writes).toEqual(['ls -la\n']);
    const input = auditEntries.find((entry) => entry.action === 'terminal.input');
    expect(input).toBeDefined();
    expect(input?.bytes).toBe(7);
    expect(input?.enter).toBe(true);
    expect(input?.actorId).toBe('user-1');
    expect(input?.terminalId).toBe(record.id);
    // Содержимого ввода в записи нет — только метаданные.
    expect(JSON.stringify(input)).not.toContain('ls -la');

    service.dispose();
  });

  it('отклоняет кадр ввода больше капа', async () => {
    const service = createService();
    const record = await service.create(createInput());

    const error = (() => {
      try {
        service.write(record.id, 'x'.repeat(16 * 1024 + 1));
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(TerminalLimitError);
    expect((error as TerminalLimitError).scope).toBe('input');
    expect(port.lastHandle.writes).toHaveLength(0);

    service.dispose();
  });

  it('ограничивает скорость ввода (20 кадров в секунду)', async () => {
    const service = createService();
    const record = await service.create(createInput());

    for (let i = 0; i < 20; i += 1) service.write(record.id, 'a');

    const error = (() => {
      try {
        service.write(record.id, 'a');
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(TerminalLimitError);
    expect((error as TerminalLimitError).scope).toBe('rate');

    // Через секунду токен восполнился.
    clock += 1000;
    expect(() => service.write(record.id, 'a')).not.toThrow();

    service.dispose();
  });

  it('меняет размер терминала', async () => {
    const service = createService();
    const record = await service.create(createInput({ sessionId: 'sess-1' }));

    const updated = service.resize(record.id, 120, 40);
    expect(updated.cols).toBe(120);
    expect(updated.rows).toBe(40);
    expect(port.lastHandle.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(events.some((event) => event.type === ('terminal.updated' as never))).toBe(true);

    service.dispose();
  });

  it('закрывает терминал: выход подписчика, события, аудит', async () => {
    const service = createService();
    const record = await service.create(createInput({ sessionId: 'sess-1' }));
    const exits: unknown[] = [];
    service.subscribe(record.id, {}, { onData: () => undefined, onExit: (info) => exits.push(info) });

    await service.close(record.id, { actorId: 'user-1' });

    expect(port.lastHandle.closeCalls).toBe(1);
    expect(exits).toHaveLength(1);
    expect(service.get(record.id)).toBeNull();
    expect(events.some((event) => event.type === ('terminal.exited' as never))).toBe(true);
    expect(events.some((event) => event.type === ('terminal.deleted' as never))).toBe(true);
    const close = auditEntries.find((entry) => entry.action === 'terminal.close');
    expect(close?.reason).toBe('user');
    expect(close?.actorId).toBe('user-1');

    service.dispose();
  });

  it('отдаёт replay из буфера, а затем живой поток (несколько подписчиков)', async () => {
    const service = createService();
    const record = await service.create(createInput());
    const handle = port.lastHandle;

    handle.emitData('первый ');
    handle.emitData('второй');
    await vi.advanceTimersByTimeAsync(20);

    const replayed: TerminalOutputChunk[] = [];
    const live: TerminalOutputChunk[] = [];
    const second: TerminalOutputChunk[] = [];

    service.subscribe(
      record.id,
      { since: 0 },
      {
        onData: (piece) => {
          replayed.push(piece);
          live.push(piece);
        },
        onExit: () => undefined,
      },
    );
    service.subscribe(
      record.id,
      {},
      { onData: (piece) => second.push(piece), onExit: () => undefined },
    );

    expect(replayed.map((piece) => piece.data).join('')).toBe('первый второй');
    const replayCount = replayed.length;

    handle.emitData('третий');
    await vi.advanceTimersByTimeAsync(20);

    // Подписчик с replay получает и live, подписчик без replay — только live.
    expect(live.slice(replayCount).map((piece) => piece.data).join('')).toBe('третий');
    expect(second.map((piece) => piece.data).join('')).toBe('третий');

    service.dispose();
  });

  it('сообщает подписчику о вытесненном выводе (onReset)', async () => {
    const service = createService({ limits: { ringBufferBytes: 32, ringSegmentBytes: 8 } });
    const record = await service.create(createInput());
    const handle = port.lastHandle;

    const resets: Array<{ droppedBytes: number; firstSeq: number }> = [];
    service.subscribe(
      record.id,
      {},
      {
        onData: () => undefined,
        onExit: () => undefined,
        onReset: (info) => resets.push(info),
      },
    );

    for (let i = 0; i < 10; i += 1) handle.emitData('0123456789');
    await vi.advanceTimersByTimeAsync(20);

    expect(resets.length).toBeGreaterThan(0);
    expect(resets[0]?.droppedBytes).toBeGreaterThan(0);

    service.dispose();
  });

  it('выключатель инстанса закрывает терминалы и запрещает создание', async () => {
    const service = createService();
    await service.create(createInput({ sessionId: 'sess-1' }));

    service.setEnabled(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(port.lastHandle.closeCalls).toBe(1);
    expect(service.list()).toHaveLength(0);
    await expect(service.create(createInput())).rejects.toBeInstanceOf(TerminalDisabledError);

    service.setEnabled(true);
    await expect(service.create(createInput())).resolves.toBeDefined();

    service.dispose();
  });

  it('убирает терминал, простаивающий без подписчиков', async () => {
    const service = createService({ limits: { idleMs: 1000, reaperIntervalMs: 100 } });
    const record = await service.create(createInput());

    clock += 2000;
    await vi.advanceTimersByTimeAsync(150);

    expect(service.get(record.id)).toBeNull();
    expect(port.lastHandle.closeCalls).toBe(1);

    service.dispose();
  });

  it('не трогает терминал с подписчиками и терминал активной сессии', async () => {
    const service = createService({
      limits: { idleMs: 1000, reaperIntervalMs: 100 },
      isSessionActive: () => true,
    });
    const withSubscriber = await service.create(createInput());
    const bound = await service.create(createInput({ sessionId: 'sess-1' }));

    service.subscribe(withSubscriber.id, {}, { onData: () => undefined, onExit: () => undefined });

    clock += 5000;
    await vi.advanceTimersByTimeAsync(150);

    expect(service.get(withSubscriber.id)).not.toBeNull();
    expect(service.get(bound.id)).not.toBeNull();

    service.dispose();
  });

  it('не находит несуществующий терминал', async () => {
    const service = createService();
    expect(() => service.write('term_missing', 'x')).toThrow(TerminalNotFoundError);
    await expect(service.close('term_missing')).rejects.toBeInstanceOf(TerminalNotFoundError);
    service.dispose();
  });

  it('оставляет запись и вывод завершённого терминала (естественный выход)', async () => {
    const service = createService();
    const record = await service.create(createInput({ sessionId: 'sess-1' }));
    const handle = port.lastHandle;

    handle.emitData('до выхода');
    await vi.advanceTimersByTimeAsync(20);
    handle.emitExit({ exitCode: 3 });

    const exited = service.get(record.id);
    expect(exited?.status).toBe('exited');
    expect(exited?.exitCode).toBe(3);
    // Живой список завершённые не показывает, но запись и вывод доступны.
    expect(service.list()).toHaveLength(0);
    expect(service.list({ includeExited: true })).toHaveLength(1);
    expect(service.output(record.id)?.chunks.map((piece) => piece.data).join('')).toBe('до выхода');
    expect(events.some((event) => event.type === ('terminal.exited' as never))).toBe(true);

    service.dispose();
  });

  it('отдаёт выход сразу при подписке на завершённый терминал', async () => {
    const service = createService();
    const record = await service.create(createInput());
    port.lastHandle.emitExit({ exitCode: 0, signal: 'SIGTERM' });

    const exits: unknown[] = [];
    service.subscribe(
      record.id,
      {},
      { onData: () => undefined, onExit: (info) => exits.push(info) },
    );

    expect(exits).toHaveLength(1);

    service.dispose();
  });
});
