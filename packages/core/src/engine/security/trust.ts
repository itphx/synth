/**
 * Матрица доверия tool-результатов для защиты от Indirect Prompt Injection.
 *
 * untrusted: web_fetch/web_search, execute_shell, MCP, task, read_session_reference,
 * файлы ВНЕ рабочего каталога.
 * trusted: файлы ВНУТРИ рабочего каталога, git_*, get_project_info, list_repos.
 * null (не оборачиваем): системные тулы (plan_enter, plan_exit, todo_write,
 * classify_conversation).
 */
import { ToolCapability } from '@synth/shared';
import { resolvePath } from '../tools/path-utils.js';
import { isInsideWorkingDir } from '../permission/evaluator.js';
import type { TrustLevel } from './prompt-injection.js';

export interface ToolTrustInfo {
  trust: TrustLevel;
  source: string;
  attrs: Record<string, string>;
}

/** Тулы, результаты которых не оборачиваются (системные, внутренние). */
const SYSTEM_TOOLS = new Set([
  'plan_enter',
  'plan_exit',
  'todo_write',
  'classify_conversation',
]);

/** Git-тулы — результаты доверенные (история репозитория проекта). */
const GIT_TOOLS = new Set([
  'git_status',
  'git_diff',
  'git_log',
  'git_commit',
  'git_push',
  'git_pull',
  'git_checkout',
  'git_branch_list',
  'git_show',
  'git_blame',
  'git_stash',
]);

/** Проектные тулы — доверенные (структура проекта). */
const PROJECT_TOOLS = new Set(['get_project_info', 'list_repos']);

/** Файловые тулы: trust определяется положением пути относительно workingDir. */
const FILE_TOOLS: Record<string, string> = {
  read_file: 'file_path',
  list_directory: 'path',
  glob: 'path',
  grep_files: 'path',
  write_file: 'file_path',
  edit_file: 'file_path',
  create_directory: 'path',
  delete_file: 'file_path',
};

function fileTrust(pathParam: string | undefined, workingDir: string): TrustLevel {
  const resolved = resolvePath(pathParam, workingDir);
  return isInsideWorkingDir(resolved, workingDir) ? 'trusted' : 'untrusted';
}

/**
 * Вычисляет trust-информацию для tool-результата.
 * @returns null — не оборачивать (системный тул).
 */
export function getToolTrust(
  toolName: string,
  params: Record<string, unknown>,
  workingDir: string,
  capabilities?: ToolCapability[],
): ToolTrustInfo | null {
  if (SYSTEM_TOOLS.has(toolName)) return null;

  if (toolName === 'web_fetch') {
    const url = (params.url as string | undefined)
      ?? (Array.isArray(params.urls) ? (params.urls as string[])[0] : undefined);
    return { trust: 'untrusted', source: 'web', attrs: { URL: url ?? '' } };
  }
  if (toolName === 'web_search') {
    return {
      trust: 'untrusted',
      source: 'web',
      attrs: { QUERY: (params.query as string | undefined) ?? '' },
    };
  }
  if (toolName === 'execute_shell') {
    return { trust: 'untrusted', source: 'shell', attrs: {} };
  }
  if (toolName === 'task') {
    return { trust: 'untrusted', source: 'task', attrs: {} };
  }
  if (toolName === 'read_session_reference') {
    return {
      trust: 'untrusted',
      source: 'session',
      attrs: { SESSION_ID: (params.session_id as string | undefined) ?? '' },
    };
  }

  // MCP-инструменты: регистрируются с capability ToolCapability.MCP
  if (capabilities?.includes(ToolCapability.MCP)) {
    return { trust: 'untrusted', source: 'mcp', attrs: {} };
  }

  if (GIT_TOOLS.has(toolName)) {
    return { trust: 'trusted', source: 'git', attrs: {} };
  }
  if (PROJECT_TOOLS.has(toolName)) {
    return { trust: 'trusted', source: 'project', attrs: {} };
  }

  const filePathParam = FILE_TOOLS[toolName];
  if (filePathParam) {
    const raw = params[filePathParam];
    const pathStr = typeof raw === 'string' ? raw : undefined;
    const trust = fileTrust(pathStr, workingDir);
    return {
      trust,
      source: 'file',
      attrs: { PATH: pathStr ?? '' },
    };
  }

  // Неизвестный тул — не оборачиваем (безопасный дефолт)
  return null;
}
