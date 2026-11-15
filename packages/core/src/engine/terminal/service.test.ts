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
import type { BlobStore } from '../../storage/ports/blob-store.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';
import type { TerminalAuditEntry } from './audit.js';
import {
  splitByUtf8Bytes,
  TerminalRingBuffer,
  utf8AlignedSuffix,
} from './ring-buffer.js';
import { TerminalService } from './service.js';
import {
  TerminalAlreadyRunningError,
  TerminalDisabledError,
  TerminalExitedError,
  TerminalLimitError,
  TerminalNotFoundError,
  TerminalUnavailableError,
  type TerminalOutputChunk,
  type TerminalPortContext,
  type TerminalRecord,
} from './types.js';
import {
  buildRunMarkerCommand,
  TERMINAL_RUN_MARKER_PREFIX,
  TerminalRunBusyError,
  type TerminalRunRecord,
} from './runs.js';
import { cleanRunOutput } from './output.js';

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

  /**
   * Если задан — `close()` ждёт его разрешения (эмуляция `SIGTERM` → `SIGKILL`:
   * PTY гаснет не мгновенно).
   */
  holdClose: (() => Promise<void>) | null = null;

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
    const hold = this.holdClose;
    if (hold) {
      return hold().then(() => {
        this.emitExit({ exitCode: 0, signal: 'SIGTERM' });
      });
    }
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

/**
 * Fake-хранилище блобов: запись откладывается до `release()`.
 *
 * Нужно, чтобы гонка «снимок пишется ↔ терминал удаляется» была
 * детерминированной: без ожидания незавершённой записи снимок записался бы
 * **после** удаления — и удалённый терминал воскрес бы после рестарта ядра.
 */
class DeferredWriteBlobStore extends MemoryBlobStore {
  /** Пути начатых записей (в порядке вызовов). */
  readonly writes: string[] = [];
  /** Ворота: пока не открыты — записи висят. */
  private readonly _gate: Promise<void>;
  /** Открыватель ворот (`null` — ещё не создан). */
  private _open: (() => void) | null = null;

  constructor() {
    super();
    this._gate = new Promise<void>((resolve) => {
      this._open = resolve;
    });
  }

  override async write(
    path: string,
    data: Buffer | string,
    opts?: { mode?: number },
  ): Promise<void> {
    this.writes.push(path);
    await this._gate;
    await super.write(path, data, opts);
  }

