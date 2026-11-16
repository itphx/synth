#!/usr/bin/env node
/**
 * Проверка self-contained аналитического HTML-отчёта (порт `check_html.py`).
 *
 * Проверяет:
 *   * наличие DOCTYPE, `<html lang>`, `<meta charset>`;
 *   * баланс тегов (незакрытые / лишние / перепутанный порядок; свой токенайзер:
 *     комментарии, void-теги, raw-text `script`/`style`);
 *   * уникальность id и разрешимость внутренних ссылок `href="#..."`;
 *   * отсутствие внешних ресурсов (link/script/img/@import) — отчёт должен
 *     открываться offline и в контуре без интернета;
 *   * наличие встроенного `<style>`;
 *   * печатает статистику документа.
 *
 * Использование:
 *     node check_html.mjs report.html
 *
 * Коды возврата: 0 — ошибок нет, 1 — есть ошибки, 2 — неверное использование.
 *
 * Без зависимостей: скрипт копируется в workspace и запускается `node`.
 */

import { readFileSync } from 'node:fs';

/** Теги без закрывающего (void). */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Raw-text теги: содержимое не токенизируется (в CSS/JS есть `<`). */
const RAW_TEXT = new Set(['script', 'style']);

/** Минимальный набор char-ref для значений атрибутов. */
const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function unescapeAttr(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (entity) => ENTITIES[entity]);
}

/** Безопасный `decodeURIComponent` для якорей (`#%D0...`). */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Индекс `>` закрывающего тег, с учётом кавычек в атрибутах; `-1` — не найден. */
function findTagEnd(raw, from) {
  let quote = null;
  for (let i = from; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/** Атрибуты тега: `name`, `name=value`, `name="value"`, `name='value'`. */
function parseAttrs(text) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = unescapeAttr(value);
  }
  return attrs;
}

