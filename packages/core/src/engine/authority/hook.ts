/**
 * PROP-108 Ф1: шов shadow-интеграции Authority-слоя в permission-слой.
 *
 * Модуль **без побочных эффектов и без импортов движка** — только типы. Его
 * импортит и permission-слой (`engine/permission/evaluator.ts`), и shadow-
 * recorder (`engine/authority/shadow.ts`), поэтому цикла зависимостей не
 * возникает.
 *
 * Контракт шва:
 * - решение **не меняется** — shadow только считает и пишет (PROP-108
 *   §«Совместимость и миграция»);
 * - вызов синхронный и **не должен бросать**: ошибка shadow не влияет на ход.
 */
import type {
  AuthorityPrincipal,
  PermissionConfig,
  PermissionDecision,
  PlanMode,
  SessionMode,
  ToolSource,
} from '@itphx/synth-shared';

/** Контекст хода для shadow-решения (принципал, сессия, агент, ход). */
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

/** Вход shadow-записи (собирается permission-слоем). */
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
