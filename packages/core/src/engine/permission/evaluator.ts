import { relative, resolve, isAbsolute, normalize, sep } from 'node:path';
import { globMatch, ToolCapability } from '@itphx/synth-shared';
import type { PermissionAction, PermissionConfig, PermissionDecision, PermissionRule, PlanMode, SessionMode, McpServerToolSettings, McpToolAvailability } from '@itphx/synth-shared';
import { resolvePath } from '../tools/path-utils.js';
import { getToolGroups, TOOL_PATH_PARAMS } from './groups.js';
import { checkShellCommand, isMutatingCommand, tokenizeCommand, matchShellCommandPattern } from '../security/shell-guard.js';
import type { ShellPolicy } from '../security/shell-guard.js';

export interface PermissionCheckInput {
  toolName: string;
  params: Record<string, unknown>;
  workingDir: string;
  capabilities?: readonly string[];
  /** Текущий runtime-режим сессии (AD-025): 'plan' — только чтение. */
  sessionMode?: SessionMode;
  /** Строгость цикла Plan→Build (AD-028): auto | strict | off. */
  planMode?: PlanMode;
  /** Утверждён ли план в сессии (после plan_exit). */
  planApproved?: boolean;
  /** Доступность MCP-инструментов по режимам plan/act (serverName → настройки). */
  mcpToolSettings?: Record<string, McpServerToolSettings>;
  /** Политика безопасности execute_shell (денлист путей/команд). Опционально. */
  shellPolicy?: ShellPolicy;
}

/**
 * AD-025: активна ли рестрикция write-тулов.
 * - mode === 'plan' — сессия в режиме планирования (plan_enter).
 * - planMode === 'strict' и план не утверждён — принудительный план перед записью.
 * - planMode === 'off' — планирование отключено, рестрикция никогда не активна.
 */
export function isPlanRestricted(
  sessionMode: SessionMode | undefined,
  planMode: PlanMode | undefined,
  planApproved: boolean | undefined,
): boolean {
  if (planMode === 'off') return false;
  if (sessionMode === 'plan') return true;
  if (planMode === 'strict' && !planApproved) return true;
  return false;
}

/** Является ли тул write/edit/delete (группа edit по AD-029). */
export function isEditTool(toolName: string, capabilities?: readonly string[]): boolean {
  return getToolGroups(toolName, capabilities).includes('edit');
}

/**
 * AD-025: тулы, блокируемые в plan-режиме (и strict без утверждённого плана):
 * edit-группа (write/edit/delete файлов) + git-запись (git_commit/git_push/...).
 * Read-only git-тулы (git_status/git_diff/...) в группу не входят и остаются доступны.
 */
export function isPlanBlockedTool(toolName: string, capabilities?: readonly string[]): boolean {
  const groups = getToolGroups(toolName, capabilities);
  return groups.includes('edit') || groups.includes('git_write');
}

/**
 * Достаёт настройку доступности MCP-инструмента по имени сервера и локальному имени
 * тула (без префикса). Полное имя инструмента: "{serverName}_{toolName}".
 * Возвращает undefined, если для сервера/тула нет настроек (доступен по умолчанию).
 */
export function getMcpToolAvailability(
  settings: Record<string, McpServerToolSettings> | undefined,
  fullToolName: string,
): McpToolAvailability | undefined {
  if (!settings) return undefined;
  const idx = fullToolName.indexOf('_');
  if (idx === -1) return undefined;
  const serverName = fullToolName.slice(0, idx);
  const localName = fullToolName.slice(idx + 1);
  const server = settings[serverName];
  if (!server) return undefined;
  return server.tools?.[localName] ?? server.default;
}

/**
 * AD-029: PermissionEvaluator — вычисление решения для одного tool_call.
 *
 * Приоритет правил:
 *   1. Правило по конкретному имени тула (специфичный файловый паттерн > '*')
 *   2. external_directory (только для путей вне workingDir)
 *   3. Групповые правила (read/edit/shell/...): специфичный паттерн > '*'
 *   4. Глобальный '*'
 *   5. Дефолт: allow
 *
 * Файловые паттерны применяются к абсолютному пути файла (resolvePath) и к
 * относительному пути от workingDir (для внутренних файлов). Это позволяет
 * использовать как простые паттерны вида `*.env`, так и абсолютные `/tmp/*`.
 */
export class PermissionEvaluator {
  constructor(private readonly _config: PermissionConfig) {}

