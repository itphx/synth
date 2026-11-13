/**
 * Встроенные browser-тулы (D1/D2): `browser_navigate`, `browser_snapshot`,
 * `browser_click`, `browser_type`, `browser_press`, `browser_wait`,
 * `browser_screenshot`, `browser_close`.
 *
 * Проверяется граница тулов:
 * - цель роутера: класс `browser`, область (projectId/sessionId) и
 *   `workspaceSubPath`;
 * - имя инструмента и аргументы, которые уходят на порт (в т.ч. переименование
 *   `press` → `browser_press_key`, `wait` → `browser_wait_for`);
 * - отказ без `browserCall` (inline/старая реализация) — понятный текст;
 * - ошибка порта — `isError`, без исключения;
 * - скриншот: публикация вложения через `AttachmentService` (ссылки в
 *   `ToolResult.attachments`), деградация без сервиса и при ошибке загрузки;
 * - группа правил `web` и plan-режим;
 * - «Стоп» и невалидные аргументы.
 *
 * Реальный исполнитель/браузер не нужен: роутер и порт подменены.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@itphx/synth-shared';
import type { ExecutionRouter, ExecutionPortTarget } from '../../execution/router.js';
import type {
  BrowserCallRequest,
  BrowserCallResult,
  ExecutionFs,
  ExecutionPort,
} from '../../execution/ports/index.js';
import type { AttachmentService, UploadedAttachmentMeta } from '../attachments/service.js';
import { AttachmentError } from '../attachments/service.js';
import { PERMISSION_GROUPS } from '../permission/groups.js';
import { isPlanBlockedTool } from '../permission/evaluator.js';
import {
  browserClickTool,
  browserCloseTool,
  browserNavigateTool,
  browserPressTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserTools,
  browserTypeTool,
  browserWaitTool,
} from './browser.js';

/** Порт-заглушка: запоминает browser-вызовы, отвечает по сценарию. */
class FakeBrowserPort implements ExecutionPort {
  readonly calls: BrowserCallRequest[] = [];
  /** Подмена FS пула (файл скриншота читается из контейнера браузера). */
  fs?: ExecutionFs;

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

/** Минимальный валидный PNG (сигнатура + IHDR) — для скриншота. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Ответ порта со вложением-скриншотом. */
function screenshotResult(content = ''): BrowserCallResult {
  return {
    content,
    isError: false,
    attachments: [{ dataBase64: PNG_BYTES.toString('base64'), mime: 'image/png' }],
  };
}

/** Заглушка сервиса вложений: запоминает вызовы `upload`. */
function fakeAttachmentService(
  upload?: (input: {
    sessionId?: string;
    bytes: Buffer;
    name?: string;
    declaredMime?: string;
  }) => Promise<UploadedAttachmentMeta>,
): { service: AttachmentService; uploads: Parameters<AttachmentService['upload']>[0][] } {
  const uploads: Parameters<AttachmentService['upload']>[0][] = [];
  const service = {
    async upload(input: Parameters<AttachmentService['upload']>[0]) {
      uploads.push(input);
      if (upload) return upload(input);
      return {
        id: 'attachments/ab/abcdef',
        blobPath: 'attachments/ab/abcdef',
        sha256: 'abcdef',
        mime: 'image/png',
        size: input.bytes.length,
        ...(input.name ? { name: input.name } : {}),
      };
    },
  } as unknown as AttachmentService;
  return { service, uploads };
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

  it('профиль браузерного пула берётся из extra.executionBrowserProfile', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const { router, targets } = fakeRouter(port);

    await browserNavigateTool.execute(
      { url: 'https://example.com' },
      makeCtx({ executionRouter: router, executionBrowserProfile: 'browser-full' }),
    );

    expect(targets[0]).toMatchObject({
      class: 'browser',
      profile: 'browser-full',
      projectId: 'prj_1',
      sessionId: 'ses_1',
    });
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

  it('click передаёт element и ref из snapshot', async () => {
    const port = new FakeBrowserPort(() => ok('clicked'));
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router });

    const result = await browserClickTool.execute({ element: 'Sign in button', ref: 'e12' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(port.calls).toEqual([
      { tool: 'browser_click', arguments: { element: 'Sign in button', ref: 'e12' } },
    ]);
  });

  it('type передаёт текст и submit только когда он задан', async () => {
    const port = new FakeBrowserPort(() => ok('typed'));
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router });

    await browserTypeTool.execute({ element: 'Email', ref: 'e5', text: 'a@b.c' }, ctx);
    await browserTypeTool.execute(
      { element: 'Email', ref: 'e5', text: 'a@b.c', submit: true },
      ctx,
    );

    expect(port.calls).toEqual([
      { tool: 'browser_type', arguments: { element: 'Email', ref: 'e5', text: 'a@b.c' } },
      {
        tool: 'browser_type',
        arguments: { element: 'Email', ref: 'e5', text: 'a@b.c', submit: true },
      },
    ]);
  });

