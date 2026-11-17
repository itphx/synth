/**
 * Встроенные browser-тулы (D1/D2): навигация, снимок страницы, взаимодействие
 * со страницей, скриншот и закрытие браузера.
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
 * ## Границы слайсов
 *
 * D1: `browser_navigate`, `browser_snapshot`, `browser_close`.
 * D2: `browser_click`, `browser_type`, `browser_press`, `browser_wait`,
 * `browser_screenshot` (изображение публикуется **вложением** сообщения:
 * байты пишет `AttachmentService`, тул возвращает ссылки).
 *
 * Отказ «браузера нет» — понятный текст, а не исключение: `inline`-режим не
 * имеет браузера вовсе (`InlineExecutionPort` не реализует `browserCall`).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type {
  ToolAttachmentRef,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@itphx/synth-shared';
import { resolveExecutionPort, resolveExecutionRouter } from '../../execution/tool-port.js';
import type { BrowserCallResult, ExecutionPort } from '../../execution/ports/index.js';
import { AttachmentError, type AttachmentService } from '../attachments/service.js';
import { warning } from '../../logger.js';
import { abortedResult, isAborted } from './abort.js';
import { argErrorResult } from './arg-error.js';
import { TIMEOUT_FG_MAX_SEC } from '../timeout.js';

/** Текст отказа, когда порт не умеет browser-вызов (inline/старая реализация). */
export const BROWSER_UNAVAILABLE_TEXT =
  'Browser execution is unavailable in the current execution environment.';

/** Имя файла скриншота по умолчанию (имя видит модель и пользователь). */
const DEFAULT_SCREENSHOT_NAME = 'screenshot.png';

/** Параметры extra, которые нужны browser-тулам. */
interface BrowserToolExtra {
  /** Относительный путь рабочего каталога в PVC (область браузерного пула). */
  executionWorkspaceSubPath?: string;
  /**
   * PROP-135 (браузерный контур): эффективный браузерный профиль хода
   * (сессия → агент → проект → инстанс-дефолт), вычислен оркестратором.
   */
  executionBrowserProfile?: string;
  /** Сервис вложений (ADR-115): единственная точка записи байтов скриншота. */
  attachmentService?: AttachmentService;
}

/** Порт для browser-вызова: пул класса `browser` либо порт сессии. */
function browserPort(ctx: ToolContext): ExecutionPort {
  const router = resolveExecutionRouter(ctx);
  if (!router) return resolveExecutionPort(ctx);
  const extra = ctx.extra as BrowserToolExtra | undefined;
  return router.portFor({
    // Browser-пул — **проектный** (изоляция cookies), профиль — свой
    // (`execution.remote.browserProfile`), а не профиль обычных команд.
    class: 'browser',
    // PROP-135 (браузерный контур): профиль вычислил binding хода; не задан —
    // роутер подставит `execution.remote.browserProfile` (прежнее поведение).
    ...(extra?.executionBrowserProfile ? { profile: extra.executionBrowserProfile } : {}),
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    workspaceSubPath: extra?.executionWorkspaceSubPath,
  });
}

/**
 * Исход одного вызова browser-инструмента: либо ответ порта, либо готовый
 * результат-отказ (тул такой исход возвращает как есть).
 */
interface BrowserCallOutcome {
  result?: BrowserCallResult;
  failure?: ToolResult;
  /** Порт, которым выполнен вызов (нужен скриншоту: файл лежит в контейнере браузера). */
  port?: ExecutionPort;
}

/**
 * Один вызов browser-инструмента: порт → `browserCall`.
 *
 * Ошибки не бросаются: недоступность браузера и ошибка инструмента — это
 * `failure`/`isError`-результат, ход продолжается.
 *
 * @param timeoutMs таймаут одного вызова, мс (параметр `timeout` тула);
 *                  не задан — таймаут инстанса (`execution.remote.browserTimeoutMs`)
 */
