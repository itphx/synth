/**
 * PROP-108 Ф1/Ф2: компиляция правил permission-слоя в гранты «действие × цель».
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
 * Ф2 — два расхождения Ф1 закрыты **в компиляции и в выводе цели**, а не
 * подгонкой политики (PROP-108 §«Совместимость и миграция»: «Расхождение
 * shadow-решения с текущим — дефект миграции, а не повод «подкрутить»
 * политику»):
 *
 * 1. **Правило группы `shell` по команде.** В permission-слое объектное правило
 *    группы `shell` матчится по **тексту команды** (`npm install *`), а не по
 *    пути. Компиляция переносит этот матчинг: команда сопоставляется тем же
 *    матчером (`matchShellCommandPattern`), а грант — «действие `execute` ×
 *    цель `workspace`» (текст команды целью **не является**, PROP-108
 *    §«Инварианты модели», п. 2).
 * 2. **Цель вне workspace.** Путь вне рабочего каталога выражается
 *    **отдельным видом цели** `outside:` (PROP-108 Ф2) — с неразличимой
 *    ссылкой (хэш пути) и сопоставлением по абсолютному пути (`altRefs`).
 *    Правило `external_directory` и его fail-closed дефолт (`ask`) относятся к
 *    таким целям; раньше цель была «неизвестной» → `deny('unknown')`, что и
 *    было задокументированным расхождением Ф1.
 *
 * Режим сессии (`yolo`) учитывается: гранты оси «пользователь» (правила
 * сессии) в `yolo` не поднимают `ask` — `ask` → `allow`. Требование
 * подтверждения от **потолка сессии** (внешний каталог) при этом сохраняется:
 * потолок строит guard (`engine/authority/guard.ts`), а не компиляция.
 */
import type {
  AuthorityGrant,
  PermissionConfig,
  PermissionRule,
  SessionMode,
  ToolSource,
} from '@itphx/synth-shared';

import { extractPaths, isInsideWorkingDir, matchPathPattern } from '../permission/evaluator.js';
import { getToolGroups } from '../permission/groups.js';
import { matchShellCommandPattern } from '../security/shell-guard.js';
import { authorityActionForTool, authorityTargetKindForTool } from './actions.js';
import { resolveAuthorityPathTarget } from './target.js';

/** Вход компиляции. */
export interface AuthorityRuleCompilationInput {
  toolName: string;
  params: Record<string, unknown>;
  workingDir: string;
  capabilities?: readonly string[];
  toolSource?: ToolSource;
  config: PermissionConfig;
  /**
   * Режим сессии (ADR-025). В `yolo` правила сессии не поднимают `ask`:
   * грант оси «пользователь» становится `allow`. Потолок сессии при этом
   * сохраняет свои требования (см. `engine/authority/guard.ts`).
   */
  sessionMode?: SessionMode;
}

/** Виды цели, к которым применимы файловые glob-паттерны правил. */
function isFileTargetKind(kind: string): boolean {
  return kind === 'path' || kind === 'outside' || kind === 'workspace';
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
  const baseKind = authorityTargetKindForTool(input.toolName, input.capabilities, input.toolSource);
  if (action === undefined || baseKind === undefined) return [];

  const rules = input.config.rules ?? {};
  const paths = extractPaths(input.toolName, input.params, input.workingDir);
  const liftAsk = input.sessionMode === 'yolo';
  // Вид цели: файловый тул — `path` (внутри рабочего каталога) или `outside`
  // (вне его); прочие тулы — `workspace`/`session`/`external`/`mcp`.
  const kind = resolveTargetKind(input, baseKind);

  // 1. Правило по конкретному имени тула.
  const toolRule = rules[input.toolName];
  if (toolRule !== undefined) {
    const grants = ruleToGrants(toolRule, action, kind, paths, input.workingDir, liftAsk);
    if (grants.length > 0) return grants;
  }

  // 2. external_directory — только для путей вне рабочего каталога.
  //
  // Порядок permission-слоя (ADR-029/ADR-075): правило по имени тула → правило
  // `external_directory` → fail-closed дефолт (`ask`; в plan-режиме — `deny`).
  // Групповые правила и `'*'` для внешних путей **не** применяются — так же,
  // как в permission-слое.
  if (hasOutsidePath(paths, input.workingDir)) {
    const extRule = rules['external_directory'];
    if (extRule !== undefined) {
      const grants = ruleToGrants(extRule, action, kind, paths, input.workingDir, liftAsk);
      if (grants.length > 0) return grants;
    }
    // Дефолт permission-слоя — `ask` (fail-closed). В `yolo` правило сессии его
    // не поднимает, но потолок сессии сохраняет требование подтверждения.
    return [{ action, targetPattern: `${kind}:**`, effect: liftAsk ? 'allow' : 'ask' }];
  }

  // 3. Групповые правила (в порядке permission-слоя).
  for (const group of getToolGroups(input.toolName, input.capabilities, input.toolSource)) {
    const rule = rules[group];
    if (rule === undefined) continue;
    // Для execute_shell правило группы `shell` матчится по КОМАНДЕ
    // (префиксы токенов), а не по cwd-пути: «npm install *» → ask.
    if (input.toolName === 'execute_shell' && group === 'shell') {
      const grants = shellRuleToGrants(rule, action, kind, input.params, liftAsk);
      if (grants.length > 0) return grants;
    } else {
      const grants = ruleToGrants(rule, action, kind, paths, input.workingDir, liftAsk);
      if (grants.length > 0) return grants;
    }
  }

  // 4. Глобальное правило '*'.
  const starRule = rules['*'];
  if (starRule !== undefined) {
    const grants = ruleToGrants(starRule, action, kind, paths, input.workingDir, liftAsk);
    if (grants.length > 0) return grants;
  }

  // 5. Дефолт permission-слоя — allow.
  return [{ action, targetPattern: `${kind}:**`, effect: 'allow' }];
}