  get config(): PermissionConfig {
    return this._config;
  }

  check(input: PermissionCheckInput): PermissionDecision {
    const decision = this._computeDecision(input);

    // AD-025-yolo: в режиме yolo все ask-запросы автоматически подтверждаются
    // (allow) без события permission.asked и без ожидания пользователя.
    // deny-правила остаются deny — трансформируется только действие ask.
    if (decision.action === 'ask' && input.sessionMode === 'yolo') {
      return {
        ...decision,
        action: 'allow',
        reason: `${decision.reason} (yolo-режим: автоподтверждение)`,
      };
    }
    return decision;
  }

  private _computeDecision(input: PermissionCheckInput): PermissionDecision {
    const { toolName, params, workingDir, capabilities, sessionMode, planMode, planApproved, mcpToolSettings, shellPolicy } = input;
    const paths = extractPaths(toolName, params, workingDir);
    const isFile = paths.length > 0;

    // Командный контекст execute_shell: сама команда и каталог выполнения.
    const shellCommand = toolName === 'execute_shell' && typeof params.command === 'string'
      ? params.command
      : undefined;
    const shellCwd = toolName === 'execute_shell'
      ? (typeof params.cwd === 'string' && params.cwd.trim() !== '' ? resolvePath(params.cwd, workingDir) : workingDir)
      : workingDir;

    // AD-025: plan-рестрикция применяется поверх конфига. В режиме plan (или
    // strict без утверждённого плана) все write/edit/delete тулы и git-запись → deny.
    if (isPlanRestricted(sessionMode, planMode, planApproved) && isPlanBlockedTool(toolName, capabilities)) {
      const restrictionSource = sessionMode === 'plan' ? 'режим plan' : 'strict: план не утверждён';
      return {
        action: 'deny',
        reason: `plan mode: запись файлов заблокирована (${restrictionSource})`,
        matchedRule: 'plan.deny',
      };
    }

    // AD-025: в plan-режиме мутирующие shell-команды запрещены, read-only разрешены.
    if (shellCommand !== undefined && isPlanRestricted(sessionMode, planMode, planApproved)
      && isMutatingCommand(tokenizeCommand(shellCommand), shellCommand)) {
      return {
        action: 'deny',
        reason: 'plan mode: shell-команда изменяет состояние',
        matchedRule: 'plan.shell-deny',
      };
    }

    // Денлист shell-политики: критичный deny/ask поверх конфига (как
    // plan-рестрикция). ApprovalPaths → ask, всё остальное из политики → deny.
    if (shellCommand !== undefined && shellPolicy) {
      const sc = checkShellCommand(shellCommand, shellCwd, shellPolicy);
      if (sc.action !== 'allow') {
        return { action: sc.action, reason: sc.reason, matchedRule: sc.matchedRule };
      }
    }

    // MCP-доступность по режимам (настройки сессии): в plan-режиме инструмент
    // доступен только если plan=true, в act — act=true. Применяется поверх конфига.
    if (capabilities?.includes(ToolCapability.MCP) && mcpToolSettings) {
      const availability = getMcpToolAvailability(mcpToolSettings, toolName);
      if (availability) {
        const modeKey: keyof McpToolAvailability = sessionMode === 'plan' ? 'plan' : 'act';
        if (!availability[modeKey]) {
          return {
            action: 'deny',
            reason: `MCP-инструмент недоступен в режиме ${modeKey}`,
            matchedRule: 'mcp.mode',
          };
        }
      }
    }

    // 1. Правило по конкретному имени тула
    const toolRule = this._config.rules[toolName];
    if (toolRule !== undefined) {
      const d = this._resolveRule(toolName, toolRule, paths, workingDir);
      if (d) return d;
    }

    // 2. external_directory — только пути вне workingDir
    if (isFile) {
      const extRule = this._config.rules['external_directory'];
      if (extRule !== undefined) {
        for (const p of paths) {
          if (isInsideWorkingDir(p, workingDir)) continue;
          const d = this._resolveRule('external_directory', extRule, [p], workingDir);
          if (d) return d;
        }
      }
    }

    // 3. Групповые правила
    for (const group of getToolGroups(toolName, capabilities)) {
      const groupRule = this._config.rules[group];
      if (groupRule === undefined) continue;
      // Для execute_shell правила группы shell матчатся по КОМАНДЕ (префиксы
      // токенов), а не по cwd-пути: "npm install *" → ask, "*" → любая команда.
      if (shellCommand !== undefined && group === 'shell') {
        const d = this._resolveShellRule(group, groupRule, shellCommand, workingDir);
        if (d) return d;
      } else {
        const d = this._resolveRule(group, groupRule, isFile ? paths : [], workingDir);
        if (d) return d;
      }
    }

    // 4. Глобальный '*'
    const starRule = this._config.rules['*'];
    if (starRule !== undefined) {
      const d = this._resolveRule('*', starRule, isFile ? paths : [], workingDir);
      if (d) return d;
    }

    // 5. Дефолт: allow
    return {
      action: 'allow',
      reason: `нет правил permissions для "${toolName}" — разрешено по умолчанию`,
    };
  }

