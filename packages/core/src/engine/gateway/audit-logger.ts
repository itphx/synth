/**
 * Аудит LLM Gateway (ADR-036): append-only JSONL, одна строка = одна запись.
 * Запись не должна ронять запрос: при ошибке — warning и продолжение.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CatalogTrustLevel, LlmFilterPhase, LlmFilterVerdictKind } from '@itphx/synth-shared';

import { warning } from '../../logger.js';

export type AuditEventType =
  | 'obfuscated'
  | 'blocked'
  | 'revealed'
  | 'rate_limited'
  | 'output_guard'
  /**
   * ADR-090: решение фильтра LLM-вызовов (плагинного
   * расширения). **Текст запроса/ответа/эмбеддингов в записи не пишется** —
   * только идентификатор фильтра, фаза, вердикты, доверие владельца и код.
   */
  | 'plugin_filter';

export interface AuditEntry {
  ts: string;
  type: AuditEventType;
  sessionId?: string;
  userId?: string;
  provider?: string;
  model?: string;
  secretsFound?: string[];
  placeholders?: string[];
  /** Плейсхолдер (⟦SYNTH_SECRET_N⟧) для события раскрытия (type: 'revealed'). */
  placeholder?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  reason?: string;
  /** Фильтр LLM-вызовов: идентификатор (`plugin:<plugin>:<filter>`). */
  filterId?: string;
  /** Фильтр LLM-вызовов: фаза (`pre_request`/`post_response`/`embedding`). */
  filterPhase?: LlmFilterPhase;
  /** Фильтр LLM-вызовов: уровень доверия владельца (право вето — `trusted` и выше). */
  filterTrust?: CatalogTrustLevel;
  /** Фильтр LLM-вызовов: вердикт фильтра (до политики хоста). */
  filterVerdict?: LlmFilterVerdictKind;
  /**
   * Фильтр LLM-вызовов: итог после политики хоста.
   * `ignored` — вердикт отклонён хостом (нет права вето у владельца либо фаза
   * не поддерживает блокировку/переписывание); `deny` — вызов заблокирован.
   */
  filterEffectiveVerdict?: LlmFilterVerdictKind | 'ignored';
  /** Фильтр LLM-вызовов: вердикт понижен хостом (у владельца нет права вето). */
  filterDowngraded?: boolean;
  /**
   * Фильтр LLM-вызовов: машиночитаемый код решения хоста
   * (`plugin_filter.denied`/`plugin_filter.deny_downgraded`/
   * `plugin_filter.unavailable`/`plugin_filter.timeout`/`plugin_filter.error`/
   * `plugin_filter.allowed`/`plugin_filter.redact_unsupported`/
   * `plugin_filter.buffering_required`/`plugin_filter.redact_invalid`).
   */
  filterCode?: string;
  /** Фильтр LLM-вызовов: бюджет времени на вызов фильтра, мс. */
  filterTimeoutMs?: number;
}

export class AuditLogger {
  private _dirReady: Promise<void> | null = null;

  constructor(private _logPath: string) {}

  get logPath(): string {
    return this._logPath;
  }

  /** Атомарный append: open 'a', write JSON + '\n'. Не бросает при ошибке записи. */
  async append(entry: AuditEntry): Promise<void> {
    try {
      await this._ensureDir();
      await appendFile(this._logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    } catch (e) {
      warning('GATEWAY', `Ошибка записи аудита: ${e instanceof Error ? e.message : String(e)}`);
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

/** Фильтры чтения JSONL-аудита (ADR-036). */
export interface AuditLogQuery {
  userId?: string;
  sessionId?: string;
  /** ISO timestamp — включительно. */
  since?: string;
  /** ISO timestamp — включительно. */
  until?: string;
  /** Сколько последних записей вернуть (по умолчанию 100). */
  limit?: number;
}

/**
 * Читает append-only JSONL аудит-файл, парсит построчно и фильтрует.
 * Если файла нет или строка повреждена — строка пропускается, файла нет —
 * возвращается пустой результат (без ошибки). `entries` — последние `limit`
 * записей, `total` — количество после фильтрации (до лимита).
 */
export async function readAuditLog(logPath: string, query: AuditLogQuery = {}): Promise<{ entries: AuditEntry[]; total: number }> {
  let entries: AuditEntry[] = [];
  try {
    const raw = await readFile(logPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as AuditEntry);
      } catch {
        // повреждённая строка — пропускаем
      }
    }
  } catch {
    return { entries: [], total: 0 };
  }

  if (query.userId) {
    entries = entries.filter((e) => e.userId === query.userId);
  }
  if (query.sessionId) {
    entries = entries.filter((e) => e.sessionId === query.sessionId);
  }
  if (query.since) {
    const since = Date.parse(query.since);
    if (!Number.isNaN(since)) {
      entries = entries.filter((e) => Date.parse(e.ts) >= since);
    }
  }
  if (query.until) {
    const until = Date.parse(query.until);
    if (!Number.isNaN(until)) {
      entries = entries.filter((e) => Date.parse(e.ts) <= until);
    }
  }

  const total = entries.length;
  const limit = Number.isFinite(query.limit) && (query.limit ?? 0) > 0 ? Math.floor(query.limit!) : 100;
  return { entries: entries.slice(-limit), total };
}
