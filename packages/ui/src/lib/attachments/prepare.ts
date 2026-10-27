/**
 * Клиентская подготовка вложений к отправке.
 *
 * Собирает вместе разрозненные шаги слоя вложений и отдаёт набор записей,
 * который композер кладёт в очередь загрузки (ADR-115, раздел «UI»):
 *
 * - MIME определяется по содержимому (`resolveAttachmentMime`), а не по
 *   заявленному типу;
 * - HEIC/HEIF конвертируется в JPEG — движки этот формат не понимают;
 * - office-документ (docx/pptx/xlsx/odt/odp/ods) распаковывается в текст
 *   (`<base>.txt`) и встроенные изображения; все записи делят один
 *   `groupId`, чтобы удаление любого элемента убирало всю группу;
 * - если разобрать документ или конвертировать HEIC не удалось, исходный
 *   файл прикладывается как есть с `fallback: true` — вложение не теряется;
 * - имена уникализируются суффиксом `-2`, `-3`, … с учётом `reservedNames`
 *   (имена, уже занятые в композере).
 *
 * Порядок записей стабилен: сначала текст документа, затем изображения в
 * порядке извлечения.
 */

import { getAttachmentFileExtension } from './accept'
import {
  DocumentExtractError,
  extractDocumentText,
  OFFICE_EXTENSIONS,
  type ExtractedDocument,
} from './document-extract'
import { resolveAttachmentMime } from './mime'

/** Готовая запись вложения: файл уже пригоден для загрузки на сервер. */
export interface PreparedAttachment {
  file: File
  mimeType: string
  /** Группа частей одного документа: удаление любого элемента группы убирает всю группу. */
  groupId?: string
  /** true — документ не удалось разобрать, приложен как есть. */
  fallback?: boolean
}

/** Форматы, которые браузеры отдают как есть, а движки не читают. */
const HEIC_MIME_TYPES: ReadonlySet<string> = new Set(['image/heic', 'image/heif'])

/** Качество JPEG при конвертации HEIC. */
const HEIC_JPEG_QUALITY = 0.9

/** Тип «не опознан»: для текстовых расширений подменяется на `text/plain`. */
const OCTET_STREAM = 'application/octet-stream'

/** MIME изображения → расширение имени файла. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * Текстовые расширения (текст, разметка, конфиги, исходники).
 *
 * Нужны только для случая `application/octet-stream`: сигнатура такие файлы
 * не опознаёт, а `File.type` браузер часто оставляет пустым — без подмены
 * исходник уедет на сервер как бинарь. Список согласован с
 * `ACCEPTED_ATTACHMENT_EXTENSIONS`/`CODE_AND_CONFIG_EXTENSIONS` в `accept.ts`.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'text',
  'log',
  'md',
  'mdx',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'conf',
  'cfg',
  'env',
  'diff',
  'patch',
  'ipynb',
  'har',
  'graphql',
  'gql',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mts',
  'cts',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'dart',
  'ex',
  'exs',
  'erl',
  'hrl',
  'fs',
  'fsx',
  'hcl',
  'drawio',
  'excalidraw',
])

/** Имя без расширения и само расширение (с точкой). */
function splitFileName(name: string): { stem: string; extension: string } {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return { stem: base, extension: '' }
  return { stem: base.slice(0, dot), extension: base.slice(dot) }
}

/** Заменить расширение (или добавить, если его нет). */
function replaceExtension(name: string, extension: string): string {
  return `${splitFileName(name).stem}.${extension}`
}

/**
 * Байты как `BlobPart`.
 *
 * `Uint8Array<ArrayBufferLike>` (тип извлечённых изображений) в TS 6 не
 * приводится к `BlobPart` из-за возможного `SharedArrayBuffer` — копия байтов
 * даёт обычный `ArrayBuffer`.
 */
