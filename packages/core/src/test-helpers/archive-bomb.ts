/**
 * Сборка «вредных» tar.gz для тестов лимитов разбора архива (ADR-091).
 *
 * Обычный `writeTarGz` пишет честные заголовки, поэтому archive-«бомбу» (заголовок
 * обещает гигабайты, а данных — килобайты) нужно собрать вручную: ustar-заголовок
 * с заданным **объявленным** размером записи + блок данных.
 *
 * Контрольную сумму заголовка пересчитывать не нужно — читатель архива её не
 * проверяет (совместимость с tar-архивами других инструментов не требуется).
 */
import { gzipSync } from 'node:zlib';

/** Сырой ustar-заголовок (512 байт) с объявленным размером записи. */
export function rawTarHeader(path: string, size: number, typeflag = '0'): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(path, 0, 100, 'utf-8');
  buf.write('000644\0', 100, 8, 'ascii');
  buf.write('000000\0', 108, 8, 'ascii');
  buf.write('000000\0', 116, 8, 'ascii');
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  buf.write('00000000000\0', 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

/** Блок данных, дополненный до границы 512 байт (как в tar). */
export function tarContent(data: Buffer): Buffer {
  const padding = (512 - (data.length % 512)) % 512;
  return Buffer.concat([data, Buffer.alloc(padding)]);
}

/**
 * Собирает gzip-архив с одной записью, чей заголовок объявляет `declaredSize`
 * байт (в данных — `actualBytes`): распаковка такого архива «раздувается» до
 * объявленного объёма.
 */
export function buildBombArchive(declaredSize: number, actualBytes = 8): Buffer {
  const header = rawTarHeader('workspace/huge.bin', declaredSize);
  return gzipSync(Buffer.concat([header, tarContent(Buffer.alloc(actualBytes))]));
}
