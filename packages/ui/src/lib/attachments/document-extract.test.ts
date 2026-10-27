/**
 * Тесты разбора office-документов (`document-extract`).
 *
 * Архивы собираются прямо в тесте через `fflate.zipSync` — внешних
 * фикстур нет. Покрываются: docx (абзацы, таблица, изображение), pptx
 * (порядок слайдов), xlsx (sharedStrings + лист), odt (`text:s`/`text:tab`),
 * обрезка текста и коды ошибок.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';

import {
  DocumentExtractError,
  DOCUMENT_QUOTAS,
  extractDocumentText,
  OFFICE_EXTENSIONS,
} from './document-extract';

/** Собрать ZIP-архив из строк и байтов. */
const zip = (entries: Record<string, string | Uint8Array>): Uint8Array => {
  const prepared: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    prepared[name] = typeof value === 'string' ? strToU8(value) : value;
  }
  return zipSync(prepared);
};

/** Проверить, что вызов упал именно с нужным кодом ошибки. */
const expectExtractError = (run: () => unknown, code: string): void => {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DocumentExtractError);
  expect((thrown as DocumentExtractError).code).toBe(code);
};

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>Первый абзац</w:t></w:r></w:p>
    <w:p><w:r><w:t>Второй</w:t><w:tab/><w:t>абзац</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Ячейка 1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Ячейка 2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
                Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
                Target="media/image1.png"/>
</Relationships>`;

const pptxSlide = (text: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Лист 1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
                Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
                Target="worksheets/sheet1.xml"/>
</Relationships>`;

const XLSX_SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>Привет</t></si>
  <si><t>Мир</t></si>
</sst>`;

const XLSX_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Ячейка</t></is></c></row>
  </sheetData>
</worksheet>`;

const ODT_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:p>Слово<text:s text:c="3"/>продолжение</text:p>
      <text:p>Колонка<text:tab/>вторая</text:p>
    </office:text>
  </office:body>
</office:document-content>`;

const ODP_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:presentation>
      <draw:page draw:name="Первый">
        <draw:frame><text:p>Слайд один</text:p></draw:frame>
      </draw:page>
      <draw:page draw:name="Второй">
        <draw:frame><text:p>Слайд два</text:p></draw:frame>
      </draw:page>
    </office:presentation>
  </office:body>
</office:document-content>`;

