/**
 * Событие шины `identities.updated` — **идентичности пользователя изменились**.
 *
 * ## Зачем шов
 *
 * Внешние идентичности (ADR-089) меняются в двух write-путях одной фабрики
 * `createIdentityRoutes`: `POST /identities/claim` (владение подтверждено
 * одноразовым кодом — идентичность привязана к профилю) и
 * `DELETE /identities/:provider/:externalId` (отвязка). Панель профиля
 * (`components/settings/ProfileSettings.tsx`) грузит список идентичностей один
 * раз при монтировании и обновляет его только после **своих** действий:
 * привязка, подтверждённая кодом из чата в другой вкладке/на другом устройстве,
 * и отвязка в соседнем клиенте видны только после перезагрузки страницы.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): у идентичностей нет сессии, новых каналов не заводим
 *   (инвариант 6 `AGENTS.md`);
 * - payload — **только вид мутации** (`IdentitiesUpdatedEventData`), без единого
 *   идентификатора: `provider`/`externalId` — персональные данные человека, а
 *   канал доставляется ещё и watch-all администраторам; клиент перечитывает
 *   **свой** список (`GET /api/v2/me/identities`) и чужие id ему не нужны.
 *   Claim-код и токены в событие не попадают тем более (инвариант 13
 *   `AGENTS.md`);
 * - хук публикации **необязателен**: без шины фабрика работает как раньше.
 *
 * Публикация — только после успешной записи (`400`/`404`/`409` молчат).
 */
import type { IdentitiesChangeAction, IdentitiesUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось у идентичностей пользователя (payload `identities.updated`). */
export interface IdentitiesChangedInfo {
  /** Вид мутации. */
  action: IdentitiesChangeAction;
}

/**
 * Хук «идентичности изменились» — вызывается **после** успешной записи;
 * `createIdentityRoutes` передаёт его в `publishIdentitiesUpdated`.
 */
export type IdentitiesChangedHook = (info: IdentitiesChangedInfo) => void;

/**
 * Опубликовать `identities.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходит
 * только вид мутации: ни `provider`/`externalId` (персональные данные), ни
 * claim-кода, ни токенов.
 */
export function publishIdentitiesUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: IdentitiesChangedInfo,
): void {
  if (!bus) return;
  const data: IdentitiesUpdatedEventData = { action: info.action };
  bus.publishInstance('identities.updated', data);
}

/** Готовый хук для фабрики роутов: `onIdentitiesChanged` поверх шины. */
export function identitiesChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): IdentitiesChangedHook {
  return (info) => publishIdentitiesUpdated(bus, info);
}
