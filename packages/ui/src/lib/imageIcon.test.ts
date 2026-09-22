import { describe, it, expect } from 'vitest'
import { downscaleIconDataUrl, isOversizedIcon, MAX_STORED_ICON_LENGTH } from './imageIcon'

const SHORT_DATA_URL = 'data:image/png;base64,AAAA'
const LONG_DATA_URL = `data:image/png;base64,${'A'.repeat(MAX_STORED_ICON_LENGTH)}`

describe('isOversizedIcon', () => {
  it('короткий data-URL — не тяжёлый', () => {
    expect(isOversizedIcon(SHORT_DATA_URL)).toBe(false)
  })

  it('data-URL длиннее лимита — тяжёлый', () => {
    expect(isOversizedIcon(LONG_DATA_URL)).toBe(true)
    expect(isOversizedIcon(LONG_DATA_URL, 10)).toBe(true)
  })

  it('кастомный лимит учитывается', () => {
    expect(isOversizedIcon(SHORT_DATA_URL, 5)).toBe(true)
    expect(isOversizedIcon(SHORT_DATA_URL, 1000)).toBe(false)
  })

  it('ri:/brand:/http и пустые значения не трогаем', () => {
    expect(isOversizedIcon('ri:cpu')).toBe(false)
    expect(isOversizedIcon(`ri:${'x'.repeat(100)}`)).toBe(false)
    expect(isOversizedIcon('brand:ollama')).toBe(false)
    expect(isOversizedIcon(`brand:${'x'.repeat(100)}`)).toBe(false)
    expect(isOversizedIcon(`https://example.com/${'x'.repeat(100)}`)).toBe(false)
    expect(isOversizedIcon('')).toBe(false)
    expect(isOversizedIcon(null)).toBe(false)
    expect(isOversizedIcon(undefined)).toBe(false)
  })
})

describe('downscaleIconDataUrl', () => {
  it('короткий data-URL — возвращает вход как есть (без работы)', async () => {
    await expect(downscaleIconDataUrl(SHORT_DATA_URL)).resolves.toBe(SHORT_DATA_URL)
  })

  it('не data:image/* — возвращает вход как есть', async () => {
    const http = `https://example.com/${'x'.repeat(MAX_STORED_ICON_LENGTH)}`
    await expect(downscaleIconDataUrl(http)).resolves.toBe(http)
    await expect(downscaleIconDataUrl('ri:cpu')).resolves.toBe('ri:cpu')
    await expect(downscaleIconDataUrl('brand:ollama')).resolves.toBe('brand:ollama')
  })

  it('jsdom: canvas/decode недоступны — возвращает вход без изменений и не мутирует его', async () => {
    // В jsdom нет ни createImageBitmap, ни рабочего canvas.getContext('2d'),
    // а <img>.decode() не может загрузить картинку — срабатывает fallback-возврат.
    const original = `${LONG_DATA_URL}${'B'.repeat(1000)}`
    const snapshot = original
    const result = await downscaleIconDataUrl(original)
    expect(result).toBe(original)
    expect(original).toBe(snapshot)
  })

  it('размер по умолчанию не ломает вызов (size опционален)', async () => {
    const original = `${LONG_DATA_URL}${'C'.repeat(1000)}`
    await expect(downscaleIconDataUrl(original, 32)).resolves.toBe(original)
  })
})
