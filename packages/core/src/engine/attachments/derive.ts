/**
 * ADR-115 §«Модели обработки по модальностям»: обработка вложения aux-моделью.
 *
 * Модель сессии модальность не принимает (текстовая модель и картинка) — тогда
 * вложение обрабатывает назначенная владельцем **модель обработки** семейства
 * (`attachments.modalityModels`), а в диалог попадает **текст** (описание,
 * транскрипт, извлечённый текст). Модель сессии при этом **не меняется**: aux —
 * отдельный вызов через `GatewayProvider` (ADR-036), история/стоимость/
 * prompt-cache остаются привязаны к модели сессии.
 *
 * ## Что уходит aux-модели
 *
 *  - `image` — часть как есть;
 *  - `pdf` — часть как есть (`file`/`document`);
 *  - `audio` — `wav`/`mp3` как есть, прочие контейнеры (`ogg`/`m4a`/`flac`/…)
 *    транскодируются внешним `ffmpeg` в wav 16 кГц mono: многие провайдеры
 *    принимают только wav/mp3, а отдавать им ogg «как есть» — гарантированная
 *    ошибка. Нет `ffmpeg` → `no_ffmpeg` (вызывающий отбрасывает вложение
 *    обычным путём — с путём в workspace);
 *  - `video` — **только через кадры**: видео-входа у провайдеров почти нет,
 *    поэтому `ffmpeg` извлекает до `MAX_VIDEO_FRAMES` кадров (равномерно по
 *    длительности, если она известна из `part.data.durationMs`), кадры уходят
 *    как image-части, а промпт просит описать содержимое по кадрам. Нет
 *    `ffmpeg` → `no_ffmpeg`.
 *
 * Байты, полученные обработкой (транскод, кадры), кладутся в blob-хранилище
 * (`attachments/.derived/<key>.<ext>`) — `MediaPartData` **не** несёт base64,
 * часть всегда ссылается на объект (ADR-115/ADR-116), поэтому aux-вызов читает
 * их тем же путём, что и обычные вложения.
 *
 * ## Кэш результата
 *
 * Ключ — `sha256(blobPath | provider/model | family)` (hex): результат зависит
 * от содержимого объекта (content-addressed путь) и от модели обработки.
 * Файл — `attachments/.derived/<key>.json` (`{version:1, text, at}`). Кэш
 * необязателен: ошибки чтения/записи только логируются (битый или чужой версии
 * файл — пересчёт), попадание в кэш → `cached: true`.
 *
 * ## Ошибки
 *
 * Внешние сбои не бросаются наружу: aux-вызов/`ffmpeg`/чтение объекта →
 * `{ok:false, reason:'failed'}` + `log` (ход сессии из-за обработки падать не
 * должен). `no_ffmpeg` — отдельная причина: вызывающий может попробовать
 * обычный путь «вложение отброшено и материализовано».
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMediaPart, type MediaPartData, type Part } from '@itphx/synth-shared';
import type { BlobStore } from '../../storage/ports/blob-store.js';

/** Каталог производных объектов и кэша результатов (внутри blob-хранилища). */
export const DERIVE_CACHE_DIR = 'attachments/.derived';

/** Версия формата кэша: чужая/старая запись — пересчёт. */
const DERIVE_CACHE_VERSION = 1;

/** Сколько кадров извлекаем из видео (равномерно по длительности). */
export const MAX_VIDEO_FRAMES = 5;

/** Предел объёма производного объекта (транскод/кадры), байт. */
export const MAX_DERIVED_BYTES = 32 * 1024 * 1024;

/** Таймаут одного вызова `ffmpeg`, мс (зависший процесс не держит ход). */
const FFMPEG_TIMEOUT_MS = 60_000;

/** Семейство вложения, для которого ищется модель обработки. */
export type DeriveFamily = 'image' | 'pdf' | 'audio' | 'video';

/** Причина, по которой обработка не дала текста. */
export type DeriveFailureReason = 'no_ffmpeg' | 'unsupported' | 'failed';

/**
 * Результат обработки:
 *  - `ok: true` — текст результата (`cached` — из кэша, aux-вызов не делался);
 *  - `ok: false` — `no_ffmpeg` (нужен внешний `ffmpeg`), `unsupported`
 *    (вложение не годится для обработки этим путём), `failed` (aux-вызов,
 *    `ffmpeg` или чтение объекта не удались — подробности в `log`).
 */
