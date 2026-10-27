/**
 * Извлечение текста и встроенных изображений из office-документов.
 *
 * Назначение: разобрать приложенный office-файл (docx/pptx/xlsx/odt/odp/ods)
 * в текст и картинки — без внешних сервисов и без тяжёлых зависимостей.
 * Архив распаковывается через `fflate`, XML разбирается минимальным парсером
 * на регулярках (собственных зависимостей модуль не добавляет).
 *
 * Границы (все квоты собраны в `DOCUMENT_QUOTAS`):
 * - архив на диске ≤ 20 МБ, суммарный распакованный объём ≤ 100 МБ;
 * - записей в архиве ≤ 5000, одна запись ≤ 25 МБ, XML-запись ≤ 8 МБ;
 * - встроенных изображений ≤ 50 (по 20 МБ каждый и 40 МБ суммарно) —
 *   лишние изображения молча пропускаются, ошибка не выбрасывается;
 * - текст обрезается до 500 000 символов, в конец добавляется пометка
 *   «[Текст документа обрезан]», а в результат ставится `truncated: true`.
 *
 * Формат определяется **только именем файла** (расширением) — сигнатура
 * архива и содержимое на выбор формата не влияют.
 *
 * Ошибки — `DocumentExtractError` с кодом:
 * - `unsupported` — расширение не office;
 * - `invalid_archive` — байты не читаются как ZIP;
 * - `not_a_document` — ZIP корректен, но office-частей в нём нет;
 * - `too_large` — превышены квоты размера (архив или распакованный объём);
 * - `too_many_entries` — записей больше, чем разрешено;
 * - `entry_too_large` — отдельная запись больше, чем разрешено.
 */

import { unzipSync, type UnzipFileInfo, type Unzipped } from 'fflate';

/** Квоты разбора документа: размеры, число записей, изображения, длина текста. */
export const DOCUMENT_QUOTAS = {
  maxArchiveBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxEntryBytes: 25 * 1024 * 1024,
  maxXmlEntryBytes: 8 * 1024 * 1024,
  maxEntries: 5000,
  maxEmbeddedImages: 50,
  maxEmbeddedImageBytes: 20 * 1024 * 1024,
  maxEmbeddedImagesBytes: 40 * 1024 * 1024,
  maxExtractedTextChars: 500_000,
} as const;

export type DocumentExtractErrorCode =
  | 'not_a_document'
  | 'too_large'
  | 'too_many_entries'
  | 'entry_too_large'
  | 'invalid_archive'
  | 'unsupported';

const ERROR_MESSAGES: Record<DocumentExtractErrorCode, string> = {
  not_a_document: 'Файл не является документом поддерживаемого формата',
  too_large: 'Документ превышает допустимый размер',
  too_many_entries: 'В документе слишком много файлов',
  entry_too_large: 'В документе есть слишком большой файл',
  invalid_archive: 'Не удалось прочитать архив документа',
  unsupported: 'Формат документа не поддерживается',
};

/** Ошибка разбора документа: код машиночитаемый, сообщение — человекочитаемое. */
export class DocumentExtractError extends Error {
  readonly code: DocumentExtractErrorCode;

  constructor(code: DocumentExtractErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'DocumentExtractError';
    this.code = code;
  }
}

/** Расширения, которые разбираются модулем. */
export const OFFICE_EXTENSIONS: readonly string[] = ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'];

/** Изображение, извлечённое из документа. */
export interface ExtractedDocumentImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Результат разбора документа. */
export interface ExtractedDocument {
  text: string;
  images: ExtractedDocumentImage[];
  truncated: boolean;
}

/** MIME-типы по расширению изображения. */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Пометка об обрезанном тексте. */
const TRUNCATION_NOTICE = '\n\n[Текст документа обрезан]\n';

/** Предел пробелов в одном элементе ODF (`text:s`). */
const ODF_MAX_SPACES = 100;

const DOCX_DOCUMENT_PATH = 'word/document.xml';
const PPTX_SLIDE_PATTERN = /^ppt\/slides\/slide\d+\.xml$/i;
const XLSX_WORKSHEET_PATTERN = /^xl\/worksheets\/sheet\d+\.xml$/i;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index + 1).toLowerCase();
};

