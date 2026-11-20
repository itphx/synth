/**
 * Событие шины `dictionaries.updated` — **словарь классификации изменился**.
 *
 * ## Зачем единый шов
 *
 * Словари категорий (`coding`, `research`, …) правит одна фабрика —
 * `createDictionaryRoutes`, write-путей у неё два: `PUT /:category/:lang`
 * (записать переопределение — YAML-текст либо legacy `{ keywords, tools }`) и
 * `DELETE /:category/:lang` (сбросить к системному словарю). Помощник общий,
 * чтобы оба пути публиковали одинаково: разойдясь, они дали бы «сохранил — не
 * видно, сбросил — видно».
 *
 * Если событие не публикуется, UI показывает устаревшие словари: секция
 * «Словари» (`DictionarySection` внутри
 * `components/settings/RoutingSettings.tsx`) грузит список один раз
 * (`useEffect(..., [])`) и перечитывает его только после **своего**
 * сохранения/сброса. Переопределение, записанное в другом клиенте или соседней
 * вкладке настроек, видно только после перезагрузки страницы — при этом метка
 * источника (`user`/`system`) и размер словаря остаются прежними.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): словари — каталог инстанса, а не ресурс сессии; новых
 *   транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, category?, lang? }`
 *   (`DictionariesUpdatedEventData`): клиент перечитывает список своим обычным
 *   запросом (`GET /api/v2/dictionaries`);
 * - **содержимое словаря в событие не попадает никогда**: ни YAML-текста, ни
 *   разобранных `keywords`/`tools` — payload говорит только «перечитай»
 *   (свойство типа payload'а, а не соглашение вызывающих);
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрика работает как раньше — событие не публикуется, падений нет.
 */
import type { DictionaryChangeAction, DictionariesUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в словарях (payload `dictionaries.updated`). */
export interface DictionariesChangedInfo {
  /** Категория словаря (`coding`, `research`, …). */
  category?: string;
  /** Язык словаря (`ru`/`en`). */
  lang?: string;
  /** Вид мутации. */
  action: DictionaryChangeAction;
}

/**
 * Хук «словарь изменился» — вызывается **после** успешной записи;
 * `createDictionaryRoutes` передаёт его в `publishDictionariesUpdated`.
 */
export type DictionariesChangedHook = (info: DictionariesChangedInfo) => void;

/**
 * Опубликовать `dictionaries.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только категория, язык и вид мутации: содержимое словаря (YAML, `keywords`,
 * `tools`) в событие не попадает.
 */
export function publishDictionariesUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: DictionariesChangedInfo,
): void {
  if (!bus) return;
  const data: DictionariesUpdatedEventData = { action: info.action };
  if (info.category) data.category = info.category;
  if (info.lang) data.lang = info.lang;
  bus.publishInstance('dictionaries.updated', data);
}

/** Готовый хук для фабрики роутов: `onDictionariesChanged` поверх шины. */
export function dictionariesChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): DictionariesChangedHook {
  return (info) => publishDictionariesUpdated(bus, info);
}
