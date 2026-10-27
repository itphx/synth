/**
 * ADR-089: домен внешних событий — нормализованное `Event`, устойчивая `Binding`
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

/** ADR-089: идентичность отправителя события (маппинг на RBAC — ADR-029/ADR-043). */
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

/**
 * ADR-115 × ADR-089: ссылка на вложение внешнего события.
 *
 * Шлюз (Telegram/VK/…) сначала загружает байты в staging (`POST /api/v2/attachments`)
 * и передаёт в событии **ссылку** на объект blob-хранилища — сами байты через
 * событие не идут. Метаданные дублируются в событии, чтобы адресат мог проверить
 * их совпадение со sidecar объекта (подмена ссылки на чужой/изменённый объект
 * отклоняется на приёме).
 */
export interface EventAttachmentRef {
  /** Путь объекта в blob-хранилище (`attachments/<sha2>/<sha256>`). */
  blobPath: string;
  /** SHA-256 содержимого (content-addressed). */
  sha256: string;
  /** MIME-тип по содержимому. */
  mime: string;
  /** Размер в байтах. */
  size: number;
  /** Имя файла (санитайз; в `blobPath` не входит). */
  name?: string;
}

/** ADR-089: нормализованное внешнее событие (источник-специфика — в `payload`). */
export interface SynthEvent {
  /** `'evt_<uuid>'`, уникален в пределах инстанса. */
  id: string;
  source: string;
  /** `'message' | 'callback' | 'webhook' | 'schedule' | 'ci_event' | 'session.requested'`. */
  type: string;
  /** Нормализованное тело: текст, ссылки на вложения (PROP-085), метаданные. */
  payload: unknown;
  identity: EventIdentity;
  /** Стабильный ключ идемпотентности. */
  dedupKey: string;
  /** Время события, ISO-8601. */
  ts: string;
  /**
   * ADR-115 × ADR-089: вложения события — ссылки на объекты blob-хранилища.
   * Аддитивное поле: события без вложений его не несут. Если поле непусто,
   * `dedupKey` обязан быть задан явно (иначе ключ идемпотентности менялся бы
   * от содержимого вложений).
   */
  attachments?: EventAttachmentRef[];
}

/** ADR-089: устойчивая привязка внешнего адреса к сессии/шаблону. */
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
  /** Шаблон агента/скилла для создания/настройки сессии (ADR-046). */
  agentTemplate?: string;
  /** `projectId` — контейнер сессии (ADR-014). */
  project?: string;
}

/** ADR-089/ADR-052: API-ключ привязки для аутентификации приёма событий. */
export interface EventBindingApiKey {
  /** `eak_<uuid>`. */
  id: string;
  bindingId: string;
  /** Обязательная уникальная (глобально по инстансу) метка ключа. */
  label: string;
  /** Опциональное описание назначения ключа. */
  description?: string;
  /**
   * Опциональный лимит запросов в минуту для этого ключа (ADR-089/ADR-052).
   * Не задан — глобальный дефолт `events.keyRateLimitPerMinute`; `0` — без лимита.
   */
  rateLimitPerMinute?: number;
  /** id создателя (пользователя). */
  createdBy: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601; best-effort, обновляется при использовании. */
  lastUsedAt?: string;
  /** Префикс ключа для идентификации в UI (секрет наружу не отдаётся). */
  prefix: string;
  /**
   * ADR-052 (задел): ISO-8601 срок действия ключа. Заполнен и уже прошёл —
   * ключ недействителен (`resolveBySecret` → `null`). Не задан — бессрочно.
   */
  expiresAt?: string;
  /**
   * ADR-052 (задел): ISO-8601 отзыв ключа (мягкое удаление). Заполнен —
   * ключ недействителен независимо от срока (`EventApiKeyStore.revoke`).
   */
  revokedAt?: string;
}

/** ADR-089: ответ создания ключа — метаданные + однократно показываемый секрет. */
export interface EventBindingApiKeyCreated extends EventBindingApiKey {
  /** Plaintext-секрет; возвращается единственный раз при создании. */
  key: string;
}

/**
 * ADR-089: ссылка на шаг пайплайна — «эта сессия — шаг `step` пайплайна `id`».
 *
 * Ссылка живёт в цели правила маршрутизации (`ephemeral`/`bind`) и прокидывается
 * в решение Router'а: на ней строится учёт экземпляров пайплайна и гейты
 * (напр. правило по событию `draft_approved` — это гейт «после approve»).
 */
