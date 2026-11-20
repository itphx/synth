/**
 * Событие шины `models.updated` — **каталог провайдеров/моделей инстанса
 * изменился**.
 *
 * ## Зачем единый шов
 *
 * Каталог мутируют две фабрики роутов: `createProviderRoutes` (`POST /`,
 * `PATCH /:name`, `DELETE /:name`) и `createModelRoutes` (`POST /`,
 * `DELETE /:id`, `POST /fetch` — синхронизация каталога с провайдером,
 * `set_as_default`). Write-тулов моделей/провайдеров в чате нет (`list_models`
 * только читает), поэтому путей ровно два — но их всё равно должен покрывать
 * один помощник: иначе один из них «молчит».
 *
 * Если событие не публикуется, UI показывает устаревший каталог: селект модели
 * в чате грузит полный каталог лениво **один раз** (guard `catalogLoaded`,
 * `stores/providersStore.ts`) и больше его не перечитывает, а админ-панели
 * обновляют только собственный список. Модель, добавленная/удалённая/сделанная
 * дефолтной в другом клиенте (или в соседней вкладке), видна только после
 * перезагрузки страницы.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): каталог провайдеров/моделей — ресурс инстанса, а не сессии;
 *   новых транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, provider?, modelId? }`
 *   (`ModelsUpdatedEventData`): клиент перечитывает каталог своими обычными
 *   запросами (`GET /providers`, `GET /models`);
 * - **секреты провайдеров в событие не попадают никогда**: `api_key`, `base_url`
 *   (в URL бывает токен) и прочий конфиг провайдера в payload не кладутся —
 *   инвариант 13 `AGENTS.md`. Это свойство типа payload'а, а не соглашение
 *   вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрики работают как раньше — событие не публикуется, падений нет.
 */
import type { ModelChangeAction, ModelsUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в каталоге провайдеров/моделей (payload `models.updated`). */
export interface ModelsChangedInfo {
  /** Провайдер, которого коснулась мутация (не задан — изменение целиком). */
  provider?: string;
  /** Имя модели, которой коснулась мутация (не задано — изменение целиком). */
  modelId?: string;
  /** Вид мутации. */
  action: ModelChangeAction;
}

/**
 * Хук «каталог провайдеров/моделей изменился» — вызывается **после** успешной
 * записи; `createProviderRoutes`/`createModelRoutes` передают его в
 * `publishModelsUpdated`.
 */
export type ModelsChangedHook = (info: ModelsChangedInfo) => void;

/**
 * Опубликовать `models.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload
 * уходят только провайдер/модель/вид мутации: конфиг провайдера (а с ним
 * `apiKey` и `baseUrl`) в событие не попадает — там бывают секреты.
 */
export function publishModelsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: ModelsChangedInfo,
): void {
  if (!bus) return;
  const data: ModelsUpdatedEventData = { action: info.action };
  if (info.provider) data.provider = info.provider;
  if (info.modelId) data.modelId = info.modelId;
  bus.publishInstance('models.updated', data);
}

/** Готовый хук для фабрик роутов: `onModelsChanged` поверх шины. */
export function modelsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): ModelsChangedHook {
  return (info) => publishModelsUpdated(bus, info);
}
