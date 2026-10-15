import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseDuckDuckGoResults, parseBingResults, webSearchTool, webFetchTool, _setWebFetchHostResolver } from './web.js';
import type { ToolContext } from '@itphx/synth-shared';

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
