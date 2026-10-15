import { z } from 'zod';
import { parse } from 'parse5';
import { ToolCapability, DEFAULT_MCP_PRIVATE_CIDRS } from '@itphx/synth-shared';
import type { ToolDefinition } from '@itphx/synth-shared';
import { deobfuscateText } from './obfuscation.js';
import { isAborted, isAbortError, signalAborted, abortedResult } from './abort.js';
import { evaluateMcpNetworkAccess } from '../mcp/network-policy.js';
import type { HostResolver } from '../mcp/network-policy.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

const MAX_RESPONSE_SIZE = 50_000;
const MAX_FETCH_URLS = 5;
/** Лимит редиректов web_fetch: каждый хоп отдельно проверяется SSRF-политикой. */
const MAX_REDIRECTS = 5;
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
        lastError = sm('web.duckduckgo_blocked');
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
  throw new Error(lastError || sm('web.search_failed'));
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

  return sm('web.search_results', { query, count: String(results.length), items: parts.join('\n\n') });
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

// ─── SSRF-политика web_fetch (ADR-071 §2.3.1, переиспользование MCP-политики) ─

/** Политика: запрет private/loopback/link-local (в т.ч. `169.254.169.254`). */
const PRIVATE_NETWORK_POLICY = {
  mode: 'deny' as const,
  list: [...DEFAULT_MCP_PRIVATE_CIDRS],
};

/**
 * Инъекция DNS-резолвера (тесты). По умолчанию — системный `dns.lookup` через
 * `evaluateMcpNetworkAccess`. Экспорт — только для тестового сьюта.
 */
let _hostResolver: HostResolver | undefined;

/** Тестовый seam: подмена DNS-резолвера SSRF-проверки web_fetch. */
export function _setWebFetchHostResolver(resolver: HostResolver | undefined): void {
  _hostResolver = resolver;
}

/** Ошибка сетевой политики web_fetch (SSRF): URL/хоп запрещён. */
class WebFetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchBlockedError';
  }
}

/**
 * Проверяет URL по SSRF-политике: только `http(s)` и адрес не из приватных
 * диапазонов. DNS-резолв — через `evaluateMcpNetworkAccess` (ADR-071).
 */
async function ensureUrlAllowed(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebFetchBlockedError(`Некорректный URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebFetchBlockedError(`Недопустимая схема URL: ${parsed.protocol}`);
  }
  const check = await evaluateMcpNetworkAccess(url, PRIVATE_NETWORK_POLICY, {
    resolveHost: _hostResolver,
  });
  if (!check.allowed) {
    throw new WebFetchBlockedError(check.reason ?? `Адрес запрещён сетевой политикой: ${url}`);
  }
}

/**
 * fetch с отключёнными автопереходами: каждый редирект проверяется политикой
 * (не более MAX_REDIRECTS хопов). `redirect: 'manual'` не даёт уйти на приватный
 * адрес в обход проверки.
 */
async function fetchWithSsrfGuard(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await ensureUrlAllowed(current);
    const response = await fetch(current, {
      signal,
      headers: BROWSER_HEADERS,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new WebFetchBlockedError(sm('web.too_many_redirects'));
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
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const params = parsed.data as {
      url?: string;
      urls?: string[];
      format?: 'text' | 'markdown' | 'html';
      timeout?: number;
    };

    const rawUrls = params.urls && params.urls.length > 0 ? params.urls : (params.url ? [params.url] : []);
    if (rawUrls.length === 0) {
      return { content: sm('tool.args_error', { tool: this.name, issues: sm('web.fetch_args_url_required') }), isError: true, metadata: { i18n: i18nMeta('web.fetch_args_url_required') } };
    }
    // ADR-036: деобфускация в точке потребления — URL может содержать ⟦SYNTH_SECRET_N⟧
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
        const response = await fetchWithSsrfGuard(url, controller.signal);
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
            content += sm('web.js_framework_warning');
          } else if (textRatio < 0.02) {
            content += sm('web.low_content_warning');
          }
        } else {
          content = rawText;
        }

        if (content.length > MAX_RESPONSE_SIZE) {
          content = content.slice(0, MAX_RESPONSE_SIZE) + sm('web.content_truncated');
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
          blocks.push(`### ${url}\n\n${sm('web.block_timeout')}`);
        } else if (error instanceof WebFetchBlockedError) {
          blocks.push(`### ${url}\n\n${sm('web.ssrf_blocked', { reason: error.message })}`);
        } else {
          blocks.push(`### ${url}\n\n${sm('web.block_error', { error: error.message || String(err) })}`);
        }
      }
    }

    if (blocks.length === 0) {
      return { content: sm('web.fetch_all_failed'), isError: true, metadata: { i18n: i18nMeta('web.fetch_all_failed') } };
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
      return { content: sm('tool.args_error', { tool: this.name, issues: parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ') }), isError: true, metadata: { i18n: i18nMeta('tool.args_error', { tool: this.name }) } };
    }
    const params = parsed.data as { query: string; max_results?: number };
    const limit = params.max_results ?? 10;

    // ADR-036: деобфускация в точке потребления — запрос может содержать ⟦SYNTH_SECRET_N⟧
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
      return { content: sm('web.no_results', { query }), metadata: { query: params.query, max_results: limit, i18n: i18nMeta('web.no_results', { query }) } };
    } catch (err: unknown) {
      // «Стоп» — единый маркер прерывания, а не «ошибка веб-поиска»
      if (signalAborted(ctx.abortSignal)) return abortedResult(this.name);
      return {
        content: sm('web.search_error', { error: (err as Error).message || String(err) }),
        isError: true,
        metadata: { query: params.query },
      };
    }
  },
};
