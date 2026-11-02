/**
 * Сервис вложений сообщений (ADR-115 §«Хранение», §«API и лимиты»).
 *
 * Единственная точка записи/чтения байтов вложения: MIME по сигнатуре, лимиты
 * из конфига, content-addressed адресация (`attachments/<sha2>/<sha256>`) и
 * sidecar-метаданные рядом с объектом.
 *
 * ADR-115 §«Приватность»: в blob пишутся **оригинальные** байты (EXIF и прочие
 * метаданные не теряются — скачивание через API и материализация отдают
 * оригинал). Очистка (`stripMetadata`) выполняется на границе отправки
 * провайдеру — `hydrate.ts` и aux-вызов оркестратора.
 *
 * Почему sidecar: в промпт уходит только путь объекта (`attachments/ab/<sha>`),
 * а имя файла и MIME должны пережить отправку — они лежат в
 * `attachments/ab/<sha>.json`. Читается в `resolve`, фоллбек — повторный sniff.
 *
 * Байты — только через порт `BlobStore` (ADR-096/ADR-116): прямой ФС нет.
 */

import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import type { AttachmentsConfig, MediaPartData, MediaPartType } from '@itphx/synth-shared';
import {
  getAttachmentMetricsHook,
  type AttachmentMetricKind,
  type AttachmentMetricsHooks,
} from '../../metrics/collectors/attachments.js';
import type { BlobReadRange, BlobStore } from '../../storage/ports/blob-store.js';
import { looksLikeSvg, normalizeMime, sniffMime } from './sniff-mime.js';

/** Каталог вложений в blob-хранилище (относительный путь порта). */
export const ATTACHMENT_DIR = 'attachments';
/** Суффикс sidecar-файла с метаданными объекта. */
export const ATTACHMENT_SIDECAR_SUFFIX = '.json';
/**
 * Временные объекты потоковой загрузки: пока считаются sha256 и MIME, байты
 * лежат здесь, затем переносятся в content-addressed путь (`ATTACHMENT_DIR`).
 *
 * Имена — случайные (`uuid`), в сообщениях такие пути не встречаются: контур
 * раздачи адресует только `attachments/<sha2>/<sha256>`. Забытый временный
 * объект (`обрыв клиента`) не имеет ссылок и уходит в GC как сирота.
 */
export const ATTACHMENT_UPLOAD_DIR = `${ATTACHMENT_DIR}/.uploads`;

/**
 * Сколько байт начала потока достаточно для определения MIME
 * (`sniffMime`/`looksLikeSvg` смотрят только префикс, SVG — первые 4 КиБ).
 */
const MIME_HEAD_BYTES = 4096;

/** Код ошибки загрузки — маппится в HTTP на границе (`413`/`415`/`400`). */
export type AttachmentErrorCode =
  | 'too_large'
  | 'unsupported_mime'
  | 'attachments_disabled'
  /**
   * Пустое тело/поток (`ingestStream`): файла нет — HTTP-ответ `400
   * VALIDATION_ERROR` (как «файл не передан» в multipart-ветке). У `upload`
   * пустой буфер остаётся `unsupported_mime` (поведение не меняем).
   */
  | 'empty';

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
  /** Ширина/высота кадра — из sidecar (ADR-115, нужно сжатию на отправке). */
  width?: number;
  height?: number;
  /** Длительность медиа (мс) — из sidecar. */
  durationMs?: number;
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
  /** ADR-115: метаданные серверной миниатюры (пишет `ThumbnailService`). */
  thumb?: AttachmentThumbnailMeta;
}

/** Метаданные серверной миниатюры вложения (ADR-115). */
export interface AttachmentThumbnailMeta {
  /** `ready` — файл миниатюры есть, `none` — превью не делается. */
  status: 'ready' | 'none';
  width?: number;
  height?: number;
}

/** Готовая миниатюра для HTTP-раздачи. */
export interface AttachmentThumbnailView {
  stream: Readable;
  mime: string;
  size: number;
  /**
   * Ширина кадра, px (из настроек `attachments.thumbnail.maxWidthPx`, с которой
   * найдена миниатюра). Нужна для ETag: при смене ширины отдаётся другой кадр,
   * и клиентский кэш должен это увидеть (`"thumb-<sha256>-<width>"`).
   */
  width: number;
}

