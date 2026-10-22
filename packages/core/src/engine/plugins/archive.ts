/**
 * PROP-090 §«Источники установки» (долги Д1): распаковка `.tar.gz`/`.tgz`
 * бандла плагина **своими силами** — `node:zlib` + разбор tar. Новых
 * зависимостей не вводим (инвариант 12: «зависимости — только с разрешения»),
 * а `tar`/`tar-fs` не входят в дерево core.
 *
 * Модуль намеренно **не переиспользует** `maintenance/archive.ts` (ADR-091):
 * у архива бэкапа другие правила — симлинки там молча пропускаются, pax-заголовки
 * не поддерживаются, а вход — путь к файлу, а не байты. Здесь нужен строгий
 * приём **чужого** архива:
 *
 * ```text
 * gzip → tar (блоки 512, ustar/pax/GNU) → проверки → запись в tmp-каталог
 *   ↗ отказ на любом шаге: симлинк/hardlink/устройство/FIFO, абсолютный путь,
 *     «..»-сегмент, windows-диск, слишком длинный/пустой путь, превышение
 *     лимитов (файлов/файла/суммы), неожиданная раскладка относительно stripPrefix
 * ```
 *
 * **Порядок важен:** сначала разбирается и проверяется **весь** архив, и только
 * потом что-либо пишется на диск. Иначе архив с «хорошим» первым файлом и
 * «плохим» вторым оставлял бы на диске частично распакованный бандл, который
 * кто-то мог бы принять за валидный.
 *
 * **Куда пишем.** Только в `destDir` (по умолчанию — `mkdtemp(<tmp>/synth-plugin-)`):
 * финальная проверка `resolve(destDir, rel)` обязана начинаться с
 * `resolve(destDir) + sep` — это последняя линия против tar-slip, даже если
 * нормализация пути когда-нибудь ослабнет. Раскладка слоя плагинов
 * (`installed/`/`quarantine/`) этим модулем не трогается: установщик копирует
 * файлы сам (`stagePluginBundle`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

/** Размер tar-блока (ustar). */
const BLOCK_SIZE = 512;

/** Префикс временного каталога распаковки (`synth-plugin-XXXXXX`). */
const TEMP_PREFIX = 'synth-plugin-';

/** Лимиты распаковки по умолчанию (fail-closed; переопределяются в запросе). */
const DEFAULT_LIMITS: Required<TarExtractLimits> = {
  maxFiles: 500,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathLength: 1024,
};

/** `gunzip` в промис-форме (модуля `node:zlib/promises` не существует). */
const gunzip = promisify(gunzipCallback) as (
  buffer: Buffer,
  options?: { maxOutputLength?: number },
) => Promise<Buffer>;

/**
 * Лимиты распаковки архива плагина.
 *
 * Превышение — **отказ** (`PluginArchiveError`), а не усечение: недособранный
 * бандл нельзя ни сканировать осмысленно, ни устанавливать.
 */
export interface TarExtractLimits {
  /** Максимум записей архива (файлы + каталоги), по умолчанию 500. */
  maxFiles?: number;
  /** Максимум размера одного файла, байты (по умолчанию 16 МиБ). */
  maxFileBytes?: number;
  /** Максимум суммарного размера файлов, байты (по умолчанию 64 МиБ). */
  maxTotalBytes?: number;
  /** Максимум длины относительного пути, символы (по умолчанию 1024). */
  maxPathLength?: number;
}

/** Результат распаковки: каталог, состав и освобождение ресурсов. */
export interface ExtractedArchive {
  /** Временный каталог (вне раскладки плагинов, под `tmp`). */
  dir: string;
  /** Относительные пути **файлов** (posix, без каталогов). */
  files: string[];
  /** Суммарный размер распакованных файлов (байты). */
  totalBytes: number;
  /** Удалить каталог (идемпотентно). */
  cleanup(): Promise<void>;
}

/**
 * Отказ разбора/распаковки архива: битый gzip, небезопасный путь, запрещённый
 * тип записи, превышение лимитов, неожиданная раскладка.
 *
 * Отдельный класс (а не голый `Error`) — вызывающий отличает «архив не принят»
 * от сбоя файловой системы и от сетевой ошибки.
 */
