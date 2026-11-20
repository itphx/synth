/**
 * Событие шины `agents.updated` — **реестр агентов инстанса изменился**.
 *
 * ## Зачем единый шов
 *
 * Мутировать реестр можно двумя путями: HTTP-роуты (`createAgentRoutes`:
 * `POST /`, `DELETE /:id`, `PATCH /:id/enabled`) и тулы самообслуживания
 * (`synth_agent_save|delete|enable|import`, `engine/tools/instance-agents.ts`).
 * Если событие публикует только один путь, второй «молчит»: UI (админ-панель
 * «Агенты», селекты агента в чате/настройках) показывает устаревший состав до
 * перезагрузки страницы. Поэтому публикация — здесь, один помощник на оба пути.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-101/ADR-118): агент — ресурс инстанса, а не сессии; новых транспортных
 *   каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ id, action }` (`AgentsUpdatedEventData`): клиент
 *   перечитывает список своим обычным запросом, тяжёлых данных в событии нет;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрики работают как раньше — событие не публикуется, падений нет.
 */
import type { AgentChangeAction, AgentsUpdatedEventData, EventType } from '@itphx/synth-shared';

/**
 * Минимальный контракт шины: достаточно инстансной публикации. `EventBus`
 * (`events/bus.ts`) подходит структурно — его `publishInstance` принимает те же
 * аргументы.
 */
export interface InstanceEventPublisherLike {
  publishInstance(type: EventType, data?: Record<string, unknown>): void;
}

/** Что изменилось в реестре агентов (payload события `agents.updated`). */
export interface AgentChangedInfo {
  /** id агента, которого коснулась мутация. */
  id: string;
  /** Вид мутации. */
  action: AgentChangeAction;
}

/**
 * Хук «состав реестра агентов изменился» — вызывается **после** успешной
 * записи; `createAgentRoutes` и тулы `synth_agent_*` передают его в
 * `publishAgentsUpdated`.
 */
export type AgentsChangedHook = (info: AgentChangedInfo) => void;

/**
 * Опубликовать `agents.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). Падение
 * обработчиков-подписчиков не должно ломать запрос/тул: шина уже ловит
 * исключения подписчиков сама (`EventBus._publish`), здесь дополнительных
 * try/catch нет — публикация синхронная и без сетевого ввода-вывода.
 */
export function publishAgentsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: AgentChangedInfo,
): void {
  if (!bus) return;
  const data: AgentsUpdatedEventData = { action: info.action };
  if (info.id) data.id = info.id;
  bus.publishInstance('agents.updated', data);
}

/** Готовый хук для фабрики роутов: `onAgentsChanged` поверх шины. */
export function agentsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): AgentsChangedHook {
  return (info) => publishAgentsUpdated(bus, info);
}