const basenameOf = (path: string): string => path.replace(/\\/g, '/').split('/').pop() ?? path;

/** Декодирование XML-сущностей (числовые идёт первыми, `&amp;` — последним). */
const decodeXml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => decodeCodePoint(code, 16))
    .replace(/&#([0-9]+);/g, (_, code: string) => decodeCodePoint(code, 10))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const decodeCodePoint = (code: string, radix: number): string => {
  const value = Number.parseInt(code, radix);
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return '�';
  }
  return String.fromCodePoint(value);
};

/** Значение атрибута в открывающем теге. */
const attribute = (tag: string, name: string): string | undefined => {
  const escaped = escapeRegExp(name);
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return undefined;
  const value = decodeXml(match[1] ?? match[2] ?? '');
  return value === '' ? undefined : value;
};

/**
 * Блоки элемента: парные (`<t>…</t>`) и самозакрывающиеся (`<t/>`).
 * Вложенность одноимённых элементов не разбирается — для нужных форматов
 * (абзацы, строки, ячейки) вложенности одноимённых элементов не бывает.
 */
const elementBlocks = (source: string, tag: string): string[] => {
  const escaped = escapeRegExp(tag);
  const pattern = new RegExp(
    `<${escaped}(?=[\\s/>])[^>]*\\/>|<${escaped}(?=[\\s/>])(?![^>]*\\/>)[^>]*>[\\s\\S]*?<\\/${escaped}>`,
    'gi',
  );
  return Array.from(source.matchAll(pattern), (match) => match[0]);
};

const textDecoder = new TextDecoder();

const readText = (archive: Unzipped, path: string): string => {
  const bytes = archive[path];
  return bytes ? textDecoder.decode(bytes) : '';
};

/** Нормализация пути внутри архива (без `..` и обратных слэшей). */
const normalizeArchivePath = (path: string): string | undefined => {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
};

/** Путь к файлу связей (`word/document.xml` → `word/_rels/document.xml.rels`). */
const relationshipsPath = (sourcePath: string): string => {
  const index = sourcePath.lastIndexOf('/');
  const directory = index === -1 ? '' : sourcePath.slice(0, index + 1);
  const filename = sourcePath.slice(index + 1);
  return `${directory}_rels/${filename}.rels`;
};

/** Карта «Id связи → Target» из файла связей. */
const parseRelationships = (archive: Unzipped, sourcePath: string): Map<string, string> => {
  const result = new Map<string, string>();
  const source = readText(archive, relationshipsPath(sourcePath));
  for (const match of source.matchAll(/<Relationship\b[^>]*?\/?\s*>/gi)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (!id || !target) continue;
    result.set(id, target);
  }
  return result;
};

/** Разрешение цели связи относительно исходного файла. */
const resolveArchivePath = (sourcePath: string, target: string): string | undefined => {
  if (!target) return undefined;
  if (target.startsWith('/')) return normalizeArchivePath(target.slice(1));
  const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
  return normalizeArchivePath(`${directory}${target}`);
};

/** Распаковка архива с проверкой квот на лету (в `filter`). */
const readArchive = (bytes: Uint8Array): Unzipped => {
  if (bytes.byteLength > DOCUMENT_QUOTAS.maxArchiveBytes) {
    throw new DocumentExtractError('too_large');
  }

  let entries = 0;
  let uncompressedBytes = 0;

  try {
    return unzipSync(bytes, {
      filter: (info: UnzipFileInfo) => {
        entries += 1;
        uncompressedBytes += info.originalSize;
        if (entries > DOCUMENT_QUOTAS.maxEntries) {
          throw new DocumentExtractError('too_many_entries');
        }
        if (info.originalSize > DOCUMENT_QUOTAS.maxEntryBytes) {
          throw new DocumentExtractError('entry_too_large');
        }
        if (/\.(?:xml|rels)$/i.test(info.name) && info.originalSize > DOCUMENT_QUOTAS.maxXmlEntryBytes) {
          throw new DocumentExtractError('entry_too_large');
        }
        if (uncompressedBytes > DOCUMENT_QUOTAS.maxUncompressedBytes) {
          throw new DocumentExtractError('too_large');
        }
        return isWantedEntry(info.name);
      },
    });
  } catch (error) {
    if (error instanceof DocumentExtractError) throw error;
    throw new DocumentExtractError('invalid_archive');
  }
};

