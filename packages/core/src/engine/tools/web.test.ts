import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseDuckDuckGoResults, parseBingResults, webSearchTool, webFetchTool, _setWebFetchHostResolver } from './web.js';
import { configureEgressRuntime, resetEgressRuntime } from '../net/egress-runtime.js';
import { attachmentsConfigSchema } from '@itphx/synth-shared';
import type { AttachmentsConfig, ToolContext } from '@itphx/synth-shared';
import { AttachmentService } from '../attachments/service.js';
import { MemoryBlobStore } from '../../storage/memory/content.js';

// Тестовый DNS-резолвер SSRF-проверки web_fetch: все хосты, кроме localhost,
// считаются публичными (иначе проверка уйдёт в реальный DNS и заблокирует
// фейковые домены тестов).
beforeEach(() => {
  _setWebFetchHostResolver(async (host) => (host === 'localhost' ? ['127.0.0.1'] : ['93.184.216.34']));
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    messageId: 'm1',
    workingDir: '/tmp',
    ...overrides,
  };
}

/** fetch-мок, висящий вечно, пока не придёт abort — имитация медленного сервера. */
function hangingFetchMock() {
  return vi.fn((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  }));
}

function initToBody(init?: RequestInit): URLSearchParams {
  return init?.body as URLSearchParams;
}

// Типовая структура HTML-страницы результатов DuckDuckGo (html.duckduckgo.com)
const DDG_HTML_FIXTURE = `<!DOCTYPE html>
<html><head><title>test — DuckDuckGo</title></head><body>
<div id="links">
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&amp;rut=abc123">Example <b>Domain</b></a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination.</a>
      <div class="result__extras">
        <div class="result__url">example.com</div>
      </div>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.iana.org%2Fdomains%2Freserved">IANA — IANA-managed Reserved Domains</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.iana.org%2Fdomains%2Freserved">Example domains as described in RFC 2606.</a>
      <div class="result__extras">
        <div class="result__url">www.iana.org</div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

// Страница-капча DuckDuckGo (anti-bot challenge, HTTP 202)
const DDG_CHALLENGE_FIXTURE = `<!DOCTYPE html>
<html lang="en"><head><title>DuckDuckGo</title></head><body>
<h1>DuckDuckGo</h1>
<p>Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human. Select all squares containing a duck:</p>
<form><input type="submit" value="Submit"></form>
</body></html>`;

// Типовая структура HTML-страницы результатов Bing (www.bing.com/search)
const BING_HTML_FIXTURE = `<!DOCTYPE html>
<html><head><title>synth — Bing</title></head><body>
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&&p=abc123">Example <b>Domain</b> on Bing</a></h2>
    <div class="b_caption">
      <cite>https://example.com</cite>
      <p>This domain is for use in illustrative examples in documents.</p>
    </div>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.bing.com/ck/a?!&&p=def456">IANA — IANA-managed Reserved Domains</a></h2>
    <div class="b_caption">
      <cite>https://www.iana.org/domains/reserved</cite>
      <p>Example domains as described in RFC 2606.</p>
    </div>
  </li>
</ol>
</body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
  _setWebFetchHostResolver(undefined);
  resetEgressRuntime();
});

describe('parseDuckDuckGoResults', () => {
  it('извлекает title, url, snippet и displayUrl из HTML', () => {
    const results = parseDuckDuckGoResults(DDG_HTML_FIXTURE, 10);

    expect(results).toHaveLength(2);

    expect(results[0]!.title).toBe('Example Domain');
    expect(results[0]!.url).toBe('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=abc123');
    expect(results[0]!.snippet).toContain('This domain is for use in illustrative examples');
    expect(results[0]!.displayUrl).toBe('example.com');

    expect(results[1]!.title).toBe('IANA — IANA-managed Reserved Domains');
    expect(results[1]!.displayUrl).toBe('www.iana.org');
  });

  it('соблюдает лимит количества результатов', () => {
    const results = parseDuckDuckGoResults(DDG_HTML_FIXTURE, 1);
    expect(results).toHaveLength(1);
  });

  it('возвращает пустой массив для HTML без результатов', () => {
    expect(parseDuckDuckGoResults('<html><body><p>no results</p></body></html>', 10)).toEqual([]);
  });
});