  it('press уходит в `browser_press_key`', async () => {
    const port = new FakeBrowserPort(() => ok('pressed'));
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router });

    await browserPressTool.execute({ key: 'Enter' }, ctx);

    expect(port.calls).toEqual([{ tool: 'browser_press_key', arguments: { key: 'Enter' } }]);
  });

  it('wait уходит в `browser_wait_for` (время в секундах)', async () => {
    const port = new FakeBrowserPort(() => ok('waited'));
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router });

    await browserWaitTool.execute({ time: 2 }, ctx);
    await browserWaitTool.execute({ text: 'Done' }, ctx);
    await browserWaitTool.execute({ time: 1, text: 'Done' }, ctx);

    expect(port.calls).toEqual([
      { tool: 'browser_wait_for', arguments: { time: 2 } },
      { tool: 'browser_wait_for', arguments: { text: 'Done' } },
      { tool: 'browser_wait_for', arguments: { time: 1, text: 'Done' } },
    ]);
  });

  it('screenshot уходит в `browser_take_screenshot` только с fullPage/type (файл не пишется)', async () => {
    const port = new FakeBrowserPort(() => screenshotResult());
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router });

    await browserScreenshotTool.execute({}, ctx);
    await browserScreenshotTool.execute({ filename: 'page.png', fullPage: true }, ctx);
    await browserScreenshotTool.execute({ filename: 'page.jpg' }, ctx);

    expect(port.calls).toEqual([
      { tool: 'browser_take_screenshot', arguments: { type: 'png' } },
      { tool: 'browser_take_screenshot', arguments: { type: 'png', fullPage: true } },
      { tool: 'browser_take_screenshot', arguments: { type: 'jpeg' } },
    ]);
  });

  it('wait без time и text → argErrorResult, порт не вызывается', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const { router, targets } = fakeRouter(port);

    const result = await browserWaitTool.execute({}, makeCtx({ executionRouter: router }));

    expect(result.isError).toBe(true);
    expect(result.metadata).toMatchObject({ i18n: { key: 'tool.args_error' } });
    expect(port.calls).toHaveLength(0);
    expect(targets).toHaveLength(0);
  });
});

