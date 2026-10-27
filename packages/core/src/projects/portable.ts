// ADR-091 (этап 2): портативный экспорт/импорт проекта между инстансами Synth.
//
// Экспорт — самодостаточный архив `<name>.synth-project.tar.gz`: `manifest.json`
// (tool/formatVersion, проект, число сессий, записи с sha256), `project.json`
// (`serializeProject`) и `sessions/<id>.json` (переносимый payload
// `buildSessionExport`) по каждой **локальной** сессии проекта; опционально
// `workspace/**` (`--with-workspace`). Секретов в архиве нет: `secrets/`, ключи,
// credentials, токены, API-ключи не попадают (это проверяется тестом).
//
// СЕКРЕТЫ СЕССИЙ (security-фикс 0.11.3): по умолчанию из переносимых payload
// сессий вырезаются карта обфускации LLM Gateway (`obfuscationMap` —
// плейсхолдер → РЕАЛЬНЫЙ секрет) и реальные значения плейсхолдеров в
// `messages[].metadata.secrets`. Причина: архив проекта содержит сессии
// **других участников** проекта, а карта обфускации — это и есть секрет.
// Явная опция `withSecrets` (CLI `--with-secrets`, HTTP `?withSecrets=true`)
// возвращает их — только для elevated (ADMIN/LEAD; standalone — локальный
// владелец); факт включается в аудит `export.created` (`details.withSecrets`).
// Импорт карту принимает и без флага (`projects/portable.ts`, поле
// `data.obfuscationMap`) — архив, полученный через привилегированный opt-in,
// импортируется корректно.
//
// Импорт — materialization, НЕ `session.requested` (ADR-089, инвариант 15):
// создаётся **новый** `projectId`, сессии получают **новые** id через
// `SessionManager.createSession` (примитив материализации, не request). Экспорт/
// импорт — перенос проекта между инстансами, а не снятие снимка каталога данных
// (ADR-091): новый инстанс не содержит прежних данных.
//
// Хранилище — через доменные порты слоя хранения (`StorageContext`, ADR-096);
// физический backend — файловый (дефолт). Архив/манифест — своим потоковым
// ustar-писателем (`maintenance/archive.ts`), без внешних зависимостей.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  SYNTH_VERSION,
  generateId,
  nowISO,
  normalizeColorKey,
  normalizeIconKey,
  slugifyWorkspaceName,
} from '@itphx/synth-shared';
import type {
  MediaPartData,
  Message,
  Part,
  Project,
  Session,
  SessionMode,
  SessionOrigin,
  SessionReference,
  SessionSettings,
} from '@itphx/synth-shared';
import { SessionManager } from '../sessions/manager.js';
import { createFileStorage, type StorageContext } from '../storage/storage-context.js';
import { provisionManagedWorkspace } from '../engine/workspace-provision.js';
import { isAttachmentPath } from '../engine/attachments/service.js';
import { stripSessionSecrets } from '../engine/gateway/obfuscation-map-store.js';
import { isInsideReal, resolveRealPath } from '../engine/tools/path-utils.js';
import { serializeProject } from '../server/serialize.js';
import { LOCAL_USER_ID } from '../server/local-owner.js';
import { buildSessionExport, resolveLocalWorkspace, walkDir } from '../remote/transfer.js';
import {
  ArchiveLimitError,
  ArchivePathError,
  readFileFromTarGz,
  readTarGz,
  writeTarGz,
  type ArchiveSource,
} from '../maintenance/archive.js';
import { recordMaintenanceAudit } from '../maintenance/audit.js';
import type { MaintenanceAuditRepository } from '../storage/ports/maintenance-audit-repository.js';

/** Префикс staging-каталога экспорта в `{dataDir}/tmp`. */
const EXPORT_STAGING_PREFIX = 'project-export-';

/**
 * Версия формата портативного архива проекта.
 *
 * - `1` — `manifest.json` + `project.json` + `sessions/**` (+ `workspace/**`);
 * - `2` — добавлены байты вложений сообщений (`attachments/<sha2>/<sha256>`,
 *   ADR-115): путь объекта content-addressed, поэтому при импорте `blobPath`
 *   частей сообщений не меняются, а существующий объект не дублируется.
 *
 * Чтение **обратно совместимо**: архив версии 1 импортируется как раньше —
 * медиа-части без байтов в архиве дают предупреждение, а не ошибку.
 */
export const PROJECT_EXPORT_FORMAT_VERSION = 2;

/** Минимальная поддерживаемая версия формата архива (обратная совместимость). */
export const PROJECT_EXPORT_MIN_FORMAT_VERSION = 1;

/** Медиа-типы частей сообщения (вложение, есть `data.blobPath`). */
const MEDIA_PART_TYPES = new Set<string>(['image', 'audio', 'video', 'file']);


/** Код ошибки портативного экспорта/импорта проекта (ADR-091). */
export type ProjectPortableErrorCode =
  | 'invalid-archive'
  | 'checksum-mismatch'
  | 'project-not-found'
  | 'project-name-conflict'
  | 'confirmation-required'
  | 'workspace-error';

/** Ошибка портативного экспорта/импорта проекта (сообщения по-русски). */
export class ProjectPortableError extends Error {
  readonly code: ProjectPortableErrorCode;

  constructor(code: ProjectPortableErrorCode, message: string) {
    super(message);
    this.name = 'ProjectPortableError';
    this.code = code;
  }
}

/** Запись манифеста архива проекта (файл + размер + sha256 содержимого). */
export interface ProjectExportEntry {
  /** Путь относительно корня архива (POSIX-разделители). */
  path: string;
  size: number;
  sha256: string;
}

