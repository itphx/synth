import { Hono } from 'hono';
import type { createMiddleware } from 'hono/factory';
import {
  DictionaryContentError,
  DICTIONARY_MAX_KEYWORDS,
  DICTIONARY_MAX_TOOLS,
} from '../../engine/router/dictionary-store.js';
import type { DictionaryStore, StoredDictionary } from '../../engine/router/dictionary-store.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface DictionaryRoutesAuth {
  requireAuth: Middleware;
}

export interface DictionaryRoutesOptions {
  /**
   * Guard для PUT/DELETE. В backend — requireAdmin (как в users.ts),
   * в core — requireAuth (локальный режим, по умолчанию).
   */
  writeGuard?: Middleware;
}

const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Словарь + действующее содержимое (YAML) и его размер в байтах. */
function withContent(store: DictionaryStore, dictionary: StoredDictionary) {
  const content = store.getContent(dictionary.category, dictionary.language);
  return {
    ...dictionary,
    content,
    size: Buffer.byteLength(content, 'utf8'),
  };
}

/** Триммит, отбрасывает пустые, дедуплицирует; null — если не массив строк. */
function normalizeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Валидация :category/:lang. Возвращает текст ошибки либо null. */
function validateTarget(store: DictionaryStore, category: string, language: string): string | null {
  if (!CATEGORY_PATTERN.test(category) || category.includes('..')) {
    return 'Некорректная категория словаря';
  }
  if (!store.isKnownCategory(category)) {
    return `Неизвестная категория словаря: ${category}`;
  }
  if (!store.isValidLanguage(language)) {
    return 'Язык словаря должен быть ru или en';
  }
  return null;
}

/**
 * API управления словарями классификации (AD-034/AD-035).
 *
 * GET    /api/v2/dictionaries               — список всех словарей.
 * GET    /api/v2/dictionaries/:category/:lang — словарь с признаком источника.
 * GET    — словарь отдаётся с действующим содержимым (content) и размером (size).
 * PUT    /api/v2/dictionaries/:category/:lang — записать переопределение:
 *          { content: string } (YAML-текст) либо { keywords, tools } (совместимость).
 * DELETE /api/v2/dictionaries/:category/:lang — сбросить к системному словарю.
 *
 * Модуль один и тот же в core (standalone) и backend (managed): отличается
 * только writeGuard (backend — requireAdmin, core — requireAuth).
 */
export function createDictionaryRoutes(
  auth: DictionaryRoutesAuth,
  store: DictionaryStore,
  opts: DictionaryRoutesOptions = {},
): Hono {
  const app = new Hono();
  const writeGuard = opts.writeGuard ?? auth.requireAuth;

  app.get('/', auth.requireAuth, (c) => {
    return c.json({ dictionaries: store.listDictionaries().map((d) => withContent(store, d)) });
  });

  app.get('/:category/:lang', auth.requireAuth, (c) => {
    const category = c.req.param('category');
    const language = c.req.param('lang');

    const error = validateTarget(store, category, language);
    if (error) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: error } }, 400);
    }

    const dictionary = store.getDictionary(category, language);
    if (!dictionary) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Словарь не найден' } }, 404);
    }
    return c.json({ dictionary: withContent(store, dictionary) });
  });

  app.put('/:category/:lang', writeGuard, async (c) => {
    const category = c.req.param('category');
    const language = c.req.param('lang');

    const targetError = validateTarget(store, category, language);
    if (targetError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: targetError } }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      content?: unknown;
      keywords?: unknown;
      tools?: unknown;
    };

    // Основной вариант (UI): YAML-текст действующего содержимого.
    if (body.content !== undefined) {
      if (typeof body.content !== 'string') {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: 'content: ожидается строка' },
        }, 400);
      }
      let dictionary: StoredDictionary | null;
      try {
        dictionary = await store.saveUserContent(category, language, body.content);
      } catch (err) {
        if (err instanceof DictionaryContentError) {
          return c.json({ error: { code: 'VALIDATION_ERROR', message: err.message } }, 400);
        }
        throw err;
      }
      if (!dictionary) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: 'Не удалось сохранить словарь' },
        }, 400);
      }
      return c.json({ status: 'ok', dictionary: withContent(store, dictionary) });
    }

    // Совместимость со старым форматом { keywords, tools }.
    const keywords = normalizeList(body.keywords);
    if (!keywords) {
      return c.json({
        error: { code: 'VALIDATION_ERROR', message: 'keywords: ожидается массив строк' },
      }, 400);
    }
    if (keywords.length > DICTIONARY_MAX_KEYWORDS) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `keywords: не более ${DICTIONARY_MAX_KEYWORDS} слов`,
        },
      }, 400);
    }

    let tools: string[] | undefined;
    if (body.tools !== undefined) {
      const normalized = normalizeList(body.tools);
      if (!normalized) {
        return c.json({
          error: { code: 'VALIDATION_ERROR', message: 'tools: ожидается массив строк' },
        }, 400);
      }
      if (normalized.length > DICTIONARY_MAX_TOOLS) {
        return c.json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `tools: не более ${DICTIONARY_MAX_TOOLS} элементов`,
          },
        }, 400);
      }
      tools = normalized;
    }

    const dictionary = await store.saveUserDictionary(category, language, { keywords, tools });
    if (!dictionary) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Не удалось сохранить словарь' } }, 400);
    }

    return c.json({
      status: 'ok',
      dictionary: withContent(store, { ...dictionary, source: 'user' as const }),
    });
  });

  app.delete('/:category/:lang', writeGuard, async (c) => {
    const category = c.req.param('category');
    const language = c.req.param('lang');

    const targetError = validateTarget(store, category, language);
    if (targetError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: targetError } }, 400);
    }

    const dictionary = await store.deleteUserDictionary(category, language);
    if (!dictionary) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Словарь не найден' } }, 404);
    }

    return c.json({ status: 'ok', dictionary: withContent(store, dictionary) });
  });

  return app;
}