describe('browser_screenshot — вложение сообщения', () => {
  it('MCP вернул путь к файлу — читаем его через FS пула и прикрепляем', async () => {
    const port = new FakeBrowserPort(() => ({
      content: '- [Screenshot of viewport](../tmp/.playwright-mcp/page-1.png)',
      isError: false,
    }))
    const readBytes = vi.fn(async () => ({
      dataBase64: PNG_BYTES.toString('base64'),
      size: PNG_BYTES.length,
    }))
    port.fs = { readBytes } as unknown as ExecutionFs
    const { service, uploads } = fakeAttachmentService()
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service })

    const result = await browserScreenshotTool.execute({}, ctx)

    expect(readBytes).toHaveBeenCalledWith('/tmp/.playwright-mcp/page-1.png', expect.any(Number))
    expect(uploads).toHaveLength(1)
    expect(result.attachments).toHaveLength(1)
  })

  it('загружает изображение через сервис и возвращает ссылки', async () => {
    const port = new FakeBrowserPort(() => screenshotResult('Saved to page.png'));
    const { service, uploads } = fakeAttachmentService();
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service });

    const result = await browserScreenshotTool.execute({ filename: 'page.png' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      sessionId: 'ses_1',
      name: 'page.png',
      declaredMime: 'image/png',
    });
    expect(uploads[0]?.bytes.equals(PNG_BYTES)).toBe(true);
    expect(String(result.content)).toContain('Screenshot attached');
    expect(result.attachments).toEqual([
      {
        blobPath: 'attachments/ab/abcdef',
        sha256: 'abcdef',
        mime: 'image/png',
        size: PNG_BYTES.length,
        name: 'page.png',
      },
    ]);
    expect(result.metadata).toMatchObject({
      tool: 'browser_screenshot',
      blob_path: 'attachments/ab/abcdef',
      mime: 'image/png',
      size: PNG_BYTES.length,
    });
  });

  it('без имени файла берётся screenshot.png', async () => {
    const port = new FakeBrowserPort(() => screenshotResult());
    const { service, uploads } = fakeAttachmentService();
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service });

    await browserScreenshotTool.execute({}, ctx);

    expect(uploads[0]?.name).toBe('screenshot.png');
  });

  it('нет сервиса вложений → текст-предупреждение, not isError', async () => {
    const port = new FakeBrowserPort(() => screenshotResult());
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router });

    const result = await browserScreenshotTool.execute({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain('could not be attached');
    expect(result.attachments).toBeUndefined();
    expect(result.metadata).toMatchObject({ reason: 'attachment_service_unavailable' });
  });

  it('ошибка upload (AttachmentError) → предупреждение, тул не падает', async () => {
    const port = new FakeBrowserPort(() => screenshotResult());
    const { service } = fakeAttachmentService(async () => {
      throw new AttachmentError('too_large', 'Размер вложения превышает предел');
    });
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service });

    const result = await browserScreenshotTool.execute({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain('size limit');
    expect(result.attachments).toBeUndefined();
    expect(result.metadata).toMatchObject({ reason: 'too_large' });
  });

  it('произвольная ошибка upload → предупреждение, тул не падает', async () => {
    const port = new FakeBrowserPort(() => screenshotResult());
    const { service } = fakeAttachmentService(async () => {
      throw new Error('disk is full');
    });
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service });

    const result = await browserScreenshotTool.execute({}, ctx);

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain('disk is full');
    expect(result.metadata).toMatchObject({ reason: 'upload_failed' });
  });

  it('нет вложений в ответе → текст как есть', async () => {
    const port = new FakeBrowserPort(() => ok('Screenshot not saved'));
    const { service, uploads } = fakeAttachmentService();
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service });

    const result = await browserScreenshotTool.execute({}, ctx);

    expect(String(result.content)).toBe('Screenshot not saved');
    expect(result.attachments).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it('isError инструмента → вложение не публикуется', async () => {
    const port = new FakeBrowserPort(() => ({
      content: 'Screenshot failed',
      isError: true,
      attachments: [{ dataBase64: PNG_BYTES.toString('base64'), mime: 'image/png' }],
    }));
    const { service, uploads } = fakeAttachmentService();
    const ctx = makeCtx({ executionRouter: fakeRouter(port).router, attachmentService: service });

    const result = await browserScreenshotTool.execute({}, ctx);

    expect(result.isError).toBe(true);
    expect(uploads).toHaveLength(0);
    expect(result.attachments).toBeUndefined();
  });
});

describe('browser-тулы — отказы', () => {
  it('нет browserCall у порта → isError с понятным текстом', async () => {
    const { router, targets } = fakeRouter(plainPort);
    const ctx = makeCtx({ executionRouter: router });

    const result = await browserClickTool.execute({ element: 'Link', ref: 'e1' }, ctx);

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

    const result = await browserTypeTool.execute(
      { element: 'Email', ref: 'e5', text: 'x' },
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

  it('пустой url / пустой ref → argErrorResult, порт не вызывается', async () => {
    const port = new FakeBrowserPort(() => ok('ok'));
    const { router, targets } = fakeRouter(port);
    const ctx = makeCtx({ executionRouter: router });

    const badUrl = await browserNavigateTool.execute({ url: '' }, ctx);
    const badRef = await browserClickTool.execute({ element: 'Link', ref: '' }, ctx);

    expect(badUrl.isError).toBe(true);
    expect(badRef.isError).toBe(true);
    expect(badUrl.metadata).toMatchObject({ i18n: { key: 'tool.args_error' } });
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

    const result = await browserPressTool.execute(
      { key: 'Enter' },
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

    const result = await browserWaitTool.execute(
      { time: 1 },
      { ...makeCtx({ executionRouter: router }), abortSignal: controller.signal },
    );

    expect(String(result.content)).toContain('<status>stopped_by_user</status>');
    expect(result.metadata).toMatchObject({ interrupted: true, stopped_by: 'user' });
    expect(port.calls).toHaveLength(0);
  });
});

describe('browser-тулы — группа правил и plan-режим', () => {
  it('все тулы зарегистрированы и входят в группу `web`', () => {
    expect(browserTools.map((tool) => tool.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_wait',
      'browser_screenshot',
      'browser_close',
    ]);
    for (const tool of browserTools) {
      expect(tool.capabilities).toContain('web');
      expect(PERMISSION_GROUPS.web).toContain(tool.name);
    }
  });

  it('plan-режим не блокирует browser-тулы', () => {
    for (const tool of browserTools) {
      expect(isPlanBlockedTool(tool.name, tool.capabilities)).toBe(false);
    }
  });
});
