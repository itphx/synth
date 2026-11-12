/**
 * Общий читатель файлов для контура исполнения (PROP-135, Ф1/слайс 2).
 *
 * ## Зачем отдельный модуль
 *
 * Чтение содержимого файла нужно **двум** сторонам:
 *
 * - **control plane** — тул `read_file` (локально или через порт);
 * - **исполнитель** — роуты `/fs/read-text`, `/fs/sniff`, `/fs/read-bytes`
 *   (в split-топологии рабочий каталог живёт там, и читать его в control
 *   plane нельзя).
 *
 * Правила чтения (потоковое чтение через `readline`, нумерация строк
 * `N: текст`, кап длины строки, кап объёма вывода, детект бинаря, MIME по
 * сигнатуре) должны быть **одними и теми же** — иначе файл, прочитанный
 * локально и по проводу, выглядел бы по-разному, а модель получала бы
 * разный текст в зависимости от топологии.
 *
 * Поэтому чтение вынесено сюда, а исполнитель зовёт **этот же** код
 * (точечный runtime-импорт `@itphx/synth-core` — как `createSshEnv` в
 * `packages/executor/src/secrets.ts`).
 *
 * ## Границы
 *
 * - **Пути — абсолютные** (резолвит вызывающий: тул — от `workingDir`,
 *   исполнитель — от `cwd` своего workspace);
 * - **ошибки — сырые** (`node:fs`): приведение к типизированным
 *   `FsPathError` делает **граница порта** (inline-реализация) и
 *   **исполнитель** (свои причины на проводе). Так поведение
 *   `sniffBinary` (которым пользуются `write_file`/`patch`/превью) не
 *   меняется: там ожидается исключение ФС, а не `FsPathError`;
 * - **формат вывода принадлежит домену**: строки уже готовые
 *   (`N: текст`, нумерация исходная 1-based) — вызывающий не пересобирает
 *   их заново.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { t as sm } from '../engine/system-messages.js';
import { sniffMime } from '../engine/attachments/sniff-mime.js';
import { MAX_LINE_LENGTH, clampLine } from '../engine/tools/line-limits.js';
import { FsPathError } from './ports/execution-fs.js';
import type {
  FsBytesResult,
  FsRawTextResult,
  FsSniffResult,
  FsTextOptions,
  FsTextPage,
} from './ports/execution-fs.js';

/**
 * Пределы чтения — паритет с opencode
 * (`packages/core/src/tool/read-filesystem.ts`: `MAX_READ_LINES`/`MAX_READ_BYTES`/
 * `MAX_LINE_LENGTH`). Каталог читается теми же пределами (строк = записей).
 */
export const MAX_READ_LINES = 2_000;

/** Жёсткий кап объёма вывода текста, байт (UTF-8). */
export const MAX_READ_BYTES = 50 * 1024;

/** Сколько первых байт смотрим, чтобы отличить бинарь от текста. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Максимальная длина одной возвращаемой строки — общая константа с
 * поисковыми тулами (`engine/tools/line-limits.ts`).
 */
export { MAX_LINE_LENGTH };

/** Доля непечатных байт, при которой файл считается бинарным. */
const BINARY_NON_PRINTABLE_RATIO = 0.3;

/**
 * Похож ли буфер на бинарный: NUL-байт или высокая доля непечатных символов.
 * Байты ≥ 0x80 — это UTF-8 (кириллица и т.п.), они печатные.
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of buf) {
    if (byte === 0) return true;
    // \t (9), \n (10), \r (13) — обычный текст
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) nonPrintable++;
  }
  return nonPrintable / buf.length > BINARY_NON_PRINTABLE_RATIO;
}

/**
 * Первые байты файла: признак «бинарь» **и** MIME по сигнатуре (ADR-115).
 *
 * Один проход вместо двух: `read_file` по тем же байтам решает, читать файл
 * как текст, отказать («бинарь») или принять как медиа-вложение (картинка/PDF).
 * MIME — тем же детектором, что у сервиса вложений
 * (`attachments/sniff-mime.ts`), второго определения MIME в ядре нет.
 *
 * Ошибка чтения (пути нет, нет доступа) — **сырая** ошибка `node:fs`:
 * приведение к `FsPathError` делает граница порта.
 */
