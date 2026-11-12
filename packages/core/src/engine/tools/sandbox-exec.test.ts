/**
 * PROP-135 слайс 5a: тул `sandbox_exec` — разовый запуск команд в отдельном
 * профиле исполнения (пул класса `sandbox`).
 *
 * Проверяется граница тула:
 * - цель порта: `class:'sandbox'`, профиль, `workspaceSubPath`, область;
 * - последовательный запуск и формат отчёта (заголовок/stdout/stderr/код);
 * - остановка после первой ошибки (следующие команды не выполняются);
 * - отсутствие роутера и выход `cwd` за периметр — понятные отказы;
 * - невалидные аргументы и «Стоп».
 *
 * Реальный provisioner/исполнитель не нужен: роутер и порт подменены.
 */
import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@itphx/synth-shared';
import type { ExecutionRouter, ExecutionPortTarget } from '../../execution/router.js';
import {
  ExecutionError,
  type ExecRequest,
  type ExecResult,
  type ExecutionPort,
} from '../../execution/ports/index.js';
import { sandboxExecTool } from './sandbox-exec.js';

/** Ответ порта по команде: результат либо ошибка. */
type Scripted = ExecResult | Error;

/** Порт-заглушка: запоминает запросы, отвечает по сценарию. */
class FakePort implements ExecutionPort {
  readonly requests: ExecRequest[] = [];

  constructor(private readonly script: (req: ExecRequest) => Scripted) {}

  async execute(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    const next = this.script(req);
    if (next instanceof Error) throw next;
    return next;
  }
}

/** Роутер-заглушка: запоминает цели, всегда отдаёт один порт. */
function fakeRouter(port: ExecutionPort): { router: ExecutionRouter; targets: ExecutionPortTarget[] } {
  const targets: ExecutionPortTarget[] = [];
  return {
    targets,
    router: {
      portFor(target?: ExecutionPortTarget): ExecutionPort {
        if (target) targets.push(target);
        return port;
      },
    },
  };
}

/** Контекст вызова: рабочее дерево `/workspace/proj`, корень проекта — рядом. */
function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
  return {
    sessionId: 'ses_1',
    messageId: 'm1',
    projectId: 'prj_1',
    workingDir: '/workspace/proj',
    allowedRoots: ['/workspace/project-root'],
    agentRole: 'fixer',
    extra,
  };
}

/** Успешный результат порта. */
function ok(stdout: string, stderr = '', exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode, truncated: false, durationMs: 1 };
}

describe('sandbox_exec — цель порта', () => {
  it('класс `sandbox`, профиль, область и workspaceSubPath уходят в роутер', async () => {
    const port = new FakePort(() => ok('hello\n'));
    const { router, targets } = fakeRouter(port);
    const ctx = makeCtx({ executionRouter: router, executionWorkspaceSubPath: 'proj/.worktrees/f' });

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['echo hello'] },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      profile: 'devops',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      workspaceSubPath: 'proj/.worktrees/f',
      class: 'sandbox',
    });
  });

  it('нет `workspaceSubPath` — поле не задаётся (provisioner смонтирует корень тома)', async () => {
    const port = new FakePort(() => ok(''));
    const { router, targets } = fakeRouter(port);

    await sandboxExecTool.execute({ profile: 'devops', commands: ['true'] }, makeCtx({ executionRouter: router }));

    expect(targets[0]?.workspaceSubPath).toBeUndefined();
    expect(targets[0]?.class).toBe('sandbox');
  });
});