export interface PipelineRef {
  /** id пайплайна (определения/экземпляра). */
  id: string;
  /** id шага внутри пайплайна. */
  step: string;
}

/**
 * ADR-089: цель правила маршрутизации (та же семантика, что у
 * `EventBinding`/`ScheduleTarget`).
 */
export type EventRouteTarget =
  | { mode: 'bound'; sessionId: string }
  | { mode: 'ephemeral'; agentTemplate?: string; project?: string; ttl?: string; pipeline?: PipelineRef }
  | { mode: 'queue'; sessionId: string }
  /**
   * ADR-089 (auto-bind): правило закрепляет внешний адрес события
   * (`chatKey`/`threadKey`) за сессией — Router создаёт `EventBinding`
   * (`mode='bound'`) при первой доставке.
   */
  | { mode: 'bind'; agentTemplate?: string; project?: string; pipeline?: PipelineRef };

/** ADR-089: условие срабатывания правила (AND по заполненным полям). */
export interface EventRouteMatch {
  source?: string;
  type?: string;
  chatKey?: string;
  threadKey?: string;
  principalId?: string;
  /** Метка в `payload.label`. */
  label?: string;
  /** Подстроки в тексте события (регистронезависимо; достаточно одного). */
  keywords?: string[];
}

/** ADR-089: правило маршрутизации событий «событие → сессия» (проектные/инстанс-правила). */
export interface EventRouteRule {
  /** `rule_<uuid>`, уникален в пределах инстанса. */
  id: string;
  name?: string;
  /** Больше = раньше; при равенстве — порядок в файле. */
  priority: number;
  enabled: boolean;
  match: EventRouteMatch;
  target: EventRouteTarget;
}

/**
 * ADR-089/ADR-084: диагностическая мета решения Router. Необязательные поля,
 * не ломают дискриминант `kind`; заполняются decision-слоем (`confidence`)
 * и маршрутизацией (`signals`) — попадают в ответ `POST /events` и в журнал.
 */
export interface RouteDecisionMeta {
  /** Уверенность decision-модели (0..1), если решение принято decision-слоем. */
  confidence?: number;
  /**
   * Диагностические сигналы решения (напр. `decision-rules`, `agent:<id>`,
   * `model:<p/m>`, `latency:<ms>ms`).
   */
  signals?: string[];
}

/** ADR-089: вариант решения Router без меты (дискриминант `kind`). */
type RouteDecisionKind =
  | { kind: 'bound'; sessionId: string }
  | { kind: 'ephemeral'; agentTemplate: string; ttl: string; project?: string; pipeline?: PipelineRef }
  | { kind: 'queue'; owner: string; reason: string }
  | { kind: 'drop'; reason: string; audited: true }
  /**
   * ADR-089 (auto-bind): Router решает закрепить событие за новой сессией —
   * `RequestSessionService` создаёт сессию без `expiresAt` и `EventBinding`
   * (`mode='bound'`), после чего доставляет событие. Источник решения — фоллбек
   * при `events.autoBind` и наличии `identity.chatKey|threadKey`, либо правило
   * с целью `mode: 'bind'`.
   */
  | { kind: 'bind'; agentTemplate: string; project?: string; pipeline?: PipelineRef };

/**
 * ADR-089: решение Router — куда направить событие (или отложить/отбросить).
 *
 * `pipeline` (ссылка на шаг пайплайна) — **семантическое** поле решения, а не
 * диагностическая мета: оно задано только у вариантов `ephemeral`/`bind`
 * (там, где решение порождает сессию) и потому живёт в вариантах
 * `RouteDecisionKind`, а не в `RouteDecisionMeta` (мета — диагностика:
 * `confidence`/`signals`).
 */
export type RouteDecision = RouteDecisionKind & RouteDecisionMeta;

/** ADR-089: инициатор запроса на сессию. */
export type EventInitiator = 'user' | 'agent' | 'external' | 'system';

/**
 * ADR-089: намерение создать/привязать сессию — единый funnel. Создание сессии
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
  /** Происхождение сессии (`user`/`fork`/`subagent`) — паритет с createSession. */
  sessionOrigin?: SessionOrigin;
  settings?: Partial<SessionSettings>;
  /** id исходного события, инициировавшего запрос. */
  sourceEventId?: string;
  dedupKey?: string;
}
