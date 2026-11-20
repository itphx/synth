/**
 * Событие шины `execution.updated` — **каталог профилей исполнения изменился**.
 *
 * ## Зачем единый шов
 *
 * Каталог профилей исполнения (ADR-135) мутируют две фабрики роутов:
 * `createSettingsRoutes` (`PUT /settings/execution` — сохранение runtime-каталога
 * целиком, `DELETE /settings/execution` — сброс к config-уровню) и
 * `createExecutionRoutes` (пулы: `POST /pools/:key/drain`, `DELETE /pools/:key`).
 * Если событие не публикуется, UI держит устаревший каталог: селекторы профиля
 * (агент в админ-панели, проект, настройки сессии) читают каталог **один раз**
 * при монтировании, поэтому профиль, созданный или переименованный в разделе
 * «Исполнение», не появляется в выпадающем списке до перезагрузки страницы.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): каталог профилей — ресурс инстанса, а не сессии; новых
 *   транспортных каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ action, profileId?, poolName? }`
 *   (`ExecutionUpdatedEventData`): клиент перечитывает каталог своими обычными
 *   запросами (`GET /execution/profiles`, `GET /execution/pools`,
 *   `GET /settings/execution`);
 * - **адреса исполнителей и токены в событие не попадают никогда** (инвариант 13
 *   `AGENTS.md`): ни URL профиля, ни токен provisioner'а, ни env/args
 *   MCP-серверов профиля в payload не кладутся — это свойство типа payload'а, а
 *   не соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрики работают как раньше — событие не публикуется, падений нет.
 */
import type { ExecutionChangeAction, ExecutionUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в каталоге профилей исполнения (payload `execution.updated`). */
export interface ExecutionChangedInfo {
  /** Профиль, которого коснулась мутация (не задан — изменение каталога целиком). */
  profileId?: string;
  /** Пул, которого коснулась мутация (не задан — профили, не пулы). */
  poolName?: string;
  /** Вид мутации. */
  action: ExecutionChangeAction;
}

/**
 * Хук «каталог профилей исполнения изменился» — вызывается **после** успешной
 * записи; `createSettingsRoutes`/`createExecutionRoutes` передают его в
 * `publishExecutionUpdated`.
 */
export type ExecutionChangedHook = (info: ExecutionChangedInfo) => void;

/**
 * Опубликовать `execution.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только id профиля/имя пула и вид мутации: адреса исполнителей и токены
 * provisioner'а в событие не попадают.
 */
export function publishExecutionUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: ExecutionChangedInfo,
): void {
  if (!bus) return;
  const data: ExecutionUpdatedEventData = { action: info.action };
  if (info.profileId) data.profileId = info.profileId;
  if (info.poolName) data.poolName = info.poolName;
  bus.publishInstance('execution.updated', data);
}

/** Готовый хук для фабрик роутов: `onExecutionChanged` поверх шины. */
export function executionChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): ExecutionChangedHook {
  return (info) => publishExecutionUpdated(bus, info);
}
