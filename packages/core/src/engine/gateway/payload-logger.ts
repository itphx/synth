/**
 * Полное логирование запросов/ответов LLM: append-only JSONL, одна строка = одна запись.
 * Данные пишутся ПОСЛЕ обфускации — секреты (реальные значения) в лог не попадают.
 * Запись не должна ронять запрос: при ошибке — warning и продолжение.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TokenUsage } from '@synth/shared';
import type { LLMMessage } from '../../providers/base.js';
import { warning } from '../../logger.js';

export interface LlmPayloadRequest {
  messages: LLMMessage[];
  systemPrompt?: string;
}

export interface LlmPayloadResponse {
  content: string;
  usage?: TokenUsage;
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

export class PayloadLogger {
  private _dirReady: Promise<void> | null = null;

  constructor(private _logPath: string) {}

  get logPath(): string {
    return this._logPath;
  }

  /** Атомарный append: open 'a', write JSON + '\n'. Не бросает при ошибке записи. */
  async append(entry: LlmPayloadEntry): Promise<void> {
    try {
      await this._ensureDir();
      await appendFile(this._logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } catch (e) {
      warning('GATEWAY', `Ошибка записи полного лога: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private _ensureDir(): Promise<void> {
    if (!this._dirReady) {
      this._dirReady = mkdir(dirname(this._logPath), { recursive: true })
        .then(() => undefined)
        .catch((e) => {
          this._dirReady = null;
          throw e;
        });
    }
    return this._dirReady!;
  }
}

/** Функциональная обёртка записи одной записи полного лога в JSONL-файл. */
export async function writePayloadLog(logPath: string, entry: LlmPayloadEntry): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
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
