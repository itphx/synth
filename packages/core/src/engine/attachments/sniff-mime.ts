/**
 * Определение MIME-типа вложения по сигнатуре содержимого (ADR-115 §«API и лимиты»).
 *
 * Заявленный клиентом `Content-Type` — недоверенный: MIME определяется по
 * байтам, заявленный тип используется только как фоллбек, когда сигнатура
 * неизвестна. Новых зависимостей нет (инвариант 12) — распознаются только
 * форматы, которые реально нужны мультимодальному вводу: изображения, PDF,
 * аудио и видео контейнеры.
 */

/** Проверить сигнатуру `prefix` по смещению `offset`. */
function matches(bytes: Buffer, offset: number, prefix: readonly number[]): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
}

/** ASCII-сигнатура по смещению (без учёта регистра). */
function matchesAscii(bytes: Buffer, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  return bytes.subarray(offset, offset + text.length).toString('latin1') === text;
}

/** ISO-BMFF-бренды: общие `ftyp`-типы изображений и видео. */
function ftypBrand(bytes: Buffer): string | undefined {
  if (!matchesAscii(bytes, 4, 'ftyp')) return undefined;
  return bytes.length >= 12 ? bytes.subarray(8, 12).toString('latin1') : undefined;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'M4V ', 'M4VH', 'mp4v',
]);

/**
 * MIME по сигнатуре. `undefined` — сигнатура не распознана (вызывающий берёт
 * заявленный тип, затем `application/octet-stream`).
 */
export function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.length === 0) return undefined;

  // Изображения
  if (matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP')) return 'image/webp';

  // PDF
  if (matchesAscii(bytes, 0, '%PDF-')) return 'application/pdf';

  // ISO-BMFF: HEIC/HEIF и MP4 различаются брендом в `ftyp`.
  const brand = ftypBrand(bytes);
  if (brand !== undefined) {
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (MP4_BRANDS.has(brand)) return 'video/mp4';
  }

  // Аудио
  if (matchesAscii(bytes, 0, 'OggS')) return 'audio/ogg';
  if (matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WAVE')) return 'audio/wav';
  if (matchesAscii(bytes, 0, 'ID3')) return 'audio/mpeg';
  // MPEG-1/2 Audio frame sync (0xFFEx/0xFFFx): маска 0xFFE0.
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg';

  // Видео
  if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';

  // SVG: текстовый формат, сигнатуры нет — распознаём по разметке в начале файла
  // (нужно, чтобы запрет `image/svg+xml` не обходился отсутствием заголовка).
  if (looksLikeSvg(bytes)) return 'image/svg+xml';

  return undefined;
}

/**
 * Похоже ли содержимое на SVG (по первым 4 КиБ, без учёта регистра).
 * SVG запрещён всегда (ADR-115 §«Лимиты и безопасность»): HTML/скрипт внутри
 * картинки — XSS при инлайн-выдаче.
 */
export function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4096).toString('utf-8').trimStart().toLowerCase();
  if (!head.startsWith('<svg') && !head.startsWith('<?xml') && !head.startsWith('<!doctype svg')) {
    return false;
  }
  return head.includes('<svg');
}

/**
 * Нормализовать MIME: нижний регистр, без параметров (`; charset=…`).
 * Пустое/невалидное значение → `undefined`.
 */
export function normalizeMime(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const base = value.split(';')[0]?.trim().toLowerCase();
  if (!base || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) return undefined;
  return base;
}
