/**
 * Серверные миниатюры вложений (ADR-115).
 *
 * Миниатюра — маленький JPEG-кадр, который UI показывает до загрузки
 * оригинала. Она **производная**: content-addressed путь
 * `attachments/.thumbs/<sha256>-<maxWidthPx>.jpg` (дедуп по содержимому и
 * ширине, как у оригинала), в sidecar вложения добавляется аддитивное поле
 * `thumb: {status: 'ready'|'none', width?, height?}`. Ширина в имени — чтобы
 * смена `attachments.thumbnail.maxWidthPx` не отдавала старый кадр другого
 * размера; историческое имя `<sha256>.jpg` (без ширины) читается только при
 * ширине по умолчанию (обратная совместимость).
 *
 * Генерация идёт **асинхронно** после загрузки (`AttachmentService.upload` не
 * ждёт ответа 201): ошибка/нет `ffmpeg` → `none`, загрузка и ход не падают.
 * Повторная генерация для того же sha не нужна — файл уже лежит в blob.
 *
 * ## Длительность видео
 *
 * Попутно с кадром определяется **длительность** видео (`video`): из sidecar,
 * из входа вызывающего либо пробой `ffmpeg -i` (без выхода — процесс
 * завершается ошибкой, длительность печатается в stderr). Длительность
 * кладётся в sidecar вложения (аддитивно, рядом с `thumb`) — её читает
 * `AttachmentService.resolve` и оттуда она попадает в сжатие (адаптивный
 * битрейт, ADR-115) и в извлечение кадров. Проба — best-effort: ошибка или
 * отсутствие `Duration` → поле не пишется, ход не падает.
 *
 * `ffmpeg` запускается **только** через медиа-раннер (`engine/media/runner.ts`):
 * inline — локально, remote (split-режим) — на исполнителе в общем workspace
 * (`requires: ['ffmpeg']`). Файлы-исходники во временном каталоге удаляются
 * раннером в `finally`.
 */

import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { MediaRunnerLike } from '../media/runner.js';
import {
  ATTACHMENT_SIDECAR_SUFFIX,
  isAttachmentPath,
  partTypeOf,
} from './service.js';

/** Каталог миниатюр в blob-хранилище (рядом с оригиналами). */
export const THUMBNAIL_DIR = 'attachments/.thumbs';

/** Суффикс файла миниатюры. */
export const THUMBNAIL_SUFFIX = '.jpg';

/** Максимальная ширина миниатюры, px (высота — пропорционально, `-2`). */
export const THUMBNAIL_MAX_WIDTH = 512;

/** Качество JPEG (`-q:v`, меньше — лучше). */
export const THUMBNAIL_JPEG_QUALITY = 4;

/** Предел размера файла миниатюры, байт (проверяется до чтения). */
export const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Длительность медиа из stderr `ffmpeg` (`Duration: HH:MM:SS.xx`), мс.
 *
 * `null` — строки нет: `Duration: N/A`, другой формат вывода или stderr пуст.
 * Разбирается первое совпадение — `ffmpeg` печатает длительность входного
 * файла один раз.
 */
export function parseFfmpegDurationMs(stderr: string | undefined): number | null {
  if (!stderr) return null;
  const match = /Duration:\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  const ms = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
  return ms > 0 ? ms : null;
}

/** Метаданные миниатюры: `ready` — файл есть, `none` — превью не делается. */
export interface ThumbnailMeta {
  status: 'ready' | 'none';
  width?: number;
  height?: number;
}

/** Готовая миниатюра для раздачи (поток из blob). */
export interface ThumbnailView {
  stream: Readable;
  mime: string;
  size: number;
  /** Ширина кадра, px — та, с которой найден файл (нужна для ETag). */
  width: number;
}

/** Что нужно для создания миниатюры. */
export interface ThumbnailInput {
  blobPath: string;
  mime: string;
  /** Длительность видео (мс), если известна (кадр — на 10% длительности). */
  durationMs?: number;
}

/** Конфиг миниатюр (live-геттер секции `attachments.thumbnail`, ADR-115). */
export interface ThumbnailConfig {
  enabled: boolean;
  maxWidthPx: number;
}

export interface ThumbnailServiceDeps {
  /** Blob-порт: оригиналы, миниатюры и sidecar вложения. */
  blobs: BlobStore;
  /** Медиа-раннер: единственная точка запуска `ffmpeg`. */
  runner: MediaRunnerLike;
  /**
   * Live-резолвер `attachments.thumbnail` (runtime-настройки, C0).
   * Не задан (тесты/урезанные сборки) — миниатюры включены, ширина
   * `THUMBNAIL_MAX_WIDTH`. `enabled: false` → `ensure()` сразу `none`
   * (ffmpeg не запускается); `maxWidthPx` подставляется в `scale`.
   */
  config?: () => ThumbnailConfig;
  /** Лог предупреждений (по умолчанию молча). */
  log?: (message: string) => void;
}