export class PluginArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginArchiveError';
  }
}

// ── Разбор tar ──────────────────────────────────────────────────────────

/** Поля, которые может переопределить pax-заголовок (`x`/`g`). */
interface PaxFields {
  path?: string;
  /** Размер записи (pax умеет > 8 ГиБ; нам нужен для корректного чтения данных). */
  size?: number;
}

/** Разобранная запись архива (данные — срез буфера tar, без копирования). */
interface TarEntry {
  /** Нормализованный относительный путь (posix). Пустой — корень. */
  path: string;
  type: 'file' | 'dir';
  /** Размер объявленный (данные — `data.length`). */
  size: number;
  data: Buffer;
}

/** Строка из поля заголовка (до первого NUL). */
function readCString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf-8');
}

/**
 * Число из поля заголовка: восьмеричное (ustar) либо base-256 (GNU, большие
 * размеры — старший бит первого байта выставлен).
 */
function readNumeric(block: Buffer, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = 0;
    for (let i = offset + 1; i < offset + length; i += 1) {
      value = value * 256 + (block[i] ?? 0);
    }
    return value;
  }
  const raw = readCString(block, offset, length).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Блок целиком из нулей — маркер конца архива. */
function isZeroBlock(block: Buffer): boolean {
  if (block.length === 0) return true;
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * Разбор pax-заголовка (`<len> <key>=<value>\n`, где `len` — длина записи
 * вместе с завершающим переводом строки).
 */
function parsePaxRecords(content: Buffer): PaxFields {
  const fields: PaxFields = {};
  let pos = 0;
  while (pos < content.length) {
    const space = content.indexOf(0x20, pos);
    if (space === -1) throw new PluginArchiveError('pax-заголовок архива повреждён: нет разделителя.');
    const length = Number.parseInt(content.subarray(pos, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0 || pos + length > content.length) {
      throw new PluginArchiveError('pax-заголовок архива повреждён: неверная длина записи.');
    }
    const record = content
      .subarray(space + 1, pos + length)
      .toString('utf-8')
      .replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === 'path') fields.path = value;
      if (key === 'size') {
        const size = Number.parseInt(value, 10);
        if (!Number.isFinite(size) || size < 0) {
          throw new PluginArchiveError('pax-заголовок архива: некорректный size.');
        }
        fields.size = size;
      }
    }
    pos += length;
  }
  return fields;
}

/** Классификация typeflag: только обычные файлы и каталоги. */
function entryType(typeflag: number): 'file' | 'dir' {
  // '\0' и '0' — обычный файл, '7' — contiguous (tar считает его файлом).
  if (typeflag === 0 || typeflag === 0x30 || typeflag === 0x37) return 'file';
  if (typeflag === 0x35) return 'dir';
  if (typeflag === 0x32) {
    throw new PluginArchiveError(
      'Архив содержит символьную ссылку — бандл плагина не может её содержать (путь к побегу).',
    );
  }
  if (typeflag === 0x31) {
    throw new PluginArchiveError(
      'Архив содержит жёсткую ссылку — бандл плагина не может её содержать.',
    );
  }
  if (typeflag === 0x33 || typeflag === 0x34) {
    throw new PluginArchiveError(
      'Архив содержит файл устройства — бандл плагина не может его содержать.',
    );
  }
  if (typeflag === 0x36) {
    throw new PluginArchiveError('Архив содержит FIFO — бандл плагина не может его содержать.');
  }
  const shown = typeflag >= 0x20 && typeflag < 0x7f ? `«${String.fromCharCode(typeflag)}»` : `0x${typeflag.toString(16)}`;
  throw new PluginArchiveError(`Архив содержит запись неизвестного типа ${shown}.`);
}

/**
 * Нормализация и проверка пути записи.
 *
 * `\` → `/`, отбрасываются `.`-сегменты и пустые сегменты (в т.ч. ведущий
 * `./`); **отказ** — абсолютный путь, `..`-сегмент, windows-диск (`C:`),
 * NUL-байт, слишком длинный путь, пустое имя файла.
 */
