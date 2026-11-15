/**
 * PROP-132 (Ф5): тесты встроенных тулов интерактивных терминалов
 * (`engine/tools/terminals.ts`).
 *
 * Сервис терминалов — **подделка** (`FakeTerminalService`): проверяются тулы,
 * а не PTY/реестр (они — в `engine/terminal/service.test.ts`). Подделка
 * реализует ровно те методы `TerminalService`, которые зовут тулы:
 * `isEnabled`/`create`/`get`/`list`/`output`/`write`/`close`/`startRun`/
 * `waitRun`.
 *
 * Что проверяется:
 * - `terminal_list` — пустой список, строки `key=value`, скоуп по проекту
 *   (чужой терминал не виден), отсутствие сервиса/выключенный контур/
 *   сессия без проекта;
 * - `terminal_open` — дефолты 80×24, каталог = рабочий каталог сессии,
 *   привязка к сессии, маппинг типизированных ошибок сервиса;
 * - `terminal_read` — вывод **в обрамлении** `[CONTENT …]`…`[CONTENT END]`
 *   (метаданные чтения — атрибутами в открывающем маркере), `since`, `tail`,
 *   `history`, `strip_ansi`, кап 32 КиБ, обрезка хвостовых пустых строк,
 *   нормализация CRLF, единый отказ «не найден» (неизвестный и чужой терминал);
 * - `terminal_write` — ввод без Enter и с Enter (**CR**, `\r`), запрет
 *   команды политикой (тот же чекер, что у `execute_shell`), требование
 *   подтверждения (внешний/защищённый путь);
 * - `terminal_signal` — управляющие сигналы (`^C`/`^\`/`^Z`): байт в PTY +
 *   завершение активного запуска сервисом (`interruptRun`, код `128+signum`);
 * - `terminal_run` — запуск с ожиданием: обрамление вывода, код возврата,
 *   занятость терминала (`run_busy`), запрет команды политикой;
 * - `terminal_run` с `background: true` — запуск без ожидания: `run_id` +
 *   подсказка, доставка результата — нотификатором сервиса (`onRunFinished`),
 *   а не тулом; `timeout_ms` — необязательный watchdog;
 * - `terminal_close` — закрытие и единый отказ «не найден»;
 * - permission-слой: plan-блокировка мутирующих тулов, группа `terminal`,
 *   доступность при выключенном контуре и при отсутствии PTY.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';
import {
  terminalListTool,
  terminalOpenTool,
  terminalReadTool,
  terminalSnapshotTool,
  terminalWriteTool,
  terminalSignalTool,
  terminalCloseTool,
  terminalRunTool,
} from './terminals.js';
import type { TerminalOutputSnapshot, TerminalRecord } from '../terminal/types.js';
import {
  TerminalDisabledError,
  TerminalForegroundAppError,
  TerminalLimitError,
} from '../terminal/types.js';
import {
  formatTerminalContentAttributes,
  frameTerminalOutput,
  normalizeTerminalOutput,
  stripTerminalAnsi,
} from '../terminal/output.js';
import { TerminalRunBusyError, buildTerminalRunNotification, type TerminalRunRecord } from '../terminal/runs.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { getToolGroups, TERMINAL_TOOLS } from '../permission/groups.js';
import { computeToolAvailability } from '../permission/availability.js';
import { t as sm } from '../system-messages.js';
import { TOOL_RUNTIME_DEP } from './runtime-deps.js';
import { createToolRegistry } from './index.js';

/** Запись терминала — минимальный валидный набор полей. */
function makeRecord(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: 'term_1',
    projectId: 'proj_1',
    ownerId: 'local',
    cwd: '/tmp/work',
    shell: '/bin/bash',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: 1_000,
    lastActivityAt: 2_000,
    target: 'inline',
    ...overrides,
  };
}

/** Снимок вывода из двух фрагментов. */
function makeSnapshot(chunks: Array<{ seq: number; data: string }>): TerminalOutputSnapshot {
  return {
    chunks: chunks.map((chunk) => ({
      seq: chunk.seq,
      data: chunk.data,
      bytes: Buffer.byteLength(chunk.data, 'utf8'),
    })),
    totalBytes: chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data, 'utf8'), 0),
    droppedBytes: 0,
    firstSeq: chunks.length > 0 ? chunks[0]!.seq : 0,
    lastSeq: chunks.length > 0 ? chunks[chunks.length - 1]!.seq : 0,
  };
}

/** Подделка запуска: запись + резолвер ожидания. */
interface FakeRun {
  record: TerminalRunRecord;
  resolve: ((run: TerminalRunRecord) => void) | null;
}

