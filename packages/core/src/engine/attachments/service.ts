/**
 * Сервис вложений сообщений (ADR-115 §«Хранение», §«API и лимиты»).
 *
 * Единственная точка записи/чтения байтов вложения: MIME по сигнатуре, лимиты
 * из конфига, вычищение метаданных, content-addressed адресация
 * (`attachments/<sha2>/<sha256>`) и sidecar-метаданные рядом с объектом.
 *
 * Почему sidecar: в промпт уходит только путь объекта (`attachments/ab/<sha>`),
 * а имя файла и MIME должны пережить отправку — они лежат в
 * `attachments/ab/<sha>.json`. Читается в `resolve`, фоллбек — повторный sniff.
 *
 * Байты — только через порт `BlobStore` (ADR-096/ADR-116): прямой ФС нет.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import type { AttachmentsConfig, MediaPartData, MediaPartType } from '@itphx/synth-shared';
import type { BlobReadRange, BlobStore } from '../../storage/ports/blob-store.js';
import { looksLikeSvg, normalizeMime, sniffMime } from './sniff-mime.js';
import { stripMetadata } from './strip-metadata.js';

/** Каталог вложений в blob-хранилище (относительный путь порта). */
export const ATTACHMENT_DIR = 'attachments';
/** Суффикс sidecar-файла с метаданными объекта. */
export const ATTACHMENT_SIDECAR_SUFFIX = '.json';

/** Код ошибки загрузки — маппится в HTTP на границе (`413`/`415`). */
export type AttachmentErrorCode = 'too_large' | 'unsupported_mime';

/** Отказ загрузки вложения (лимит размера / недопустимый тип). */
export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** Результат загрузки вложения (ответ `POST /sessions/:id/attachments`). */
export interface UploadedAttachmentMeta {
  /** id вложения — равен `blobPath` (content-addressed, дедуп). */
  id: string;
  blobPath: string;
  sha256: string;
  mime: string;
  size: number;
  name?: string;
}

/** Метаданные стороны чтения (`resolve`). */
export interface ResolvedAttachment {
  blobPath: string;
  mime: string;
  size: number;
  sha256: string;
  name?: string;
  stat: { size: number; mtimeMs: number };
}

/** Медиа-часть для сообщения: тип части + данные. */
export interface BuiltMediaPart {
  type: MediaPartType;
  data: MediaPartData;
}

/** Sidecar с метаданными объекта (аддитивные поля читаются, если есть). */
interface AttachmentSidecar {
  name?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface AttachmentServiceDeps {
  blobs: BlobStore;
  config: AttachmentsConfig;
  /** Лог предупреждений (по умолчанию `console.warn`). */
  log?: (message: string) => void;
}

export class AttachmentService {
  private readonly _blobs: BlobStore;
  private readonly _config: AttachmentsConfig;
  private readonly _log: (message: string) => void;

  constructor(deps: AttachmentServiceDeps) {
    this._blobs = deps.blobs;
    this._config = deps.config;
    this._log = deps.log ?? ((message) => console.warn(message));
  }

  /**
   * Загрузить вложение: проверить размер и MIME, вычистить метаданные,
   * записать объект (если такого содержимого ещё нет) и sidecar.
   */
  async upload(input: {
    sessionId: string;
    bytes: Buffer;
    name?: string;
    declaredMime?: string;
  }): Promise<UploadedAttachmentMeta> {
    const raw = input.bytes;
    if (raw.length === 0) {
      throw new AttachmentError('unsupported_mime', 'Пустой файл: MIME по содержимому не определяется');
    }
    if (raw.length > this._config.maxBytesPerFile) {
      throw new AttachmentError(
        'too_large',
        `Размер вложения ${raw.length} Б превышает предел ${this._config.maxBytesPerFile} Б`,
      );
    }

    const mime = this._resolveMime(raw, input.declaredMime);
    this._assertAllowed(mime);

    // Метаданные вычищаются до хеширования: адрес описывает то, что реально лежит.
    const bytes = stripMetadata(raw, mime);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blobPath = `${ATTACHMENT_DIR}/${sha256.slice(0, 2)}/${sha256}`;
    const name = sanitizeFileName(input.name);
    const sidecar: AttachmentSidecar = {
      mime,
      size: bytes.length,
      sha256,
      ...(name ? { name } : {}),
    };

    const exists = await this._blobs.exists(blobPath);
    if (!exists) {
      await this._blobs.write(blobPath, bytes);
      await this._writeSidecar(blobPath, sidecar);
    } else if (!(await this._blobs.exists(this._sidecarPath(blobPath)))) {
      // Объект уже есть (дедуп), sidecar потерян/не создан — дописываем метаданные.
      await this._writeSidecar(blobPath, sidecar);
    }

    return {
      id: blobPath,
      blobPath,
      sha256,
      mime,
      size: bytes.length,
      ...(name ? { name } : {}),
    };
  }

