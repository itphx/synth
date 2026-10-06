import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { applyThemedFavicon } from './favicon'

function removeIconLinks() {
  document.head.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove())
}

describe('applyThemedFavicon', () => {
  beforeEach(() => {
    removeIconLinks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('создаёт link, если его нет, с data-URI и цветом темы', () => {
    applyThemedFavicon('#CA6008')

    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0].type).toBe('image/svg+xml')
    expect(links[0].href).toContain('data:image/svg+xml,')
    // encodeURIComponent превращает '#' в '%23'
    expect(links[0].href).toContain(encodeURIComponent('#CA6008'))
  })

  it('подменяет href существующего link, не создавая дублей', () => {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    link.href = '/favicon.svg'
    document.head.appendChild(link)

    applyThemedFavicon('#123456')

    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0]).toBe(link)
    expect(links[0].href).not.toBe('/favicon.svg')
    expect(links[0].href).toContain(encodeURIComponent('#123456'))
  })

  it('обновляет favicon при смене темы', () => {
    applyThemedFavicon('#CA6008')
    applyThemedFavicon('#0EA5E9')

    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')
    expect(links).toHaveLength(1)
    expect(links[0].href).toContain(encodeURIComponent('#0EA5E9'))
    expect(links[0].href).not.toContain(encodeURIComponent('#CA6008'))
  })

  it('SSR-safe: без document не бросает', () => {
    vi.stubGlobal('document', undefined)
    expect(() => applyThemedFavicon('#ffffff')).not.toThrow()
  })
})
