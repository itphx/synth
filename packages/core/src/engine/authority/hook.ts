/**
 * PROP-108 Ф1/Ф2: шов Authority-слоя в permission-слой.
 *
 * Модуль **без побочных эффектов и без импортов движка** — только типы. Его
 * импортит и permission-слой (`engine/permission/evaluator.ts`), и guard
 * (`engine/authority/guard.ts`), поэтому цикла зависимостей не возникает.
 *
 * Контракт шва:
 * - решение **не меняется** в shadow-режиме — слой только считает и пишет
 *   (PROP-108 §«Совместимость и миграция»);
 * - в enforced-режиме (Ф2) решение Authority-слоя **сужает** решение
 *   permission-слоя: `deny` → `deny`, `ask` → `ask`; `allow` ничего не
 *   разрешает сверх permission-слоя (права только сужаются, PROP-108
 *   §«Инварианты модели», п. 3);
 * - вызов синхронный и **не должен бросать**: ошибка слоя не влияет на ход.
 */
import type {
  AuthorityPrincipal,
  PermissionConfig,
  PermissionDecision,
  PlanMode,
  SessionMode,
  ToolSource,
} from '@itphx/synth-shared';

import type { AuthorityAxisSource } from './resolve.js';

/** Контекст хода для решения Authority-слоя (принципал, сессия, агент, ход). */
export interface AuthorityShadowContext {
  /** Сессия хода. */
  sessionId?: string;
  /** Принципал хода (кто действует). */
  principal?: AuthorityPrincipal;
  /** Агент хода. */
  agentId?: string;
  /** Идентификатор хода (`turn_id`). */
  turnId?: string;
}

/** Вход решения Authority-слоя (собирается permission-слоем). */
export interface AuthorityShadowInput extends AuthorityShadowContext {
  toolName: string;
  params: Record<string, unknown>;
  workingDir: string;
  capabilities?: readonly string[];
  toolSource?: ToolSource;
  sessionMode?: SessionMode;
  planMode?: PlanMode;
  planApproved?: boolean;
  /** Эффективный permission-конфиг сессии — основа компиляции грантов. */
  config: PermissionConfig;
  /** Текущее решение permission-слоя (для сверки в журнале). */
  decision: PermissionDecision;
}

/**
 * Шов shadow-записи. Вызывается permission-слоем после вычисления решения;
 * реализация считает authority-решение и пишет его в журнал.
 */
export type AuthorityShadowHook = (input: AuthorityShadowInput) => void;

/**
 * Решение Authority-слоя для пары «действие × цель» (PROP-108 Ф2).
 *
 * `enforced` — слой применяет решение (`authority.enabled` и **не**
 * `authority.shadow`). При `enforced: false` решение только считается и
 * пишется в журнал — права не меняются.
 */
export interface AuthorityGateResult {
  /** Эффект решения. */
  effect: 'allow' | 'ask' | 'deny';
  /** Действие, по которому принято решение (доменный глагол). */
  action: string;
  /** Причина решения (`unknown`/`explicit`/`no_grant`/null). */
  reason: 'unknown' | 'explicit' | 'no_grant' | null;
  /** Ось, давшая решение. */
  source: AuthorityAxisSource;
  /** Слой применяет решение (false — shadow). */
  enforced: boolean;
  /**
   * Требуется подтверждение, которое `yolo` **не снимает**: решение пришло от
   * потолка/политики (ось ≠ «user»), а не от правил сессии (PROP-108
   * §«Многопользовательская сессия»: «`yolo` не снимает `ask`, если этого
   * требует потолок сессии»).
   */
  requiresConfirm: boolean;
}

/** Шов решения Authority-слоя (permission-слой → authority-слой). */
export type AuthorityGateHook = (input: AuthorityShadowInput) => AuthorityGateResult | undefined;
