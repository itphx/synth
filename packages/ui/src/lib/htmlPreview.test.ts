import { describe, it, expect } from 'vitest'
import { HTML_PREVIEW_CSP, buildSandboxedHtmlDocument } from './htmlPreview'

const META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`

describe('htmlPreview — meta-CSP для HTML-предпросмотра', () => {
  it('вставляет meta сразу после `<!DOCTYPE html>`', () => {
    const result = buildSandboxedHtmlDocument('<!DOCTYPE html><html><body>ok</body></html>')

    expect(result.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(result).toContain(META)
    // meta идёт до содержимого документа, а не в конец.
    expect(result.indexOf(META)).toBe('<!DOCTYPE html>'.length)
  })

  it('регистр DOCTYPE не важен (`<!doctype html>`)', () => {
    const result = buildSandboxedHtmlDocument('<!doctype html>\n<html lang="ru"></html>')

    expect(result.indexOf(META)).toBe('<!doctype html>'.length)
    expect(result).toContain('\n<html lang="ru">')
  })

  it('нет DOCTYPE — meta встаёт в начало документа', () => {
    const result = buildSandboxedHtmlDocument('<html><body>без доктайпа</body></html>')

    expect(result.startsWith(META)).toBe(true)
    expect(result).toContain('<html><body>без доктайпа</body></html>')
  })

  it('идемпотентно: повторная сборка не добавляет вторую meta', () => {
    const once = buildSandboxedHtmlDocument('<!DOCTYPE html><html></html>')
    const twice = buildSandboxedHtmlDocument(once)

    expect(twice).toBe(once)
    expect(twice.split(HTML_PREVIEW_CSP).length - 1).toBe(1)
  })

  it('содержимое после вставки сохраняется без иных правок', () => {
    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '  <head><title>Отчёт</title></head>',
      '  <body onload="steal()">',
      '    <script>alert(1)</script>',
      '    <p>Привет &amp; пока</p>',
      '  </body>',
      '</html>',
    ].join('\n')

    const result = buildSandboxedHtmlDocument(html)

    // Никакой санитизации: разметка (включая скрипты/обработчики) не меняется —
    // изоляцию даёт sandbox, а не вычистка тегов.
    expect(result.replace(META, '')).toBe(html)
    expect(result).toContain('<script>alert(1)</script>')
    expect(result).toContain('onload="steal()"')
  })

  it('meta стоит до первого `<style>`', () => {
    const result = buildSandboxedHtmlDocument(
      '<!DOCTYPE html><html><head><style>body{color:red}</style></head></html>',
    )

    expect(result.indexOf(META)).toBeGreaterThan(-1)
    expect(result.indexOf(META)).toBeLessThan(result.indexOf('<style>'))
  })

  it('CSP закрывает сеть, формы и base', () => {
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("style-src 'unsafe-inline'")
    expect(HTML_PREVIEW_CSP).toContain('img-src data:')
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'")
    expect(HTML_PREVIEW_CSP).toContain("base-uri 'none'")
    expect(HTML_PREVIEW_CSP).not.toContain('script-src')
  })
})