export type DeriveResult =
  | { ok: true; text: string; cached: boolean }
  | { ok: false; reason: DeriveFailureReason };

/** Вход обработки: готовая часть вложения + модель обработки. */
export interface DeriveInput {
  family: DeriveFamily;
  mime: string;
  name?: string;
  blobPath: string;
  /** Часть вложения, собранная `AttachmentService.buildMediaPart`. */
  part: Part;
  /** Провайдер модели обработки (`attachments.modalityModels[<family>]`). */
  provider: string;
  /** Имя модели обработки. */
  model: string;
  /** Язык промпта/ответа. */
  language: 'ru' | 'en';
}

/** Зависимости обработки (всё внешнее — инъекция, реальные бинарники в тестах не нужны). */
export interface DeriveDeps {
  /** Вызов aux-модели через gateway: части вложения + промпт → текст. */
  chat: (parts: Part[], prompt: string) => Promise<{ text: string }>;
  /** Blob-хранилище: кэш результата и производные объекты. */
  blobs: BlobStore;
  /**
   * Сырое чтение байтов объекта для `ffmpeg`. Не задано — используется
   * `blobs.read` (порт умеет отдавать содержимое целиком).
   */
  blobsRead?: (path: string) => Promise<Buffer | null>;
  /** Есть ли `ffmpeg` в окружении (см. `isFfmpegAvailable`, ADR-078). */
  hasFfmpeg: () => boolean;
  /**
   * Запуск `ffmpeg` с байтами входа; stdout — кусками. Не задан — реальный
   * `spawn('ffmpeg', …)` с временным файлом (в тестах всегда инъекция).
   */
  runFfmpeg?: (args: string[], input: Buffer) => Promise<Buffer[]>;
  /**
   * Шаблон промпта для языка (`ContextConfig.getMediaDeriveTemplate`).
   * Плейсхолдеры `{modality}` и `{name}` подставляет этот модуль. Пусто/не
   * задан — короткая техническая инструкция на английском (канал LLM, ADR-041).
   */
  promptTemplate?: (language: 'ru' | 'en') => string;
  /** Лог предупреждений (по умолчанию — молча). */
  log?: (msg: string) => void;
}

/** Аудио-контейнеры, которые уходят провайдеру без транскодирования. */
const NATIVE_AUDIO_MIMES: ReadonlySet<string> = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/mp3',
]);

/**
 * Техническая инструкция на случай, когда файла шаблона нет (промпты не
 * поставлены/каталог пуст). Английский — канал LLM (ADR-041), формат — как у
 * `prompts/system/MEDIA_DERIVE.md`.
 */
const DEFAULT_PROMPT =
  '[MEDIA DERIVE] You are processing an attachment that the main model does not accept. ' +
  'Modality: {modality}. File: {name}. Return only the result without reasoning: ' +
  'image — describe it in detail and extract all visible text; ' +
  'pdf — extract all text preserving the structure; ' +
  'audio — verbatim transcript with speaker labels when possible; ' +
  'video — describe the content frame by frame (actions, on-screen text, scenes).';

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Ключ кэша результата: содержимое объекта (path), модель обработки и семейство.
 * hex — пригодно как имя файла и как основа имени производных объектов.
 */
export function deriveCacheKey(
  input: Pick<DeriveInput, 'blobPath' | 'provider' | 'model' | 'family'>,
): string {
  return sha256Hex(`${input.blobPath}|${input.provider}/${input.model}|${input.family}`);
}

/** Путь файла кэша результата (`attachments/.derived/<key>.json`). */
export function deriveCachePath(
  input: Pick<DeriveInput, 'blobPath' | 'provider' | 'model' | 'family'>,
): string {
  return `${DERIVE_CACHE_DIR}/${deriveCacheKey(input)}.json`;
}

/** Данные медиа-части (blobPath/mime/метаданные); `null` — часть не медиа. */
function partData(part: Part | undefined): Partial<MediaPartData> | null {
  const data = part?.data;
  if (!data || typeof data !== 'object') return null;
  return data as Partial<MediaPartData>;
}

