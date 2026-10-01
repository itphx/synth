/* Synth PWA — service worker (app-shell, runtime-кэш). */
const CACHE = 'synth-shell-__SYNTH_VERSION__'

// Пути, которые НЕ кэшируем: данные/авторизация/реалтайм/служебные.
const NO_CACHE_URL = /\/api\/|\/ws|\/auth|\/admin|\/health|sw\.js$/

// Статика app-shell, которую кэшируем.
const STATIC_RE = /^\/(assets|icons)\//

self.addEventListener('install', (event) => {
  // Без skipWaiting(): новый SW ждёт команды SKIP_WAITING, чтобы не подменять
  // приложение без ведома пользователя (баннер обновления — PwaUpdatePrompt).
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['/']))
      .catch(() => {}) // ошибки предкэша некритичны
  )
})

// Обновление запускается из UI: старый SW уступает место новому.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (NO_CACHE_URL.test(url.pathname)) return

  // Навигация: network-first, при успехе кэшируем шелл, при офлайне — из кэша.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match('/').then((cached) => cached || offlineResponse()))
    )
    return
  }

  // Прочие same-origin статики: cache-first с фоновым обновлением (SWR).
  if (STATIC_RE.test(url.pathname) || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {})
            }
            return res
          })
          .catch(() => cached)
        return cached || networkFetch
      })
    )
  }
})

// Минимальный офлайн-шелле, когда кэша ещё нет.
function offlineResponse() {
  return new Response(
    '<!DOCTYPE html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>Вы офлайн</h1><p>Нет соединения с Synth-сервером. Проверьте сеть и перезагрузите страницу.</p></div></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}