/** Манифест архива портативного экспорта проекта (ADR-091). */
export interface ProjectExportManifest {
  tool: 'synth-project-export';
  /** Версия формата (`PROJECT_EXPORT_FORMAT_VERSION`; 1 — архив без вложений). */
  formatVersion: number;
  exportedAt: string;
  /** `SYNTH_VERSION` на момент экспорта. */
  instanceVersion: string;
  /** Проект-источник (id + имя). */
  project: { id: string; name: string };
  /** Число экспортированных локальных сессий. */
  sessions: number;
  withWorkspace: boolean;
  /** ADR-115: байты вложений сообщений в архиве (поле отсутствует в версии 1). */
  withAttachments?: boolean;
  /** ADR-115: число объектов вложений в архиве (версия 2+). */
  attachments?: number;
  /** Записи архива (без `manifest.json`). */
  entries: ProjectExportEntry[];
}

/** Опции `exportProject` (ADR-091). */
export interface ExportProjectOptions {
  dataDir: string;
  projectId: string;
  /** Путь к архиву; каталог — положить файл внутрь. По умолчанию — текущий каталог. */
  out?: string;
  /** Включить `workspace/**` (рабочий каталог проекта). */
  withWorkspace?: boolean;
  /**
   * Включить секреты сессий в архив: карту обфускации LLM Gateway
   * (`obfuscationMap`) и реальные значения плейсхолдеров в
   * `messages[].metadata.secrets`. По умолчанию — **выключено** (security-фикс
   * 0.11.3): архив проекта переносит сессии других участников, а карта
   * обфускации — это секрет. Привилегированная опция (CLI `--with-secrets`,
   * HTTP `?withSecrets=true`) — только для elevated (ADMIN/LEAD; standalone —
   * локальный владелец); факт фиксируется в аудите `export.created`.
   */
  withSecrets?: boolean;
  /**
   * ADR-115: переносить **байты** вложений сообщений (по умолчанию `true`).
   *
   * Вложения лежат в blob-хранилище тома и по своей природе крупнее истории
   * сессий, поэтому архив может заметно вырасти. Отключение — осознанный выбор
   * вызывающего (внутренняя опция функции; CLI-флага нет): части сообщений
   * переносятся, а байты на целевом инстансе окажутся «висячими» — импорт
   * сообщит о них предупреждением. Молчаливого урезания по порогу размера нет.
   */
  withAttachments?: boolean;
  /** Корень локальных workspace (по умолчанию `{dataDir}/workspaces`). */
  workspacesRoot?: string;
  /** ADR-092: аудит-журнал обслуживания (best-effort; ошибка записи не ломает операцию). */
  audit?: MaintenanceAuditRepository;
  /**
   * ADR-096: готовый контекст хранения (иначе — `file`-контекст по `dataDir`).
   * Позволяет экспорту работать на выбранном backend (напр. `postgres`).
   */
  storage?: StorageContext;
  /** ADR-092: инициатор операции (`'cli'` | `userId`). */
  actor?: string;
  /** Канал вывода (по умолчанию — тихий). */
  log?: (msg: string) => void;
}

/** Результат `exportProject` (ADR-091). */
export interface ExportProjectResult {
  path: string;
  bytes: number;
  sessions: number;
  entries: number;
  withWorkspace: boolean;
  /** ADR-115: число объектов вложений, положенных в архив. */
  attachments: number;
}

/** Опции `importProject` (ADR-091). */
export interface ImportProjectOptions {
  dataDir: string;
  archive: string;
  /** Имя нового проекта (по умолчанию — из архива + суффикс при коллизии имён). */
  name?: string;
  /** ID существующего проекта — импортировать сессии в него. */
  mergeInto?: string;
  /** Распаковать `workspace/**` в каталог проекта. */
  withWorkspace?: boolean;
  /** Предпросмотр: валидация архива и план без записи. */
  dryRun?: boolean;
  /** Подтверждение создания проекта/сессий (обязательно без `--dry-run`). */
  yes?: boolean;
  /** Корень локальных workspace (по умолчанию `{dataDir}/workspaces`). */
  workspacesRoot?: string;
  /**
   * Лимиты распакованного объёма импорта (ADR-091): число записей, размер одной
   * записи, суммарный объём. Не заданы — `DEFAULT_PROJECT_IMPORT_LIMITS`.
   * Проверяются в момент чтения архива (fail-closed).
   */
  limits?: Partial<ProjectImportLimits>;
  /** Владелец новых проекта/сессий (standalone — `local`). */
  ownerId?: string;
  /** ADR-092: аудит-журнал обслуживания (best-effort). */
  audit?: MaintenanceAuditRepository;
  /**
   * ADR-096: готовый контекст хранения (иначе — `file`-контекст по `dataDir`).
   * Позволяет импорту работать на выбранном backend (напр. `postgres`).
   */
  storage?: StorageContext;
  /** ADR-092: инициатор операции (`'cli'` | `userId`). */
  actor?: string;
  /** Канал вывода (по умолчанию — тихий). */
  log?: (msg: string) => void;
  /**
   * ADR-089 (инвариант 18): колбэк на каждую материализованную сессию —
   * публикация `session.created`, чтобы хабы подписали владельца. В CLI — нет
   * (no-op); managed/standalone — подключают шину событий.
   */
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

/** Результат `importProject` (ADR-091). */
export interface ImportProjectResult {
  projectId: string;
  sessionsImported: number;
  messagesImported: number;
  workspaceRestored: boolean;
  /** Маппинг старый id → новый id (по импортированным сессиям). */
  idMap: Record<string, string>;
  /** ADR-115: объектов вложений записано в blob-хранилище (с `blob_refs`). */
  attachmentsImported: number;
  /**
   * ADR-115: вложений, которые не удалось восстановить (нет байтов в архиве —
   * dangling, либо не совпала контрольная сумма). Не ошибка импорта: части
   * сообщений сохраняются, байты просто отсутствуют.
   */
  attachmentsSkipped: number;
  /** Предупреждения импорта (пропущенные вложения и причины) — не ошибки. */
  warnings: string[];
}

/**
 * Лимиты распакованного объёма при импорте портативного архива (ADR-091) —
 * защита от archive-бомб (архив-«бомба» распаковывается в гигабайты и
 * исчерпывает память/диск инстанса).
 *
 * Обоснование значений:
 *
 * - `maxEntries = 100_000` — реальный проект (workspace с `node_modules`) укладывается
 *   в десятки тысяч файлов; 100k — с запасом, но ограничивает накладные расходы
 *   (манифест + карта собранных записей) и время разбора;
 * - `maxEntryBytes = 128 МиБ` — потолок для ОДНОГО файла (веса модели, видео);
 *   содержимое записи читается в память целиком, поэтому лимит заметно ниже
 *   суммарного (пик ≈ 2 × этот лимит из-за промежуточного буфера чтения);
 * - `maxTotalBytes = 2 ГиБ` — суммарный распакованный объём архива: столько
 *   реально занимает большой проект с workspace и историей сессий. Это же верхняя
 *   граница расхода RAM/диска одного импорта (содержимое собирается в память перед
 *   записью в workspace). Проект больше — переносится частями или лимит поднимается
 *   явно через `ImportProjectOptions.limits`.
 *
 * Проверки выполняются **в момент чтения** архива (`readTarGz`): лимит одной записи
 * сверяется по заголовку ДО буферизации содержимого, суммарный — по сумме размеров
 * заголовков. Поэтому превышение обрывает разбор, а не констатирует факт после
 * распаковки.
 */
export interface ProjectImportLimits {
  /** Максимум записей в архиве (файлы + каталоги). */
  maxEntries: number;
  /** Максимум размера одной записи (байты). */
  maxEntryBytes: number;
  /** Максимум суммарного распакованного объёма (байты). */
  maxTotalBytes: number;
}

/** Лимиты импорта по умолчанию (см. `ProjectImportLimits`). */
export const DEFAULT_PROJECT_IMPORT_LIMITS: ProjectImportLimits = {
  maxEntries: 100_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

/** sha256 файла потоково (без чтения целиком в память). */
function _hashFile(absPath: string): Promise<string> {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const rs = createReadStream(absPath);
    rs.on('error', reject);
    rs.on('end', () => resolveHash(hash.digest('hex')));
    rs.on('data', (chunk) => hash.update(chunk));
  });
}

