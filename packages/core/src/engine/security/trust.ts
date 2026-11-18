/**
 * Матрица доверия tool-результатов для защиты от Indirect Prompt Injection.
 *
 * untrusted: web_fetch/web_search, execute_shell, MCP, task, read_session_reference,
 * терминалы (`terminal_*`), файлы ВНЕ рабочего каталога.
 * trusted: файлы ВНУТРИ рабочего каталога, git_*, get_project_info, list_repos.
 * null (не оборачиваем): системные тулы (plan_enter, plan_exit, todo_write,
 * classify_conversation).
 */
import { ToolCapability } from '@itphx/synth-shared';
import type { CatalogTrustLevel, ToolSource } from '@itphx/synth-shared';
import { trustLevelRank } from '@itphx/synth-shared';
import { resolvePath, isInsideAnyRoot } from '../tools/path-utils.js';
import { extractPathParams } from '../permission/groups.js';
import { sanitizeTerminalAttributeValue } from '../terminal/output.js';
import type { TrustLevel } from './prompt-injection.js';

export interface ToolTrustInfo {
  trust: TrustLevel;
  source: string;
  attrs: Record<string, string>;
}

/**
 * Дополнительные сведения о туле для матрицы доверия (6-й аргумент
 * `getToolTrust`). Все поля необязательны — вызов с пятью аргументами
 * (историческая сигнатура) работает как раньше.
 */
export interface ToolTrustOptions {
  /**
   * Фактический уровень доверия установки для тула плагина
   * (`CatalogTrustLevel`: `builtin` → `verified` → `trusted` → `community`).
   * Не задан — fail-closed `untrusted`.
   */
  pluginTrust?: CatalogTrustLevel;
  /** Источник тула (`builtin`/`mcp`/`plugin`). `plugin` включает плагинную ветку. */
  toolSource?: ToolSource;
  /**
   * Метаданные для матрицы доверия.
   *
   * - `pluginName` — имя плагина-владельца (атрибут `PLUGIN` в маркере
   *   контента);
   * - атрибуты терминала (`terminal_id`, `status`, `bytes`, `run`, `exit`, …) —
   *   их кладёт тул в `metadata` результата, а конверт ставит runtime.
   */
  metadata?: Record<string, unknown>;
}

/** Уровни доверия, при которых результат плагинного тула считается `trusted`. */
const PLUGIN_TRUSTED_MAX_RANK = trustLevelRank('trusted');

/**
 * Атрибуты терминального результата, которые переносятся в открывающий маркер.
 *
 * Белый список: в `metadata` результата тула лежит много служебного (i18n,
 * внутренние seq, пути) — в маркер идёт только то, что читает модель.
 */
const TERMINAL_ATTR_KEYS = [
  'terminal_id',
  'status',
  'seq',
  'bytes',
  'tail',
  'stripped',
  'history',
  'total_bytes',
  'dropped_bytes',
  'size',
  'cursor',
  'run',
  'exit',
  'still_running',
  'timeout',
  'truncated',
  'lines',
  'cwd',
  'shell',
] as const;

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
  'project_repo_clone',
  'project_repo_init',
  'project_repo_fetch',
]);

/** Проектные тулы — доверенные (структура проекта). */
const PROJECT_TOOLS = new Set([
  'get_project_info',
  'list_repos',
  'project_update',
  'project_workspace_set',
  'project_repo_add',
  'project_repo_remove',
  // ADR-076: метаданные SSH-ключей инстанса — доверенные (реестр ключей, без
  // секретов и без недоверенного содержимого), источник `project`.
  'ssh_keys_list',
]);

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

function fileTrust(
  pathParam: string | undefined,
  workingDir: string,
  allowedRoots?: readonly string[],
): TrustLevel {
  const resolved = resolvePath(pathParam, workingDir);
  // Периметр — рабочий каталог + дополнительные корни (ADR-114: корень проекта
  // у сессии в git-worktree); путь в любом из них — доверенный.
  const roots = allowedRoots && allowedRoots.length > 0
    ? [workingDir, ...allowedRoots]
    : [workingDir];
  return isInsideAnyRoot(resolved, roots) ? 'trusted' : 'untrusted';
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
  allowedRoots?: readonly string[],
  opts?: ToolTrustOptions,
): ToolTrustInfo | null {
  if (SYSTEM_TOOLS.has(toolName)) return null;

  // ADR-090: тул плагина — доверие по **уровню установки** плагина, а не по
  // имени/пути. Ветка стоит ДО MCP: плагинный тул не может «выдать себя» за
  // MCP-инструмент, а capability `mcp` ему и так зарезервирована.
  const pluginName = typeof opts?.metadata?.pluginName === 'string'
    ? opts.metadata.pluginName
    : undefined;
  if (opts?.toolSource === 'plugin' || pluginName) {
    const level = opts?.pluginTrust;
    // fail-closed: уровень неизвестен → недоверенный контент.
    const trust: TrustLevel = level !== undefined
      && trustLevelRank(level) <= PLUGIN_TRUSTED_MAX_RANK
      ? 'trusted'
      : 'untrusted';
    return {
      trust,
      source: 'plugin',
      attrs: pluginName ? { PLUGIN: pluginName } : {},
    };
  }

  // ADR-132: интерактивный терминал — недоверенный поток (вывод чужой
  // программы: эхо файлов, вывод ssh, ответы REPL). Тул отдаёт сырой текст, а
  // атрибуты чтения/запуска — в `metadata`; конверт ставит runtime. Ветка после
  // плагинов (их доверие решает уровень установки) и до файловых/web-тулов.
  if (
    capabilities?.includes(ToolCapability.TERMINAL)
    || toolName.startsWith('terminal_')
  ) {
    const attrs: Record<string, string> = {};
    for (const key of TERMINAL_ATTR_KEYS) {
      const raw = opts?.metadata?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const value = sanitizeTerminalAttributeValue(
        typeof raw === 'string' ? raw : String(raw),
      );
      if (value === '') continue;
      attrs[key] = value;
    }
    return { trust: 'untrusted', source: 'terminal', attrs };
  }

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

  // `patch` — мультифайловая правка: все `edits[].file_path` должны быть в
  // периметре. Пустой/битый список — доверенный (нечего оборачивать).
  if (toolName === 'patch') {
    const pathStrs = extractPathParams('patch', params);
    if (pathStrs.length === 0) return { trust: 'trusted', source: 'file', attrs: {} };
    const trust: TrustLevel = pathStrs.every((p) => fileTrust(p, workingDir, allowedRoots) === 'trusted')
      ? 'trusted'
      : 'untrusted';
    return { trust, source: 'file', attrs: { PATH: pathStrs.join(', ') } };
  }

  const filePathParam = FILE_TOOLS[toolName];
  if (filePathParam) {
    const raw = params[filePathParam];
    const pathStr = typeof raw === 'string' ? raw : undefined;
    const trust = fileTrust(pathStr, workingDir, allowedRoots);
    return {
      trust,
      source: 'file',
      attrs: { PATH: pathStr ?? '' },
    };
  }

  // Неизвестный тул — не оборачиваем (безопасный дефолт)
  return null;
}