/** Совпадает ли MIME семейству (страховка от перепутанных аргументов). */
function mimeMatchesFamily(mime: string, family: DeriveFamily): boolean {
  if (family === 'pdf') return mime === 'application/pdf';
  return mime.startsWith(`${family}/`);
}

/** Промпт для aux-модели: шаблон языка с подстановкой `{modality}`/`{name}`. */
function renderPrompt(input: DeriveInput, deps: DeriveDeps): string {
  let fromFile = '';
  try {
    fromFile = deps.promptTemplate?.(input.language) ?? '';
  } catch {
    // Шаблон недоступен (файл/порт) — работаем по технической инструкции.
    fromFile = '';
  }
  const template = fromFile.trim().length > 0 ? fromFile : DEFAULT_PROMPT;
  const name = input.name?.trim() || '—';
  // split/join — подстановка без интерпретации `$`-паттернов в именах файлов.
  return template.split('{modality}').join(input.family).split('{name}').join(name);
}

/** Есть ли `ffmpeg`: ошибка проверки считается «нет» (обработка не выполняется). */
function hasFfmpeg(deps: DeriveDeps): boolean {
  try {
    return deps.hasFfmpeg();
  } catch {
    return false;
  }
}

/** Чтение байтов объекта: инъекция `blobsRead`, иначе порт; ошибка → `null`. */
async function readBlob(deps: DeriveDeps, path: string): Promise<Buffer | null> {
  try {
    return deps.blobsRead ? await deps.blobsRead(path) : await deps.blobs.read(path);
  } catch {
    return null;
  }
}

/** Результат из кэша; `null` — нет/битый/чужой версии (пересчёт). */
async function readCache(deps: DeriveDeps, path: string): Promise<string | null> {
  try {
    const bytes = await deps.blobs.read(path);
    if (!bytes) return null;
    const parsed = JSON.parse(bytes.toString('utf-8')) as {
      version?: unknown;
      text?: unknown;
    } | null;
    if (!parsed || parsed.version !== DERIVE_CACHE_VERSION) return null;
    if (typeof parsed.text !== 'string' || parsed.text.trim() === '') return null;
    return parsed.text;
  } catch {
    // Битый JSON/нечитаемый объект — кэша нет.
    return null;
  }
}

/** Запись кэша; ошибка не ломает обработку (результат уже получен). */
async function writeCache(deps: DeriveDeps, path: string, text: string): Promise<void> {
  try {
    const payload = JSON.stringify({
      version: DERIVE_CACHE_VERSION,
      text,
      at: new Date().toISOString(),
    });
    await deps.blobs.write(path, payload);
  } catch (err) {
    deps.log?.(`[MediaDerive] кэш результата не записан (${path}): ${describeError(err)}`);
  }
}

/** Текст ошибки без стектрейса (в лог, не в диалог). */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Реальный запуск `ffmpeg`: вход — временный файл, stdout — кусками.
 *
 * MP4/WebM с `moov` в конце не читаются из неразмеченного stdin (`partial
 * file` → `Could not open encoder before EOF`), поэтому байты сначала
 * сохраняются во временный файл, а `pipe:0` заменяется на путь. Файл удаляется
 * в `finally`; таймаут и предел вывода — чтобы зависший/раздувшийся транскод не
 * держал ход сессии. Только `spawn` с argv (без shell).
 */
async function runFfmpegSpawn(args: string[], input: Buffer): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'synth-ffmpeg-'));
  const inputPath = join(dir, 'input.bin');
  try {
    await writeFile(inputPath, input);
    return await spawnFfmpeg(args.map((arg) => (arg === 'pipe:0' ? inputPath : arg)));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnFfmpeg(args: string[]): Promise<Buffer[]> {
  return new Promise<Buffer[]>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (err: Error | null, value?: Buffer[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value ?? []);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`ffmpeg не завершился за ${FFMPEG_TIMEOUT_MS} мс`));
    }, FFMPEG_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DERIVED_BYTES) {
        child.kill('SIGKILL');
        finish(new Error(`вывод ffmpeg превысил ${MAX_DERIVED_BYTES} байт`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) {
        finish(null, chunks.length > 0 ? [Buffer.concat(chunks)] : []);
        return;
      }
      const tail = Buffer.concat(errors).toString('utf-8').trim().slice(-400);
      finish(new Error(`ffmpeg вышел с кодом ${code}${tail ? `: ${tail}` : ''}`));
    });
  });
}

