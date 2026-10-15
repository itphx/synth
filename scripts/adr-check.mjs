#!/usr/bin/env node
/**
 * scripts/adr-check.mjs — индекс и целостность архитектурных решений (AD) Synth.
 *
 * Запуск (без внешних зависимостей, только node:*):
 *   node scripts/adr-check.mjs          # проверка: ссылки, полнота индекса, целостность статусов
 *   node scripts/adr-check.mjs --write  # перегенерация индексов (идемпотентно)
 *
 * Что делает:
 *   1. `--write` — парсит `> **Статус:**` (канонический токен) и H1 каждого `docs/arch_decisions/ad-*.md`
 *      и пересобирает: таблицы в `docs/arch_decisions/README.md` (Реализовано / Частично / Предложения /
 *      Заменено / Отклонено / Legacy) и строки индекса AD в `AGENTS.md` (между маркерами
 *      `<!-- ad-index:start -->` / `<!-- ad-index:end -->`).
 *   2. проверяет, что все относительные ссылки на `ad-*.md` (в md/ts/tsx) резолвятся, что каждый файл AD
 *      присутствует в индексе и что нет ссылок на несуществующий AD (упоминания «голых» номеров
 *      прототипных AD 001–021 — warning).
 *   3. предупреждает, если `✅ Реализовано` без раздела «Статус в коде»/«Реализация», и если
 *      actionable-предложение (`🧩 Предложение`) без строки `> **Решение до:**`.
 *
 * Правила ведения AD и жизненный цикл документов — docs/ARCH_DECISIONS.md.
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

// ── Канонические статусы (docs/ARCH_DECISIONS.md) ───────────────────────────

const TOKEN_DONE = '✅ Реализовано';
const TOKEN_PARTIAL = '⚠️ Частично';
const TOKEN_PROPOSAL = '🧩 Предложение';
const TOKEN_VISION = '🧩 Предложение (vision)';
const TOKEN_ICEBOX = '🧊 Icebox';
const TOKEN_SUPERSEDED = '⛔ Заменено';
const TOKEN_REJECTED = '🗑 Отклонено';

/** Секции индекса README: порядок и состав токенов. */
const SECTIONS = [
  { title: 'Реализовано', tokens: [TOKEN_DONE] },
  { title: 'Частично', tokens: [TOKEN_PARTIAL] },
  { title: 'Предложения', tokens: [TOKEN_PROPOSAL, TOKEN_VISION, TOKEN_ICEBOX] },
  { title: 'Заменено', tokens: [TOKEN_SUPERSEDED] },
  { title: 'Отклонено', tokens: [TOKEN_REJECTED] },
];

/** AD прототипа без файлов в каталоге: упоминания в тексте допустимы. */
const PROTOTYPE_MENTIONS = new Set([
  '001', '002', '003', '004', '006', '007', '010', '011', '012', '013', '015', '016', '020', '021',
]);

/** Расширения, в которых ищем ссылки на AD. */
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

// ── Чтение AD ──────────────────────────────────────────────────────────────

function parseAdFile(path, legacy) {
  const text = readText(path);
  const fileName = path.split('/').pop();
  const idMatch = fileName.match(/^ad-(\d+)/);
  if (!idMatch) return null;
  const num = idMatch[1];
  const titleLine = (text.match(/^#\s+AD-\d+[^:]*:\s*(.*)$/m) || [])[1] || fileName;
  const statusLine = (text.match(STATUS_RE) || [])[1] || '';
  const deadline = (text.match(DEADLINE_RE) || [])[1] || '';
  return {
    num,
    id: `AD-${num}`,
    fileName,
    path,
    rel: relRoot(path),
    title: titleLine.trim(),
    status: statusLine.trim(),
    token: detectToken(statusLine),
    deadline: deadline.trim(),
    legacy: Boolean(legacy),
    hasImplSection: IMPL_SECTION_RE.test(text),
    lines: text.split('\n').length,
  };
}

function readAllAds() {
  const ads = [];
  for (const entry of readdirSync(AD_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !/^ad-\d+.*\.md$/.test(entry.name)) continue;
    const ad = parseAdFile(join(AD_DIR, entry.name), false);
    if (ad) ads.push(ad);
  }
  if (existsSync(LEGACY_DIR)) {
    for (const entry of readdirSync(LEGACY_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/^ad-\d+.*\.md$/.test(entry.name)) continue;
      const ad = parseAdFile(join(LEGACY_DIR, entry.name), true);
      if (ad) ads.push(ad);
    }
  }
  ads.sort((a, b) => Number(a.num) - Number(b.num));
  return ads;
}

// ── Разбор существующих индексов (сохраняем описания) ───────────────────────

/** `| AD-005 | описание | … |` → Map<num, описание>. */
function parseDescriptions(text, { stripLinks = false } = {}) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*AD-(\d+)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    let desc = cells[0] || '';
    const link = desc.match(/^\[([^\]]+)\]\([^)]*\)$/);
    if (link) desc = link[1];
    if (stripLinks) desc = desc.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    desc = desc.replace(/\s*\|\s*$/, '').trim();
    if (!map.has(m[1]) || !map.get(m[1])) map.set(m[1], desc);
  }
  return map;
}