/**
 * Вид цели вызова: файловый тул — `path`/`outside`, остальные — как есть.
 *
 * Совпадает с выводом цели (`deriveAuthorityTarget`) — иначе грант не покроет
 * цель и решение станет `deny('no_grant')`.
 */
function resolveTargetKind(
  input: AuthorityRuleCompilationInput,
  baseKind: string,
): string {
  if (baseKind !== 'path') return baseKind;
  const resolved = resolveAuthorityPathTarget(input.toolName, input.params, input.workingDir);
  return resolved?.kind ?? baseKind;
}

/** Есть ли у вызова путь вне рабочего каталога. */
function hasOutsidePath(paths: string[], workingDir: string): boolean {
  return paths.some((p) => !isInsideWorkingDir(p, workingDir));
}

/**
 * Правило → гранты.
 *
 * Строковое правило — один грант на весь вид цели. Объектное правило —
 * файловые glob-паттерны: сработавший паттерн становится целью
 * `<вид>:<паттерн>`, остальные — `<вид>:**` (как в permission-слое, где при
 * отсутствии совпадения работает только ключ `'*'`).
 *
 * `liftAsk` — режим `yolo`: `ask` из правил сессии поднимается до `allow`
 * (ось «пользователь»); требования потолка сессии при этом сохраняются.
 */
function ruleToGrants(
  rule: PermissionRule,
  action: string,
  kind: string,
  paths: string[],
  workingDir: string,
  liftAsk: boolean,
): AuthorityGrant[] {
  if (typeof rule === 'string') {
    return [{ action, targetPattern: `${kind}:**`, effect: liftEffect(rule, liftAsk) }];
  }

  if (paths.length === 0) {
    const star = rule['*'];
    return star ? [{ action, targetPattern: `${kind}:**`, effect: liftEffect(star, liftAsk) }] : [];
  }

  let starEffect: 'allow' | 'deny' | 'ask' | undefined;
  for (const [pattern, effect] of Object.entries(rule)) {
    if (pattern === '*') {
      starEffect = effect;
      continue;
    }
    // Файловый паттерн применим только к файловым видам цели.
    if (!isFileTargetKind(kind)) continue;
    for (const path of paths) {
      if (matchPathPattern(pattern, path, workingDir)) {
        return [
          { action, targetPattern: `${kind}:${pattern}`, effect: liftEffect(effect, liftAsk) },
        ];
      }
    }
  }
  if (starEffect) {
    return [{ action, targetPattern: `${kind}:**`, effect: liftEffect(starEffect, liftAsk) }];
  }
  return [];
}

/**
 * Правило группы `shell` → гранты (PROP-108 Ф2, расхождение №1).
 *
 * Матчинг — по **тексту команды** (тем же матчером, что и permission-слой:
 * `matchShellCommandPattern`), а грант — «действие × рабочая область»: текст
 * команды целью не является (PROP-108 §«Инварианты модели», п. 2).
 */
function shellRuleToGrants(
  rule: PermissionRule,
  action: string,
  kind: string,
  params: Record<string, unknown>,
  liftAsk: boolean,
): AuthorityGrant[] {
  const command = typeof params.command === 'string' ? params.command : undefined;
  if (command === undefined) return [];

  if (typeof rule === 'string') {
    return [{ action, targetPattern: `${kind}:**`, effect: liftEffect(rule, liftAsk) }];
  }

  let starEffect: 'allow' | 'deny' | 'ask' | undefined;
  for (const [pattern, effect] of Object.entries(rule)) {
    if (pattern === '*') {
      starEffect = effect;
      continue;
    }
    if (matchShellCommandPattern(pattern, command)) {
      return [{ action, targetPattern: `${kind}:**`, effect: liftEffect(effect, liftAsk) }];
    }
  }
  if (starEffect) {
    return [{ action, targetPattern: `${kind}:**`, effect: liftEffect(starEffect, liftAsk) }];
  }
  return [];
}

/** `ask` → `allow` в режиме `yolo` (ось «пользователь»). */
function liftEffect(
  effect: 'allow' | 'deny' | 'ask',
  liftAsk: boolean,
): 'allow' | 'deny' | 'ask' {
  return liftAsk && effect === 'ask' ? 'allow' : effect;
}
