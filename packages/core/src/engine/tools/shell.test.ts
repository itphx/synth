import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeShellTool } from './shell.js';
import { ExecutionError } from '../../execution/ports/index.js';
import type { ToolContext } from '@itphx/synth-shared';
import type { ProcessService } from '../processes/service.js';

describe('execute_shell — cwd resolution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('без cwd — команда выполняется в рабочем каталоге', async () => {
    const result = await executeShellTool.execute({ command: 'pwd' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(tmpDir);
  });

  it('cwd: относительный путь', async () => {
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
    const result = await executeShellTool.execute({ command: 'pwd', cwd: 'sub' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(join(tmpDir, 'sub'));
  });

  it('cwd: абсолютный путь', async () => {
    const result = await executeShellTool.execute({ command: 'pwd', cwd: tmpDir }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content.trim()).toBe(tmpDir);
  });
});

describe('execute_shell — прерывание по «Стоп» (abortSignal)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-abort-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      ...overrides,
    };
  }

  it('abort во время долгой команды: процесс убит, tool_result содержит маркер прерывания и частичный вывод', async () => {
    const ac = new AbortController();
    // exec sleep: sleep заменяет sh — SIGTERM по «Стоп» убивает его напрямую,
    // дочерних процессов-сирот не остаётся
    const promise = executeShellTool.execute(
      { command: 'echo partial-before-stop; exec sleep 60', timeout: 120 },
      makeCtx({ abortSignal: ac.signal }),
    );

    // Даём команде стартовать и напечатать частичный вывод
    await new Promise((resolve) => setTimeout(resolve, 500));
    ac.abort();

    const result = await promise;
    const elapsedMs = Date.now();

    // Единый маркер прерывания (консистентно с task.ts)
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.content).toContain('partial-before-stop');
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(result.metadata?.partial_output).toContain('partial-before-stop');

    // Процесс убит сразу, а не по 120-секундному таймауту
    expect(Date.now() - elapsedMs).toBeLessThan(30_000);
  });

  it('pre-aborted: команда не стартует (файл-маркер не создаётся)', async () => {
    const ac = new AbortController();
    ac.abort();

    const marker = join(tmpDir, 'should-not-be-created');
    const result = await executeShellTool.execute(
      { command: `touch ${marker}` },
      makeCtx({ abortSignal: ac.signal }),
    );

    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(result.content).toContain('<status>stopped_by_user</status>');

    // Даём время, если бы команда всё же запустилась
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(access(marker)).rejects.toThrow();
  });

  it('без abortSignal — команда выполняется как раньше (обратная совместимость)', async () => {
    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('ok');
    expect(result.metadata?.interrupted).toBeUndefined();
  });

  it('таймаут (без «Стопа») — ошибка с actionable-текстом, а не маркер прерывания', async () => {
    const result = await executeShellTool.execute(
      { command: 'sleep 5', timeout: 1 },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    // Таймаут не должен выглядеть как «Command failed»: модель получает
    // величину лимита (в секундах) и подсказку.
    expect(result.content).toContain('timed out');
    expect(result.content).toContain('1 seconds');
    expect(result.metadata?.reason).toBe('timeout');
    expect(result.metadata?.interrupted).toBeUndefined();
    expect(result.metadata?.stopped_by).toBeUndefined();
  });
});