/**
 * Миниатюры вложений: генерация по требованию и раздача.
 *
 * Ничего не бросает: любая ошибка генерации — `{status:'none'}`.
 */
export class ThumbnailService {
  private readonly _blobs: BlobStore;
  private readonly _runner: MediaRunnerLike;
  private readonly _config: (() => ThumbnailConfig) | undefined;
  private readonly _log: (message: string) => void;
  /**
   * Дедуп одновременных генераций по sha256: 10 параллельных запросов превью
   * не запускают 10 `ffmpeg`. Запись снимается в `finally`.
   */
  private readonly _inflight = new Map<string, Promise<ThumbnailMeta>>();

  constructor(deps: ThumbnailServiceDeps) {
    this._blobs = deps.blobs;
    this._runner = deps.runner;
    this._config = deps.config;
    this._log = deps.log ?? (() => undefined);
  }

  /** Текущие настройки миниатюр: без геттера — включены, ширина по умолчанию. */
  private _settings(): ThumbnailConfig {
    if (!this._config) return { enabled: true, maxWidthPx: THUMBNAIL_MAX_WIDTH };
    try {
      const current = this._config();
      return {
        enabled: current.enabled !== false,
        maxWidthPx:
          typeof current.maxWidthPx === 'number' && current.maxWidthPx > 0
            ? current.maxWidthPx
            : THUMBNAIL_MAX_WIDTH,
      };
    } catch {
      // Ошибка резолвера настроек не должна ронять превью: дефолты.
      return { enabled: true, maxWidthPx: THUMBNAIL_MAX_WIDTH };
    }
  }

  /**
   * Путь миниатюры для sha256 оригинала и ширины из настроек.
   *
   * Ширина входит в имя: при смене `attachments.thumbnail.maxWidthPx` старый
   * кадр другого размера не отдаётся (генерируется новый).
   */
  thumbnailPath(sha256: string, maxWidthPx: number = THUMBNAIL_MAX_WIDTH): string {
    return `${THUMBNAIL_DIR}/${sha256}-${maxWidthPx}${THUMBNAIL_SUFFIX}`;
  }

  /**
   * Создать миниатюру, если она применима и ещё не создана.
   *
   * `image`/`video` → кадр; `audio`/`file`/`pdf` → `none` (без запуска ffmpeg).
   * Существующий файл переиспользуется (content-addressed). Одновременные
   * вызовы для одного sha делят одну генерацию (дедуп в `_inflight`).
   *
   * Для `video` попутно определяется **длительность** (sidecar/вход/проба
   * `ffmpeg`) — она нужна и кадру (10% длительности), и адаптивному битрейту
   * сжатия (ADR-115).
   */
  async ensure(input: ThumbnailInput): Promise<ThumbnailMeta> {
    const settings = this._settings();
    if (!isAttachmentPath(input.blobPath) || input.blobPath.startsWith(`${THUMBNAIL_DIR}/`)) {
      return { status: 'none' };
    }
    const kind = partTypeOf(input.mime);
    if (kind !== 'image' && kind !== 'video') return { status: 'none' };

    const sha256 = basename(input.blobPath);
    if (!/^[0-9a-f]{64}$/.test(sha256)) return { status: 'none' };

    // Дедуп — по паре «содержимое + ширина»: генерации для разных ширин не
    // должны делить один промис (иначе второй вызов получил бы чужой размер).
    const inflightKey = `${sha256}:${settings.maxWidthPx}`;
    const running = this._inflight.get(inflightKey);
    if (running) return running;

    const pending = this._generate(input, sha256, kind, settings).finally(() => {
      // Снимаем запись только если это всё ещё наша генерация.
      if (this._inflight.get(inflightKey) === pending) this._inflight.delete(inflightKey);
    });
    this._inflight.set(inflightKey, pending);
    return pending;
  }