/**
 * Провайдер миниатюр (реализация — `ThumbnailService`). Сервис только
 * делегирует: генерация идёт вне загрузки, ошибки провайдера не ломают ответ.
 */
export interface AttachmentThumbnailProvider {
  ensure(input: {
    blobPath: string;
    mime: string;
    durationMs?: number;
  }): Promise<AttachmentThumbnailMeta>;
  get(blobPath: string): Promise<AttachmentThumbnailView | null>;
}

export interface AttachmentServiceDeps {
  blobs: BlobStore;
  /**
   * Конфигурация вложений: статический снимок **или** резолвер (ADR-115).
   *
   * Резолвер читается на **каждый** вызов (`upload`): настройки из админки
   * (`/api/v2/settings/attachments`) применяются без рестарта. Чтение
   * (`resolve`/`read`/`buildMediaPart`) конфиг не использует.
   */
  config: AttachmentsConfig | (() => AttachmentsConfig);
  /** Лог предупреждений (по умолчанию `console.warn`). */
  log?: (message: string) => void;
  /**
   * ADR-115: провайдер серверных миниатюр. Задан — после записи объекта
   * миниатюра генерируется **асинхронно** (`void …catch(log)`), ответ 201 не
   * задерживается; ошибка/нет `ffmpeg` → `none`, загрузка не падает.
   */
  thumbnails?: AttachmentThumbnailProvider;
  /**
   * ADR-094: метрики вложений (`synth_attachment_*`). Не задан — берётся
   * модульный sink (`getAttachmentMetricsHook`), который ставит контейнер
   * зависимостей при `metrics.enabled=true`; выключенные метрики — no-op.
   */
  metrics?: AttachmentMetricsHooks;
}

export class AttachmentService {
  private readonly _blobs: BlobStore;
  private readonly _configSource: AttachmentsConfig | (() => AttachmentsConfig);
  private readonly _log: (message: string) => void;
  private readonly _metrics?: AttachmentMetricsHooks;
  private readonly _thumbnails?: AttachmentThumbnailProvider;

  constructor(deps: AttachmentServiceDeps) {
    this._blobs = deps.blobs;
    this._configSource = deps.config;
    this._log = deps.log ?? ((message) => console.warn(message));
    this._metrics = deps.metrics;
    this._thumbnails = deps.thumbnails;
  }

  /**
   * Эффективная конфигурация на текущий момент (ADR-115): резолвер читается
   * на каждый вызов — runtime-настройки из админки применяются сразу.
   */
  private get _config(): AttachmentsConfig {
    return typeof this._configSource === 'function' ? this._configSource() : this._configSource;
  }

  /**
   * Конфигурация вложений только для чтения (лимиты/модальности).
   *
   * Нужна потребителям, которые не загружают байты, а **проверяют** ссылки:
   * приём внешних событий (ADR-089) сверяет количество и размеры вложений
   * события с теми же лимитами, что действуют на загрузку.
   */
  get config(): AttachmentsConfig {
    return this._config;
  }

  /**
   * Blob-порт, с которым работает сервис.
   *
   * Нужен chunked-загрузке (`engine/attachments/uploads.ts`): временный объект
   * собирается дописыванием частей, а сам сервис остаётся единственной точкой
   * публикации (MIME по сигнатуре, лимиты, дедуп, sidecar).
   */
  get blobs(): BlobStore {
    return this._blobs;
  }

  /** Метрики вложений: явные из опций приоритетнее модульного sink'а. */
  private get _metricsHooks(): AttachmentMetricsHooks | null {
    return this._metrics ?? getAttachmentMetricsHook();
  }

