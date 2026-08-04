import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseDuckDuckGoResults, webSearchTool, webFetchTool } from './web.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(result.content).toContain('Результаты поиска «example domain» (2):');
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
});
