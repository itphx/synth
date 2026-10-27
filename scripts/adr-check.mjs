#!/usr/bin/env node
/**
 * scripts/adr-check.mjs — индекс и целостность архитектурных решений (ADR) и предложений (PROP) Synth.
 *
 * Запуск (без внешних зависимостей, только node:*):
 *   node scripts/adr-check.mjs          # проверка: ссылки, полнота индекса, целостность статусов
 *   node scripts/adr-check.mjs --write  # перегенерация индексов (идемпотентно)
 *
 * Что делает:
 *   1. `--write` — парсит `> **Статус:**` (канонический токен) и H1 каждого `docs/arch_decisions/adr-*.md`
 *      и `docs/arch_decisions/prop-*.md` и пересобирает: таблицы в `docs/arch_decisions/README.md`
 *      (Решения / Частично / Принятые предложения (история) / Предложения / Vision / Заменено /
 *      Отклонено / Legacy) и строки индекса ADR/PROP в `AGENTS.md` (между маркерами
 *      `<!-- ad-index:start -->` / `<!-- ad-index:end -->`).
 *   2. проверяет, что все относительные ссылки на `adr-*.md` / `prop-*.md` (в md/ts/tsx) резолвятся, что
 *      каждый документ присутствует в индексе и что нет ссылок на несуществующий документ (упоминания
 *      «голых» номеров прототипных ADR 001–021 — warning).
 *   3. предупреждает, если `✅ Реализовано` без раздела «Статус в коде»/«Реализация», если
 *      actionable-предложение (`🧩 Предложение`) без строки `> **Решение до:**`, и если
 *      `✅ Принято` указано без существующего `(ADR-NNN)` (или не у предложения).
 *
 * Классы документов, правила ведения и жизненный цикл — docs/ARCH_DECISIONS.md.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AD_DIR = join(ROOT, 'docs', 'arch_decisions');
const LEGACY_DIR = join(AD_DIR, 'legacy');
const README_PATH = join(AD_DIR, 'README.md');
const AGENTS_PATH = join(ROOT, 'AGENTS.md');
const INDEX_START = '<!-- ad-index:start -->';
const INDEX_END = '<!-- ad-index:end -->';

const WRITE = process.argv.includes('--write');

/** Имя файла документа: `adr-NNN-slug.md` (решение) или `prop-NNN-slug.md` (предложение). */
const DOC_FILE_RE = /^(adr|prop)-\d+.*\.md$/;
/** Идентификатор в H1: `# ADR-NNN: …` / `# PROP-NNN: …`. */
const DOC_TITLE_RE = /^#\s+(?:ADR|PROP)-\d+[^:]*:\s*(.*)$/m;

// ── Канонические статусы (docs/ARCH_DECISIONS.md) ───────────────────────────

const TOKEN_DONE = '✅ Реализовано';
const TOKEN_PARTIAL = '⚠️ Частично';
const TOKEN_PROPOSAL = '🧩 Предложение';
const TOKEN_VISION = '🧩 Предложение (vision)';
const TOKEN_ICEBOX = '🧊 Icebox';
const TOKEN_ADOPTED = '✅ Принято';
const TOKEN_SUPERSEDED = '⛔ Заменено';
const TOKEN_REJECTED = '🗑 Отклонено';

/** Секции индекса README: порядок и состав токенов. */
const SECTIONS = [
  { title: 'Решения', tokens: [TOKEN_DONE] },
  { title: 'Частично', tokens: [TOKEN_PARTIAL] },
  { title: 'Принятые предложения (история)', tokens: [TOKEN_ADOPTED] },
  { title: 'Предложения', tokens: [TOKEN_PROPOSAL, TOKEN_ICEBOX] },
  { title: 'Vision', tokens: [TOKEN_VISION] },
  { title: 'Заменено', tokens: [TOKEN_SUPERSEDED] },
  { title: 'Отклонено', tokens: [TOKEN_REJECTED] },
];

/** ADR прототипа без файлов в каталоге: упоминания в тексте допустимы. */
const PROTOTYPE_MENTIONS = new Set([
  '001', '002', '003', '004', '006', '007', '010', '011', '012', '013', '015', '016', '020', '021',
]);