describe('execute_shell — таймаут', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-timeout-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Порт-заглушка: пишет запросы (виден таймаут) и ничего не запускает. */
  function makePort() {
    const requests: Array<{ timeoutMs?: number }> = [];
    return {
      requests,
      async execute(req: { timeoutMs?: number }) {
        requests.push({ timeoutMs: req.timeoutMs });
        return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
      },
    };
  }

  function makeCtx(extra: Record<string, unknown>): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra,
    };
  }

  it('дефолт таймаута — 120 с (в порт уходит 120000)', async () => {
    const port = makePort();
    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx({ executionPort: port }));

    expect(result.isError).toBeFalsy();
    expect(port.requests[0]!.timeoutMs).toBe(120_000);
  });

  it('timeout: 0 — отказ аргументов («без лимита» больше нет)', async () => {
    const port = makePort();
    const result = await executeShellTool.execute({ command: 'echo ok', timeout: 0 }, makeCtx({ executionPort: port }));

    expect(result.isError).toBe(true);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    expect(port.requests).toHaveLength(0);
  });

  it('timeout больше 600 с в foreground — отказ аргументов (команда не запускается)', async () => {
    const port = makePort();
    const result = await executeShellTool.execute(
      { command: 'echo ok', timeout: 601 },
      makeCtx({ executionPort: port }),
    );

    expect(result.isError).toBe(true);
    expect((result.metadata?.i18n as { key?: string })?.key).toBe('tool.args_error');
    expect(port.requests).toHaveLength(0);
  });

  it('background: timeout до 86400 с допустим (потолок фонового режима)', async () => {
    const port = makePort();
    const result = await executeShellTool.execute(
      { command: 'echo ok', timeout: 86_400, background: true },
      makeCtx({ executionPort: port }),
    );

    // Валидация параметров пройдена (фоновый запуск без сервиса процессов
    // отказывает по другой причине — `process.deps_unavailable`).
    expect((result.metadata?.i18n as { key?: string })?.key).not.toBe('tool.args_error');
  });

  it('timeout выше потолка фонового режима — текст отказа про background, не про foreground', async () => {
    const port = makePort();
    const result = await executeShellTool.execute(
      { command: 'echo ok', timeout: 86_401, background: true },
      makeCtx({ executionPort: port }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/background mode/);
    expect(result.content).not.toMatch(/in foreground/);
    expect(port.requests).toHaveLength(0);
  });
});

