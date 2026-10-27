/**
 * ADR-101 §9 + ADR-116 §3: хранилище артефактов прогонов пайплайнов.
 *
 * Отдельного хранилища артефактов **нет** (решение 2026-10-27, ADR-101
 * §«Открытые вопросы»): байты лежат в общем blob-порте (ADR-096/ADR-116),
 * учёт ссылок — в порту `BlobRefRepository` с владельцем
 * `ownerKind: 'pipeline-run'`. Поэтому артефакт переживает удаление
 * пайплайна (прогон самодостаточен), а GC blob'ов видит его как живой —
 * пока существует ссылка.
 *
 * ## Раскладка
 *
 * `artifacts/<runId>/<name>` — по каталогу на прогон: удаление прогона
 * (`removeRun`) снимает весь каталог и ссылки владельца одним движением, а
 * список артефактов прогона — это просто `list(prefix)`.
 *
 * ## Имя файла
 *
 * Имя приходит из выхода `file` (путь в workspace проекта), поэтому оно
 * санитайзится: только basename (без `/` и `\`), без `..`, без управляющих
 * символов, длина ≤ 200. Коллизии в пределах прогона разводятся суффиксом
 * `-2`, `-3`, … (`report.md` → `report-2.md`) — одинаковые имена не затирают
 * друг друга.
 *
 * ## Лимит
 *
 * `maxBytes` (дефолт 50 МиБ) проверяется **до** записи: превышение —
 * `PipelineArtifactError('too_large')`. Выход `file` не считает это ошибкой
 * прогона — он пишет предупреждение и оставляет артефакт только в workspace.
 */

import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import type { PipelineArtifact } from '@itphx/synth-shared';

import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';

/** Каталог артефактов прогонов в blob-хранилище. */
export const PIPELINE_ARTIFACT_DIR = 'artifacts';

/** Дефолтный предел размера артефакта (50 МиБ). */
export const DEFAULT_PIPELINE_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

/** Предел длины имени файла артефакта. */
const MAX_ARTIFACT_NAME_LENGTH = 200;

/** Потолок попыток развести коллизию имён. */
const MAX_COLLISION_ATTEMPTS = 100;

/** Код отказа записи артефакта. */
export type PipelineArtifactErrorCode = 'too_large' | 'invalid_input';

/** Отказ записи артефакта (лимит размера / некорректный id прогона). */
export class PipelineArtifactError extends Error {
  constructor(
    readonly code: PipelineArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineArtifactError';
  }
}

/** Вход записи артефакта. */
export interface PipelineArtifactInput {
  /** Имя файла (берётся из пути выхода; санитайзится). */
  name: string;
  /** Содержимое артефакта. */
  bytes: Buffer;
  /** MIME-тип (необязателен — отдаётся в `Content-Type`). */
  mime?: string;
}

/** Элемент списка артефактов прогона. */
export interface PipelineArtifactEntry {
  /** Путь объекта в blob-хранилище. */
  path: string;
  /** Размер, байт. */
  size: number;
  /** Имя файла (последний сегмент пути). */
  name: string;
}

export interface PipelineArtifactStoreDeps {
  /** Порт blob-хранилища (ADR-096/ADR-116). */
  blobs: BlobStore;
  /** Порт учёта ссылок на объекты blob-хранилища. */
  blobRefs: BlobRefRepository;
  /** Предел размера одного артефакта (дефолт 50 МиБ). */
  maxBytes?: number;
}

/**
 * Хранилище артефактов прогонов пайплайнов поверх blob-порта.
 *
 * Сервис не знает про HTTP и про workspace: он умеет только положить байты
 * по пути `artifacts/<runId>/<name>`, прочитать их и убрать каталог прогона.
 */
export class PipelineArtifactStore {
  private readonly _blobs: BlobStore;
  private readonly _refs: BlobRefRepository;
  private readonly _maxBytes: number;

  constructor(deps: PipelineArtifactStoreDeps) {
    this._blobs = deps.blobs;
    this._refs = deps.blobRefs;
    this._maxBytes = deps.maxBytes && deps.maxBytes > 0
      ? deps.maxBytes
      : DEFAULT_PIPELINE_ARTIFACT_MAX_BYTES;
  }

  /** Предел размера одного артефакта, байт. */
  get maxBytes(): number {
    return this._maxBytes;
  }

  /**
   * Записать артефакт прогона.
   *
   * Имя санитайзится, коллизия в пределах прогона разводится суффиксом
   * (`-2`, `-3`, …). После записи добавляется ссылка владельца
   * (`ownerKind: 'pipeline-run'`) — без неё GC счёл бы объект осиротевшим.
   */
  async put(runId: string, input: PipelineArtifactInput): Promise<PipelineArtifact> {
    const run = sanitizeRunId(runId);
    const bytes = input.bytes;
    if (!Buffer.isBuffer(bytes)) {
      throw new PipelineArtifactError('invalid_input', 'Содержимое артефакта должно быть Buffer');
    }
    if (bytes.length > this._maxBytes) {
      throw new PipelineArtifactError(
        'too_large',
        `Размер артефакта ${bytes.length} Б превышает предел ${this._maxBytes} Б`,
      );
    }

    const name = await this._uniqueName(run, sanitizeArtifactName(input.name));
    const blobPath = `${PIPELINE_ARTIFACT_DIR}/${run}/${name}`;
    await this._blobs.write(blobPath, bytes);
    await this._refs.add({ blobPath, ownerKind: 'pipeline-run', ownerId: run });

    const artifact: PipelineArtifact = {
      kind: 'blob',
      id: blobPath,
      path: blobPath,
      name,
      size: bytes.length,
      ...(input.mime ? { mime: input.mime } : {}),
    };
    return artifact;
  }