export async function sniffFileHeadFromFile(
  filePath: string,
  maxBytes: number = BINARY_SNIFF_BYTES,
): Promise<FsSniffResult> {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    const head = buf.subarray(0, bytesRead);
    return { binary: looksBinary(head), mime: sniffMime(head) };
  } finally {
    await handle.close();
  }
}

/**
 * Первые байты файла → признак «это бинарь».
 *
 * Тонкая обёртка над `sniffFileHeadFromFile`: ею пользуются тулы записи
 * (`write_file`/`edit_file`/`patch`) и превью файла — им нужен только
 * признак «бинарь», без MIME.
 */
export async function sniffBinary(filePath: string): Promise<boolean> {
  return (await sniffFileHeadFromFile(filePath)).binary;
}

/** Обрезка слишком длинной строки с маркером (в вывод не уходит «простыня»). */
function clampReadLine(line: string): string {
  return clampLine(line, sm('fsread.line_truncated'));
}

/**
 * Страница текстового файла: читаем потоком через `readline` — в память не
 * поднимается всё содержимое даже большого файла. `offset` — 0-based,
 * нумерация строк в выводе — исходная 1-based (первая строка страницы имеет
 * номер `offset + 1`).
 *
 * `totalLines` считаем тем же проходом до EOF (счётчик, без хранения строк):
 * метаданные честно сообщают размер файла, а память остаётся постоянной.
 *
 * `limit`/`maxBytes` — потолки страницы; не заданы — дефолты модуля.
 */
export async function readTextPageFromFile(
  filePath: string,
  opts: FsTextOptions = {},
): Promise<FsTextPage> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? MAX_READ_LINES);
  const maxBytes = Math.max(1, opts.maxBytes ?? MAX_READ_BYTES);

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  let lineNo = 0;
  let totalLines = 0;
  let bytes = 0;
  let truncated = false;

  try {
    for await (const raw of rl) {
      lineNo += 1;
      totalLines = lineNo;
      if (lineNo <= offset) continue;
      if (lines.length >= limit || bytes >= maxBytes) {
        truncated = true;
        continue;
      }
      const text = clampReadLine(raw);
      const line = `${lineNo}: ${text}`;
      const size = Buffer.byteLength(line, 'utf-8') + (lines.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        truncated = true;
        continue;
      }
      lines.push(line);
      bytes += size;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { lines, totalLines, truncated, bytes };
}

/**
 * Байты файла (base64) с жёстким лимитом размера.
 *
 * Размер известен **до** чтения (`stat`): файл больше `maxBytes` не
 * читается вовсе — ни память, ни канал не тратятся на заведомо лишнее.
 * Превышение → `FsPathError` с кодом `too_large` (сообщение содержит лимит).
 */
export async function readBytesFromFile(
  filePath: string,
  maxBytes: number,
): Promise<FsBytesResult> {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new FsPathError(
      'too_large',
      filePath,
      `файл больше лимита: ${info.size} байт (лимит ${maxBytes} байт)`,
    );
  }
  const data = await readFile(filePath);
  return { dataBase64: data.toString('base64'), size: data.length };
}

/**
 * Текст файла **как есть** (UTF-8, без нумерации строк) — PROP-135, Ф2.
 *
 * Нужен тулам правки (`edit_file`/`patch`): они сопоставляют правку с
 * **точным** текстом файла, а `readTextPageFromFile` отдаёт готовые строки
 * вывода (`N: текст`) — для этого не годится.
 *
 * Размер известен **до** чтения (`stat`): файл больше `maxBytes` не читается
 * вовсе — превышение → `FsPathError` с кодом `too_large`.
 */
export async function readRawTextFromFile(
  filePath: string,
  maxBytes: number,
): Promise<FsRawTextResult> {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new FsPathError(
      'too_large',
      filePath,
      `файл больше лимита: ${info.size} байт (лимит ${maxBytes} байт)`,
    );
  }
  const text = await readFile(filePath, 'utf-8');
  return { text, size: info.size };
}

/**
 * SHA-256 файла (hex) — **потоком** (PROP-135, Ф3).
 *
 * Файл целиком в память не поднимается: хэш считается по мере чтения
 * (`createHash` + `createReadStream`) — файлы бывают крупными (вложения).
 *
 * Хэш считается **на точке исполнения**: там, где лежит файл (в
 * split-топологии — на исполнителе). Ошибка чтения — **сырая** ошибка
 * `node:fs`: приведение к типизированным `FsPathError` делает граница порта
 * (inline-реализация) и исполнитель (свои причины на проводе).
 */
export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