function bytesAsBlobPart(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

/** Расширение для извлечённого изображения по его MIME. */
function imageExtension(mime: string): string {
  const normalized = mime.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  const known = IMAGE_EXTENSIONS[normalized]
  if (known) return known
  const subtype = normalized.split('/').pop() ?? ''
  return /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin'
}

/**
 * Свободное имя в пределах вызова.
 *
 * Сравнение регистронезависимое: сервер и файловые системы пользователей
 * могут не различать регистр, и `Photo.PNG`/`photo.png` — одна коллизия.
 */
function uniqueName(name: string, used: Set<string>): string {
  const key = name.toLowerCase()
  if (!used.has(key)) {
    used.add(key)
    return name
  }

  const { stem, extension } = splitFileName(name)
  let index = 2
  let candidate = `${stem}-${index}${extension}`
  while (used.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${stem}-${index}${extension}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/** Копия файла под новым именем (тип и содержимое сохраняются). */
function renamedFile(file: File, name: string): File {
  if (name === file.name) return file
  return new File([file], name, { type: file.type })
}

/** Конвертация HEIC/HEIF в JPEG; `undefined` — конвертация не удалась. */
async function convertHeicToJpeg(file: File): Promise<Blob | undefined> {
  try {
    const { default: heic2any } = await import('heic2any')
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: HEIC_JPEG_QUALITY })
    const blob = Array.isArray(result) ? result[0] : result
    return blob ?? undefined
  } catch {
    return undefined
  }
}

/** Идентификатор группы частей одного документа. */
function createGroupId(): string {
  const random = Math.random().toString(36).slice(2, 8)
  return `doc-${Date.now().toString(36)}-${random}`
}

/**
 * Подготовить файл к отправке.
 *
 * Один исходный файл может дать несколько записей (office-документ — текст и
 * изображения). `reservedNames` — имена, уже занятые в композере: новые имена
 * получают суффикс `-2`, `-3`, … перед расширением.
 */
export async function prepareAttachmentFiles(
  file: File,
  reservedNames: Iterable<string> = [],
): Promise<PreparedAttachment[]> {
  const used = new Set<string>()
  for (const reserved of reservedNames) {
    const normalized = reserved.trim().toLowerCase()
    if (normalized) used.add(normalized)
  }

  const mimeType = await resolveAttachmentMime(file)
  const extension = getAttachmentFileExtension(file.name)

  if (HEIC_MIME_TYPES.has(mimeType)) {
    const jpeg = await convertHeicToJpeg(file)
    if (!jpeg) return [{ file, mimeType, fallback: true }]
    const name = uniqueName(replaceExtension(file.name, 'jpg'), used)
    return [{ file: new File([jpeg], name, { type: 'image/jpeg' }), mimeType: 'image/jpeg' }]
  }

  if (OFFICE_EXTENSIONS.includes(extension)) {
    let extracted: ExtractedDocument
    try {
      extracted = extractDocumentText(file.name, new Uint8Array(await file.arrayBuffer()))
    } catch (error) {
      if (error instanceof DocumentExtractError) return [{ file, mimeType, fallback: true }]
      throw error
    }

    if (!extracted.text && extracted.images.length === 0) {
      return [{ file, mimeType, fallback: true }]
    }

    const { stem } = splitFileName(file.name)
    const groupId = createGroupId()
    const prepared: PreparedAttachment[] = []

    // Пустой текст отдельной записи не даёт: `.txt` без содержимого в
    // композере бесполезен, изображения документа при этом остаются.
    if (extracted.text) {
      const name = uniqueName(`${stem}.txt`, used)
      prepared.push({
        file: new File([extracted.text], name, { type: 'text/plain' }),
        mimeType: 'text/plain',
        groupId,
      })
    }

    extracted.images.forEach((image, index) => {
      const name = uniqueName(`${stem}-image-${index + 1}.${imageExtension(image.mime)}`, used)
      prepared.push({
        file: new File([bytesAsBlobPart(image.bytes)], name, { type: image.mime }),
        mimeType: image.mime,
        groupId,
      })
    })

    return prepared
  }

  const resolvedMime =
    mimeType === OCTET_STREAM && TEXT_EXTENSIONS.has(extension) ? 'text/plain' : mimeType
  const name = uniqueName(file.name, used)
  return [{ file: renamedFile(file, name), mimeType: resolvedMime }]
}