/** Расширения, в которых ищем ссылки на документы. */
const SCAN_EXT = /\.(md|ts|tsx|mts|cts)$/;
/** Каталоги, которые не сканируем. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', 'tmp', 'data', 'secrets', '.venv', 'venv', 'out',
]);
/** Строки статуса, считающиеся каноническими. */
const STATUS_RE = /^\s*>?\s*\*\*Статус:\*\*\s*(.+)$/m;
/** Разделы, подтверждающие, что «Реализовано» опирается на код. */
const IMPL_SECTION_RE = /^#{2,4}\s+.*(Статус в коде|Статус реализации|Реализация)/m;
/** Строка со сроком решения по proposal. */
const DEADLINE_RE = /^\s*>?\s*\*\*Решение до:\*\*\s*(.+)$/m;

// ── Утилиты ────────────────────────────────────────────────────────────────

const warnings = [];
const errors = [];

function warn(msg) {
  warnings.push(msg);
}

function error(msg) {
  errors.push(msg);
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function writeText(path, text) {
  writeFileSync(path, text, 'utf8');
}

function relRoot(path) {
  return relative(ROOT, path).split('\\').join('/');
}

/** Рекурсивный обход файлов (без node_modules/dist/...). */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitverse' && entry.name !== '.opencode') {
      if (entry.isDirectory()) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Канонический токен статуса по строке `> **Статус:** …`. */
function detectToken(statusLine) {
  if (!statusLine) return null;
  // Принятое предложение: файл остаётся в каталоге как история, статус терминальный.
  if (/Принято/.test(statusLine)) return TOKEN_ADOPTED;
  if (statusLine.includes(TOKEN_VISION)) return TOKEN_VISION;
  if (statusLine.includes(TOKEN_ICEBOX)) return TOKEN_ICEBOX;
  if (statusLine.includes(TOKEN_PROPOSAL)) return TOKEN_PROPOSAL;
  if (statusLine.includes(TOKEN_PARTIAL)) return TOKEN_PARTIAL;
  if (statusLine.includes('⛔')) return TOKEN_SUPERSEDED;
  if (statusLine.includes('🗑')) return TOKEN_REJECTED;
  // неканонические формулировки: смешанные «✅ … ⏳ …» считаем частичной реализацией
  if (statusLine.includes('✅') && statusLine.includes('⏳')) return TOKEN_PARTIAL;
  if (statusLine.includes('✅')) return TOKEN_DONE;
  if (statusLine.includes('⏳')) return TOKEN_PROPOSAL;
  return null;
}

// ── Чтение документов ──────────────────────────────────────────────────────

function parseDocFile(path, legacy) {
  const text = readText(path);
  const fileName = path.split('/').pop();
  const idMatch = fileName.match(/^(adr|prop)-(\d+)/);
  if (!idMatch) return null;
  const kind = idMatch[1].toUpperCase();
  const num = idMatch[2];
  const titleLine = (text.match(DOC_TITLE_RE) || [])[1] || fileName;
  const statusLine = (text.match(STATUS_RE) || [])[1] || '';
  const deadline = (text.match(DEADLINE_RE) || [])[1] || '';
  const adoptedMatch = statusLine.match(/Принято\s*\(ADR-(\d+)\)/);
  return {
    num,
    kind,
    id: `${kind}-${num}`,
    fileName,
    path,
    rel: relRoot(path),
    title: titleLine.trim(),
    status: statusLine.trim(),
    token: detectToken(statusLine),
    adoptedAs: adoptedMatch ? adoptedMatch[1] : null,
    deadline: deadline.trim(),
    legacy: Boolean(legacy),
    hasImplSection: IMPL_SECTION_RE.test(text),
    lines: text.split('\n').length,
  };
}

function readAllDocs() {
  const docs = [];
  for (const entry of readdirSync(AD_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !DOC_FILE_RE.test(entry.name)) continue;
    const doc = parseDocFile(join(AD_DIR, entry.name), false);
    if (doc) docs.push(doc);
  }
  if (existsSync(LEGACY_DIR)) {
    for (const entry of readdirSync(LEGACY_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !DOC_FILE_RE.test(entry.name)) continue;
      const doc = parseDocFile(join(LEGACY_DIR, entry.name), true);
      if (doc) docs.push(doc);
    }
  }
  docs.sort((a, b) => Number(a.num) - Number(b.num));
  return docs;
}

// ── Разбор существующих индексов (сохраняем описания) ───────────────────────

/** `| ADR-005 | описание | … |` → Map<`ADR-005`, описание> (ключ — полный id: ADR- и PROP- номера могут совпадать). */
function parseDescriptions(text, { stripLinks = false } = {}) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(ADR|PROP)-(\d+)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    const cells = m[3].split('|').map((c) => c.trim());
    let desc = cells[0] || '';
    const link = desc.match(/^\[([^\]]+)\]\([^)]*\)$/);
    if (link) desc = link[1];
    if (stripLinks) desc = desc.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    desc = desc.replace(/\s*\|\s*$/, '').trim();
    if (!map.has(key) || !map.get(key)) map.set(key, desc);
  }
  return map;
}