describe('execute_shell — фоновый запуск (background: true)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-bg-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(extra: Record<string, unknown>): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra,
    };
  }

  it('backgroundEnabled=false — отказ process.background_disabled, процесс не запущен', async () => {
    const spawn = vi.fn();
    const processService = { spawn } as unknown as ProcessService;

    const result = await executeShellTool.execute(
      { command: 'sleep 1', background: true },
      makeCtx({ processService, backgroundEnabled: false }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Background processes are disabled');
    expect(result.metadata?.i18n).toMatchObject({ key: 'process.background_disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('backgroundEnabled=true — процесс запущен (гейт не мешает)', async () => {
    const spawn = vi.fn().mockResolvedValue({
      runId: 'bgr_1',
      processId: 'proc_1',
      logPath: 'processes/bgr_1.log',
    });
    const processService = { spawn } as unknown as ProcessService;

    const result = await executeShellTool.execute(
      { command: 'sleep 1', background: true },
      makeCtx({ processService, backgroundEnabled: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.metadata?.process_id).toBe('proc_1');
  });
});

/**
 * PROP-124 §2: секреты вызова (режим `ssh-агента`) в `execute_shell`.
 *
 * Резолвер приходит из `ctx.extra.sshSecrets` (его собирает оркестратор):
 * тул получает ключи **один раз на вызов** и передаёт их точке исполнения.
 * При пустом списке поле `secrets` в запрос не попадает вовсе.
 */
describe('execute_shell — секреты вызова (режим ssh-агента)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-ssh-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(extra: Record<string, unknown>): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra,
    };
  }

  /** Порт-заглушка: пишет запросы (в них видны секреты). */
  function makePort() {
    const requests: Array<{ secrets?: unknown[] }> = [];
    return {
      requests,
      async execute(req: { secrets?: unknown[] }) {
        requests.push(req);
        return { stdout: 'ok', stderr: '', exitCode: 0, truncated: false, durationMs: 1 };
      },
    };
  }

  const secret = { kind: 'ssh-key' as const, privateKey: 'key-material', mode: 'agent' as const };

  it('режим agent — секреты уходят в порт исполнения', async () => {
    const port = makePort();

    const result = await executeShellTool.execute(
      { command: 'echo ok' },
      makeCtx({ executionPort: port, sshSecrets: async () => [secret] }),
    );

    expect(result.isError).toBeFalsy();
    expect(port.requests[0]?.secrets).toEqual([secret]);
  });

  it('режим tools (резолвер вернул пусто) — поле secrets в запросе нет', async () => {
    const port = makePort();

    const result = await executeShellTool.execute(
      { command: 'echo ok' },
      makeCtx({ executionPort: port, sshSecrets: async () => [] }),
    );

    expect(result.isError).toBeFalsy();
    expect(port.requests[0]).not.toHaveProperty('secrets');
  });

  it('резолвера нет — вызов идёт без секретов (поле не появляется)', async () => {
    const port = makePort();

    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx({ executionPort: port }));

    expect(result.isError).toBeFalsy();
    expect(port.requests[0]).not.toHaveProperty('secrets');
  });

  it('фоновый запуск — секреты уходят в ProcessService.spawn', async () => {
    const spawn = vi.fn().mockResolvedValue({
      runId: 'bgr_1',
      processId: 'proc_1',
      logPath: 'processes/bgr_1.log',
    });
    const processService = { spawn } as unknown as ProcessService;

    const result = await executeShellTool.execute(
      { command: 'sleep 1', background: true },
      makeCtx({
        processService,
        backgroundEnabled: true,
        sshSecrets: async () => [secret],
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ secrets: [secret] });
  });

  it('фоновый запуск без секретов — поле secrets в spawn не появляется', async () => {
    const spawn = vi.fn().mockResolvedValue({
      runId: 'bgr_1',
      processId: 'proc_1',
      logPath: 'processes/bgr_1.log',
    });
    const processService = { spawn } as unknown as ProcessService;

    await executeShellTool.execute(
      { command: 'sleep 1', background: true },
      makeCtx({ processService, backgroundEnabled: true }),
    );

    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('secrets');
  });
});

/**
 * ANSI-шум в выводе команды.
 *
 * Shell исполняется в PTY с `TERM=xterm-256color`/`COLORTERM=truecolor`, поэтому
 * программы включают цвета. Модели цвет не нужен: `ESC[…m` — шум в контексте,
 * лишние токены и искажённые сравнения с путями/кодом. Нормализация —
 * **эталонная** (`stripTerminalAnsi` из `engine/terminal/output.js`), поэтому
 * ожидания ниже — это её поведение, а не подгонка под результат.
 *
 * Лог фонового прогона и буфер терминала остаются raw: тесты проверяют только
 * текст, который уходит модели.
 */
describe('execute_shell — снятие ANSI из вывода для модели', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-shell-ansi-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Порт-заглушка: отдаёт заданный вывод либо бросает заданную ошибку. */
  function makePort(result: { stdout?: string; stderr?: string } | Error) {
    return {
      async execute() {
        if (result instanceof Error) throw result;
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: 0,
          truncated: false,
          durationMs: 1,
        };
      },
    };
  }

  function makeCtx(port: unknown): ToolContext {
    return {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: tmpDir,
      extra: { executionPort: port },
    };
  }

  it('stdout с ANSI — коды вырезаны, текст сохранён, ansi_stripped = true', async () => {
    const port = makePort({ stdout: '\u001b[32mOK\u001b[0m \u001b[1mbold\u001b[0m\n' });

    const result = await executeShellTool.execute({ command: 'colorful' }, makeCtx(port));

    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain('\u001b');
    expect(result.content).toContain('OK');
    expect(result.content).toContain('bold');
    expect(result.content).toBe('OK bold\n');
    expect(result.metadata?.ansi_stripped).toBe(true);
    // Остальной контракт тула не изменился.
    expect(result.metadata).toMatchObject({ command: 'colorful', exitCode: 0, truncated: false });
  });

  it('вывод без ANSI — текст не изменён, ansi_stripped не выставляется', async () => {
    const port = makePort({ stdout: 'ok\n' });

    const result = await executeShellTool.execute({ command: 'echo ok' }, makeCtx(port));

    expect(result.content).toBe('ok\n');
    expect(result.metadata?.ansi_stripped).toBeUndefined();
  });

  it('stderr с ANSI — тоже очищен, текст сохранён', async () => {
    const port = makePort({ stderr: '\u001b[31mnote\u001b[0m\n' });

    const result = await executeShellTool.execute({ command: 'warn' }, makeCtx(port));

    expect(result.content).not.toContain('\u001b');
    expect(result.content).toBe('note\n');
    expect(result.metadata?.ansi_stripped).toBe(true);
  });

  it('прогресс-бар с \\r — не мусор: одиночный CR вырезан (поведение stripTerminalAnsi)', async () => {
    const port = makePort({ stdout: 'one\rtwo\n' });

    const result = await executeShellTool.execute({ command: 'progress' }, makeCtx(port));

    // Эталонная нормализация: одиночный `\r` (возврат каретки) вырезается,
    // текст остаётся читаемым — «one» + «two», без ESC-мусора.
    expect(result.content).toBe('onetwo\n');
    expect(result.content).not.toContain('\r');
    expect(result.metadata?.ansi_stripped).toBe(true);
  });

  it('ошибка команды — частичный вывод модели тоже без ANSI', async () => {
    const err = new ExecutionError({
      message: 'Command failed: exit code 2',
      reason: 'nonzero_exit',
      code: 2,
      stdout: '\u001b[1mboom\u001b[0m\n',
      stderr: '\u001b[31mstderr-note\u001b[0m\n',
    });

    const result = await executeShellTool.execute({ command: 'fail' }, makeCtx(makePort(err)));

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('\u001b');
    expect(result.content).toContain('boom');
    expect(result.content).toContain('stderr-note');
    expect(result.metadata?.ansi_stripped).toBe(true);
    expect(result.metadata).toMatchObject({ command: 'fail', exitCode: 2 });
  });

  it('таймаут — частичный вывод тоже без ANSI', async () => {
    const err = new ExecutionError({
      message: 'Command timed out',
      reason: 'timeout',
      killed: true,
      stdout: '\u001b[33mbefore-timeout\u001b[0m\n',
    });

    const result = await executeShellTool.execute({ command: 'slow', timeout: 1 }, makeCtx(makePort(err)));

    expect(result.isError).toBe(true);
    expect(result.metadata?.reason).toBe('timeout');
    expect(result.content).not.toContain('\u001b');
    expect(result.content).toContain('before-timeout');
    expect(result.metadata?.ansi_stripped).toBe(true);
  });

  it('реальный inline-порт: цвет из printf вырезан, текст сохранён', async () => {
    // Без `executionPort` в extra — настоящий inline-порт (тот же путь, что в
    // бою): команда печатает настоящие ESC-последовательности.
    const result = await executeShellTool.execute(
      { command: "printf '\\033[32mOK\\033[0m\\n'" },
      { sessionId: 's1', messageId: 'm1', workingDir: tmpDir },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain('\u001b');
    expect(result.content.trim()).toBe('OK');
    expect(result.metadata?.ansi_stripped).toBe(true);
  });

  it('в shell.ts и shell-detachable.ts нет своей копии stripAnsi — только импорт из output.ts', async () => {
    for (const file of ['./shell.ts', './shell-detachable.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/function stripAnsi\b/);
      expect(source).not.toMatch(/function stripTerminalAnsi\b/);
      expect(source).not.toMatch(/function stripEscapeSequences\b/);
    }
    const detachable = await readFile(new URL('./shell-detachable.ts', import.meta.url), 'utf8');
    expect(detachable).toContain('stripTerminalAnsi');
    expect(detachable).toContain("from '../terminal/output.js'");
  });
});
