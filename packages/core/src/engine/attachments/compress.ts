/**
 * ADR-115: сжатие вложений **на границе отправки** провайдеру.
 *
 * Оригинал в blob не меняется (content-addressed байты, ADR-115/ADR-116):
 * сжатая копия готовится только для LLM-вызова и кэшируется отдельно. Поэтому
 * повторная отправка того же файла не теряет качество оригинала, а `GET
 * /attachments/:sha256` и тул `save_attachment` по-прежнему отдают оригинал.
 *
 * ## Когда сжимаем
 *
 *  - мастер-выключатель `attachments.compression.enabled` и выключатель
 *    семейства (`compression.image|video|audio.enabled`);
 *  - файл не меньше `minBytes`, **либо** размеры превышают предел семейства
 *    (картинка/видео: даже маленький по весу файл с огромным кадром имеет
 *    смысл уменьшить);
 *  - `video` — только при нативной доставке (`capability.supportsNativeVideo`),
 *    иначе работает существующий aux-derived путь (кадры) и сжатие не участвует;
 *  - `audio` — только если транспорт принимает целевой контейнер
 *    (`target.audioFormat`; `null` — не сжимаем).
 *
 * Возможности транспорта приходят **данными** (`compatibility` слоя
 * совместимости, ADR-117), а не host-проверкой.
 *
 * ## Форматы
 *
 *  - image: PNG остаётся PNG (lossless scale, `-compression_level`), остальные
 *    форматы (JPEG/WebP/GIF/…) → JPEG (`-q:v` из `quality`);
 *  - video: H.264/MP4 (`libx264`, `veryfast`, битрейт/буфер, `+faststart`);
 *  - audio: MP3 (`libmp3lame`) или WAV (`pcm_s16le`) с каналами/частотой
 *    профиля.
 *
 * ## Кэш и деградация
 *
 * Результат — `attachments/.derived/compress/<sha256>_<profile>.<ext>`; профиль
 * включает все параметры перекодирования, поэтому смена настроек не подменяет
 * старый файл. Сжатый объект не меньше оригинала → `null` (отправляем
 * оригинал). Ошибка/нет `ffmpeg` → `null` + лог: сжатие — оптимизация, ход из-за
 * него падать не должен. `ffmpeg` запускается только через медиа-раннер
 * (`engine/media/runner.ts`), вход/выход — потоком/файлом, не в памяти.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AttachmentsConfig, NativeAudioFormat } from '@itphx/synth-shared';
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { MediaRunnerLike } from '../media/runner.js';

/** Каталог сжатых копий и кэша (внутри blob-хранилища, рядом с `derive`). */
export const COMPRESS_CACHE_DIR = 'attachments/.derived/compress';

/** Предел размера сжатой копии, байт (защита от раздувания перекодированием). */
export const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;

/** Семейство, для которого применяется сжатие (`pdf` не сжимается). */
export type CompressFamily = 'image' | 'video' | 'audio';

/** Вложение, которое предлагается сжать. */
export interface AttachmentCompressInput {
  blobPath: string;
  mime: string;
  family: CompressFamily;
  name?: string;
  /** Размер оригинала, байт (`minBytes` сравнивается с ним). */
  size: number;
  /** Ширина/высота кадра, если известны (из sidecar). */
  width?: number;
  height?: number;
}

/**
 * Возможности нативной доставки медиа транспортом (ADR-115 × ADR-117).
 *
 * Источник — **данные** слоя совместимости (`compatibility.supportsNativeVideo`
 * / `compatibility.nativeAudioFormats`), а не host-проверка. Структурно
 * совместимо с `ResolvedModelCompatibility` — отдельный тип не нужен.
 */
export interface NativeMediaCapability {
  /** Аудио-контейнеры нативного пути (`input_audio`/`audio`). */
  nativeAudioFormats: readonly NativeAudioFormat[];
  /** Транспорт принимает видеофайл нативно (`video_url`). */
  supportsNativeVideo: boolean;
}

/** Куда транспорт провайдера реально умеет доставлять вложение. */
export interface AttachmentCompressTarget {
  /** Целевой аудио-контейнер нативного пути; `null` — аудио не сжимаем. */
  audioFormat: 'mp3' | 'wav' | null;
  /** Транспорт принимает видеофайл нативно (`supportsNativeVideo`). */
  nativeVideo: boolean;
}

/** Сжатая копия, готовая к отправке (оригинал в blob не менялся). */
export interface CompressedAttachment {
  blobPath: string;
  mime: string;
  size: number;
  name?: string;
}