/** Аргументы транскодирования аудио в wav 16 кГц mono. */
function audioTranscodeArgs(): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    'wav',
    '-ar',
    '16000',
    '-ac',
    '1',
    'pipe:1',
  ];
}

/**
 * Аргументы упаковки аудио в MP4 с чёрным видео-треком.
 *
 * Нужно моделям с `video`, но без `audio`: они принимают видеофайл, а
 * отдельную аудиодорожку — нет. Чёрный кадр — техническая «подложка», чтобы
 * контейнер был валидным видео; модель слышит звук, а системная пометка
 * сообщает, что визуального содержимого в оригинале не было.
 *
 * `frag_keyframe+empty_moov` — MP4 пишется в stdout без seek (moov вперёд).
 */
function audioAsVideoArgs(): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=640x360:r=2',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ];
}

/**
 * Аргументы извлечения кадров: до `MAX_VIDEO_FRAMES` кадров JPEG на stdout.
 *
 * Длительность известна (`part.data.durationMs`) — частота выбирается так,
 * чтобы кадры распределились по всему ролику (`5 / duration`); неизвестна —
 * `fps=1` (первая секунда на кадр, не более пяти): равномерность по всему
 * ролику в этом случае не гарантируется, но результат стабилен и дешёв.
 */
function videoFrameArgs(durationMs: number | undefined): string[] {
  const seconds = typeof durationMs === 'number' && durationMs > 0 ? durationMs / 1000 : 0;
  const fps = seconds > 0 ? Math.min(5, Math.max(MAX_VIDEO_FRAMES / seconds, 0.0001)) : 1;
  const filters = [`fps=${fps.toFixed(4)}`, "scale='min(1280,iw)':-2"];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-vf',
    filters.join(','),
    '-frames:v',
    String(MAX_VIDEO_FRAMES),
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-q:v',
    '3',
    'pipe:1',
  ];
}

/**
 * Разбиение склеенного потока JPEG (`image2pipe` без контейнера) на кадры по
 * маркерам SOI (`FFD8`) / EOI (`FFD9`).
 */
export function splitJpegFrames(bytes: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let index = 0; index + 1 < bytes.length; index++) {
    const marker = bytes[index] === 0xff ? bytes[index + 1] : -1;
    if (marker === 0xd8) {
      start = index;
      index += 1;
      continue;
    }
    if (marker === 0xd9 && start >= 0) {
      frames.push(bytes.subarray(start, index + 2));
      start = -1;
      index += 1;
    }
  }
  return frames;
}

/**
 * Публикация производного объекта в blob-хранилище; `null` — запись не удалась.
 * Часть ссылается на объект (base64 в `MediaPartData` не хранится).
 */
async function storeDerived(
  deps: DeriveDeps,
  key: string,
  suffix: string,
  bytes: Buffer,
  mime: string,
): Promise<MediaPartData | null> {
  const blobPath = `${DERIVE_CACHE_DIR}/${key}${suffix}`;
  try {
    await deps.blobs.write(blobPath, bytes);
  } catch (err) {
    deps.log?.(`[MediaDerive] производный объект не записан (${blobPath}): ${describeError(err)}`);
    return null;
  }
  return {
    blobPath,
    sha256: sha256Hex(bytes),
    mime,
    size: bytes.length,
    name: `${key.slice(0, 12)}${suffix}`,
  };
}

/** Итог подготовки частей: либо части, либо причина отказа. */
type PartsResult = { ok: true; parts: Part[] } | { ok: false; reason: DeriveFailureReason };

/**
 * Подготовка частей для aux-вызова по семейству вложения.
 *
 * `key` — ключ кэша: производные объекты именуются им (уникальны для пары
 * «объект × модель × семейство»), поэтому повторная обработка не плодит копий.
 */
