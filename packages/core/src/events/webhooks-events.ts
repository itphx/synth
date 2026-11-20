/**
 * Событие шины `webhooks.updated` — **реестр webhooks инстанса изменился**.
 *
 * ## Зачем единый шов
 *
 * Реестр подписок на исходящие события (ADR-052, этап II) мутирует одна
 * фабрика — `createWebhookRoutes`, но write-путей у неё шесть: `POST /`
 * (создание), `PATCH /:id` (правка, в том числе тумблер `enabled`),
 * `DELETE /:id`, `POST /:id/regenerate` (ротация signing-секрета),
 * `POST /:id/revoke` (гашение подписки) и `POST /:id/test` (тестовая доставка).
 * Один помощник нужен именно потому, что путей много: без общего шва один из
 * них «молчит» — ровно так и была потеряна видимость мутаций.
 *
 * Если событие не публикуется, UI показывает устаревший реестр: раздел
 * «Webhooks» (`components/settings/WebhooksSettings.tsx`) грузит список один раз
 * при монтировании и перечитывает его только после **своих** мутаций
 * (`loadSubscriptions()` в обработчиках). Подписка, созданная/изменённая/
 * удалённая в другом клиенте или соседней вкладке админки, видна только после
 * перезагрузки страницы — а погашенная подписка продолжает выглядеть активной.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): реестр подписок — ресурс инстанса, а не сессии; новых
 *   транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, subscriptionId? }`
 *   (`WebhooksUpdatedEventData`): клиент перечитывает список своим обычным
 *   запросом (`GET /api/v2/webhooks`), а открытый журнал — вторым
 *   (`GET /api/v2/webhooks/:id/deliveries`);
 * - **signing-секрет и целевой URL в событие не попадают никогда**: `whsec_…`
 *   подписывает доставки, а в `url` у получателя бывает собственный токен
 *   (`https://hooks.example.com/…?token=…`) — инвариант 13 `AGENTS.md`. Это
 *   свойство типа payload'а, а не соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрика работает как раньше — событие не публикуется, падений нет.
 *
 * Почему `POST /:id/test` тоже публикует (действие `test`): реестр подписок он
 * не меняет, но пишет в **подписку** отметку доставки (`WebhookStore.
 * touchDelivery` → `lastDeliveryAt`/`lastStatus`), а эти поля панель показывает
 * в списке (бейдж статуса и «последняя доставка»). Без сигнала индикатор
 * «залипал» бы на прежнем статусе до перезагрузки страницы.
 */
import type { WebhookChangeAction, WebhooksUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в реестре webhooks (payload `webhooks.updated`). */
export interface WebhooksChangedInfo {
  /** id подписки, которой коснулась мутация (не задан — изменение реестра целиком). */
  subscriptionId?: string;
  /** Вид мутации. */
  action: WebhookChangeAction;
}

/**
 * Хук «реестр webhooks изменился» — вызывается **после** успешной записи;
 * `createWebhookRoutes` передаёт его в `publishWebhooksUpdated`.
 */
export type WebhooksChangedHook = (info: WebhooksChangedInfo) => void;

/**
 * Опубликовать `webhooks.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только id подписки и вид мутации: signing-секрет (`whsec_…`), целевой URL
 * (в нём бывает токен получателя) и прочий конфиг подписки в событие не
 * попадают.
 */
export function publishWebhooksUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: WebhooksChangedInfo,
): void {
  if (!bus) return;
  const data: WebhooksUpdatedEventData = { action: info.action };
  if (info.subscriptionId) data.subscriptionId = info.subscriptionId;
  bus.publishInstance('webhooks.updated', data);
}

/** Готовый хук для фабрики роутов: `onWebhooksChanged` поверх шины. */
export function webhooksChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): WebhooksChangedHook {
  return (info) => publishWebhooksUpdated(bus, info);
}
