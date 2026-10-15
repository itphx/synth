// Раздача статики UI (SPA + PWA) для standalone-core.
// Вынесено из `server/app.ts` (ADR-095, шаг 4a) — «вынос по швам», без изменения поведения.
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * MIME-типы отдаваемых файлов UI. `.webmanifest` — `application/manifest+json`
 * (PWA-манифест, ADR-044); остальное — минимум для SPA-шела.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function serveStatic(uiDistPath: string) {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    const fullPath = join(uiDistPath, filePath);

    if (!existsSync(fullPath) || !fullPath.startsWith(uiDistPath)) {
      filePath = '/index.html';
      const fallbackPath = join(uiDistPath, '/index.html');
      if (!existsSync(fallbackPath)) return null;
      const content = readFileSync(fallbackPath);
      const ext = '.html';
      return new Response(content, {
        status: 200,
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      });
    }

    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath).toLowerCase();
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control':
            ext === '.html' || ext === '.webmanifest' || url.pathname === '/sw.js'
              ? 'no-cache'
              : 'public, max-age=3600',
        },
      });
    } catch {
      return null;
    }
  };
}
