import { relative, resolve, isAbsolute, normalize, sep } from 'node:path';
import { globMatch } from '@synth/shared';
import type { PermissionAction, PermissionConfig, PermissionDecision, PermissionRule, PlanMode, SessionMode } from '@synth/shared';
import { resolvePath } from '../tools/path-utils.js';
import { getToolGroups, TOOL_PATH_PARAMS } from './groups.js';

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
    const { toolName, params, workingDir, capabilities, sessionMode, planMode, planApproved } = input;
    const paths = extractPaths(toolName, params, workingDir);
    const isFile = paths.length > 0;

    // AD-025: plan-рестрикция применяется поверх конфига. В режиме plan (или
    // strict без утверждённого плана) все write/edit/delete тулы → deny,
    // единственное исключение — файлы .synth/plans/*.md.
    if (isPlanRestricted(sessionMode, planMode, planApproved) && isEditTool(toolName, capabilities)) {
      if (isFile && paths.some((p) => matchPathPattern('.synth/plans/*.md', p, workingDir))) {
        return {
          action: 'allow',
          reason: 'plan mode: запись в .synth/plans/*.md разрешена',
          matchedRule: 'plan.plans',
        };
      }
      const restrictionSource = sessionMode === 'plan' ? 'режим plan' : 'strict: план не утверждён';
      return {
        action: 'deny',
        reason: `plan mode: запись файлов заблокирована (${restrictionSource})`,
        matchedRule: 'plan.deny',
      };
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
      const d = this._resolveRule(group, groupRule, isFile ? paths : [], workingDir);
      if (d) return d;
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