// ── Генерация README ───────────────────────────────────────────────────────

const README_HEADER = `# Архитектурные решения (AD)

> Индекс каталога архитектурных решений. Правила ведения, жизненный цикл и классы документов —
> [docs/ARCH_DECISIONS.md](../ARCH_DECISIONS.md); предложения и сроки решений — [docs/roadmap.md](../roadmap.md).
> Номера AD стабильны: файлы не переносятся и не удаляются (ссылок на AD-id по репозиторию — тысячи).

Таблицы собираются автоматически — вручную не правь:
\`node scripts/adr-check.mjs --write\` (проверка — \`node scripts/adr-check.mjs\`).`;

function renderReadme(ads, descriptions) {
  const lines = [README_HEADER, ''];
  for (const section of SECTIONS) {
    const rows = ads
      .filter((ad) => !ad.legacy && section.tokens.includes(ad.token))
      .sort((a, b) => section.tokens.indexOf(a.token) - section.tokens.indexOf(b.token) || Number(a.num) - Number(b.num));
    if (rows.length === 0) continue;
    lines.push(`## ${section.title}`, '');
    lines.push('| AD | Тема | Статус | Файл |', '|----|------|--------|------|');
    for (const ad of rows) {
      const desc = descriptions.get(ad.num) || ad.title;
      lines.push(`| ${ad.id} | ${desc} | ${ad.token} | [${ad.fileName}](./${ad.fileName}) |`);
    }
    lines.push('');
  }
  const legacy = ads.filter((ad) => ad.legacy);
  if (legacy.length > 0) {
    lines.push('## Legacy', '');
    lines.push('| AD | Тема | Статус | Файл |', '|----|------|--------|------|');
    for (const ad of legacy) {
      const desc = descriptions.get(ad.num) || ad.title;
      lines.push(`| ${ad.id} | ${desc} | ${ad.token || TOKEN_SUPERSEDED} | [legacy/${ad.fileName}](./legacy/${ad.fileName}) |`);
    }
    lines.push('');
  }
  const counts = [
    `Реализовано: ${ads.filter((a) => a.token === TOKEN_DONE).length}`,
    `Частично: ${ads.filter((a) => a.token === TOKEN_PARTIAL).length}`,
    `Предложения: ${ads.filter((a) => a.token === TOKEN_PROPOSAL).length}`,
    `Vision: ${ads.filter((a) => a.token === TOKEN_VISION).length}`,
    `Icebox: ${ads.filter((a) => a.token === TOKEN_ICEBOX).length}`,
    `Legacy: ${ads.filter((a) => a.legacy).length}`,
  ];
  lines.push('---', '', `Всего AD: ${ads.length} (${counts.join(', ')}).`, '');
  return lines.join('\n');
}

// ── Генерация индекса в AGENTS.md ──────────────────────────────────────────