/** Подделка терминального сервиса: только то, что зовут тулы. */
class FakeTerminalService {
  enabled = true;
  records = new Map<string, TerminalRecord>();
  outputs = new Map<string, TerminalOutputSnapshot>();
  writes: Array<{ id: string; data: string; actorId?: string }> = [];
  closed: Array<{ id: string; actorId?: string }> = [];
  created: TerminalRecord[] = [];
  /** Ошибка, которую сервис бросит на `create`/`write`/`close`. */
  failWith: unknown = null;
  /** Ошибка, которую сервис бросит на `startRun` (полноэкранное приложение). */
  startRunError: unknown = null;
  /** Запуски (`startRun`/`waitRun`). */
  runs = new Map<string, FakeRun>();
  /** Аргументы запусков (терминал/команда/срок/режимы) — проверка режимов. */
  started: Array<{
    terminalId: string;
    command: string;
    timeoutMs: number;
    background?: boolean;
    killOnTimeout?: boolean;
  }> = [];
  /** Завершённые запуски — как колбэк завершения (`onRunFinished`) у сервиса. */
  settled: TerminalRunRecord[] = [];
  /** Вызовы `interruptRun` (сигнал терминала). */
  interrupts: Array<{ terminalId: string; exitCode: number }> = [];
  /** Терминал занят активным запуском (`run_busy`). */
  busy = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  async create(input: {
    projectId: string;
    ownerId: string;
    cwd: string;
    cols: number;
    rows: number;
    sessionId?: string;
    title?: string;
  }): Promise<TerminalRecord> {
    if (this.failWith) throw this.failWith;
    const record = makeRecord({
      id: `term_${this.records.size + 1}`,
      projectId: input.projectId,
      ownerId: input.ownerId,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    this.records.set(record.id, record);
    this.created.push(record);
    return record;
  }

  get(id: string): TerminalRecord | null {
    return this.records.get(id) ?? null;
  }

  list(filter: { projectId?: string; sessionId?: string; includeExited?: boolean }): TerminalRecord[] {
    const result: TerminalRecord[] = [];
    for (const record of this.records.values()) {
      if (filter.projectId !== undefined && record.projectId !== filter.projectId) continue;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
      if (filter.includeExited !== true && record.status === 'exited') continue;
      result.push({ ...record });
    }
    return result;
  }

  output(id: string): TerminalOutputSnapshot | null {
    return this.outputs.get(id) ?? null;
  }

  write(id: string, data: string, options: { actorId?: string } = {}): void {
    if (this.failWith) throw this.failWith;
    this.writes.push({ id, data, ...(options.actorId !== undefined ? { actorId: options.actorId } : {}) });
  }

  async close(id: string, options: { actorId?: string } = {}): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.closed.push({ id, ...(options.actorId !== undefined ? { actorId: options.actorId } : {}) });
    const record = this.records.get(id);
    if (record) {
      this.records.set(id, { ...record, status: 'exited' });
    }
  }

  /** Запуск команды (регистрация; ожидание — за тестом). */
  startRun(input: {
    terminalId: string;
    command: string;
    timeoutMs: number;
    background?: boolean;
    killOnTimeout?: boolean;
  }): TerminalRunRecord {
    if (this.startRunError) throw this.startRunError;
    if (this.busy) throw new TerminalRunBusyError(input.terminalId, 'run_busy_existing');
    const runId = `run_${this.runs.size + 1}`;
    const record: TerminalRunRecord = {
      runId,
      terminalId: input.terminalId,
      nonce: `nonce-${runId}`,
      command: input.command,
      status: 'running',
      ...(input.background === true ? { background: true } : {}),
      stillRunning: true,
      output: '',
      startedAt: 1_000,
      timeoutMs: input.timeoutMs,
      truncated: false,
    };
    this.runs.set(runId, { record, resolve: null });
    this.started.push({
      terminalId: input.terminalId,
      command: input.command,
      timeoutMs: input.timeoutMs,
      ...(input.background !== undefined ? { background: input.background } : {}),
      ...(input.killOnTimeout !== undefined ? { killOnTimeout: input.killOnTimeout } : {}),
    });
    this.busy = true;
    return { ...record };
  }

  /** Ожидание завершения запуска (завершение инициирует тест). */
  waitRun(runId: string, _timeoutMs: number): Promise<TerminalRunRecord | null> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve(null);
    return new Promise<TerminalRunRecord | null>((resolve) => {
      run.resolve = resolve;
    });
  }

  /** Завершить запуск (управление из теста). */
  finishRun(runId: string, patch: Partial<TerminalRunRecord>): TerminalRunRecord | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    Object.assign(run.record, patch);
    // Как в реестре запусков: `stillRunning` вычисляется из статуса (`timeout`
    // без убийства терминал не освобождает); явное значение в патче важнее.
    if (patch.stillRunning === undefined && patch.status !== undefined) {
      run.record.stillRunning = patch.status === 'timeout';
    }
    this.busy = run.record.stillRunning === true;
    // Сервис терминалов после завершения зовёт колбэк (`onSettled` →
    // `onRunFinished`) — уведомление о завершении уходит из сервиса.
    this.settled.push({ ...run.record });
    run.resolve?.({ ...run.record });
    return { ...run.record };
  }

  /** Прервать активный запуск — как `TerminalService.interruptRun`. */
  interruptRun(terminalId: string, exitCode = 130): boolean {
    this.interrupts.push({ terminalId, exitCode });
    if (!this.busy) return false;
    this.busy = false;
    return true;
  }
}

