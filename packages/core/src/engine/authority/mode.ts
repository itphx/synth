/**
 * ADR-106 Ф4 (шаг C): режим сессии — как потолок хода.
 *
 * До шага C режим был **общим переключателем сессии**: `PATCH /sessions/:id`
 * менял `Session.mode` для всех, а `yolo` превращал `ask` в `allow` — один
 * участник снимал подтверждения всем (ADR-106 §«Контекст», п. 3).
 *
 * Теперь режим — свойство **принципала хода**:
 *
 * - `Session.mode` — базовый режим сессии (прежнее поведение для одиночных
 *   сессий: standalone `local`, личная сессия без участников);
 * - `Session.modeByPrincipal` — переопределение режима для конкретного
 *   участника: действует **только на его ходы**, чужие ходы не меняются.
 *
 * Инварианты шага C:
 *
 * 1. **Смена режима одним участником не меняет решения для ходов другого.**
 *    Переопределение пишется в `modeByPrincipal`, базовый `mode` не трогается.
 * 2. **`yolo` никогда не выше потолка сессии.** Режим — только «разрешение
 *    спросить» снять; требование потолка (выход за рабочий каталог, роль
 *    `viewer`, потолок пакета/инстанса) снимается **потолком**, а не режимом
 *    (ADR-106 §«Многопользовательская сессия»). В enforced-режиме слой это
 *    обеспечивает сам (`engine/authority/guard.ts` + `_applyAuthority`).
 * 3. **Совместимость.** Нет участников (или участник один) — режим меняется
 *    для сессии, как раньше; `plan`/`act` работают как раньше.
 *
 * Модуль — единственное место, где режим **выводится** для хода и
 * **записывается** в сессию. Право на смену режима решает граничный guard
 * (`server/session-mode-guard.ts`), а не обработчик (инвариант 16).
 */
import type {
  AuthorityPrincipal,
  Session,
  SessionMode,
  SessionParticipant,
} from '@itphx/synth-shared';

/** Режим по умолчанию, если он не задан (прежнее поведение `session.mode ?? 'act'`). */
export const DEFAULT_SESSION_MODE: SessionMode = 'act';

/**
 * Область применения режима.
 *
 * - `session` — общий режим сессии (`Session.mode`): одиночная сессия
 *   (участников нет или один) — прежнее поведение;
 * - `principal` — режим **только** этого принципала (`Session.modeByPrincipal`):
 *   многопользовательская сессия, где смена режима одним участником не должна
 *   менять решения для ходов другого.
 */
export type SessionModeScope =
  | { kind: 'session' }
  | { kind: 'principal'; userId: string };

/** Причина отказа в смене режима. */
export type SessionModeScopeReason = 'not_participant' | 'read_only';

/** Решение о области применения режима. */
export type SessionModeScopeDecision =
  | { allowed: true; scope: SessionModeScope }
  | { allowed: false; reason: SessionModeScopeReason };

/**
 * Режим хода: переопределение принципала → базовый режим сессии → дефолт.
 *
 * Переопределение применяется только к **человеческим** принципалам
 * (`kind: 'user'`): машинные (service/event/scheduler/agent) идут от своих
 * осей прав, а не от режима участника.
 */
export function resolveTurnMode(
  session: Pick<Session, 'mode' | 'modeByPrincipal'>,
  principal?: AuthorityPrincipal | null,
): SessionMode {
  if (principal?.kind === 'user') {
    const override = session.modeByPrincipal?.[principal.id];
    if (override) return override;
  }
  return session.mode ?? DEFAULT_SESSION_MODE;
}

/**
 * Область применения режима — решение о том, чей это режим.
 *
 * - **Участников нет или один** → `session`: прежнее поведение (standalone,
 *   личная сессия). Право на смену режима — как прежде (write-доступ к
 *   сессии решает общий prefix-guard).
 * - **Участников несколько** → `principal`: режим меняется только у того,
 *   кто его выставил. Право: участник с мутирующей ролью (`owner`/`editor`);
 *   `viewer` — не может (инвариант 21: право чтения не расширяет права на
 *   изменение); неучастник — не может (fail-closed).
 * - **Сквозной доступ (ADMIN/LEAD)** → `session`: их доступ к чужим сессиям —
 *   осознанное решение (матрица IDOR), право на смену режима сохраняется.
 */
export function decideSessionModeScope(input: {
  participants: readonly SessionParticipant[];
  userId: string;
  /** Сквозной доступ инстанса (ADMIN/LEAD). */
  elevated?: boolean;
}): SessionModeScopeDecision {
  const participants = input.participants ?? [];
  if (participants.length <= 1) return { allowed: true, scope: { kind: 'session' } };
  if (input.elevated) return { allowed: true, scope: { kind: 'session' } };
  const participant = participants.find((p) => p.userId === input.userId);
  if (!participant) return { allowed: false, reason: 'not_participant' };
  if (participant.role === 'viewer') return { allowed: false, reason: 'read_only' };
  return { allowed: true, scope: { kind: 'principal', userId: participant.userId } };
}

/**
 * Записать режим в сессию (область — из решения граничного guard'а).
 *
 * - область `session` → `Session.mode` (прежнее поведение);
 * - область `principal` → `Session.modeByPrincipal[userId]`. Если режим совпал
 *   с базовым режимом сессии — переопределение снимается (участник вернулся
 *   к общему режиму), карта не разрастается.
 */
export function applySessionMode(
  session: Pick<Session, 'mode' | 'modeByPrincipal'>,
  mode: SessionMode,
  scope: SessionModeScope,
): void {
  if (scope.kind === 'session') {
    session.mode = mode;
    return;
  }
  const current = { ...(session.modeByPrincipal ?? {}) };
  if (mode === (session.mode ?? DEFAULT_SESSION_MODE)) {
    delete current[scope.userId];
  } else {
    current[scope.userId] = mode;
  }
  session.modeByPrincipal = Object.keys(current).length > 0 ? current : undefined;
}