// ── Генерация README ───────────────────────────────────────────────────────

const README_HEADER = `# Архитектурные решения и предложения (ADR / PROP)

> Индекс каталога: **ADR** — принятые решения (\`adr-*.md\`), **PROP** — предложения (\`prop-*.md\`); принятое предложение остаётся в каталоге как история со статусом \`✅ Принято (ADR-NNN)\`.
> Правила ведения, жизненный цикл и классы документов — [docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md);
> предложения и сроки решений — [docs/roadmap.md](../roadmap.md).
> Номера стабильны: файлы не переносятся и не удаляются (ссылок на id по репозиторию — тысячи).

Таблицы собираются автоматически — вручную не правь:
\`node scripts/adr-check.mjs --write\` (проверка — \`node scripts/adr-check.mjs\`).`;

/** Ячейка статуса: у принятого предложения — с номером ADR. */
function statusCell(doc) {
  return doc.token === TOKEN_ADOPTED && doc.adoptedAs
    ? `${TOKEN_ADOPTED} (ADR-${doc.adoptedAs})`
    : doc.token || '—';
}

function renderReadme(docs, descriptions) {
  const lines = [README_HEADER, ''];
  for (const section of SECTIONS) {
    const rows = docs
      .filter((doc) => !doc.legacy && section.tokens.includes(doc.token))
      .sort((a, b) => section.tokens.indexOf(a.token) - section.tokens.indexOf(b.token) || Number(a.num) - Number(b.num));
    if (rows.length === 0) continue;
    lines.push(`## ${section.title}`, '');
    lines.push('| ID | Тема | Статус | Файл |', '|----|------|--------|------|');
    for (const doc of rows) {
      const desc = descriptions.get(doc.id) || doc.title;
      lines.push(`| ${doc.id} | ${desc} | ${statusCell(doc)} | [${doc.fileName}](./${doc.fileName}) |`);
    }
    lines.push('');
  }
  const legacy = docs.filter((doc) => doc.legacy);
  if (legacy.length > 0) {
    lines.push('## Legacy', '');
    lines.push('| ID | Тема | Статус | Файл |', '|----|------|--------|------|');
    for (const doc of legacy) {
      const desc = descriptions.get(doc.num) || doc.title;
      lines.push(`| ${doc.id} | ${desc} | ${doc.token || TOKEN_SUPERSEDED} | [legacy/${doc.fileName}](./legacy/${doc.fileName}) |`);
    }
    lines.push('');
  }
  const counts = [
    `Решения: ${docs.filter((d) => d.token === TOKEN_DONE).length}`,
    `Частично: ${docs.filter((d) => d.token === TOKEN_PARTIAL).length}`,
    `Принятые предложения: ${docs.filter((d) => d.token === TOKEN_ADOPTED).length}`,
    `Предложения: ${docs.filter((d) => d.token === TOKEN_PROPOSAL).length}`,
    `Vision: ${docs.filter((d) => d.token === TOKEN_VISION).length}`,
    `Icebox: ${docs.filter((d) => d.token === TOKEN_ICEBOX).length}`,
    `Legacy: ${docs.filter((d) => d.legacy).length}`,
  ];
  lines.push('---', '', `Всего документов: ${docs.length} (${counts.join(', ')}).`, '');
  return lines.join('\n');
}

