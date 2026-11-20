/**
 * Событие шины `credentials.updated` — **внешние доступы инстанса изменились**
 * (ADR-105).
 *
 * ## Зачем единый шов
 *
 * Слой внешних доступов мутирует одна фабрика (`createOAuthRoutes`), но
 * write-путей у неё несколько: выдача (`POST /credentials` — authorize и device
 * flow), отзыв (`DELETE /credentials/:id`), обновление токена
 * (`POST /credentials/:id/refresh`) и привязка к MCP-коннектору
 * (`POST /credentials/:id/bind`). Если событие публикует только часть путей,
 * раздел «Внешние доступы» показывает устаревший список: доступ, выданный в
 * другом клиенте (или в соседней вкладке), виден только после перезагрузки
 * страницы — ровно та же дыра, что была у реестров агентов/MCP/скиллов/моделей.
 *
 * ## Контракт
 *
 * - канал — **инстансный** (`EventBus.publishInstance`, `INSTANCE_EVENT_CHANNEL`,
 *   ADR-118): доступ — ресурс инстанса, а не сессии; новых транспортных каналов
 *   не заводим (инвариант 6 `AGENTS.md`);
 * - payload минимальный — `{ credentialId?, provider?, action }`
 *   (`CredentialsUpdatedEventData`): клиент перечитывает список своим обычным
 *   запросом (`GET /oauth/credentials`);
 * - **токены в событие не попадают никогда**: `access_token`/`refresh_token`,
 *   маска секрета и прочие детали записи в payload не кладутся (инвариант 13
 *   `AGENTS.md`). Это свойство типа payload'а, а не соглашение вызывающих;
 * - в managed-режиме событие **не** входит в «пользовательские»
 *   (`USER_FACING_INSTANCE_EVENTS`): доступы — админский ресурс, обычному
 *   пользователю список не нужен;
 * - хук публикации **необязателен**: без шины (тесты, сторонние потребители)
 *   фабрика работает как раньше — событие не публикуется, падений нет.
 */
import type { CredentialChangeAction, CredentialsUpdatedEventData } from '@itphx/synth-shared';
// Контракт шины переиспользуем у соседнего шва (`agents.updated`) — тот же
// минимум (`publishInstance`), дублировать тип незачем.
import type { InstanceEventPublisherLike } from './agents-events.js';

export type { InstanceEventPublisherLike };

/** Что изменилось в слое внешних доступов (payload `credentials.updated`). */
export interface CredentialsChangedInfo {
  /** id записи доступа (не задан — изменение слоя доступов целиком). */
  credentialId?: string;
  /** OAuth-провайдер, которого коснулась мутация. */
  provider?: string;
  /** Вид мутации. */
  action: CredentialChangeAction;
}

/**
 * Хук «слой внешних доступов изменился» — вызывается **после** успешной
 * записи; `createOAuthRoutes` передаёт его в `publishCredentialsUpdated`.
 */
export type CredentialsChangedHook = (info: CredentialsChangedInfo) => void;

/**
 * Опубликовать `credentials.updated` в инстансный канал шины.
 *
 * `bus` не задан — no-op (хук необязателен, поведение прежнее). В payload
 * уходят только id записи, провайдер и вид мутации: токены и маска секрета в
 * событие не попадают.
 */
export function publishCredentialsUpdated(
  bus: InstanceEventPublisherLike | undefined | null,
  info: CredentialsChangedInfo,
): void {
  if (!bus) return;
  const data: CredentialsUpdatedEventData = { action: info.action };
  if (info.credentialId) data.credentialId = info.credentialId;
  if (info.provider) data.provider = info.provider;
  bus.publishInstance('credentials.updated', data);
}

/** Готовый хук для фабрики роутов: `onCredentialsChanged` поверх шины. */
export function credentialsChangedPublisher(
  bus: InstanceEventPublisherLike | undefined | null,
): CredentialsChangedHook {
  return (info) => publishCredentialsUpdated(bus, info);
}
