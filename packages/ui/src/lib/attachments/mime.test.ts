import { describe, it, expect } from 'vitest'
import {
  getAttachmentInputModality,
  getUnsupportedAttachmentInputs,
  resolveAttachmentMime,
  sniffMimeFromBytes,
} from './mime'

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values)

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0)
const PDF = bytes(...ascii('%PDF-1.7'))
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04)
const GIF = bytes(...ascii('GIF89a'))
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3)

// ISO-BMFF: 4 байта размера, на 4-м — маркер `ftyp`, на 8-м — бренд.
const ftypBox = (brand: string): Uint8Array =>
  bytes(0x00, 0x00, 0x00, 0x18, ...ascii('ftyp'), ...ascii(brand))

const RIFF = (format: string): Uint8Array =>
  bytes(...ascii('RIFF'), 0x10, 0x00, 0x00, 0x00, ...ascii(format))

describe('sniffMimeFromBytes', () => {
  it('опознаёт png, jpeg, gif и pdf', () => {
    expect(sniffMimeFromBytes(PNG)).toBe('image/png')
    expect(sniffMimeFromBytes(JPEG)).toBe('image/jpeg')
    expect(sniffMimeFromBytes(GIF)).toBe('image/gif')
    expect(sniffMimeFromBytes(PDF)).toBe('application/pdf')
  })

  it('опознаёт zip-контейнер', () => {
    expect(sniffMimeFromBytes(ZIP)).toBe('application/zip')
  })

  it('опознаёт webp и wav по содержимому RIFF', () => {
    expect(sniffMimeFromBytes(RIFF('WEBP'))).toBe('image/webp')
    expect(sniffMimeFromBytes(RIFF('WAVE'))).toBe('audio/wav')
  })

  it('опознаёт HEIC по ftyp-бренду', () => {
    expect(sniffMimeFromBytes(ftypBox('heic'))).toBe('image/heic')
    expect(sniffMimeFromBytes(ftypBox('mif1'))).toBe('image/heic')
  })

  it('опознаёт mp4 и m4a по ftyp-бренду', () => {
    expect(sniffMimeFromBytes(ftypBox('isom'))).toBe('video/mp4')
    expect(sniffMimeFromBytes(ftypBox('mp42'))).toBe('video/mp4')
    expect(sniffMimeFromBytes(ftypBox('M4A '))).toBe('audio/mp4')
  })

  it('опознаёт mp3, ogg и webm', () => {
    expect(sniffMimeFromBytes(bytes(...ascii('ID3')))).toBe('audio/mpeg')
    expect(sniffMimeFromBytes(bytes(0xff, 0xfb))).toBe('audio/mpeg')
    expect(sniffMimeFromBytes(bytes(...ascii('OggS')))).toBe('audio/ogg')
    expect(sniffMimeFromBytes(WEBM)).toBe('video/webm')
  })

  it('неизвестная сигнатура — undefined', () => {
    expect(sniffMimeFromBytes(bytes(0x01, 0x02, 0x03))).toBeUndefined()
    expect(sniffMimeFromBytes(bytes())).toBeUndefined()
  })
})

describe('resolveAttachmentMime', () => {
  it('сигнатура содержимого важнее file.type', async () => {
    const file = new File([PNG], 'photo.png', { type: 'text/plain' })
    await expect(resolveAttachmentMime(file)).resolves.toBe('image/png')
  })

  it('zip-контейнер с расширением .docx — MIME документа', async () => {
    const file = new File([ZIP], 'report.docx', { type: '' })
    await expect(resolveAttachmentMime(file)).resolves.toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('zip-контейнер с расширением .xlsx — MIME таблицы', async () => {
    const file = new File([ZIP], 'book.xlsx', { type: '' })
    await expect(resolveAttachmentMime(file)).resolves.toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })

  it('запасной путь — file.type', async () => {
    const file = new File(['просто текст'], 'notes.txt', { type: 'text/plain' })
    await expect(resolveAttachmentMime(file)).resolves.toBe('text/plain')
  })

  it('запасной путь — расширение, если file.type пустой', async () => {
    const file = new File(['данные'], 'config.yaml', { type: '' })
    await expect(resolveAttachmentMime(file)).resolves.toBe('application/yaml')
  })

  it('ничего не известно — application/octet-stream', async () => {
    const file = new File([bytes(0x01, 0x02, 0x03)], 'blob.unknown', { type: '' })
    await expect(resolveAttachmentMime(file)).resolves.toBe('application/octet-stream')
  })
})

describe('getAttachmentInputModality', () => {
  it('определяет модальность по типу', () => {
    expect(getAttachmentInputModality('image/png')).toBe('image')
    expect(getAttachmentInputModality('audio/mpeg')).toBe('audio')
    expect(getAttachmentInputModality('video/mp4')).toBe('video')
    expect(getAttachmentInputModality('application/pdf')).toBe('pdf')
    expect(getAttachmentInputModality('text/plain')).toBe('text')
  })

  it('игнорирует параметры и регистр', () => {
    expect(getAttachmentInputModality('TEXT/PLAIN; charset=utf-8')).toBe('text')
    expect(getAttachmentInputModality('Image/PNG')).toBe('image')
  })

  it('неизвестный тип — undefined', () => {
    expect(getAttachmentInputModality('application/zip')).toBeUndefined()
    expect(getAttachmentInputModality('application/octet-stream')).toBeUndefined()
  })
})

describe('getUnsupportedAttachmentInputs', () => {
  it('возвращает вложения с неподдерживаемой модальностью', () => {
    const image = { id: 'a', mimeType: 'image/png' }
    const text = { id: 'b', mimeType: 'text/plain' }

    const unsupported = getUnsupportedAttachmentInputs([image, text], ['text'])
    expect(unsupported).toHaveLength(1)
    expect(unsupported[0]?.attachment).toBe(image)
    expect(unsupported[0]?.modality).toBe('image')
  })

  it('пустой список, когда все модальности поддерживаются', () => {
    const items = [{ mimeType: 'image/png' }, { mimeType: 'text/plain' }]
    expect(getUnsupportedAttachmentInputs(items, ['image', 'text'])).toEqual([])
  })

  it('вложение без распознанной модальности пропускается', () => {
    const items = [{ mimeType: 'application/zip' }]
    expect(getUnsupportedAttachmentInputs(items, ['text'])).toEqual([])
  })
})
