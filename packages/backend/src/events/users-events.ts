// Каталог пользователей инстанса (managed) изменился — событие `users.updated`
// в инстансный канал шины (ADR-118, инвариант 27 `AGENTS.md`).
//
// ## Зачем
//
// Каталог пользователей правит **только** backend (`packages/backend/src/routes/users.ts`)
// и только ADMIN: `POST /users`, `PUT /users/:id`, `DELETE /users/:id`. До этого
// шва write-пути молчали, поэтому админ-панель «Пользователи» показывала снимок,
// снятый при монтировании: пользователь, созданный/отредактированный/удалённый во
// втором клиенте (или во второй вкладке), появлялся только после перезагрузки
// страницы.
//
// ## Контракт
//
// - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`):
//   каталог пользователей — ресурс инстанса, а не сессии; новых транспортных
//   каналов не заводим (инвариант 6 `AGENTS.md`);
// - payload минимальный — `{ action, userId? }` (`UsersUpdatedEventData`): клиент
//   перечитывает каталог своим обычным запросом (`GET /api/v2/users`);
// - **почта, телефон, заметки, роли, идентичности и предпочтения в событие не
//   попадают никогда** (инвариант 13 `AGENTS.md`): это свойство типа payload'а, а
//   не соглашение вызывающих;
// - событие **админское**: в `USER_FACING_INSTANCE_EVENTS` его нет — каталог
//   пользователей доступен только ADMIN (`requireAdminOrScope`), обычному
//   пользователю это событие бесполезно и раскрывало бы факт мутации каталога;
// - публикация — **только после успешной записи**: 400/403/409 и 404 (нет
//   пользователя) молчат;
// - шина **необязательна**: без неё (тесты, сторонние потребители) роуты
//   работают как раньше — событие не публикуется, падений нет.
import type { UsersChangeAction, UsersUpdatedEventData } from '@itphx/synth-shared';
import type { InstanceEventPublisherLike } from '@itphx/synth-core';

/** Что изменилось в каталоге пользователей (payload `users.updated`). */
export interface UsersChangedInfo {
  /** id профиля, которого коснулась мутация (не задан — изменение целиком). */
  userId?: string;
  /** Вид мутации. */
  action: UsersChangeAction;
}

/**
 * Хук «каталог пользователей изменился» — вызывается **после** успешной записи;
 * `createUserRoutes` передаёт его в `publishUsersUpdated`.
 */
export type UsersChangedHook = (info: UsersChangedInfo) => void;

/**
 * Опубликовать `users.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только id пользователя и вид мутации.
 */
export function publishUsersUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: UsersChangedInfo,
): void {
  if (!bus) return;
  const data: UsersUpdatedEventData = { action: info.action };
  if (info.userId) data.userId = info.userId;
  bus.publishInstance('users.updated', data);
}

/** Готовый хук для фабрики роутов: `onUsersChanged` поверх шины. */
export function usersChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): UsersChangedHook {
  return (info) => publishUsersUpdated(bus, info);
}
