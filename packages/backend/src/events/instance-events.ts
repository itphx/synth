// Инстансный канал шины в managed-режиме (ADR-101/ADR-118): какие его события
// доходят до **обычного** пользователя.
//
// Канал `INSTANCE_EVENT_CHANNEL` (`'instance'`, `packages/core/src/events/bus.ts`)
// — не сессионный: у него нет владельца, а `publishInstance` доставляет событие
// глобальным подписчикам (`subscribeAll`). Раньше в managed-хабе глобальную
// подписку имели только watch-all клиенты (`service:*`/`ADMIN`/`LEAD`), поэтому
// события реестров (`agents.updated`, `mcp.updated`, `skills.updated`,
// `models.updated`) и прогонов пайплайнов (`pipeline.run.*`) до обычного `USER`
// не доходили вовсе — списки в UI обновлялись только перезагрузкой страницы
// (в standalone дыры не было: `/ws/events` подписывает каждый клиент на
// инстансный канал).
//
// Решение владельца (вариант A): инстансный канал доставляется **любому**
// аутентифицированному клиенту, но не целиком — только «пользовательским»
// типам из списка ниже. Административные события (аудит, обслуживание
// инстанса — будущие `maintenance.*`, `packs.*` и т.п.) остаются у
// `ADMIN`/`LEAD`/`service:*`: они получают канал подпиской `subscribeAll`, и
// список их не сужает.
//
// Правило: инстансное событие считается пользовательским, если оно описывает
// **ресурс, который пользователь видит в UI** — реестры агентов/MCP/скиллов/
// моделей и состояние прогонов пайплайнов; payload таких событий не содержит
// секретов и текста чужих сессий (это уже гарантировано типами: `mcp.updated`
// не несёт конфиг, `models.updated` — ключи/URL провайдеров, `agents.updated` —
// тело роли). Любое **новое** инстансное событие по умолчанию к `USER` **не**
// попадает: список расширяется осознанно, отдельной правкой с обоснованием.
//
// Единственный источник истины: списки и фильтры (WS/SSE через `EventHub`,
// тесты матрицы доставки) читают этот модуль, своих копий не заводят.
import type { EventType } from '@itphx/synth-shared';

/**
 * «Пользовательские» типы инстансного канала: их получает любой
 * аутентифицированный клиент (WS `/ws/events` и SSE `GET /api/v2/events`).
 *
 * Состав:
 * - реестры инстанса, которые есть в UI у каждого пользователя —
 *   `agents.updated`, `mcp.updated`, `skills.updated`, `models.updated`;
 * - состояние прогонов пайплайнов — семейство `pipeline.run.*` (прогон идёт в
 *   фоне, клиент следит за ним событиями) и выход `gateway` — `pipeline.completed`.
 *   Пайплайны принадлежат проектам, но событие безадресное и несёт только
 *   id/статус: доступ к самим прогонам по-прежнему проверяет проектный роут.
 *
 * `USER` не получает административные инстансные события (аудит, обслуживание
 * инстанса): для них доставка остаётся у `ADMIN`/`LEAD`/`service:*`.
 */
export const USER_FACING_INSTANCE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'agents.updated',
  'mcp.updated',
  'skills.updated',
  'models.updated',
  'pipeline.run.started',
  'pipeline.run.node_started',
  'pipeline.run.node_finished',
  'pipeline.run.awaiting_human',
  'pipeline.run.finished',
  'pipeline.run.failed',
  'pipeline.completed',
]);

/**
 * Доставлять ли инстансное событие обычному пользователю (не watch-all).
 *
 * Всё, чего нет в `USER_FACING_INSTANCE_EVENTS`, к `USER` не идёт — fail-closed:
 * забыть про новый тип безопаснее, чем отдать его всем.
 */
export function isUserFacingInstanceEvent(type: EventType): boolean {
  return USER_FACING_INSTANCE_EVENTS.has(type);
}
