/**
 * Событие шины `events.updated` — **реестр приёма внешних событий изменился**.
 *
 * ## Зачем единый шов
 *
 * Реестр приёма событий (ADR-089) мутирует одна фабрика — `createEventRoutes`,
 * но write-путей у неё восемь: привязки (`POST /bindings` — upsert,
 * `DELETE /bindings/:id`), API-ключи привязки (`POST /bindings/:id/keys`,
 * `PATCH /bindings/:id/keys/:keyId`, `POST /bindings/:id/keys/:keyId/revoke`,
 * `DELETE /bindings/:id/keys/:keyId`) и правила маршрутизации
 * (`POST /routes` — upsert, `DELETE /routes/:id`). Один помощник нужен именно
 * потому, что путей много: без общего шва один из них «молчит» — ровно так уже
 * терялась видимость мутаций у пяти реестров подряд.
 *
 * Если событие не публикуется, UI показывает устаревший реестр: раздел
 * «События» (`components/settings/EventsAdminSettings.tsx`) грузит список
 * привязок один раз при монтировании, секция правил
 * (`components/settings/EventRoutesSection.tsx`) — свой список, а карточка
 * привязки (`components/settings/EventBindingKeys.tsx`) — метаданные ключей;
 * перечитываются они только после **своих** мутаций. Привязка, правило или
 * ключ, созданные/изменённые/удалённые в другом клиенте или соседней вкладке
 * админки, видны только после перезагрузки страницы — а отозванный ключ
 * продолжает выглядеть активным.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): реестр приёма событий — ресурс инстанса, а не сессии; новых
 *   транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, bindingId?, routeId? }`
 *   (`EventsUpdatedEventData`): клиент перечитывает список своим обычным
 *   запросом (`GET /api/v2/events/bindings` / `GET /api/v2/events/routes`), а
 *   открытую карточку привязки — вторым (`GET /api/v2/events/bindings/:id/keys`);
 * - **секрет API-ключа (`synth_evt_…`), его хеш и id ключа в событие не
 *   попадают никогда** (инвариант 13 `AGENTS.md`): ключ подписывает приём
 *   событий, а сигналу достаточно «перечитай карточку привязки». Это свойство
 *   типа payload'а, а не соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрика работает как раньше — событие не публикуется, падений нет.
 *
 * Публикация — **только после успешной записи** (`400`/`403`/`404`/`409`
 * молчат): клиенту нечего перечитывать, если записи не произошло.
 */
import type { EventsChangeAction, EventsUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в реестре приёма внешних событий (payload `events.updated`). */
export interface EventsChangedInfo {
  /** Привязка, которой коснулась мутация (в т.ч. мутация её ключа). */
  bindingId?: string;
  /** Правило маршрутизации, которого коснулась мутация. */
  routeId?: string;
  /** Вид мутации. */
  action: EventsChangeAction;
}

/**
 * Хук «реестр приёма событий изменился» — вызывается **после** успешной записи;
 * `createEventRoutes` передаёт его в `publishEventsUpdated`.
 */
export type EventsChangedHook = (info: EventsChangedInfo) => void;

/**
 * Опубликовать `events.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только вид мутации и id затронутой записи: секрет ключа (`synth_evt_…`), его
 * хеш, id ключа и тело привязки/правила в событие не попадают.
 */
export function publishEventsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: EventsChangedInfo,
): void {
  if (!bus) return;
  const data: EventsUpdatedEventData = { action: info.action };
  if (info.bindingId) data.bindingId = info.bindingId;
  if (info.routeId) data.routeId = info.routeId;
  bus.publishInstance('events.updated', data);
}

/** Готовый хук для фабрики роутов: `onEventsChanged` поверх шины. */
export function eventsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): EventsChangedHook {
  return (info) => publishEventsUpdated(bus, info);
}
