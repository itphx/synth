// Предпросмотр файла (`GET /api/v2/fs/raw`): inline-allowlist, MIME, SVG-CSP,
// Range/206, ETag/304, кап размера, 404/400.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { createFsRoutes } from './fs.js';
import type { AuthKit } from '../../auth/local.js';
import type { ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';

function createMockAuth(): AuthKit {
  return {
    getCurrentUser: () => null,
    requireAuth: async (_c: Context, next: Next) => { await next(); },
  } as unknown as AuthKit;
}

const NO_PROTECTED: ProtectedPathsPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
};

describe('FS: предпросмотр файла (GET /raw)', () => {
  let tmpDir: string;
  let root: string;

  function makeApp(opts: { maxPreviewBytes?: number } = {}): Hono {
    const app = new Hono();
    app.route('/api/v2/fs', createFsRoutes(createMockAuth(), root, undefined, {
      getOutsideRootPolicy: () => 'confirm',
      getProtectedPathsPolicy: () => NO_PROTECTED,
      ...opts,
    }));
    return app;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'synth-fs-raw-'));
    root = join(tmpDir, 'workspaces');
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('image/png → 200 inline с точным MIME и байтами', async () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(root, 'pic.png'), payload);

    const res = await makeApp().request('/api/v2/fs/raw?path=pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
    expect(res.headers.get('Content-Disposition')).toContain('pic.png');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(res.headers.get('Content-Length')).toBe(String(payload.length));
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Last-Modified')).toBeTruthy();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true);
  });

  it('video/audio/pdf → inline с MIME по расширению', async () => {
    await writeFile(join(root, 'clip.mp4'), 'video-bytes');
    await writeFile(join(root, 'sound.mp3'), 'audio-bytes');
    await writeFile(join(root, 'doc.pdf'), '%PDF-1.4');

    const video = await makeApp().request('/api/v2/fs/raw?path=clip.mp4');
    expect(video.status).toBe(200);
    expect(video.headers.get('Content-Type')).toBe('video/mp4');
    expect(video.headers.get('Content-Disposition')).toContain('inline');

    const audio = await makeApp().request('/api/v2/fs/raw?path=sound.mp3');
    expect(audio.status).toBe(200);
    expect(audio.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(audio.headers.get('Content-Disposition')).toContain('inline');

    const pdf = await makeApp().request('/api/v2/fs/raw?path=doc.pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(pdf.headers.get('Content-Disposition')).toContain('inline');
  });

  it('text/html → attachment + application/octet-stream (не inline — XSS)', async () => {
    const html = '<html><script>alert(1)</script></html>';
    await writeFile(join(root, 'page.html'), html);

    const res = await makeApp().request('/api/v2/fs/raw?path=page.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).not.toContain('inline');
    expect(await res.text()).toBe(html);
  });

  it('text/code (markdown, ts) → тоже attachment, не inline', async () => {
    await writeFile(join(root, 'notes.md'), '# hi');
    await writeFile(join(root, 'main.ts'), 'export {};\n');

    for (const file of ['notes.md', 'main.ts']) {
      const res = await makeApp().request(`/api/v2/fs/raw?path=${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('Content-Disposition')).toContain('attachment');
    }
  });

  it('svg → image/svg+xml inline + CSP-песочница', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    await writeFile(join(root, 'logo.svg'), svg);

    const res = await makeApp().request('/api/v2/fs/raw?path=logo.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
    expect(res.headers.get('Content-Security-Policy'))
      .toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  });

  it('Range bytes=2-5 → 206, Content-Range и корректная длина', async () => {
    await writeFile(join(root, 'range.bin'), '0123456789');

    const res = await makeApp().request('/api/v2/fs/raw?path=range.bin', {
      headers: { Range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('Range bytes=-3 → 206 (последние 3 байта)', async () => {
    await writeFile(join(root, 'suffix.bin'), 'abcdefghij');

    const res = await makeApp().request('/api/v2/fs/raw?path=suffix.bin', {
      headers: { Range: 'bytes=-3' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(await res.text()).toBe('hij');
  });

  it('Range за пределами файла → 416 + Content-Range bytes */size', async () => {
    await writeFile(join(root, 'short.bin'), '0123456789');

    const res = await makeApp().request('/api/v2/fs/raw?path=short.bin', {
      headers: { Range: 'bytes=100-200' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('If-None-Match с текущим ETag → 304 без тела', async () => {
    await writeFile(join(root, 'cache.png'), 'cache-me');

    const first = await makeApp().request('/api/v2/fs/raw?path=cache.png');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const res = await makeApp().request('/api/v2/fs/raw?path=cache.png', {
      headers: { 'If-None-Match': etag as string },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('файл больше maxPreviewBytes → 413 FILE_TOO_LARGE + details', async () => {
    await writeFile(join(root, 'big.mp4'), 'x'.repeat(100));

    const res = await makeApp({ maxPreviewBytes: 16 })
      .request('/api/v2/fs/raw?path=big.mp4');
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { maxPreviewBytes?: number; size?: number; reason?: string };
      };
    };
    expect(body.error.code).toBe('FILE_TOO_LARGE');
    expect(body.error.details).toEqual({ maxPreviewBytes: 16, size: 100, reason: 'preview_size' });
  });

  it('без опции maxPreviewBytes дефолт 100 МиБ: небольшой файл → 200', async () => {
    await writeFile(join(root, 'ok.png'), 'small');
    const res = await makeApp().request('/api/v2/fs/raw?path=ok.png');
    expect(res.status).toBe(200);
  });

  it('несуществующий файл → 404 NOT_FOUND', async () => {
    const res = await makeApp().request('/api/v2/fs/raw?path=missing.png');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('директория → 400 IS_DIRECTORY', async () => {
    await mkdir(join(root, 'dir'));
    const res = await makeApp().request('/api/v2/fs/raw?path=dir');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IS_DIRECTORY');
  });

  it('HEAD → 200 с заголовками и Content-Length, без тела', async () => {
    await writeFile(join(root, 'head.png'), 'head-me');
    const res = await makeApp().request('/api/v2/fs/raw?path=head.png', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Length')).toBe('7');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('HEAD на файл больше maxPreviewBytes → 413 + причина и размеры в заголовках', async () => {
    await writeFile(join(root, 'huge.mp4'), 'x'.repeat(100));

    const res = await makeApp({ maxPreviewBytes: 16 })
      .request('/api/v2/fs/raw?path=huge.mp4', { method: 'HEAD' });
    expect(res.status).toBe(413);
    // Hono отбрасывает тело HEAD-ответа — клиент (`probeRawFile`) узнаёт
    // причину отказа только из заголовков.
    expect(res.headers.get('X-Synth-Preview-Reason')).toBe('preview_size');
    expect(res.headers.get('X-Synth-Preview-Max-Bytes')).toBe('16');
    expect(res.headers.get('X-Synth-Preview-Size')).toBe('100');
  });
});