/** Оставляем в архиве только XML, связи и изображения — остальное не нужно. */
const isWantedEntry = (name: string): boolean => {
  const extension = extensionOf(name);
  return extension === 'xml' || extension === 'rels' || extension in IMAGE_MIMES;
};

/** Инлайновый текст OOXML: `w:t`/`a:t`, табуляции и переносы. */
const OOXML_INLINE_PATTERN =
  /<(?:w:t|a:t)(?=[\s/>])(?![^>]*\/>)[^>]*>([\s\S]*?)<\/(?:w:t|a:t)>|<(?:w:tab|a:tab)(?=[\s/>])[^>]*\/?>|<(?:w:br|a:br|w:cr)(?=[\s/>])[^>]*\/?>/gi;

const ooxmlInlineText = (block: string): string => {
  const pieces: string[] = [];
  for (const match of block.matchAll(OOXML_INLINE_PATTERN)) {
    const captured = match[1];
    if (captured !== undefined) {
      pieces.push(decodeXml(captured.replace(/<[^>]+>/g, '')));
      continue;
    }
    pieces.push(/tab/i.test(match[0]) ? '\t' : '\n');
  }
  return pieces.join('');
};

/** Абзацы и таблицы docx — в порядке документа; ячейки таблицы через `\t`. */
const docxText = (archive: Unzipped): string => {
  const documentXml = readText(archive, DOCX_DOCUMENT_PATH);
  const body = elementBlocks(documentXml, 'w:body')[0] ?? documentXml;
  const blocks: string[] = [];

  const pattern = /<w:tbl(?=[\s/>])(?![^>]*\/>)[^>]*>[\s\S]*?<\/w:tbl>|<w:p(?=[\s/>])[^>]*\/>|<w:p(?=[\s/>])(?![^>]*\/>)[^>]*>[\s\S]*?<\/w:p>/gi;

  for (const match of body.matchAll(pattern)) {
    const block = match[0];
    if (/^<w:tbl/i.test(block)) {
      blocks.push(...docxTableRows(block));
      continue;
    }
    const text = ooxmlInlineText(block).trim();
    if (text) blocks.push(text);
  }

  return blocks.join('\n');
};

const docxTableRows = (table: string): string[] => {
  const rows: string[] = [];
  for (const row of elementBlocks(table, 'w:tr')) {
    const cells = elementBlocks(row, 'w:tc').map((cell) => docxCellText(cell));
    const line = cells.join('\t');
    if (line.trim()) rows.push(line);
  }
  return rows;
};

const docxCellText = (cell: string): string =>
  elementBlocks(cell, 'w:p')
    .map((paragraph) => ooxmlInlineText(paragraph).trim())
    .filter(Boolean)
    .join(' ');

/** Слайды pptx — по числу в имени файла, между слайдами пустая строка. */
const pptxText = (archive: Unzipped): string => {
  const slides = Object.keys(archive)
    .filter((path) => PPTX_SLIDE_PATTERN.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right));

  const chunks = slides.map((slide) => {
    const slideXml = readText(archive, slide);
    const paragraphs = elementBlocks(slideXml, 'a:p')
      .map((paragraph) => ooxmlInlineText(paragraph).trim())
      .filter(Boolean);
    if (paragraphs.length > 0) return paragraphs.join('\n');
    const fallback = Array.from(
      slideXml.matchAll(/<a:t(?=[\s/>])(?![^>]*\/>)[^>]*>([\s\S]*?)<\/a:t>/gi),
      (match) => decodeXml(match[1].replace(/<[^>]+>/g, '')),
    )
      .filter(Boolean)
      .join(' ');
    return fallback;
  });

  return chunks.filter(Boolean).join('\n\n');
};