/** Текст ошибки (для сообщений `ProjectPortableError`). */
function _errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Резолвит итоговый путь архива (каталог/путь с завершающим `/` → имя по умолчанию внутри). */
async function _resolveOutPath(out: string | undefined, defaultName: string): Promise<string> {
  if (!out) return resolve(defaultName);
  const dirHint = /[\\/]$/.test(out);
  const abs = resolve(out);
  let isDir = false;
  try {
    isDir = (await stat(abs)).isDirectory();
  } catch {
    // Путь ещё не существует: завершающий разделитель трактуем как каталог.
    isDir = dirHint;
  }
  return isDir ? join(abs, defaultName) : abs;
}
/** Сессия принадлежит другому инстансу (агрегация миров, ADR-042). */
function _isRemoteSession(session: Session): boolean {
  const origin = (session as { origin?: string }).origin;
  return origin === 'remote' || session.id.startsWith('remote:');
}

/** Массив из неизвестного значения (иначе — пустой). */
function _asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Число из неизвестного значения. */
function _num(value: unknown, def = 0): number {
  return typeof value === 'number' ? value : def;
}

/** Парсит JSON-объект из буфера; иначе `invalid-archive`. */
function _parseJsonObject(buffer: Buffer, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch {
    throw new ProjectPortableError('invalid-archive', `Файл ${path} невалиден (не JSON).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProjectPortableError('invalid-archive', `Файл ${path} невалиден (не JSON-объект).`);
  }
  return parsed as Record<string, unknown>;
}

/** Переписать `session_reference`-часть сообщения по mapping (не перенесено → null). */
function _rewriteReferencePart(part: Part, mapping: Map<string, string>): Part {
  if (!part || part.type !== 'session_reference' || !part.data || typeof part.data !== 'object') {
    return part;
  }
  const data = { ...(part.data as Record<string, unknown>) };
  const sid = data.sessionId ?? data.session_id;
  if (typeof sid === 'string') {
    data.sessionId = mapping.get(sid) ?? null;
    delete data.session_id;
  }
  return { ...part, data };
}

/** Уникальное имя нового проекта (при коллизии имён и авто-имени — суффикс). */
function _uniqueProjectName(base: string, names: Set<string>): string {
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} (${i})`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/**
 * Вырезает секреты из переносимого payload сессии (security-фикс 0.11.3):
 * карту обфускации LLM Gateway (`obfuscationMap` — плейсхолдер → РЕАЛЬНЫЙ
 * секрет) и реальные значения плейсхолдеров в `messages[].metadata.secrets`.
 *
 * Общий хелпер `stripSessionSecrets` (ADR-036, `engine/gateway`) — тот же, что
 * использует HTTP-роут экспорта сессии: одна реализация «без секретов».
 */
function _stripSessionSecrets(payload: Record<string, unknown>): Record<string, unknown> {
  return stripSessionSecrets(payload);
}

/**
 * Экспортирует проект в портативный архив (ADR-091) и best-effort фиксирует
 * событие `export.created` в аудит-журнале обслуживания (ADR-092). Ошибка
 * аудит-порта не ломает экспорт.
 *
 * @throws ProjectPortableError `project-not-found` — проект не найден.
 */
export async function exportProject(opts: ExportProjectOptions): Promise<ExportProjectResult> {
  const result = await _exportProject(opts);
  await recordMaintenanceAudit(opts.audit, {
    op: 'export.created',
    status: 'ok',
    actor: opts.actor,
    details: {
      projectId: opts.projectId,
      sessions: result.sessions,
      workspace: result.withWorkspace,
      // ADR-115: вложения переносятся вместе с проектом (байты в архиве).
      attachments: result.attachments,
      // security-фикс 0.11.3: факт включения секретов в архив — в аудите.
      withSecrets: !!opts.withSecrets,
      bytes: result.bytes,
    },
  });
  return result;
}

async function _exportProject(opts: ExportProjectOptions): Promise<ExportProjectResult> {
  const log = opts.log ?? ((): void => {});
  const dataDir = resolve(opts.dataDir);
  const withWorkspace = !!opts.withWorkspace;
  const withAttachments = opts.withAttachments !== false;
  const workspacesRoot = opts.workspacesRoot ? resolve(opts.workspacesRoot) : join(dataDir, 'workspaces');
  // ADR-096: готовый контекст (любой backend) либо `file`-контекст по `dataDir`.
  const storage = opts.storage ?? createFileStorage({ dataDir });

  const project = await storage.projects.load(opts.projectId);
  if (!project) {
    throw new ProjectPortableError('project-not-found', `Проект ${opts.projectId} не найден.`);
  }

  const manager = new SessionManager(storage.sessions);
  const all = await manager.listSessions({ projectId: project.id });
  const localSessions: Session[] = [];
  let skippedRemote = 0;
  for (const session of all) {
    if (_isRemoteSession(session)) {
      skippedRemote++;
      log(`  пропущена удалённая сессия ${session.id} (принадлежит другому инстансу)`);
      continue;
    }
    localSessions.push(session);
  }
  if (skippedRemote > 0) {
    log(`Предупреждение: пропущено удалённых сессий — ${skippedRemote} (origin: remote).`);
  }
  localSessions.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const baseName = slugifyWorkspaceName(project.name) || 'project';
  const outPath = await _resolveOutPath(opts.out, `${baseName}.synth-project.tar.gz`);

  const staging = join(dataDir, 'tmp', `${EXPORT_STAGING_PREFIX}${generateId()}`);
  await mkdir(staging, { recursive: true });
  try {
    const sources: ArchiveSource[] = [];

    // project.json — metadata проекта (serializeProject).
    const projectPath = join(staging, 'project.json');
    await writeFile(projectPath, JSON.stringify(serializeProject(project), null, 2), 'utf-8');
    sources.push({ path: 'project.json', type: 'file', absPath: projectPath, mode: 0o644 });

    // sessions/<id>.json — переносимый payload каждой локальной сессии.
    // security-фикс 0.11.3: по умолчанию из payload вырезаются карта
    // обфускации и `metadata.secrets` (реальные значения плейсхолдеров) —
    // архив проекта не должен уносить чужие секреты.
    const sessionsDir = join(staging, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    for (const session of localSessions) {
      const path = join(sessionsDir, `${session.id}.json`);
      const payload = buildSessionExport(session);
      const packed = opts.withSecrets ? payload : _stripSessionSecrets(payload);
      await writeFile(path, JSON.stringify(packed, null, 2), 'utf-8');
      sources.push({ path: `sessions/${session.id}.json`, type: 'file', absPath: path, mode: 0o644 });
    }

    // attachments/<sha2>/<sha256> — ADR-115: байты вложений сообщений.
    // Путь в архиве совпадает с `blobPath` (content-addressed), поэтому импорт
    // восстанавливает объект по тому же адресу и не переписывает части сообщений.
    // Отсутствующий объект (dangling: GC/удалён вручную) — пропуск с предупреждением,
    // архив не роняем.
    let attachmentCount = 0;
    let attachmentSkipped = 0;
    if (withAttachments) {
      const seenBlobs = new Set<string>();
      for (const session of localSessions) {
        for (const message of session.messages ?? []) {
          for (const part of message.parts ?? []) {
            if (!MEDIA_PART_TYPES.has(part.type)) continue;
            const blobPath = (part.data as Partial<MediaPartData> | undefined)?.blobPath;
            if (typeof blobPath !== 'string' || !isAttachmentPath(blobPath)) continue;
            if (seenBlobs.has(blobPath)) continue;
            seenBlobs.add(blobPath);
            const bytes = await storage.blobs.read(blobPath);
            if (!bytes) {
              attachmentSkipped++;
              log(`  пропущено вложение без байтов: ${blobPath} (dangling)`);
              continue;
            }
            const absPath = join(staging, ...blobPath.split('/'));
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, bytes);
            sources.push({ path: blobPath, type: 'file', absPath, mode: 0o644 });
            attachmentCount++;
          }
        }
      }
      if (attachmentSkipped > 0) {
        log(`Предупреждение: вложений без байтов — ${attachmentSkipped} (в архив не попали).`);
      }
    }

    // workspace/** — опционально (--with-workspace); секретов там нет.
    if (withWorkspace) {
      const projectDir = resolveLocalWorkspace(
        project,
        workspacesRoot,
        join(workspacesRoot, 'default'),
      );
      const files = await walkDir(projectDir);
      for (const rel of files) {
        sources.push({
          path: `workspace/${rel}`,
          type: 'file',
          absPath: join(projectDir, rel),
          mode: 0o644,
        });
      }
    }

    // Записи манифеста известны до записи (манифест пишется последним).
    const entries: ProjectExportEntry[] = [];
    for (const source of sources) {
      const info = await stat(source.absPath);
      entries.push({ path: source.path, size: info.size, sha256: await _hashFile(source.absPath) });
    }

    const manifest: ProjectExportManifest = {
      tool: 'synth-project-export',
      formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
      exportedAt: nowISO(),
      instanceVersion: SYNTH_VERSION,
      project: { id: project.id, name: project.name },
      sessions: localSessions.length,
      withWorkspace,
      withAttachments,
      attachments: attachmentCount,
      entries,
    };

    await mkdir(dirname(outPath), { recursive: true });
    await writeTarGz(outPath, sources, {
      extraFile: {
        path: 'manifest.json',
        content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
      },
    });
    const bytes = (await stat(outPath)).size;
    log(`Экспорт проекта «${project.name}»: ${outPath}`);
    return {
      path: outPath,
      bytes,
      sessions: localSessions.length,
      entries: entries.length,
      withWorkspace,
      attachments: attachmentCount,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Читает и валидирует манифест архива проекта (ADR-091).
 *
 * Чтение идёт с теми же лимитами, что и импорт (`ProjectImportLimits`): превышение
 * лимита распакованного объёма — `invalid-archive` (fail-closed), архив не
 * распаковывается целиком.
 */
async function _readManifest(
  archive: string,
  limits: ProjectImportLimits,
): Promise<ProjectExportManifest> {
  let buffer: Buffer | null;
  try {
    buffer = await readFileFromTarGz(archive, 'manifest.json', limits);
  } catch (err) {
    if (err instanceof ArchiveLimitError) {
      throw new ProjectPortableError('invalid-archive', `Архив превышает лимиты импорта: ${err.message}`);
    }
    throw new ProjectPortableError('invalid-archive', `Не удалось прочитать архив: ${_errMsg(err)}`);
  }
  if (!buffer) {
    throw new ProjectPortableError('invalid-archive', 'Архив не содержит manifest.json — это не экспорт проекта Synth.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch {
    throw new ProjectPortableError('invalid-archive', 'manifest.json невалиден (не JSON).');
  }
  const manifest = parsed as Partial<ProjectExportManifest> | null;
  if (!manifest || manifest.tool !== 'synth-project-export') {
    throw new ProjectPortableError('invalid-archive', 'Архив не является экспортом проекта Synth (неверный tool).');
  }
  if (
    typeof manifest.formatVersion !== 'number'
    || manifest.formatVersion < PROJECT_EXPORT_MIN_FORMAT_VERSION
    || manifest.formatVersion > PROJECT_EXPORT_FORMAT_VERSION
  ) {
    throw new ProjectPortableError('invalid-archive', `Неподдерживаемая версия формата архива: ${String(manifest.formatVersion)}.`);
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ProjectPortableError('invalid-archive', 'manifest.json невалиден: отсутствует список записей.');
  }
  if (!manifest.project || typeof manifest.project !== 'object'
    || typeof manifest.project.id !== 'string' || typeof manifest.project.name !== 'string') {
    throw new ProjectPortableError('invalid-archive', 'manifest.json невалиден: отсутствует проект.');
  }
  return manifest as ProjectExportManifest;
}

/**
 * Проверяет контрольные суммы архива и собирает нужные файлы (project.json,
 * sessions/**, workspace/**) за один проход. Несовпадение sha256 или отсутствие
 * файла из манифеста → `checksum-mismatch`; повреждённый/небезопасный архив →
 * `invalid-archive`; превышение лимитов распакованного объёма → `invalid-archive`
 * (fail-closed: разбор обрывается в момент чтения, а не после распаковки).
 */
async function _verifyArchive(
  archive: string,
  manifest: ProjectExportManifest,
  limits: ProjectImportLimits,
): Promise<Map<string, Buffer>> {
  const expected = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry && typeof entry.path === 'string' && typeof entry.sha256 === 'string') {
      expected.set(entry.path, entry.sha256);
    }
  }

  const collected = new Map<string, Buffer>();
  const seen = new Set<string>();
  try {
    await readTarGz(
      archive,
      (entry) => {
        if (entry.type !== 'file' || entry.path === 'manifest.json') return;
        const want = expected.get(entry.path);
        if (want) {
          const got = createHash('sha256').update(entry.content).digest('hex');
          if (got !== want) {
            throw new ProjectPortableError('checksum-mismatch', `Контрольная сумма не совпадает: ${entry.path}`);
          }
          seen.add(entry.path);
        }
        if (
          entry.path === 'project.json'
          || entry.path.startsWith('sessions/')
          // ADR-115: байты вложений (формат архива 2+; в версии 1 их нет).
          || entry.path.startsWith('attachments/')
          || entry.path === 'workspace'
          || entry.path.startsWith('workspace/')
        ) {
          collected.set(entry.path, entry.content);
        }
      },
      limits,
    );
  } catch (err) {
    if (err instanceof ProjectPortableError) throw err;
    if (err instanceof ArchiveLimitError) {
      throw new ProjectPortableError('invalid-archive', `Архив превышает лимиты импорта: ${err.message}`);
    }
    if (err instanceof ArchivePathError) {
      throw new ProjectPortableError('invalid-archive', `Небезопасный путь в архиве: ${err.path}`);
    }
    throw new ProjectPortableError('invalid-archive', `Не удалось разобрать архив: ${_errMsg(err)}`);
  }

  for (const path of expected.keys()) {
    if (!seen.has(path)) {
      throw new ProjectPortableError('checksum-mismatch', `В архиве отсутствует файл: ${path}`);
    }
  }
  return collected;
}

/**
 * Импортирует проект из портативного архива (ADR-091) — materialization, не
 * `session.requested` (ADR-089, инвариант 15). Создаёт новый `projectId` и новые
 * сессии; `mergeInto` импортирует сессии в существующий проект. Без `--dry-run`
 * и без `--yes` — отказ (`confirmation-required`).
 *
 * @throws ProjectPortableError `invalid-archive`/`checksum-mismatch` — битый архив
 *   (в т.ч. превышение лимитов распакованного объёма — `ProjectImportLimits`);
 *   `project-not-found` — нет проекта для `mergeInto`; `project-name-conflict` —
 *   явное имя занято; `confirmation-required` — нет подтверждения.
 */
export async function importProject(opts: ImportProjectOptions): Promise<ImportProjectResult> {
  const dryRun = !!opts.dryRun;
  if (!dryRun && !opts.yes) {
    throw new ProjectPortableError(
      'confirmation-required',
      'Импорт создаёт новый проект и сессии. Используйте --dry-run для проверки или --yes для применения.',
    );
  }

  const result = await _importProject(opts);
  if (!dryRun) {
    await recordMaintenanceAudit(opts.audit, {
      op: 'import.applied',
      status: 'ok',
      actor: opts.actor,
      details: {
        projectId: result.projectId,
        from: resolve(opts.archive),
        sessions: result.sessionsImported,
        ...(opts.mergeInto ? { mergeInto: opts.mergeInto } : {}),
      },
    });
  }
  return result;
}

async function _importProject(opts: ImportProjectOptions): Promise<ImportProjectResult> {
  const log = opts.log ?? ((): void => {});
  const dryRun = !!opts.dryRun;
  const dataDir = resolve(opts.dataDir);
  const archive = resolve(opts.archive);
  const withWorkspace = !!opts.withWorkspace;
  const workspacesRoot = opts.workspacesRoot ? resolve(opts.workspacesRoot) : join(dataDir, 'workspaces');
  const ownerId = opts.ownerId ?? LOCAL_USER_ID;
  // Лимиты распакованного объёма (ADR-091): fail-closed, проверка в момент чтения.
  const limits: ProjectImportLimits = { ...DEFAULT_PROJECT_IMPORT_LIMITS, ...(opts.limits ?? {}) };

  const manifest = await _readManifest(archive, limits);
  const collected = await _verifyArchive(archive, manifest, limits);

  const projectBuffer = collected.get('project.json');
  if (!projectBuffer) {
    throw new ProjectPortableError('invalid-archive', 'Архив не содержит project.json.');
  }
  const projectDto = _parseJsonObject(projectBuffer, 'project.json');

  const sessionFiles: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const [path, content] of collected) {
    if (!path.startsWith('sessions/') || !path.endsWith('.json')) continue;
    const id = path.slice('sessions/'.length, -'.json'.length);
    sessionFiles.push({ id, data: _parseJsonObject(content, path) });
  }
  sessionFiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const messagesTotal = sessionFiles.reduce(
    (sum, file) => sum + _asArray(file.data.messages).length,
    0,
  );

  // ADR-096: готовый контекст (любой backend) либо `file`-контекст по `dataDir`.
  const storage = opts.storage ?? createFileStorage({ dataDir });

  // Целевой проект: существующий (`--merge-into`) либо новый.
  let target: Project | null = null;
  let name = opts.name ?? manifest.project.name;
  if (opts.mergeInto) {
    target = await storage.projects.load(opts.mergeInto);
    if (!target) {
      throw new ProjectPortableError('project-not-found', `Проект ${opts.mergeInto} не найден.`);
    }
  } else {
    const existingNames = new Set((await storage.projects.list()).map((p) => p.name));
    if (existingNames.has(name)) {
      if (opts.name) {
        throw new ProjectPortableError('project-name-conflict', `Проект с именем «${name}» уже существует.`);
      }
      name = _uniqueProjectName(name, existingNames);
    }
  }

  if (dryRun) {
    const archiveAttachments = [...collected.keys()].filter((path) => path.startsWith('attachments/')).length;
    log(`[dry-run] Импорт проекта из ${archive}`);
    log(`  проект-источник: ${manifest.project.name} (${manifest.project.id})`);
    log(`  целевой проект: ${opts.mergeInto ? `существующий ${opts.mergeInto}` : `новый «${name}»`}`);
    log(`  сессий к импорту: ${sessionFiles.length}`);
    log(`  сообщений к импорту: ${messagesTotal}`);
    log(`  вложений в архиве: ${archiveAttachments}`);
    log(`  workspace: ${withWorkspace && manifest.withWorkspace ? 'будет восстановлен' : 'нет'}`);
    log('  (dry-run: изменения не записаны)');
    return {
      projectId: opts.mergeInto ?? '',
      sessionsImported: sessionFiles.length,
      messagesImported: messagesTotal,
      workspaceRestored: false,
      idMap: {},
      attachmentsImported: 0,
      attachmentsSkipped: 0,
      warnings: [],
    };
  }

  if (!target) {
    target = storage.projects.create(name, ownerId, {
      description: typeof projectDto.description === 'string' ? projectDto.description : '',
      icon: normalizeIconKey(projectDto.icon),
      color: normalizeColorKey(projectDto.color),
      repos: Array.isArray(projectDto.repos) ? (projectDto.repos as Project['repos']) : undefined,
      mcp: projectDto.mcp && typeof projectDto.mcp === 'object' ? (projectDto.mcp as Project['mcp']) : undefined,
    });
    target.currentTask = typeof projectDto.current_task === 'string' ? projectDto.current_task : '';
    target.invariants = typeof projectDto.invariants === 'string' ? projectDto.invariants : '';
    target.statusMessages = Array.isArray(projectDto.status_messages)
      ? (projectDto.status_messages as Project['statusMessages'])
      : [];
    target.log = Array.isArray(projectDto.log) ? (projectDto.log as Project['log']) : [];
    if (projectDto.plan && typeof projectDto.plan === 'object') {
      target.plan = projectDto.plan as Project['plan'];
    }
    await storage.projects.save(target);
    log(`Проект создан: ${target.id} («${target.name}»)`);
  } else {
    log(`Импорт в существующий проект: ${target.id} («${target.name}»)`);
  }

  // ADR-089: materialization — прямой createSession (не funnel `session.requested`).
  const manager = new SessionManager(storage.sessions, { projectStore: storage.projects });
  const mapping = new Map<string, string>();
  const staged: Array<{ id: string; session: Session; data: Record<string, unknown> }> = [];

  for (const file of sessionFiles) {
    const data = file.data;
    const session = await manager.createSession({
      title: typeof data.title === 'string' ? data.title : undefined,
      icon: normalizeIconKey(data.icon),
      color: normalizeColorKey(data.color),
      projectId: target.id,
      sessionOrigin: (typeof data.sessionOrigin === 'string' ? data.sessionOrigin : undefined) as SessionOrigin | undefined,
      settings: (data.settings && typeof data.settings === 'object'
        ? data.settings
        : {}) as unknown as Partial<SessionSettings>,
      userId: ownerId,
      ownerId,
    });
    mapping.set(file.id, session.id);
    staged.push({ id: file.id, session, data });
  }

  const idMap: Record<string, string> = {};
  for (const [oldId, newId] of mapping) idMap[oldId] = newId;

  const transferredMessageIds = new Set<string>();
  for (const item of staged) {
    for (const message of _asArray(item.data.messages)) {
      if (typeof message.id === 'string') transferredMessageIds.add(message.id);
    }
  }

  let sessionsImported = 0;
  let messagesImported = 0;
  // ADR-115: восстановление байтов вложений (blob-порт + `blob_refs`).
  let attachmentsImported = 0;
  let attachmentsSkipped = 0;
  const attachmentWarnings = new Set<string>();
  for (const item of staged) {
    const data = item.data;
    const session = item.session;

    // Ссылки на перенесённые сессии → новые id; внешние — зануляются.
    session.parentId = typeof data.parentId === 'string' ? (mapping.get(data.parentId) ?? undefined) : undefined;
    session.branchPoint = typeof data.branchPoint === 'string' ? data.branchPoint : undefined;
    session.planApproved = typeof data.planApproved === 'boolean' ? data.planApproved : false;
    session.mode = typeof data.mode === 'string' ? (data.mode as SessionMode) : undefined;

    const messages: Message[] = _asArray(data.messages).map(
      (message) => structuredClone(message) as unknown as Message,
    );
    messages.forEach((message, i) => { message.seq = i + 1; });
    for (const message of messages) {
      if (typeof message.sourceMsgId === 'string' && !transferredMessageIds.has(message.sourceMsgId)) {
        message.sourceMsgId = undefined;
      }
      message.parts = message.parts.map((part) => _rewriteReferencePart(part, mapping));
    }
    session.messages = messages;
    // ADR-115: байты вложений — до сохранения сессии, чтобы ссылки `blob_refs`
    // уже существовали (иначе GC мог бы удалить объект как осиротевший).
    const attachmentStats = await _importMessageAttachments(storage, messages, collected);
    attachmentsImported += attachmentStats.imported;
    attachmentsSkipped += attachmentStats.skipped;
    for (const warning of attachmentStats.warnings) attachmentWarnings.add(warning);
    session.pendingMessages = [];
    session.todos = Array.isArray(data.todos) ? (data.todos as Session['todos']) : undefined;
    session.stickyNotes = Array.isArray(data.stickyNotes)
      ? (data.stickyNotes as Session['stickyNotes'])
      : [];
    session.references = _asArray(data.references).map((ref) => ({
      ...ref,
      sessionId: typeof ref.sessionId === 'string'
        ? (mapping.get(ref.sessionId) ?? null)
        : (ref.sessionId ?? null),
    })) as unknown as SessionReference[];
    session.checkpoints = Array.isArray(data.checkpoints)
      ? (data.checkpoints as Session['checkpoints'])
      : [];
    session.obfuscationMap = data.obfuscationMap && typeof data.obfuscationMap === 'object'
      ? (data.obfuscationMap as Session['obfuscationMap'])
      : undefined;

    // Безопасное состояние: не переносим блокировки/активный стрим/отмену/архив.
    session.status = {};
    session.currentStream = undefined;
    session.summarizationPending = false;
    session.canSummarize = false;
    session.expiresAt = undefined;
    session.archivedAt = undefined;
    session.userId = ownerId;
    session.ownerId = ownerId;

    session.inputTokens = _num(data.inputTokens);
    session.outputTokens = _num(data.outputTokens);
    session.totalTokens = _num(data.totalTokens);
    session.cacheReadTokens = _num(data.cacheReadTokens);
    session.cacheWriteTokens = _num(data.cacheWriteTokens);
    session.reasoningTokens = _num(data.reasoningTokens);
    session.inputCost = _num(data.inputCost);
    session.outputCost = _num(data.outputCost);
    session.cacheReadCost = _num(data.cacheReadCost);
    session.cacheWriteCost = _num(data.cacheWriteCost);
    if (typeof data.createdAt === 'string') session.createdAt = data.createdAt;

    await manager.saveSession(session);
    sessionsImported++;
    messagesImported += messages.length;
    // ADR-089 (инвариант 18): уведомить хаб о новой сессии (авто-подписка).
    await opts.onSessionCreated?.(session.id);
    log(`  сессия: ${session.title || session.id}`);
  }

  let workspaceRestored = false;
  if (withWorkspace && manifest.withWorkspace) {
    workspaceRestored = await _restoreWorkspace(storage, target, workspacesRoot, collected, log);
  }

  return {
    projectId: target.id,
    sessionsImported,
    messagesImported,
    workspaceRestored,
    idMap,
    attachmentsImported,
    attachmentsSkipped,
    warnings: [...attachmentWarnings],
  };
}

/** Статистика восстановления вложений одного шага импорта. */
interface AttachmentImportStats {
  imported: number;
  skipped: number;
  warnings: string[];
}

/**
 * ADR-115: восстановить байты вложений сообщений из архива в blob-порт цели.
 *
 * - адрес объекта **content-addressed** (`attachments/<sha2>/<sha256>`), поэтому
 *   `blobPath` частей сообщения не меняется; уже существующий объект (дедуп) не
 *   перезаписывается;
 * - sidecar (`<sha>.json`) с метаданными создаётся из данных части, если его нет —
 *   имя файла и MIME переживают перенос;
 * - на объект фиксируется ссылка `blob_refs` (`ownerKind: 'message'`) — иначе GC
 *   считал бы объект осиротевшим;
 * - отсутствующий в архиве объект (dangling) или несовпадение sha256 — **пропуск
 *   с предупреждением**: части сообщения сохраняются, импорт не падает.
 */
async function _importMessageAttachments(
  storage: StorageContext,
  messages: Message[],
  collected: Map<string, Buffer>,
): Promise<AttachmentImportStats> {
  const warnings = new Set<string>();
  let imported = 0;
  let skipped = 0;

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!MEDIA_PART_TYPES.has(part.type)) continue;
      const data = (part.data ?? {}) as Partial<MediaPartData>;
      const blobPath = data.blobPath;
      if (typeof blobPath !== 'string' || !isAttachmentPath(blobPath)) continue;

      const bytes = collected.get(blobPath);
      if (!bytes) {
        skipped++;
        warnings.add(`вложение отсутствует в архиве (dangling): ${blobPath}`);
        continue;
      }
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      const pathSha = blobPath.split('/').pop() ?? '';
      if ((typeof data.sha256 === 'string' && data.sha256 !== actualSha) || pathSha !== actualSha) {
        skipped++;
        warnings.add(`контрольная сумма вложения не совпадает: ${blobPath}`);
        continue;
      }

      if (!(await storage.blobs.exists(blobPath))) {
        await storage.blobs.write(blobPath, bytes);
      }
      const sidecarPath = `${blobPath}.json`;
      if (!(await storage.blobs.exists(sidecarPath))) {
        const sidecar = {
          mime: typeof data.mime === 'string' && data.mime ? data.mime : 'application/octet-stream',
          size: bytes.length,
          sha256: actualSha,
          ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
          ...(typeof data.width === 'number' ? { width: data.width } : {}),
          ...(typeof data.height === 'number' ? { height: data.height } : {}),
          ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
        };
        await storage.blobs.write(sidecarPath, JSON.stringify(sidecar));
      }
      await storage.blobRefs.add({ blobPath, ownerKind: 'message', ownerId: message.id });
      imported++;
    }
  }

  return { imported, skipped, warnings: [...warnings] };
}

/**
 * Проверяет безопасность пути записи внутри workspace (security-фикс 0.11.3).
 *
 * Лексическая проверка (`resolve` + префикс) **недостаточна**: заранее
 * существующий симлинк внутри workspace (в каталоге или сам файл) проходит
 * её, но `writeFile` следует по симлинку и пишет **вне** workspace. Поэтому:
 *
 * 1. ни один компонент пути от корня workspace до цели (включая финальный)
 *    не должен быть симлинком (`lstat`);
 * 2. родитель цели после разыменования символов должен лежать внутри
 *    разыменованного корня workspace (`realpath`-containment, fail-closed:
 *    неразрешимый путь → отказ).
 *
 * Нарушение → `ProjectPortableError` с кодом `invalid-archive` (на него
 * завязаны CLI/HTTP-поверхности).
 */
async function _assertSafeWorkspaceTarget(
  workspaceDir: string,
  target: string,
  archivePath: string,
): Promise<void> {
  const reject = (reason: string): never => {
    throw new ProjectPortableError(
      'invalid-archive',
      `Небезопасный путь workspace (${reason}): ${archivePath}`,
    );
  };

  // 1) Симлинков на пути (включая финальный компонент) быть не должно.
  const rel = relative(workspaceDir, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) reject('вне workspace');
  let current = workspaceDir;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      // Компонент ещё не существует — его создаст `mkdir` (симлинком он не является).
      continue;
    }
    if (stats.isSymbolicLink()) reject('симлинк на пути');
  }

  // 2) Realpath-контейнмент: родитель цели после разыменования — внутри workspace.
  if (!resolveRealPath(workspaceDir)) reject('каталог workspace не разрешается');
  if (!resolveRealPath(dirname(target))) reject('путь не разрешается');
  if (!isInsideReal(workspaceDir, dirname(target))) reject('выход за пределы workspace');
}

