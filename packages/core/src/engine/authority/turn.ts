/**
 * ADR-106 Ф4 (шаг B2): контекст хода и потолок хода.
 *
 * Контекст хода собирается **один раз на ход** — при старте хода в
 * оркестраторе — и кладётся в шов permission-слоя (`authorityContext`).
 * Вместе с принципалом (шаг A) он несёт:
 *
 * - **участников сессии** (снимок на начало хода) и **роль принципала** среди
 *   них: потолок сессии зависит от роли (`viewer` — только чтение, инвариант 21:
 *   право чтения не расширяет права на изменение);
 * - **потолок сессии** (ось `session`) — считается один раз на ход;
 * - **оси хода** (`effective`) — пересечение прав: права инициатора ∩ права
 *   агента ∩ потолок сессии ∩ потолок пакета ∩ политика инстанса.
 *
 * Инвариант шага B2: **сообщение другого участника не поднимает потолок уже
 * начатого хода**. Потолок привязан к инициатору хода (принципалу,
 * зафиксированному при приёме ввода), а не к последнему написавшему: `viewer`,
 * отправивший сообщение в сессию, где идёт ход `editor`, не меняет решение
 * этого хода.
 *
 * Модуль — единственное место, где контекст хода собирается; вычисление
 * потолка и осей — в guard'е (`guard.ts`), решение — в резолвере
 * (`resolve.ts`).
 */
import type {
  AuthorityCeiling,
  AuthorityPrincipal,
  SessionParticipant,
  SessionParticipantRole,
} from '@itphx/synth-shared';

import { resolveParticipantRole } from './participants.js';
import type { AuthorityEffective } from './resolve.js';

/**
 * Контекст хода — снимок полномочий на момент начала хода.
 *
 * Поля `ceiling` и `effective` заполняются **один раз на ход** (guard
 * считает их при первом решении хода и кладёт сюда) — поэтому повторные
 * решения того же хода не могут поднять потолок.
 */
export interface AuthorityTurnContext {
  /** Идентификатор хода (`turn_id`). */
  id: string;
  /** Сессия хода. */
  sessionId: string;
  /** Принципал хода (зафиксирован при приёме ввода — ADR-106 Ф4, шаг A). */
  principal: AuthorityPrincipal;
  /** Агент хода (если ход исполняет агента). */
  agentId?: string;
  /** Участники сессии (снимок на начало хода). */
  participants: readonly SessionParticipant[];
  /**
   * Роль принципала среди участников сессии. `undefined` — потолок по роли
   * **не применяется** (участников нет, принципал — не человек или носитель
   * глобальной роли): прежнее поведение.
   */
  participantRole?: SessionParticipantRole;
  /** Потолок сессии (ось `session`) — считается один раз на ход. */
  ceiling?: AuthorityCeiling[];
  /** Оси хода (`effective`) — считаются один раз на ход. */
  effective?: AuthorityEffective;
  /** Начало хода (ISO-8601). */
  startedAt: string;
}

/**
 * Контекст хода по принципалу и участникам сессии.
 *
 * Участники — снимок на начало хода: участник, добавленный или удалённый
 * позже, на потолок **начатого** хода не влияет.
 */
export function createAuthorityTurnContext(input: {
  sessionId: string;
  principal: AuthorityPrincipal;
  turnId: string;
  agentId?: string;
  participants?: readonly SessionParticipant[];
  startedAt?: string;
}): AuthorityTurnContext {
  const participants = input.participants ?? [];
  const participantRole = resolveParticipantRole(participants, input.principal);
  return {
    id: input.turnId,
    sessionId: input.sessionId,
    principal: input.principal,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    participants,
    ...(participantRole ? { participantRole } : {}),
    startedAt: input.startedAt ?? new Date().toISOString(),
  };
}
