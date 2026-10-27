/**
 * Тесты подготовки вложений (`prepare`).
 *
 * Архивы office-документов собираются в тесте через `fflate.zipSync`,
 * конвертер HEIC подменяется моком — внешних фикстур и сети нет.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

import { prepareAttachmentFiles } from './prepare'

const { heic2anyMock } = vi.hoisted(() => ({ heic2anyMock: vi.fn() }))

vi.mock('heic2any', () => ({ default: heic2anyMock }))

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))

/** Байты HEIC: ISO-BMFF-бокс `ftyp` с брендом `heic`. */
const heicBytes = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0x00, 0x00, 0x00, 0x18, ...ascii('ftyp'), ...ascii('heic')])

const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
])

/** Собрать ZIP-архив из строк и байтов. */
const zip = (entries: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> => {
  const prepared: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(entries)) {
    prepared[name] = typeof value === 'string' ? strToU8(value) : value
  }
  return new Uint8Array(zipSync(prepared))
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Первый абзац</w:t></w:r></w:p>
    <w:p><w:r><w:t>Второй абзац</w:t></w:r></w:p>
  </w:body>
</w:document>`

/** docx с текстом и одним встроенным изображением. */
const docxFile = (name = 'отчёт.docx'): File =>
  new File([zip({ 'word/document.xml': DOCX_XML, 'word/media/image1.png': PNG_BYTES })], name)

/** Прочитать содержимое записи как текст. */
const readText = async (file: File): Promise<string> => new TextDecoder().decode(await file.arrayBuffer())

beforeEach(() => {
  heic2anyMock.mockReset()
})

describe('prepareAttachmentFiles: текст и прочие файлы', () => {
  it('текстовый файл остаётся одним вложением с текстовым MIME', async () => {
    const file = new File(['привет'], 'note.txt', { type: 'text/plain' })
    const prepared = await prepareAttachmentFiles(file)

    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.file.name).toBe('note.txt')
    expect(prepared[0]?.mimeType).toBe('text/plain')
    expect(prepared[0]?.groupId).toBeUndefined()
    expect(prepared[0]?.fallback).toBeUndefined()
  })

  it('application/octet-stream с текстовым расширением становится text/plain', async () => {
    const file = new File(['const answer = 42'], 'main.ts', { type: '' })
    const prepared = await prepareAttachmentFiles(file)

    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.mimeType).toBe('text/plain')
    expect(prepared[0]?.file.name).toBe('main.ts')
  })

  it('бинарь без текстового расширения сохраняет неопознанный MIME', async () => {
    const file = new File([new Uint8Array([0x01, 0x02, 0x03])], 'data.bin')
    const prepared = await prepareAttachmentFiles(file)

    expect(prepared[0]?.mimeType).toBe('application/octet-stream')
  })
})

describe('prepareAttachmentFiles: HEIC/HEIF', () => {
  it('конвертирует HEIC в JPEG с именем .jpg', async () => {
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
    heic2anyMock.mockResolvedValue(jpeg)

    const file = new File([heicBytes()], 'IMG_0001.heic')
    const prepared = await prepareAttachmentFiles(file)

    expect(heic2anyMock).toHaveBeenCalledTimes(1)
    expect(heic2anyMock).toHaveBeenCalledWith({ blob: file, toType: 'image/jpeg', quality: 0.9 })
    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.file.name).toBe('IMG_0001.jpg')
    expect(prepared[0]?.mimeType).toBe('image/jpeg')
    expect(prepared[0]?.fallback).toBeUndefined()
  })

  it('ошибка конвертации — исходный файл с fallback', async () => {
    heic2anyMock.mockRejectedValue(new Error('libheif failed'))

    const file = new File([heicBytes()], 'IMG_0002.heic')
    const prepared = await prepareAttachmentFiles(file)

    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.file).toBe(file)
    expect(prepared[0]?.mimeType).toBe('image/heic')
    expect(prepared[0]?.fallback).toBe(true)
  })
})

describe('prepareAttachmentFiles: office-документы', () => {
  it('docx распаковывается в текст и изображения одной группы', async () => {
    const prepared = await prepareAttachmentFiles(docxFile())

    expect(prepared).toHaveLength(2)
    const [text, image] = prepared

    expect(text?.file.name).toBe('отчёт.txt')
    expect(text?.mimeType).toBe('text/plain')
    expect(await readText(text!.file)).toBe('Первый абзац\nВторой абзац')

    expect(image?.file.name).toBe('отчёт-image-1.png')
    expect(image?.mimeType).toBe('image/png')

    expect(text?.groupId).toBeTruthy()
    expect(image?.groupId).toBe(text?.groupId)
    expect(text?.fallback).toBeUndefined()
    expect(image?.fallback).toBeUndefined()
  })

  it('битый office прикладывается как есть с fallback', async () => {
    const file = new File(['это не архив'], 'broken.docx')
    const prepared = await prepareAttachmentFiles(file)

    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.file).toBe(file)
    expect(prepared[0]?.fallback).toBe(true)
    expect(prepared[0]?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('имя текстовой части учитывает reservedNames', async () => {
    const prepared = await prepareAttachmentFiles(docxFile(), ['отчёт.txt'])
    expect(prepared[0]?.file.name).toBe('отчёт-2.txt')
  })
})

describe('prepareAttachmentFiles: коллизии имён', () => {
  it('reservedNames даёт суффикс -2 внутри расширения', async () => {
    const file = new File(['данные'], 'file.txt', { type: 'text/plain' })
    const prepared = await prepareAttachmentFiles(file, ['file.txt'])

    expect(prepared[0]?.file.name).toBe('file-2.txt')
  })

  it('третье совпадение получает суффикс -3', async () => {
    const file = new File(['данные'], 'file.txt', { type: 'text/plain' })
    const prepared = await prepareAttachmentFiles(file, ['file.txt', 'file-2.txt'])

    expect(prepared[0]?.file.name).toBe('file-3.txt')
  })

  it('два одинаковых файла в одном наборе не конфликтуют', async () => {
    // Композер готовит файлы по одному, поэтому занятые имена передаются
    // через `reservedNames` — так и получается уникальность внутри набора.
    const first = new File(['данные'], 'file.txt', { type: 'text/plain' })
    const second = new File(['данные'], 'file.txt', { type: 'text/plain' })

    const used: string[] = []
    for (const file of [first, second]) {
      const [item] = await prepareAttachmentFiles(file, used)
      used.push(item!.file.name)
    }

    expect(used).toEqual(['file.txt', 'file-2.txt'])
  })
})
