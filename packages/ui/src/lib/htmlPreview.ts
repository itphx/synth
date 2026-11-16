/**
 * Безопасный предпросмотр HTML-файла проекта.
 *
 * HTML-документ агента (отчёт, дашборд, сгенерированная страница) показывается
 * в `<iframe sandbox srcDoc>`: сервер **никогда** не отдаёт такой файл как
 * `text/html` с нашего origin (`GET /api/v2/fs/raw` для kind вне
 * `INLINE_PREVIEW_KINDS` отвечает `attachment`), а `blob:`/`data:`-документ в
 * новой вкладке брать нельзя — `blob:` наследует origin приложения и любой
 * скрипт внутри отчёта получил бы доступ к сессии пользователя.
 *
 * Два слоя защиты:
 *
 * 1. **Граница — атрибут `sandbox`** (задаётся на iframe в `FileViewerTab`):
 *    без `allow-scripts` скрипты документа не исполняются, без
 *    `allow-same-origin` документ считается уникальным origin и не читает
 *    наше хранилище/cookie. На это правило нельзя влиять содержимым файла.
 * 2. **Второй слой — meta-CSP** (`HTML_PREVIEW_CSP`, вставляется этой функцией):
 *    блокирует сеть (`default-src 'none'`, разрешены только инлайновые стили и
 *    `data:`-картинки/шрифты/медиа), отправку форм (`form-action 'none'`) и
 *    подмену базового адреса (`base-uri 'none'`). Если браузер когда-нибудь
 *    перестанет наследовать CSP родителя для `srcdoc` (или политика SPA будет
 *    ослаблена), документ всё равно не пойдёт в сеть и не отправит форму —
 *    `sandbox` при этом остаётся главным ограничителем, а CSP лишь сужает
 *    побочные эффекты «безобидной» разметки (`<img src=…>`, `@import`, `<form>`).
 *
 * Санитизации здесь нет и быть не может: разобрать произвольный HTML «без
 * потерь» нельзя, а изоляцию даёт `sandbox`.
 */

/**
 * CSP для документа внутри sandbox-iframe: всё запрещено, кроме инлайновых
 * стилей и встроенных (`data:`) картинок, шрифтов и медиа — так отчёт с
 * картинкой-`data:`-URI остаётся читаемым, а сеть/формы/`<base>` закрыты.
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'"

/** Первое объявление `<!DOCTYPE …>` (регистронезависимо, до закрывающей `>`). */
const DOCTYPE_PATTERN = /<!doctype\b[^>]*>/i

/**
 * Вставляет meta-CSP в HTML-документ, который пойдёт в `srcDoc`.
 *
 * Meta ставится сразу после `<!DOCTYPE …>` (первое вхождение, регистр не важен),
 * чтобы не оказаться внутри `<head>`-зависимой разметки и примениться до первых
 * ресурсов; DOCTYPE-объявления нет — в начало строки. Идемпотентно: если
 * `HTML_PREVIEW_CSP` уже встречается в тексте, документ возвращается как есть.
 * Иных правок нет — исходный HTML (включая регистр тегов и отступы) сохраняется,
 * поэтому «Исходник» показывает ровно то, что лежит в файле.
 */
export function buildSandboxedHtmlDocument(html: string): string {
  if (html.includes(HTML_PREVIEW_CSP)) return html
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`
  const doctype = DOCTYPE_PATTERN.exec(html)
  if (!doctype) return `${meta}${html}`
  const insertAt = doctype.index + doctype[0].length
  return `${html.slice(0, insertAt)}${meta}${html.slice(insertAt)}`
}
