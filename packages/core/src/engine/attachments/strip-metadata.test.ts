/**
 * ADR-115 §«Приватность»: очистка метаданных на границе отправки
 * (`stripMetadata`). Битая/недописанная структура возвращается как есть —
 * «почистить наполовину» хуже, чем не трогать.
 */
import { describe, it, expect } from 'vitest';
import { stripMetadata } from './strip-metadata.js';

/** JPEG-сегмент: маркер + длина (включая саму длину) + данные. */
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpegWithExif(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe1, Buffer.from('Exif\0\0GPS', 'latin1')),
    jpegSegment(0xe2, Buffer.from('ICC_PROFILE', 'latin1')),
    jpegSegment(0xdb, Buffer.from([1, 2, 3, 4])),
    jpegSegment(0xda, Buffer.alloc(8, 9)),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** PNG-чанк: длина + тип + данные + CRC-заглушка (CRC не проверяется). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function pngWithText(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, 1)),
    pngChunk('tEXt', Buffer.from(text, 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('stripMetadata (ADR-115)', () => {
  it('JPEG: вырезает APP1/APP2, оставляя DQT/SOS-данные и EOI', () => {
    const raw = jpegWithExif();
    const stripped = stripMetadata(raw, 'image/jpeg');

    expect(stripped.length).toBeLessThan(raw.length);
    expect(stripped.includes(Buffer.from('Exif\0\0GPS', 'latin1'))).toBe(false);
    expect(stripped.includes(Buffer.from('ICC_PROFILE', 'latin1'))).toBe(false);
    expect(stripped.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(stripped.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(stripped.includes(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBe(true);
  });

  it('PNG: вырезает tEXt, оставляя IHDR/IEND', () => {
    const stripped = stripMetadata(pngWithText('секретное-гео'), 'image/png');

    expect(stripped.includes(Buffer.from('tEXt', 'latin1'))).toBe(false);
    expect(stripped.includes(Buffer.from('секретное-гео', 'latin1'))).toBe(false);
    expect(stripped.includes(Buffer.from('IHDR', 'latin1'))).toBe(true);
    expect(stripped.includes(Buffer.from('IEND', 'latin1'))).toBe(true);
  });

  it('обрезанный PNG (нет IEND) → оригинал без изменений', () => {
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    expect(stripMetadata(truncated, 'image/png')).toEqual(truncated);
  });

  it('обрезанный JPEG (нет SOS/EOI) и прочие форматы → оригинал', () => {
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xdb, Buffer.from([1, 2, 3, 4])),
    ]);
    expect(stripMetadata(truncated, 'image/jpeg')).toEqual(truncated);
    // WebP/PDF/аудио/видео не разбираются.
    const pdf = Buffer.from('%PDF-1.7\n');
    expect(stripMetadata(pdf, 'application/pdf')).toEqual(pdf);
  });
});