function normalizeEntryPath(raw: string, isDir: boolean, maxPathLength: number): string {
  if (raw.includes('\0')) {
    throw new PluginArchiveError('Путь записи архива содержит NUL-байт — архив отклонён.');
  }
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) {
    throw new PluginArchiveError(`Абсолютный путь в архиве: «${raw}» — архив отклонён.`);
  }
  if (/^[A-Za-z]:/.test(unified) || unified.startsWith(':')) {
    throw new PluginArchiveError(
      `Путь с windows-диском в архиве: «${raw}» — архив отклонён.`,
    );
  }
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new PluginArchiveError(
        `Выход за пределы каталога распаковки в архиве: «${raw}» — архив отклонён.`,
      );
    }
    segments.push(segment);
  }
  const rel = segments.join('/');
  if (rel.length > maxPathLength) {
    throw new PluginArchiveError(
      `Путь записи архива слишком длинный (${rel.length} > ${maxPathLength}): «${raw}».`,
    );
  }
  if (!rel && !isDir) {
    throw new PluginArchiveError('Запись архива с пустым именем файла — архив отклонён.');
  }
  return rel;
}

/**
 * Разбор всего tar-потока в записи (с проверками по ходу).
 *
 * Лимиты проверяются **сразу** по заголовку, до чтения данных: иначе запись на
 * 16 МиБ пришлось бы сначала материализовать, а потом отклонить.
 */
function parseTar(tar: Buffer, limits: Required<TarExtractLimits>): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalBytes = 0;
  /** pax-переопределения: глобальные (`g`) и для следующей записи (`x`). */
  let globalFields: PaxFields = {};
  let nextFields: PaxFields = {};
  let nextLongName: string | undefined;

  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + BLOCK_SIZE);
    if (block.length < BLOCK_SIZE || isZeroBlock(block)) break; // конец архива
    offset += BLOCK_SIZE;

    const typeflag = block[156] ?? 0;
    const headerSize = readNumeric(block, 124, 12);

    /** Прочитать данные текущей записи (с выравниванием до блока). */
    const readData = (size: number): Buffer => {
      if (offset + size > tar.length) {
        throw new PluginArchiveError('Архив обрезан: данных записи меньше объявленного размера.');
      }
      const data = tar.subarray(offset, offset + size);
      const padded = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
      offset = Math.min(offset + padded, tar.length);
      return data;
    };

    // pax extended headers: 'x' — для следующей записи, 'g' — глобальные.
    if (typeflag === 0x78 || typeflag === 0x67) {
      const fields = parsePaxRecords(readData(headerSize));
      globalFields = typeflag === 0x67 ? { ...globalFields, ...fields } : globalFields;
      if (typeflag === 0x78) nextFields = fields;
      continue;
    }
    // GNU long name (`././@LongLink`) — имя следующей записи.
    if (typeflag === 0x4c) {
      nextLongName = readData(headerSize).toString('utf-8').replace(/\0[\s\S]*$/, '').trim();
      continue;
    }
    // GNU long linkname — ссылку всё равно отклоним на следующей записи.
    if (typeflag === 0x4b) {
      readData(headerSize);
      continue;
    }

    const type = entryType(typeflag);
    const effective: PaxFields = { ...globalFields, ...nextFields };
    const rawName = readCString(block, 0, 100);
    const rawPrefix = readCString(block, 345, 155);
    const path =
      effective.path ??
      nextLongName ??
      (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    const size = effective.size ?? headerSize;
    nextFields = {};
    nextLongName = undefined;

    const rel = normalizeEntryPath(path, type === 'dir', limits.maxPathLength);

    // Лимиты — до чтения данных записи.
    if (entries.length + 1 > limits.maxFiles) {
      throw new PluginArchiveError(
        `Архив содержит больше записей, чем разрешено (${limits.maxFiles}) — распаковка отклонена.`,
      );
    }
    if (type === 'file') {
      if (size > limits.maxFileBytes) {
        throw new PluginArchiveError(
          `Файл «${rel}» больше допустимого (${size} > ${limits.maxFileBytes} байт) — распаковка отклонена.`,
        );
      }
      totalBytes += size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new PluginArchiveError(
          `Распакованный архив больше допустимого (${totalBytes} > ${limits.maxTotalBytes} байт) — отклонён.`,
        );
      }
    }

    const data = readData(size);
    entries.push({ path: rel, type, size, data });
  }

  return entries;
}