class Checker {
  constructor(raw) {
    this.raw = raw;
    this.lineStarts = [0];
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === '\n') this.lineStarts.push(i + 1);
    }
    this.stack = [];
    this.errors = [];
    this.warnings = [];
    this.ids = new Map();
    this.anchors = [];
    this.external = [];
    this.hasStyle = false;
    this.hasDoctype = false;
    this.htmlLang = null;
    this.hasCharset = false;
  }

  /** Человекочитаемая позиция: `строка N:колонка M`. */
  pos(index) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return `строка ${lo + 1}:${index - this.lineStarts[lo] + 1}`;
  }

  startTag(tag, attrs, index) {
    if (tag === 'html') this.htmlLang = attrs.lang ?? null;
    if (tag === 'meta' && (attrs.charset || (attrs.content ?? '').toLowerCase().includes('charset'))) {
      this.hasCharset = true;
    }
    if (tag === 'style') this.hasStyle = true;

    // Внешние ресурсы — отчёт должен открываться offline.
    if (tag === 'link') {
      const href = attrs.href ?? '';
      if (/^(?:https?:)?\/\//i.test(href)) this.external.push({ tag, href, index });
      else if (href.toLowerCase().endsWith('.css')) this.external.push({ tag, href, index });
    }
    if (['script', 'img', 'iframe', 'source', 'video', 'audio'].includes(tag)) {
      const src = attrs.src ?? '';
      if (/^(?:https?:)?\/\//i.test(src)) this.external.push({ tag, href: src, index });
    }

    const id = attrs.id;
    if (id) {
      if (this.ids.has(id)) {
        this.errors.push(`${this.pos(index)}: повторяющийся id '${id}' (первый — ${this.pos(this.ids.get(id))})`);
      } else {
        this.ids.set(id, index);
      }
    }

    if (tag === 'a' && (attrs.href ?? '').startsWith('#')) {
      this.anchors.push({ anchor: safeDecode((attrs.href ?? '').slice(1)), index });
    }

    if (!VOID.has(tag)) this.stack.push({ tag, index });
  }

  endTag(tag, index) {
    if (VOID.has(tag)) return;
    if (this.stack.length === 0) {
      this.errors.push(`${this.pos(index)}: лишний закрывающий </${tag}>`);
      return;
    }
    const top = this.stack[this.stack.length - 1];
    if (top.tag === tag) {
      this.stack.pop();
      return;
    }
    this.errors.push(
      `${this.pos(index)}: </${tag}> не соответствует открытому <${top.tag}> `
      + `(${this.pos(top.index)})`,
    );
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      if (this.stack[i].tag === tag) {
        this.stack.length = i;
        return;
      }
    }
  }

  run() {
    const raw = this.raw;
    let i = 0;
    while (i < raw.length) {
      const lt = raw.indexOf('<', i);
      if (lt < 0) break;

      // Комментарий.
      if (raw.startsWith('<!--', lt)) {
        const end = raw.indexOf('-->', lt + 4);
        i = end < 0 ? raw.length : end + 3;
        continue;
      }
      // DOCTYPE и прочие `<! ... >`.
      if (raw.startsWith('<!', lt)) {
        const end = raw.indexOf('>', lt);
        if (end < 0) break;
        if (/^doctype/i.test(raw.slice(lt + 2, end).trim())) this.hasDoctype = true;
        i = end + 1;
        continue;
      }
      // Processing instruction / bogus comment.
      if (raw.startsWith('<?', lt)) {
        const end = raw.indexOf('>', lt);
        i = end < 0 ? raw.length : end + 1;
        continue;
      }
      // Закрывающий тег.
      if (raw[lt + 1] === '/') {
        const end = raw.indexOf('>', lt);
        if (end < 0) {
          this.errors.push(`${this.pos(lt)}: незакрытый '</'`);
          break;
        }
        const name = (raw.slice(lt + 2, end).trim().split(/[\s/]/)[0] ?? '').toLowerCase();
        if (name) this.endTag(name, lt);
        i = end + 1;
        continue;
      }
      // Не тег — текст.
      if (!/[a-zA-Z]/.test(raw[lt + 1] ?? '')) {
        i = lt + 1;
        continue;
      }

      const end = findTagEnd(raw, lt + 1);
      if (end < 0) {
        this.errors.push(`${this.pos(lt)}: незакрытый '<'`);
        break;
      }
      const text = raw.slice(lt + 1, end);
      const selfClosing = text.trimEnd().endsWith('/');
      const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(text);
      const tag = (nameMatch?.[1] ?? '').toLowerCase();
      const attrs = parseAttrs(nameMatch ? text.slice(nameMatch[0].length) : '');
      i = end + 1;

      if (!tag) continue;
      if (selfClosing) {
        // `<tag />` — открываем и сразу закрываем (id/внешние ресурсы проверяются).
        this.startTag(tag, attrs, lt);
        if (!VOID.has(tag)) this.stack.pop();
        continue;
      }
      this.startTag(tag, attrs, lt);

      // Raw-text: пропускаем содержимое до закрывающего тега.
      if (RAW_TEXT.has(tag)) {
        const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
        const rest = raw.slice(i);
        const close = closeRe.exec(rest);
        if (!close) {
          i = raw.length;
          continue;
        }
        i += close.index + close[0].length;
        this.stack.pop();
      }
    }

    if (!this.hasDoctype) this.errors.push('нет <!DOCTYPE html>');
    if (!this.htmlLang) this.warnings.push('у <html> нет атрибута lang');
    if (!this.hasCharset) this.errors.push('нет <meta charset="utf-8">');
    if (!this.hasStyle) this.warnings.push('нет встроенного <style> — отчёт может зависеть от внешних стилей');

    for (const entry of this.stack) {
      this.errors.push(`${this.pos(entry.index)}: не закрыт <${entry.tag}>`);
    }

    for (const { anchor, index } of this.anchors) {
      if (anchor && !this.ids.has(anchor)) {
        this.errors.push(`${this.pos(index)}: ссылка #${anchor} не находит id`);
      }
    }

    const seen = new Set();
    for (const { tag, href, index } of this.external) {
      const key = `${tag}\u0000${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.errors.push(
        `${this.pos(index)}: внешний ресурс <${tag}> ${href} — отчёт должен быть self-contained`,
      );
    }

    if (/@import\s/.test(raw)) {
      this.errors.push('найден @import в стилях — используйте встроенный CSS');
    }
  }
}

function main(path) {
  const raw = readFileSync(path, 'utf-8');
  const checker = new Checker(raw);
  checker.run();

  const { errors, warnings } = checker;
  const h2 = (raw.match(/<h2/gi) ?? []).length;
  const tables = (raw.match(/<table/gi) ?? []).length;
  const callouts = (raw.match(/class="callout/g) ?? []).length;
  const badges = (raw.match(/class="badge/g) ?? []).length;

  const sizeKb = (Buffer.byteLength(raw, 'utf-8') / 1024).toFixed(1);
  console.log(`Файл: ${path}`);
  console.log(`Размер: ${sizeKb} КБ`);
  console.log(`Разделов h2: ${h2} · таблиц: ${tables} · врезок: ${callouts} · статусов: ${badges}`);
  console.log(`Внутренних ссылок: ${checker.anchors.length} · id: ${checker.ids.size}`);

  if (warnings.length > 0) {
    console.log('\nПредупреждения:');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
  if (errors.length > 0) {
    console.log('\nОшибки:');
    for (const error of errors) console.log(`  x ${error}`);
    console.log(`\nИТОГО: ${errors.length} ошибок, ${warnings.length} предупреждений`);
    return 1;
  }

  console.log(`\nOK: ошибок нет, предупреждений ${warnings.length}`);
  return 0;
}

const argv = process.argv.slice(2);
if (argv.length !== 1) {
  console.log('Использование: node check_html.mjs <файл.html>');
  process.exit(2);
}

try {
  process.exit(main(argv[0]));
} catch (error) {
  console.error(`Ошибка чтения файла: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
