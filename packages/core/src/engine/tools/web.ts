import { z } from 'zod';
import { parse } from 'parse5';
import { ToolCapability } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, isAbortError, signalAborted, abortedResult } from './abort.js';

const MAX_RESPONSE_SIZE = 50_000;
const MAX_FETCH_URLS = 5;
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const BING_SEARCH_URL = 'https://www.bing.com/search';
const SEARCH_ATTEMPTS = 3;
const SEARCH_RETRY_DELAY_MS = 400;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
};

// ─── Парсинг DuckDuckGo HTML (без внешних зависимостей, через parse5) ───────

interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  value?: string;
}

function getAttr(node: P5Node, name: string): string | undefined {
  return node.attrs?.find((a) => a.name === name)?.value;
}

function hasClass(node: P5Node, className: string): boolean {
  const cls = getAttr(node, 'class');
  return cls?.split(/\s+/).includes(className) ?? false;
}

function textContent(node: P5Node | undefined): string {
  if (!node) return '';
  if (node.value !== undefined) return node.value;
  let out = '';
  for (const child of node.childNodes ?? []) {
    out += textContent(child);
  }
  return out;
}

function walk(node: P5Node | undefined, visit: (n: P5Node) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes ?? []) {
    walk(child, visit);
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
}

export function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const doc = parse(html) as unknown as P5Node;

  const resultBlocks: P5Node[] = [];
  walk(doc, (n) => {
    if (n.tagName === 'div' && hasClass(n, 'result')) {
      resultBlocks.push(n);
    }
  });

  const results: SearchResult[] = [];
  for (const block of resultBlocks) {
    if (results.length >= limit) break;

    let titleEl: P5Node | undefined;
    let snippetEl: P5Node | undefined;
    let urlEl: P5Node | undefined;

    walk(block, (n) => {
      if (!titleEl && n.tagName === 'a' && hasClass(n, 'result__a')) titleEl = n;
      if (!snippetEl && n.tagName === 'a' && hasClass(n, 'result__snippet')) snippetEl = n;
      if (!urlEl && n.tagName && hasClass(n, 'result__url')) urlEl = n;
    });

    if (!titleEl) continue;

    const title = textContent(titleEl).replace(/\s+/g, ' ').trim();
    let url = getAttr(titleEl, 'href') ?? '';
    if (url.startsWith('//')) url = 'https:' + url;

    const snippet = textContent(snippetEl).replace(/\s+/g, ' ').trim();
    const displayUrl = textContent(urlEl).replace(/\s+/g, ' ').trim() || url;

    results.push({ title, url, snippet, displayUrl });
  }

  return results;
}