/** Итоговые записи после снятия `stripPrefix` (или `null`, если снять нельзя). */
function applyStripPrefix(
  entries: TarEntry[],
  stripPrefix: string,
): TarEntry[] {
  const prefix = stripPrefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!prefix) return entries;
  const out: TarEntry[] = [];
  for (const entry of entries) {
    // Корень архива («./» / «package/») — пропускаем: каталог создастся по файлам.
    if (entry.path === '') continue;
    if (entry.path === prefix) {
      if (entry.type !== 'dir') {
        throw new PluginArchiveError(
          `Неожиданная раскладка архива: «${prefix}» — файл, а не каталог.`,
        );
      }
      continue;
    }
    if (!entry.path.startsWith(`${prefix}/`)) {
      throw new PluginArchiveError(
        `Неожиданная раскладка архива: запись «${entry.path}» вне ожидаемого каталога «${prefix}/».`,
      );
    }
    out.push({ ...entry, path: entry.path.slice(prefix.length + 1) });
  }
  return out;
}

/** Верхняя граница распакованного tar для `gunzip` (защита от gzip-бомбы). */
function outputLimitOf(limits: Required<TarExtractLimits>): number {
  // Данные + заголовки/выравнивание записей + два нулевых блока + запас.
  return (
    limits.maxTotalBytes +
    limits.maxFiles * (BLOCK_SIZE + 1024) +
    BLOCK_SIZE * 2 +
    4096
  );
}

/**
 * Распаковать `.tar.gz`/`.tgz` (npm-тарбол — с префиксом `package/`) в каталог.
 *
 * @param archive байты архива (gzip).
 * @param opts.limits лимиты (по умолчанию 500 файлов / 16 МиБ файл / 64 МиБ сумма / 1024 символа путь).
 * @param opts.stripPrefix срезать общий префикс (`package` у npm-тарбола); запись вне него — отказ.
 * @param opts.destDir каталог распаковки (по умолчанию — новый `mkdtemp` под `tmp`);
 *   при ошибке созданный **самим** модулем каталог удаляется.
 * @throws PluginArchiveError битый gzip, запрещённый тип записи, небезопасный путь, лимиты.
 */
export async function extractPluginArchive(
  archive: Uint8Array,
  opts: { limits?: TarExtractLimits; stripPrefix?: string; destDir?: string } = {},
): Promise<ExtractedArchive> {
  const limits: Required<TarExtractLimits> = { ...DEFAULT_LIMITS, ...opts.limits };
  const input = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);

  let tar: Buffer;
  try {
    tar = await gunzip(input, { maxOutputLength: outputLimitOf(limits) });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new PluginArchiveError(
        `Распакованный архив превышает предел (${outputLimitOf(limits)} байт) — распаковка отклонена.`,
      );
    }
    throw new PluginArchiveError(
      `Архив не является корректным .tar.gz: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = parseTar(tar, limits);
  const entries = opts.stripPrefix ? applyStripPrefix(parsed, opts.stripPrefix) : parsed;

  const destDir = opts.destDir;
  const createdTemp = destDir === undefined;
  const dir = destDir === undefined ? await mkdtemp(join(tmpdir(), TEMP_PREFIX)) : resolve(destDir);
  const root = resolve(dir);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true });
  };

  try {
    if (!createdTemp) await mkdir(root, { recursive: true });
    const files: string[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.path === '') continue;
      const target = resolve(root, entry.path);
      // Последняя линия защиты: ничего вне destDir.
      if (target !== root && !target.startsWith(rootPrefix)) {
        throw new PluginArchiveError(
          `Путь вне каталога распаковки: «${entry.path}» — архив отклонён.`,
        );
      }
      if (entry.type === 'dir') {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      // Байты как есть: текст и бинарные ассеты (PNG и т.п.) не портятся.
      await writeFile(target, entry.data);
      files.push(entry.path);
      totalBytes += entry.data.length;
    }
    return { dir, files, totalBytes, cleanup };
  } catch (err) {
    // Частично распакованный бандл не оставляем: каталог создавали мы — убираем.
    if (createdTemp) await cleanup().catch(() => undefined);
    throw err;
  }
}
