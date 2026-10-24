import type { z } from 'zod';

export const ToolCapability = {
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  SHELL: 'shell',
  SEARCH: 'search',
  WEB: 'web',
  GIT_READ: 'git_read',
  GIT_WRITE: 'git_write',
  TASK: 'task',
  MCP: 'mcp',
  RUNTIME: 'runtime',
  USER: 'user',
  /**
   * Память (ADR-107, PROP-047): тулы плагина памяти (`memory_search`/
   * `memory_write`/`memory_forget`).
   *
   * Отдельная capability, а не `search`/`file_write`: память работает **всегда** —
   * она не привязана к рабочему каталогу проекта (`WORKSPACE_CAPABILITIES`),
   * поэтому в сессии без `project.workspace` тулы памяти остаются доступны.
   */
  MEMORY: 'memory',
} as const;

export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability];

export const TOOL_CAPABILITY_META: Record<string, { label: string; description: string }> = {
  [ToolCapability.FILE_READ]: { label: 'Чтение файлов', description: 'read_file, list_directory, glob' },
  [ToolCapability.FILE_WRITE]: { label: 'Запись файлов', description: 'write_file, edit_file, create_directory, delete_file' },
  [ToolCapability.SHELL]: { label: 'Shell-команды', description: 'execute_shell' },
  [ToolCapability.SEARCH]: { label: 'Поиск', description: 'grep_files, glob' },
  [ToolCapability.WEB]: { label: 'Веб', description: 'web_fetch, web_search' },
  [ToolCapability.GIT_READ]: { label: 'Чтение Git', description: 'git_status, git_diff, git_log, git_branch_list, git_show, git_blame' },
  [ToolCapability.GIT_WRITE]: { label: 'Запись Git', description: 'git_commit, git_push, git_pull, git_checkout, etc.' },
  [ToolCapability.TASK]: { label: 'Запуск сабагентов', description: 'task' },
  [ToolCapability.MCP]: { label: 'MCP-инструменты', description: 'внешние MCP-серверы' },
  [ToolCapability.RUNTIME]: { label: 'Управление сессией', description: 'classify_conversation' },
  [ToolCapability.USER]: { label: 'Работа с пользователем', description: 'profile_update' },
  [ToolCapability.MEMORY]: { label: 'Память', description: 'memory_search, memory_write, memory_forget' },
};

export interface ToolContext {
  sessionId: string;
  messageId: string;
  abortSignal?: AbortSignal;
  agentRole?: string;
  /**
   * Проект сессии — метаданные хода, а не internals ядра.
   *
   * Нужен плагину, который сужает контекст (ADR-107): без него плагинный тул
   * не знает, чей это проект, и не может ограничить себя его данными.
   */
  projectId?: string;
  workingDir: string;
  dataDir?: string;
  extra?: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export type ToolExecutor = (params: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * ADR-071 §2.1 + ADR-090: источник инструмента.
 *
 * - `builtin` — встроенный (слой `tools`, `stable`);
 * - `mcp` — инструмент MCP-сервера (слой `mcp.tools`, `volatile`);
 * - `plugin` — инструмент, зарегистрированный плагином через
 *   `PluginFacade.registerTool` (ADR-090, Ф3в): в промпте идёт после
 *   встроенных (вне stable-префикса — плагин можно снять в runtime).
 *
 * Для встроенных проставляется по умолчанию в `ToolRegistry.register`.
 */
export type ToolSource = 'builtin' | 'mcp' | 'plugin';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  capabilities: ToolCapability[];
  execute: ToolExecutor;
  jsonSchema?: Record<string, unknown>;
  /** ADR-071 §2.1: источник инструмента (builtin/mcp/plugin). */
  source?: ToolSource;
  /** ADR-071 §2.1: имя MCP-сервера для `source: 'mcp'`. */
  mcpServer?: string;
  /**
   * ADR-090: имя плагина-владельца для `source: 'plugin'`.
   *
   * Имя тула в реестре — с namespace (`plugin_<plugin>_<tool>`,
   * `pluginToolFullName`), локальное имя хранится только здесь и в манифесте
   * (`provides.tools[]`).
   */
  pluginName?: string;
}

export interface ToolForLLM {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface PendingToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  startedAt: string;
}

export interface CompletedToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  startedAt: string;
  completedAt: string;
}
