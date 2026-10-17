/**
 * ADR-052 (этап II): исходящие webhooks — подписки и журнал доставок. Здесь
 * только контракты (browser-safe): сами хранилище и движок доставки живут в core.
 */

/** Префикс signing-секрета подписки (`whsec_<base64url>`). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Статус доставки: `pending` — зарезервирован под асинхронную запись. */
export type WebhookDeliveryStatus = 'ok' | 'failed' | 'pending';

/**
 * Дефолтный набор паттернов событий подписки (пустой `events` = этот набор).
 * Паттерн — точный тип (`stream.done`) либо префикс `prefix.*` (`session.*`).
 * Набор намеренно исключает высокочастотный стриминг (`stream.chunk`/`usage`),
 * оставляя интеграционно значимые вехи: жизненный цикл сессий, сообщения,
 * завершение/ошибка стрима, план/todo, проект, файлы и события Router.
 */
export const DEFAULT_WEBHOOK_EVENT_PATTERNS = [
  'session.*',
  'message.added',
  'stream.done',
  'stream.error',
  'plan.approved',
  'todos.updated',
  'project.updated',
  'fs.changed',
  'event.*',
  'binding.changed',
] as const;

/**
 * Проверяет, матчит ли тип события список паттернов подписки.
 * Пустой/отсутствующий список — дефолтный набор (`DEFAULT_WEBHOOK_EVENT_PATTERNS`).
 * Паттерн `foo.*` матчит любой тип, начинающийся с `foo.`; иначе — точное совпадение.
 */
export function matchWebhookEvent(
  patterns: readonly string[] | undefined,
  eventType: string,
): boolean {
  const list = patterns && patterns.length > 0 ? patterns : DEFAULT_WEBHOOK_EVENT_PATTERNS;
  for (const pattern of list) {
    if (pattern.endsWith('.*')) {
      if (eventType.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === eventType) {
      return true;
    }
  }
  return false;
}

/** Формат паттерна события: `foo.bar` либо `foo.*` (без пробелов/пустых сегментов). */
export function isWebhookEventPattern(value: string): boolean {
  const pattern = value.trim();
  if (!pattern) return false;
  if (pattern.endsWith('.*')) {
    return /^[a-z0-9_]+(\.[a-z0-9_]+)*\.\*$/.test(pattern);
  }
  return /^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(pattern);
}

/**
 * ADR-052 (этап II): подписка на исходящие события. Секрет подписи (`secret`)
 * наружу не отдаётся — только `secretPrefix`; полный секрет возвращается
 * единственный раз в `WebhookSubscriptionCreated`.
 */
export interface WebhookSubscription {
  /** `whk_<uuid>`. */
  id: string;
  /** Обязательная метка (уникальна глобально по инстансу, регистронезависимо). */
  label: string;
  description?: string;
  /** Целевой URL (https; http — только при `egress.webhooks.mode: 'off'`). */
  url: string;
  /** Паттерны событий (exact или `prefix.*`); пусто — дефолтный набор. */
  events: string[];
  /** Активна ли подписка (мастер-выключатель подписки). */
  enabled: boolean;
  /** Префикс signing-секрета для идентификации в UI. */
  secretPrefix: string;
  /** id создателя (пользователя/сервиса). */
  createdBy: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601; best-effort, обновляется при доставке. */
  lastDeliveryAt?: string;
  /** Итог последней доставки. */
  lastStatus?: 'ok' | 'failed';
  /** ISO-8601 мягкого отключения (`enabled=false`). */
  disabledAt?: string;
}

/** Ответ создания/ротации подписки — метаданные + однократный signing-секрет. */
export interface WebhookSubscriptionCreated extends WebhookSubscription {
  /** Plaintext signing-секрет `whsec_<base64url>`; возвращается единственный раз. */
  secret: string;
}

/** ADR-052 (этап II): запись журнала доставки webhook. */
export interface WebhookDelivery {
  /** `whd_<uuid>`. */
  id: string;
  subscriptionId: string;
  /** Тип события, инициировавшего доставку (`webhook.test` — тестовая). */
  eventType: string;
  status: WebhookDeliveryStatus;
  /** Число выполненных HTTP-попыток. */
  attempts: number;
  /** HTTP-статус последнего ответа, если был. */
  responseStatus?: number;
  /** Текст ошибки при неуспехе. */
  error?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601 завершения доставки. */
  completedAt?: string;
}

/** ADR-052 (этап II): тело создания подписки (`POST /api/v2/webhooks`). */
export interface CreateWebhookSubscriptionInput {
  label: string;
  description?: string;
  url: string;
  events?: string[];
  enabled?: boolean;
}

/**
 * ADR-052 (этап II): тело обновления подписки. `undefined` — не трогать;
 * `null` — сбросить опциональное значение (`description`).
 */
export interface UpdateWebhookSubscriptionPatch {
  label?: string;
  description?: string | null;
  url?: string;
  events?: string[];
  enabled?: boolean;
}
