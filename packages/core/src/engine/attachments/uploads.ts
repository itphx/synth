/**
 * ADR-115 (B2a): серверный **chunked**-протокол загрузки вложения.
 *
 * Зачем: крупные файлы (видео) не должны целиком буферизоваться в памяти и не
 * должны требовать одного длинного соединения. Клиент создаёт сессию загрузки,
 * шлёт части (`maxChunkBytes`), затем завершает — сервис считает sha256/MIME
 * повторным потоковым проходом и публикует объект как обычное вложение
 * (`AttachmentService.ingestPath`).
 *
 * Устройство — **stateless, multi-replica**:
 * - состояние сессии лежит **на томе**, рядом с временным объектом: temp
 *   `attachments/.uploads/<uuid>` и sidecar `attachments/.uploads/<uuid>.json`
 *   (`{version, sessionId?, name?, mime?, createdAt, updatedAt?}`). В памяти
 *   процесса ничего не хранится — реплика control plane, которой достался
 *   запрос, продолжает ту же загрузку;
 * - **смещение — фактический размер временного объекта** (`stat`), а не счётчик
 *   в памяти: `received`/`nextOffset` всегда соответствуют байтам на томе;
 * - привязка к сессии (`sessionId` в sidecar) проверяется на каждой операции:
 *   чужая загрузка не видна (fail-closed, `not_found` → 404);
 * - лимиты и мастер-выключатель читаются из live-конфига `attachments`
 *   (`maxChunkBytes`/`maxBytesPerFile`/`maxBytesPerSession`/
 *   `maxActiveUploadsPerSession`/`maxActiveUploads`/`enabled`) на каждый вызов;
 * - незавершённые загрузки ограничены по объёму (квота сессии) и по числу
 *   (на сессию и глобально, включая staging без `sessionId`): уборка протухших
 *   сессий идёт до подсчёта, а протухшие не попадают в квоту, даже если
 *   ленивая уборка пропущена по троттлингу;
 * - TTL сессии — `UPLOAD_SESSION_TTL_MS` (1 ч) без активности: протухшая
 *   сессия удаляется (temp + sidecar) и больше не доступна; общая уборка —
 *   `pruneExpired` (на `create`) и фоновый GC (`engine/attachments/prune.ts`,
 *   чистит `.uploads` по mtime, TTL 1 ч независимо от `gcDays`).
 *
 * Ограничение multi-replica: том `blobs` должен быть **общим** для реплик
 * control plane — иначе загрузка, начатая на одной реплике, не продолжится на
 * другой (часть попадёт в другой temp-объект либо сессия не найдётся).
 *
 * Гонка: части приходят **последовательно** (клиент шлёт следующую по
 * `nextOffset`); параллельные `append` не гарантируются — проверка смещения
 * по размеру файла отсекает дубль, а ответом всегда фактический размер
 * (`received`/`nextOffset`), с которого клиент продолжит.
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
 * Суффикс sidecar'а сессии загрузки (рядом с временным объектом, на томе).
 *
 * Отдельный от `ATTACHMENT_SIDECAR_SUFFIX` (тот — у content-addressed объектов
 * вложений), но с тем же расширением: файл лежит в служебном каталоге
 * `.uploads`, а не в контуре раздачи вложений.
 */
export const UPLOAD_SESSION_SIDECAR_SUFFIX = '.json';

/** Версия формата sidecar'а сессии загрузки. */
export const UPLOAD_SESSION_SIDECAR_VERSION = 1;

/**
 * Минимальный интервал между полными проходами уборки (мс).
 *
 * Уборка читает перечень каталога `.uploads` (у файлового blob-порта — обход
 * дерева), поэтому на каждый `create` её запускать дорого. Порог — не более
 * одного прохода в минуту на экземпляр стора.
 */
const PRUNE_MIN_INTERVAL_MS = 60_000;

/** Идентификатор сессии загрузки — uuid (выдаёт сервер). */
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Машинные коды отказа протокола chunked-загрузки (маппинг в HTTP — на границе
 * роутов: `not_found` → 404, `offset_mismatch`/`invalid` → 400, прочие → 413).
 * Ошибки лимитов/MIME самого вложения остаются `AttachmentError`.
 */
export type UploadSessionErrorCode =
  | 'not_found'
  | 'offset_mismatch'
  | 'invalid'
  | 'too_large_chunk'
  | 'too_large';

