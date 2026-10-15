import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, UI_CONTENT_SECURITY_POLICY } from './static.js';

/** Путь к файлу репозитория из каталога теста (`packages/core/src/server/app`). */
const repoFile = (relative: string) =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

/**
 * CSP-хэши инлайн-скриптов документа: `<script>…</script>` без атрибутов
 * (внешние `<script src …>` политикой не ограничиваются хэшем).
 */
function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue;
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

describe('UI Content-Security-Policy', () => {
  it('хэширует оба инлайн-бутстрапа (тема в index.html, diag.html)', () => {
    const policyHashes = UI_CONTENT_SECURITY_POLICY.match(/'sha256-[^']+'/g) ?? [];
    expect(policyHashes).toHaveLength(2);

    // Если падает здесь — изменился инлайн-скрипт в HTML (или сама политика):
    // обновите `UI_CONTENT_SECURITY_POLICY` в `static.ts` И строку CSP в
    // `docker/nginx-ui.conf` (иначе бутстрап темы/диагностика будут заблокированы).
    const indexHtml = readFileSync(repoFile('packages/ui/index.html'), 'utf8');
    const diagHtml = readFileSync(repoFile('packages/ui/public/diag.html'), 'utf8');
    expect(policyHashes.sort()).toEqual(
      [...inlineScriptHashes(indexHtml), ...inlineScriptHashes(diagHtml)].sort(),
    );
  });

  it('не выдаёт script-src unsafe-inline/unsafe-eval (цель директивы — блок XSS)', () => {
    const scriptSrc = UI_CONTENT_SECURITY_POLICY.split('; ')
      .find((directive) => directive.startsWith('script-src'));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('совпадает побазно с CSP в nginx-конфиге (единая политика, а не «две разные»)', () => {
    const nginx = readFileSync(repoFile('docker/nginx-ui.conf'), 'utf8');
    expect(nginx).toContain(UI_CONTENT_SECURITY_POLICY);
  });
});

describe('serveStatic', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeUiDist(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'synth-ui-dist-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it('отдаёт CSP для SPA-шелла, статики и fallback-роутов', async () => {
    const dist = makeUiDist({ 'index.html': '<html></html>', 'sw.js': '// sw' });
    const handler = serveStatic(dist);

    for (const path of ['/', '/index.html', '/some/spa/route', '/sw.js']) {
      const res = await handler(new Request(`http://localhost${path}`));
      expect(res, path).not.toBeNull();
      expect(res!.headers.get('Content-Security-Policy'), path).toBe(UI_CONTENT_SECURITY_POLICY);
    }
  });

  it('неизвестный путь отдаёт SPA-шелл (index.html), а не 404', async () => {
    const dist = makeUiDist({ 'index.html': '<html></html>' });
    const handler = serveStatic(dist);
    const res = await handler(new Request('http://localhost/no/such-file.png'));
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('<html></html>');
  });

  it('каталог без index.html — статика не перехватывается (null → Hono)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synth-ui-empty-'));
    dirs.push(dir);
    const handler = serveStatic(dir);
    expect(await handler(new Request('http://localhost/'))).toBeNull();
  });
});