function renderAgentsIndex(ads, descriptions) {
  const lines = [
    INDEX_START,
    '| AD | Суть | Статус | Файл |',
    '|----|------|--------|------|',
  ];
  for (const ad of ads.filter((a) => !a.legacy)) {
    const desc = descriptions.get(ad.num) || ad.title;
    lines.push(`| ${ad.id} | ${desc} | ${ad.token || '—'} | [ad-${ad.num}](./${ad.rel}) |`);
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

const AD_FILE_TOKEN = /ad-\d+[\w.-]*\.md/g;
/** Markdown-ссылка `[текст](цель)`. */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** Упоминание с путём (есть хотя бы один `/`). */
const AD_PATH_TOKEN_RE = /(?:^|[^\w-])((?:\.{0,2}\/|\/)?(?:[\w.@-]+\/)+ad-\d+[\w.-]*\.md)/g;
/** «Голый» номер AD. */
const AD_MENTION_RE = /AD-\d{3}/g;
/**
 * Append-only журналы задач (.opencode/tasks/*): исторические упоминания файлов AD
 * (в т.ч. удалённых/переименованных) — не переписываем и не проверяем.
 */
const SKIP_LINK_PREFIXES = ['.opencode/tasks/'];

function resolveAdTarget(file, target) {
  const candidates = target.startsWith('./') || target.startsWith('../') || target.startsWith('/')
    ? [resolve(dirname(file), target)]
    : [resolve(ROOT, target), resolve(dirname(file), target), join(AD_DIR, target), join(LEGACY_DIR, target)];
  return candidates.find((c) => existsSync(c)) || null;
}

function checkLinks(ads) {
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
        if (!AD_FILE_TOKEN.test(target)) continue;
        AD_FILE_TOKEN.lastIndex = 0;
        checked.add(target);
        if (!resolveAdTarget(file, target)) {
          error(`${rel}:${idx + 1}: неразрешимая ссылка на AD — ${target}`);
        }
      }
      AD_PATH_TOKEN_RE.lastIndex = 0;
      while ((m = AD_PATH_TOKEN_RE.exec(line)) !== null) {
        const target = m[1];
        if (checked.has(target)) continue;
        checked.add(target);
        if (!resolveAdTarget(file, target)) {
          error(`${rel}:${idx + 1}: неразрешимый путь к AD — ${target}`);
        }
      }
      // 3. «голые» имена файлов AD в тексте: файл может отсутствовать (история) — warning
      AD_FILE_TOKEN.lastIndex = 0;
      while ((m = AD_FILE_TOKEN.exec(line)) !== null) {
        const target = m[0];
        if (checked.has(target)) continue;
        if (!resolveAdTarget(file, target)) {
          warn(`${rel}:${idx + 1}: устаревшее упоминание файла AD — ${target}`);
        }
      }
      // 4. номера AD без файла (прототипные 001–021 допустимы)
      AD_MENTION_RE.lastIndex = 0;
      let mention;
      while ((mention = AD_MENTION_RE.exec(line)) !== null) {
        const num = mention[0].slice(3);
        const exists = ads.some((ad) => ad.num === num);
        if (!exists && !PROTOTYPE_MENTIONS.has(num)) {
          warn(`${rel}:${idx + 1}: упоминание AD без файла — ${mention[0]}`);
        }
      }
    });
  }
}

function checkIndexCompleteness(ads) {
  const readme = existsSync(README_PATH) ? readText(README_PATH) : '';
  const agents = existsSync(AGENTS_PATH) ? readText(AGENTS_PATH) : '';
  const indexed = new Set(parseDescriptions(readme).keys());
  for (const ad of ads) {
    if (!indexed.has(ad.num)) error(`docs/arch_decisions/README.md: ${ad.id} отсутствует в индексе`);
  }
  if (!agents.includes(INDEX_START) || !agents.includes(INDEX_END)) {
    error(`AGENTS.md: не найдены маркеры ${INDEX_START} / ${INDEX_END}`);
  }
}

function checkStatusIntegrity(ads) {
  for (const ad of ads) {
    if (ad.token === TOKEN_DONE && !ad.hasImplSection) {
      warn(`${ad.rel}: «${TOKEN_DONE}» без раздела «Статус в коде»/«Реализация»`);
    }
    if (ad.token === TOKEN_PROPOSAL && !ad.deadline) {
      warn(`${ad.rel}: actionable-предложение без строки «> **Решение до:**»`);
    }
    if (ad.token === null) {
      warn(`${ad.rel}: неканонический статус — «${ad.status || 'нет строки Статус'}»`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const ads = readAllAds();

  if (WRITE) {
    const descriptions = parseDescriptions(existsSync(README_PATH) ? readText(README_PATH) : '', { stripLinks: true });
    writeText(README_PATH, renderReadme(ads, descriptions));

    const agents = readText(AGENTS_PATH);
    const agentsDescriptions = parseDescriptions(agents);
    const block = renderAgentsIndex(ads, agentsDescriptions);
    const updated = replaceAgentsIndex(agents, block);
    if (updated === null) {
      console.error(`✖ AGENTS.md: не найдены маркеры ${INDEX_START} / ${INDEX_END} — индекс не обновлён`);
      process.exitCode = 1;
      return;
    }
    if (updated !== agents) writeText(AGENTS_PATH, updated);
    console.log(`✔ индексы обновлены (AD: ${ads.length})`);
    return;
  }

  checkLinks(ads);
  checkIndexCompleteness(ads);
  checkStatusIntegrity(ads);

  for (const w of warnings) console.warn(`⚠ ${w}`);
  for (const e of errors) console.error(`✖ ${e}`);

  const summary = `AD: ${ads.length}; ошибок: ${errors.length}; предупреждений: ${warnings.length}`;
  if (errors.length > 0) {
    console.error(`adr-check FAILED — ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`adr-check OK — ${summary}`);
}

main();