/** Отказ протокола chunked-загрузки (нет сессии, смещение, параметры, лимит части/файла). */
export class UploadSessionError extends Error {
  constructor(
    readonly code: UploadSessionErrorCode,
    message: string,
    /**
     * Лимит, который сработал (для `error.details` HTTP-ответа): квота сессии
     * или число активных загрузок. Необязателен — прежние отказы его не несут.
     */
    readonly details?: {
      maxBytesPerSession?: number;
      maxActiveUploads?: number;
      maxActiveUploadsPerSession?: number;
    },
  ) {
    super(message);
    this.name = 'UploadSessionError';
  }
}

/**
 * Sidecar сессии загрузки (на томе, рядом с временным объектом).
 *
 * Единственный источник состояния сессии: `sessionId` — привязка к сессии
 * (контур `/:id/attachments/uploads`), `name`/`mime` — метаданные файла для
 * публикации, `createdAt`/`updatedAt` — TTL (время последней активности).
 */
export interface UploadSessionSidecar {
  /** Версия формата (`UPLOAD_SESSION_SIDECAR_VERSION`). */
  version: number;
  /** Сессия-владелец (для контура `/:id/attachments/uploads`; staging — нет). */
  sessionId?: string;
  /** Имя файла из инициализации (санитайз — в сервисе при публикации). */
  name?: string;
  /** Заявленный MIME (проверка всё равно по сигнатуре). */
  mime?: string;
  /** Момент создания сессии (мс). */
  createdAt: number;
  /** Момент последней активности (мс) — основа TTL. */
  updatedAt?: number;
}

/** Область операции: сессия-владелец (для проверки привязки к сессии). */
export interface UploadSessionScope {
  /** Сессия-владелец; `undefined` — контур staging (без привязки). */
  sessionId?: string;
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
 * Реестр сессий chunked-загрузки — **stateless**: состояние на томе (temp +
 * sidecar), в памяти процесса ничего не хранится. Несколько экземпляров
 * стора над одним `BlobStore` (реплики control plane) работают как один.
 */
export class UploadSessionStore {
  private readonly _service: AttachmentService;
  private readonly _blobs: BlobStore;
  private readonly _configSource: AttachmentsConfig | (() => AttachmentsConfig);
  private readonly _now: () => number;
  private readonly _ttlMs: number;
  private readonly _log: (message: string) => void;
  /** Время последнего полного прохода уборки (ограничивает стоимость `list`). */
  private _lastPruneAt = Number.NEGATIVE_INFINITY;

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

  /** Путь временного объекта сессии загрузки (на томе). */
  private _tempPath(uploadId: string): string {
    return `${ATTACHMENT_UPLOAD_DIR}/${uploadId}`;
  }

  /** Путь sidecar'а сессии загрузки (на томе, рядом с временным объектом). */
  private _sidecarPath(uploadId: string): string {
    return `${ATTACHMENT_UPLOAD_DIR}/${uploadId}${UPLOAD_SESSION_SIDECAR_SUFFIX}`;
  }