describe('parseBingResults', () => {
  it('извлекает title, url, snippet и displayUrl из HTML', () => {
    const results = parseBingResults(BING_HTML_FIXTURE, 10);

    expect(results).toHaveLength(2);

    expect(results[0]!.title).toBe('Example Domain on Bing');
    expect(results[0]!.url).toBe('https://example.com');
    expect(results[0]!.displayUrl).toBe('https://example.com');
    expect(results[0]!.snippet).toContain('This domain is for use in illustrative examples');

    expect(results[1]!.title).toBe('IANA — IANA-managed Reserved Domains');
    expect(results[1]!.url).toBe('https://www.iana.org/domains/reserved');
  });

  it('соблюдает лимит количества результатов', () => {
    const results = parseBingResults(BING_HTML_FIXTURE, 1);
    expect(results).toHaveLength(1);
  });

  it('возвращает пустой массив для HTML без результатов', () => {
    expect(parseBingResults('<html><body><p>no results</p></body></html>', 10)).toEqual([]);
  });
});

describe('webSearchTool', () => {
  it('выполняет поиск через DuckDuckGo и форматирует результаты', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(DDG_HTML_FIXTURE, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.execute({ query: 'example domain' }, {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: '/tmp',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Search results for "example domain" (2):');
    expect(result.content).toContain('**Example Domain**');
    expect(result.content).toContain('example.com');

    const body = initToBody(fetchMock.mock.calls[0]![1]);
    expect(body.get('q')).toBe('example domain');
  });

  it('возвращает ошибку при сетевом сбое', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const result = await webSearchTool.execute({ query: 'test' }, {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: '/tmp',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('network down');
  });

  it('переключается на Bing, если DuckDuckGo отдаёт anti-bot challenge', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('html.duckduckgo.com')) {
        return new Response(DDG_CHALLENGE_FIXTURE, { status: 202, headers: { 'content-type': 'text/html' } });
      }
      return new Response(BING_HTML_FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.execute({ query: 'example domain' }, {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: '/tmp',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Example Domain on Bing');
    expect(result.metadata).toMatchObject({ source: 'bing' });
  });

  it('сообщает об ошибке, если DuckDuckGo и Bing недоступны', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('html.duckduckgo.com')) {
        return new Response(DDG_CHALLENGE_FIXTURE, { status: 202, headers: { 'content-type': 'text/html' } });
      }
      return new Response('Server Error', { status: 500, headers: { 'content-type': 'text/plain' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.execute({ query: 'test' }, {
      sessionId: 's1',
      messageId: 'm1',
      workingDir: '/tmp',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('anti-bot');
  });
});

describe('webFetchTool', () => {
  it('exception-hostname разрешает адрес из 10.0.0.0/8', async () => {
    _setWebFetchHostResolver(async (host) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']));
    configureEgressRuntime({
      resolver: {
        resolveTools: async () => ({
          mode: 'deny',
          list: ['10.0.0.0/8'],
          exceptions: ['internal.example'],
        }),
      },
    });
    const fetchMock = vi.fn(async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute({ url: 'https://internal.example/x' }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('без exception приватный адрес блокируется (fetch не вызывается)', async () => {
    _setWebFetchHostResolver(async () => ['10.0.0.5']);
    configureEgressRuntime({
      resolver: {
        resolveTools: async () => ({ mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] }),
      },
    });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute({ url: 'https://internal.example/x' }, makeCtx());

    expect(result.content).toMatch(/заблокирован|blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('обрабатывает несколько URL и изолирует ошибки per-URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === 'https://ok.example') {
        return Promise.resolve(new Response('<html><body><h1>Hello</h1><p><b>world</b></p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'https://ok.example', urls: ['https://ok.example', 'https://broken.example'] },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('### https://ok.example');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('❌ HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('очищает HTML: убирает script/style и схлопывает пустые строки', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><head><style>body{color:red}</style></head><body><script>alert(1)</script><p>Text</p><p>More</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    )));

    const result = await webFetchTool.execute(
      { url: 'https://page.example' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(result.content).not.toContain('alert(1)');
    expect(result.content).not.toContain('color:red');
    expect(result.content).toContain('Text');
    expect(result.content).toContain('More');
  });

  it('поддерживает вызов только с urls (без url)', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { urls: ['https://one.example', 'https://two.example'] },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.metadata?.count).toBe(2);
  });

  it('возвращает ошибку, если не указаны ни url, ни urls', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      {},
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('specify url or urls');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('нормализует URL без схемы', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'example.com' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledWith('https://example.com', expect.anything());
    expect(result.content).toContain('### https://example.com');
  });

  it('SSRF: приватный/loopback адрес блокируется без сетевого вызова', async () => {
    const fetchMock = vi.fn(async () => new Response('secret', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { urls: ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data', 'http://localhost/x'] },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.content).toContain('Blocked by the network policy');
  });

  it('SSRF: не-http(s) схема блокируется', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'ftp://example.com/x' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.content).toContain('Blocked by the network policy');
  });

  it('SSRF: редирект на приватный адрес блокируется (хоп не выполняется)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://public.example/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/internal' },
        });
      }
      return new Response('should-not-be-fetched', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'https://public.example/start' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('Blocked by the network policy');
    expect(result.content).not.toContain('should-not-be-fetched');
  });

  it('SSRF: публичный редирект отслеживается с ручным режимом', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === 'https://public.example/start') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://public.example/final' },
        });
      }
      if (String(url) === 'https://public.example/final') {
        return new Response('<html><body>Final page</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'https://public.example/start' },
      { sessionId: 's1', messageId: 'm1', workingDir: '/tmp' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Final page');
    // Автопереходы отключены — редиректы обрабатываются вручную.
    expect(fetchMock.mock.calls.every((call) => ((call as unknown[])[1] as RequestInit | undefined)?.redirect === 'manual')).toBe(true);
  });
});

describe('web tools — прерывание по «Стоп» (abortSignal)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('web_fetch: abort во время fetch — tool_result содержит маркер прерывания', async () => {
    const fetchMock = hangingFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    const promise = webFetchTool.execute({ url: 'https://slow.example' }, makeCtx({ abortSignal: ac.signal }));

    // Даём fetch начаться, затем «Стоп»
    await new Promise((resolve) => setTimeout(resolve, 50));
    ac.abort();

    const result = await promise;

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<status>stopped_by_user</status>');
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('web_fetch: pre-aborted — fetch не вызывается, мгновенный маркер прерывания', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    ac.abort();

    const result = await webFetchTool.execute(
      { url: 'https://example.com' },
      makeCtx({ abortSignal: ac.signal }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
  });

  it('web_fetch: при abort после первого URL — прерывание с частичными блоками', async () => {
    // Первый URL отвечает быстро, второй висит до «Стопа»
    const hanging = hangingFetchMock();
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('https://fast.example')) {
        return Promise.resolve(new Response('fast page', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }));
      }
      return hanging(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    const promise = webFetchTool.execute(
      { urls: ['https://fast.example', 'https://slow.example'] },
      makeCtx({ abortSignal: ac.signal }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    ac.abort();

    const result = await promise;

    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    // Частичный результат: успевший URL — в partial_output
    expect(result.metadata?.partial_output).toContain('fast page');
  });

  it('web_search: abort во время DuckDuckGo — фолбэк на Bing не выполняется, маркер прерывания', async () => {
    const fetchMock = hangingFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    const promise = webSearchTool.execute({ query: 'test' }, makeCtx({ abortSignal: ac.signal }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    ac.abort();

    const result = await promise;

    expect(result.metadata?.stopped_by).toBe('user');
    expect(result.metadata?.interrupted).toBe(true);
    // Только DuckDuckGo вызван — Bing после «Стопа» не дёргается
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('duckduckgo');
  });

  it('web_search: pre-aborted — fetch не вызывается', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    ac.abort();

    const result = await webSearchTool.execute({ query: 'test' }, makeCtx({ abortSignal: ac.signal }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata?.interrupted).toBe(true);
  });
});

// ─── ADR-115 §«Медиа из инструментов»: web_fetch + include_media ────────────
//
// Проверяем шов «тул → ссылка на blob»: медиа читается стримом с капом, байты
// уходят в `AttachmentService.upload`, а в результат — `attachments[]`.
// Текстовые ветки (отказы) не роняют вызов и не тянут тело ответа.

/** PNG-сигнатура + полезная нагрузка: сервис определяет MIME по содержимому. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-body-for-web-fetch'),
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

interface AttachmentsEnv {
  service: AttachmentService;
  upload: ReturnType<typeof vi.spyOn>;
  config: AttachmentsConfig;
}

/** Сервис вложений на in-memory blob-порте с live-конфигом. */
function makeAttachmentsEnv(overrides: Partial<AttachmentsConfig> = {}): AttachmentsEnv {
  const blobs = new MemoryBlobStore();
  const config: AttachmentsConfig = { ...attachmentsConfigSchema.parse({}), ...overrides };
  const service = new AttachmentService({ blobs, config: () => config });
  const upload = vi.spyOn(service, 'upload');
  return { service, upload, config };
}

/** Контекст web_fetch с сервисом вложений (как упаковывает оркестратор). */
function mediaCtx(env: AttachmentsEnv, overrides: Partial<ToolContext> = {}): ToolContext {
  return makeCtx({
    extra: {
      attachmentService: env.service,
      attachmentsConfig: () => env.config,
    },
    ...overrides,
  });
}

/** Ответ с бинарным телом и заголовками. */
function binaryResponse(bytes: Buffer, mime: string, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': mime, 'content-length': String(bytes.length), ...headers },
  });
}

/**
 * Ответ с потоковым телом и шпионом на `body.getReader`: `Response` может
 * заранее подтянуть чанк в буфер, поэтому «тело не читалось» проверяем по
 * обращению к читателю, а не по счётчику `pull` источника.
 */
function streamResponse(
  bytes: Buffer,
  mime: string,
  headers: Record<string, string> = {},
): { response: Response; getReader: ReturnType<typeof vi.spyOn> } {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': mime, ...headers },
  });
  const getReader = vi.spyOn(response.body!, 'getReader');
  return { response, getReader };
}

describe('webFetchTool — include_media (ADR-115)', () => {
  it('image/png с include_media: вложение в результате + текст с плейсхолдером', async () => {
    const env = makeAttachmentsEnv();
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse(PNG_BYTES, 'image/png')));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/picture.png', include_media: true },
      mediaCtx(env),
    );

    expect(result.isError).toBeFalsy();
    expect(result.attachments).toHaveLength(1);
    const [ref] = result.attachments!;
    expect(ref!.mime).toBe('image/png');
    expect(ref!.size).toBe(PNG_BYTES.length);
    expect(ref!.blobPath.startsWith('attachments/')).toBe(true);
    expect(ref!.name).toBe('picture.png');
    expect(ref!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // В тексте — маркер вложения (модель и строка истории не теряют факт медиа).
    expect(result.content).toContain('### https://cdn.example/picture.png');
    expect(result.content).toContain('[image: picture.png] attached to the dialog');
    expect(env.upload).toHaveBeenCalledTimes(1);
  });

  it('application/pdf с include_media: вложение типа file', async () => {
    const env = makeAttachmentsEnv();
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse(PDF_BYTES, 'application/pdf')));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/doc.pdf', include_media: true },
      mediaCtx(env),
    );

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]!.mime).toBe('application/pdf');
    expect(result.content).toContain('[file: doc.pdf] attached to the dialog');
  });

  it('имя из Content-Disposition приоритетнее пути URL', async () => {
    const env = makeAttachmentsEnv();
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse(PNG_BYTES, 'image/png', {
      'content-disposition': 'attachment; filename="shot-01.png"',
    })));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/download', include_media: true },
      mediaCtx(env),
    );

    expect(result.attachments![0]!.name).toBe('shot-01.png');
  });

  it('превышение лимита (content-length) — без вложения и без чтения тела, с причиной', async () => {
    const env = makeAttachmentsEnv({ maxBytesPerFile: 64 });
    const { response, getReader } = streamResponse(PNG_BYTES, 'image/png', {
      'content-length': '1000000',
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/huge.png', include_media: true },
      mediaCtx(env),
    );

    expect(result.attachments).toBeUndefined();
    expect(result.content).toContain('include_media: file is too large');
    expect(env.upload).not.toHaveBeenCalled();
    // Ранняя проверка: тело не запрашивалось вовсе.
    expect(getReader).not.toHaveBeenCalled();
  });

  it('превышение лимита без content-length — чтение обрывается по капу', async () => {
    const env = makeAttachmentsEnv({ maxBytesPerFile: 8 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(PNG_BYTES.subarray(0, 6)));
          controller.enqueue(new Uint8Array(PNG_BYTES.subarray(6)));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'image/png' } },
    )));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/stream.png', include_media: true },
      mediaCtx(env),
    );

    expect(result.attachments).toBeUndefined();
    expect(result.content).toContain('include_media: file is too large');
    expect(env.upload).not.toHaveBeenCalled();
  });

  it('attachments.enabled=false — отказ с причиной, тело не читается', async () => {
    const env = makeAttachmentsEnv({ enabled: false });
    const { response, getReader } = streamResponse(PNG_BYTES, 'image/png');
    vi.stubGlobal('fetch', vi.fn(async () => response));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/picture.png', include_media: true },
      mediaCtx(env),
    );

    expect(result.attachments).toBeUndefined();
    expect(result.content).toContain('include_media: attachments are disabled on this instance');
    expect(env.upload).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
  });

  it('MIME вне allowlist (SVG) — отказ сервиса, вызов не падает', async () => {
    const env = makeAttachmentsEnv();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse(svg, 'image/svg+xml')));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/logo.svg', include_media: true },
      mediaCtx(env),
    );

    expect(result.isError).toBeFalsy();
    expect(result.attachments).toBeUndefined();
    expect(result.content).toContain('include_media:');
    expect(result.content).toMatch(/svg/i);
  });

  it('нет attachmentService — причина в тексте, без падения', async () => {
    const fetchMock = vi.fn(async () => binaryResponse(PNG_BYTES, 'image/png'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/picture.png', include_media: true },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.attachments).toBeUndefined();
    expect(result.content).toContain('include_media: attachments are unavailable in this build');
  });

  it('include_media=false: бинарь не читается и не декодируется как текст', async () => {
    const env = makeAttachmentsEnv();
    const { response, getReader } = streamResponse(PNG_BYTES, 'image/png');
    vi.stubGlobal('fetch', vi.fn(async () => response));

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/picture.png' },
      mediaCtx(env),
    );

    expect(result.attachments).toBeUndefined();
    expect(env.upload).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(result.content).toContain('[binary content: image/png]');
    expect(result.content).toContain('include_media=true');
  });

  it('несколько URL: медиа и текст изолированы, ошибка одного не мешает другому', async () => {
    const env = makeAttachmentsEnv({ maxBytesPerFile: 64 });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith('picture.png')) return binaryResponse(PNG_BYTES, 'image/png');
      if (target.endsWith('huge.png')) {
        return new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '1000000' },
        });
      }
      return new Response('<html><body><p>plain page</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      {
        urls: ['https://cdn.example/picture.png', 'https://cdn.example/huge.png', 'https://site.example/'],
        include_media: true,
      },
      mediaCtx(env),
    );

    expect(result.isError).toBeFalsy();
    expect(result.attachments).toHaveLength(1);
    expect(result.content).toContain('[image: picture.png] attached to the dialog');
    expect(result.content).toContain('include_media: file is too large');
    expect(result.content).toContain('plain page');
  });

  it('редирект на приватный адрес по-прежнему блокируется при include_media', async () => {
    _setWebFetchHostResolver(async (host) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']));
    configureEgressRuntime({
      resolver: {
        resolveTools: async () => ({ mode: 'deny', list: ['10.0.0.0/8'], exceptions: [] }),
      },
    });
    const env = makeAttachmentsEnv();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://internal.example/secret.png' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.execute(
      { url: 'https://cdn.example/picture.png', include_media: true },
      mediaCtx(env),
    );

    expect(result.attachments).toBeUndefined();
    expect(result.content).toMatch(/Blocked by the network policy|заблокирован/i);
    expect(env.upload).not.toHaveBeenCalled();
  });
});
