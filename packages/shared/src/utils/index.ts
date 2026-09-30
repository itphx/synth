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

// --- Glob (permission patterns, AD-029) ---

export { globMatch } from './glob.js';

// --- Workspace (AD-075) ---

export { slugifyWorkspaceName, uniqueWorkspaceName, MAX_WORKSPACE_SLUG_LENGTH } from './workspace.js';

// --- Part helpers ---

import type { Part, PartType } from '../types/index.js';
import type { ProfileStore } from '../interfaces/index.js';

export function makePart(type: PartType, data: unknown): Part {
  return { id: generateId(), type, data };
}

export function makeTextPart(text: string): Part {
  return makePart('text', text);
}

export function buildContentFromParts(parts: Part[]): string {
  return parts
    .map((p) => {
      if (p.type === 'text') return String(p.data ?? '');
      if (p.type === 'reasoning') return `<reasoning>${String(p.data ?? '')}</reasoning>`;
      if (p.type === 'tool_use') {
        const d = p.data as Record<string, unknown>;
        return `<tool_call name="${d.name ?? ''}">${JSON.stringify(d.args ?? {})}</tool_call>`;
      }
      if (p.type === 'tool_result') {
        const d = p.data as Record<string, unknown>;
        const isError = d.isError ? ' error="true"' : '';
        return `<tool_result${isError}>${String(d.content ?? '')}</tool_result>`;
      }
      if (p.type === 'session_reference') {
        const d = p.data as Record<string, unknown>;
        const summary = d.autoSummary ?? d.auto_summary ?? '';
        return `<session_reference session_id="${d.sessionId ?? d.session_id ?? ''}" label="${d.label ?? ''}">${String(summary)}</session_reference>`;
      }
      return '';
    })
    .join('\n');
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