describe('Тулы интерактивных терминалов (terminals.ts)', () => {
  let tmpDir: string;
  let service: FakeTerminalService;

  function makeCtx(extra: Record<string, unknown> = {}, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 'ses_1',
      messageId: 'msg_1',
      projectId: 'proj_1',
      workingDir: tmpDir,
      extra: {
        terminalService: service,
        ...extra,
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-terminal-tools-'));
    service = new FakeTerminalService();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('terminal_list', () => {
    it('без сервиса терминалов → deps_unavailable', async () => {
      const result = await terminalListTool.execute({}, makeCtx({ terminalService: undefined }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('terminal service is not available');
    });

    it('выключенный контур → terminal.tool.disabled', async () => {
      service.enabled = false;
      const result = await terminalListTool.execute({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('terminals are disabled');
    });

    it('сессия без проекта → project_required', async () => {
      const result = await terminalListTool.execute({}, makeCtx({}, { projectId: undefined }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('no project');
    });

    it('пустой реестр → terminal.tool.empty', async () => {
      const result = await terminalListTool.execute({}, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('No terminals');
      expect(result.metadata?.count).toBe(0);
    });

    it('терминалы проекта видны, чужой проект — нет', async () => {
      service.records.set('term_1', makeRecord({ id: 'term_1', projectId: 'proj_1', sessionId: 'ses_1' }));
      service.records.set('term_2', makeRecord({ id: 'term_2', projectId: 'proj_other' }));

      const result = await terminalListTool.execute({}, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('term_1');
      expect(result.content).toContain('cwd=');
      expect(result.content).toContain('shell=/bin/bash');
      expect(result.content).toContain('status=running');
      expect(result.content).toContain('can_write=true');
      expect(result.content).toContain('session=ses_1');
      expect(result.content).not.toContain('term_2');
      expect(result.metadata?.count).toBe(1);
    });

    it('помечает принадлежность текущей сессии (own)', async () => {
      service.records.set('term_own', makeRecord({ id: 'term_own', projectId: 'proj_1', sessionId: 'ses_1' }));
      service.records.set('term_other', makeRecord({ id: 'term_other', projectId: 'proj_1', sessionId: 'ses_2' }));
      service.records.set('term_none', makeRecord({ id: 'term_none', projectId: 'proj_1' }));

      const result = await terminalListTool.execute({}, makeCtx());
      expect(result.isError).toBeUndefined();
      // Свой терминал — own=true, чужие (в т.ч. без сессии) — own=false.
      expect(result.content).toContain('term_own | ');
      expect(result.content).toMatch(/term_own[^\n]*own=true/);
      expect(result.content).toMatch(/term_other[^\n]*own=false/);
      expect(result.content).toMatch(/term_none[^\n]*own=false/);

      const terminals = result.metadata?.terminals as Array<{ id: string; own: boolean }>;
      expect(terminals.find((t) => t.id === 'term_own')?.own).toBe(true);
      expect(terminals.find((t) => t.id === 'term_other')?.own).toBe(false);
      expect(terminals.find((t) => t.id === 'term_none')?.own).toBe(false);
    });

    it('фильтр по сессии и include_exited', async () => {
      service.records.set('term_1', makeRecord({ id: 'term_1', sessionId: 'ses_1' }));
      service.records.set('term_2', makeRecord({ id: 'term_2', sessionId: 'ses_2' }));
      service.records.set('term_3', makeRecord({ id: 'term_3', sessionId: 'ses_1', status: 'exited' }));

      const onlySession = await terminalListTool.execute({ session_id: 'ses_1' }, makeCtx());
      expect(onlySession.metadata?.count).toBe(1);

      const withExited = await terminalListTool.execute({ include_exited: true }, makeCtx());
      expect(withExited.metadata?.count).toBe(3);
    });
  });

  describe('terminal_open', () => {
    it('открывает терминал в рабочем каталоге сессии (дефолты 80×24)', async () => {
      const result = await terminalOpenTool.execute({}, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(service.created).toHaveLength(1);
      expect(service.created[0]?.cwd).toBe(tmpDir);
      expect(service.created[0]?.cols).toBe(80);
      expect(service.created[0]?.rows).toBe(24);
      expect(service.created[0]?.projectId).toBe('proj_1');
      expect(service.created[0]?.sessionId).toBe('ses_1');
      expect(result.metadata?.terminal_id).toBe('term_1');
    });

    it('размер терминала задаётся параметрами', async () => {
      await terminalOpenTool.execute({ cols: 120, rows: 40 }, makeCtx());
      expect(service.created[0]?.cols).toBe(120);
      expect(service.created[0]?.rows).toBe(40);
    });

    it('ошибка лимита сервиса → terminal.tool.limit', async () => {
      service.failWith = new TerminalLimitError({ scope: 'project', limit: 8, message: 'limit' });
      const result = await terminalOpenTool.execute({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('8');
      expect(result.metadata?.scope).toBe('project');
    });

    it('выключенный сервис (TerminalDisabledError) → terminal.tool.disabled', async () => {
      service.failWith = new TerminalDisabledError();
      const result = await terminalOpenTool.execute({}, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('terminals are disabled');
    });

    it('невалидные аргументы → отказ tool.args_error', async () => {
      const result = await terminalOpenTool.execute({ cols: 0 }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('argument error');
    });
  });

  describe('terminal_read', () => {
    beforeEach(() => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
    });

    it('без вывода → terminal.tool.no_output', async () => {
      const result = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toBe('The terminal has not produced any output yet');
      expect(result.metadata?.bytes).toBe(0);
    });

    it('читает вывод терминала в обрамлении [CONTENT …]…[CONTENT END] (метаданные — в маркере)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'hello\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=5]\nhello\n[CONTENT END]');
      expect(result.metadata?.bytes).toBe(5);
    });

    it('обрезает хвостовые пустые строки вывода', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\n\n\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3]\na\nb\n[CONTENT END]');
    });

    it('нормализует CRLF в LF (только возвращаемый текст)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\r\nb\r\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3]\na\nb\n[CONTENT END]');
      // Буфер терминала не меняется — CRLF остаётся в нём.
      expect(service.outputs.get('term_1')?.chunks[0]?.data).toBe('a\r\nb\r\n');
    });

    it('since отбрасывает старые фрагменты', async () => {
      service.outputs.set('term_1', makeSnapshot([
        { seq: 1, data: 'old\n' },
        { seq: 2, data: 'new\n' },
      ]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', since: 1 }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=2..2 bytes=3]\nnew\n[CONTENT END]');
    });

    it('tail оставляет последние N строк (завершающий пустой элемент отброшен)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\nc\nd\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 2 }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3 tail=2]\nc\nd\n[CONTENT END]');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('tail без завершающего перевода строки', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\nc' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 2 }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3 tail=2]\nb\nc\n[CONTENT END]');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('tail с переводами строк CRLF нормализуется', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\r\nb\r\nc\r\nd\r\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 2 }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3 tail=2]\nc\nd\n[CONTENT END]');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('tail больше, чем строк, — весь текст как есть', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 5 }, makeCtx());
      expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3 tail=5]\na\nb\n[CONTENT END]');
      expect(result.metadata?.truncated).toBe(false);
    });

    it('ANSI по умолчанию сохраняется, strip_ansi вырезает', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: '\u001B[31mred\u001B[0m\n' }]));

      const raw = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(raw.content).toContain('\u001B[31m');

      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3 stripped=true]\nred\n[CONTENT END]');
    });

    it('strip_ansi вырезает OSC-строки целиком (маркер запуска, 3008)', async () => {
      service.outputs.set(
        'term_1',
        makeSnapshot([
          {
            seq: 1,
            data: 'before\u001B]7770;synth-run;abc123;0\u0007after\u001B]3008;report=1\u0007end\n',
          },
        ]),
      );
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=14 stripped=true]\nbeforeafterend\n[CONTENT END]');
    });

    it('strip_ansi вырезает OSC, завершённую ST (ESC \\)', async () => {
      service.outputs.set(
        'term_1',
        makeSnapshot([{ seq: 1, data: 'a\u001B]0;window title\u001B\\b\n' }]),
      );
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=2 stripped=true]\nab\n[CONTENT END]');
    });

    it('strip_ansi применяет backspace (X\\b — удалить символ)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'abc\b\bZ\n' }]));
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=2 stripped=true]\naZ\n[CONTENT END]');
    });

    it('strip_ansi: backspace в начале строки ничего не удаляет', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: '\b\btext\n' }]));
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=4 stripped=true]\ntext\n[CONTENT END]');
    });

    it('strip_ansi вырезает одиночный \\r (\\r\\n остаётся переводом строки)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'progress 10%\rprogress 20%\r\ndone\n' }]));
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=29 stripped=true]\nprogress 10%progress 20%\ndone\n[CONTENT END]');
    });

    it('strip_ansi схлопывает «широкие» вставки пробелов (>40 подряд → один)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: `a${' '.repeat(60)}b\n` }]));
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('[CONTENT terminal=term_1 status=running seq=1..1 bytes=3 stripped=true]\na b\n[CONTENT END]');
    });

    it('strip_ansi сохраняет обычные отступы (≤40 подряд)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: `a${' '.repeat(40)}b\n` }]));
      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe(`[CONTENT terminal=term_1 status=running seq=1..1 bytes=42 stripped=true]\na${' '.repeat(40)}b\n[CONTENT END]`);
    });

    it('кап вывода — 32 КиБ (хвост обрезается, truncated)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'x'.repeat(40_000) }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.metadata?.bytes).toBe(32 * 1024);
      expect(result.metadata?.truncated).toBe(true);
    });

    it('неизвестный и чужой терминал — один отказ «не найден» (существование не раскрывается)', async () => {
      // Свой терминал проекта сессии + чужой (другого проекта).
      service.records.set('term_mine', makeRecord({ id: 'term_mine', projectId: 'proj_1' }));
      service.records.set('term_other', makeRecord({ id: 'term_other', projectId: 'proj_other' }));

      const unknown = await terminalReadTool.execute({ terminal_id: 'term_missing' }, makeCtx());
      expect(unknown.isError).toBe(true);
      expect(unknown.metadata?.i18n).toMatchObject({ key: 'terminal.tool.not_found' });

      const foreign = await terminalReadTool.execute({ terminal_id: 'term_other' }, makeCtx());
      expect(foreign.isError).toBe(true);
      // Тот же стабильный признак отказа — как у неизвестного терминала.
      expect(foreign.metadata?.i18n).toMatchObject({ key: 'terminal.tool.not_found' });
      // Ни один существующий терминал не упоминается в ответе: ни свой
      // (нет перечисления), ни чужой (нет намёка на его существование).
      expect(unknown.content).not.toContain('term_mine');
      expect(unknown.content).not.toContain('term_other');
      expect(foreign.content).not.toContain('term_mine');
    });

    describe('history', () => {
      it('пустая история → terminal.tool.history_empty', async () => {
        const result = await terminalReadTool.execute(
          { terminal_id: 'term_1', history: true },
          makeCtx(),
        );
        expect(result.content).toBe('The terminal output history is empty');
        expect(result.metadata?.history).toBe(true);
        expect(result.metadata?.bytes).toBe(0);
      });

      it('отдаёт весь доступный буфер в обрамлении', async () => {
        service.outputs.set('term_1', makeSnapshot([
          { seq: 1, data: 'first\n' },
          { seq: 2, data: 'second\n' },
        ]));
        const result = await terminalReadTool.execute(
          { terminal_id: 'term_1', history: true },
          makeCtx(),
        );
        expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..2 bytes=12 history=true total_bytes=13 dropped_bytes=0]\nfirst\nsecond\n[CONTENT END]');
        expect(result.metadata?.history).toBe(true);
        expect(result.metadata?.dropped_bytes).toBe(0);
      });

      it('history игнорирует since и tail (запрос всей истории)', async () => {
        service.outputs.set('term_1', makeSnapshot([
          { seq: 1, data: 'first\n' },
          { seq: 2, data: 'second\n' },
        ]));
        const result = await terminalReadTool.execute(
          { terminal_id: 'term_1', history: true, since: 1, tail: 1 },
          makeCtx(),
        );
        expect(result.content).toBe('[CONTENT terminal=term_1 status=running seq=1..2 bytes=12 history=true total_bytes=13 dropped_bytes=0]\nfirst\nsecond\n[CONTENT END]');
      });

      it('сообщает о потерянных байтах буфера (dropped_bytes)', async () => {
        const snapshot = makeSnapshot([{ seq: 1, data: 'first\n' }]);
        snapshot.droppedBytes = 512;
        service.outputs.set('term_1', snapshot);
        const result = await terminalReadTool.execute(
          { terminal_id: 'term_1', history: true },
          makeCtx(),
        );
        expect(result.metadata?.dropped_bytes).toBe(512);
      });
    });
  });

  describe('terminal_snapshot', () => {
    beforeEach(() => {
      service.records.set('term_1', makeRecord({ id: 'term_1', cols: 20, rows: 5 }));
    });

    it('отдаёт видимый экран: последняя строка видна, старые за пределами rows не попадают', async () => {
      const output = `${Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\r\n')}\r\n`;
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: output }]));

      const result = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      // Экран — последние 5 строк терминала, а не весь поток.
      expect(result.content).toBe(
        '[CONTENT terminal=term_1 status=running size=20x5 cursor=4,0]\nline7\nline8\nline9\nline10\n[CONTENT END]',
      );
      expect(result.content.split('\n')).not.toContain('line1');
      expect(result.metadata?.lines).toBe(4);
      expect(result.metadata?.has_content).toBe(true);
      expect(result.metadata?.cols).toBe(20);
      expect(result.metadata?.rows).toBe(5);
    });

    it('размеры по умолчанию берутся из записи терминала', async () => {
      service.records.set('term_1', makeRecord({ id: 'term_1', cols: 30, rows: 8 }));
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'hello\r\n' }]));

      const result = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toContain('size=30x8');
      expect(result.metadata?.cols).toBe(30);
      expect(result.metadata?.rows).toBe(8);
    });

    it('cols/rows перекрывают окно рендера', async () => {
      // Строка в 30 колонок при окне 40 не переносится.
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: `${'x'.repeat(30)}\r\n` }]));

      const narrow = await terminalSnapshotTool.execute(
        { terminal_id: 'term_1', cols: 20, rows: 5 },
        makeCtx(),
      );
      expect(narrow.content).toContain('size=20x5');
      // При 20 колонках 30 символов переносятся на вторую строку.
      expect(narrow.metadata?.lines).toBe(2);

      const wide = await terminalSnapshotTool.execute(
        { terminal_id: 'term_1', cols: 40, rows: 5 },
        makeCtx(),
      );
      expect(wide.content).toContain('size=40x5');
      expect(wide.metadata?.lines).toBe(1);
    });

    it('TUI-перерисовка: виден последний кадр (экран ≠ поток)', async () => {
      service.outputs.set('term_1', makeSnapshot([
        { seq: 1, data: '\u001B[2J\u001B[HCPU: 10%' },
        { seq: 2, data: '\u001B[HCPU: 90%' },
      ]));

      const result = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toContain('CPU: 90%');
      expect(result.content).not.toContain('CPU: 10%');
    });

    it('exited: экран последнего вывода', async () => {
      service.records.set('term_1', makeRecord({ id: 'term_1', cols: 20, rows: 5, status: 'exited' }));
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'bye\r\n' }]));

      const result = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toBe(
        '[CONTENT terminal=term_1 status=exited size=20x5 cursor=1,0]\nbye\n[CONTENT END]',
      );
      expect(result.metadata?.status).toBe('exited');
    });

    it('пустой экран → текст terminal.tool.snapshot_empty (без обрамления)', async () => {
      const noOutput = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(noOutput.content).toBe(
        'The terminal screen is empty — no visible content (the program has not drawn anything yet)',
      );
      expect(noOutput.metadata?.has_content).toBe(false);
      expect(noOutput.metadata?.empty).toBe(true);

      // Очистка экрана тоже даёт пустой экран.
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'old\u001B[2J\u001B[H' }]));
      const cleared = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(cleared.metadata?.has_content).toBe(false);
    });

    it('атрибуты маркера: терминал, статус, размер, курсор', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'abc' }]));

      const result = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content.split('\n')[0]).toBe(
        '[CONTENT terminal=term_1 status=running size=20x5 cursor=0,3]',
      );
      expect(result.content.endsWith('[CONTENT END]')).toBe(true);
      expect(result.metadata?.cursor).toEqual({ x: 3, y: 0 });
    });

    it('чужой и неизвестный терминал → единый отказ not_found', async () => {
      service.records.set('foreign', makeRecord({ id: 'foreign', projectId: 'proj_other' }));

      const unknown = await terminalSnapshotTool.execute({ terminal_id: 'nope' }, makeCtx());
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toContain('not found');

      const foreign = await terminalSnapshotTool.execute({ terminal_id: 'foreign' }, makeCtx());
      expect(foreign.isError).toBe(true);
      expect(foreign.content).toContain('not found');
    });

    it('без сервиса и при выключенном контуре → отказ', async () => {
      const noService = await terminalSnapshotTool.execute(
        { terminal_id: 'term_1' },
        makeCtx({ terminalService: undefined }),
      );
      expect(noService.isError).toBe(true);

      service.enabled = false;
      const disabled = await terminalSnapshotTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(disabled.isError).toBe(true);
      expect(disabled.content).toContain('disabled');
    });

    it('невалидные размеры окна → отказ валидации', async () => {
      const tiny = await terminalSnapshotTool.execute(
        { terminal_id: 'term_1', cols: 5 },
        makeCtx(),
      );
      expect(tiny.isError).toBe(true);

      const huge = await terminalSnapshotTool.execute(
        { terminal_id: 'term_1', rows: 500 },
        makeCtx(),
      );
      expect(huge.isError).toBe(true);
    });
  });

  describe('terminal_write', () => {
    beforeEach(() => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
    });

    it('ввод без Enter уходит как есть', async () => {
      const result = await terminalWriteTool.execute({ terminal_id: 'term_1', data: 'ls' }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(service.writes).toHaveLength(1);
      expect(service.writes[0]?.data).toBe('ls');
      expect(result.metadata?.enter).toBe(false);
    });

    it('enter добавляет CR (\\r) — Enter в терминале', async () => {
      await terminalWriteTool.execute({ terminal_id: 'term_1', data: 'ls -la', enter: true }, makeCtx());
      // Терминал ждёт CR, а не LF (raw-режим, tmux-промпт, less, REPL).
      expect(service.writes[0]?.data).toBe('ls -la\r');
    });

    it('команда, запрещённая политикой, не отправляется', async () => {
      const policy = {
        deniedPaths: ['/etc/secret'],
        deniedPrefixes: [],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      };
      const result = await terminalWriteTool.execute(
        { terminal_id: 'term_1', data: 'cat /etc/secret', enter: true },
        makeCtx({ shellPolicy: policy }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('forbidden by the shell policy');
      expect(service.writes).toHaveLength(0);
    });

    it('команда, требующая подтверждения, не отправляется', async () => {
      const policy = {
        deniedPaths: [],
        deniedPrefixes: [],
        approvalPaths: ['/etc/shadow'],
        deniedCommandPrefixes: [],
      };
      const result = await terminalWriteTool.execute(
        { terminal_id: 'term_1', data: 'cat /etc/shadow', enter: true },
        makeCtx({ shellPolicy: policy }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('requires user approval');
      expect(result.metadata?.reason).toBe('command_requires_approval');
      expect(service.writes).toHaveLength(0);
    });

    it('разрешённая команда уходит в терминал', async () => {
      const policy = {
        deniedPaths: [],
        deniedPrefixes: [],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      };
      const result = await terminalWriteTool.execute(
        { terminal_id: 'term_1', data: 'echo hi', enter: true },
        makeCtx({ shellPolicy: policy }),
      );
      expect(result.isError).toBeUndefined();
      expect(service.writes[0]?.data).toBe('echo hi\r');
    });

    it('неизвестный терминал → «не найден»', async () => {
      const result = await terminalWriteTool.execute({ terminal_id: 'term_missing', data: 'ls' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('пустой data с enter=true — отправляется чистый Enter (без проверки shell-guard)', async () => {
      const policy = {
        deniedPaths: ['/etc/secret'],
        deniedPrefixes: [],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      };
      const result = await terminalWriteTool.execute(
        { terminal_id: 'term_1', data: '', enter: true },
        makeCtx({ shellPolicy: policy }),
      );
      expect(result.isError).toBeUndefined();
      expect(service.writes).toHaveLength(1);
      expect(service.writes[0]?.data).toBe('\r');
      expect(result.metadata?.enter).toBe(true);
    });

    it('пустой data без enter — отказ валидации (отправлять нечего)', async () => {
      const result = await terminalWriteTool.execute({ terminal_id: 'term_1', data: '' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('argument error');
      expect(result.content).toContain('enter=true');
      expect(service.writes).toHaveLength(0);
    });
  });

  describe('terminal_run', () => {
    beforeEach(() => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
    });

    it('запускает команду и ждёт завершения: вывод в обрамлении + код возврата', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls -la' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'done', exitCode: 0, output: 'file1\nfile2\n' });

      const result = await promise;
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('[CONTENT terminal=term_1 run=run_1 status=done exit=0]');
      expect(result.content).toContain('file1');
      expect(result.content).toContain('[CONTENT END]');
      expect(result.content).toContain('Exit code: 0');
      expect(result.metadata?.status).toBe('done');
      expect(result.metadata?.exit_code).toBe(0);
      expect(result.metadata?.run_id).toBe(runId);
    });

    it('ненулевой код возврата попадает в результат', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'false' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'done', exitCode: 2, output: 'boom\n' });

      const result = await promise;
      expect(result.content).toContain('Exit code: 2');
      expect(result.metadata?.exit_code).toBe(2);
    });

    it('маркер запуска (done): terminal/run/status/exit + вывод между маркерами', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls -la' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'done', exitCode: 0, output: 'file1\nfile2\n' });

      const result = await promise;
      expect(result.content).toContain(
        '[CONTENT terminal=term_1 run=run_1 status=done exit=0]\nfile1\nfile2\n[CONTENT END]',
      );
    });

    it('маркер запуска (timeout): timeout_ms и still_running, без exit', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'sleep 100', timeout_ms: 1_000 },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'timeout', output: 'partial\n' });

      const result = await promise;
      expect(result.content).toContain(
        '[CONTENT terminal=term_1 run=run_1 status=timeout timeout_ms=1000 still_running=true]\npartial\n[CONTENT END]',
      );
      // Кода возврата нет — атрибута `exit` тоже нет.
      expect(result.content).not.toContain('exit=');
    });

    it('маркер запуска (exited): без exit и без still_running', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'exited', output: 'partial\n' });

      const result = await promise;
      expect(result.content).toContain(
        '[CONTENT terminal=term_1 run=run_1 status=exited]\npartial\n[CONTENT END]',
      );
    });

    it('таймаут запуска — понятный статус и частичный вывод', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'sleep 100', timeout_ms: 1_000 },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'timeout', output: 'partial\n' });

      const result = await promise;
      expect(result.metadata?.status).toBe('timeout');
      expect(result.content).toContain('timeout');
      expect(result.content).toContain('[CONTENT terminal=term_1 run=run_1 status=timeout timeout_ms=1000 still_running=true]');
      expect(result.content).toContain('partial');
    });

    it('таймаут не убивает команду: в ответе still_running, run_id и подсказка', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'sleep 100', timeout_ms: 1_000 },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'timeout', output: 'partial\n' });

      const result = await promise;
      expect(result.metadata?.status).toBe('timeout');
      expect(result.metadata?.still_running).toBe(true);
      expect(result.metadata?.run_id).toBe(runId);
      // Подсказка: команда продолжает выполняться, терминал занят (run_busy),
      // остановить — Ctrl+C через terminal_write.
      expect(result.content).toContain('still running');
      expect(result.content).toContain(runId);
      expect(result.content).toContain('run_busy');
      expect(result.content).toContain('Ctrl+C');
      expect(result.content).toContain('terminal_write');

      // Терминал после таймаута занят: следующий запуск — run_busy.
      const next = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      expect(next.isError).toBe(true);
      expect(next.metadata?.reason).toBe('run_busy');
    });

    it('timeout + stillRunning: признак «продолжает выполняться» — из записи запуска', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'sleep 100', timeout_ms: 1_000 },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'timeout', stillRunning: true, output: 'partial\n' });

      const result = await promise;
      expect(result.metadata?.still_running).toBe(true);
      expect(result.content).toContain('still running');
      expect(result.content).toContain('[CONTENT terminal=term_1 run=run_1 status=timeout timeout_ms=1000 still_running=true]');
    });

    it('kill_on_timeout: по таймауту Ctrl+C, терминал свободен (без «продолжает выполняться»)', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'sleep 100', timeout_ms: 1_000, kill_on_timeout: true },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      // Режим убийства команды передан сервису.
      expect(service.started[0]?.killOnTimeout).toBe(true);
      const runId = [...service.runs.keys()][0]!;
      // Реестр уже освободил терминал: `timeout`, но `stillRunning: false`.
      service.finishRun(runId, { status: 'timeout', stillRunning: false, output: 'partial\n' });

      const result = await promise;
      expect(result.metadata?.status).toBe('timeout');
      expect(result.metadata?.still_running).toBeUndefined();
      expect(result.content).not.toContain('still running');
      expect(result.content).not.toContain('run_busy');
      // Отказ по сроку с частичным выводом.
      expect(result.content).toContain('did not finish');
      expect(result.content).toContain('partial');
      expect(result.content).toContain('[CONTENT terminal=term_1 run=run_1 status=timeout timeout_ms=1000]');
    });

    it('вышедший терминал — своя строка статуса (без «Exit code: -»)', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'exited', output: 'partial\n' });

      const result = await promise;
      expect(result.metadata?.status).toBe('exited');
      expect(result.content).toContain('exited');
      expect(result.content).not.toContain('Exit code: -');
      // Вышедший терминал — команда не «ещё работает».
      expect(result.metadata?.still_running).toBeUndefined();
    });

    it('дефолтный срок ожидания — 30 с', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      expect(service.started[0]?.timeoutMs).toBe(30_000);
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'done', exitCode: 0, output: '' });
      await promise;
    });

    it('невалидные параметры → отказ tool.args_error', async () => {
      const notBool = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls', background: 'yes' },
        makeCtx(),
      );
      expect(notBool.isError).toBe(true);
      expect(notBool.content).toContain('argument error');

      const zeroTimeout = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls', timeout_ms: 0 },
        makeCtx(),
      );
      expect(zeroTimeout.isError).toBe(true);
      expect(zeroTimeout.content).toContain('argument error');

      const tooBigTimeout = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls', timeout_ms: 600_001 },
        makeCtx(),
      );
      expect(tooBigTimeout.isError).toBe(true);
      expect(tooBigTimeout.content).toContain('argument error');

      const unknownParam = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls', wait: true },
        makeCtx(),
      );
      expect(unknownParam.isError).toBe(true);
      expect(unknownParam.content).toContain('argument error');

      expect(service.runs.size).toBe(0);
    });

    it('занятый терминал → terminal.tool.run_busy', async () => {
      service.busy = true;
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.reason).toBe('run_busy');
      expect(result.metadata?.i18n).toMatchObject({ key: 'terminal.tool.run_busy' });
      expect(service.runs.size).toBe(0);
    });

    it('команда, запрещённая политикой, не запускается', async () => {
      const policy = {
        deniedPaths: ['/etc/secret'],
        deniedPrefixes: [],
        approvalPaths: [],
        deniedCommandPrefixes: [],
      };
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'cat /etc/secret' },
        makeCtx({ shellPolicy: policy }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('forbidden by the shell policy');
      expect(service.runs.size).toBe(0);
    });

    it('неизвестный терминал → «не найден»', async () => {
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_missing', command: 'ls' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('полноэкранное приложение → TERMINAL_FOREGROUND_APP (текст ключа + код)', async () => {
      service.startRunError = new TerminalForegroundAppError('term_1', sm('terminal.tool.foreground_app'));
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      // Текст — ровно из ключа `terminal.tool.foreground_app`, не общий
      // `tool.exec_error` («terminal: …»).
      expect(result.content).toBe(sm('terminal.tool.foreground_app'));
      expect(result.content).toContain('full-screen application');
      expect(result.content).toContain('terminal_write');
      expect(result.content).toContain('terminal_snapshot');
      expect(result.content).not.toContain('terminal:');
      expect(result.metadata?.code).toBe('TERMINAL_FOREGROUND_APP');
      expect(result.metadata?.terminal_id).toBe('term_1');
      expect(result.metadata?.i18n).toMatchObject({ key: 'terminal.tool.foreground_app' });
      // Запуск не состоялся: до PTY ничего не ушло.
      expect(service.runs.size).toBe(0);
      expect(service.started).toHaveLength(0);
    });

    it('полноэкранное приложение в фоне → тот же отказ (режим не обходит проверку)', async () => {
      service.startRunError = new TerminalForegroundAppError('term_1', sm('terminal.tool.foreground_app'));
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls', background: true },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.code).toBe('TERMINAL_FOREGROUND_APP');
      expect(result.metadata?.run_id).toBeUndefined();
    });

    it('обычный запуск не затронут: нет metadata.code, ошибки нет', async () => {
      const promise = terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls' },
        makeCtx(),
      );
      await vi.waitFor(() => expect(service.runs.size).toBe(1));
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'done', exitCode: 0, output: 'ok\n' });

      const result = await promise;
      expect(result.isError).toBeUndefined();
      expect(result.metadata?.code).toBeUndefined();
      expect(result.metadata?.status).toBe('done');
      expect(result.content).toContain('Exit code: 0');
    });
  });

  describe('terminal_run (background: true)', () => {
    beforeEach(() => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
    });

    it('запускает без ожидания: возвращает run_id и подсказку', async () => {
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'npm test', background: true },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      expect(result.metadata?.run_id).toBe('run_1');
      expect(result.metadata?.status).toBe('running');
      expect(result.metadata?.command).toBe('npm test');
      expect(result.metadata?.background).toBe(true);
      expect(result.content).toContain('run_1');
      expect(result.content).toContain('chat');
      // Тул не ждёт завершения и не отдаёт вывод запуска.
      expect(result.content).not.toContain('[CONTENT]');
      expect(result.metadata?.exit_code).toBeUndefined();
    });

    it('результат приходит нотификатором сервиса, а не тулом', async () => {
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'npm test', background: true },
        makeCtx(),
      );
      expect(result.metadata?.run_id).toBe('run_1');

      // Завершение запуска — на стороне сервиса терминалов (`onRunFinished`).
      const runId = [...service.runs.keys()][0]!;
      service.finishRun(runId, { status: 'done', exitCode: 0, output: 'ok\n' });
      expect(service.settled).toHaveLength(1);

      // Уведомление собирает терминальный слой (не тул): сообщение роли USER
      // с `metadata.type='background_run_result'` и выводом в обрамлении.
      const notification = buildTerminalRunNotification(service.settled[0]!);
      expect(notification.metadata?.type).toBe('background_run_result');
      expect(notification.metadata?.run_id).toBe(runId);
      expect(notification.content).toContain('[CONTENT terminal=term_1 run=run_1 status=done exit=0]');
      expect(notification.content).toContain('ok');
      // В ответе тула вывода запуска нет — он придёт отдельным сообщением.
      expect(result.content).not.toContain('ok');
    });

    it('background пробрасывается в сервис запусков', async () => {
      await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'npm test', background: true },
        makeCtx(),
      );
      expect(service.started[0]?.background).toBe(true);
      // По умолчанию команда по таймауту не убивается.
      expect(service.started[0]?.killOnTimeout).toBe(false);
    });

    it('timeout_ms — необязательный watchdog: без него лимита нет', async () => {
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'npm test', background: true },
        makeCtx(),
      );
      // Срок не задан — в метаданных его нет, сервису уходит срок `0`:
      // реестр запусков при таком сроке watchdog-таймер **не ставит**.
      expect(result.metadata?.timeout_ms).toBeUndefined();
      expect(service.started[0]?.timeoutMs).toBe(0);
    });

    it('заданный timeout_ms — watchdog фонового запуска', async () => {
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'npm test', background: true, timeout_ms: 60_000 },
        makeCtx(),
      );
      expect(result.metadata?.timeout_ms).toBe(60_000);
      expect(service.started[0]?.timeoutMs).toBe(60_000);
    });

    it('занятый терминал → terminal.tool.run_busy', async () => {
      service.busy = true;
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'ls', background: true },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.reason).toBe('run_busy');
    });

    it('команда, запрещённая политикой, не запускается', async () => {
      const policy = {
        deniedPaths: [],
        deniedPrefixes: [],
        approvalPaths: ['/etc/shadow'],
        deniedCommandPrefixes: [],
      };
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_1', command: 'cat /etc/shadow', background: true },
        makeCtx({ shellPolicy: policy }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('requires user approval');
      expect(service.runs.size).toBe(0);
    });

    it('неизвестный терминал → «не найден»', async () => {
      const result = await terminalRunTool.execute(
        { terminal_id: 'term_missing', command: 'ls', background: true },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });
  });

  describe('terminal_close', () => {
    it('закрывает терминал', async () => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
      const result = await terminalCloseTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.isError).toBeUndefined();
      expect(service.closed).toHaveLength(1);
      expect(service.closed[0]?.id).toBe('term_1');
    });

    it('неизвестный терминал → «не найден»', async () => {
      const result = await terminalCloseTool.execute({ terminal_id: 'term_missing' }, makeCtx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
      expect(service.closed).toHaveLength(0);
    });
  });

  describe('terminal_signal', () => {
    beforeEach(() => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
    });

    it('INT → ETX (^C), активный запуск завершается кодом 130', async () => {
      service.busy = true;
      const result = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'INT' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      expect(service.writes).toHaveLength(1);
      expect(service.writes[0]?.data).toBe('\u0003');
      expect(service.interrupts).toEqual([{ terminalId: 'term_1', exitCode: 130 }]);
      expect(result.metadata?.signal).toBe('INT');
      expect(result.metadata?.interrupt).toBe(130);
      expect(result.content).toContain('INT');
      expect(result.content).toContain('term_1');
    });

    it('QUIT → FS (^\\), код 131', async () => {
      service.busy = true;
      const result = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'QUIT' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      expect(service.writes[0]?.data).toBe('\u001c');
      expect(service.interrupts).toEqual([{ terminalId: 'term_1', exitCode: 131 }]);
      expect(result.metadata?.interrupt).toBe(131);
    });

    it('TSTP → SUB (^Z), код 147', async () => {
      service.busy = true;
      const result = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'TSTP' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      expect(service.writes[0]?.data).toBe('\u001a');
      expect(service.interrupts).toEqual([{ terminalId: 'term_1', exitCode: 147 }]);
      expect(result.metadata?.interrupt).toBe(147);
    });

    it('нет активного запуска → interrupt: null (прерывать нечего)', async () => {
      const result = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'INT' },
        makeCtx(),
      );
      expect(result.isError).toBeUndefined();
      expect(service.interrupts).toEqual([{ terminalId: 'term_1', exitCode: 130 }]);
      expect(result.metadata?.interrupt).toBeNull();
    });

    it('неизвестный и чужой терминал → единый отказ, байт не отправляется', async () => {
      service.records.set('foreign', makeRecord({ id: 'foreign', projectId: 'proj_other' }));

      const unknown = await terminalSignalTool.execute(
        { terminal_id: 'term_missing', signal: 'INT' },
        makeCtx(),
      );
      expect(unknown.isError).toBe(true);
      expect(unknown.metadata?.i18n).toMatchObject({ key: 'terminal.tool.not_found' });

      const foreign = await terminalSignalTool.execute(
        { terminal_id: 'foreign', signal: 'INT' },
        makeCtx(),
      );
      expect(foreign.isError).toBe(true);
      expect(foreign.metadata?.i18n).toMatchObject({ key: 'terminal.tool.not_found' });
      expect(service.writes).toHaveLength(0);
      expect(service.interrupts).toHaveLength(0);
    });

    it('неизвестный сигнал → отказ валидации', async () => {
      const result = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'TERM' },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('argument error');
      expect(service.writes).toHaveLength(0);
    });

    it('без сервиса и при выключенном контуре → отказ', async () => {
      const noService = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'INT' },
        makeCtx({ terminalService: undefined }),
      );
      expect(noService.isError).toBe(true);

      service.enabled = false;
      const disabled = await terminalSignalTool.execute(
        { terminal_id: 'term_1', signal: 'INT' },
        makeCtx(),
      );
      expect(disabled.isError).toBe(true);
      expect(disabled.content).toContain('disabled');
    });
  });

  describe('общий слой вывода (output.ts)', () => {
    it('terminal_read применяет stripTerminalAnsi из output.ts', async () => {
      service.records.set('term_1', makeRecord({ id: 'term_1' }));
      const raw = 'before\u001B]7770;synth-run;abc;0\u0007red\u001B[31m!\u001B[0m\b \r\nend\n';
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: raw }]));

      const result = await terminalReadTool.execute(
        { terminal_id: 'term_1', strip_ansi: true },
        makeCtx(),
      );
      const body = normalizeTerminalOutput(stripTerminalAnsi(raw));
      expect(result.content).toContain(body);
      expect(result.content).not.toContain('\u001B');
    });

    it('в terminals.ts нет своей копии stripAnsi — только импорт из output.ts', async () => {
      const source = await readFile(new URL('./terminals.ts', import.meta.url), 'utf8');
      expect(source).not.toMatch(/function stripAnsi\b/);
      expect(source).not.toMatch(/function stripEscapeSequences\b/);
      expect(source).toContain('stripTerminalAnsi');
      expect(source).toContain("from '../terminal/output.js'");
    });
  });

  describe('Формат маркера [CONTENT …]', () => {
    it('без атрибутов — прежний маркер [CONTENT]', () => {
      expect(frameTerminalOutput('hello')).toBe('[CONTENT]\nhello\n[CONTENT END]');
    });

    it('атрибуты — в открывающем маркере, закрывающий не меняется', () => {
      expect(frameTerminalOutput('hello', { terminal: 'term_1', status: 'running' })).toBe(
        '[CONTENT terminal=term_1 status=running]\nhello\n[CONTENT END]',
      );
    });

    it('значения санитизируются: без переводов строк, пробелов и «]», кап 120 символов', () => {
      const attrs = formatTerminalContentAttributes({
        bad: 'a\nb c]',
        long: 'x'.repeat(200),
        empty: '',
        missing: undefined,
      });
      expect(attrs).toBe(`bad=abc long=${'x'.repeat(120)}`);
    });

    it('числа и булевы значения выводятся как есть, порядок — порядок ключей', () => {
      expect(formatTerminalContentAttributes({ bytes: 12, history: true })).toBe(
        'bytes=12 history=true',
      );
      expect(formatTerminalContentAttributes({})).toBe('');
      expect(formatTerminalContentAttributes(undefined)).toBe('');
    });
  });

  describe('permission-слой', () => {
    it('мутирующие тулы заблокированы в plan-режиме, чтение — разрешено', () => {
      expect(isPlanBlockedTool('terminal_open')).toBe(true);
      expect(isPlanBlockedTool('terminal_write')).toBe(true);
      expect(isPlanBlockedTool('terminal_signal')).toBe(true);
      expect(isPlanBlockedTool('terminal_close')).toBe(true);
      // Запуск команды — исполнение: в plan-режиме заблокирован (ADR-025)
      // в обоих режимах (`background: false` и `background: true`).
      expect(isPlanBlockedTool('terminal_run')).toBe(true);
      expect(isPlanBlockedTool('terminal_list')).toBe(false);
      expect(isPlanBlockedTool('terminal_read')).toBe(false);
      // Снимок экрана — только чтение (рендер в памяти), в плане разрешён.
      expect(isPlanBlockedTool('terminal_snapshot')).toBe(false);
    });

    it('группа `terminal` матчится по capability', () => {
      expect(getToolGroups('terminal_write', [ToolCapability.TERMINAL])).toContain('terminal');
      expect(getToolGroups('terminal_signal', [ToolCapability.TERMINAL])).toContain('terminal');
      expect(getToolGroups('terminal_list', [ToolCapability.TERMINAL])).toContain('terminal');
      expect(getToolGroups('terminal_snapshot', [ToolCapability.TERMINAL])).toContain('terminal');
      expect(getToolGroups('terminal_run', [ToolCapability.TERMINAL])).toContain('terminal');
    });

    it('выключенный контур → unavailable(policy)', () => {
      const availability = computeToolAvailability('terminal_open', [ToolCapability.TERMINAL], {
        getTerminalEnabled: () => false,
      });
      expect(availability).toEqual({ available: false, reason: 'policy' });
    });

    it('включённый контур → доступен', () => {
      const availability = computeToolAvailability('terminal_open', [ToolCapability.TERMINAL], {
        getTerminalEnabled: () => true,
      });
      expect(availability.available).toBe(true);
    });

    it('нет PTY у точки исполнения → unavailable(dependency)', () => {
      const availability = computeToolAvailability('terminal_open', [ToolCapability.TERMINAL], {
        runtimeDeps: {
          git: true, rg: true, sh: true, bash: true, ssh: true, sftp: true,
          pty: false,
          ptyDetail: 'PTY is not supported by the execution environment',
        },
      });
      expect(availability.available).toBe(false);
      expect(availability.reason).toBe('dependency');
      expect(availability.detail).toContain('PTY');
    });

    it('открытие терминала требует оболочку bash', () => {
      expect(TOOL_RUNTIME_DEP.terminal_open).toBe('bash');
    });
  });

  describe('реестр тулов', () => {
    it('все тулы терминалов зарегистрированы', () => {
      const registry = createToolRegistry();
      for (const name of [
        'terminal_list',
        'terminal_open',
        'terminal_read',
        'terminal_snapshot',
        'terminal_write',
        'terminal_signal',
        'terminal_close',
        'terminal_run',
      ]) {
        expect(registry.get(name), name).toBeDefined();
      }
    });

    it('отдельного тула terminal_run_background больше нет', () => {
      const registry = createToolRegistry();
      expect(registry.get('terminal_run_background')).toBeUndefined();
      // И в группе правил `terminal` его нет: оба режима — один тул.
      expect(TERMINAL_TOOLS).not.toContain('terminal_run_background');
      expect(TERMINAL_TOOLS).toContain('terminal_run');
    });

    it('terminal_signal в реестре и в группе правил `terminal`', () => {
      const registry = createToolRegistry();
      expect(registry.get('terminal_signal')).toBeDefined();
      expect(TERMINAL_TOOLS).toContain('terminal_signal');
    });
  });
});