// ── Генерация индекса в AGENTS.md ──────────────────────────────────────────

function renderAgentsIndex(docs, descriptions) {
  const lines = [
    INDEX_START,
    '| ID | Суть | Статус | Файл |',
    '|----|------|--------|------|',
  ];
  for (const doc of docs.filter((d) => !d.legacy)) {
    const desc = descriptions.get(doc.id) || doc.title;
    lines.push(`| ${doc.id} | ${desc} | ${statusCell(doc)} | [${doc.id.toLowerCase()}](./${doc.rel}) |`);
  }
  lines.push(INDEX_END);
  return lines.join('\n');
}

function replaceAgentsIndex(text, block) {
  const start = text.indexOf(INDEX_START);
  const end = text.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(0, start) + block + text.slice(end + INDEX_END.length);
}

// ── Проверки ───────────────────────────────────────────────────────────────

const DOC_FILE_TOKEN = /(?:adr|prop)-\d+[\w.-]*\.md/g;
/** Markdown-ссылка `[текст](цель)`. */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** Упоминание с путём (есть хотя бы один `/`). */
const DOC_PATH_TOKEN_RE = /(?:^|[^\w-])((?:\.{0,2}\/|\/)?(?:[\w.@-]+\/)+(?:adr|prop)-\d+[\w.-]*\.md)/g;
/** «Голый» номер документа. */
const DOC_MENTION_RE = /(?:ADR|PROP)-\d{3}/g;
/**
 * Append-only журналы задач (.opencode/tasks/*): исторические упоминания файлов документов
 * (в т.ч. удалённых/переименованных) — не переписываем и не проверяем.
 */
const SKIP_LINK_PREFIXES = ['.opencode/tasks/'];

function resolveDocTarget(file, target) {
  const candidates = target.startsWith('./') || target.startsWith('../') || target.startsWith('/')
    ? [resolve(dirname(file), target)]
    : [resolve(ROOT, target), resolve(dirname(file), target), join(AD_DIR, target), join(LEGACY_DIR, target)];
  return candidates.find((c) => existsSync(c)) || null;
}