/** Зависимости сжатия (всё внешнее — инъекция). */
export interface AttachmentCompressorDeps {
  /** Blob-порт: кэш сжатых копий. */
  blobs: BlobStore;
  /** Медиа-раннер — единственная точка запуска `ffmpeg`. */
  runner: MediaRunnerLike;
  /** Live-резолвер секции `attachments.compression` (runtime-настройки). */
  config: () => AttachmentsConfig['compression'];
  /** Лог предупреждений (по умолчанию молча). */
  log?: (message: string) => void;
}

/** Чем закончилось решение о сжатии: файл, формат и профиль кэша. */
interface CompressionPlan {
  ext: string;
  mime: string;
  profile: string;
  args: string[];
}

/** MIME без параметров и в нижнем регистре. */
function normalizeMime(mime: string): string {
  return (mime ?? '').toLowerCase().split(';')[0]!.trim();
}

/** Подмена/добавление расширения у имени файла (модель видит понятное имя). */
function withExtension(name: string | undefined, ext: string): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (trimmed === '') return undefined;
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base}.${ext}`;
}

/** Качество JPEG (`-q:v`): 1..100 → 31..2, больше quality — лучше. */
export function jpegQualityValue(quality: number): number {
  const clamped = Math.max(1, Math.min(100, Math.round(quality)));
  return Math.max(2, Math.min(31, Math.round(31 - (clamped * 29) / 100)));
}

/** Имя файла кэша: содержимое (sha из пути) + профиль перекодирования. */
function cacheName(blobPath: string, profile: string, ext: string): string {
  const base = basename(blobPath);
  const key = /^[0-9a-f]{64}$/.test(base)
    ? base
    : createHash('sha256').update(blobPath).digest('hex');
  return `${key}_${profile}.${ext}`;
}

/**
 * Целевой аудио-контейнер нативного пути по возможностям транспорта.
 * Порядок — mp3 → wav (компактнее при прочих равных); ни один не поддержан —
 * `null` (аудио не сжимаем, работает derive/отброс).
 */
export function resolveNativeAudioFormat(
  capability: NativeMediaCapability,
): 'mp3' | 'wav' | null {
  if (capability.nativeAudioFormats.includes('mp3')) return 'mp3';
  if (capability.nativeAudioFormats.includes('wav')) return 'wav';
  return null;
}

/** Возможности нативной доставки провайдера для сжатия (выбор форматов). */
export function resolveCompressTarget(
  capability: NativeMediaCapability,
): AttachmentCompressTarget {
  return {
    audioFormat: resolveNativeAudioFormat(capability),
    nativeVideo: capability.supportsNativeVideo,
  };
}

/** Сжатие вложений на границе отправки провайдеру (ADR-115). */
export class AttachmentCompressor {
  private readonly _blobs: BlobStore;
  private readonly _runner: MediaRunnerLike;
  private readonly _config: () => AttachmentsConfig['compression'];
  private readonly _log: (message: string) => void;

  constructor(deps: AttachmentCompressorDeps) {
    this._blobs = deps.blobs;
    this._runner = deps.runner;
    this._config = deps.config;
    this._log = deps.log ?? (() => undefined);
  }

  /**
   * Сжать вложение или вернуть `null`, если сжатие не требуется/невозможно.
   *
   * Ничего не бросает: ошибка настроек, раннера или записи → `null` (отправляем
   * оригинал).
   */
  async compress(
    input: AttachmentCompressInput,
    target: AttachmentCompressTarget,
  ): Promise<CompressedAttachment | null> {
    try {
      const plan = this._plan(input, target);
      if (!plan) return null;

      const cachePath = `${COMPRESS_CACHE_DIR}/${cacheName(input.blobPath, plan.profile, plan.ext)}`;
      const cached = await this._blobs.stat(cachePath).catch(() => null);
      if (cached && cached.size > 0) {
        return withName(cachePath, plan.mime, cached.size, withExtension(input.name, plan.ext));
      }

      const result = await this._runner.run({
        args: plan.args,
        inputBlobPath: input.blobPath,
        capture: 'file',
        outputName: `out.${plan.ext}`,
        maxOutputBytes: MAX_COMPRESSED_BYTES,
      });
      if (!result.ok) {
        this._log(
          `[attachments] сжатие не выполнено (${input.blobPath}): ${result.error ?? result.reason ?? 'ffmpeg'}`,
        );
        return null;
      }
      const bytes = result.outputs[0];
      if (!bytes || bytes.length === 0) return null;
      // Сжатие имеет смысл только если объект стал меньше: иначе отправляем
      // оригинал (лишняя копия в blob не нужна).
      if (input.size > 0 && bytes.length >= input.size) {
        this._log(
          `[attachments] сжатая копия не меньше оригинала (${input.blobPath}): ${bytes.length} >= ${input.size}`,
        );
        return null;
      }

      try {
        await this._blobs.write(cachePath, bytes);
      } catch (err) {
        this._log(
          `[attachments] сжатая копия не записана (${cachePath}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
      return withName(cachePath, plan.mime, bytes.length, withExtension(input.name, plan.ext));
    } catch (err) {
      this._log(
        `[attachments] сжатие не выполнено (${input.blobPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Решение «сжимать/нет» + формат, профиль кэша и аргументы `ffmpeg`. */
  private _plan(
    input: AttachmentCompressInput,
    target: AttachmentCompressTarget,
  ): CompressionPlan | null {
    const config = this._config();
    if (!config?.enabled) return null;

    switch (input.family) {
      case 'image': {
        const settings = config.image;
        if (!settings?.enabled) return null;
        const maxSide = knownMaxSide(input);
        // Размеры в пределах и файл маленький — не трогаем; превышение кадра
        // сжимаем даже при `size < minBytes`.
        if (maxSide !== null && maxSide <= settings.maxSidePx && input.size < settings.minBytes) {
          return null;
        }
        const png = normalizeMime(input.mime) === 'image/png';
        const ext = png ? 'png' : 'jpg';
        const scale = `scale='min(${settings.maxSidePx},iw)':-2`;
        const args = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          '{input}',
          '-frames:v',
          '1',
          '-vf',
          scale,
          ...(png
            ? ['-c:v', 'png', '-compression_level', '9', '-f', 'image2']
            : ['-c:v', 'mjpeg', '-q:v', String(jpegQualityValue(settings.quality)), '-f', 'image2']),
          '{output}',
        ];
        return {
          ext,
          mime: png ? 'image/png' : 'image/jpeg',
          profile: `image-${settings.maxSidePx}-${png ? 'lossless' : `q${settings.quality}`}`,
          args,
        };
      }
      case 'video': {
        const settings = config.video;
        if (!settings?.enabled) return null;
        // Видео сжимаем только на нативном пути; иначе работают кадры (derive).
        if (!target.nativeVideo) return null;
        const height = typeof input.height === 'number' && input.height > 0 ? input.height : null;
        if (height !== null && height <= settings.maxHeightPx && input.size < settings.minBytes) {
          return null;
        }
        if (height === null && input.size < settings.minBytes) return null;
        const maxRate = Math.round(settings.bitrateKbps * 1.5);
        const args = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          '{input}',
          '-vf',
          `scale=-2:'min(${settings.maxHeightPx},ih)'`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-b:v',
          `${settings.bitrateKbps}k`,
          '-maxrate',
          `${maxRate}k`,
          '-bufsize',
          `${settings.bitrateKbps * 2}k`,
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          `${settings.audioBitrateKbps}k`,
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          '{output}',
        ];
        return {
          ext: 'mp4',
          mime: 'video/mp4',
          profile: `video-${settings.maxHeightPx}-${settings.bitrateKbps}-a${settings.audioBitrateKbps}`,
          args,
        };
      }
      case 'audio': {
        const settings = config.audio;
        if (!settings?.enabled) return null;
        // Транспорт не принимает целевой контейнер — сжатие не участвует.
        if (target.audioFormat === null) return null;
        if (input.size < settings.minBytes) return null;
        const format = target.audioFormat;
        const args = [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          '{input}',
          '-vn',
          ...(format === 'mp3'
            ? [
                '-c:a',
                'libmp3lame',
                '-b:a',
                `${settings.bitrateKbps}k`,
                '-ac',
                String(settings.channels),
                '-ar',
                String(settings.sampleRateHz),
                '-f',
                'mp3',
              ]
            : [
                '-c:a',
                'pcm_s16le',
                '-ac',
                String(settings.channels),
                '-ar',
                String(settings.sampleRateHz),
                '-f',
                'wav',
              ]),
          '{output}',
        ];
        return {
          ext: format,
          mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          profile:
            format === 'mp3'
              ? `audio-mp3-${settings.bitrateKbps}-${settings.channels}-${settings.sampleRateHz}`
              : `audio-wav-${settings.channels}-${settings.sampleRateHz}`,
          args,
        };
      }
    }
  }
}

/** Длинная сторона кадра, если известны обе стороны; иначе `null`. */
function knownMaxSide(input: AttachmentCompressInput): number | null {
  if (typeof input.width !== 'number' || typeof input.height !== 'number') return null;
  if (input.width <= 0 || input.height <= 0) return null;
  return Math.max(input.width, input.height);
}

/** Результат сжатия с необязательным именем. */
function withName(
  blobPath: string,
  mime: string,
  size: number,
  name: string | undefined,
): CompressedAttachment {
  return {
    blobPath,
    mime,
    size,
    ...(name ? { name } : {}),
  };
}
