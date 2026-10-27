import type { TokenUsage } from './llm.js';
import type { PromptMeta } from './prompt.js';
import type { AuthorityPrincipal } from './authority.js';

// --- Message role ---

export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
  SUMMARY = 'summary',
  DEBUG = 'debug',
  INFO = 'info',
  ERROR = 'error',
}

// --- Part ---
/**
 * Типы частей сообщения.
 *
 * ADR-115: к текстовым/служебным добавлены медиа-типы (`image`/`audio`/
 * `video`/`file`) — вложения сообщений. Текстовые части не меняются
 * (обратная совместимость).
 */
export type PartType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'reasoning'
  | 'session_reference'
  | 'image'
  | 'audio'
  | 'video'
  | 'file';

/** Медиа-типы части сообщения (ADR-115) — вложение. */
export type MediaPartType = 'image' | 'audio' | 'video' | 'file';

/**
 * ADR-115 §«Модель контента»: данные медиа-части — ссылка на blob в
 * blob-хранилище + метаданные. Байты в сообщении не лежат (том, ADR-116),
 * поэтому часть переносима и переживает пересборку бэкапа.
 */
export interface MediaPartData {
  /** Путь объекта в blob-хранилище (`attachments/<sha2>/<sha256>`). */
  blobPath: string;
  /** SHA-256 содержимого (content-addressed, дедуп/GC). */
  sha256: string;
  /** MIME-тип по содержимому. */
  mime: string;
  /** Размер в байтах. */
  size: number;
  /** Имя файла (санитайз; в `blobPath` не входит). */
  name?: string;
  /** Ширина изображения/кадра, px. */
  width?: number;
  /** Высота изображения/кадра, px. */
  height?: number;
  /** Длительность аудио/видео, мс. */
  durationMs?: number;
  /**
   * Текстовая расшифровка (ASR/OCR/извлечение из документа) — подставляется
   * в контекст вместо байтов.
   */
  transcript?: string;
}

export interface Part {
  id: string;
  type: PartType;
  data: unknown;
}

// --- MessageOrigin ---
export type MessageOrigin = 'local' | 'inherited' | 'merged' | 'crosspost';

/**
 * metadata.i18n сообщения/tool_result (i18n ядра): стабильный en-like ключ
 * системного сообщения + параметры подстановки. UI рендерит перевод по ключу
 * (formatMessage), fallback — на content (en). Плейсхолдеры — `{param}`.
 */
export interface MessageI18n {
  key: string;
  params?: Record<string, string>;
}

// --- Message ---
export interface Message {
  id: string;
  role: MessageRole;
  seq: number;
  origin: MessageOrigin;
  sourceMsgId?: string;
  parts: Part[];
  content: string;
  toolCalls?: Record<string, unknown>[];
  toolCallId?: string;
  createdAt: string;
  disabled: boolean;
  pinned: boolean;
  hidden: boolean;
  /**
   * ADR-046 §7.1: сообщение локальной `/`-команды (builtin-ответ) — видно в
   * истории, но исключается из LLM-контекста.
   */
  ephemeral?: boolean;
  debugData?: Record<string, unknown>;
  model?: string;
  provider?: string;
  providerType?: string;
  usage?: TokenUsage;
  reasoning?: string;
  source?: 'web' | 'cli' | 'api';
  author?: string;
  /**
   * ADR-106 Ф0: принципал ввода (аддитивное поле). `author` остаётся
   * display-строкой для UI — принципал даёт машиночитаемую атрибуцию
   * («кто это сделал») без изменения существующих потребителей.
   */
  principal?: AuthorityPrincipal;
  agentRole?: string;
  metadata?: Record<string, unknown>;
  /** ADR-070 §2.4: предсказание/валидация prompt-cache для этого хода. */
  promptMeta?: PromptMeta;
  summaryOf?: number[];
  qa_pass?: boolean;
  qa_reason?: string;
}
