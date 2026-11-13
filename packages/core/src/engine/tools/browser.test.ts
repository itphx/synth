/**
 * Встроенные browser-тулы (D1): `browser_navigate`, `browser_snapshot`,
 * `browser_close`.
 *
 * Проверяется граница тулов:
 * - цель роутера: класс `browser`, область (projectId/sessionId) и
 *   `workspaceSubPath`;
 * - имя инструмента и аргументы, которые уходят на порт;
 * - отказ без `browserCall` (inline/старая реализация) — понятный текст;
 * - ошибка порта — `isError`, без исключения;
 * - «Стоп» и невалидные аргументы.
 *
 * Реальный исполнитель/браузер не нужен: роутер и порт подменены.
 */
import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@itphx/synth-shared';
import type { ExecutionRouter, ExecutionPortTarget } from '../../execution/router.js';
import type {
  BrowserCallRequest,
  BrowserCallResult,
  ExecutionPort,
} from '../../execution/ports/index.js';
import {
  browserCloseTool,
  browserNavigateTool,
  browserSnapshotTool,
} from './browser.js';

/** Порт-заглушка: запоминает browser-вызовы, отвечает по сценарию. */
class FakeBrowserPort implements ExecutionPort {
  readonly calls: BrowserCallRequest[] = [];

  constructor(private readonly script: (req: BrowserCallRequest) => BrowserCallResult) {}

  async execute(): Promise<never> {
    throw new Error('execute не используется browser-тулами');
  }

  async browserCall(req: BrowserCallRequest): Promise<BrowserCallResult> {
    this.calls.push(req);
    return this.script(req);
  }
}

/** Порт без browser-вызова: так выглядит inline-реализация. */
const plainPort: ExecutionPort = {
  async execute() {
    return { stdout: '', stderr: '', exitCode: 0, truncated: false, durationMs: 0 };
  },
};

/** Роутер-заглушка: запоминает цели, всегда отдаёт один порт. */
function fakeRouter(port: ExecutionPort): {
  router: ExecutionRouter;
  targets: ExecutionPortTarget[];
} {
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

/** Контекст вызова: проект и рабочее дерево по умолчанию. */
function makeCtx(extra: Record<string, unknown> = {}): ToolContext {
  return {
    sessionId: 'ses_1',
    messageId: 'm1',
    projectId: 'prj_1',
    workingDir: '/workspace/proj',
    agentRole: 'fixer',
    extra,
  };
}

/** Успешный результат browser-вызова. */
function ok(content: string): BrowserCallResult {
  return { content, isError: false };
}

describe('browser-тулы — цель порта', () => {
  it('navigate уходит в пул класса `browser` с областью проекта и subPath', async () => {
    const port = new FakeBrowserPort(() => ok('Navigated to https://example.com'));
    const { router, targets } = fakeRouter(port);
    const ctx = makeCtx({
      executionRouter: router,
      executionWorkspaceSubPath: 'proj/.worktrees/f',
    });

    const result = await browserNavigateTool.execute({ url: 'https://example.com' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain('https://example.com');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      class: 'browser',
      projectId: 'prj_1',
      sessionId: 'ses_1',
      workspaceSubPath: 'proj/.worktrees/f',
    });
    expect(targets[0]?.profile).toBeUndefined();
    expect(port.calls).toEqual([
      { tool: 'browser_navigate', arguments: { url: 'https://example.com' } },
    ]);
  });

  it('без workspaceSubPath поле не задаётся', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const { router, targets } = fakeRouter(port);

    await browserNavigateTool.execute({ url: 'https://example.com' }, makeCtx({ executionRouter: router }));

    expect(targets[0]?.workspaceSubPath).toBeUndefined();
    expect(targets[0]?.class).toBe('browser');
  });

  it('router нет — используется порт сессии (ctx.extra.executionPort)', async () => {
    const port = new FakeBrowserPort(() => ok('snapshot'));
    const ctx = makeCtx({ executionPort: port });

    const result = await browserSnapshotTool.execute({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(port.calls).toEqual([{ tool: 'browser_snapshot', arguments: {} }]);
  });
});

describe('browser-тулы — имена инструментов и аргументы', () => {
  it('snapshot и close вызывают свои инструменты с пустыми аргументами', async () => {
    const port = new FakeBrowserPort((req) => ok(`${req.tool}: done`));
    const { router } = fakeRouter(port);
    const ctx = makeCtx({ executionRouter: router });

    const snapshot = await browserSnapshotTool.execute({}, ctx);
    const close = await browserCloseTool.execute({}, ctx);

    expect(String(snapshot.content)).toContain('browser_snapshot');
    expect(String(close.content)).toContain('browser_close');
    expect(port.calls).toEqual([
      { tool: 'browser_snapshot', arguments: {} },
      { tool: 'browser_close', arguments: {} },
    ]);
  });
});

describe('browser-тулы — отказы', () => {
  it('нет browserCall у порта → isError с понятным текстом', async () => {
    const { router, targets } = fakeRouter(plainPort);
    const ctx = makeCtx({ executionRouter: router });

    const result = await browserNavigateTool.execute({ url: 'https://example.com' }, ctx);

    expect(result.isError).toBe(true);
    const content = String(result.content);
    expect(content).toContain('Browser execution is unavailable');
    // Текст для модели — без внутренних терминов документации.
    expect(content).not.toMatch(/ADR|PROP|MCP/);
    expect(targets).toHaveLength(1);
  });

  it('ошибка порта (исключение) → isError, тул не бросает', async () => {
    const port = new FakeBrowserPort(() => {
      throw new Error('executor exploded');
    });
    const { router } = fakeRouter(port);

    const result = await browserNavigateTool.execute(
      { url: 'https://example.com' },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('executor exploded');
  });

  it('isError от инструмента → isError в результате тула', async () => {
    const port = new FakeBrowserPort(() => ({
      content: 'Navigation failed: net::ERR_NAME_NOT_RESOLVED',
      isError: true,
    }));
    const { router } = fakeRouter(port);

    const result = await browserNavigateTool.execute(
      { url: 'https://nope.invalid' },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('ERR_NAME_NOT_RESOLVED');
  });

  it('пустой url → argErrorResult, порт не вызывается', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const { router, targets } = fakeRouter(port);

    const result = await browserNavigateTool.execute({ url: '' }, makeCtx({ executionRouter: router }));

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ i18n: { key: 'tool.args_error' } });
    expect(port.calls).toHaveLength(0);
    expect(targets).toHaveLength(0);
  });

  it('роутер бросил (fail-closed) → isError с текстом отказа', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const router: ExecutionRouter = {
      portFor(): ExecutionPort {
        throw new Error('execution pool scope "project" requires an id');
      },
    };

    const result = await browserNavigateTool.execute(
      { url: 'https://example.com' },
      makeCtx({ executionRouter: router }),
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Browser execution is unavailable');
    expect(String(result.content)).toContain('requires an id');
    expect(port.calls).toHaveLength(0);
  });

  it('«Стоп» до запуска → маркер прерывания, вызова нет', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const { router } = fakeRouter(port);
    const controller = new AbortController();
    controller.abort();

    const result = await browserNavigateTool.execute(
      { url: 'https://example.com' },
      { ...makeCtx({ executionRouter: router }), abortSignal: controller.signal },
    );

    expect(String(result.content)).toContain('<status>stopped_by_user</status>');
    expect(result.metadata).toMatchObject({ interrupted: true, stopped_by: 'user' });
    expect(port.calls).toHaveLength(0);
  });
});
