/**
 * Событие шины `memory.updated` — **память инстанса изменилась** (ADR-107).
 *
 * ## Зачем единый шов
 *
 * Память мутируют **два** контура, и оба должны публиковать событие:
 *
 * 1. **портал** (`createMemoryRoutes`, `/api/v2/memory`): индекс создан,
 *    пересобран, удалён, включён/выключен; факты слиты консолидацией;
 * 2. **плагин памяти** (`facade.memory`, `plugin:<имя>`-namespace): факт
 *    записан (`memory_write`), исправлен/снят (`memory_forget`), слит
 *    консолидацией — то есть **агент в чате** пишет память мимо портала.
 *
 * Портал и плагин приходят в одни и те же порты, поэтому публикация
 * посажена на **запись** (chokepoint): `engine/plugins/scoped-memory.ts`
 * публикует событие на каждой мутации факта/индекса плагина. Так «роут
 * публикует, плагин молчит» невозможно по построению: путь мутации у них
 * общий. Единственное исключение — `PATCH /indexes/:id` (переключатель
 * `enabled`): он пишет порт напрямую, мимо фасада, и публикует сам.
 *
 * Без события UI «залипает»: `MemorySettings` держит три среза (статус, факты,
 * индексы) в состоянии компонента и перечитывает их только по своей мутации
 * или по кнопке «Обновить». Факт, записанный агентом, или индекс, созданный
 * другим админом, видны лишь после перезагрузки страницы (инвариант 27
 * `AGENTS.md`).
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): память — ресурс инстанса, а не сессии; новых транспортных каналов
 *   не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ scope, action, id? }` (`MemoryUpdatedEventData`):
 *   клиент перечитывает портал своими обычными запросами (`GET /memory/status`,
 *   `GET /memory/facts`, `GET /memory/indexes`). **Ни текста фактов, ни
 *   эмбеддингов, ни поисковых запросов, ни содержимого корпуса** в событии нет —
 *   это свойство типа payload'а, а не соглашение вызывающих (память — это
 *   пользовательские данные, docs/MEMORY.md §10; инвариант 13 `AGENTS.md`);
 * - публикация — **только после успешной записи**: 400/403/404/409 и no-op
 *   (запись не изменилась) молчат;
 * - шина **необязательна**: без неё (тесты, сторонние потребители) фабрики и
 *   scoped-обёртка работают как раньше — событие не публикуется, падений нет.
 */
import type { MemoryChangeAction, MemoryChangeScope, MemoryUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в памяти (payload `memory.updated`). */
export interface MemoryChangedInfo {
  /** Область памяти: факты или индексы. */
  scope: MemoryChangeScope;
  /** Вид мутации. */
  action: MemoryChangeAction;
  /** id записи, которой коснулась мутация (не задан — изменение целиком). */
  id?: string;
}

/**
 * Хук «память изменилась» — вызывается **после** успешной записи;
 * `createMemoryRoutes` передаёт его в `publishMemoryUpdated`.
 */
export type MemoryChangedHook = (info: MemoryChangedInfo) => void;

/**
 * Опубликовать `memory.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload уходят
 * только область, вид мутации и id записи: текст факта, эмбеддинги и поисковые
 * запросы в событие не попадают.
 */
export function publishMemoryUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: MemoryChangedInfo,
): void {
  if (!bus) return;
  const data: MemoryUpdatedEventData = { scope: info.scope, action: info.action };
  if (info.id) data.id = info.id;
  bus.publishInstance('memory.updated', data);
}

/** Готовый хук для фабрик роутов: `onMemoryChanged` поверх шины. */
export function memoryChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): MemoryChangedHook {
  return (info) => publishMemoryUpdated(bus, info);
}