function isDdgChallenge(html: string, status: number): boolean {
  if (status === 202 || status === 429) return true;
  const lower = html.toLowerCase();
  return lower.includes('complete the following challenge')
    || lower.includes('bots use duckduckgo')
    || (status === 403 && lower.includes('tor'));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Связать внешний AbortSignal («Стоп» сессии) с локальным таймаут-контроллером:
 * при внешнем abort локальный контроллер тоже абортируется, fetch прерывается.
 * Возвращает функцию снятия подписки.
 */
function linkSignal(controller: AbortController, external?: AbortSignal): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

async function duckDuckGoSearch(query: string, limit: number, abortSignal?: AbortSignal, attempts = SEARCH_ATTEMPTS): Promise<SearchResult[]> {
  let lastError = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    // «Стоп» пришёл между попытками — ретраи не выполняем
    if (signalAborted(abortSignal)) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const unlink = linkSignal(controller, abortSignal);

    try {
      const response = await fetch(DDG_SEARCH_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ q: query }),
      });

      const html = await response.text();

      if (isDdgChallenge(html, response.status)) {
        lastError = 'DuckDuckGo временно блокирует запросы (anti-bot challenge)';
        continue;
      }

      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`;
        continue;
      }

      return parseDuckDuckGoResults(html, limit);
    } catch (err: unknown) {
      lastError = (err as Error).message || String(err);
    } finally {
      clearTimeout(timer);
      unlink();
    }

    await sleep(SEARCH_RETRY_DELAY_MS);
  }
  throw new Error(lastError || 'Не удалось получить результаты от DuckDuckGo');
}

// ─── Парсинг Bing HTML (fallback для web_search) ────────────────────────────

export function parseBingResults(html: string, limit: number): SearchResult[] {
  const doc = parse(html) as unknown as P5Node;

  const resultBlocks: P5Node[] = [];
  walk(doc, (n) => {
    if (n.tagName === 'li' && hasClass(n, 'b_algo')) {
      resultBlocks.push(n);
    }
  });

  const results: SearchResult[] = [];
  for (const block of resultBlocks) {
    if (results.length >= limit) break;

    let titleEl: P5Node | undefined;
    let snippetEl: P5Node | undefined;
    let citeEl: P5Node | undefined;

    walk(block, (n) => {
      if (!titleEl && n.tagName === 'h2') titleEl = n;
      if (!snippetEl && n.tagName === 'p') snippetEl = n;
      if (!citeEl && n.tagName === 'cite') citeEl = n;
    });

    if (!titleEl) continue;
    const linkEl = titleEl.childNodes?.find((n) => n.tagName === 'a');

    const title = textContent(titleEl).replace(/\s+/g, ' ').trim();
    const href = linkEl ? getAttr(linkEl, 'href') ?? '' : '';
    const displayUrl = textContent(citeEl).replace(/\s+/g, ' ').trim();
    const snippet = textContent(snippetEl).replace(/\s+/g, ' ').trim();

    const url = displayUrl || href || '';
    results.push({ title, url, snippet, displayUrl });
  }

  return results;
}

async function bingSearch(query: string, limit: number, abortSignal?: AbortSignal): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const unlink = linkSignal(controller, abortSignal);

  try {
    const url = `${BING_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${limit}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: BROWSER_HEADERS,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    return parseBingResults(html, limit);
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  const parts = results.map((r) => {
    const lines = [`**${r.title}**`];
    if (r.snippet) lines.push(r.snippet);
    lines.push(r.displayUrl || r.url);
    return lines.join('\n');
  });

  return `Результаты поиска «${query}» (${results.length}):\n\n${parts.join('\n\n')}`;
}

// ─── Очистка HTML для web_fetch ─────────────────────────────────────────────

const _INLINE_SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const _INLINE_STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const _NOSCRIPT_RE = /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi;
const _STRIP_TAGS_RE = /<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi;

const SPA_INDICATORS = ['<div id="root"', '<div id="app"', 'window.__', 'webpack', '__NEXT', '__NUXT', 'react-dom', 'vue'];

function detectSpa(content: string): boolean {
  const lower = content.toLowerCase();
  return SPA_INDICATORS.some((ind) => lower.includes(ind));
}

function cleanHtml(html: string): string {
  let cleaned = html.replace(_INLINE_SCRIPT_RE, '');
  cleaned = cleaned.replace(_INLINE_STYLE_RE, '');
  cleaned = cleaned.replace(_NOSCRIPT_RE, '');
  cleaned = cleaned.replace(_STRIP_TAGS_RE, '');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/&nbsp;/gi, ' ');
  cleaned = cleaned.replace(/\s{3,}/g, '\n\n').trim();
  return cleaned;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  return 'https://' + trimmed;
}

