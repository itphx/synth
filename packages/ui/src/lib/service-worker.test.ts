import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  renderServiceWorker,
  serviceWorkerCacheName,
  SW_BUILD_ID_PLACEHOLDER,
  SW_VERSION_PLACEHOLDER,
} from './service-worker'

/** Исходник реального `public/sw.js` — проверяем именно его плейсхолдеры. */
const SW_SOURCE = readFileSync(path.resolve(process.cwd(), 'public/sw.js'), 'utf8')

describe('service worker: версия и build id', () => {
  it('имя кэша содержит build id', () => {
    expect(serviceWorkerCacheName('1.2.3', 'abc1234')).toBe('synth-shell-1.2.3-abc1234')
  })

  it('без build id — только версия, без висящего дефиса', () => {
    expect(serviceWorkerCacheName('1.2.3')).toBe('synth-shell-1.2.3')
    expect(serviceWorkerCacheName('1.2.3', '')).toBe('synth-shell-1.2.3')
  })

  it('небезопасные символы build id отбрасываются (JS-строка/имя кэша)', () => {
    expect(serviceWorkerCacheName('1.2.3', "ab'c\n")).toBe('synth-shell-1.2.3-abc')
  })

  it('подставляет версию и build id в реальный sw.js', () => {
    const rendered = renderServiceWorker(SW_SOURCE, { version: '1.2.3', buildId: 'abc1234' })

    expect(rendered).not.toContain(SW_VERSION_PLACEHOLDER)
    expect(rendered).not.toContain(SW_BUILD_ID_PLACEHOLDER)
    expect(rendered).toContain("const CACHE_VERSION = 'synth-shell-1.2.3'")
    expect(rendered).toContain("const CACHE_BUILD = 'abc1234'")
    expect(rendered).toContain('`${CACHE_VERSION}-${CACHE_BUILD}`')
  })

  it('без build id оставляет только версию (пустой CACHE_BUILD)', () => {
    const rendered = renderServiceWorker(SW_SOURCE, { version: '1.2.3', buildId: '' })

    expect(rendered).not.toContain(SW_BUILD_ID_PLACEHOLDER)
    expect(rendered).toContain("const CACHE_VERSION = 'synth-shell-1.2.3'")
    expect(rendered).toContain("const CACHE_BUILD = ''")
    // Кэш-имя без build id: `${CACHE_VERSION}` — без хвостового дефиса.
    expect(serviceWorkerCacheName('1.2.3', '')).toBe('synth-shell-1.2.3')
  })

  it('собранный sw.js синтаксически валиден', () => {
    const rendered = renderServiceWorker(SW_SOURCE, { version: '1.2.3', buildId: 'abc1234' })
    // new Function компилирует скрипт (не исполняет) — ловит синтаксис.
    expect(() => new Function(rendered)).not.toThrow()
  })
})
