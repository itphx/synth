/**
 * Вычищение метаданных из изображений перед записью в blob-хранилище
 * (ADR-115 §«Лимиты и безопасность»: EXIF/IPTC не должны уезжать провайдеру).
 *
 * Свой минимальный парсер без зависимостей (инвариант 12): JPEG — удаление
 * сегментов `APP1` (`FFE1`, EXIF/XMP) и `APP2` (`FFE2`, ICC/IPTC); PNG —
 * удаление чанков `eXIf`, `tEXt`, `iTXt`, `zTXt`. Остальные форматы (WebP,
 * GIF, HEIC, PDF, аудио/видео) не разбираются — байты остаются как есть:
 * «вычистить наполовину» хуже, чем не трогать (порча файла).
 */

/** Маркер начала сегмента JPEG. */
const JPEG_MARKER = 0xff;
/** Start of Scan — с него начинаются энтропийно сжатые данные (дальше не разбираем). */
const JPEG_SOS = 0xda;
/** Start of Image. */
const JPEG_SOI = 0xd8;
/** End of Image. */
const JPEG_EOI = 0xd9;
/** Сегменты, которые вырезаем (APP1 — EXIF/XMP, APP2 — ICC/IPTC). */
const JPEG_DROP_MARKERS = new Set([0xe1, 0xe2]);

/** PNG-сигнатура (8 байт). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG-чанки с метаданными (текст/EXIF). */
const PNG_DROP_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
/** Конец PNG (`IEND`). */
const PNG_END_CHUNK = 'IEND';

/**
 * Удалить метаданные из поддерживаемых форматов. Неподдерживаемый/битый файл
 * возвращается без изменений (никогда не бросает).
 */
export function stripMetadata(bytes: Buffer, mime: string): Buffer {
  try {
    if (mime === 'image/jpeg') return stripJpegMetadata(bytes);
    if (mime === 'image/png') return stripPngMetadata(bytes);
    return bytes;
  } catch {
    return bytes;
  }
}

/**
 * JPEG: пересобрать файл без сегментов `APP1`/`APP2`.
 *
 * Формат: `SOI` (`FFD8`), затем сегменты `FF <marker> <len:BE16> <payload>`;
 * `SOS` (`FFDA`) — конец заголовков, дальше сжатые данные до `EOI` (`FFD9`),
 * они копируются как есть. Битый файл → исходные байты.
 */
function stripJpegMetadata(bytes: Buffer): Buffer {
  if (bytes.length < 4 || bytes[0] !== JPEG_MARKER || bytes[1] !== JPEG_SOI) return bytes;

  const out: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== JPEG_MARKER) return bytes; // не маркер — структура не наша
    const marker = bytes[offset + 1] ?? 0;

    // Заполняющие байты `FF FF …` допустимы.
    if (marker === JPEG_MARKER) {
      out.push(bytes.subarray(offset, offset + 1));
      offset += 1;
      continue;
    }

    // Маркеры без длины: EOI/временные.
    if (marker === JPEG_EOI || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }

    if (offset + 3 >= bytes.length) return bytes;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return bytes;

    if (marker === JPEG_SOS) {
      // Заголовок SOS копируем вместе со сжатыми данными до конца.
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }

    if (!JPEG_DROP_MARKERS.has(marker)) {
      out.push(bytes.subarray(offset, offset + 2 + length));
    }
    offset += 2 + length;
  }

  return Buffer.concat(out);
}

/**
 * PNG: пересобрать файл без текстовых/EXIF-чанков.
 *
 * Формат: сигнатура, затем чанки `len:BE32 type:4 data crc:4`. Удаляются
 * `eXIf`/`tEXt`/`iTXt`/`zTXt`/`tIME`; `IEND` копируется вместе с хвостом.
 * Битый файл → исходные байты.
 */
function stripPngMetadata(bytes: Buffer): Buffer {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return bytes;

  const out: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const total = 12 + length; // len + type + data + crc
    if (offset + total > bytes.length) return bytes;

    const chunk = bytes.subarray(offset, offset + total);
    if (!PNG_DROP_CHUNKS.has(type)) out.push(chunk);
    offset += total;

    if (type === PNG_END_CHUNK) {
      // После IEND данных быть не должно, но если есть — сохраняем как есть.
      if (offset < bytes.length) out.push(bytes.subarray(offset));
      break;
    }
  }

  return Buffer.concat(out);
}