function checkLinks(docs) {
  const files = walk(ROOT);
  for (const file of files) {
    if (!SCAN_EXT.test(file)) continue;
    const rel = relRoot(file);
    if (SKIP_LINK_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const lines = readText(file).split('\n');
    lines.forEach((line, idx) => {
      const checked = new Set();
      let m;
      // 1. markdown-ссылки и 2. упоминания с путём — обязаны резолвиться
      MD_LINK_RE.lastIndex = 0;
      while ((m = MD_LINK_RE.exec(line)) !== null) {
        const target = m[1];
        if (!DOC_FILE_TOKEN.test(target)) continue;
        DOC_FILE_TOKEN.lastIndex = 0;
        checked.add(target);
        if (!resolveDocTarget(file, target)) {
          error(`${rel}:${idx + 1}: неразрешимая ссылка на документ — ${target}`);
        }
      }
      DOC_PATH_TOKEN_RE.lastIndex = 0;
      while ((m = DOC_PATH_TOKEN_RE.exec(line)) !== null) {
        const target = m[1];
        if (checked.has(target)) continue;
        checked.add(target);
        if (!resolveDocTarget(file, target)) {
          error(`${rel}:${idx + 1}: неразрешимый путь к документу — ${target}`);
        }
      }
      // 3. «голые» имена файлов документов в тексте: файл может отсутствовать (история) — warning
      DOC_FILE_TOKEN.lastIndex = 0;
      while ((m = DOC_FILE_TOKEN.exec(line)) !== null) {
        const target = m[0];
        if (checked.has(target)) continue;
        if (!resolveDocTarget(file, target)) {
          warn(`${rel}:${idx + 1}: устаревшее упоминание файла документа — ${target}`);
        }
      }
      // 4. номера документов без файла (прототипные 001–021 допустимы)
      DOC_MENTION_RE.lastIndex = 0;
      let mention;
      while ((mention = DOC_MENTION_RE.exec(line)) !== null) {
        const num = mention[0].replace(/^(?:ADR|PROP)-/, '');
        const exists = docs.some((doc) => doc.num === num);
        if (!exists && !PROTOTYPE_MENTIONS.has(num)) {
          warn(`${rel}:${idx + 1}: упоминание документа без файла — ${mention[0]}`);
        }
      }
    });
  }
}

function checkIndexCompleteness(docs) {
  const readme = existsSync(README_PATH) ? readText(README_PATH) : '';
  const agents = existsSync(AGENTS_PATH) ? readText(AGENTS_PATH) : '';
  const indexed = new Set(parseDescriptions(readme).keys());
  for (const doc of docs) {
    if (!indexed.has(doc.id)) error(`docs/arch_decisions/README.md: ${doc.id} отсутствует в индексе`);
  }
  if (!agents.includes(INDEX_START) || !agents.includes(INDEX_END)) {
    error(`AGENTS.md: не найдены маркеры ${INDEX_START} / ${INDEX_END}`);
  }
}

function checkStatusIntegrity(docs) {
  for (const doc of docs) {
    if (doc.token === TOKEN_DONE && !doc.hasImplSection) {
      warn(`${doc.rel}: «${TOKEN_DONE}» без раздела «Статус в коде»/«Реализация»`);
    }
    if (doc.token === TOKEN_PROPOSAL && !doc.deadline) {
      warn(`${doc.rel}: actionable-предложение без строки «> **Решение до:**»`);
    }
    if (doc.token === null) {
      warn(`${doc.rel}: неканонический статус — «${doc.status || 'нет строки Статус'}»`);
    }
    if (doc.token === TOKEN_ADOPTED) {
      if (doc.kind !== 'PROP') warn(`${doc.rel}: статус «${TOKEN_ADOPTED}» допустим только для предложения`);
      if (!doc.adoptedAs) warn(`${doc.rel}: «${TOKEN_ADOPTED}» без ссылки на ADR — ожидается «Принято (ADR-NNN)»`);
      else if (!docs.some((d) => d.kind === 'ADR' && d.num === doc.adoptedAs)) {
        warn(`${doc.rel}: принято как ADR-${doc.adoptedAs}, но такого ADR в каталоге нет`);
      }
    }
    if (doc.kind === 'ADR' && [TOKEN_PROPOSAL, TOKEN_VISION, TOKEN_ICEBOX, TOKEN_ADOPTED].includes(doc.token)) {
      warn(`${doc.rel}: статус предложения у ADR — «${doc.status}»`);
    }
    if (doc.kind === 'PROP' && (doc.token === TOKEN_DONE || doc.token === TOKEN_PARTIAL)) {
      warn(`${doc.rel}: ADR-статус у предложения — используйте «${TOKEN_ADOPTED} (ADR-NNN)»`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const docs = readAllDocs();

  if (WRITE) {
    const descriptions = parseDescriptions(existsSync(README_PATH) ? readText(README_PATH) : '', { stripLinks: true });
    writeText(README_PATH, renderReadme(docs, descriptions));

    const agents = readText(AGENTS_PATH);
    const agentsDescriptions = parseDescriptions(agents);
    const block = renderAgentsIndex(docs, agentsDescriptions);
    const updated = replaceAgentsIndex(agents, block);
    if (updated === null) {
      console.error(`✖ AGENTS.md: не найдены маркеры ${INDEX_START} / ${INDEX_END} — индекс не обновлён`);
      process.exitCode = 1;
      return;
    }
    if (updated !== agents) writeText(AGENTS_PATH, updated);
    console.log(`✔ индексы обновлены (документов: ${docs.length})`);
    return;
  }

  checkLinks(docs);
  checkIndexCompleteness(docs);
  checkStatusIntegrity(docs);

  for (const w of warnings) console.warn(`⚠ ${w}`);
  for (const e of errors) console.error(`✖ ${e}`);

  const summary = `документов: ${docs.length}; ошибок: ${errors.length}; предупреждений: ${warnings.length}`;
  if (errors.length > 0) {
    console.error(`adr-check FAILED — ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`adr-check OK — ${summary}`);
}

main();
