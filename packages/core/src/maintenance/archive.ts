// ADR-091: минимальный потоковый tar.gz (ustar) без внешних зависимостей.
// Используется `synth backup`/`restore` для архива каталога данных с манифестом.
// Пишем/читаем только `node:fs`, `node:zlib`, `node:crypto`, `node:path`.
//
// Безопасность чтения: при разборе архива путь нормализуется и отвергаются
// абсолютные пути, `..`, пустые сегменты и `.` (`ArchivePathError`). Симлинки и
// hardlink не разворачиваются и пропускаются.
import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, type Dirent } from 'node:fs';
import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';

/** Размер tar-блока (ustar). */
const BLOCK_SIZE = 512;
/** Права файла архива (архив — потенциальный секрет). */
const ARCHIVE_MODE = 0o600;
/** Пустой буфер (для каталогов/пустых файлов). */
const EMPTY = Buffer.alloc(0);

/** Метаданные записи архива (ADR-091). */
export interface ArchiveEntryMeta {
  /** Путь относительно корня архива (POSIX-разделители, без завершающего `/`). */
  path: string;
  type: 'file' | 'dir';
  size: number;
  mode: number;
  /** sha256 содержимого — только для файлов. */
  sha256?: string;
}

/** Источник для записи в архив (ADR-091). */
export interface ArchiveSource {
  /** Путь относительно корня архива. */
  path: string;
  type: 'file' | 'dir';
  /** Абсолютный путь на диске. */
  absPath: string;
  /** Права доступа (биты 0o777). */
  mode: number;
}

/**
 * Небезопасный путь внутри архива (path traversal, абсолютный путь,
 * пустой/`.`/`..`-сегмент) — PROT-091.
 */
