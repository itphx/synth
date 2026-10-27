// Генерация ID

let _counter = 0;

export function generateId(): string {
  _counter += 1;
  return `${Date.now().toString(36)}-${_counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateStreamId(): string {
  return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Форматирование дат

export function formatISODate(date: Date): string {
  return date.toISOString();
}

export function nowISO(): string {
  return new Date().toISOString();
}

// Безопасный JSON-парсинг

export function safeJsonParse<T>(data: string, fallback: T): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

// Атомарная запись в файл (write → temp → rename)

export async function atomicWrite(
  writeFile: (path: string, data: string) => Promise<void>,
  rename: (oldPath: string, newPath: string) => Promise<void>,
  targetPath: string,
  data: string,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${generateId()}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
}

// Санитизация недоверенного текста (U+0000)

/**
 * Удаляет NUL-символы (`\u0000`) из строки. PostgreSQL не принимает U+0000
 * ни в `text` («invalid byte sequence for encoding "UTF8": 0x00»), ни в `jsonb`
 * (`JSON.stringify` даёт escape `\u0000` → «unsupported Unicode escape
 * sequence»), поэтому недоверенный текст (ответ модели, вывод тулов/файлов/
 * shell/веба) чистится до записи. Остальные символы не меняются; исходная
 * строка возвращается, если NUL-байтов нет.
 */
export function stripNullBytes(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}

/** Обычный объект-литерал (`{}` или `Object.create(null)`), не класс/Date/Buffer. */
function isPlainObjectValue(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripNullBytesDeepInternal(value: unknown): unknown {
  if (typeof value === 'string') return stripNullBytes(value);

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const next = stripNullBytesDeepInternal(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? result : value;
  }

  // Date/Buffer/классы/Map/Set и прочие non-plain объекты не трогаем:
  // их содержимое не является текстом домена.
  if (typeof value === 'object' && value !== null && isPlainObjectValue(value)) {
    let changed = false;
    const result = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      const next = stripNullBytesDeepInternal(item);
      if (next !== item) changed = true;
      result[key] = next;
    }
    return changed ? result : value;
  }

  return value;
}

/**
 * Рекурсивно удаляет NUL-байты из строк в массивах/plain-объектах.
 * `Date`, `Buffer` и прочие non-plain объекты возвращаются как есть.
 * Если изменений нет — возвращается исходное значение (та же ссылка).
 */
export function stripNullBytesDeep<T>(value: T): T {
  return stripNullBytesDeepInternal(value) as T;
}

// Асинхронный Mutex

export class AsyncLock {
  private _locked = false;
  private _waiting: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise((resolve) => {
      this._waiting.push(() => {
        this._locked = true;
        resolve();
      });
    });
  }

  release(): void {
    if (this._waiting.length > 0) {
      const next = this._waiting.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

// i18n: выбор локализованного значения из Record<string, V>
// Пример: pickLocalized({ en: 'Developer', ru: 'Разработчик' }, 'en') → 'Developer'

export function pickLocalized<V>(record: Record<string, V>, lang: string, fallbackLang = 'ru'): V | undefined {
  return record[lang] ?? record[fallbackLang] ?? undefined;
}

// --- Session title helpers ---

/** Дефольный заголовок новой сессии (en — системные сообщения ядра на en). */
const DEFAULT_TITLE = 'New session';
/** Легаси-варианты дефолтного заголовка (старые сессии в хранилище). */
const LEGACY_DEFAULT_TITLES = ['Новая сессия'];
/** Префиксы служебных дочерних сессий (текущий + легаси). */
const CHILD_TITLE_PREFIXES = ['Child session', 'Дочерняя сессия'];

export function isDefaultTitle(title?: string): boolean {
  if (!title) return true;
  return title === DEFAULT_TITLE
    || LEGACY_DEFAULT_TITLES.includes(title)
    || CHILD_TITLE_PREFIXES.some((p) => title.startsWith(p));
}

export function getForkedTitle(title?: string, existingTitles?: string[]): string {
  const base = title || DEFAULT_TITLE;
  const match = base.match(/^(.+) \(fork #(\d+)\)$/);
  const name = (match && match[1]) ? match[1] : base;
  let maxN = 0;
  if (existingTitles) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped} \\(fork #(\\d+)\\)$`);
    for (const t of existingTitles) {
      const m = t.match(regex);
      if (m && m[1]) maxN = Math.max(maxN, parseInt(m[1]));
    }
  }
  return `${name} (fork #${maxN + 1})`;
}

// --- Glob (permission patterns, ADR-029) ---

export { globMatch } from './glob.js';

// --- Workspace (ADR-075) ---

export { slugifyWorkspaceName, uniqueWorkspaceName, MAX_WORKSPACE_SLUG_LENGTH } from './workspace.js';

// --- Блоки рассуждений модели (общий хелпер UI и ядра) ---

export { appendReasoningBlock, type ReasoningBlock } from './reasoning.js';

// --- Part helpers ---

import type { MediaPartData, MediaPartType, Part, PartType } from '../types/index.js';
import type { ProfileStore } from '../interfaces/index.js';

export function makePart(type: PartType, data: unknown): Part {
  return { id: generateId(), type, data };
}