async function buildParts(
  input: DeriveInput,
  deps: DeriveDeps,
  key: string,
  log: (msg: string) => void,
): Promise<PartsResult> {
  const data = partData(input.part);
  if (!data || typeof data.blobPath !== 'string' || data.blobPath === '') {
    log(`[MediaDerive] часть вложения без blobPath (${input.family}, ${input.mime}) — обработка невозможна`);
    return { ok: false, reason: 'unsupported' };
  }
  if (!mimeMatchesFamily(input.mime, input.family)) {
    log(`[MediaDerive] MIME ${input.mime} не относится к семейству ${input.family}`);
    return { ok: false, reason: 'unsupported' };
  }

  // image/pdf: часть уходит как есть — провайдер (или совместимый aux-путь)
  // сам извлечёт описание/текст.
  if (input.family === 'image' || input.family === 'pdf') {
    return { ok: true, parts: [input.part] };
  }

  // audio: wav/mp3 — как есть, иначе внешний ffmpeg (wav 16k mono).
  if (input.family === 'audio' && NATIVE_AUDIO_MIMES.has(input.mime.toLowerCase())) {
    return { ok: true, parts: [input.part] };
  }

  if (!hasFfmpeg(deps)) {
    log(`[MediaDerive] ${input.family}: нужен ffmpeg (${input.mime}) — программы нет в окружении`);
    return { ok: false, reason: 'no_ffmpeg' };
  }

  const bytes = await readBlob(deps, data.blobPath);
  if (!bytes || bytes.length === 0) {
    log(`[MediaDerive] объект вложения не прочитан (${data.blobPath})`);
    return { ok: false, reason: 'failed' };
  }

  const run = deps.runFfmpeg ?? runFfmpegSpawn;
  let output: Buffer[];
  try {
    output = await run(
      input.family === 'audio' ? audioTranscodeArgs() : videoFrameArgs(data.durationMs),
      bytes,
    );
  } catch (err) {
    log(`[MediaDerive] ffmpeg не справился (${input.family}, ${input.mime}): ${describeError(err)}`);
    return { ok: false, reason: 'failed' };
  }

  if (input.family === 'audio') {
    const wav = output[0];
    if (!wav || wav.length === 0) {
      log(`[MediaDerive] ffmpeg вернул пустой wav (${input.mime})`);
      return { ok: false, reason: 'failed' };
    }
    if (wav.length > MAX_DERIVED_BYTES) {
      log(`[MediaDerive] транскод больше ${MAX_DERIVED_BYTES} байт (${input.mime})`);
      return { ok: false, reason: 'failed' };
    }
    const stored = await storeDerived(deps, key, '.wav', wav, 'audio/wav');
    if (!stored) return { ok: false, reason: 'failed' };
    return { ok: true, parts: [makeMediaPart('audio', stored)] };
  }

  // video: кадры (склеенный mjpeg-поток или уже отдельные буферы инъекции).
  const frames = output.flatMap((chunk) => splitJpegFrames(chunk)).slice(0, MAX_VIDEO_FRAMES);
  if (frames.length === 0) {
    log(`[MediaDerive] ffmpeg не извлёк ни одного кадра (${input.mime})`);
    return { ok: false, reason: 'failed' };
  }
  const parts: Part[] = [];
  for (const [index, frame] of frames.entries()) {
    const stored = await storeDerived(deps, key, `-${index}.jpg`, frame, 'image/jpeg');
    if (!stored) return { ok: false, reason: 'failed' };
    parts.push(makeMediaPart('image', stored));
  }
  return { ok: true, parts };
}

/** Вход упаковки аудио в видео (без готовой `Part`). */
export interface WrapAudioAsVideoInput {
  blobPath: string;
  mime: string;
  name?: string;
  provider: string;
  model: string;
}

/** Результат упаковки аудио в видео: производная часть + её байты. */
export interface WrappedAudioAsVideo {
  part: MediaPartData;
  bytes: Buffer;
}

/**
 * Упаковать аудио в MP4 с чёрным видео-треком (ADR-115).
 *
 * Для моделей, которые заявляют `video`, но не `audio`: отдельную аудиодорожку
 * они не принимают, а видеофайл — принимают (RouterAI `video_url`). Видеоряд —
 * чёрный placeholder; модель слышит звук, а в текст сообщения добавляется
 * пометка, что оригинала «только звук».
 *
 * Возвращает `null`, если ffmpeg недоступен/не справился или объект пуст.
 * Ничего не бросает.
 */