  /** Фактическая генерация (внутри дедупа): существующий файл или `ffmpeg`. */
  private async _generate(
    input: ThumbnailInput,
    sha256: string,
    kind: 'image' | 'video',
    settings: ThumbnailConfig,
  ): Promise<ThumbnailMeta> {
    try {
      // Длительность (видео) — до проверки выключателя миниатюр: она нужна
      // не только кадру, но и адаптивному битрейту сжатия (ADR-115).
      const durationMs = kind === 'video' ? await this._resolveDurationMs(input) : null;
      // Выключено в runtime-настройках — превью не делаем вовсе (кадр не пишем).
      if (!settings.enabled) return { status: 'none' };

      const thumbPath = this.thumbnailPath(sha256, settings.maxWidthPx);

      let existing = await this._readThumbMeta(thumbPath);
      // Обратная совместимость: до появления ширины в имени превью лежало по
      // `<sha256>.jpg`. Читаем его только при ширине по умолчанию (512): при
      // другой ширине отдали бы кадр чужого размера — генерируем новый.
      if (!existing && settings.maxWidthPx === THUMBNAIL_MAX_WIDTH) {
        existing = await this._readThumbMeta(legacyThumbnailPath(sha256));
      }
      if (existing) {
        await this._updateSidecar(input.blobPath, { thumb: existing });
        return existing;
      }

      const atSeconds =
        kind === 'video'
          ? durationMs !== null
            ? Math.max(0, (durationMs / 1000) * 0.1)
            : 1
          : undefined;

      let result = await this._runner.run({
        args: thumbnailArgs(atSeconds, settings.maxWidthPx),
        inputBlobPath: input.blobPath,
        capture: 'file',
        outputName: `thumb${THUMBNAIL_SUFFIX}`,
        maxOutputBytes: THUMBNAIL_MAX_BYTES,
      });
      // Короткое видео может не дать кадр на 1-й секунде — повтор с начала.
      if (!result.ok && kind === 'video' && atSeconds !== undefined && atSeconds > 0) {
        result = await this._runner.run({
          args: thumbnailArgs(0, settings.maxWidthPx),
          inputBlobPath: input.blobPath,
          capture: 'file',
          outputName: `thumb${THUMBNAIL_SUFFIX}`,
          maxOutputBytes: THUMBNAIL_MAX_BYTES,
        });
      }
      if (!result.ok) {
        this._log(
          `[thumbnails] миниатюра не создана (${input.blobPath}): ${result.error ?? result.reason ?? 'ffmpeg'}`,
        );
        await this._updateSidecar(input.blobPath, { thumb: { status: 'none' } });
        return { status: 'none' };
      }
      const bytes = result.outputs[0];
      if (!bytes || bytes.length === 0) {
        await this._updateSidecar(input.blobPath, { thumb: { status: 'none' } });
        return { status: 'none' };
      }

      await this._blobs.write(thumbPath, bytes);
      const size = jpegSize(bytes);
      const meta: ThumbnailMeta = {
        status: 'ready',
        ...(size ? { width: size.width, height: size.height } : {}),
      };
      await this._updateSidecar(input.blobPath, { thumb: meta });
      return meta;
    } catch (err) {
      this._log(
        `[thumbnails] ошибка генерации (${input.blobPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { status: 'none' };
    }
  }

  /**
   * Длительность видео, мс: sidecar → вход вызывающего → проба `ffmpeg`.
   *
   * Проба — best-effort (`ffmpeg -i` без выхода: процесс завершается ошибкой
   * «нужен выходной файл», это норма). Ошибка/нет `Duration` → `null`, поле в
   * sidecar не пишется (следующий вызов попробует снова — но не чаще, чем
   * вызывается `ensure`).
   *
   * Найденная длительность сохраняется в sidecar вложения (аддитивно, рядом с
   * `thumb`): её читает `AttachmentService.resolve` — оттуда она попадает в
   * сжатие (адаптивный битрейт) и в извлечение кадров.
   */
  private async _resolveDurationMs(input: ThumbnailInput): Promise<number | null> {
    const sidecar = await this._readSidecar(input.blobPath);
    const fromSidecar =
      typeof sidecar?.durationMs === 'number' && sidecar.durationMs > 0 ? sidecar.durationMs : null;
    // Уже известная длительность не перезаписывается.
    if (fromSidecar !== null) return fromSidecar;

    const fromInput =
      typeof input.durationMs === 'number' && input.durationMs > 0 ? input.durationMs : null;
    if (fromInput !== null) {
      await this._updateSidecar(input.blobPath, { durationMs: fromInput });
      return fromInput;
    }

    const detected = await this._detectDurationMs(input.blobPath);
    if (detected === null) return null;
    await this._updateSidecar(input.blobPath, { durationMs: detected });
    return detected;
  }

  /**
   * Проба длительности через медиа-раннер: `ffmpeg -hide_banner -i <файл>`
   * без выходного файла (ffmpeg завершится ошибкой — длительность всё равно
   * напечатана в stderr). `null` — определить не удалось.
   */
  private async _detectDurationMs(blobPath: string): Promise<number | null> {
    try {
      const result = await this._runner.run({
        args: durationProbeArgs(),
        inputBlobPath: blobPath,
        capture: 'stdout',
      });
      return parseFfmpegDurationMs(result.stderr);
    } catch (err) {
      this._log(
        `[thumbnails] длительность не определена (${blobPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Готовая миниатюра вложения (поток из blob) либо `null` — файла нет.
   * Путь объекта миниатюры выводится из sha256 оригинала и текущей ширины
   * настроек; исторический `<sha256>.jpg` (без ширины) читается только при
   * ширине по умолчанию — без перезаписи.
   */
  async get(blobPath: string): Promise<ThumbnailView | null> {
    if (!isAttachmentPath(blobPath) || blobPath.startsWith(`${THUMBNAIL_DIR}/`)) return null;
    const sha256 = basename(blobPath);
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    const width = this._settings().maxWidthPx;
    const paths = [this.thumbnailPath(sha256, width)];
    if (width === THUMBNAIL_MAX_WIDTH) paths.push(legacyThumbnailPath(sha256));
    for (const thumbPath of paths) {
      const stat = await this._blobs.stat(thumbPath).catch(() => null);
      if (!stat || stat.size === 0) continue;
      const stream = await this._blobs.readStream(thumbPath).catch(() => null);
      if (!stream) continue;
      return { stream, mime: 'image/jpeg', size: stat.size, width };
    }
    return null;
  }

  /** Метаданные существующей миниатюры (переиспользование без ffmpeg). */
  private async _readThumbMeta(thumbPath: string): Promise<ThumbnailMeta | null> {
    const stat = await this._blobs.stat(thumbPath).catch(() => null);
    if (!stat || stat.size === 0) return null;
    const bytes = await this._blobs.read(thumbPath).catch(() => null);
    if (!bytes) return { status: 'ready' };
    const size = jpegSize(bytes);
    return { status: 'ready', ...(size ? { width: size.width, height: size.height } : {}) };
  }

  /** Sidecar вложения (метаданные объекта) — `null`, если его нет/битый. */
  private async _readSidecar(blobPath: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await this._blobs.read(`${blobPath}${ATTACHMENT_SIDECAR_SUFFIX}`);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw.toString('utf-8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      return parsed as Record<string, unknown>;
    } catch (err) {
      this._log(
        `[thumbnails] sidecar не прочитан (${blobPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * Аддитивное обновление sidecar вложения (best-effort).
   *
   * Пишутся только новые поля (`thumb`, `durationMs`) — прежние не теряются.
   * Sidecar не создаётся: его пишет `AttachmentService` (в нём mime/size/sha256).
   */
  private async _updateSidecar(blobPath: string, patch: Record<string, unknown>): Promise<void> {
    const parsed = await this._readSidecar(blobPath);
    if (!parsed) return;
    try {
      await this._blobs.write(
        `${blobPath}${ATTACHMENT_SIDECAR_SUFFIX}`,
        JSON.stringify({ ...parsed, ...patch }),
      );
    } catch (err) {
      this._log(
        `[thumbnails] sidecar не обновлён (${blobPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Исторический путь миниатюры — `<sha256>.jpg`, без ширины в имени (до C2).
 * Только чтение: новые файлы пишутся как `<sha256>-<ширина>.jpg`.
 */
function legacyThumbnailPath(sha256: string): string {
  return `${THUMBNAIL_DIR}/${sha256}${THUMBNAIL_SUFFIX}`;
}

/**
 * Аргументы пробы длительности: `ffmpeg` без выходного файла.
 *
 * Процесс завершится ошибкой («нужен выходной файл») — это норма: длительность
 * входа печатается в stderr до проверки выходов.
 */
function durationProbeArgs(): string[] {
  return ['-hide_banner', '-i', '{input}'];
}

/** Аргументы кадра: один JPEG шириной ≤`maxWidthPx` (`-2` — высота пропорционально). */
function thumbnailArgs(atSeconds: number | undefined, maxWidthPx: number): string[] {
  const scale = `scale='min(${maxWidthPx},iw)':-2`;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(atSeconds !== undefined ? ['-ss', atSeconds.toFixed(3)] : []),
    '-i',
    '{input}',
    '-frames:v',
    '1',
    '-vf',
    scale,
    '-q:v',
    String(THUMBNAIL_JPEG_QUALITY),
    '-f',
    'mjpeg',
    '{output}',
  ];
}

/**
 * Размеры JPEG из заголовка (SOF0…SOF15). `null` — сигнатура/маркер не найдены.
 * Полноценный декодер не нужен: нужны только width/height.
 */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Маркеры без длины (SOI/EOI/RST/заполнители).
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0..SOF15, кроме DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    offset += 2 + length;
  }
  return null;
}