async function invokeBrowserTool(
  ctx: ToolContext,
  toolName: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<BrowserCallOutcome> {
  let port: ExecutionPort;
  try {
    port = browserPort(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      failure: {
        content: `Browser execution is unavailable: ${message}`,
        isError: true,
        metadata: { tool: toolName },
      },
    };
  }

  if (!port.browserCall) {
    return {
      failure: { content: BROWSER_UNAVAILABLE_TEXT, isError: true, metadata: { tool: toolName } },
    };
  }

  try {
    return {
      result: await port.browserCall({
        tool,
        arguments: args,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
      port,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      failure: {
        content: `Browser tool "${toolName}" failed: ${message}`,
        isError: true,
        metadata: { tool: toolName },
      },
    };
  }
}

/** Текстовый результат вызова (тулы без вложений). */
async function callBrowserTool(
  ctx: ToolContext,
  toolName: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<ToolResult> {
  const outcome = await invokeBrowserTool(ctx, toolName, tool, args, timeoutMs);
  if (outcome.failure) return outcome.failure;
  const result = outcome.result as BrowserCallResult;
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
    metadata: { tool: toolName },
  };
}

/** Понятный текст причины отказа загрузки вложения (по машинному коду). */
const ATTACHMENT_FAILURE_TEXT: Record<string, string> = {
  too_large: 'the image exceeds the attachment size limit',
  unsupported_mime: 'the image type is not allowed by the attachment policy',
  attachments_disabled: 'attachments are disabled on this instance',
  empty: 'the image is empty',
};

/**
 * Предупреждение вместо вложения: скриншот снят, но приложить его не удалось.
 *
 * `isError` **не** ставится — инструмент выполнен, потеряно только вложение
 * (модель видит причину и может перейти к текстовому результату).
 */
function screenshotWarning(
  toolName: string,
  content: string,
  reason: string,
  detail?: string,
): ToolResult {
  const text = detail
    ? `Screenshot captured, but it could not be attached: ${detail}`
    : 'Screenshot captured, but it could not be attached to the dialog.';
  const body = content.trim();
  return {
    content: body ? `${text}\n\n${body}` : text,
    metadata: { tool: toolName, reason, ...(detail ? { detail } : {}) },
  };
}

/**
 * Результат `browser_screenshot`: изображения из ответа публикуются вложением
 * сообщения (ссылки `ToolResult.attachments`), байты пишет `AttachmentService`.
 *
 * Деградация (никогда не роняет шаг):
 * - нет `attachmentService` — текст-предупреждение (скриншот снят, но не приложен);
 * - ошибка `upload`/лимит — предупреждение с причиной;
 * - в ответе нет вложений — текст результата как есть.
 */
/** Лимит чтения файла скриншота из контейнера браузера (20 МиБ). */
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

/**
 * Достать изображение, которое Playwright MCP сохранил в контейнере браузера.
 *
 * MCP возвращает текстовую ссылку (`../tmp/.playwright-mcp/page-….png`);
 * файл читается через `ExecutionFs` того же пула (тот же контейнер).
 */
async function readScreenshotFile(
  port: ExecutionPort,
  content: string,
): Promise<{ dataBase64: string; mime: string }[]> {
  const match = /(?:\.\.\/)?tmp\/\.playwright-mcp\/[^\s)"'`]+\.(?:png|jpe?g|webp)/i.exec(content);
  if (!match) return [];
  const raw = match[0]!;
  const abs = raw.startsWith('/') ? raw : `/${raw.replace(/^\.\.\//, '')}`;
  const mime = /\.jpe?g$/i.test(abs) ? 'image/jpeg' : /\.webp$/i.test(abs) ? 'image/webp' : 'image/png';
  try {
    const bytes = await port.fs!.readBytes(abs, MAX_SCREENSHOT_BYTES);
    return bytes.dataBase64 ? [{ dataBase64: bytes.dataBase64, mime }] : [];
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warning('BROWSER', `"browser_screenshot": не удалось прочитать ${abs}: ${detail}`);
    return [];
  }
}

async function callBrowserScreenshot(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  attachmentName?: string,
  timeoutMs?: number,
): Promise<ToolResult> {
  const outcome = await invokeBrowserTool(ctx, toolName, 'browser_take_screenshot', args, timeoutMs);
  if (outcome.failure) return outcome.failure;
  const result = outcome.result as BrowserCallResult;
  let payloads = result.isError ? [] : (result.attachments ?? []);
  // Playwright MCP этой версии всегда пишет файл в `/tmp/.playwright-mcp` и
  // возвращает текстовую ссылку (image-блок не отдаёт). Читаем файл через FS
  // того же пула — байты попадут вложение, а не останутся в контейнере.
  if (payloads.length === 0 && !result.isError && outcome.port?.fs) {
    payloads = await readScreenshotFile(outcome.port, result.content);
  }
  if (payloads.length === 0) {
    return {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
      metadata: { tool: toolName },
    };
  }

  const service = (ctx.extra as BrowserToolExtra | undefined)?.attachmentService;
  if (!service) {
    return screenshotWarning(
      toolName,
      result.content,
      'attachment_service_unavailable',
      'attachments are unavailable in this environment',
    );
  }

  const name = attachmentName?.trim()
    || (typeof args.filename === 'string' && args.filename.trim())
    || DEFAULT_SCREENSHOT_NAME;
  const refs: ToolAttachmentRef[] = [];
  for (const payload of payloads) {
    try {
      const bytes = Buffer.from(payload.dataBase64, 'base64');
      if (bytes.length === 0) {
        warning('BROWSER', `"${toolName}": пустое вложение ${payload.mime} пропущено`);
        continue;
      }
      // Лимиты/allowlist/MIME — политика сервиса (второй не заводим).
      const meta = await service.upload({
        sessionId: ctx.sessionId,
        bytes,
        declaredMime: payload.mime,
        name,
      });
      refs.push({
        blobPath: meta.blobPath,
        sha256: meta.sha256,
        mime: meta.mime,
        size: meta.size,
        ...(meta.name ? { name: meta.name } : {}),
      });
    } catch (err) {
      if (err instanceof AttachmentError) {
        return screenshotWarning(
          toolName,
          result.content,
          err.code,
          ATTACHMENT_FAILURE_TEXT[err.code] ?? err.message,
        );
      }
      const detail = err instanceof Error ? err.message : String(err);
      warning('BROWSER', `"${toolName}": скриншот не сохранён: ${detail}`);
      return screenshotWarning(toolName, result.content, 'upload_failed', detail);
    }
  }

  const first = refs[0];
  if (!first) {
    return screenshotWarning(
      toolName,
      result.content,
      'upload_failed',
      'the screenshot image was empty',
    );
  }
  const body = result.content.trim();
  return {
    content: body ? `Screenshot attached\n\n${body}` : 'Screenshot attached',
    metadata: {
      tool: toolName,
      mime: first.mime,
      size: first.size,
      blob_path: first.blobPath,
    },
    attachments: refs,
  };
}

/**
 * Параметр `timeout` — таймаут одного вызова браузерного инструмента, **секунды**.
 *
 * Перекрывает таймаут инстанса (`execution.remote.browserTimeoutMs`, дефолт 120 с);
 * потолок — 600 с (`MAX_EXECUTION_BROWSER_TIMEOUT_MS` в `@itphx/synth-shared`).
 */
const timeoutParam = z
  .number()
  .int()
  .min(1)
  .max(TIMEOUT_FG_MAX_SEC)
  .optional()
  .describe(
    'Timeout in seconds for this call (default: instance settings, usually 120; max 600)',
  );

/**
 * Таймаут вызова: **секунды** (входной параметр тула) → миллисекунды
 * (внутренний контракт `BrowserCallRequest.timeoutMs`).
 */
function timeoutMsOf(timeoutSec: number | undefined): number | undefined {
  return timeoutSec !== undefined ? timeoutSec * 1000 : undefined;
}

const navigateSchema = z.object({
  url: z
    .string()
    .min(1)
    .describe('Absolute URL to open (for example https://example.com)'),
  timeout: timeoutParam,
});

const emptySchema = z.object({});

const clickSchema = z.object({
  element: z
    .string()
    .min(1)
    .describe('Human-readable description of the element to click (for example "Sign in button")'),
  ref: z
    .string()
    .min(1)
    .describe('Element reference from the latest browser_snapshot (for example "e12")'),
});

const typeSchema = z.object({
  element: z
    .string()
    .min(1)
    .describe('Human-readable description of the input field (for example "Email field")'),
  ref: z
    .string()
    .min(1)
    .describe('Element reference from the latest browser_snapshot (for example "e5")'),
  text: z.string().describe('Text to type into the field'),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter after typing (default false)'),
});

const pressSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe('Key to press, for example "Enter", "Escape", "Tab" or "Control+A"'),
});

const waitSchema = z
  .object({
    time: z
      .number()
      .min(0)
      .optional()
      .describe('Seconds to wait (for example 2)'),
    text: z
      .string()
      .min(1)
      .optional()
      .describe('Wait until this text appears on the page'),
    timeout: timeoutParam,
  })
  .refine((value) => value.time !== undefined || value.text !== undefined, {
    message: 'either "time" (seconds) or "text" is required',
  });

const screenshotSchema = z.object({
  filename: z
    .string()
    .optional()
    .describe(
      'Attachment name for the image in the dialog (default screenshot.png; .jpg/.jpeg means JPEG). '
      + 'The image is returned to the dialog, never written to a file.',
    ),
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture the whole scrollable page instead of the viewport (default false)'),
  timeout: timeoutParam,
});

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
    return callBrowserTool(
      ctx,
      this.name,
      'browser_navigate',
      { url: parsed.data.url },
      timeoutMsOf(parsed.data.timeout),
    );
  },
};

