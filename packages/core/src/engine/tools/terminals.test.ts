/**
 * PROP-132 (Ф5): тесты встроенных тулов интерактивных терминалов
 * (`engine/tools/terminals.ts`).
 *
 * Сервис терминалов — **подделка** (`FakeTerminalService`): проверяются тулы,
 * а не PTY/реестр (они — в `engine/terminal/service.test.ts`). Подделка
 * реализует ровно те методы `TerminalService`, которые зовут тулы:
 * `isEnabled`/`create`/`get`/`list`/`output`/`write`/`close`.
 *
 * Что проверяется:
 * - `terminal_list` — пустой список, строки `key=value`, скоуп по проекту
 *   (чужой терминал не виден), отсутствие сервиса/выключенный контур/
 *   сессия без проекта;
 * - `terminal_open` — дефолты 80×24, каталог = рабочий каталог сессии,
 *   привязка к сессии, маппинг типизированных ошибок сервиса;
 * - `terminal_read` — вывод, `since`, `tail`, `strip_ansi`, кап 32 КиБ,
 *   единый отказ «не найден» (неизвестный и чужой терминал);
 * - `terminal_write` — ввод без Enter и с Enter (перевод строки), запрет
 *   команды политикой (тот же чекер, что у `execute_shell`), требование
 *   подтверждения (внешний/защищённый путь);
 * - `terminal_close` — закрытие и единый отказ «не найден»;
 * - permission-слой: plan-блокировка мутирующих тулов, группа `terminal`,
 *   доступность при выключенном контуре и при отсутствии PTY.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@itphx/synth-shared';
import { ToolCapability } from '@itphx/synth-shared';
import {
  terminalListTool,
  terminalOpenTool,
  terminalReadTool,
  terminalWriteTool,
  terminalCloseTool,
} from './terminals.js';
import type { TerminalOutputSnapshot, TerminalRecord } from '../terminal/types.js';
import {
  TerminalDisabledError,
  TerminalLimitError,
} from '../terminal/types.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';
import { computeToolAvailability } from '../permission/availability.js';
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

    it('читает вывод терминала', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'hello\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(result.content).toBe('hello\n');
      expect(result.metadata?.bytes).toBe(6);
    });

    it('since отбрасывает старые фрагменты', async () => {
      service.outputs.set('term_1', makeSnapshot([
        { seq: 1, data: 'old\n' },
        { seq: 2, data: 'new\n' },
      ]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', since: 1 }, makeCtx());
      expect(result.content).toBe('new\n');
    });

    it('tail оставляет последние N строк (завершающий пустой элемент отброшен)', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\nc\nd\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 2 }, makeCtx());
      expect(result.content).toBe('c\nd');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('tail без завершающего перевода строки', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\nc' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 2 }, makeCtx());
      expect(result.content).toBe('b\nc');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('tail с переводами строк CRLF', async () => {
      // Формула хвоста снимает завершающий LF (`text.replace(/\n$/, '')`),
      // поэтому у CRLF-вывода остаётся CR последней строки — это часть
      // разделителя, а не отдельный символ вывода.
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\r\nb\r\nc\r\nd\r\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 2 }, makeCtx());
      expect(result.content).toBe('c\r\nd\r');
      expect(result.metadata?.truncated).toBe(true);
    });

    it('tail больше, чем строк, — весь текст как есть', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: 'a\nb\n' }]));
      const result = await terminalReadTool.execute({ terminal_id: 'term_1', tail: 5 }, makeCtx());
      expect(result.content).toBe('a\nb');
      expect(result.metadata?.truncated).toBe(false);
    });

    it('ANSI по умолчанию сохраняется, strip_ansi вырезает', async () => {
      service.outputs.set('term_1', makeSnapshot([{ seq: 1, data: '\u001B[31mred\u001B[0m\n' }]));

      const raw = await terminalReadTool.execute({ terminal_id: 'term_1' }, makeCtx());
      expect(raw.content).toContain('\u001B[31m');

      const stripped = await terminalReadTool.execute({ terminal_id: 'term_1', strip_ansi: true }, makeCtx());
      expect(stripped.content).toBe('red\n');
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

    it('enter добавляет перевод строки', async () => {
      await terminalWriteTool.execute({ terminal_id: 'term_1', data: 'ls -la', enter: true }, makeCtx());
      expect(service.writes[0]?.data).toBe('ls -la\n');
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
      expect(service.writes[0]?.data).toBe('echo hi\n');
    });

    it('неизвестный терминал → «не найден»', async () => {
      const result = await terminalWriteTool.execute({ terminal_id: 'term_missing', data: 'ls' }, makeCtx());
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

  describe('permission-слой', () => {
    it('мутирующие тулы заблокированы в plan-режиме, чтение — разрешено', () => {
      expect(isPlanBlockedTool('terminal_open')).toBe(true);
      expect(isPlanBlockedTool('terminal_write')).toBe(true);
      expect(isPlanBlockedTool('terminal_close')).toBe(true);
      expect(isPlanBlockedTool('terminal_list')).toBe(false);
      expect(isPlanBlockedTool('terminal_read')).toBe(false);
    });

    it('группа `terminal` матчится по capability', () => {
      expect(getToolGroups('terminal_write', [ToolCapability.TERMINAL])).toContain('terminal');
      expect(getToolGroups('terminal_list', [ToolCapability.TERMINAL])).toContain('terminal');
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
    it('все пять тулов зарегистрированы', () => {
      const registry = createToolRegistry();
      for (const name of [
        'terminal_list',
        'terminal_open',
        'terminal_read',
        'terminal_write',
        'terminal_close',
      ]) {
        expect(registry.get(name), name).toBeDefined();
      }
    });
  });
});
