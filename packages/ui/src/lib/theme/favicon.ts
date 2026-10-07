import { SYNTH_LOGO_PATH } from './logo-path'

/**
 * Окрашивает favicon вкладки в актуальный цвет темы (--primary) и подменяет
 * `href` у `link[rel="icon"]` на data-URI с SVG. SSR-safe: без `document`
 * ничего не делает. Если link отсутствует — создаёт, не плодя дублей.
 */
export function applyThemedFavicon(color: string): void {
  if (typeof document === 'undefined') {
    return
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-36 -17 272 272">` +
    `<g transform="translate(-5.0739065,-29.931031)">` +
    `<path fill="${color}" d="${SYNTH_LOGO_PATH}"/>` +
    `</g></svg>`
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/svg+xml'
  link.href = href
}