export const browserSnapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  description:
    'Return an accessibility snapshot of the current page in the project browser: '
    + 'structured text with element roles, names and visible text. '
    + 'Use it to inspect the page (links, buttons, fields) and to get element references '
    + 'for browser_click and browser_type before deciding what to do next. '
    + 'The browser keeps its state between calls.',
  parameters: emptySchema,
  capabilities: [ToolCapability.WEB],
  async execute(_args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    return callBrowserTool(ctx, this.name, 'browser_snapshot', {});
  },
};

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  description:
    'Click an element on the current page in the project browser. '
    + 'Pass the element reference ("ref") from the latest browser_snapshot and a short '
    + 'human-readable description of the element. Call browser_snapshot again to see '
    + 'the result of the click.',
  parameters: clickSchema,
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = clickSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    return callBrowserTool(ctx, this.name, 'browser_click', {
      element: parsed.data.element,
      ref: parsed.data.ref,
    });
  },
};

export const browserTypeTool: ToolDefinition = {
  name: 'browser_type',
  description:
    'Type text into an input field on the current page in the project browser. '
    + 'Pass the element reference ("ref") from the latest browser_snapshot and a short '
    + 'human-readable description of the field. Set "submit" to press Enter after typing. '
    + 'Call browser_snapshot again to verify the result.',
  parameters: typeSchema,
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = typeSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    return callBrowserTool(ctx, this.name, 'browser_type', {
      element: parsed.data.element,
      ref: parsed.data.ref,
      text: parsed.data.text,
      ...(parsed.data.submit !== undefined ? { submit: parsed.data.submit } : {}),
    });
  },
};