export function makeTextPart(text: string): Part {
  return makePart('text', text);
}

/**
 * ADR-115: медиа-часть вложения (ссылка на blob + метаданные).
 */
export function makeMediaPart(type: MediaPartType, data: MediaPartData): Part {
  return makePart(type, data);
}

/**
 * ADR-115: плейсхолдер медиа-части для строковых производных (`content`).
 *
 * Вложение обязано оставить след в тексте: иначе факт вложения «испаряется»
 * без ошибки (экспорт, поиск, PG-маппинг `messages.content`). Формат —
 * `[<type>: <name>]`, без имени — `[<type>]`.
 */
export function mediaPartPlaceholder(type: MediaPartType, data: unknown): string {
  const name =
    typeof data === 'object' && data !== null
      ? (data as { name?: unknown }).name
      : undefined;
  const label = typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
  return label ? `[${type}: ${label}]` : `[${type}]`;
}

/**
 * ADR-115: тип медиа-части по MIME.
 *
 * Совпадает с `partTypeOf` ядра (`engine/attachments/service.ts`) — композеру
 * нужен тот же маппинг, чтобы маркер в тексте совпал с серверным.
 */
export function mediaTypeOfMime(mime: string): MediaPartType {
  const normalized = mime.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * ADR-115: дописать в текст отсутствующие плейсхолдеры медиа-частей.
 *
 * Сервер строит `content` из частей, но маркер может прийти уже из композера
 * (пользователь набрал его сам или он был вставлен при прикреплении). Поэтому
 * добавляются только те плейсхолдеры, которых в тексте ещё нет — иначе один
 * файл дал бы два вхождения. Не-медиа части игнорируются; пустой текст не
 * получает ведущего перевода строки.
 */
export function appendMediaPlaceholders(text: string, parts: Part[]): string {
  let result = text;
  for (const part of parts) {
    if (
      part.type !== 'image' &&
      part.type !== 'audio' &&
      part.type !== 'video' &&
      part.type !== 'file'
    ) {
      continue;
    }
    const placeholder = mediaPartPlaceholder(part.type, part.data);
    if (result.includes(placeholder)) continue;
    result = result === '' ? placeholder : `${result}\n${placeholder}`;
  }
  return result;
}

export function buildContentFromParts(parts: Part[]): string {
  const chunks: string[] = [];
  for (const p of parts) {
    // ADR-115: медиа-часть (вложение) — плейсхолдер с именем файла. Если он уже
    // есть в тексте (маркер вставил композер или пользователь набрал вручную),
    // второй раз не добавляем — иначе строковая производная задвоит вложение.
    if (p.type === 'image' || p.type === 'audio' || p.type === 'video' || p.type === 'file') {
      const placeholder = mediaPartPlaceholder(p.type, p.data);
      if (chunks.join('\n').includes(placeholder)) continue;
      chunks.push(placeholder);
      continue;
    }
    if (p.type === 'text') {
      chunks.push(String(p.data ?? ''));
      continue;
    }
    if (p.type === 'reasoning') {
      chunks.push(`<reasoning>${String(p.data ?? '')}</reasoning>`);
      continue;
    }
    if (p.type === 'tool_use') {
      const d = p.data as Record<string, unknown>;
      chunks.push(`<tool_call name="${d.name ?? ''}">${JSON.stringify(d.args ?? {})}</tool_call>`);
      continue;
    }
    if (p.type === 'tool_result') {
      const d = p.data as Record<string, unknown>;
      const isError = d.isError ? ' error="true"' : '';
      chunks.push(`<tool_result${isError}>${String(d.content ?? '')}</tool_result>`);
      continue;
    }
    if (p.type === 'session_reference') {
      const d = p.data as Record<string, unknown>;
      const summary = d.autoSummary ?? d.auto_summary ?? '';
      chunks.push(`<session_reference session_id="${d.sessionId ?? d.session_id ?? ''}" label="${d.label ?? ''}">${String(summary)}</session_reference>`);
      continue;
    }
    chunks.push('');
  }
  return chunks.join('\n');
}

// --- Provider icon helpers (общие для core/backend роутеров провайдеров) ---

/** Favicon по origin базового URL провайдера; undefined — URL некорректен/пуст. */
export function getFaviconUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const origin = new URL(baseUrl).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

/** Представление иконки провайдера: заданная `icon` либо fallback на favicon. */
export function renderIcon(icon?: string, baseUrl?: string): { icon: string; icon_url?: string } {
  if (icon) return { icon };
  const fav = getFaviconUrl(baseUrl);
  return { icon: '', icon_url: fav };
}

// --- Author display name (статистика сессии) ---

/**
 * Резолвер отображаемого имени автора по профилю (displayName, fallback —
 * username). Без профилей возвращает undefined — потребитель подставит username.
 */
export function createResolveAuthorName(
  profilesStore?: ProfileStore,
): ((author: string) => Promise<string | null>) | undefined {
  if (!profilesStore) return undefined;
  return async (author: string): Promise<string | null> => {
    const profile = await profilesStore.getProfileByUsername(author);
    return profile ? profile.displayName || profile.username : null;
  };
}
