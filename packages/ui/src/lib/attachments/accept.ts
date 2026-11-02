/**
 * Что UI принимает как вложение.
 *
 * Единый список для трёх мест: фильтр диалога выбора файла (`accept`),
 * проверка файла перед отправкой (`isAcceptedAttachment`) и подсказка
 * пользователю о неподдерживаемом формате.
 *
 * HEIC/HEIF здесь намеренно НЕ входят: движки не понимают этот формат, и
 * конвертация HEIC → JPEG выполняется отдельно (шаг конвертации перед
 * отправкой), уже после того, как файл выбран. Считать «heic» поддерживаемым
 * здесь нельзя — иначе файл дойдёт до модели в нечитаемом виде.
 */

/** MIME-типы, которые UI принимает нативно. */
export const ACCEPTED_ATTACHMENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/aac',
  'audio/opus',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/*',
  'application/json',
  'application/ld+json',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/xml',
  'text/csv',
]

/** Расширение → канонический MIME (для обратного маппинга). */
const MIME_TYPE_EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/ogg', 'ogv'],
  ['video/quicktime', 'mov'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/flac', 'flac'],
  ['audio/mp4', 'm4a'],
  ['audio/aac', 'aac'],
  ['audio/opus', 'opus'],
  ['application/pdf', 'pdf'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/json', 'json'],
  ['application/ld+json', 'jsonld'],
  ['application/yaml', 'yaml'],
  ['application/x-yaml', 'yaml'],
  ['application/toml', 'toml'],
  ['application/x-toml', 'toml'],
  ['application/xml', 'xml'],
  ['text/csv', 'csv'],
  ['text/plain', 'txt'],
])

/**
 * Расширения исходников и конфигов, у которых нет отдельного MIME-типа
 * (в `accept` их указывают как расширения).
 */
const CODE_AND_CONFIG_EXTENSIONS: readonly string[] = [
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
  'md',
  'mdx',
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
]

/** Текстовые расширения, покрытые MIME-типом `text/*`. */
const TEXT_ATTACHMENT_EXTENSIONS: readonly string[] = ['txt', 'text', 'log', 'md', 'csv']

/**
 * Дополнительные расширения медиа: у одного MIME-типа может быть несколько
 * расширений, а карта `MIME_TYPE_EXTENSIONS` однозначна (MIME → ext).
 */
const EXTRA_MEDIA_EXTENSIONS: ReadonlyMap<string, 'image' | 'pdf' | 'audio' | 'video'> = new Map([
  ['m4v', 'video'],
  ['oga', 'audio'],
])

/** Все принимаемые расширения (без ведущей точки), по алфавиту. */
export const ACCEPTED_ATTACHMENT_EXTENSIONS: readonly string[] = Array.from(
  new Set<string>([
    ...MIME_TYPE_EXTENSIONS.values(),
    ...EXTRA_MEDIA_EXTENSIONS.keys(),
    ...TEXT_ATTACHMENT_EXTENSIONS,
    ...CODE_AND_CONFIG_EXTENSIONS,
  ]),
).sort()

/** Семейства вложений, которые сервер может включать/выключать (`attachments.modalities`). */
export type AttachmentModalities = {
  image?: boolean
  pdf?: boolean
  audio?: boolean
  video?: boolean
}

type AttachmentFamily = keyof AttachmentModalities

const DEFAULT_MODALITIES: Required<AttachmentModalities> = {
  image: true,
  pdf: true,
  audio: true,
  video: true,
}

/** Семейство MIME-типа (у текста/офиса/кода — нет, они не гейтятся модальностью). */
function mimeFamily(mime: string): AttachmentFamily | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  return null
}

/** Семейство расширения — по его каноническому MIME. */
const EXTENSION_FAMILIES: ReadonlyMap<string, AttachmentFamily> = (() => {
  const families = new Map<string, AttachmentFamily>()
  for (const [mime, extension] of MIME_TYPE_EXTENSIONS) {
    const family = mimeFamily(mime)
    if (family) families.set(extension, family)
  }
  for (const [extension, family] of EXTRA_MEDIA_EXTENSIONS) families.set(extension, family)
  return families
})()

/**
 * Значение атрибута `accept` для `<input type="file">` с учётом серверных
 * `attachments.modalities` (выключенное семейство не предлагается в диалоге).
 */
export function buildAttachmentAccept(modalities?: AttachmentModalities): string {
  const enabled: Required<AttachmentModalities> = { ...DEFAULT_MODALITIES, ...modalities }
  const isEnabled = (family: AttachmentFamily | null): boolean =>
    family === null || enabled[family]

  const types = ACCEPTED_ATTACHMENT_TYPES.filter((mime) => isEnabled(mimeFamily(mime)))
  const extensions = ACCEPTED_ATTACHMENT_EXTENSIONS.filter((extension) =>
    isEnabled(EXTENSION_FAMILIES.get(extension) ?? null),
  )

  return [...types, ...extensions.map((extension) => `.${extension}`)].join(',')
}

/** Полный `accept` (все семейства включены) — фоллбек до ответа `/meta`. */
export const ATTACHMENT_ACCEPT: string = buildAttachmentAccept()

/**
 * Расширение имени файла в нижнем регистре (без точки).
 *
 * Точечные файлы (`.env`) трактуются как расширение — имя после точки.
 */
export function getAttachmentFileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  if (dot === 0) return base.slice(1).toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

/** MIME-тип без параметров (`text/plain; charset=utf-8` → `text/plain`). */
function normalizeMimeType(mime: string | undefined): string {
  if (!mime) return ''
  return mime.toLowerCase().split(';', 1)[0]?.trim() ?? ''
}

/**
 * Поддерживает ли UI такой файл.
 *
 * MIME-тип важнее расширения: если тип известен и не в списке — файл не
 * принимается (например `image/svg+xml` — вектор, который движки не ждут).
 * MIME-типа нет или он пустой — решает расширение.
 */
export function isAcceptedAttachment(name: string, mime?: string): boolean {
  const normalizedMime = normalizeMimeType(mime)
  if (normalizedMime) {
    if (ACCEPTED_ATTACHMENT_TYPES.includes(normalizedMime)) return true
    if (normalizedMime.startsWith('text/')) return true
  }
  const extension = getAttachmentFileExtension(name)
  if (!extension) return false
  return ACCEPTED_ATTACHMENT_EXTENSIONS.includes(extension)
}