export async function wrapAudioAsVideo(
  input: WrapAudioAsVideoInput,
  deps: DeriveDeps,
): Promise<WrappedAudioAsVideo | null> {
  const log = deps.log ?? (() => undefined);
  if (!input.blobPath) {
    log(`[MediaDerive] аудио без blobPath (${input.mime}) — упаковка в видео невозможна`);
    return null;
  }
  if (!mimeMatchesFamily(input.mime, 'audio')) {
    log(`[MediaDerive] MIME ${input.mime} не аудио — упаковка в видео невозможна`);
    return null;
  }
  if (!hasFfmpeg(deps)) {
    log(`[MediaDerive] audio-as-video: нужен ffmpeg (${input.mime}) — программы нет в окружении`);
    return null;
  }

  // Ключ отдельный от аудио-транскода (`-video`): один и тот же blob может
  // обрабатываться и как wav для aux, и как MP4 для video-модели.
  const key = `${deriveCacheKey({ ...input, family: 'audio' })}-video`;
  const cachedPath = `${DERIVE_CACHE_DIR}/${key}.mp4`;
  try {
    if (await deps.blobs.exists(cachedPath)) {
      const cached = await readBlob(deps, cachedPath);
      if (cached && cached.length > 0) {
        return {
          part: {
            blobPath: cachedPath,
            sha256: sha256Hex(cached),
            mime: 'video/mp4',
            size: cached.length,
            name: audioVideoName(input.name),
          },
          bytes: cached,
        };
      }
    }
  } catch {
    // Кэш — оптимизация; ошибка чтения не мешает пересборке.
  }

  const source = await readBlob(deps, input.blobPath);
  if (!source || source.length === 0) {
    log(`[MediaDerive] объект аудио не прочитан (${input.blobPath})`);
    return null;
  }

  const run = deps.runFfmpeg ?? runFfmpegSpawn;
  let output: Buffer[];
  try {
    output = await run(audioAsVideoArgs(), source);
  } catch (err) {
    log(`[MediaDerive] ffmpeg не упаковал аудио в видео (${input.mime}): ${describeError(err)}`);
    return null;
  }
  const mp4 = output[0];
  if (!mp4 || mp4.length === 0) {
    log(`[MediaDerive] ffmpeg вернул пустой MP4 (${input.mime})`);
    return null;
  }
  if (mp4.length > MAX_DERIVED_BYTES) {
    log(`[MediaDerive] упакованное видео больше ${MAX_DERIVED_BYTES} байт (${input.mime})`);
    return null;
  }

  const stored = await storeDerived(deps, key, '.mp4', mp4, 'video/mp4');
  if (!stored) return null;
  return {
    part: { ...stored, name: audioVideoName(input.name) },
    bytes: mp4,
  };
}

/** Имя аудио-в-видео: базовое имя исходника с расширением `.mp4`. */
function audioVideoName(name: string | undefined): string {
  const base = (name ?? 'audio').replace(/\.[^.]+$/, '').trim() || 'audio';
  return `${base}.mp4`;
}

/**
 * Обработать вложение aux-моделью и получить **текст** для диалога.
 *
 * Порядок: кэш → подготовка частей (транскод/кадры при необходимости) →
 * LLM-вызов через `deps.chat` (GatewayProvider на стороне вызывающего) → кэш.
 * Ничего не бросает: любой внешний сбой — `{ok:false, reason:'failed'}` + `log`.
 */
export async function deriveModalityText(
  input: DeriveInput,
  deps: DeriveDeps,
): Promise<DeriveResult> {
  const log = deps.log ?? (() => undefined);
  const cachePath = deriveCachePath(input);

  const cached = await readCache(deps, cachePath);
  if (cached !== null) return { ok: true, text: cached, cached: true };

  const prepared = await buildParts(input, deps, deriveCacheKey(input), log);
  if (!prepared.ok) return prepared;

  let text: string;
  try {
    const response = await deps.chat(prepared.parts, renderPrompt(input, deps));
    text = typeof response?.text === 'string' ? response.text.trim() : '';
  } catch (err) {
    log(`[MediaDerive] aux-модель не ответила (${input.family}, ${input.mime}): ${describeError(err)}`);
    return { ok: false, reason: 'failed' };
  }

  if (text === '') {
    log(`[MediaDerive] aux-модель вернула пустой результат (${input.family}, ${input.mime})`);
    return { ok: false, reason: 'failed' };
  }

  await writeCache(deps, cachePath, text);
  return { ok: true, text, cached: false };
}