// ─── Тулы ────────────────────────────────────────────────────────────────────

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch content from URLs and convert to readable text. Supports up to 5 URLs at once. '
    + 'Use this to retrieve and analyze web content.',
  parameters: z.object({
    url: z.string().optional().describe('The URL to fetch content from'),
    urls: z.array(z.string()).max(MAX_FETCH_URLS).optional()
      .describe(`Multiple URLs to fetch (up to ${MAX_FETCH_URLS}). Takes priority over "url".`),
    format: z.enum(['text', 'markdown', 'html']).optional().default('markdown')
      .describe('The format to return the content in (default: markdown)'),
    timeout: z.number().int().min(1).max(120).optional().describe('Timeout per URL in seconds (max 120)'),
  }),
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — fetch не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as {
      url?: string;
      urls?: string[];
      format?: 'text' | 'markdown' | 'html';
      timeout?: number;
    };

    const rawUrls = params.urls && params.urls.length > 0 ? params.urls : (params.url ? [params.url] : []);
    if (rawUrls.length === 0) {
      return { content: `Ошибка аргументов инструмента "${this.name}": укажите url или urls`, isError: true };
    }
    // AD-036: деобфускация в точке потребления — URL может содержать ⟦SYNTH_SECRET_N⟧
    const restoredUrls = await Promise.all(rawUrls.map((u) => deobfuscateText(ctx, u)));
    const urls = restoredUrls.slice(0, MAX_FETCH_URLS).map(normalizeUrl);
    const timeoutMs = (params.timeout ?? 30) * 1000;

    const blocks: string[] = [];

    for (const url of urls) {
      // «Стоп» пришёл между URL — оставшиеся не загружаем
      if (isAborted(ctx)) return abortedResult(this.name, blocks.join('\n\n---\n\n') || undefined);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const unlink = linkSignal(controller, ctx.abortSignal);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: BROWSER_HEADERS,
        });
        clearTimeout(timer);
        unlink();

        if (!response.ok) {
          blocks.push(`### ${url}\n\n❌ HTTP ${response.status} ${response.statusText}`);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();
        let content: string;

        if (contentType.includes('application/json')) {
          content = rawText;
          try {
            content = JSON.stringify(JSON.parse(rawText), null, 2);
          } catch {
            content = rawText;
          }
        } else if (contentType.includes('text/html') && params.format !== 'html') {
          content = cleanHtml(rawText);
          const isSpa = detectSpa(rawText);
          const textRatio = content.length / Math.max(rawText.length, 1);
          if (isSpa) {
            content += '\n\n⚠️ Сайт использует JavaScript-фреймворк — часть контента может быть недоступна без выполнения JS.';
          } else if (textRatio < 0.02) {
            content += '\n\n⚠️ На странице очень мало текстового контента (возможно, JavaScript-рендеринг).';
          }
        } else {
          content = rawText;
        }

        if (content.length > MAX_RESPONSE_SIZE) {
          content = content.slice(0, MAX_RESPONSE_SIZE) + '\n... (содержимое обрезано)';
        }

        blocks.push(`### ${url}\n\n${content}`);
      } catch (err: unknown) {
        clearTimeout(timer);
        unlink();
        const error = err as Error;
        if (isAbortError(err) && isAborted(ctx)) {
          // «Стоп» — единый маркер прерывания + частичные блоки
          return abortedResult(this.name, blocks.join('\n\n---\n\n') || undefined);
        }
        if (error.name === 'AbortError') {
          blocks.push(`### ${url}\n\n❌ Таймаут`);
        } else {
          blocks.push(`### ${url}\n\n❌ Ошибка загрузки: ${error.message || String(err)}`);
        }
      }
    }

    if (blocks.length === 0) {
      return { content: 'Не удалось загрузить ни один URL', isError: true };
    }

    return {
      content: blocks.join('\n\n---\n\n'),
      metadata: { urls, count: urls.length },
    };
  },
};

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for information using DuckDuckGo (no API key required). '
    + 'Returns up to 10 results with title, snippet and URL.',
  parameters: z.object({
    query: z.string().describe('Search query'),
    max_results: z.number().int().min(1).max(20).optional().default(10)
      .describe('Maximum number of results (default: 10)'),
  }),
  capabilities: [ToolCapability.WEB],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — поиск не выполняется (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args);
    if (!parsed.success) {
      return { content: `Ошибка аргументов инструмента "${this.name}": ${parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`, isError: true };
    }
    const params = parsed.data as { query: string; max_results?: number };
    const limit = params.max_results ?? 10;

    // AD-036: деобфускация в точке потребления — запрос может содержать ⟦SYNTH_SECRET_N⟧
    const query = await deobfuscateText(ctx, params.query);

    try {
      try {
        const results = await duckDuckGoSearch(query, limit, ctx.abortSignal);
        if (results.length > 0) {
          return { content: formatSearchResults(query, results), metadata: { query: params.query, max_results: limit, source: 'duckduckgo' } };
        }
      } catch (err: unknown) {
        // «Стоп» — фолбэк на Bing не выполняем
        if (signalAborted(ctx.abortSignal)) return abortedResult(this.name);
        // DDG заблокирован или недоступен — пробуем Bing
        try {
          const results = await bingSearch(query, limit, ctx.abortSignal);
          if (results.length > 0) {
            return { content: formatSearchResults(query, results), metadata: { query: params.query, max_results: limit, source: 'bing' } };
          }
        } catch {
          throw err;
        }
      }
      return { content: `По запросу «${query}» ничего не найдено.`, metadata: { query: params.query, max_results: limit } };
    } catch (err: unknown) {
      // «Стоп» — единый маркер прерывания, а не «ошибка веб-поиска»
      if (signalAborted(ctx.abortSignal)) return abortedResult(this.name);
      return {
        content: `Ошибка веб-поиска: ${(err as Error).message || String(err)}`,
        isError: true,
        metadata: { query: params.query },
      };
    }
  },
};
