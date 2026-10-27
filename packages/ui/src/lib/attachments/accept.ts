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

/** Все принимаемые расширения (без ведущей точки), по алфавиту. */
export const ACCEPTED_ATTACHMENT_EXTENSIONS: readonly string[] = Array.from(
  new Set<string>([
    ...MIME_TYPE_EXTENSIONS.values(),
    ...TEXT_ATTACHMENT_EXTENSIONS,
    ...CODE_AND_CONFIG_EXTENSIONS,
  ]),
).sort()

/** Значение атрибута `accept` для `<input type="file">`. */
export const ATTACHMENT_ACCEPT: string = [
  ...ACCEPTED_ATTACHMENT_TYPES,
  ...ACCEPTED_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`),
].join(',')

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