describe('sandbox_exec — запуск и отчёт', () => {
  it('команды идут последовательно; формат — заголовок, stdout, stderr, код выхода', async () => {
    const port = new FakePort((req) => {
      const command = req.command.kind === 'shell' ? req.command.command : '';
      return command === 'first' ? ok('one\n') : ok('two\n', 'warn\n', 3);
    });
    const { router } = fakeRouter(port);

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['first', 'second'] },
      makeCtx({ executionRouter: router }),
    );

    // Запросы — в порядке команд, оболочка bash, cwd и лимит вывода заданы.
    expect(port.requests).toHaveLength(2);
    expect(port.requests[0]!.command).toEqual({ kind: 'shell', command: 'first', shell: 'bash' });
    expect(port.requests[1]!.command).toEqual({ kind: 'shell', command: 'second', shell: 'bash' });
    expect(port.requests[0]!.cwd).toBe('/workspace/proj');
    expect(port.requests[0]!.maxOutputBytes).toBeGreaterThan(0);
    expect(port.requests[0]!.timeoutMs).toBe(120_000);

    const content = String(result.content);
    expect(content).toContain('[sandbox:devops] $ first');
    expect(content).toContain('one');
    expect(content).toContain('(exit 0)');
    expect(content).toContain('[sandbox:devops] $ second');
    expect(content).toContain('[stderr]');
    expect(content).toContain('warn');
    expect(content).toContain('(exit 3)');
    // Коды выхода — в порядке команд, ошибки нет.
    expect(result.isError).toBeFalsy();
    expect(result.metadata).toMatchObject({
      profile: 'devops',
      commands: ['first', 'second'],
      cwd: '/workspace/proj',
      exit_codes: [0, 3],
    });
  });

  it('таймаут и cwd из аргументов доходят до порта', async () => {
    const port = new FakePort(() => ok(''));
    const { router } = fakeRouter(port);

    await sandboxExecTool.execute(
      { profile: 'devops', commands: ['pwd'], cwd: 'sub', timeout_ms: 5000 },
      makeCtx({ executionRouter: router }),
    );

    expect(port.requests[0]!.cwd).toBe('/workspace/proj/sub');
    expect(port.requests[0]!.timeoutMs).toBe(5000);
  });

  it('ошибка команды: `Error: …`, `isError` и остановка (следующие не запускаются)', async () => {
    const port = new FakePort((req) => {
      const command = req.command.kind === 'shell' ? req.command.command : '';
      if (command === 'boom') {
        return new ExecutionError({
          message: 'Command failed: boom',
          code: 2,
          stdout: 'partial\n',
          stderr: 'bad\n',
          reason: 'nonzero_exit',
        });
      }
      return ok('never\n');
    });
    const { router } = fakeRouter(port);

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['boom', 'after'] },
      makeCtx({ executionRouter: router }),
    );

    // Вторая команда не выполнялась.
    expect(port.requests).toHaveLength(1);
    expect(result.isError).toBe(true);
    const content = String(result.content);
    expect(content).toContain('[sandbox:devops] $ boom');
    expect(content).toContain('partial');
    expect(content).toContain('bad');
    expect(content).toContain('Error: Command failed: boom');
    expect(content).not.toContain('$ after');
    expect(result.metadata).toMatchObject({ exit_codes: [2] });
  });

  it('ошибка без кода выхода — `-1` в метаданных, тул не бросает', async () => {
    const port = new FakePort(() => new ExecutionError({
      message: 'spawn failed',
      code: null,
      reason: 'spawn_failed',
    }));
    const { router } = fakeRouter(port);

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['x'] },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ exit_codes: [-1] });
    expect(String(result.content)).toContain('Error: spawn failed');
  });
});

describe('sandbox_exec — отказы до запуска', () => {
  it('нет роутера → понятная ошибка, команды не исполняются', async () => {
    const port = new FakePort(() => ok(''));
    const ctx = makeCtx({ executionPort: port });

    const result = await sandboxExecTool.execute({ profile: 'devops', commands: ['ls'] }, ctx);

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Sandbox execution is unavailable');
    expect(String(result.content)).toContain('execution.mode=remote');
    expect(port.requests).toHaveLength(0);
  });

  it('cwd вне периметра → pathEscapesWorkspaceResult', async () => {
    const port = new FakePort(() => ok(''));
    const { router } = fakeRouter(port);

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['ls'], cwd: '/etc' },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ path: '/etc' });
    expect(port.requests).toHaveLength(0);
  });

  it('cwd внутри корня проекта (allowedRoots) — не внешний', async () => {
    const port = new FakePort(() => ok(''));
    const { router } = fakeRouter(port);

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['ls'], cwd: '/workspace/project-root/sub' },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBeFalsy();
    expect(port.requests[0]!.cwd).toBe('/workspace/project-root/sub');
  });

  it('пустой список команд → argErrorResult, порт не вызывается', async () => {
    const port = new FakePort(() => ok(''));
    const { router, targets } = fakeRouter(port);

    const result = await sandboxExecTool.execute({ profile: 'devops', commands: [] }, makeCtx({ executionRouter: router }));

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ i18n: { key: 'tool.args_error' } });
    expect(targets).toHaveLength(0);
  });

  it('больше 5 команд → argErrorResult', async () => {
    const port = new FakePort(() => ok(''));
    const { router, targets } = fakeRouter(port);

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['1', '2', '3', '4', '5', '6'] },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ i18n: { key: 'tool.args_error' } });
    expect(targets).toHaveLength(0);
  });

  it('«Стоп» до запуска → маркер прерывания, команд нет', async () => {
    const port = new FakePort(() => ok(''));
    const { router } = fakeRouter(port);
    const controller = new AbortController();
    controller.abort();

    const result = await sandboxExecTool.execute(
      { profile: 'devops', commands: ['ls'] },
      { ...makeCtx({ executionRouter: router }), abortSignal: controller.signal },
    );

    expect(String(result.content)).toContain('<status>stopped_by_user</status>');
    expect(result.metadata).toMatchObject({ interrupted: true, stopped_by: 'user' });
    expect(port.requests).toHaveLength(0);
  });
});
