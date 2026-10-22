/**
 * tar-фикстуры для тестов слоя плагинов (PROP-090): сборка ustar-архивов
 * **без зависимостей** — тем же принципом, что и разбор в
 * `engine/plugins/archive.ts` (новых пакетов не вводим, инвариант 12).
 *
 * Фикстуры собираются в тесте, а не лежат бинарями в репозитории: каждый кейс
 * явно показывает, что в архиве (симлинк, `../evil`, pax-заголовок), и меняется
 * одной строкой.
 */
import { gzipSync } from 'node:zlib';

/** Размер tar-блока. */
const BLOCK = 512;

/** Запись для сборки тестового tar. */
export interface TarFixtureEntry {
  name: string;
  /** typeflag как в ustar: `0`/`\0` — файл, `5` — каталог, `2` — симлинк, `1` — hardlink, `x` — pax, `L` — GNU long name, `6` — FIFO. */
  type?: string;
  content?: string | Buffer;
  linkname?: string;
}

/** Записать строку в поле заголовка (UTF-8, с усечением по длине поля). */
function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(buf, offset, 0, length);
}

/** Собрать ustar-заголовок (512 байт) с контрольной суммой. */
function buildHeader(entry: TarFixtureEntry, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const type = entry.type ?? '0';
  const isDir = type === '5';
  writeString(buf, entry.name, 0, 100);
  writeString(buf, isDir ? '0000755' : '0000644', 100, 8);
  writeString(buf, '0000000', 108, 8);
  writeString(buf, '0000000', 116, 8);
  writeString(buf, size.toString(8).padStart(11, '0'), 124, 12);
  writeString(buf, '00000000000', 136, 12);
  buf.write('        ', 148, 8, 'ascii');
  buf.write(type, 156, 1, 'ascii');
  if (entry.linkname) writeString(buf, entry.linkname, 157, 100);
  writeString(buf, 'ustar\0', 257, 6);
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/** Собрать tar (без сжатия) из набора записей. */
export function buildTar(entries: TarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content === undefined ? Buffer.alloc(0) : Buffer.from(entry.content);
    chunks.push(buildHeader(entry, content.length));
    if (content.length > 0) {
      chunks.push(content);
      const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // два нулевых блока — конец архива
  return Buffer.concat(chunks);
}

/** Собрать `.tar.gz` из набора записей. */
export function buildTarGz(entries: TarFixtureEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

/** pax-запись `<len> <key>=<value>\n` (len включает и себя, и перевод строки). */
export function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) {
    length = String(length).length + body.length;
  }
  return Buffer.from(`${length}${body}`, 'utf-8');
}