/**
 * Восстанавливает `workspace/**` архива в каталог проекта (ADR-075): при
 * отсутствии workspace у проекта — авто-имя через общий provisioning. Путь цели
 * проверяется на containment (защита от path traversal) **и** на realpath
 * (security-фикс 0.11.3: симлинк внутри workspace не должен выводить запись за
 * его пределы).
 */
async function _restoreWorkspace(
  storage: StorageContext,
  project: Project,
  workspacesRoot: string,
  collected: Map<string, Buffer>,
  log: (msg: string) => void,
): Promise<boolean> {
  let workspaceDir: string;
  if (project.workspace) {
    workspaceDir = isAbsolute(project.workspace)
      ? normalize(project.workspace)
      : resolve(workspacesRoot, project.workspace);
  } else {
    const provisioned = await provisionManagedWorkspace(storage.projects, workspacesRoot, project.name, undefined);
    if (!provisioned.ok || !provisioned.workspace) {
      throw new ProjectPortableError(
        'workspace-error',
        provisioned.ok ? 'Не удалось определить каталог workspace проекта.' : provisioned.message,
      );
    }
    project.workspace = provisioned.workspace;
    await storage.projects.save(project);
    workspaceDir = resolve(workspacesRoot, provisioned.workspace);
  }
  await mkdir(workspaceDir, { recursive: true });

  let restored = 0;
  for (const [path, content] of collected) {
    if (!path.startsWith('workspace/')) continue;
    const rel = path.slice('workspace/'.length);
    if (!rel) continue;
    const target = resolve(workspaceDir, rel);
    if (target === workspaceDir || !target.startsWith(workspaceDir + sep)) {
      throw new ProjectPortableError('invalid-archive', `Небезопасный путь workspace: ${path}`);
    }
    await _assertSafeWorkspaceTarget(workspaceDir, target, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    restored++;
  }
  if (restored > 0) log(`  workspace восстановлен: ${workspaceDir} (${restored} файлов)`);
  return restored > 0;
}
