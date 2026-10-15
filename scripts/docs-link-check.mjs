#!/usr/bin/env node
/**
 * scripts/docs-link-check.mjs — проверка относительных ссылок в документации Synth.
 *
 * Запуск (без внешних зависимостей, только node:*):
 *   node scripts/docs-link-check.mjs
 *
 * Что проверяет:
 *   1. markdown-ссылки `[текст](цель)` и картинки `![alt](цель)` в файлах:
 *      `docs/**` (кроме `docs/arch_decisions/**` — за неё отвечает `scripts/adr-check.mjs`),
 *      корневые `README*.md` (включая `README.en.md`), `AGENTS.md`, `packages/<pkg>/AGENTS.md`.
 *   2. цель ссылки обязана резолвиться (файл или каталог существует) относительно
 *      каталога самого файла (или корня репозитория для путей, начинающихся с `/`).
 *
 * Что игнорируется:
 *   - якоря (`#section`) и хвосты `#anchor` у путей — внутренние якоря не проверяются;
 *   - внешние ссылки и любые URI со схемой (`http://`, `https://`, `mailto:`, `data:` …);
 *   - ссылки на `docs/arch_decisions/**` проверяются на существование, но содержимое
 *     этого каталога не сканируется;
 *   - содержимое fenced code-блоков (``` / ~~~) и inline code (`…`) — там ссылки часто
 *     приводятся как пример синтаксиса;
 *   - append-only журналы `.opencode/tasks/**` (исторические упоминания не переписываются).
 *
 * Ошибка → строка `файл:строка → цель` и exit 1.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Каталоги, которые не сканируем: их проверяет adr-check, либо это append-only журналы. */
const SKIP_DIRS = ['docs/arch_decisions', '.opencode/tasks'];
/** Каталоги, которые не спускаем при обходе файловой системы. */
const PRUNE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'tmp']);

/** Markdown-ссылка/картинка `[текст](цель)` (в т.ч. `<цель>` и опциональный title). */
const MD_LINK_RE = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** Открытие/закрытие fenced code-блока. */
const FENCE_RE = /^\s{0,3}(```|~~~)/;
/** Inline code-спан (`…` или ``…``) — примеры синтаксиса ссылок внутри него не проверяем. */
const INLINE_CODE_RE = /`+[^`]*`+/g;
/** Любая URI-схема (`https:`, `mailto:`, `data:` …). */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const errors = [];
const checked = { files: 0, links: 0 };

/** Рекурсивный сбор `*.md` (пропускает служебные каталоги). */
function walkMarkdown(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Целевые файлы проверки (относительные пути от корня). */
function collectTargets() {
  const files = walkMarkdown(join(ROOT, 'docs'));
  for (const name of readdirSync(ROOT)) {
    if (name !== 'AGENTS.md' && !/^README.*\.md$/.test(name)) continue;
    const full = join(ROOT, name);
    if (existsSync(full)) files.push(full);
  }
  const packagesDir = join(ROOT, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(packagesDir, entry.name, 'AGENTS.md');
      if (existsSync(full)) files.push(full);
    }
  }
  return files
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .filter((rel) => !SKIP_DIRS.some((skip) => rel === skip || rel.startsWith(`${skip}/`)))
    .sort();
}

/** Строки файла с «обнулёнными» fenced-блоками и inline code (номера строк сохраняются). */
function stripCode(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';
    return line.replace(INLINE_CODE_RE, '');
  });
}

/** Нормализация цели ссылки: снять `<…>`, отбросить якорь. Возвращает null, если проверять нечего. */
function normalizeTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  if (target === '') return null;
  if (target.startsWith('#')) return null;
  if (SCHEME_RE.test(target)) return null;
  const hash = target.indexOf('#');
  if (hash !== -1) target = target.slice(0, hash);
  if (target === '' || target.startsWith('#')) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    /* некорректный percent-encoding — проверяем как есть */
  }
  return target;
}

function checkFile(rel) {
  const full = join(ROOT, rel);
  const lines = stripCode(readFileSync(full, 'utf8'));
  lines.forEach((line, idx) => {
    if (!line.includes('](')) return;
    MD_LINK_RE.lastIndex = 0;
    let match;
    while ((match = MD_LINK_RE.exec(line)) !== null) {
      const target = normalizeTarget(match[1]);
      if (target === null) continue;
      checked.links += 1;
      const resolved = target.startsWith('/')
        ? resolve(ROOT, `.${target}`)
        : resolve(dirname(full), target);
      if (!existsSync(resolved)) {
        errors.push(`${rel}:${idx + 1} → ${target}`);
      }
    }
  });
}

function main() {
  const targets = collectTargets();
  for (const rel of targets) checkFile(rel);
  checked.files = targets.length;

  for (const err of errors) console.error(`✖ ${err}`);

  const summary = `файлов: ${checked.files}; ссылок: ${checked.links}; ошибок: ${errors.length}`;
  if (errors.length > 0) {
    console.error(`docs-link-check FAILED — ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`docs-link-check OK — ${summary}`);
}

main();
