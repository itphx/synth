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
} as const;

export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability];

export const TOOL_CAPABILITY_META: Record<string, { label: string; description: string }> = {
  [ToolCapability.FILE_READ]: { label: 'Чтение файлов', description: 'read_file, list_directory, glob' },
  [ToolCapability.FILE_WRITE]: { label: 'Запись файлов', description: 'write_file, edit_file, create_directory, delete_file' },
  [ToolCapability.SHELL]: { label: 'Shell-команды', description: 'execute_shell' },
  [ToolCapability.SEARCH]: { label: 'Поиск', description: 'grep_files, glob' },
  [ToolCapability.WEB]: { label: 'Веб', description: 'web_fetch, web_search' },
  [ToolCapability.GIT_READ]: { label: 'Чтение Git', description: 'git_status, git_diff, git_log, git_branch_list' },
  [ToolCapability.GIT_WRITE]: { label: 'Запись Git', description: 'git_commit, git_push, git_pull, git_checkout, etc.' },
  [ToolCapability.TASK]: { label: 'Запуск сабагентов', description: 'task' },
  [ToolCapability.MCP]: { label: 'MCP-инструменты', description: 'внешние MCP-серверы' },
  [ToolCapability.RUNTIME]: { label: 'Управление сессией', description: 'classify_conversation' },
};

export interface ToolContext {
  sessionId: string;
  messageId: string;
  abortSignal?: AbortSignal;
  agentRole?: string;
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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  capabilities: ToolCapability[];
  execute: ToolExecutor;
  jsonSchema?: Record<string, unknown>;
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