export class ArchivePathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Небезопасный путь в архиве: ${path}`);
    this.name = 'ArchivePathError';
    this.path = path;
  }
}

/**
 * Превышен лимит разбора архива (число записей / размер одной записи /
 * суммарный распакованный объём) — защита от archive-бомб: fail-closed, разбор
 * обрывается **до** буферизации очередной записи.
 */
export class ArchiveLimitError extends Error {
  /** Какая именно граница превышена. */
  readonly limit: 'entries' | 'entry-size' | 'total-size';
  /** Значение границы (байты/штуки). */
  readonly limitValue: number;
  /** Фактическое значение (что получилось). */
  readonly actual: number;

  constructor(limit: 'entries' | 'entry-size' | 'total-size', limitValue: number, actual: number) {
    super(`Превышен лимит архива (${limit}): ${actual} > ${limitValue}`);
    this.name = 'ArchiveLimitError';
    this.limit = limit;
    this.limitValue = limitValue;
    this.actual = actual;
  }
}

/**
 * Лимиты разбора архива (fail-closed). Проверяются **в момент чтения**:
 * содержимое записи буферизуется целиком, поэтому лимит одной записи
 * проверяется по заголовку ДО чтения данных, а суммарный — по сумме размеров
 * заголовков (объявленный размер tar совпадает с фактическим).
 */
export interface ReadTarGzOptions {
  /** Максимум записей в архиве (файлы + каталоги). */
  maxEntries?: number;
  /** Максимум размера одной записи (байты). */
  maxEntryBytes?: number;
  /** Максимум суммарного распакованного объёма (байты). */
  maxTotalBytes?: number;
}

/** Дополнительные параметры записи архива. */
export interface WriteTarGzExtra {
  /** Колбэк на каждую записанную исходную запись (файл/каталог). */
  onEntry?: (meta: ArchiveEntryMeta) => void;
  /** Дополнительный файл (манифест) — всегда добавляется последней записью. */
  extraFile?: { path: string; content: Buffer };
}

/** Округление размера до границы блока. */
function _padSize(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

/** Число байт дополнения содержимого до границы блока (для записи). */
function _contentPadding(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

/** Записывает строку в буфер (UTF-8) с усечением по длине поля. */
function _writeString(buf: Buffer, value: string, offset: number, length: number): void {
  if (value.length === 0) return;
  Buffer.from(value, 'utf-8').copy(buf, offset, 0, length);
}

/** Записывает восьмеричное число (длина поля — с завершающим NUL). */
function _writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const str = value.toString(8).padStart(length - 1, '0');
  buf.write(str.slice(-(length - 1)), offset, 'ascii');
  buf[offset + length - 1] = 0;
}

/**
 * Разбивает имя на поле `name` (≤100 байт) и `prefix` (≤155 байт) по `/`.
 * @throws Error если имя не помещается в ustar.
 */
function _splitName(name: string): { name: string; prefix: string } {
  const bytes = Buffer.from(name, 'utf-8');
  if (bytes.length <= 100) return { name, prefix: '' };
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x2f /* '/' */) continue;
    const prefixBytes = i;
    const nameBytes = bytes.length - i - 1;
    if (prefixBytes <= 155 && nameBytes > 0 && nameBytes <= 100) {
      return {
        name: bytes.subarray(i + 1).toString('utf-8'),
        prefix: bytes.subarray(0, i).toString('utf-8'),
      };
    }
  }
  throw new Error(`Имя файла слишком длинное для ustar: ${name}`);
}

/** Собирает ustar-заголовок (512 байт) с корректной контрольной суммой. */
function _buildHeader(path: string, type: 'file' | 'dir', mode: number, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK_SIZE);
  const name = type === 'dir' ? `${path}/` : path;
  const { name: nameField, prefix } = _splitName(name);

  _writeString(buf, nameField, 0, 100);
  _writeOctal(buf, mode & 0o7777, 100, 8);
  _writeOctal(buf, 0, 108, 8); // uid
  _writeOctal(buf, 0, 116, 8); // gid
  _writeOctal(buf, size, 124, 12);
  _writeOctal(buf, Math.floor(Date.now() / 1000), 136, 12); // mtime
  buf.write('        ', 148, 8, 'ascii'); // chksum — временно пробелы
  buf[156] = type === 'dir' ? 0x35 /* '5' */ : 0x30 /* '0' */;
  _writeString(buf, 'ustar\0', 257, 6); // magic
  buf.write('00', 263, 2, 'ascii'); // version
  _writeString(buf, prefix, 345, 155);

  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20; // пробел
  return buf;
}

/** Строка из HEX-поля заголовка (до первого NUL). */
function _readCString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf-8');
}

/** Восьмеричное число из поля заголовка. */
function _readOctal(block: Buffer, offset: number, length: number): number {
  const raw = _readCString(block, offset, length).trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Блок целиком из нулей (маркер конца архива). */
function _isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/** Разобранный заголовок записи. */
interface ParsedHeader {
  path: string;
  type: 'file' | 'dir' | 'other';
  size: number;
  mode: number;
}

/** Разбирает 512-байтовый заголовок; неизвестные типы → `other`. */
function _parseHeader(block: Buffer): ParsedHeader {
  const name = _readCString(block, 0, 100);
  const prefix = _readCString(block, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  const typeflag = block[156];
  const type: ParsedHeader['type'] =
    typeflag === 0x35 ? 'dir' : typeflag === 0x30 || typeflag === 0x00 ? 'file' : 'other';
  return {
    path,
    type,
    size: _readOctal(block, 124, 12),
    mode: _readOctal(block, 100, 8),
  };
}

/** Нормализует и проверяет путь записи (защита от path traversal). */
function _validateEntryPath(raw: string): string {
  const isDir = raw.endsWith('/');
  const trimmed = isDir ? raw.replace(/\/+$/, '') : raw;
  if (trimmed.length === 0 || trimmed.startsWith('/')) throw new ArchivePathError(raw);
  const parts = trimmed.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new ArchivePathError(raw);
  }
  return trimmed;
}

/** Потоковый читатель блоков поверх async-итератора gzip. */
class BlockReader {
  private readonly _iter: AsyncIterator<Buffer>;
  private readonly _chunks: Buffer[] = [];
  private _length = 0;
  private _done = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this._iter = stream[Symbol.asyncIterator]();
  }

  private async _fill(min: number): Promise<void> {
    while (this._length < min && !this._done) {
      const next = await this._iter.next();
      if (next.done) {
        this._done = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this._chunks.push(chunk);
      this._length += chunk.length;
    }
  }

  /** Забирает ровно `n` байт из накопленного. */
  private _take(n: number): Buffer {
    if (n === 0) return EMPTY;
    if (this._chunks.length === 1) {
      const only = this._chunks[0];
      if (!only) return EMPTY;
      const out = only.subarray(0, n);
      const rest = only.subarray(n);
      if (rest.length > 0) this._chunks[0] = rest;
      else this._chunks.length = 0;
      this._length -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const first = this._chunks[0];
      if (!first) break;
      const need = n - off;
      if (first.length <= need) {
        first.copy(out, off);
        off += first.length;
        this._chunks.shift();
      } else {
        first.copy(out, off, 0, need);
        this._chunks[0] = first.subarray(need);
        off += need;
      }
    }
    this._length -= n;
    return out;
  }

  /** Ровно `n` байт или `null` при усечённом конце. */
  async readExact(n: number): Promise<Buffer | null> {
    await this._fill(n);
    if (this._length < n) return null;
    return this._take(n);
  }

  /** До `n` байт (меньше только в самом конце потока). */
  async readUpTo(n: number): Promise<Buffer> {
    await this._fill(n);
    return this._take(Math.min(n, this._length));
  }
}

/**
 * Детерминированно (сортировка) собирает файлы/каталоги для архива.
 * Симлинки и прочие не-файлы/не-каталоги пропускаются.
 */
export async function listFilesForArchive(
  rootDir: string,
  opts: { exclude: (relPath: string, isDir: boolean) => boolean },
): Promise<ArchiveSource[]> {
  const out: ArchiveSource[] = [];

  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(rootDir, rel) : rootDir;
    const entries: Dirent[] = await readdir(abs, { withFileTypes: true }).catch(
      () => [] as Dirent[],
    );
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      const isFile = entry.isFile();
      if (!isDir && !isFile) continue; // симлинки и прочее не архивируем
      if (opts.exclude(childRel, isDir)) continue;
      const childAbs = join(abs, entry.name);
      let mode = 0o644;
      try {
        mode = (await stat(childAbs)).mode & 0o777;
      } catch {
        continue;
      }
      if (isDir) {
        out.push({ path: childRel, type: 'dir', absPath: childAbs, mode });
        await walk(childRel);
      } else {
        out.push({ path: childRel, type: 'file', absPath: childAbs, mode });
      }
    }
  }

  await walk('');
  // Глобальная сортировка: детерминированный порядок; каталог всегда идёт
  // перед своим содержимым (короткая строка лексикографически меньше).
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Потоково пишет содержимое файла в gzip, попутно считая sha256. */
function _streamFile(absPath: string, gzip: Gzip, hash: Hash): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rs = createReadStream(absPath);
    rs.on('error', reject);
    rs.on('end', resolve);
    rs.pipe(gzip, { end: false });
    rs.on('data', (chunk) => hash.update(chunk));
  });
}

/**
 * Записывает источники в gzip-tar потоково (не держа архив в памяти).
 * Дополнительный файл (манифест) — последней записью. Возвращает метаданные
 * исходных записей (без `extraFile`).
 */
export async function writeTarGz(
  outPath: string,
  sources: ArchiveSource[],
  extra?: WriteTarGzExtra,
): Promise<ArchiveEntryMeta[]> {
  const metas: ArchiveEntryMeta[] = [];
  const gzip = createGzip();
  const out = createWriteStream(outPath, { mode: ARCHIVE_MODE });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });
  gzip.pipe(out);

  try {
    for (const source of sources) {
      if (source.type === 'dir') {
        gzip.write(_buildHeader(source.path, 'dir', source.mode, 0));
        const meta: ArchiveEntryMeta = {
          path: source.path,
          type: 'dir',
          size: 0,
          mode: source.mode,
        };
        metas.push(meta);
        extra?.onEntry?.(meta);
        continue;
      }

      const info = await stat(source.absPath);
      const hash = createHash('sha256');
      gzip.write(_buildHeader(source.path, 'file', source.mode, info.size));
      await _streamFile(source.absPath, gzip, hash);
      const padding = _contentPadding(info.size);
      if (padding > 0) gzip.write(Buffer.alloc(padding));
      const meta: ArchiveEntryMeta = {
        path: source.path,
        type: 'file',
        size: info.size,
        mode: source.mode,
        sha256: hash.digest('hex'),
      };
      metas.push(meta);
      extra?.onEntry?.(meta);
    }

    if (extra?.extraFile) {
      const content = extra.extraFile.content;
      gzip.write(_buildHeader(extra.extraFile.path, 'file', 0o600, content.length));
      gzip.write(content);
      const padding = _contentPadding(content.length);
      if (padding > 0) gzip.write(Buffer.alloc(padding));
    }

    gzip.write(Buffer.alloc(BLOCK_SIZE * 2)); // два нулевых блока — конец архива
    gzip.end();
    await finished;
    await chmod(outPath, ARCHIVE_MODE);
  } catch (err) {
    out.destroy();
    gzip.destroy();
    throw err;
  }

  return metas;
}

/** Запись, отдаваемая в колбэк чтения. */
export interface ReadTarGzEntry {
  path: string;
  type: 'file' | 'dir';
  mode: number;
  content: Buffer;
}

/**
 * Потоково разбирает tar.gz; `onEntry` вызывается для файлов и каталогов.
 * Симлинки/hardlink и прочие типы пропускаются. Небезопасный путь →
 * `ArchivePathError`; превышение лимитов (`options`) → `ArchiveLimitError`
 * (проверка — по заголовку записи, до буферизации её содержимого).
 */
export async function readTarGz(
  archivePath: string,
  onEntry: (entry: ReadTarGzEntry) => Promise<void> | void,
  options: ReadTarGzOptions = {},
): Promise<void> {
  const source = createReadStream(archivePath);
  const gunzip = createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  // Гасим возможный необработанный 'error' после остановки чтения (итератор
  // получает ошибку сам через reject).
  gunzip.on('error', () => {});
  source.pipe(gunzip);
  const reader = new BlockReader(gunzip);
  const maxEntries = options.maxEntries;
  const maxEntryBytes = options.maxEntryBytes;
  const maxTotalBytes = options.maxTotalBytes;
  let entries = 0;
  let totalBytes = 0;

  try {
    for (;;) {
      const block = await reader.readExact(BLOCK_SIZE);
      if (!block || _isZeroBlock(block)) break;
      const header = _parseHeader(block);

      // Лимиты — ДО чтения содержимого записи (содержимое буферизуется целиком).
      entries += 1;
      if (maxEntries !== undefined && entries > maxEntries) {
        throw new ArchiveLimitError('entries', maxEntries, entries);
      }
      if (maxEntryBytes !== undefined && header.size > maxEntryBytes) {
        throw new ArchiveLimitError('entry-size', maxEntryBytes, header.size);
      }
      totalBytes += header.size;
      if (maxTotalBytes !== undefined && totalBytes > maxTotalBytes) {
        throw new ArchiveLimitError('total-size', maxTotalBytes, totalBytes);
      }

      let content: Buffer = EMPTY;
      const padding = _padSize(header.size);
      if (padding > 0) {
        const data = await reader.readUpTo(padding);
        content = data.length > header.size ? data.subarray(0, header.size) : data;
      }

      if (header.type === 'file' || header.type === 'dir') {
        const safePath = _validateEntryPath(header.path);
        await onEntry({ path: safePath, type: header.type, mode: header.mode, content });
      }
    }
  } finally {
    source.destroy();
  }
}

/** Список записей архива (пути, типы, размеры, права). */
export async function listTarGz(
  archivePath: string,
): Promise<Array<{ path: string; type: 'file' | 'dir'; size: number; mode: number }>> {
  const out: Array<{ path: string; type: 'file' | 'dir'; size: number; mode: number }> = [];
  await readTarGz(archivePath, (entry) => {
    out.push({ path: entry.path, type: entry.type, size: entry.content.length, mode: entry.mode });
  });
  return out;
}

/** Читает один файл из архива (для манифеста); нет файла → `null`. */
export async function readFileFromTarGz(
  archivePath: string,
  path: string,
  options: ReadTarGzOptions = {},
): Promise<Buffer | null> {
  let found: Buffer | null = null;
  await readTarGz(
    archivePath,
    (entry) => {
      if (found === null && entry.type === 'file' && entry.path === path) found = entry.content;
    },
    options,
  );
  return found;
}