export const browserPressTool: ToolDefinition = {
  name: 'browser_press',
  description:
    'Press a keyboard key on the current page in the project browser (for example Enter, '
    + 'Escape, Tab, ArrowDown, Control+A). Use it to submit forms, dismiss dialogs or move '
    + 'focus. Call browser_snapshot to see the result.',
  parameters: pressSchema,
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = pressSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    return callBrowserTool(ctx, this.name, 'browser_press_key', { key: parsed.data.key });
  },
};

export const browserWaitTool: ToolDefinition = {
  name: 'browser_wait',
  description:
    'Wait on the current page in the project browser: either a fixed number of seconds '
    + '("time") or until the given "text" appears. At least one of them is required. '
    + 'Use it after actions that trigger network requests or animations. '
    + 'Call browser_snapshot to see the page after the wait.',
  parameters: waitSchema,
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = waitSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    return callBrowserTool(
      ctx,
      this.name,
      'browser_wait_for',
      {
        ...(parsed.data.time !== undefined ? { time: parsed.data.time } : {}),
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
      },
      timeoutMsOf(parsed.data.timeout),
    );
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description:
    'Take a screenshot of the current page in the project browser and attach the image to '
    + 'the dialog, so you and the user can see it. By default the viewport is captured; set '
    + '"fullPage" to capture the whole scrollable page. The image format is PNG unless the '
    + 'attachment name ends with .jpg or .jpeg. The image is never written to a file: do not '
    + 'pass disk paths.',
  parameters: screenshotSchema,
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx): Promise<ToolResult> {
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = screenshotSchema.safeParse(args);
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const filename = parsed.data.filename?.trim();
    const type = filename && /\.jpe?g$/i.test(filename) ? 'jpeg' : 'png';
    // `filename` — только имя вложения в диалоге: в MCP его не передаём, иначе
    // Playwright сохраняет файл внутри контейнера браузера и изображение не
    // возвращается (байты не попадают в сообщение).
    return callBrowserScreenshot(
      ctx,
      this.name,
      {
        type,
        ...(parsed.data.fullPage !== undefined ? { fullPage: parsed.data.fullPage } : {}),
      },
      filename,
      timeoutMsOf(parsed.data.timeout),
    );
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

/** Все browser-тулы (D1 + D2). */
export const browserTools: ToolDefinition[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserPressTool,
  browserWaitTool,
  browserScreenshotTool,
  browserCloseTool,
];