const slideNumber = (path: string): number => Number(path.match(/(\d+)(?=\.xml$)/)?.[1] ?? 0);

/** Листы xlsx: имя — из `xl/workbook.xml`, значения — через `\t`. */
const xlsxText = (archive: Unzipped): string => {
  const sharedStrings = xlsxSharedStrings(archive);
  const sheets = xlsxSheets(archive);

  const chunks = sheets.map((sheet) => {
    const rows = xlsxRows(readText(archive, sheet.path), sharedStrings);
    return [sheet.name, ...rows].join('\n');
  });

  return chunks.filter((chunk) => chunk.trim()).join('\n\n');
};

const xlsxSharedStrings = (archive: Unzipped): string[] =>
  elementBlocks(readText(archive, 'xl/sharedStrings.xml'), 'si').map((item) =>
    Array.from(item.matchAll(/<t(?=[\s/>])(?![^>]*\/>)[^>]*>([\s\S]*?)<\/t>/gi), (match) =>
      decodeXml(match[1].replace(/<[^>]+>/g, '')),
    ).join(''),
  );

interface XlsxSheet {
  name: string;
  path: string;
}

const xlsxSheets = (archive: Unzipped): XlsxSheet[] => {
  const workbookXml = readText(archive, 'xl/workbook.xml');
  const relationships = parseRelationships(archive, 'xl/workbook.xml');
  const sheets: XlsxSheet[] = [];

  for (const match of workbookXml.matchAll(/<sheet\b[^>]*?\/?\s*>/gi)) {
    const name = attribute(match[0], 'name');
    const relationshipId = attribute(match[0], 'r:id');
    const target = relationshipId ? relationships.get(relationshipId) : undefined;
    const path = target ? resolveArchivePath('xl/workbook.xml', target) : undefined;
    if (!path) continue;
    sheets.push({ name: name ?? basenameOf(path).replace(/\.xml$/i, ''), path });
  }

  if (sheets.length > 0) return sheets;

  // Запасной путь: листы берём по именам файлов (`sheetN`).
  return Object.keys(archive)
    .filter((path) => XLSX_WORKSHEET_PATTERN.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
    .map((path) => ({ name: basenameOf(path).replace(/\.xml$/i, ''), path }));
};

const xlsxColumnIndex = (letters: string): number => {
  let result = 0;
  for (const character of letters.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
};

const xlsxRows = (worksheetXml: string, sharedStrings: string[]): string[] => {
  const rows: string[] = [];
  for (const rowXml of elementBlocks(worksheetXml, 'row')) {
    const values: string[] = [];
    let nextColumn = 0;
    for (const match of rowXml.matchAll(
      /<c(?=[\s/>])[^>]*\/>|<c(?=[\s/>])(?![^>]*\/>)[^>]*>[\s\S]*?<\/c>/gi,
    )) {
      const cell = match[0];
      const openTag = cell.match(/^<c\b[^>]*>/i)?.[0] ?? '';
      const reference = attribute(openTag, 'r');
      const columns = reference?.match(/^([a-z]+)[0-9]+$/i);
      const column = columns ? xlsxColumnIndex(columns[1] ?? '') : nextColumn;
      while (nextColumn < column) {
        values.push('');
        nextColumn += 1;
      }
      values.push(xlsxCellValue(cell, sharedStrings));
      nextColumn = column + 1;
    }
    const line = values.join('\t');
    if (line.trim()) rows.push(line);
  }
  return rows;
};

const xlsxCellValue = (cell: string, sharedStrings: string[]): string => {
  const openTag = cell.match(/^<c\b[^>]*>/i)?.[0] ?? '';
  const type = attribute(openTag, 't');
  if (type === 'inlineStr') {
    return Array.from(cell.matchAll(/<t(?=[\s/>])(?![^>]*\/>)[^>]*>([\s\S]*?)<\/t>/gi), (match) =>
      decodeXml(match[1].replace(/<[^>]+>/g, '')),
    ).join('');
  }
  const raw = cell.match(/<v(?=[\s/>])(?![^>]*\/>)[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '';
  if (type === 's') return sharedStrings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return decodeXml(raw);
};

/** Пробелы ODF (`text:s`) — по атрибуту `text:c`, не больше 100 на элемент. */
const odfSpaces = (tag: string): string => {
  const raw = attribute(tag, 'text:c');
  if (!raw) return ' ';
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count <= 0) return ' ';
  if (count <= ODF_MAX_SPACES) return ' '.repeat(count);
  return `${' '.repeat(ODF_MAX_SPACES)}[опущено ещё ${count - ODF_MAX_SPACES} пробелов]`;
};

/** Инлайновый текст ODF: `text:s` — пробелы, `text:tab` — табуляция, `text:line-break` — перенос. */
const odfInlineText = (source: string): string =>
  source
    .replace(/<text:tab(?=[\s/>])[^>]*>/gi, '\t')
    .replace(/<text:line-break(?=[\s/>])[^>]*>/gi, '\n')
    .replace(/<text:s(?=[\s/>])[^>]*>/gi, (tag) => odfSpaces(tag))
    .replace(/<[^>]+>/g, '');

const ODF_PARAGRAPH_PATTERN =
  /<text:(?:p|h)(?=[\s/>])(?![^>]*\/>)[^>]*>[\s\S]*?<\/text:(?:p|h)>|<text:(?:p|h)(?=[\s/>])[^>]*\/>/gi;

const odfParagraphLines = (source: string): string[] =>
  Array.from(source.matchAll(ODF_PARAGRAPH_PATTERN), (match) =>
    decodeXml(odfInlineText(match[0])).trim(),
  ).filter(Boolean);

/** Текстовый документ ODF (odt): абзацы и заголовки — отдельные строки. */
const odtText = (archive: Unzipped): string =>
  odfParagraphLines(readText(archive, 'content.xml')).join('\n');

/** Презентация ODF (odp): страницы разделены пустой строкой. */
const odpText = (archive: Unzipped): string => {
  const contentXml = readText(archive, 'content.xml');
  const pages = elementBlocks(contentXml, 'draw:page');
  if (pages.length === 0) return odfParagraphLines(contentXml).join('\n');
  return pages
    .map((page) => odfParagraphLines(page).join('\n'))
    .filter(Boolean)
    .join('\n\n');
};

/** Таблица ODF (ods): ячейки через `\t`, строки — через `\n`. */
const odsText = (archive: Unzipped): string => {
  const contentXml = readText(archive, 'content.xml');
  const tables = elementBlocks(contentXml, 'table:table');
  if (tables.length === 0) return odfParagraphLines(contentXml).join('\n');

  const lines: string[] = [];
  for (const table of tables) {
    for (const row of elementBlocks(table, 'table:table-row')) {
      const cells = elementBlocks(row, 'table:table-cell').map((cell) =>
        odfParagraphLines(cell).join(' '),
      );
      const line = cells.join('\t');
      if (line.trim()) lines.push(line);
    }
  }
  return lines.join('\n');
};

/** Изображения docx: по связям `r:embed` и все `word/media/*`. */
const docxImagePaths = (archive: Unzipped): string[] => {
  const documentXml = readText(archive, DOCX_DOCUMENT_PATH);
  const relationships = parseRelationships(archive, DOCX_DOCUMENT_PATH);
  const paths: string[] = [];

  for (const match of documentXml.matchAll(/r:(?:embed|link|id)\s*=\s*"([^"]+)"/gi)) {
    const target = relationships.get(match[1] ?? '');
    if (!target) continue;
    const resolved = resolveArchivePath(DOCX_DOCUMENT_PATH, target);
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }

  for (const path of Object.keys(archive)) {
    if (/^word\/media\//i.test(path) && !paths.includes(path)) paths.push(path);
  }

  return paths;
};

const mediaPaths = (archive: Unzipped, pattern: RegExp): string[] =>
  Object.keys(archive)
    .filter((path) => pattern.test(path))
    .sort((left, right) => left.localeCompare(right));

/** Сбор изображений с проверкой квот: лишние молча пропускаются. */
const collectImages = (archive: Unzipped, paths: string[]): ExtractedDocumentImage[] => {
  const images: ExtractedDocumentImage[] = [];
  const usedNames = new Set<string>();
  let totalBytes = 0;

  for (const path of paths) {
    if (images.length >= DOCUMENT_QUOTAS.maxEmbeddedImages) break;
    const bytes = archive[path];
    if (!bytes) continue;
    const mime = IMAGE_MIMES[extensionOf(path)];
    if (!mime) continue;
    if (bytes.byteLength > DOCUMENT_QUOTAS.maxEmbeddedImageBytes) continue;
    if (totalBytes + bytes.byteLength > DOCUMENT_QUOTAS.maxEmbeddedImagesBytes) continue;
    totalBytes += bytes.byteLength;
    images.push({ name: uniqueImageName(basenameOf(path), usedNames), mime, bytes });
  }

  return images;
};

const uniqueImageName = (name: string, used: Set<string>): string => {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let index = 2;
  let candidate = `${stem}-${index}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate);
  return candidate;
};

/** Есть ли в архиве части, характерные для office-документа. */
const hasDocumentParts = (extension: string, archive: Unzipped): boolean => {
  const paths = Object.keys(archive);
  switch (extension) {
    case 'docx':
      return paths.includes(DOCX_DOCUMENT_PATH);
    case 'pptx':
      return paths.some((path) => PPTX_SLIDE_PATTERN.test(path));
    case 'xlsx':
      return (
        paths.includes('xl/workbook.xml') ||
        paths.some((path) => XLSX_WORKSHEET_PATTERN.test(path))
      );
    case 'odt':
    case 'odp':
    case 'ods':
      return paths.includes('content.xml');
    default:
      return false;
  }
};

interface FormatResult {
  text: string;
  images: ExtractedDocumentImage[];
}

const extractByFormat = (extension: string, archive: Unzipped): FormatResult => {
  switch (extension) {
    case 'docx':
      return {
        text: docxText(archive),
        images: collectImages(archive, docxImagePaths(archive)),
      };
    case 'pptx':
      return {
        text: pptxText(archive),
        images: collectImages(archive, mediaPaths(archive, /^ppt\/media\//i)),
      };
    case 'xlsx':
      return {
        text: xlsxText(archive),
        images: collectImages(archive, mediaPaths(archive, /^xl\/media\//i)),
      };
    case 'odt':
      return {
        text: odtText(archive),
        images: collectImages(archive, mediaPaths(archive, /^Pictures\//i)),
      };
    case 'odp':
      return {
        text: odpText(archive),
        images: collectImages(archive, mediaPaths(archive, /^Pictures\//i)),
      };
    case 'ods':
      return {
        text: odsText(archive),
        images: collectImages(archive, mediaPaths(archive, /^Pictures\//i)),
      };
    default:
      throw new DocumentExtractError('unsupported');
  }
};

/**
 * Разбор office-документа: текст + встроенные изображения.
 *
 * @param fileName имя файла — по расширению определяется формат
 *   (docx/pptx/xlsx/odt/odp/ods); иные расширения — ошибка `unsupported`
 * @param bytes содержимое файла (ZIP-архив office-формата)
 * @throws {DocumentExtractError} с кодом причины отказа
 */
export function extractDocumentText(fileName: string, bytes: Uint8Array): ExtractedDocument {
  const extension = extensionOf(fileName);
  if (!OFFICE_EXTENSIONS.includes(extension)) {
    throw new DocumentExtractError('unsupported');
  }

  const archive = readArchive(bytes);
  if (!hasDocumentParts(extension, archive)) {
    throw new DocumentExtractError('not_a_document');
  }

  const { text, images } = extractByFormat(extension, archive);
  const trimmed = text.trim();

  if (trimmed.length <= DOCUMENT_QUOTAS.maxExtractedTextChars) {
    return { text: trimmed, images, truncated: false };
  }

  const end = DOCUMENT_QUOTAS.maxExtractedTextChars - TRUNCATION_NOTICE.length;
  return {
    text: `${trimmed.slice(0, end)}${TRUNCATION_NOTICE}`,
    images,
    truncated: true,
  };
}
