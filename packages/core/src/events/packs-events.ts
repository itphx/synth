/**
 * Событие шины `packs.updated` — **реестр пакетов расширений изменился**.
 *
 * ## Зачем единый шов
 *
 * Реестр установок пакетов (аддоны, ADR-086 §5) мутирует одна фабрика —
 * `createPacksRoutes`, но write-путей у неё три: `POST /` (установка, в том
 * числе «в карантин»), `POST /:name/approve` (одобрение из карантина) и
 * `DELETE /:name` (снятие вместе с принесёнными артефактами). Один помощник
 * нужен именно потому, что путей несколько: без общего шва один из них
 * «молчит» — ровно так терялась видимость мутаций у других реестров.
 *
 * Если событие не публикуется, UI показывает устаревший реестр: раздел
 * «Аддоны» (`components/settings/AddonsSettings.tsx`) грузит список установок
 * один раз при монтировании и перечитывает его только после **своих** действий
 * (`loadPacks()` в обработчиках). Пакет, поставленный/одобренный/снятый в другом
 * клиенте, соседней вкладке админки или установщиком по HTTP API, виден только
 * после перезагрузки страницы — а снятый пакет продолжает висеть в списке.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): реестр установок — ресурс инстанса, а не сессии; новых
 *   транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, packName? }` (`PacksUpdatedEventData`):
 *   клиент перечитывает список своим обычным запросом (`GET /api/v2/packs`);
 * - **манифест пакета и карта файлов в событие не попадают никогда**: манифест
 *   описывает контент, который ставится в инстанс (в том числе тела скиллов и
 *   определения агентов), а сигналу достаточно «перечитай»; это свойство типа
 *   payload'а, а не соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрика работает как раньше — событие не публикуется, падений нет;
 * - публикация — **после** успешной записи: 400 (некорректный манифест/нет
 *   файла), 403 (нет прав/scope), 404 (пакета нет) и 409 (пакет не ждёт
 *   подтверждения) событие не публикуют.
 *
 * Особый случай — установка «в карантин» (`status: 'pending_approval'`, ответ
 * 202): запись в реестре уже создана, пакет виден в списке админки, поэтому
 * событие публикуется с тем же `action: 'install'`.
 */
import type { PackChangeAction, PacksUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в реестре пакетов (payload `packs.updated`). */
export interface PacksChangedInfo {
  /** Имя пакета, которого коснулась мутация (не задано — изменение реестра целиком). */
  packName?: string;
  /** Вид мутации. */
  action: PackChangeAction;
}

/**
 * Хук «реестр пакетов изменился» — вызывается **после** успешной записи;
 * `createPacksRoutes` передаёт его в `publishPacksUpdated`.
 */
export type PacksChangedHook = (info: PacksChangedInfo) => void;

/**
 * Опубликовать `packs.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только имя пакета и вид мутации: манифест, карта файлов и сводка полномочий в
 * событие не попадают.
 */
export function publishPacksUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: PacksChangedInfo,
): void {
  if (!bus) return;
  const data: PacksUpdatedEventData = { action: info.action };
  if (info.packName) data.packName = info.packName;
  bus.publishInstance('packs.updated', data);
}

/** Готовый хук для фабрики роутов: `onPacksChanged` поверх шины. */
export function packsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): PacksChangedHook {
  return (info) => publishPacksUpdated(bus, info);
}
