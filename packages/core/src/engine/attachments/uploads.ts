/**
 * ADR-115 (B2a): серверный **chunked**-протокол загрузки вложения.
 *
 * Зачем: крупные файлы (видео) не должны целиком буферизоваться в памяти и не
 * должны требовать одного длинного соединения. Клиент создаёт сессию загрузки,
 * шлёт части (`maxChunkBytes`), затем завершает — сервис считает sha256/MIME
 * повторным потоковым проходом и публикует объект как обычное вложение
 * (`AttachmentService.ingestPath`).
 *
 * Устройство:
 * - состояние — **в памяти процесса** (`uploadId → запись`), байты — во временном
 *   объекте blob-порта `attachments/.uploads/<uuid>`;
 * - лимиты и мастер-выключатель читаются из live-конфига `attachments`
 *   (`maxChunkBytes`/`maxBytesPerFile`/`enabled`) на каждый вызов;
 * - TTL сессии — `UPLOAD_SESSION_TTL_MS` (1 ч): протухшие сессии и их временные
 *   объекты удаляются **лениво** (на `create`/`append`/`complete`), глобального
 *   таймера нет; ошибки уборки не роняют запрос.
 *
 * Ограничение multi-replica: временный объект лежит на томе одного пода, а запись
 * сессии — в памяти этого же процесса. Несколько реплик control plane этот
 * протокол не обслуживают (клиент должен попадать на ту же реплику —
 * sticky/один инстанс); для тестов достаточно одной реплики. Перенос состояния в
 * общий стор (`blob_refs`/БД) — отдельная задача, если понадобится.
 */

import { randomUUID } from 'node:crypto';
import type { AttachmentsConfig } from '@itphx/synth-shared';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import {
  ATTACHMENT_UPLOAD_DIR,
  AttachmentError,
  type AttachmentService,
  type UploadedAttachmentMeta,
} from './service.js';

/** Срок жизни сессии загрузки без активности (мс). */
export const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Машинные коды отказа протокола chunked-загрузки (маппинг в HTTP — на границе
 * роутов: `not_found` → 404, `offset_mismatch` → 400, прочие → 413).
 * Ошибки лимитов/MIME самого вложения остаются `AttachmentError`.
 */
export type UploadSessionErrorCode =
  | 'not_found'
  | 'offset_mismatch'
  | 'too_large_chunk'
  | 'too_large';

/** Отказ протокола chunked-загрузки (нет сессии, смещение, лимит части/файла). */
export class UploadSessionError extends Error {
  constructor(
    readonly code: UploadSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadSessionError';
  }
}

/** Запись сессии загрузки (in-memory). */
export interface UploadSessionRecord {
  /** Сессия-владелец (для контура `/:id/attachments`; staging — нет). */
  sessionId?: string;
  /** Временный объект blob-порта (`attachments/.uploads/<uuid>`). */
  path: string;
  /** Принято байт. */
  received: number;
  /** Имя файла из инициализации (санитайз — в сервисе при публикации). */
  name?: string;
  /** Заявленный MIME (проверка всё равно по сигнатуре). */
  declaredMime?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadSessionStoreDeps {
  /** Сервис вложений: `ingestPath` на завершении, blob-порт для временного объекта. */
  service: AttachmentService;
  /** Live-конфиг `attachments` (снимок или резолвер). */
  config: AttachmentsConfig | (() => AttachmentsConfig);
  /** Инъекция времени (тесты TTL). */
  now?: () => number;
  /** TTL сессии без активности (по умолчанию `UPLOAD_SESSION_TTL_MS`). */
  ttlMs?: number;
  /** Лог предупреждений уборки (по умолчанию `console.warn`). */
  log?: (message: string) => void;
}

export interface CreateUploadSessionInput {
  sessionId?: string;
  name?: string;
  declaredMime?: string;
  /** Заявленный размер файла: больше `maxBytesPerFile` — ранний отказ. */
  size?: number;
}

/** Ответ инициализации: id сессии и максимальный размер части. */
export interface CreatedUploadSession {
  uploadId: string;
  maxChunkBytes: number;
}

/** Ответ приёма части: принято всего и смещение следующей части. */
export interface AppendedUploadChunk {
  received: number;
  nextOffset: number;
}

/**
 * Реестр сессий chunked-загрузки (in-memory, один процесс).
 */
export class UploadSessionStore {
  private readonly _records = new Map<string, UploadSessionRecord>();
  private readonly _service: AttachmentService;
  private readonly _blobs: BlobStore;
  private readonly _configSource: AttachmentsConfig | (() => AttachmentsConfig);
  private readonly _now: () => number;
  private readonly _ttlMs: number;
  private readonly _log: (message: string) => void;

  constructor(deps: UploadSessionStoreDeps) {
    this._service = deps.service;
    this._blobs = deps.service.blobs;
    this._configSource = deps.config;
    this._now = deps.now ?? (() => Date.now());
    this._ttlMs = deps.ttlMs ?? UPLOAD_SESSION_TTL_MS;
    this._log = deps.log ?? ((message) => console.warn(message));
  }

