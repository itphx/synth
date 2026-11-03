/**
 * Классификация файла проекта по расширению — **browser-safe** контракт
 * (только чистые функции и константы, без `node:*` и без zod-схем): его
 * импортирует UI (`@itphx/synth-shared/types`), чтобы клиент и сервер
 * одинаково понимали, что за файл и можно ли его отдавать inline.
 *
 * Единый источник истины — здесь: `isTextFile()` в core (`server/fs-workspace.ts`)
 * отвечает на другой вопрос («это текст или бинарь — по содержимому») и не
 * дублируется здесь. Этот модуль отвечает на вопрос «какого семейства файл
 * по расширению» (для выбора превью и MIME).
 */

/** Семейство файла (по расширению). */
export type FileKind =
  | 'text'
  | 'markdown'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'binary';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown']);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.avif', '.tif', '.tiff',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.ogv', '.avi', '.mkv',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.rb', '.rs', '.go', '.java', '.kt', '.kts', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.lua', '.pl', '.pm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.vue', '.svelte', '.astro',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sql', '.graphql', '.gql', '.proto', '.prisma',
  '.tf', '.tfvars', '.gradle', '.m', '.mm',
  '.ex', '.exs', '.erl', '.hs', '.clj', '.groovy', '.dart', '.r', '.jl', '.nim', '.zig',
  // Конфиги
  '.yaml', '.yml', '.json', '.jsonl', '.toml', '.xml',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.csv', '.log', '.env', '.ini', '.cfg', '.conf',
  '.rst', '.adoc', '.org',
  '.tex', '.bib', '.patch', '.diff', '.srt', '.vtt',
]);

/** Расширение пути в нижнем регистре (с точкой); без расширения — `''`. */
function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  // Точка в начале имени (`.gitignore`) — расширения нет.
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Семейство файла по расширению (регистронезависимо).
 *
 * Неизвестное расширение (и файл без расширения) → `binary` — консервативно:
 * такой файл нельзя отдавать inline (см. `INLINE_PREVIEW_KINDS`).
 */
export function fileKind(path: string): FileKind {
  const ext = extensionOf(path);
  if (!ext) return 'binary';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

/** MIME по расширению; `binary`/неизвестное → `application/octet-stream`. */
const MIME_BY_EXTENSION: Record<string, string> = {
  // Изображения
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  // Видео
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  // Аудио
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  // Документы
  '.pdf': 'application/pdf',
  // Текст/код
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
};

/**
 * MIME-тип файла по расширению (регистронезависимо).
 *
 * `binary`/неизвестное расширение → `application/octet-stream`; текст, код и
 * markdown → `text/plain` (или точный MIME из таблицы выше).
 *
 * ⚠️ MIME **не** определяет, можно ли отдавать файл inline: этим занимается
 * allow-list `INLINE_PREVIEW_KINDS` (см. `GET /api/v2/fs/raw`).
 */
export function fileMime(path: string): string {
  const ext = extensionOf(path);
  if (!ext) return 'application/octet-stream';
  const known = MIME_BY_EXTENSION[ext];
  if (known) return known;
  const kind = fileKind(path);
  if (kind === 'markdown' || kind === 'code' || kind === 'text') return 'text/plain';
  return 'application/octet-stream';
}

/**
 * Семейства файлов, которые разрешено отдавать **inline** (в `<img>`,
 * `<video>`, `<audio>`, `<embed>`), а не как вложение.
 *
 * HTML/CSS/JS и прочий текст/код **в списке нет** — иначе `text/html`
 * исполнился бы в origin приложения (XSS). Правило — на сервере:
 * `GET /api/v2/fs/raw` для kind вне списка отдаёт `application/octet-stream`
 * + `Content-Disposition: attachment`.
 */
export const INLINE_PREVIEW_KINDS: readonly FileKind[] = ['image', 'video', 'audio', 'pdf'];
