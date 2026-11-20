/**
 * Событие шины `plugins.updated` — **реестр плагинов слоя расширений изменился**.
 *
 * ## Зачем единый шов
 *
 * Реестр плагинов (ADR-090) мутируют две фабрики: `createPluginsRoutes`
 * (жизненный цикл: `POST /install`, `POST /update`, `POST /:name/approve`,
 * `POST /:name/enable`, `POST /:name/disable`, `POST /:name/rollback`,
 * `DELETE /:name`) и `createPluginSettingsRoutes` (политика слоя:
 * `PUT | DELETE /plugins` → `action: 'policy'`). Путей много, поэтому без
 * общего шва один из них «молчит» — ровно так терялась видимость мутаций у
 * других реестров.
 *
 * Если событие не публикуется, UI показывает устаревший реестр: раздел
 * «Плагины» (`components/settings/PluginsSettings.tsx`) грузит список один раз
 * при монтировании и перечитывает его только после **своих** действий
 * (`loadPlugins()` в обработчиках). Из-за этого «залипал» статус: плагин,
 * активированный/выключенный/удалённый в другом клиенте или установленный
 * `POST /plugins/install` из CLI, продолжал показываться в прежнем состоянии
 * (`active` / `pending approval`) до перезагрузки страницы.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): реестр плагинов — ресурс инстанса, а не сессии; новых
 *   транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, pluginName? }` (`PluginsUpdatedEventData`):
 *   клиент перечитывает список своим обычным запросом (`GET /api/v2/plugins`), а
 *   после `action: 'policy'` — ещё и снимок политики
 *   (`GET /api/v2/settings/plugins`);
 * - **токенов, ключей, URL источников установки и содержимого манифеста в
 *   событие не попадает никогда** (инвариант 13 `AGENTS.md`): `POST /plugins/token`
 *   выдаёт секрет (`synth_svc_…`) и потому события не публикует вовсе — реестр
 *   плагинов он не меняет, меняется только реестр service-key;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрики работают как раньше — событие не публикуется, падений нет;
 * - публикация — **после** успешной записи и **только при фактической мутации**
 *   реестра: 400/403/404/409/501/502 событие не публикуют. Молчат и исходы,
 *   которые запись не меняют: `POST /install` с `outcome: 'approval_required'`
 *   (202 — бандл ушёл в карантин, lock **не** пишется, список плагинов прежний),
 *   `POST /update` с `outcome: 'unchanged'` (content-hash совпал: ни версия, ни
 *   запись lock не менялись) и `DELETE /:name` с `removed: false` (снимать было
 *   нечего). Сигнал «перечитай» без мутации — лишние запросы у всех клиентов.
 */
import type { PluginChangeAction, PluginsUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в реестре плагинов (payload `plugins.updated`). */
export interface PluginsChangedInfo {
  /** Имя плагина, которого коснулась мутация (не задано — изменение целиком). */
  pluginName?: string;
  /** Вид мутации. */
  action: PluginChangeAction;
}

/**
 * Хук «реестр плагинов изменился» — вызывается **после** успешной записи;
 * `createPluginsRoutes`/`createPluginSettingsRoutes` передают его в
 * `publishPluginsUpdated`.
 */
export type PluginsChangedHook = (info: PluginsChangedInfo) => void;

/**
 * Опубликовать `plugins.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только имя плагина и вид мутации: токен, ключи, URL источника установки и
 * прочий конфиг плагина в событие не попадают.
 */
export function publishPluginsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: PluginsChangedInfo,
): void {
  if (!bus) return;
  const data: PluginsUpdatedEventData = { action: info.action };
  if (info.pluginName) data.pluginName = info.pluginName;
  bus.publishInstance('plugins.updated', data);
}

/** Готовый хук для фабрик роутов: `onPluginsChanged` поверх шины. */
export function pluginsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): PluginsChangedHook {
  return (info) => publishPluginsUpdated(bus, info);
}
