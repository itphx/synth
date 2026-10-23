/**
 * PROP-108 Ф1: компиляция правил permission-слоя в гранты «действие × цель».
 *
 * Таблица совместимости PROP-108 (§«Совместимость и миграция») требует:
 * «`PermissionConfig.rules` — остаётся; **компилируется в гранты «действие ×
 * цель» при чтении**». Этот модуль — именно эта компиляция.
 *
 * Компиляция **по инструменту**: берутся те же правила и в том же порядке,
 * что и в permission-слое (правило по имени тула → групповое → `'*'` →
 * дефолт `allow`), но результатом является не решение, а **гранты**. Так
 * тень остаётся независимой проверкой: она не спрашивает permission-слой о
 * решении, а пересобирает права из правил по модели Authority-слоя.
 *
 * Ограничения Ф1 (осознанные расхождения, «дефект миграции», а не ошибка
 * резолвера):
 * - правило по **имени тула** компилируется в грант «действие × вид цели» —
 *   точность «только этот тул» теряется (грант `write`/`path` покрывает и
 *   `edit_file`); смягчается тем, что deny-грант сильнее allow;
 * - file-паттерны правила переносятся в цель `path:` (тот же glob), иначе —
 *   в вид цели инструмента;
 * - оси вне правил (plan-режим, shell-политика, защищённые пути, зависимости
 *   окружения, workspace) в Ф1 не компилируются, кроме режима сессии —
 *   он попадает в **потолок сессии** (ось `session`).
 */
import type {
  AuthorityGrant,
  PermissionConfig,
  PermissionRule,
  ToolSource,
} from '@itphx/synth-shared';

import { extractPaths, matchPathPattern } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';
import { authorityActionForTool, authorityTargetKindForTool } from './actions.js';

/** Вход компиляции. */
export interface AuthorityRuleCompilationInput {
  toolName: string;
  params: Record<string, unknown>;
  workingDir: string;
  capabilities?: readonly string[];
  toolSource?: ToolSource;
  config: PermissionConfig;
}

/**
 * Гранты оси «пользователь» для конкретного инструмента.
 *
 * Пустой массив — действие/цель неизвестны (инструмент без отображения) →
 * решение будет `deny('unknown')` (fail-closed).
 */
export function compileAuthorityGrantsForTool(
  input: AuthorityRuleCompilationInput,
): AuthorityGrant[] {
  const action = authorityActionForTool(input.toolName, input.capabilities);
  const kind = authorityTargetKindForTool(input.toolName, input.capabilities, input.toolSource);
  if (action === undefined || kind === undefined) return [];

  const rules = input.config.rules ?? {};
  const paths = extractPaths(input.toolName, input.params, input.workingDir);

  // 1. Правило по конкретному имени тула.
  const toolRule = rules[input.toolName];
  if (toolRule !== undefined) {
    const grants = ruleToGrants(toolRule, action, kind, paths, input.workingDir);
    if (grants.length > 0) return grants;
  }

  // 2. Групповые правила (в порядке permission-слоя).
  for (const group of getToolGroups(input.toolName, input.capabilities, input.toolSource)) {
    const rule = rules[group];
    if (rule === undefined) continue;
    const grants = ruleToGrants(rule, action, kind, paths, input.workingDir);
    if (grants.length > 0) return grants;
  }

  // 3. Глобальное правило '*'.
  const starRule = rules['*'];
  if (starRule !== undefined) {
    const grants = ruleToGrants(starRule, action, kind, paths, input.workingDir);
    if (grants.length > 0) return grants;
  }

  // 4. Дефолт permission-слоя — allow.
  return [{ action, targetPattern: `${kind}:**`, effect: 'allow' }];
}

/**
 * Правило → гранты.
 *
 * Строковое правило — один грант на весь вид цели. Объектное правило —
 * файловые glob-паттерны: сработавший паттерн становится целью
 * `path:<паттерн>`, остальные — `вид:**` (как в permission-слое, где при
 * отсутствии совпадения работает только ключ `'*'`).
 */
function ruleToGrants(
  rule: PermissionRule,
  action: string,
  kind: string,
  paths: string[],
  workingDir: string,
): AuthorityGrant[] {
  if (typeof rule === 'string') {
    return [{ action, targetPattern: `${kind}:**`, effect: rule }];
  }

  if (paths.length === 0) {
    const star = rule['*'];
    return star ? [{ action, targetPattern: `${kind}:**`, effect: star }] : [];
  }

  let starEffect: 'allow' | 'deny' | 'ask' | undefined;
  for (const [pattern, effect] of Object.entries(rule)) {
    if (pattern === '*') {
      starEffect = effect;
      continue;
    }
    // Файловый паттерн применим только к целям вида `path`.
    if (kind !== 'path') continue;
    for (const path of paths) {
      if (matchPathPattern(pattern, path, workingDir)) {
        return [{ action, targetPattern: `path:${pattern}`, effect }];
      }
    }
  }
  if (starEffect) {
    return [{ action, targetPattern: `${kind}:**`, effect: starEffect }];
  }
  return [];
}
