/**
 * Снимки терминалов (PROP-132) — восстановление после рестарта ядра.
 *
 * ## Что хранится
 *
 * Терминал — PTY-сессия: сам процесс после рестарта ядра не переживает. Но
 * **история вывода** пережить может — она лежит в кольцевом буфере сервиса
 * (`512 КиБ`). Чтобы вкладка терминала после рестарта показывала последний
 * вывод, сервис кладёт снимок в blob-хранилище (ADR-096/ADR-116 — тот же порт
 * `BlobStore`, что у логов фоновых процессов):
 *
 * ```text
 * terminals/<id>/meta.json   — запись реестра (`TerminalRecord`) + `savedAt`
 * terminals/<id>/output.txt  — хвост кольцевого буфера (≤ 512 КиБ)
 * ```
 *
 * ## Правила
 *
 * - **Хвост, а не весь вывод:** в снимок попадает только то, что ещё лежит в
 *   буфере (`ringBufferBytes`). Снимок — «последние 512 КиБ», а не журнал.
 * - **Срок жизни — `idleMs`** (2 дня от `lastActivityAt`): снимок старше срока
 *   удаляется (reaper/старт процесса), терминал не восстанавливается.
 * - **Явное удаление терминала удаляет и снимок:** удалённый терминал не
 *   должен воскреснуть после рестарта.
 * - **`terminal.autoRestore === false`** — снимки не поднимаются; их убирает
 *   reaper (иначе файлы копились бы впустую).
 *
 * ## Чего здесь нет
 *
 * Никаких прямых обращений к `$SYNTH_DATA_DIR`: только порт `BlobStore`
 * (инвариант 2). Пути относительные — корень задаёт реализация порта
 * (`{dataDir}/blobs`).
 */
import type { BlobStore } from '../../storage/ports/blob-store.js';
import type { TerminalRecord } from './types.js';

/** Префикс снимков терминалов в blob-хранилище. */
export const TERMINAL_SNAPSHOT_PREFIX = 'terminals/';

/**
 * Предел хвоста вывода в снимке, байт (512 КиБ — ёмкость кольцевого буфера).
 *
 * Держим ровно столько, сколько влезает в буфер: снимок — «последние
 * 512 КиБ», а не журнал сессии.
 */
export const TERMINAL_SNAPSHOT_OUTPUT_BYTES = 512 * 1024;

/** Версия формата снимка (на случай смены схемы). */
export const TERMINAL_SNAPSHOT_VERSION = 1;

/** Метаданные снимка: запись реестра + время сохранения. */
export interface TerminalSnapshotMeta {
  /** Версия формата снимка. */
  version: number;
  /** Момент сохранения (мс epoch). */
  savedAt: number;
  /** Запись реестра терминала на момент сохранения. */
  record: TerminalRecord;
}

/** Путь файла метаданных снимка терминала. */
export function terminalSnapshotMetaPath(id: string): string {
  return `${TERMINAL_SNAPSHOT_PREFIX}${id}/meta.json`;
}

/** Путь файла вывода снимка терминала. */
export function terminalSnapshotOutputPath(id: string): string {
  return `${TERMINAL_SNAPSHOT_PREFIX}${id}/output.txt`;
}

/**
 * Хвост текста, помещающийся в `maxBytes` байт UTF-8.
 *
 * Обрезка — по границе кодовой точки (как в кольцевом буфере): битый UTF-8 в
 * снимке недопустим — вывод читает клиент.
 */
function utf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  const points = Array.from(text);
  let size = 0;
  let start = points.length;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const pointBytes = Buffer.byteLength(points[i]!, 'utf8');
    if (size + pointBytes > maxBytes) break;
    size += pointBytes;
    start = i;
  }
  return points.slice(start).join('');
}

/**
 * Записать снимок терминала (метаданные + хвост вывода).
 *
 * Ошибка записи **не ломает терминал**: снимок — best-effort (то же, что
 * логи фоновых процессов, ADR-113). Вызывающий сам решает, что делать с
 * ошибкой (сервис — предупреждение в лог).
 */
export async function writeTerminalSnapshot(
  blobs: BlobStore,
  record: TerminalRecord,
  output: string,
  now: number,
): Promise<void> {
  const meta: TerminalSnapshotMeta = {
    version: TERMINAL_SNAPSHOT_VERSION,
    savedAt: now,
    record,
  };
  await blobs.write(terminalSnapshotMetaPath(record.id), `${JSON.stringify(meta, null, 2)}\n`);
  const tail = utf8Tail(output, TERMINAL_SNAPSHOT_OUTPUT_BYTES);
  if (tail !== '') {
    await blobs.write(terminalSnapshotOutputPath(record.id), tail);
  }
}

/**
 * Прочитать метаданные снимка терминала.
 *
 * `null` — снимка нет или он битый (нечитаемый JSON/не та схема): битый
 * снимок считается отсутствующим (терминал не восстанавливается, файл уберёт
 * reaper).
 */
export async function readTerminalSnapshot(
  blobs: BlobStore,
  id: string,
): Promise<TerminalSnapshotMeta | null> {
  const raw = await blobs.read(terminalSnapshotMetaPath(id));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<TerminalSnapshotMeta>;
  const record = candidate.record;
  if (!record || typeof record !== 'object') return null;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.projectId !== 'string' || record.projectId === '') return null;
  if (typeof record.cwd !== 'string' || record.cwd === '') return null;
  if (typeof record.shell !== 'string' || record.shell === '') return null;
  if (typeof record.lastActivityAt !== 'number' || !Number.isFinite(record.lastActivityAt)) {
    return null;
  }
  return {
    version: typeof candidate.version === 'number' ? candidate.version : TERMINAL_SNAPSHOT_VERSION,
    savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : record.lastActivityAt,
    record: record as TerminalRecord,
  };
}

/** Прочитать сохранённый вывод снимка (пустая строка — вывода не было). */
export async function readTerminalSnapshotOutput(blobs: BlobStore, id: string): Promise<string> {
  const raw = await blobs.read(terminalSnapshotOutputPath(id));
  if (!raw) return '';
  return raw.toString('utf8');
}

/** Удалить снимок терминала (файлы метаданных и вывода). */
export async function deleteTerminalSnapshot(blobs: BlobStore, id: string): Promise<void> {
  await blobs.delete(terminalSnapshotMetaPath(id));
  await blobs.delete(terminalSnapshotOutputPath(id));
}

/**
 * Идентификаторы терминалов, у которых есть снимок.
 *
 * Снимок считается существующим по файлу метаданных (`meta.json`); осиротевший
 * `output.txt` без метаданных уборщик удалит отдельно.
 */
export async function listTerminalSnapshotIds(blobs: BlobStore): Promise<string[]> {
  const entries = await blobs.list(TERMINAL_SNAPSHOT_PREFIX);
  const ids = new Set<string>();
  for (const entry of entries) {
    const path = entry.path;
    const metaSuffix = '/meta.json';
    if (!path.endsWith(metaSuffix)) continue;
    const id = path.slice(TERMINAL_SNAPSHOT_PREFIX.length, path.length - metaSuffix.length);
    if (id === '' || id.includes('/')) continue;
    ids.add(id);
  }
  return [...ids];
}