  /** Открыть ворота: отложенные записи применяются. */
  release(): void {
    this._open?.();
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
      onRunFinished?: (run: TerminalRunRecord, terminal: TerminalRecord | null) => void;
      blobs?: BlobStore;
      resolvePort?: (ctx: TerminalPortContext) => ExecutionPort | Promise<ExecutionPort>;
      autoRestore?: boolean;
      defaultShell?: string | null;
      auditInput?: boolean;
      logger?: { warn: (message: string) => void; error: (message: string) => void };
    } = {},
  ): TerminalService {
    let idCounter = 0;
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
      // Уникальный id на терминал: иначе два терминала выглядели бы одним.
      generateId: () => `uuid-${++idCounter}`,
      now: options.now ?? (() => clock),
      ...(options.isSessionActive ? { isSessionActive: options.isSessionActive } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.onRunFinished ? { onRunFinished: options.onRunFinished } : {}),
      ...(options.blobs ? { blobs: options.blobs } : {}),
      ...(options.resolvePort ? { resolvePort: options.resolvePort } : {}),
      ...(options.autoRestore !== undefined ? { autoRestore: options.autoRestore } : {}),
      ...(options.defaultShell !== undefined ? { defaultShell: options.defaultShell } : {}),
      ...(options.auditInput !== undefined ? { auditInput: options.auditInput } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
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

  it('последовательные открытия дают разные терминалы (single-flight — только по незавершённым)', async () => {
    const service = createService();
    const first = await service.create(createInput());
    const second = await service.create(createInput());

    expect(first.id).not.toBe(second.id);
    expect(port.requests).toHaveLength(2);
    expect(service.list()).toHaveLength(2);

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

  it('setLimits меняет параметры выполнения на лету (создание и reaper)', async () => {
    const service = createService({ limits: { reaperIntervalMs: 100 } });
    const first = await service.create(createInput());

    // Лимит проекта снижается live: уже открытый терминал не закрывается,
    // но следующий создать нельзя.
    service.setLimits({ maxPerProject: 1 });
    const error = await service.create(createInput()).catch((err) => err);
    expect(error).toBeInstanceOf(TerminalLimitError);
    expect((error as TerminalLimitError).scope).toBe('project');
    expect(service.list().map((record) => record.id)).toEqual([first.id]);

    // idleMs тоже live: reaper на следующем тике читает новое значение.
    service.setLimits({ idleMs: 1000 });
    clock += 2000;
    await vi.advanceTimersByTimeAsync(150);
    expect(service.get(first.id)).toBeNull();

    service.dispose();
  });

  it('setLimits игнорирует некорректные значения (положительное целое)', async () => {
    const warnings: string[] = [];
    const service = createService({
      limits: { maxPerProject: 2 },
      logger: {
        warn: (message: string) => warnings.push(message),
        error: (message: string) => warnings.push(message),
      },
    });

    service.setLimits({ maxPerProject: 0, maxPerInstance: -3, idleMs: Number.NaN });

    // Лимит проекта остался прежним (2): некорректные значения не применены.
    await service.create(createInput());
    await service.create(createInput());
    const error = await service.create(createInput()).catch((err) => err);
    expect(error).toBeInstanceOf(TerminalLimitError);
    expect((error as TerminalLimitError).limit).toBe(2);
    expect(warnings.length).toBe(3);

    service.dispose();
  });

  it('setDefaultShell применяется к новым терминалам, существующие не меняются', async () => {
    const service = createService();
    const first = await service.create(createInput());
    expect(first.shell).toBe('bash');

    service.setDefaultShell('/bin/zsh');
    expect(service.getDefaultShell()).toBe('/bin/zsh');
    const second = await service.create(createInput({ shell: undefined, cwd: '/work-2' }));

    expect(second.shell).toBe('/bin/zsh');
    // Новый PTY открыт с новой оболочкой.
    expect(port.requests[1]?.shell).toBe('/bin/zsh');
    // Существующий терминал не перезапущен: у него прежняя оболочка.
    expect(service.get(first.id)?.shell).toBe('bash');
    expect(port.requests).toHaveLength(2);

    // Сброс (`null`) — платформенный дефолт.
    service.setDefaultShell(null);
    const third = await service.create(createInput({ shell: undefined, cwd: '/work-3' }));
    expect(third.shell).toBe(process.env.SHELL?.trim() || '/bin/bash');

    service.dispose();
  });

  it('defaultShell из опций сервиса применяется к новому терминалу', async () => {
    const service = createService({ defaultShell: '/bin/fish' });
    const record = await service.create(createInput({ shell: undefined }));
    expect(record.shell).toBe('/bin/fish');
    expect(port.requests[0]?.shell).toBe('/bin/fish');
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

  it('помечает терминал `closing` синхронно (гонка disable → enable)', async () => {
    const service = createService();
    const record = await service.create(createInput());

    // PTY гаснет не мгновенно (`SIGTERM` → `SIGKILL`) — держим закрытие.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    port.lastHandle.holdClose = () => held;

    service.setEnabled(false);

    // Ответ `PUT /settings/terminal {enabled:false}` уходит сразу: до выхода
    // оболочки запись уже не `running` — UI не покажет «живой» терминал и не
    // получит его в списке как рабочий.
    expect(service.get(record.id)?.status).toBe('closing');
    expect(service.list().map((t) => t.status)).toEqual(['closing']);
    await expect(service.create(createInput())).rejects.toBeInstanceOf(TerminalDisabledError);

    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.get(record.id)).toBeNull();

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

  describe('запуски команд', () => {
    /** Текст маркера завершения запуска (как его печатает `printf`). */
    function marker(nonce: string, code: string): string {
      return `${TERMINAL_RUN_MARKER_PREFIX}${nonce};${code}\u0007`;
    }

    it('отправляет команду и невидимый маркер в терминал', async () => {
      const service = createService();
      const record = await service.create(createInput({ sessionId: 'sess-1' }));

      const run = service.startRun({
        terminalId: record.id,
        command: 'ls -la',
        timeoutMs: 30_000,
      });

      const handle = port.lastHandle;
      // Enter в raw-режиме терминала — это CR (`\r`), а не LF: tmux/less/REPL
      // ждут именно `\r`.
      expect(handle.writes[0]).toBe('ls -la\r');
      expect(handle.writes[1]).toContain('printf');
      expect(handle.writes[1]).toContain(run.nonce);
      expect(handle.writes[1]).toContain('"$?"');
      expect(handle.writes[1]?.endsWith('\r')).toBe(true);
      expect(service.getRun(run.runId)?.status).toBe('running');

      service.dispose();
    });

    it('маркер в потоке завершает запуск: код возврата фиксируется, маркер вырезан из буфера', async () => {
      const service = createService();
      const record = await service.create(createInput({ sessionId: 'sess-1' }));
      const run = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
      });

      port.lastHandle.emitData('file1\n');
      port.lastHandle.emitData(marker(run.nonce, '0'));
      port.lastHandle.emitData('after\n');

      const finished = service.getRun(run.runId);
      expect(finished?.status).toBe('done');
      expect(finished?.exitCode).toBe(0);
      expect(finished?.output).toBe('file1\n');
      // Маркер в буфер терминала не попал — только обычный текст.
      const buffered = service.output(record.id)?.chunks.map((piece) => piece.data).join('');
      expect(buffered).toBe('file1\nafter\n');
      expect(buffered).not.toContain('synth-run');

      service.dispose();
    });

    it('ожидание завершения возвращает финальный снимок', async () => {
      const service = createService();
      const record = await service.create(createInput());
      const run = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
      });

      const waiting = service.waitRun(run.runId, 30_000);
      port.lastHandle.emitData(marker(run.nonce, '2'));
      const finished = await waiting;

      expect(finished?.status).toBe('done');
      expect(finished?.exitCode).toBe(2);

      service.dispose();
    });

    it('второй запуск в том же терминале — TerminalRunBusyError', async () => {
      const service = createService();
      const record = await service.create(createInput());
      service.startRun({ terminalId: record.id, command: 'ls', timeoutMs: 30_000 });

      expect(() =>
        service.startRun({ terminalId: record.id, command: 'pwd', timeoutMs: 30_000 }),
      ).toThrow(TerminalRunBusyError);

      service.dispose();
    });

    it('таймаут запуска завершает его статусом timeout', async () => {
      const service = createService();
      const record = await service.create(createInput());
      const run = service.startRun({
        terminalId: record.id,
        command: 'sleep 100',
        timeoutMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(service.getRun(run.runId)?.status).toBe('timeout');
      // Команду не убивали — терминал остаётся занятым.
      expect(service.getRun(run.runId)?.stillRunning).toBe(true);

      service.dispose();
    });

    it('killOnTimeout: таймаут пишет Ctrl+C в PTY и освобождает терминал', async () => {
      const service = createService();
      const record = await service.create(createInput());
      const run = service.startRun({
        terminalId: record.id,
        command: 'sleep 100',
        timeoutMs: 1_000,
        killOnTimeout: true,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      const finished = service.getRun(run.runId);
      expect(finished?.status).toBe('timeout');
      expect(finished?.stillRunning).toBe(false);
      // Ctrl+C ушёл прямо в PTY (после команды и строки-маркера).
      expect(port.lastHandle.writes).toContain('\u0003');
      // Терминал свободен — следующий запуск проходит.
      const next = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
      });
      expect(next.status).toBe('running');

      service.dispose();
    });

    it('закрытие терминала посреди запуска завершает его статусом exited', async () => {
      const settled: TerminalRunRecord[] = [];
      const service = createService({
        onRunFinished: (run) => {
          settled.push(run);
        },
      });
      const record = await service.create(createInput({ sessionId: 'sess-1' }));
      const run = service.startRun({
        terminalId: record.id,
        command: 'sleep 100',
        timeoutMs: 30_000,
        background: true,
      });

      await service.close(record.id);

      expect(service.getRun(run.runId)?.status).toBe('exited');
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('exited');
      expect(settled[0]?.sessionId).toBe('sess-1');

      service.dispose();
    });

    it('колбэк завершения зовётся один раз с финальным статусом и кодом', async () => {
      const settled: TerminalRunRecord[] = [];
      const service = createService({
        onRunFinished: (run) => {
          settled.push(run);
        },
      });
      const record = await service.create(createInput({ sessionId: 'sess-1' }));
      const run = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
        background: true,
      });

      port.lastHandle.emitData('out\n');
      port.lastHandle.emitData(marker(run.nonce, '0'));
      // Повторный маркер ничего не меняет (переход состояния — один).
      port.lastHandle.emitData(marker(run.nonce, '0'));

      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('done');
      expect(settled[0]?.exitCode).toBe(0);
      expect(settled[0]?.output).toBe('out\n');

      service.dispose();
    });

    it('запуск с ожиданием не порождает уведомление (ответ уже инлайн)', async () => {
      const settled: TerminalRunRecord[] = [];
      const service = createService({
        onRunFinished: (run) => {
          settled.push(run);
        },
      });
      const record = await service.create(createInput({ sessionId: 'sess-1' }));
      const run = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
      });

      port.lastHandle.emitData('out\n');
      port.lastHandle.emitData(marker(run.nonce, '0'));

      expect(service.getRun(run.runId)?.status).toBe('done');
      expect(settled).toHaveLength(0);

      service.dispose();
    });

    it('Ctrl+C (ETX) завершает активный запуск и освобождает терминал', async () => {
      const settled: TerminalRunRecord[] = [];
      const service = createService({
        onRunFinished: (run) => {
          settled.push(run);
        },
      });
      const record = await service.create(createInput({ sessionId: 'sess-1' }));
      const run = service.startRun({
        terminalId: record.id,
        command: 'sleep 100',
        timeoutMs: 0,
        background: true,
      });

      // Маркер после Ctrl+C не придёт: прерывание снимает строку целиком.
      service.write(record.id, '\u0003');

      const finished = service.getRun(run.runId);
      expect(finished?.status).toBe('done');
      expect(finished?.exitCode).toBe(130);
      expect(finished?.stillRunning).toBe(false);
      // Уведомление ушло (запуск фоновый) — ровно одно.
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('done');
      expect(settled[0]?.exitCode).toBe(130);

      // Терминал снова свободен: следующий запуск проходит.
      const next = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
      });
      expect(next.status).toBe('running');

      service.dispose();
    });

    it('обычный ввод без ETX запуск не трогает', async () => {
      const service = createService();
      const record = await service.create(createInput());
      const run = service.startRun({
        terminalId: record.id,
        command: 'sleep 100',
        timeoutMs: 0,
      });

      service.write(record.id, 'abc');

      expect(service.getRun(run.runId)?.status).toBe('running');
      service.dispose();
    });

    it('cleanRunOutput: реальный вывод с эхом обёртки и ANSI', () => {
      const wrapper = buildRunMarkerCommand('a1b2c3d4e5f60718');
      // Как это выглядит в потоке PTY: эхо введённой строки-обёртки, цвета,
      // служебный OSC-маркер (он вырезается сканером, но остаётся в примере
      // для полноты) и CRLF от ONLCR.
      const raw = [
        '\u001B[1m$ npm test\u001B[0m',
        `user@host:~/proj$ ${wrapper}`,
        '\u001B[32m✓\u001B[0m 12 passed',
        '\u001B]3008;title\u0007',
        '',
      ].join('\r\n');

      const cleaned = cleanRunOutput(raw, wrapper);
      expect(cleaned).toBe('$ npm test\n✓ 12 passed');
      expect(cleaned).not.toContain('synth-run');
      expect(cleaned).not.toContain('\u001B');
    });

    it('терминал без привязки к сессии: запуск всё равно работает', async () => {
      const service = createService();
      const record = await service.create(createInput());
      const run = service.startRun({
        terminalId: record.id,
        command: 'ls',
        timeoutMs: 30_000,
      });

      port.lastHandle.emitData(marker(run.nonce, '0'));

      expect(service.getRun(run.runId)?.status).toBe('done');
      expect(service.getRun(run.runId)?.sessionId).toBeUndefined();

      service.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Аудит: только выполненные команды
  // -------------------------------------------------------------------------

  describe('Аудит ввода', () => {
    it('кадр с Enter (команда) попадает в журнал', async () => {
      const service = createService();
      const record = await service.create(createInput());

      service.write(record.id, 'ls -la\n', { actorId: 'user-1' });

      const input = auditEntries.find((entry) => entry.action === 'terminal.input');
      expect(input).toBeDefined();
      expect(input?.bytes).toBe(7);
      expect(input?.enter).toBe(true);
      expect(input?.actorId).toBe('user-1');
      // Содержимого ввода в записи нет — только метаданные.
      expect(JSON.stringify(input)).not.toContain('ls -la');

      service.dispose();
    });

    it('обычный кадр (без Enter) в журнал не попадает, но считается метрикой', async () => {
      const bytes: Array<{ op: string; value: number }> = [];
      const service = new TerminalService({
        port,
        eventBus,
        audit: {
          record: (entry: TerminalAuditEntry) => {
            auditEntries.push(entry);
          },
        },
        metrics: {
          syncSessions: () => {},
          addBytes: (op, value) => bytes.push({ op, value }),
        },
        generateId: () => 'uuid-1',
        now: () => clock,
      });
      const record = await service.create(createInput());

      service.write(record.id, 'ls', { actorId: 'user-1' });

      expect(auditEntries.some((entry) => entry.action === 'terminal.input')).toBe(false);
      expect(bytes).toContainEqual({ op: 'input', value: 2 });

      service.dispose();
    });

    it('setAuditInput(false) — команда не пишется в журнал, метрика остаётся', async () => {
      const bytes: Array<{ op: string; value: number }> = [];
      const service = new TerminalService({
        port,
        eventBus,
        audit: {
          record: (entry: TerminalAuditEntry) => {
            auditEntries.push(entry);
          },
        },
        metrics: {
          syncSessions: () => {},
          addBytes: (op, value) => bytes.push({ op, value }),
        },
        generateId: () => 'uuid-1',
        now: () => clock,
      });
      const record = await service.create(createInput({ sessionId: 'sess-1' }));

      service.setAuditInput(false);
      expect(service.isAuditInput()).toBe(false);

      service.write(record.id, 'ls -la\n', { actorId: 'user-1' });

      // Содержимое команды в журнал не попало (даже метаданные кадра).
      expect(auditEntries.some((entry) => entry.action === 'terminal.input')).toBe(false);
      // Объём ввода виден метрикой — она считается всегда.
      expect(bytes).toContainEqual({ op: 'input', value: 7 });
      // Аудит открытия не меняется выключателем ввода.
      expect(auditEntries.some((entry) => entry.action === 'terminal.open')).toBe(true);

      // Включили обратно — запись снова идёт.
      service.setAuditInput(true);
      service.write(record.id, 'pwd\n', { actorId: 'user-1' });
      expect(auditEntries.filter((entry) => entry.action === 'terminal.input')).toHaveLength(1);

      service.dispose();
    });

    it('auditInput=false из опций сервиса — стартовое значение', async () => {
      const service = createService({ auditInput: false });
      const record = await service.create(createInput());
      service.write(record.id, 'ls\n', { actorId: 'user-1' });

      expect(auditEntries.some((entry) => entry.action === 'terminal.input')).toBe(false);
      expect(auditEntries.some((entry) => entry.action === 'terminal.open')).toBe(true);

      service.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Снимки и восстановление (PROP-132)
  // -------------------------------------------------------------------------

  describe('Снимки терминалов', () => {
    let blobs: MemoryBlobStore;

    beforeEach(() => {
      blobs = new MemoryBlobStore();
    });

    it('снимок пишется при выходе процесса', async () => {
      const service = createService({ blobs });
      const record = await service.create(createInput());
      port.lastHandle.emitData('вывод\n');

      port.lastHandle.emitExit({ exitCode: 0 });
      // Запись снимка — best-effort (fire-and-forget): дожидаемся микротаска.
      await vi.waitFor(async () => {
        expect(await blobs.exists(`terminals/${record.id}/meta.json`)).toBe(true);
      });

      const meta = await blobs.read(`terminals/${record.id}/meta.json`);
      expect(meta).not.toBeNull();
      const parsed = JSON.parse(meta!.toString('utf8')) as {
        record: { id: string; status: string };
        savedAt: number;
      };
      expect(parsed.record.id).toBe(record.id);
      expect(parsed.savedAt).toBeGreaterThan(0);

      const output = await blobs.read(`terminals/${record.id}/output.txt`);
      expect(output?.toString('utf8')).toContain('вывод');

      service.dispose();
    });

    it('явное удаление терминала убирает его снимок', async () => {
      const service = createService({ blobs });
      const record = await service.create(createInput());
      port.lastHandle.emitExit({ exitCode: 0 });
      await vi.waitFor(async () => {
        expect(await blobs.exists(`terminals/${record.id}/meta.json`)).toBe(true);
      });

      await service.delete(record.id);

      expect(await blobs.exists(`terminals/${record.id}/meta.json`)).toBe(false);
      expect(await blobs.exists(`terminals/${record.id}/output.txt`)).toBe(false);

      service.dispose();
    });

    it('удаление сразу после выхода дожидается незавершённой записи снимка', async () => {
      // Запись снимка отложена (fake-хранилище): без ожидания `pendingSnapshot`
      // снимок записался бы **после** удаления — и удалённый терминал воскрес
      // бы после рестарта ядра.
      const deferred = new DeferredWriteBlobStore();
      const service = createService({ blobs: deferred });
      const record = await service.create(createInput());
      port.lastHandle.emitData('вывод\n');
      port.lastHandle.emitExit({ exitCode: 0 });

      // Запись снимка начата, но ещё не применена (ждёт разрешения).
      expect(deferred.writes).toContain(`terminals/${record.id}/meta.json`);
      expect(await deferred.exists(`terminals/${record.id}/meta.json`)).toBe(false);

      let deleted = false;
      const deleting = service.delete(record.id).then(() => {
        deleted = true;
      });
      // `delete()` ждёт запись снимка — снимка на диске ещё нет.
      await Promise.resolve();
      await Promise.resolve();
      expect(deleted).toBe(false);
      expect(await deferred.exists(`terminals/${record.id}/meta.json`)).toBe(false);

      deferred.release();
      await deleting;

      // Снимок записан **и** убран удалением: удалённый терминал не воскреснет.
      expect(deferred.writes).toContain(`terminals/${record.id}/meta.json`);
      expect(await deferred.exists(`terminals/${record.id}/meta.json`)).toBe(false);
      expect(await deferred.exists(`terminals/${record.id}/output.txt`)).toBe(false);

      service.dispose();
    });
  });

  describe('Восстановление из снимков', () => {
    let blobs: MemoryBlobStore;

    beforeEach(() => {
      blobs = new MemoryBlobStore();
    });

    /** Положить снимок терминала в blob-хранилище. */
    async function seedSnapshot(
      id: string,
      lastActivityAt: number,
      output: string,
      options: { runningAtSave?: boolean } = {},
    ): Promise<void> {
      await blobs.write(
        `terminals/${id}/meta.json`,
        JSON.stringify({
          version: 2,
          savedAt: lastActivityAt,
          // Старый снимок (без поля) — признака «жив» в нём нет вовсе.
          ...(options.runningAtSave !== undefined
            ? { runningAtSave: options.runningAtSave }
            : {}),
          record: {
            id,
            projectId: 'proj-1',
            ownerId: 'user-1',
            cwd: '/work',
            shell: 'bash',
            status: 'running',
            cols: 80,
            rows: 24,
            createdAt: lastActivityAt,
            lastActivityAt,
            target: 'inline',
          },
        }),
      );
      await blobs.write(`terminals/${id}/output.txt`, output);
    }

    it('живой снимок поднимает терминал заново: новый PTY, статус running, история на месте', async () => {
      await seedSnapshot('term_r', clock - 1000, 'сохранённый вывод\n', { runningAtSave: true });
      const service = createService({ blobs });

      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(1);
      const record = service.get('term_r');
      expect(record?.status).toBe('running');
      expect(record?.restored).toBe(true);
      expect(record?.cwd).toBe('/work');
      expect(record?.shell).toBe('bash');
      // Восстановление = **запуск процесса**: поднят новый PTY с теми же
      // параметрами.
      expect(port.requests).toHaveLength(1);
      expect(port.requests[0]).toMatchObject({ cwd: '/work', shell: 'bash', cols: 80, rows: 24 });
      // История вывода доступна: `output()` отдаёт сохранённый хвост.
      expect(service.output('term_r')?.chunks.map((chunk) => chunk.data).join('')).toBe(
        'сохранённый вывод\n',
      );

      service.dispose();
    });

    it('завершённый снимок не восстанавливается, файл удаляется', async () => {
      // Терминал завершился **до** остановки ядра — воскресать нечего.
      const first = createService({ blobs });
      const record = await first.create(createInput());
      port.lastHandle.emitData('вывод\n');
      port.lastHandle.emitExit({ exitCode: 0 });
      await vi.waitFor(async () => {
        expect(await blobs.exists(`terminals/${record.id}/meta.json`)).toBe(true);
      });
      const meta = JSON.parse(
        (await blobs.read(`terminals/${record.id}/meta.json`))!.toString('utf8'),
      ) as { runningAtSave?: boolean };
      expect(meta.runningAtSave).toBe(false);
      first.dispose();

      const service = createService({ blobs });
      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(0);
      expect(service.get(record.id)).toBeNull();
      expect(await blobs.exists(`terminals/${record.id}/meta.json`)).toBe(false);
      expect(await blobs.exists(`terminals/${record.id}/output.txt`)).toBe(false);

      service.dispose();
    });

    it('старый снимок без runningAtSave не восстанавливается (нет признака «жив»)', async () => {
      await seedSnapshot('term_legacy', clock - 1000, 'вывод');
      const service = createService({ blobs });

      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(0);
      expect(service.get('term_legacy')).toBeNull();
      expect(await blobs.exists('terminals/term_legacy/meta.json')).toBe(false);

      service.dispose();
    });

    it('не удалось поднять PTY — терминал остаётся exited с сохранённым выводом (warn в лог)', async () => {
      await seedSnapshot('term_no_pty', clock - 1000, 'сохранённый вывод\n', {
        runningAtSave: true,
      });
      const warnings: string[] = [];
      const service = createService({
        blobs,
        // Точка исполнения недоступна — старт процесса не должен падать.
        resolvePort: () => {
          throw new Error('пул недоступен');
        },
        logger: {
          warn: (message: string) => warnings.push(message),
          error: (message: string) => warnings.push(message),
        },
      });

      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(1);
      const record = service.get('term_no_pty');
      expect(record?.status).toBe('exited');
      expect(record?.restored).toBe(true);
      // Вывод сохранён — терминал можно перезапустить вручную.
      expect(service.output('term_no_pty')?.chunks.map((chunk) => chunk.data).join('')).toBe(
        'сохранённый вывод\n',
      );
      expect(warnings.some((message) => message.includes('не восстановлен'))).toBe(true);

      service.dispose();
    });

    it('просроченная запись (старше TTL) не поднимается, файлы удаляются', async () => {
      const idleMs = 2 * 24 * 60 * 60 * 1000;
      await seedSnapshot('term_old', clock - idleMs - 1000, 'старый вывод', {
        runningAtSave: true,
      });
      const service = createService({ blobs });

      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(0);
      expect(service.get('term_old')).toBeNull();
      expect(await blobs.exists('terminals/term_old/meta.json')).toBe(false);
      expect(await blobs.exists('terminals/term_old/output.txt')).toBe(false);

      service.dispose();
    });

    it('setLimits меняет TTL снимков на лету — старый по новому сроку не поднимается', async () => {
      // Снимок свежий по дефолтному TTL (2 дня), но старый по новому сроку.
      await seedSnapshot('term_ttl', clock - 60_000, 'вывод', { runningAtSave: true });
      const service = createService({ blobs });

      service.setLimits({ idleMs: 1000 });
      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(0);
      expect(service.get('term_ttl')).toBeNull();
      expect(await blobs.exists('terminals/term_ttl/meta.json')).toBe(false);

      service.dispose();
    });

    it('autoRestore=false — снимки не поднимаются', async () => {
      await seedSnapshot('term_off', clock - 1000, 'вывод', { runningAtSave: true });
      const service = createService({ blobs, autoRestore: false });

      const restored = await service.restoreFromSnapshots();

      expect(restored).toBe(0);
      expect(service.get('term_off')).toBeNull();
      // Файлы не удаляются сразу — их убирает reaper.
      expect(await blobs.exists('terminals/term_off/meta.json')).toBe(true);

      service.dispose();
    });

    it('восстановленный терминал можно перезапустить (после выхода нового PTY)', async () => {
      await seedSnapshot('term_r', clock - 1000, 'вывод', { runningAtSave: true });
      const service = createService({ blobs });
      await service.restoreFromSnapshots();
      // Новый PTY вышел — терминал снова завершён, его можно перезапустить.
      port.lastHandle.emitExit({ exitCode: 0, signal: 'SIGTERM' });

      const restarted = await service.restart('term_r');

      expect(restarted.id).toBe('term_r');
      expect(restarted.status).toBe('running');
      expect(restarted.restored).toBe(false);
      expect(restarted.cwd).toBe('/work');
      // История вывода не потеряна.
      expect(service.output('term_r')?.chunks.map((chunk) => chunk.data).join('')).toContain(
        'вывод',
      );

      service.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Перезапуск терминала (PROP-132)
  // -------------------------------------------------------------------------

  describe('Перезапуск терминала', () => {
    it('живой терминал перезапустить нельзя — TERMINAL_ALREADY_RUNNING', async () => {
      const service = createService();
      const record = await service.create(createInput());

      const error = await service.restart(record.id).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TerminalAlreadyRunningError);
      expect((error as TerminalAlreadyRunningError).code).toBe('TERMINAL_ALREADY_RUNNING');

      service.dispose();
    });

    it('завершённый терминал: новый PTY с теми же параметрами, история вывода сохранена', async () => {
      const service = createService();
      const record = await service.create(createInput({ cols: 100, rows: 30, sessionId: 'sess-1' }));
      port.lastHandle.emitData('старый вывод\n');
      port.lastHandle.emitExit({ exitCode: 0, signal: 'SIGTERM' });

      const restarted = await service.restart(record.id);

      expect(restarted.id).toBe(record.id);
      expect(restarted.status).toBe('running');
      expect(restarted.restored).toBe(false);
      expect(restarted.cols).toBe(100);
      expect(restarted.rows).toBe(30);
      expect(restarted.cwd).toBe('/work');
      expect(restarted.shell).toBe('bash');
      // Новый PTY открыт с теми же параметрами.
      expect(port.requests).toHaveLength(2);
      expect(port.requests[1]).toMatchObject({ cwd: '/work', shell: 'bash', cols: 100, rows: 30 });
      // Буфер **не** очищен: старый вывод остаётся историей, код выхода
      // прежней оболочки снят.
      expect(service.output(record.id)?.chunks.map((chunk) => chunk.data).join('')).toContain(
        'старый вывод',
      );
      expect(restarted.exitCode).toBeUndefined();
      // Событие `terminal.updated` опубликовано.
      expect(events.some((event) => event.type === ('terminal.updated' as never))).toBe(true);

      service.dispose();
    });

    it('restart не теряет историю: вывод до перезапуска виден через output()', async () => {
      const service = createService();
      const record = await service.create(createInput());
      port.lastHandle.emitData('первая строка\n');
      port.lastHandle.emitExit({ exitCode: 0 });

      await service.restart(record.id);
      // Новый вывод дописывается в конец истории.
      port.lastHandle.emitData('вторая строка\n');

      const output = service.output(record.id)?.chunks.map((chunk) => chunk.data).join('') ?? '';
      expect(output).toContain('первая строка');
      expect(output).toContain('вторая строка');

      service.dispose();
    });

    it('ввод и размер в завершённый терминал — TERMINAL_EXITED (не «не найден»)', async () => {
      const service = createService();
      const record = await service.create(createInput());
      port.lastHandle.emitExit({ exitCode: 0 });

      const writeError = (() => {
        try {
          service.write(record.id, 'ls');
          return null;
        } catch (err) {
          return err;
        }
      })();
      const resizeError = (() => {
        try {
          service.resize(record.id, 100, 30);
          return null;
        } catch (err) {
          return err;
        }
      })();

      expect(writeError).toBeInstanceOf(TerminalExitedError);
      expect((writeError as TerminalExitedError).code).toBe('TERMINAL_EXITED');
      expect(resizeError).toBeInstanceOf(TerminalExitedError);
      // В PTY ничего не ушло.
      expect(port.lastHandle.writes).toHaveLength(0);

      service.dispose();
    });

    it('переименование: событие terminal.updated с новым заголовком и запись в реестре', async () => {
      const service = createService();
      const record = await service.create(createInput({ sessionId: 'sess-1' }));
      events.length = 0;

      const updated = service.update(record.id, { title: 'Логи' });

      expect(updated.title).toBe('Логи');
      expect(service.get(record.id)?.title).toBe('Логи');
      const event = events.find((item) => item.type === ('terminal.updated' as never));
      expect(event).toBeDefined();
      expect(event?.data['title']).toBe('Логи');

      service.dispose();
    });

    it('переименование завершённого терминала тоже работает', async () => {
      const service = createService();
      const record = await service.create(createInput());
      port.lastHandle.emitExit({ exitCode: 0 });

      const updated = service.update(record.id, { title: 'Архив' });

      expect(updated.title).toBe('Архив');
      expect(service.get(record.id)?.title).toBe('Архив');

      service.dispose();
    });

    it('несуществующий терминал — TERMINAL_NOT_FOUND', async () => {
      const service = createService();
      const error = await service.restart('term_missing').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(TerminalNotFoundError);
      service.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Выбор порта исполнения (PROP-135)
  // -------------------------------------------------------------------------

  describe('Выбор порта исполнения', () => {
    it('порт терминала выбирается резолвером (профиль/область)', async () => {
      const contexts: TerminalPortContext[] = [];
      const otherPort = new FakeExecutionPort();
      const service = createService({
        resolvePort: (ctx) => {
          contexts.push(ctx);
          return otherPort;
        },
      });

      const record = await service.create(createInput({ sessionId: 'sess-1' }));

      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        cwd: '/work',
        shell: 'bash',
      });
      // PTY открыт на **выбранном** порту, а не на инстансном.
      expect(otherPort.requests).toHaveLength(1);
      expect(port.requests).toHaveLength(0);
      expect(record.target).toBe('inline');

      service.dispose();
    });

    it('ошибка выбора порта — TERMINAL_UNAVAILABLE (fail-closed)', async () => {
      const service = createService({
        resolvePort: () => {
          throw new Error('пул недоступен');
        },
      });

      const error = await service.create(createInput()).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TerminalUnavailableError);
      expect((error as TerminalUnavailableError).reason).toBe('port_unavailable');
      expect(port.requests).toHaveLength(0);

      service.dispose();
    });
  });
});
