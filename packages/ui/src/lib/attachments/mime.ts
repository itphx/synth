/**
 * Определение MIME-типа вложения по содержимому.
 *
 * Браузерный `File.type` часто пустой или врёт (особенно на Windows и для
 * office-документов), поэтому тип выводится из сигнатуры первых байт. Сигнатура
 * — источник истины; `file.type` и расширение идут только запасным путём.
 */

/** Модальность вложения — по ней выбирается канал отправки в движок. */
export type AttachmentInputModality = 'text' | 'image' | 'pdf' | 'audio' | 'video'

/** Расширение → MIME-тип (запасной путь, когда сигнатура не сработала). */
const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  json: 'application/json',
  jsonld: 'application/ld+json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  csv: 'text/csv',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  mdx: 'text/markdown',
}

/** Office-документы — zip-контейнеры, тип восстанавливается по расширению. */
const OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'])

/** Бренды ISO-BMFF, по которым HEIC отличается от прочих mp4-контейнеров. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'])

/** Сколько байт файла читается для определения типа. */
const HEAD_BYTES = 4096

function startsWithBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false
  }
  return true
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return ''
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result += String.fromCharCode(bytes[offset + index])
  }
  return result
}

function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  if (dot === 0) return base.slice(1).toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

/**
 * MIME-тип по сигнатуре файла.
 *
 * Возвращает `undefined`, если сигнатура не опознана. `application/zip`
 * означает «zip-контейнер»: конкретный тип (docx/xlsx/…) определяется по
 * расширению уже в `resolveAttachmentMime`.
 */
export function sniffMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined

  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (asciiAt(bytes, 0, 4) === '%PDF') return 'application/pdf'
  if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (asciiAt(bytes, 0, 3) === 'ID3') return 'audio/mpeg'
  if (startsWithBytes(bytes, [0xff, 0xfb])) return 'audio/mpeg'
  if (asciiAt(bytes, 0, 4) === 'OggS') return 'audio/ogg'

  if (asciiAt(bytes, 0, 4) === 'RIFF') {
    const format = asciiAt(bytes, 8, 4)
    if (format === 'WEBP') return 'image/webp'
    if (format === 'WAVE') return 'audio/wav'
  }

  // ISO-BMFF: на 4-м байте — маркер бокса `ftyp`, на 8-м — бренд.
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4)
    if (HEIC_BRANDS.has(brand)) return 'image/heic'
    if (brand === 'M4A ') return 'audio/mp4'
    if (brand === 'isom' || brand === 'mp42') return 'video/mp4'
  }

  return undefined
}

async function readHeadBytes(file: File, length: number): Promise<Uint8Array> {
  const blob = file.slice(0, length)
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('Не удалось прочитать файл'))
    reader.readAsArrayBuffer(blob)
  })
  return new Uint8Array(buffer)
}

/**
 * MIME-тип вложения.
 *
 * Порядок: сигнатура содержимого → office-контейнер по расширению →
 * `file.type` → расширение → `application/octet-stream`.
 */
export async function resolveAttachmentMime(file: File): Promise<string> {
  const bytes = await readHeadBytes(file, HEAD_BYTES)
  const sniffed = sniffMimeFromBytes(bytes)
  const extension = fileExtension(file.name)

  if (sniffed && sniffed !== 'application/zip') return sniffed

  if (sniffed === 'application/zip' && OFFICE_EXTENSIONS.has(extension)) {
    const officeMime = EXTENSION_MIME_TYPES[extension]
    if (officeMime) return officeMime
  }

  if (file.type) return file.type
  const byExtension = EXTENSION_MIME_TYPES[extension]
  if (byExtension) return byExtension
  return 'application/octet-stream'
}

/**
 * Модальность вложения по MIME-типу.
 *
 * `undefined` — тип не относится ни к одному поддерживаемому входу
 * (например `application/zip`): такие вложения не отправляются в движок.
 */
export function getAttachmentInputModality(mime: string): AttachmentInputModality | undefined {
  const normalized = mime.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('audio/')) return 'audio'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized === 'application/pdf') return 'pdf'
  if (normalized.startsWith('text/')) return 'text'
  return undefined
}

/**
 * Вложения, модальность которых не поддерживается каналом.
 *
 * Вложения без распознанной модальности (`undefined`) пропускаются — их
 * отсекает проверка формата, а не проверка канала.
 */
export function getUnsupportedAttachmentInputs<T extends { mimeType: string }>(
  items: readonly T[],
  supportedModalities: readonly string[],
): Array<{ attachment: T; modality: AttachmentInputModality }> {
  const supported = new Set(supportedModalities.map((modality) => modality.toLowerCase()))
  const unsupported: Array<{ attachment: T; modality: AttachmentInputModality }> = []
  for (const attachment of items) {
    const modality = getAttachmentInputModality(attachment.mimeType)
    if (modality && !supported.has(modality)) {
      unsupported.push({ attachment, modality })
    }
  }
  return unsupported
}