  /**
   * Метаданные объекта вложения. `null` — объекта нет или путь не из
   * `attachments/` (раздавать произвольные blob'ы через этот контур нельзя).
   */
  async resolve(blobPath: string): Promise<ResolvedAttachment | null> {
    if (!isAttachmentPath(blobPath)) return null;
    const stat = await this._blobs.stat(blobPath);
    if (!stat) return null;

    const sidecar = await this._readSidecar(blobPath);
    let mime = normalizeMime(sidecar?.mime);
    let sha256 = typeof sidecar?.sha256 === 'string' ? sidecar.sha256 : undefined;
    let size = typeof sidecar?.size === 'number' ? sidecar.size : stat.size;

    if (!mime || !sha256) {
      // Sidecar потерян/битый — фоллбек на сигнатуру содержимого.
      const bytes = await this._blobs.read(blobPath);
      if (!bytes) return null;
      mime = mime ?? sniffMime(bytes) ?? 'application/octet-stream';
      sha256 = sha256 ?? createHash('sha256').update(bytes).digest('hex');
      size = typeof sidecar?.size === 'number' ? sidecar.size : bytes.length;
    }

    return {
      blobPath,
      mime,
      size,
      sha256,
      ...(typeof sidecar?.name === 'string' && sidecar.name ? { name: sidecar.name } : {}),
      stat,
    };
  }

  /** Потоковое чтение объекта вложения (диапазон — включительно, как у `fs`). */
  async read(blobPath: string, range?: BlobReadRange): Promise<Readable | null> {
    if (!isAttachmentPath(blobPath)) return null;
    return this._blobs.readStream(blobPath, range);
  }

  /**
   * Медиа-часть сообщения по пути объекта: тип части из MIME
   * (`image/*` → `image`, `audio/*` → `audio`, `video/*` → `video`, иначе `file`).
   * `null` — объекта нет (битый путь/GC уже удалил).
   */
  async buildMediaPart(blobPath: string): Promise<BuiltMediaPart | null> {
    const resolved = await this.resolve(blobPath);
    if (!resolved) return null;
    const sidecar = await this._readSidecar(blobPath);
    const data: MediaPartData = {
      blobPath: resolved.blobPath,
      sha256: resolved.sha256,
      mime: resolved.mime,
      size: resolved.size,
      ...(resolved.name ? { name: resolved.name } : {}),
      ...(typeof sidecar?.width === 'number' ? { width: sidecar.width } : {}),
      ...(typeof sidecar?.height === 'number' ? { height: sidecar.height } : {}),
      ...(typeof sidecar?.durationMs === 'number' ? { durationMs: sidecar.durationMs } : {}),
    };
    return { type: partTypeOf(resolved.mime), data };
  }

  /** MIME по сигнатуре → заявленный → `application/octet-stream`. */
  private _resolveMime(bytes: Buffer, declaredMime?: string): string {
    const sniffed = sniffMime(bytes);
    if (sniffed) return sniffed;
    // Содержимое похоже на SVG, но сигнатуры нет — фиксируем запрещённый тип.
    if (looksLikeSvg(bytes)) return 'image/svg+xml';
    return normalizeMime(declaredMime) ?? 'application/octet-stream';
  }

  /** Проверка белого списка MIME (SVG запрещён всегда). */
  private _assertAllowed(mime: string): void {
    if (mime === 'image/svg+xml') {
      throw new AttachmentError(
        'unsupported_mime',
        'Тип image/svg+xml запрещён: SVG может нести скрипт (XSS)',
      );
    }
    const prefixes = this._config.allowedMimePrefixes ?? [];
    if (prefixes.length === 0) return;
    if (prefixes.some((prefix) => mime.startsWith(prefix))) return;
    throw new AttachmentError(
      'unsupported_mime',
      `Тип ${mime} не разрешён (допустимые префиксы: ${prefixes.join(', ')})`,
    );
  }

  private _sidecarPath(blobPath: string): string {
    return `${blobPath}${ATTACHMENT_SIDECAR_SUFFIX}`;
  }

  private async _writeSidecar(blobPath: string, sidecar: AttachmentSidecar): Promise<void> {
    try {
      await this._blobs.write(this._sidecarPath(blobPath), JSON.stringify(sidecar));
    } catch (err) {
      // Sidecar — метаданные: без него вложение читается (фоллбек на sniff),
      // поэтому ошибка записи не отменяет загрузку объекта.
      this._log(
        `[attachments] не удалось записать sidecar ${blobPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async _readSidecar(blobPath: string): Promise<AttachmentSidecar | null> {
    try {
      const raw = await this._blobs.read(this._sidecarPath(blobPath));
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw.toString('utf-8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      return parsed as AttachmentSidecar;
    } catch {
      return null;
    }
  }
}

/** Является ли путь объектом вложений (контур раздачи ограничен `attachments/`). */
export function isAttachmentPath(blobPath: string): boolean {
  if (typeof blobPath !== 'string' || blobPath.length === 0) return false;
  if (!blobPath.startsWith(`${ATTACHMENT_DIR}/`)) return false;
  if (blobPath.includes('..') || blobPath.includes('\\') || blobPath.includes('\0')) return false;
  return true;
}

/** Тип медиа-части по MIME. */
export function partTypeOf(mime: string): MediaPartType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Санитайз имени файла: только basename, без управляющих символов, длина ≤ 200.
 * Имя живёт только в метаданных (в `blobPath` его нет).
 */
export function sanitizeFileName(name: string | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = basename(trimmed.replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return undefined;
  return cleaned.slice(0, 200);
}