  /**
   * Прочитать байты артефакта. `null` — объекта нет или путь не из каталога
   * артефактов (раздавать произвольные blob'ы через этот контур нельзя).
   */
  async read(artifact: { path: string }): Promise<Buffer | null> {
    const path = artifact?.path;
    if (!isPipelineArtifactPath(path)) return null;
    return this._blobs.read(path);
  }

  /**
   * Потоковое чтение артефакта (раздача без чтения в память). `null` — нет
   * объекта или путь вне каталога артефактов.
   */
  async readStream(artifact: { path: string }): Promise<Readable | null> {
    const path = artifact?.path;
    if (!isPipelineArtifactPath(path)) return null;
    return this._blobs.readStream(path);
  }

  /** Артефакты прогона (пути и размеры) — детерминированный порядок порта. */
  async listRun(runId: string): Promise<Array<{ path: string; size: number }>> {
    const run = sanitizeRunId(runId);
    return this._blobs.list(`${PIPELINE_ARTIFACT_DIR}/${run}/`);
  }

  /**
   * Найти артефакт прогона по имени файла (для HTTP-раздачи).
   *
   * Имя сравнивается с последним сегментом пути после санитайза — клиент
   * передаёт то имя, которое увидел в журнале прогона (с учётом `-2`).
   */
  async find(runId: string, name: string): Promise<PipelineArtifactEntry | null> {
    const run = sanitizeRunId(runId);
    const wanted = sanitizeArtifactName(name);
    const entries = await this._blobs.list(`${PIPELINE_ARTIFACT_DIR}/${run}/`);
    const hit = entries.find((entry) => artifactNameOf(entry.path) === wanted);
    if (!hit) return null;
    return { path: hit.path, size: hit.size, name: artifactNameOf(hit.path) };
  }

  /**
   * Убрать все артефакты прогона (удаление прогона).
   *
   * Сначала объекты, затем ссылки владельца: осиротевшая ссылка безопаснее
   * удалённого объекта (GC удалит объект, только когда ссылок нет).
   */
  async removeRun(runId: string): Promise<void> {
    const run = sanitizeRunId(runId);
    const entries = await this._blobs.list(`${PIPELINE_ARTIFACT_DIR}/${run}/`);
    for (const entry of entries) {
      await this._blobs.delete(entry.path);
    }
    await this._refs.removeByOwner('pipeline-run', run);
  }

  /** Свободное имя файла в каталоге прогона (коллизии — `-2`, `-3`, …). */
  private async _uniqueName(run: string, name: string): Promise<string> {
    const base = `${PIPELINE_ARTIFACT_DIR}/${run}`;
    let candidate = name;
    for (let attempt = 2; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
      if (!(await this._blobs.exists(`${base}/${candidate}`))) return candidate;
      candidate = withSuffix(name, attempt);
    }
    // Все имена заняты — не затираем существующие: добавляем уникальный хвост.
    return withSuffix(name, Date.now());
  }
}

/** Является ли путь объектом артефактов прогона (`artifacts/…`). */
export function isPipelineArtifactPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (!path.startsWith(`${PIPELINE_ARTIFACT_DIR}/`)) return false;
  if (path.includes('..') || path.includes('\\') || path.includes('\0')) return false;
  return true;
}

/**
 * Санитайз имени файла артефакта: только basename, без `..` и управляющих
 * символов, длина ≤ 200. Пустое имя получает `artifact`.
 */
export function sanitizeArtifactName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  // Обратные слэши — разделители Windows: путь тоже схлопывается до basename.
  const lastSegment = basename(raw.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.\./g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '_') return 'artifact';
  return cleaned.slice(0, MAX_ARTIFACT_NAME_LENGTH);
}

/** id прогона в безопасном для пути виде (`prun_<uuid>` и т.п.). */
export function sanitizeRunId(runId: unknown): string {
  const cleaned = String(runId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\./g, '_')
    .slice(0, 120);
  if (!cleaned || /^[._]+$/.test(cleaned)) {
    throw new PipelineArtifactError('invalid_input', 'Некорректный идентификатор прогона');
  }
  return cleaned;
}

/** Имя файла артефакта по пути объекта. */
function artifactNameOf(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? '';
}

/** Имя с суффиксом коллизии: `report.md` + 2 → `report-2.md`. */
function withSuffix(name: string, index: number): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)}-${index}${name.slice(dot)}`;
  return `${name}-${index}`;
}