const ODS_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="Лист">
        <table:table-row>
          <table:table-cell><text:p>Привет</text:p></table:table-cell>
          <table:table-cell><text:p>Мир</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell><text:p>1</text:p></table:table-cell>
          <table:table-cell><text:p>2</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`;

describe('document-extract', () => {
  it('знает поддерживаемые форматы', () => {
    expect([...OFFICE_EXTENSIONS].sort()).toEqual(
      ['docx', 'odp', 'ods', 'odt', 'pptx', 'xlsx'].sort(),
    );
  });

  it('docx: абзацы, таблица и встроенное изображение', () => {
    const bytes = zip({
      'word/document.xml': DOCX_XML,
      'word/_rels/document.xml.rels': DOCX_RELS,
      'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const result = extractDocumentText('отчёт.docx', bytes);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe('Первый абзац\nВторой\tабзац\nЯчейка 1\tЯчейка 2');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mime).toBe('image/png');
    expect(result.images[0]?.name).toBe('image1.png');
    expect(result.images[0]?.bytes.byteLength).toBe(4);
  });

  it('docx: XML-сущности декодируются', () => {
    const bytes = zip({
      'word/document.xml': `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>a &amp; b &lt;c&gt; &#65;</w:t></w:r></w:p></w:body></w:document>`,
    });

    const result = extractDocumentText('сущности.docx', bytes);

    expect(result.text).toBe('a & b <c> A');
  });

  it('pptx: слайды идут в числовом порядке', () => {
    const bytes = zip({
      'ppt/slides/slide1.xml': pptxSlide('Первый слайд'),
      'ppt/slides/slide2.xml': pptxSlide('Второй слайд'),
      'ppt/slides/slide10.xml': pptxSlide('Десятый слайд'),
    });

    const result = extractDocumentText('презентация.pptx', bytes);

    expect(result.text).toBe('Первый слайд\n\nВторой слайд\n\nДесятый слайд');
  });

  it('xlsx: значения листа разделяются табуляцией', () => {
    const bytes = zip({
      'xl/workbook.xml': XLSX_WORKBOOK,
      'xl/_rels/workbook.xml.rels': XLSX_WORKBOOK_RELS,
      'xl/sharedStrings.xml': XLSX_SHARED_STRINGS,
      'xl/worksheets/sheet1.xml': XLSX_SHEET,
    });

    const result = extractDocumentText('таблица.xlsx', bytes);

    expect(result.text).toBe('Лист 1\nПривет\t42\nМир\tЯчейка');
  });

  it('odt: text:s даёт пробелы, text:tab — табуляцию', () => {
    const bytes = zip({ 'content.xml': ODT_CONTENT });

    const result = extractDocumentText('документ.odt', bytes);

    expect(result.text).toBe('Слово   продолжение\nКолонка\tвторая');
  });

  it('odp: страницы разделены пустой строкой', () => {
    const bytes = zip({ 'content.xml': ODP_CONTENT });

    const result = extractDocumentText('колода.odp', bytes);

    expect(result.text).toBe('Слайд один\n\nСлайд два');
  });

  it('ods: ячейки таблицы разделяются табуляцией', () => {
    const bytes = zip({ 'content.xml': ODS_CONTENT });

    const result = extractDocumentText('книга.ods', bytes);

    expect(result.text).toBe('Привет\tМир\n1\t2');
  });

  it('pptx: изображения берутся из ppt/media', () => {
    const bytes = zip({
      'ppt/slides/slide1.xml': pptxSlide('Слайд'),
      'ppt/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const result = extractDocumentText('картинка.pptx', bytes);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mime).toBe('image/png');
    expect(result.images[0]?.name).toBe('image1.png');
  });

  it('odt: изображения берутся из Pictures', () => {
    const bytes = zip({
      'content.xml': ODT_CONTENT,
      'Pictures/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    const result = extractDocumentText('картинка.odt', bytes);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mime).toBe('image/png');
  });

  it('не-office расширение — ошибка unsupported', () => {
    expectExtractError(
      () => extractDocumentText('фото.png', new Uint8Array([1, 2, 3])),
      'unsupported',
    );
  });

  it('битые байты — ошибка invalid_archive', () => {
    expectExtractError(
      () => extractDocumentText('битый.docx', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
      'invalid_archive',
    );
  });

  it('zip без office-частей — ошибка not_a_document', () => {
    const bytes = zip({ 'readme.txt': 'просто текст' });

    expectExtractError(() => extractDocumentText('пусто.docx', bytes), 'not_a_document');
  });

  it('слишком много записей — ошибка too_many_entries', () => {
    const entries: Record<string, string> = {};
    for (let index = 0; index <= DOCUMENT_QUOTAS.maxEntries; index += 1) {
      entries[`word/media/file${index}.txt`] = 'x';
    }
    const bytes = zip(entries);

    expectExtractError(() => extractDocumentText('много.docx', bytes), 'too_many_entries');
  });

  it('слишком большой XML — ошибка entry_too_large', () => {
    const huge = 'я'.repeat(DOCUMENT_QUOTAS.maxXmlEntryBytes + 1024);
    const bytes = zip({
      'word/document.xml': `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:body></w:document>`,
    });

    expectExtractError(() => extractDocumentText('огромный.docx', bytes), 'entry_too_large');
  });

  it('длинный текст обрезается с пометкой', () => {
    const long = 'я'.repeat(DOCUMENT_QUOTAS.maxExtractedTextChars + 1000);
    const bytes = zip({
      'word/document.xml': `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${long}</w:t></w:r></w:p></w:body></w:document>`,
    });

    const result = extractDocumentText('длинный.docx', bytes);

    expect(result.truncated).toBe(true);
    expect(result.text.endsWith('[Текст документа обрезан]\n')).toBe(true);
    expect(result.text.length).toBe(DOCUMENT_QUOTAS.maxExtractedTextChars);
  });
});