  /**
   * Загрузить вложение: проверить размер и MIME, записать объект (если такого
   * содержимого ещё нет) и sidecar.
   *
   * `sessionId` не используется (адресация content-addressed, объект общий):
   * параметр оставлен для существующих вызовов; staging-загрузка шлюзов и
   * пайплайнов вызывает `upload` без него.
   */
  async upload(input: {
    sessionId?: string;
    bytes: Buffer;
    name?: string;
    declaredMime?: string;
  }): Promise<UploadedAttachmentMeta> {
    const raw = input.bytes;
    // ADR-115: конфигурация читается на каждый вызов — runtime-настройки
    // (мастер-выключатель, модальности, лимиты) применяются без рестарта.
    const config = this._config;
    // ADR-094: метрики попыток — вид вложения best-effort (сигнатура → MIME),
    // чтобы отказ тоже был размечен (невалидный MIME всё равно имеет вид).
    const metrics = this._metricsHooks;
    const kind = metrics ? uploadKindHint(raw, input.declaredMime) : 'file';
    if (!config.enabled) {
      metrics?.onUpload({ outcome: 'unsupported', kind });
      throw new AttachmentError('attachments_disabled', 'Вложения отключены администратором');
    }
    if (raw.length === 0) {
      metrics?.onUpload({ outcome: 'unsupported', kind });
      throw new AttachmentError('unsupported_mime', 'Пустой файл: MIME по содержимому не определяется');
    }
    if (raw.length > config.maxBytesPerFile) {
      metrics?.onUpload({ outcome: 'too_large', kind });
      throw new AttachmentError(
        'too_large',
        `Размер вложения ${raw.length} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }

    const mime = this._resolveMime(raw, input.declaredMime);
    try {
      this._assertAllowed(mime, config);
    } catch (err) {
      metrics?.onUpload({ outcome: 'unsupported', kind: partTypeOf(mime) });
      throw err;
    }

    // ADR-115 §«Приватность»: адрес и sidecar описывают **оригинал** — байты в
    // blob не меняются. Метаданные срезаются только при отправке провайдеру
    // (`hydrate.ts`, aux-вызов оркестратора), а не на записи.
    const bytes = raw;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blobPath = `${ATTACHMENT_DIR}/${sha256.slice(0, 2)}/${sha256}`;
    const name = sanitizeFileName(input.name);

    return this._finalize({
      blobPath,
      sha256,
      mime,
      size: bytes.length,
      ...(name ? { name } : {}),
      publish: () => this._blobs.write(blobPath, bytes),
    });
  }

  /**
   * ADR-115: загрузка вложения **потоком** (`POST …/attachments` raw-body).
   *
   * Крупное тело (видео) не буферизуется: байты идут во временный объект
   * (`attachments/.uploads/<uuid>`), инкрементально считаются sha256 и лимит,
   * первые ~4 КиБ дают MIME по сигнатуре. Затем объект переносится в
   * content-addressed путь (`blobs.move`) и получает sidecar — дальше всё как у
   * `upload` (дедуп, миниатюра, метрики).
   *
   * Отказ по лимиту обрывает поток (`AttachmentError('too_large')`) и удаляет
   * временный объект; ошибка/обрыв клиента — тоже (наружу уходит исходная
   * ошибка, ход не падает).
   */
  async ingestStream(input: {
    stream: Readable;
    name?: string;
    declaredMime?: string;
    /** Заявленный размер (`content-length`): ранний отказ без чтения потока. */
    sizeHint?: number;
  }): Promise<UploadedAttachmentMeta> {
    // ADR-115: конфигурация читается на каждый вызов (runtime без рестарта).
    const config = this._config;
    const metrics = this._metricsHooks;
    if (!config.enabled) {
      metrics?.onUpload({ outcome: 'unsupported', kind: 'file' });
      throw new AttachmentError('attachments_disabled', 'Вложения отключены администратором');
    }
    if (typeof input.sizeHint === 'number' && input.sizeHint > config.maxBytesPerFile) {
      input.stream.destroy();
      metrics?.onUpload({ outcome: 'too_large', kind: declaredKindHint(input.declaredMime) });
      throw new AttachmentError(
        'too_large',
        `Размер вложения ${input.sizeHint} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }

    const tempPath = `${ATTACHMENT_UPLOAD_DIR}/${randomUUID()}`;
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    let mime: string | undefined;

    /** MIME по первым байтам + проверка модальности/allowlist (один раз). */
    const resolveMime = (): string => {
      const resolved = this._resolveMime(head, input.declaredMime);
      this._assertAllowed(resolved, config);
      return resolved;
    };

    // Байты считаются по ходу: превышение лимита рвёт поток (генератор
    // закрывает источник), sha256 копится инкрементально, голова — для MIME
    // (её хватает первых ~4 КиБ: `sniffMime`/`looksLikeSvg` смотрят префикс).
    const guard = async function* (source: Readable): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer);
        size += buf.length;
        if (size > config.maxBytesPerFile) {
          throw new AttachmentError(
            'too_large',
            `Размер вложения ${size} Б превышает предел ${config.maxBytesPerFile} Б`,
          );
        }
        hash.update(buf);
        if (mime === undefined && head.length < MIME_HEAD_BYTES) {
          head = Buffer.concat([head, buf.subarray(0, MIME_HEAD_BYTES - head.length)]);
          if (head.length >= MIME_HEAD_BYTES) mime = resolveMime();
        }
        yield buf;
      }
      // Пустой файл — как в `upload`: MIME по содержимому не определяется.
      // Для HTTP это «файл не передан» (`400 VALIDATION_ERROR`).
      if (size === 0) {
        throw new AttachmentError('empty', 'Пустой файл: MIME по содержимому не определяется');
      }
      if (mime === undefined) mime = resolveMime();
    };

    try {
      await this._blobs.writeStream(tempPath, Readable.from(guard(input.stream)));
    } catch (err) {
      await this._blobs.delete(tempPath);
      if (err instanceof AttachmentError) {
        metrics?.onUpload({
          outcome: err.code === 'too_large' ? 'too_large' : 'unsupported',
          kind: mime ? partTypeOf(mime) : uploadKindHint(head, input.declaredMime),
        });
      }
      throw err;
    }

    const sha256 = hash.digest('hex');
    const blobPath = `${ATTACHMENT_DIR}/${sha256.slice(0, 2)}/${sha256}`;
    const name = sanitizeFileName(input.name);
    const finalMime = mime;
    if (!finalMime) {
      // Защита от «тихого» принятия без MIME: поток завершён, но тип не определён.
      await this._blobs.delete(tempPath);
      metrics?.onUpload({ outcome: 'unsupported', kind: 'file' });
      throw new AttachmentError('unsupported_mime', 'MIME вложения не определён');
    }

    try {
      return await this._finalize({
        blobPath,
        sha256,
        mime: finalMime,
        size,
        ...(name ? { name } : {}),
        publish: () => this._blobs.move(tempPath, blobPath),
        discard: () => this._blobs.delete(tempPath),
      });
    } catch (err) {
      // Перенос не состоялся (или дедуп не потребовал его) — временный объект убираем.
      await this._blobs.delete(tempPath);
      throw err;
    }
  }

  /**
   * ADR-115 (B2a): финализация **chunked**-загрузки — временный объект уже
   * собран частями (`UploadSessionStore`), здесь он проверяется и публикуется
   * как обычное вложение.
   *
   * Отличие от `ingestStream`: источник — готовый объект blob-порта, поэтому
   * MIME и sha256 считаются повторным потоковым проходом (память постоянна), а
   * публикация — `blobs.move` (или удаление временного при дедупе). Временный
   * объект удаляется при **любой** ошибке; наружу — `AttachmentError`
   * (`empty`/`too_large`/`unsupported_mime`/`attachments_disabled`).
   */
  async ingestPath(
    path: string,
    input: { name?: string; declaredMime?: string } = {},
  ): Promise<UploadedAttachmentMeta> {
    const config = this._config;
    const metrics = this._metricsHooks;
    if (!config.enabled) {
      metrics?.onUpload({ outcome: 'unsupported', kind: declaredKindHint(input.declaredMime) });
      throw new AttachmentError('attachments_disabled', 'Вложения отключены администратором');
    }

    const discardTemp = async (): Promise<void> => {
      await this._blobs.delete(path).catch(() => undefined);
    };

    const stat = await this._blobs.stat(path);
    if (!stat || stat.size === 0) {
      await discardTemp();
      metrics?.onUpload({ outcome: 'unsupported', kind: declaredKindHint(input.declaredMime) });
      throw new AttachmentError('empty', 'Пустой файл: MIME по содержимому не определяется');
    }
    if (stat.size > config.maxBytesPerFile) {
      await discardTemp();
      metrics?.onUpload({ outcome: 'too_large', kind: declaredKindHint(input.declaredMime) });
      throw new AttachmentError(
        'too_large',
        `Размер вложения ${stat.size} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }

    const stream = await this._blobs.readStream(path);
    if (!stream) {
      await discardTemp();
      metrics?.onUpload({ outcome: 'unsupported', kind: declaredKindHint(input.declaredMime) });
      throw new AttachmentError('empty', 'Пустой файл: MIME по содержимому не определяется');
    }

    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    let mime: string | undefined;
    try {
      for await (const chunk of stream) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : (chunk as Buffer);
        size += buf.length;
        // Лимит проверяется и по `stat` (выше), и по факту: временный объект
        // мог дорасти между вызовами.
        if (size > config.maxBytesPerFile) {
          throw new AttachmentError(
            'too_large',
            `Размер вложения ${size} Б превышает предел ${config.maxBytesPerFile} Б`,
          );
        }
        hash.update(buf);
        if (head.length < MIME_HEAD_BYTES) {
          head = Buffer.concat([head, buf.subarray(0, MIME_HEAD_BYTES - head.length)]);
        }
      }
      if (size === 0) {
        throw new AttachmentError('empty', 'Пустой файл: MIME по содержимому не определяется');
      }
      mime = this._resolveMime(head, input.declaredMime);
      this._assertAllowed(mime, config);
    } catch (err) {
      stream.destroy();
      await discardTemp();
      if (err instanceof AttachmentError) {
        metrics?.onUpload({
          outcome: err.code === 'too_large' ? 'too_large' : 'unsupported',
          kind: mime ? partTypeOf(mime) : uploadKindHint(head, input.declaredMime),
        });
      }
      throw err;
    }

    const sha256 = hash.digest('hex');
    const blobPath = `${ATTACHMENT_DIR}/${sha256.slice(0, 2)}/${sha256}`;
    const name = sanitizeFileName(input.name);
    if (!mime) {
      // Защита от «тихого» принятия без MIME (поток завершён, тип не определён).
      await discardTemp();
      metrics?.onUpload({ outcome: 'unsupported', kind: 'file' });
      throw new AttachmentError('unsupported_mime', 'MIME вложения не определён');
    }
    try {
      return await this._finalize({
        blobPath,
        sha256,
        mime,
        size,
        ...(name ? { name } : {}),
        publish: () => this._blobs.move(path, blobPath),
        discard: () => this._blobs.delete(path),
      });
    } catch (err) {
      // Перенос не состоялся (или дедуп не потребовал его) — временный объект убираем.
      await discardTemp();
      throw err;
    }
  }

  /**
   * Общий финал загрузки (`upload` и `ingestStream`): дедуп по content-addressed
   * пути, sidecar, асинхронная миниатюра, метрики и метаданные ответа.
   *
   * `publish` вызывается **только** когда объекта ещё нет (буфер — запись,
   * поток — перенос временного файла); `discard` — уборка временного объекта,
   * если публикация не нужна (дедуп).
   */
  private async _finalize(input: {
    blobPath: string;
    sha256: string;
    mime: string;
    size: number;
    name?: string;
    publish: () => Promise<void>;
    discard?: () => Promise<void>;
  }): Promise<UploadedAttachmentMeta> {
    const { blobPath, sha256, mime, size, name } = input;
    const sidecar: AttachmentSidecar = {
      mime,
      size,
      sha256,
      ...(name ? { name } : {}),
    };

    const exists = await this._blobs.exists(blobPath);
    if (!exists) {
      await input.publish();
      await this._writeSidecar(blobPath, sidecar);
    } else {
      // Объект уже есть (дедуп) — временный не нужен; sidecar дописываем, если
      // он потерян/не создан.
      if (input.discard) await input.discard();
      if (!(await this._blobs.exists(this._sidecarPath(blobPath)))) {
        await this._writeSidecar(blobPath, sidecar);
      }
    }

    // ADR-115: миниатюра не задерживает ответ 201. Ошибка (нет ffmpeg,
    // сбой процесса) — `none`, загрузка уже успешна; повторный `ensure` для
    // того же sha переиспользует готовый файл.
    if (this._thumbnails) {
      void this._thumbnails
        .ensure({ blobPath, mime })
        .catch((err: unknown) =>
          this._log(
            `[attachments] миниатюра не создана (${blobPath}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }

    this._metricsHooks?.onUpload({ outcome: 'ok', kind: partTypeOf(mime), bytes: size });
    return {
      id: blobPath,
      blobPath,
      sha256,
      mime,
      size,
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
      ...(typeof sidecar?.width === 'number' && sidecar.width > 0 ? { width: sidecar.width } : {}),
      ...(typeof sidecar?.height === 'number' && sidecar.height > 0 ? { height: sidecar.height } : {}),
      ...(typeof sidecar?.durationMs === 'number' && sidecar.durationMs > 0
        ? { durationMs: sidecar.durationMs }
        : {}),
      stat,
    };
  }

  /** Потоковое чтение объекта вложения (диапазон — включительно, как у `fs`). */
  async read(blobPath: string, range?: BlobReadRange): Promise<Readable | null> {
    if (!isAttachmentPath(blobPath)) return null;
    return this._blobs.readStream(blobPath, range);
  }

  /**
   * ADR-115: готовая серверная миниатюра вложения (`?variant=thumb`).
   * `null` — провайдер не подключён, путь не из `attachments/` или файла нет.
   */
  async thumbnail(blobPath: string): Promise<AttachmentThumbnailView | null> {
    if (!this._thumbnails || !isAttachmentPath(blobPath)) return null;
    return this._thumbnails.get(blobPath);
  }

  /**
   * ADR-115: лениво сгенерировать миниатюру (для старых вложений, загруженных
   * до появления миниатюр). Ошибка/отсутствие провайдера — `null` (запрос не
   * ломается, роут отдаёт 404).
   */
  async ensureThumbnail(
    blobPath: string,
    mime: string,
    durationMs?: number,
  ): Promise<AttachmentThumbnailMeta | null> {
    if (!this._thumbnails || !isAttachmentPath(blobPath)) return null;
    try {
      return await this._thumbnails.ensure({
        blobPath,
        mime,
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
      });
    } catch (err) {
      this._log(
        `[attachments] ленивая миниатюра не создана (${blobPath}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
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

  /** Проверка модальности и белого списка MIME (SVG запрещён всегда). */
  private _assertAllowed(mime: string, config: AttachmentsConfig): void {
    // ADR-115: выключенное семейство (`image`/`pdf`/`audio`/`video`) — отказ,
    // даже если MIME проходит белый список префиксов.
    const modality = attachmentModalityOf(mime);
    if (modality && config.modalities?.[modality] === false) {
      throw new AttachmentError(
        'unsupported_mime',
        `Категория вложений «${modality}» отключена в настройках`,
      );
    }
    if (mime === 'image/svg+xml') {
      throw new AttachmentError(
        'unsupported_mime',
        'Тип image/svg+xml запрещён: SVG может нести скрипт (XSS)',
      );
    }
    const prefixes = config.allowedMimePrefixes ?? [];
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
 * ADR-115: семейство вложений по MIME (`image`/`pdf`/`audio`/`video`).
 * `null` — MIME не относится к настраиваемым семействам (напр. `text/*`).
 */
export function attachmentModalityOf(mime: string): 'image' | 'pdf' | 'audio' | 'video' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || mime.startsWith('application/pdf')) return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

/**
 * ADR-094: вид вложения для метрики попытки загрузки — по сигнатуре содержимого,
 * иначе по заявленному MIME, иначе `file`. Нужен и на отказе (лимит/формат),
 * где итоговый MIME ещё не определён.
 */
function uploadKindHint(bytes: Buffer, declaredMime?: string): AttachmentMetricKind {
  const sniffed = sniffMime(bytes);
  if (sniffed) return partTypeOf(sniffed);
  // SVG сигнатуры не имеет, но запрещён всегда — вид всё равно `image`.
  if (looksLikeSvg(bytes)) return 'image';
  const normalized = normalizeMime(declaredMime);
  return normalized ? partTypeOf(normalized) : 'file';
}

/**
 * Вид вложения по заявленному MIME — для метрик до чтения байтов (ранний отказ
 * по `content-length`/`sizeHint`). Неизвестно → `file`.
 */
function declaredKindHint(declaredMime?: string): AttachmentMetricKind {
  const normalized = normalizeMime(declaredMime);
  return normalized ? partTypeOf(normalized) : 'file';
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
