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

/**
 * Content-Security-Policy UI-документа — **единая** политика для обеих точек
 * раздачи SPA: эта (`serveStatic` в standalone-core, `synth serve --ui`) и nginx
 * (`docker/nginx-ui.conf.template` — образ `synth-ui`, k8s-поды `ui`). Расхождение политик
 * недопустимо; синхронность строки с nginx-конфигом и хэшей с инлайн-скриптами
 * проверяет `static.test.ts`.
 *
 * Обоснование нестандартных директив (defense-in-depth поверх allowlist-DOMPurify):
 * - `script-src 'self' 'sha256-…'`: хэши — два инлайн-бутстрапа, которые обязаны
 *   исполниться до первого пейнта (`packages/ui/index.html` — выбор темы, чтобы не
 *   было мигания; `packages/ui/public/diag.html` — диагностика вьюпорта).
 *   `'unsafe-inline'`/`'unsafe-eval'` **не выдаются**: инъекция скрипта (XSS)
 *   заблокирована — это и есть цель директивы.
 * - `style-src 'self' 'unsafe-inline'`: темизация собирает CSS-переменные в строку и
 *   инжектит её рантаймовым элементом `<style>` (`packages/ui/src/lib/theme/cssGenerator.ts`),
 *   React ставит инлайн-стили на элементы, react-toastify инжектит стили в рантайме.
 *   Хэш/nonce на рантаймовый `<style>` неприменим; риск ниже, чем у script-src —
 *   инъекция стилей не исполняет код.
 * - `img-src 'self' data: blob: http: https:`: иконки провайдеров
 *   (`packages/ui/src/components/admin/ProviderIcon.tsx`) рендерятся как `data:`-base64,
 *   либо как favicon с произвольного origin'а провайдера — включая локальные
 *   LLM-серверы по http (`http://localhost:11434/favicon.ico`). `blob:` — превью
 *   вложений. Картинки — read-only канал, кода не исполняют.
 * - `connect-src 'self'`: API/SSE/WebSocket идут на свой origin (в гибриде запросы
 *   проксирует локальный core — внешних API-origin у UI нет). Если браузер не
 *   сопоставит `ws:` с `'self'`, транспорт `auto` автоматически уходит на SSE
 *   (`stores/transportStore.ts`).
 * - `worker-src 'self' blob:`: PWA service worker `/sw.js` из своего origin.
 * - `frame-ancestors 'self'`: защита от кликджекинга (встраивание из чужого origin).
 */
export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'sha256-MMhFazxtuMIPPkuMwnmXCKpXQEcfdAFwPeO4AMhxusM=' 'sha256-bCDmoN59JH37oVd/UoltmCDavDiBTQeK7E+RZBHsLjc='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': UI_CONTENT_SECURITY_POLICY,
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
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          ...SECURITY_HEADERS,
        },
      });
    }

    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath).toLowerCase();
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          ...SECURITY_HEADERS,
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
