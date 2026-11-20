/**
 * Событие шины `mcp.updated` — **реестр MCP-серверов инстанса изменился**.
 *
 * ## Зачем единый шов
 *
 * Мутировать реестр MCP можно двумя путями: HTTP-роуты (`createMcpRegistryRoutes`:
 * `/servers*`, `/registry*`, `/session/:sessionId`; проектный скоуп —
 * `PUT /projects/:id/mcp`) и тулы самообслуживания (`synth_mcp_add|update|
 * remove|enable`, `engine/tools/instance-mcp.ts`). Если событие публикует
 * только один путь, второй «молчит»: панели MCP (админская, пользовательская,
 * «Внешние доступы») и селекторы серверов показывают устаревший состав до
 * перезагрузки страницы. Поэтому публикация — здесь, один помощник на оба пути.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): реестр MCP — ресурс инстанса, а не сессии; новых транспортных
 *   каналов не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ name, action, scope?, sessionId?, projectId? }`
 *   (`McpUpdatedEventData`): клиент перечитывает реестр своим обычным запросом
 *   (`GET /mcp/registry`);
 * - **секреты в событие не попадают никогда**: конфиг сервера (`config`, `env`,
 *   `headers`, `auth`) в payload не кладётся — в нём бывают токены (инвариант 13
 *   `AGENTS.md`). Это свойство типа payload'а, а не соглашение вызывающих;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрики работают как раньше — событие не публикуется, падений нет.
 */
import type {
  EventType,
  McpChangeAction,
  McpChangeScope,
  McpUpdatedEventData,
} from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/**
 * Минимальный контракт шины для события в **канал сессии** (`EventBus.publish`).
 *
 * Нужен роуту `PUT /mcp/session/:sessionId`: смена MCP-скоупа сессии — это
 * `session.updated` в канал этой сессии (паритет с тулом `synth_mcp_enable`,
 * `level: 'session'`), а не инстансное событие.
 */
export interface SessionEventPublisherLike {
  publish(channel: string, type: EventType, data?: Record<string, unknown>): void;
}

/** Что изменилось в реестре MCP (payload события `mcp.updated`). */
export interface McpChangedInfo {
  /** Имя сервера, которого коснулась мутация (не задано — изменение целиком). */
  name?: string;
  /** Вид мутации. */
  action: McpChangeAction;
  /** Область уровневой операции (реестр инстанса — не задана). */
  scope?: McpChangeScope;
  /** Сессия, чей MCP-скоуп изменён (`scope: 'session'`). */
  sessionId?: string;
  /** Проект, чей MCP-скоуп изменён (`scope: 'project'`). */
  projectId?: string;
}

/**
 * Хук «состав реестра MCP изменился» — вызывается **после** успешной записи;
 * `createMcpRegistryRoutes`/`createProjectRoutes` и тулы `synth_mcp_*`
 * передают его в `publishMcpUpdated`.
 */
export type McpChangedHook = (info: McpChangedInfo) => void;

/**
 * Опубликовать `mcp.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload
 * уходят только имя/вид мутации/область: конфиг сервера (а с ним `env`,
 * `headers`, `auth`) в событие не попадает — в нём бывают секреты.
 */
export function publishMcpUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: McpChangedInfo,
): void {
  if (!bus) return;
  const data: McpUpdatedEventData = { action: info.action };
  if (info.name) data.name = info.name;
  if (info.scope) data.scope = info.scope;
  if (info.sessionId) data.sessionId = info.sessionId;
  if (info.projectId) data.projectId = info.projectId;
  bus.publishInstance('mcp.updated', data);
}

/** Готовый хук для фабрики роутов: `onMcpChanged` поверх шины. */
export function mcpChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): McpChangedHook {
  return (info) => publishMcpUpdated(bus, info);
}