  /** Прочитать sidecar сессии; `null` — сессии нет (или sidecar битый). */
  private async _readSidecar(uploadId: string): Promise<UploadSessionSidecar | null> {
    try {
      const raw = await this._blobs.read(this._sidecarPath(uploadId));
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw.toString('utf-8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const sidecar = parsed as UploadSessionSidecar;
      if (typeof sidecar.createdAt !== 'number') return null;
      return sidecar;
    } catch {
      return null;
    }
  }

  /** Записать sidecar сессии (атомарно — порт пишет tmp→rename). */
  private async _writeSidecar(uploadId: string, sidecar: UploadSessionSidecar): Promise<void> {
    await this._blobs.write(this._sidecarPath(uploadId), JSON.stringify(sidecar));
  }

  /** Обновить время активности сессии (ошибка записи не роняет запрос). */
  private async _touch(uploadId: string, sidecar: UploadSessionSidecar): Promise<void> {
    try {
      await this._writeSidecar(uploadId, { ...sidecar, updatedAt: this._now() });
    } catch (err) {
      // Смещение берётся из размера файла, поэтому сбой записи sidecar'а не
      // ломает протокол: сессия остаётся рабочей, лишь «стареет» раньше.
      this._log(
        `[attachments] sidecar сессии загрузки не обновлён (${uploadId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Удалить temp и sidecar сессии (идемпотентно, ошибки — в лог). */
  private async _deleteUpload(uploadId: string): Promise<void> {
    await this._blobs.delete(this._tempPath(uploadId)).catch((err: unknown) => {
      this._log(
        `[attachments] временный объект загрузки не удалён (${uploadId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    await this._blobs.delete(this._sidecarPath(uploadId)).catch((err: unknown) => {
      this._log(
        `[attachments] sidecar сессии загрузки не удалён (${uploadId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /**
   * Загрузить состояние сессии: sidecar + фактический размер temp-объекта.
   *
   * Отказ (`not_found`) — сессии нет, она чужая (привязка к другой сессии) или
   * протухла (TTL без активности). В последнем случае temp и sidecar удаляются.
   */
  private async _loadSession(
    uploadId: string,
    scope?: UploadSessionScope,
  ): Promise<{ tempPath: string; sidecar: UploadSessionSidecar; size: number }> {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) {
      throw new UploadSessionError('not_found', 'Сессия загрузки не найдена');
    }
    const sidecar = await this._readSidecar(uploadId);
    if (!sidecar) {
      throw new UploadSessionError('not_found', 'Сессия загрузки не найдена');
    }
    // Привязка к сессии: чужая загрузка выглядит как отсутствующая (fail-closed).
    if (sidecar.sessionId && sidecar.sessionId !== scope?.sessionId) {
      throw new UploadSessionError('not_found', 'Сессия загрузки не найдена');
    }
    // TTL без активности: протухшая сессия удаляется и больше не доступна.
    const touchedAt = sidecar.updatedAt ?? sidecar.createdAt;
    if (this._now() - touchedAt > this._ttlMs) {
      await this._deleteUpload(uploadId);
      throw new UploadSessionError('not_found', 'Сессия загрузки протухла');
    }
    const tempPath = this._tempPath(uploadId);
    const stat = await this._blobs.stat(tempPath);
    if (!stat) {
      // Temp убран (GC/уборка) — сессии больше нет; sidecar подчищаем.
      await this._blobs.delete(this._sidecarPath(uploadId)).catch(() => undefined);
      throw new UploadSessionError('not_found', 'Сессия загрузки не найдена');
    }
    return { tempPath, sidecar, size: stat.size };
  }

  /**
   * Активные сессии загрузки: sidecar есть, время активности не вышло, temp
   * существует. Протухшие сессии не возвращаются (их удалит `pruneExpired`),
   * поэтому мусор не занимает квоту и не блокирует лимиты числа.
   *
   * Стоимость — один обход `attachments/.uploads` и чтение sidecar'ов; это
   * происходит на `create` (лимиты числа/квоты) и на `append`/`complete`
   * только для загрузок, привязанных к сессии.
   */
  private async _listActiveUploads(): Promise<
    Array<{ uploadId: string; sidecar: UploadSessionSidecar; size: number }>
  > {
    const now = this._now();
    const entries = await this._blobs.list(ATTACHMENT_UPLOAD_DIR);
    const prefix = `${ATTACHMENT_UPLOAD_DIR}/`;
    const active: Array<{ uploadId: string; sidecar: UploadSessionSidecar; size: number }> = [];

    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const uploadId = entry.path.slice(prefix.length);
      if (uploadId.endsWith(UPLOAD_SESSION_SIDECAR_SUFFIX)) continue;
      if (!UPLOAD_ID_PATTERN.test(uploadId)) continue;

      const sidecar = await this._readSidecar(uploadId);
      if (!sidecar) continue;
      const touchedAt = sidecar.updatedAt ?? sidecar.createdAt;
      if (now - touchedAt > this._ttlMs) continue;

      const stat = await this._blobs.stat(entry.path);
      if (!stat) continue;
      active.push({ uploadId, sidecar, size: stat.size });
    }

    return active;
  }

  /**
   * Квота сессии для незавершённых chunked-загрузок: сумма активных загрузок
   * этой сессии (temp-объекты) + текущий файл не должна превышать
   * `maxBytesPerSession`. Другие сессии не влияют.
   */
  private async _assertSessionQuota(
    config: AttachmentsConfig,
    sessionId: string,
    uploadId: string,
    fileSize: number,
  ): Promise<void> {
    const active = await this._listActiveUploads();
    let used = 0;
    for (const entry of active) {
      if (entry.uploadId === uploadId) continue;
      if (entry.sidecar.sessionId !== sessionId) continue;
      used += entry.size;
    }
    if (used + fileSize <= config.maxBytesPerSession) return;
    throw new UploadSessionError(
      'too_large',
      `Суммарный объём активных загрузок сессии ${used + fileSize} Б превышает предел ${config.maxBytesPerSession} Б`,
      { maxBytesPerSession: config.maxBytesPerSession },
    );
  }

  /**
   * Начать загрузку: создать пустой временный объект и sidecar на томе,
   * вернуть лимит части.
   */
  async create(input: CreateUploadSessionInput = {}): Promise<CreatedUploadSession> {
    const config = this._config;
    this._requireEnabled(config);
    // Публичный шов: HTTP-парсер (`parseUploadInitBody`) режет `size` сам, но
    // стор зовут и staging/тесты, поэтому некорректный размер обязан
    // отбрасываться здесь — иначе отрицательный/дробный/`NaN` обошёл бы квоту.
    if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 0)) {
      throw new UploadSessionError(
        'invalid',
        `Размер вложения «${String(input.size)}» должен быть целым неотрицательным числом`,
      );
    }
    if (input.size !== undefined && input.size > config.maxBytesPerFile) {
      throw new UploadSessionError(
        'too_large',
        `Размер вложения ${input.size} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }

    // Уборка протухших сессий — до подсчёта лимитов: мусор не должен
    // блокировать новые загрузки. `_listActiveUploads` дополнительно
    // игнорирует протухшие, если ленивая уборка пропущена по троттлингу.
    await this._pruneSafely();
    const active = await this._listActiveUploads();

    if (active.length >= config.maxActiveUploads) {
      throw new UploadSessionError(
        'too_large',
        `Число активных загрузок ${active.length} достигло предела ${config.maxActiveUploads}`,
        { maxActiveUploads: config.maxActiveUploads },
      );
    }

    if (input.sessionId) {
      const sessionUploads = active.filter(
        (entry) => entry.sidecar.sessionId === input.sessionId,
      );
      if (sessionUploads.length >= config.maxActiveUploadsPerSession) {
        throw new UploadSessionError(
          'too_large',
          `Число активных загрузок сессии ${sessionUploads.length} достигло предела ${config.maxActiveUploadsPerSession}`,
          { maxActiveUploadsPerSession: config.maxActiveUploadsPerSession },
        );
      }
      // Заявленный размер учитывается сразу: иначе клиент мог бы открыть
      // несколько «больших» загрузок и только на `append` упереться в квоту.
      if (typeof input.size === 'number' && Number.isFinite(input.size)) {
        const used = sessionUploads.reduce((total, entry) => total + entry.size, 0);
        if (used + input.size > config.maxBytesPerSession) {
          throw new UploadSessionError(
            'too_large',
            `Суммарный объём активных загрузок сессии ${used + input.size} Б превышает предел ${config.maxBytesPerSession} Б`,
            { maxBytesPerSession: config.maxBytesPerSession },
          );
        }
      }
    }

    const uploadId = randomUUID();
    const now = this._now();
    const sidecar: UploadSessionSidecar = {
      version: UPLOAD_SESSION_SIDECAR_VERSION,
      createdAt: now,
      updatedAt: now,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.declaredMime ? { mime: input.declaredMime } : {}),
    };

    // Временный объект и sidecar — рядом, на общем томе: состояние сессии не
    // зависит от того, какая реплика обслуживает запрос.
    await this._blobs.write(this._tempPath(uploadId), Buffer.alloc(0));
    try {
      await this._writeSidecar(uploadId, sidecar);
    } catch (err) {
      await this._blobs.delete(this._tempPath(uploadId)).catch(() => undefined);
      throw err;
    }

    return { uploadId, maxChunkBytes: config.maxChunkBytes };
  }

  /**
   * Принять часть по смещению `offset` (обязан равняться уже принятому объёму —
   * иначе клиент потерял часть и дописывание склеило бы файл с дырой).
   *
   * Принятый объём — **фактический размер временного объекта** на томе.
   */
  async append(
    uploadId: string,
    offset: number,
    bytes: Buffer,
    scope?: UploadSessionScope,
  ): Promise<AppendedUploadChunk> {
    const config = this._config;
    this._requireEnabled(config);

    const { tempPath, sidecar, size } = await this._loadSession(uploadId, scope);

    if (!Number.isInteger(offset) || offset !== size) {
      throw new UploadSessionError(
        'offset_mismatch',
        `Смещение части ${offset} не совпадает с принятым объёмом ${size}`,
      );
    }
    if (bytes.length > config.maxChunkBytes) {
      throw new UploadSessionError(
        'too_large_chunk',
        `Размер части ${bytes.length} Б превышает предел ${config.maxChunkBytes} Б`,
      );
    }
    if (size + bytes.length > config.maxBytesPerFile) {
      throw new UploadSessionError(
        'too_large',
        `Размер вложения ${size + bytes.length} Б превышает предел ${config.maxBytesPerFile} Б`,
      );
    }
    // Квота сессии по фактическому росту: активные загрузки этой сессии +
    // итоговый размер текущего файла. Staging (`sessionId` нет) квоте не подлежит.
    if (sidecar.sessionId) {
      await this._assertSessionQuota(config, sidecar.sessionId, uploadId, size + bytes.length);
    }

    if (bytes.length > 0) await this._blobs.append(tempPath, bytes);

    // Фактический размер после записи — единственный верный «следующий offset»
    // (при гонке параллельных append это уже сумма обеих частей).
    const after = await this._blobs.stat(tempPath);
    const received = after?.size ?? size + bytes.length;

    // Активность сессии обновляется (важно и для TTL, и для фонового GC по mtime).
    await this._touch(uploadId, sidecar);

    return { received, nextOffset: received };
  }

  /**
   * Завершить загрузку: опубликовать временный объект как вложение.
   *
   * Sidecar снимается **до** публикации (заявка на завершение): повторное
   * завершение — `not_found`. Временный объект удаляется в `finally` (при
   * ошибке публикации тоже — `ingestPath` убирает его сам).
   */
  async complete(
    uploadId: string,
    scope?: UploadSessionScope,
  ): Promise<UploadedAttachmentMeta> {
    const config = this._config;
    this._requireEnabled(config);

    const { tempPath, sidecar, size } = await this._loadSession(uploadId, scope);

    // Квота сессии проверяется и на завершении: файл уже собран, но лимит
    // мог быть снижен runtime-настройкой после `append`.
    if (sidecar.sessionId) {
      await this._assertSessionQuota(config, sidecar.sessionId, uploadId, size);
    }

    // Забираем сессию: повторное завершение — `not_found`.
    await this._blobs.delete(this._sidecarPath(uploadId)).catch((err: unknown) => {
      this._log(
        `[attachments] sidecar сессии загрузки не удалён (${uploadId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    try {
      return await this._service.ingestPath(tempPath, {
        ...(sidecar.name ? { name: sidecar.name } : {}),
        ...(sidecar.mime ? { declaredMime: sidecar.mime } : {}),
      });
    } finally {
      // `ingestPath` переносит или удаляет объект сам; повторное удаление
      // идемпотентно и страхует путь ошибки.
      await this._blobs.delete(tempPath).catch((err: unknown) => {
        this._log(
          `[attachments] временный объект загрузки не удалён (${uploadId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  /**
   * Отменить загрузку: удалить временный объект и sidecar (идемпотентно).
   *
   * Чужая (привязанная к другой сессии) загрузка не трогается: отказ молчаливый
   * (контракт отмены — 204 идемпотентно).
   */
  async cancel(uploadId: string, scope?: UploadSessionScope): Promise<void> {
    if (!UPLOAD_ID_PATTERN.test(uploadId)) return;
    const sidecar = await this._readSidecar(uploadId);
    if (sidecar?.sessionId && sidecar.sessionId !== scope?.sessionId) return;
    await this._deleteUpload(uploadId);
  }

  /**
   * Удалить протухшие сессии (TTL без активности) и их временные объекты.
   * Возвращает число удалённых записей (тесты/диагностика).
   */
  async pruneExpired(): Promise<number> {
    const now = this._now();
    const entries = await this._blobs.list(ATTACHMENT_UPLOAD_DIR);
    const prefix = `${ATTACHMENT_UPLOAD_DIR}/`;
    let removed = 0;

    const temps = new Set<string>();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const name = entry.path.slice(prefix.length);
      if (name.endsWith(UPLOAD_SESSION_SIDECAR_SUFFIX)) continue;
      temps.add(name);
      const sidecar = await this._readSidecar(name);
      const touchedAt =
        sidecar?.updatedAt
        ?? sidecar?.createdAt
        ?? (await this._blobs.stat(entry.path))?.mtimeMs
        ?? now;
      if (now - touchedAt <= this._ttlMs) continue;
      await this._deleteUpload(name);
      removed += 1;
    }

    // Осиротевшие sidecar'ы (temp уже убран GC/публикацией) — тоже в уборку.
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const name = entry.path.slice(prefix.length);
      if (!name.endsWith(UPLOAD_SESSION_SIDECAR_SUFFIX)) continue;
      const uploadId = name.slice(0, -UPLOAD_SESSION_SIDECAR_SUFFIX.length);
      if (temps.has(uploadId)) continue;
      if (await this._blobs.stat(this._tempPath(uploadId))) continue;
      await this._blobs.delete(entry.path).catch((err: unknown) => {
        this._log(
          `[attachments] sidecar сессии загрузки не удалён (${uploadId}): ${
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
    const now = this._now();
    if (now - this._lastPruneAt < PRUNE_MIN_INTERVAL_MS) return;
    this._lastPruneAt = now;
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
