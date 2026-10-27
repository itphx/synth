/**
 * Полное логирование запросов/ответов LLM: append-only JSONL, одна строка = одна запись.
 * Данные пишутся ПОСЛЕ обфускации — секреты (реальные значения) в лог не попадают.
 * Запись не должна ронять запрос: при ошибке — warning и продолжение.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TokenUsage } from '@itphx/synth-shared';
import type { LLMAttachment, LLMMessage, SystemPromptInput } from '../../providers/base.js';
import { warning } from '../../logger.js';

/**
 * ADR-115 §«Gateway»: сводка вложения для полного лога — **без base64**.
 * В журнал попадают только MIME, имя и размер; содержимое не логируется.
 */
export interface LlmPayloadAttachmentSummary {
  mime: string;
  name?: string;
  sizeBytes: number;
}

/** Сообщение в полном логе: вложения заменены сводкой без base64. */
export interface LlmPayloadMessage extends Omit<LLMMessage, 'attachments'> {
  attachments?: LlmPayloadAttachmentSummary[];
}

export interface LlmPayloadRequest {
  messages: LlmPayloadMessage[];
  systemPrompt?: SystemPromptInput;
}

export interface LlmPayloadResponse {
  content: string;
  usage?: TokenUsage;
}

/** Вход записи полного лога (сообщения — как есть, с base64 вложений). */
export interface LlmPayloadEntryInput {
  ts: string;
  sessionId?: string;
  userId?: string;
  provider?: string;
  model?: string;
  request: {
    messages: LLMMessage[];
    systemPrompt?: SystemPromptInput;
  };
  response: LlmPayloadResponse;
}

export interface LlmPayloadEntry {
  ts: string;
  sessionId?: string;
  userId?: string;
  provider?: string;
  model?: string;
  request: LlmPayloadRequest;
  response: LlmPayloadResponse;
}

/** Размер base64-строки в байтах исходных данных (без декодирования). */
export function base64SizeBytes(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * ADR-115: заменить вложения на сводку `{mime, name?, sizeBytes}`.
 * Сообщения без вложений возвращаются тем же объектом (лог не меняется).
 */
export function summarizeMessagesForPayloadLog(
  messages: readonly (LLMMessage | LlmPayloadMessage)[],
): LlmPayloadMessage[] {
  return messages.map((message) => {
    const attachments = message.attachments as readonly (LLMAttachment | LlmPayloadAttachmentSummary)[] | undefined;
    if (!attachments || attachments.length === 0) {
      // Без вложений запись в лог не меняется (base64-полей нет).
      const { attachments: _unused, ...rest } = message;
      void _unused;
      return rest as LlmPayloadMessage;
    }
    const { attachments: _unused, ...rest } = message;
    void _unused;
    return {
      ...rest,
      attachments: attachments.map((attachment) =>
        'base64' in attachment
          ? {
              mime: attachment.mime,
              ...(attachment.name ? { name: attachment.name } : {}),
              sizeBytes: base64SizeBytes(attachment.base64),
            }
          : attachment,
      ),
    } as LlmPayloadMessage;
  });
}

/** Функциональная обёртка записи одной записи полного лога в JSONL-файл. */
export async function writePayloadLog(
  logPath: string,
  entry: LlmPayloadEntryInput | LlmPayloadEntry,
): Promise<void> {
  // ADR-115: base64 вложений в журнал не попадает — только сводка.
  const sanitized: LlmPayloadEntry = {
    ...entry,
    request: {
      ...entry.request,
      messages: summarizeMessagesForPayloadLog(entry.request.messages),
    },
  };
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(sanitized)}\n`, { encoding: 'utf8' });
  } catch (e) {
    warning('GATEWAY', `Ошибка записи полного лога: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Фильтры чтения JSONL полного лога. */
export interface PayloadLogQuery {
  sessionId?: string;
  /** Сколько последних записей вернуть (по умолчанию 100). */
  limit?: number;
}

/**
 * Читает append-only JSONL полного лога, парсит построчно и фильтрует.
 * Если файла нет или строка повреждена — строка пропускается, файла нет —
 * возвращается пустой результат (без ошибки). `entries` — последние `limit`
 * записей, `total` — количество после фильтрации (до лимита).
 */
export async function readPayloadLog(
  logPath: string,
  query: PayloadLogQuery = {},
): Promise<{ entries: LlmPayloadEntry[]; total: number }> {
  let entries: LlmPayloadEntry[] = [];
  try {
    const raw = await readFile(logPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as LlmPayloadEntry);
      } catch {
        // повреждённая строка — пропускаем
      }
    }
  } catch {
    return { entries: [], total: 0 };
  }

  if (query.sessionId) {
    entries = entries.filter((e) => e.sessionId === query.sessionId);
  }

  const total = entries.length;
  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit!) : 100;
  return { entries: entries.slice(-limit), total };
}
