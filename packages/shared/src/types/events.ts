/**
 * AD-089: домен внешних событий — нормализованное `Event`, устойчивая `Binding`
 * и решение Router. Контракты без бизнес-логики: сам Router/приём событий живут
 * в core, здесь только типы.
 */
import type { SessionOrigin, SessionSettings } from './index.js';

/**
 * Источник события. Свободная строка, известные значения: `'telegram'`,
 * `'synth-media'`, `'webhook'`, `'cron'`, `'ci'`, `'ui'`.
 */
export type EventSource = string;

/** Режим обработки события: `drop` — осознанный отказ с аудитом. */
export type EventMode = 'bound' | 'ephemeral' | 'queue' | 'drop';

/** Режим доставки события в `EventBinding` (без `drop`). */
export type EventDeliveryMode = Exclude<EventMode, 'drop'>;

/** AD-089: идентичность отправителя события (маппинг на RBAC — AD-029/AD-043). */
export interface EventIdentity {
  /** Внешний идентификатор пользователя. */
  principalId?: string;
  /** Ключ чата: `'chat:<source>:<chatId>'`. */
  chatKey?: string;
  /** Ключ треда/топика: `'thread:<source>:<chatId>:<threadId>'`. */
  threadKey?: string;
  /** Роли для маппинга на RBAC. */
  roles?: string[];
}

/** AD-089: нормализованное внешнее событие (источник-специфика — в `payload`). */
export interface SynthEvent {
  /** `'evt_<uuid>'`, уникален в пределах инстанса. */
  id: string;
  source: string;
  /** `'message' | 'callback' | 'webhook' | 'schedule' | 'ci_event' | 'session.requested'`. */
  type: string;
  /** Нормализованное тело: текст, ссылки на вложения (AD-085), метаданные. */
  payload: unknown;
  identity: EventIdentity;
  /** Стабильный ключ идемпотентности. */
  dedupKey: string;
  /** Время события, ISO-8601. */
  ts: string;
}

/** AD-089: устойчивая привязка внешнего адреса к сессии/шаблону. */
export interface EventBinding {
  id: string;
  source: string;
  /** Привязка на чат. */
  chatKey?: string;
  /** Привязка на тред/топик (приоритетнее чата). */
  threadKey?: string;
  /** Конкретная постоянная сессия (mode=`bound`). */
  sessionId?: string;
  mode: EventDeliveryMode;
  /** Шаблон агента/скилла для создания/настройки сессии (AD-046). */
  agentTemplate?: string;
  /** `projectId` — контейнер сессии (AD-014). */
  project?: string;
}

/** AD-089: решение Router — куда направить событие (или отложить/отбросить). */
export type RouteDecision =
  | { kind: 'bound'; sessionId: string }
  | { kind: 'ephemeral'; agentTemplate: string; ttl: string }
  | { kind: 'queue'; owner: string; reason: string }
  | { kind: 'drop'; reason: string; audited: true };

/** AD-089: инициатор запроса на сессию. */
export type EventInitiator = 'user' | 'agent' | 'external' | 'system';

/**
 * AD-089: намерение создать/привязать сессию — единый funnel. Создание сессии
 * обрабатывается тем же Router'ом, независимо от инициатора.
 */
export interface SessionRequest {
  initiator: EventInitiator;
  intent: 'explicit' | 'event';
  projectId?: string;
  parentId?: string;
  agentTemplate?: string;
  mode?: EventDeliveryMode;
  /** TTL для режима `ephemeral` (напр. `'24h'`). */
  ttl?: string;
  title?: string;
  /** Канонический ключ иконки (PROJECT_ICON_KEYS). */
  icon?: string;
  /** Канонический ключ цвета (PROJECT_COLOR_KEYS). */
  color?: string;
  engine?: string;
  /** Происхождение сессии (`user`/`fork`/`subagent`) — паритет с createSession. */
  sessionOrigin?: SessionOrigin;
  settings?: Partial<SessionSettings>;
  /** id исходного события, инициировавшего запрос. */
  sourceEventId?: string;
  dedupKey?: string;
}