  private _resolveRule(
    key: string,
    rule: PermissionRule,
    paths: string[],
    workingDir: string,
  ): PermissionDecision | undefined {
    if (typeof rule === 'string') {
      return { action: rule, reason: `правило "${key}" → ${rule}`, matchedRule: key };
    }

    // Объект — файловые паттерны. Для тулов без путей учитываем только '*'.
    if (paths.length === 0) {
      const star = rule['*'];
      if (star) {
        return { action: star, reason: `правило "${key}.*" → ${star}`, matchedRule: `${key}.*` };
      }
      return undefined;
    }

    let starAction: PermissionAction | undefined;
    for (const [pattern, action] of Object.entries(rule)) {
      if (pattern === '*') {
        starAction = action;
        continue;
      }
      for (const p of paths) {
        if (matchPathPattern(pattern, p, workingDir)) {
          return {
            action,
            reason: `правило "${key}.${pattern}" → ${action} (путь: ${p})`,
            matchedRule: `${key}.${pattern}`,
          };
        }
      }
    }
    if (starAction) {
      return {
        action: starAction,
        reason: `правило "${key}.*" → ${starAction}`,
        matchedRule: `${key}.*`,
      };
    }
    return undefined;
  }

  /**
   * Разрешение правил группы shell для execute_shell: паттерны матчатся по
   * команде (а не по пути). Поддержан префиксный синтаксис "git commit *".
   */
  private _resolveShellRule(
    key: string,
    rule: PermissionRule,
    command: string,
    _workingDir: string,
  ): PermissionDecision | undefined {
    if (typeof rule === 'string') {
      return { action: rule, reason: `правило "${key}" → ${rule}`, matchedRule: key };
    }

    let starAction: PermissionAction | undefined;
    for (const [pattern, action] of Object.entries(rule)) {
      if (pattern === '*') {
        starAction = action;
        continue;
      }
      if (matchShellCommandPattern(pattern, command)) {
        return {
          action,
          reason: `правило "${key}.${pattern}" → ${action} (команда: ${command})`,
          matchedRule: `${key}.${pattern}`,
        };
      }
    }
    if (starAction) {
      return {
        action: starAction,
        reason: `правило "${key}.*" → ${starAction}`,
        matchedRule: `${key}.*`,
      };
    }
    return undefined;
  }
}

/** Резолвит все файловые параметры тула в абсолютные пути. */
export function extractPaths(
  toolName: string,
  params: Record<string, unknown>,
  workingDir: string,
): string[] {
  const paramNames = TOOL_PATH_PARAMS[toolName];
  if (!paramNames || paramNames.length === 0) return [];
  const result: string[] = [];
  for (const name of paramNames) {
    const value = params[name];
    if (typeof value === 'string' && value.trim() !== '') {
      result.push(resolvePath(value, workingDir));
    }
  }
  return result;
}

/** Совпадает ли путь с паттерном (абсолютный или относительный от workingDir). */
export function matchPathPattern(pattern: string, absolutePath: string, workingDir: string): boolean {
  if (globMatch(pattern, absolutePath)) return true;
  if (isInsideWorkingDir(absolutePath, workingDir)) {
    const rel = relative(workingDir, absolutePath);
    if (globMatch(pattern, rel)) return true;
  }
  return false;
}

export function isInsideWorkingDir(p: string, workingDir: string): boolean {
  const abs = isAbsolute(p) ? normalize(p) : resolve(workingDir, p);
  const dir = isAbsolute(workingDir) ? normalize(workingDir) : resolve(workingDir);
  if (abs === dir) return true;
  return abs.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}