  /** Эффективный конфиг на текущий вызов (runtime-настройки без рестарта). */
  private get _config(): AttachmentsConfig {
    return typeof this._configSource === 'function' ? this._configSource() : this._configSource;
  }

  /** Мастер-выключатель вложений (как у `AttachmentService.upload`). */
  private _requireEnabled(config: AttachmentsConfig): void {
    if (!config.enabled) {
      throw new AttachmentError('attachments_disabled', 'Вложения отключены администратором');
    }
  }

  /** Начать загрузку: создать пустой временный объект и вернуть лимит части. */
  async create(input: CreateUploadSessionInput = {}): Promise<CreatedUploadSession> {
    const config = this._config;
    this._requireEnabled(config);
    if (
      typeof input.size === 'number'
      && Number.isFinite(input.size)
      && input.size > config.maxBytesPerFile
    ) {
      throw new UploadSessionError(
        'too_large',
        `Размер вложения ${input.size} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }

    await this._pruneSafely();

    const uploadId = randomUUID();
    const path = `${ATTACHMENT_UPLOAD_DIR}/${uploadId}`;
    await this._blobs.write(path, Buffer.alloc(0));

    const now = this._now();
    const record: UploadSessionRecord = {
      path,
      received: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (input.sessionId) record.sessionId = input.sessionId;
    if (input.name) record.name = input.name;
    if (input.declaredMime) record.declaredMime = input.declaredMime;
    this._records.set(uploadId, record);

    return { uploadId, maxChunkBytes: config.maxChunkBytes };
  }

  /**
   * Принять часть по смещению `offset` (обязан равняться уже принятому объёму —
   * иначе клиент потерял часть и дописывание склеило бы файл с дырой).
   */
  async append(
    uploadId: string,
    offset: number,
    bytes: Buffer,
  ): Promise<AppendedUploadChunk> {
    await this._pruneSafely();
    const record = this._records.get(uploadId);
    if (!record) {
      throw new UploadSessionError('not_found', 'Сессия загрузки не найдена');
    }
    const config = this._config;
    this._requireEnabled(config);

    if (!Number.isInteger(offset) || offset !== record.received) {
      throw new UploadSessionError(
        'offset_mismatch',
        `Смещение части ${offset} не совпадает с принятым объёмом ${record.received}`,
      );
    }
    if (bytes.length > config.maxChunkBytes) {
      throw new UploadSessionError(
        'too_large_chunk',
        `Размер части ${bytes.length} Б превышает предел ${config.maxChunkBytes} Б`,
      );
    }
    if (record.received + bytes.length > config.maxBytesPerFile) {
      throw new UploadSessionError(
        'too_large',
        `Размер вложения ${record.received + bytes.length} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }

    if (bytes.length > 0) await this._blobs.append(record.path, bytes);
    record.received += bytes.length;
    record.updatedAt = this._now();

    return { received: record.received, nextOffset: record.received };
  }

  /**
   * Завершить загрузку: опубликовать временный объект как вложение. Запись
   * снимается до публикации (повторное завершение — `not_found`), временный
   * объект удаляется в `finally` (при ошибке публикации тоже).
   */
  async complete(uploadId: string): Promise<UploadedAttachmentMeta> {
    await this._pruneSafely();
    const record = this._records.get(uploadId);
    if (!record) {
      throw new UploadSessionError('not_found', 'Сессия загрузки не найдена');
    }
    this._records.delete(uploadId);

    try {
      return await this._service.ingestPath(record.path, {
        ...(record.name ? { name: record.name } : {}),
        ...(record.declaredMime ? { declaredMime: record.declaredMime } : {}),
      });
    } finally {
      // `ingestPath` переносит или удаляет объект сам; повторное удаление
      // идемпотентно и страхует путь ошибки.
      await this._blobs.delete(record.path).catch((err: unknown) => {
        this._log(
          `[attachments] временный объект загрузки не удалён (${record.path}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  /** Отменить загрузку: удалить временный объект и запись (идемпотентно). */
  async cancel(uploadId: string): Promise<void> {
    const record = this._records.get(uploadId);
    this._records.delete(uploadId);
    if (!record) return;
    await this._blobs.delete(record.path).catch((err: unknown) => {
      this._log(
        `[attachments] временный объект отменённой загрузки не удалён (${record.path}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Удалить протухшие сессии и их временные объекты. Вызывается лениво;
   * возвращает число удалённых записей (тесты/диагностика).
   */
  async pruneExpired(): Promise<number> {
    const now = this._now();
    let removed = 0;
    for (const [uploadId, record] of this._records) {
      if (now - record.updatedAt <= this._ttlMs) continue;
      this._records.delete(uploadId);
      await this._blobs.delete(record.path).catch((err: unknown) => {
        this._log(
          `[attachments] временный объект протухшей загрузки не удалён (${record.path}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      removed += 1;
    }
    return removed;
  }

  /** Ленивая уборка: ошибка стора не должна ронять текущий запрос. */
  private async _pruneSafely(): Promise<void> {
    try {
      await this.pruneExpired();
    } catch (err) {
      this._log(
        `[attachments] уборка протухших загрузок не выполнена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
