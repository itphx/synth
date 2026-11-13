/**
 * Встроенные browser-тулы (D1): навигация, снимок страницы и закрытие браузера.
 *
 * ## Зачем встроенные тулы, а не MCP-discovery
 *
 * Браузер живёт у исполнителя (там Chromium), но модель не должна зависеть от
 * того, нашёлся ли MCP-сервер в его поде и как называются его инструменты:
 * discovery глобальный, а браузерный пул — **проектный**. Поэтому схемы тулов
 * статические (реестр ядра), а вызов уходит на порт исполнения:
 * `ExecutionPort.browserCall` → `POST /mcp/call` в пул класса `browser`
 * (адресат — MCP-сервер браузера, имя задаёт `execution.remote.browserMcpServer`).
 *
 * ## Границы D1
 *
 * Реализованы `browser_navigate`, `browser_snapshot`, `browser_close`.
 * Взаимодействие со страницей (click/type/press/wait) и скриншоты — следующий
 * слайс: схемы расширяются аддитивно, без смены транспорта.
 *
 * Отказ «браузера нет» — понятный текст, а не исключение: `inline`-режим не
 * имеет браузера вовсе (`InlineExecutionPort` не реализует `browserCall`).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import { resolveExecutionPort, resolveExecutionRouter } from '../../execution/tool-port.js';
import type { ExecutionPort } from '../../execution/ports/index.js';
import { abortedResult, isAborted } from './abort.js';
import { argErrorResult } from './arg-error.js';

/** Текст отказа, когда порт не умеет browser-вызов (inline/старая реализация). */
export const BROWSER_UNAVAILABLE_TEXT =
  'Browser execution is unavailable in the current execution environment.';

/** Имя параметра extra с относительным путём рабочего каталога в PVC. */
interface BrowserToolExtra {
  executionWorkspaceSubPath?: string;
}

/** Порт для browser-вызова: пул класса `browser` либо порт сессии. */
function browserPort(ctx: ToolContext): ExecutionPort {
  const router = resolveExecutionRouter(ctx);
  if (!router) return resolveExecutionPort(ctx);
  return router.portFor({
    // Browser-пул — **проектный** (изоляция cookies), профиль — свой
    // (`execution.remote.browserProfile`), а не профиль обычных команд.
    class: 'browser',
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    workspaceSubPath: (ctx.extra as BrowserToolExtra | undefined)?.executionWorkspaceSubPath,
  });
}

/**
 * Один вызов browser-инструмента: порт → `browserCall` → результат тула.
 *
 * Ошибки не бросаются: недоступность браузера и ошибка инструмента — это
 * `isError`-результат, ход продолжается.
 */
async function callBrowserTool(
  ctx: ToolContext,
  toolName: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let port: ExecutionPort;
  try {
    port = browserPort(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Browser execution is unavailable: ${message}`,
      isError: true,
      metadata: { tool: toolName },
    };
  }

  if (!port.browserCall) {
    return { content: BROWSER_UNAVAILABLE_TEXT, isError: true, metadata: { tool: toolName } };
  }

  try {
    const result = await port.browserCall({ tool, arguments: args });
    return {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
      // D1: байты вложений не публикуются (следующий слайс — скриншоты).
      metadata: { tool: toolName },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `Browser tool "${toolName}" failed: ${message}`,
      isError: true,
      metadata: { tool: toolName },
    };
  }
}

const navigateSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe('Absolute URL to open (for example https://example.com)'),
});

const emptySchema = z.object({});

export const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description:
    'Open a URL in the project browser — a shared headless browser isolated per project. '
    + 'Cookies and the current page are kept between calls within the project. '
    + 'Returns the tool output as text; call browser_snapshot to read the page structure '
    + 'before deciding what to do next.',
  parameters: navigateSchema,
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = navigateSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    return callBrowserTool(ctx, this.name, 'browser_navigate', { url: parsed.data.url });
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  description:
    'Return an accessibility snapshot of the current page in the project browser: '
    + 'structured text with element roles, names and visible text. '
    + 'Use it to inspect the page (links, buttons, fields) before deciding what to do next. '
    + 'The browser keeps its state between calls.',
  parameters: emptySchema,
  capabilities: [ToolCapability.WEB],
  async execute(_args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    return callBrowserTool(ctx, this.name, 'browser_snapshot', {});
  },
};

export const browserCloseTool: ToolDefinition = {
  name: 'browser_close',
  description:
    'Close the project browser page and release its resources. '
    + 'Call it when the browser is no longer needed; the next browser call starts a fresh page.',
  parameters: emptySchema,
  capabilities: [ToolCapability.WEB],
  async execute(_args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    return callBrowserTool(ctx, this.name, 'browser_close', {});
  },
};

/** Все browser-тулы слайса D1. */
export const browserTools: ToolDefinition[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserCloseTool,
];
