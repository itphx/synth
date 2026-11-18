#!/usr/bin/env node
/**
 * scripts/bundle-budget.mjs — бюджет размера чанков UI-сборки (Node 22+, только `node:*`).
 *
 * Зачем: предупреждение Vite «chunks are larger than 500 kB» — общий порог, который либо
 * шумит на известном долге, либо (если его поднять) перестаёт замечать рост. Поэтому
 * порог Vite в `packages/ui/vite.config.ts` поднят до уровня старого долга, а реальный
 * контроль размера держит этот скрипт: у каждого чанка есть зафиксированный размер и
 * допуск на рост. Новый тяжёлый чанк без бюджета и «протухшая» запись бюджета — ошибка.
 *
 * Что читает: `packages/ui/dist/assets/*.js` и `*.css` (результат
 * `pnpm --filter @itphx/synth-ui build`), манифест — `scripts/bundle-budget.json`.
 *
 * Ключ бюджета — имя чанка **без хеша** (`vendor-misc-BVxk9LR4.js` → `vendor-misc`), поэтому
 * запись переживает пересборки. Один префикс может встречаться у нескольких файлов (например
 * `dist-*` из глубины `node_modules`): тогда бюджет — наибольший размер в этом семействе, а
 * проверяется каждый файл отдельно.
 *
 * Использование:
 *   node scripts/bundle-budget.mjs              # проверка (exit 1 при превышении/аномалии)
 *   node scripts/bundle-budget.mjs --update     # перезаписать манифест фактическими размерами
 *   node scripts/bundle-budget.mjs --root <dir> # корень репозитория (по умолчанию — из пути скрипта)
 *
 * Коды возврата: 0 — в бюджете, 1 — превышение/новый тяжёлый чанк/устаревший бюджет,
 *                2 — нет сборки или битый манифест (ошибка запуска).
 *
 * Скрипт только читает `dist` и (в режиме `--update`) пишет манифест; в сеть не ходит.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const ROOT = resolve(valueOf('--root') ?? resolve(import.meta.dirname, '..'));
const UPDATE = argv.includes('--update');
const BUDGET_PATH = resolve(ROOT, 'scripts/bundle-budget.json');
const ASSETS_DIR = resolve(ROOT, 'packages/ui/dist/assets');

/** Допуск на рост относительно бюджета: +5% (сборка не байт-в-байт стабильна). */
const TOLERANCE = 0.05;
/** Порог «тяжёлого» чанка для записей, которых ещё нет в бюджете (как у Vite: 500 kB). */
const UNKNOWN_HEAVY_BYTES = 500 * 1000;
/** Хеш в имени файла — 8 символов base64url (может содержать `-` и `_`). */
const HASH_SUFFIX = /^(.+)-[A-Za-z0-9_-]{8}$/;
const COMMENT =
  'Бюджет размера чанков UI-сборки (pnpm --filter @itphx/synth-ui build). ' +
  'Проверка: pnpm bundle:budget, обновление: pnpm bundle:budget:update. ' +
  'Ключ — имя чанка без хеша; допуск на рост +5%; для повторяющихся префиксов ' +
  '(dist, css, javascript…) бюджет — наибольший размер в семействе.';

// --- Утилиты ----------------------------------------------------------------

const fail = (message) => {
  console.error(`bundle-budget: ${message}`);
  process.exit(2);
};

/** Имя чанка без хеша: `vendor-misc-BVxk9LR4.js` → `vendor-misc`. */
function chunkKey(fileName) {
  const base = fileName.replace(/\.(js|css)$/, '');
  const match = base.match(HASH_SUFFIX);
  return match ? match[1] : base;
}

/** Размер в человекочитаемом виде (десятичные kB/MB — как в отчёте Vite). */
function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${bytes} B`;
}

function formatDelta(fact, budget) {
  if (!budget) return '—';
  const percent = ((fact - budget) / budget) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

const padLeft = (text, width) => String(text).padStart(width);
const padRight = (text, width) => String(text).padEnd(width);

// --- Рендер таблицы ---------------------------------------------------------

const COLUMNS = [
  ['чанк', 26, padRight],
  ['факт', 10, padLeft],
  ['бюджет', 10, padLeft],
  ['дельта', 8, padLeft],
  ['статус', 12, padRight],
];

function renderTable(rows) {
  const lines = [];
  lines.push(COLUMNS.map(([title, width, pad]) => pad(title, width)).join('  '));
  lines.push(COLUMNS.map(([, width]) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    lines.push(
      COLUMNS.map(([, width, pad], index) => pad(row[index], width)).join('  ').trimEnd(),
    );
  }
  return lines.join('\n');
}

// --- Сбор данных ------------------------------------------------------------

/** @returns {Array<{file: string, key: string, bytes: number}> | null} */
function scanAssets() {
  if (!existsSync(ASSETS_DIR)) return null;
  return readdirSync(ASSETS_DIR)
    .filter((file) => /\.(js|css)$/.test(file))
    .map((file) => ({
      file,
      key: chunkKey(file),
      bytes: statSync(resolve(ASSETS_DIR, file)).size,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
}

/** @returns {Map<string, number> | null} */
function loadBudget() {
  if (!existsSync(BUDGET_PATH)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  } catch (error) {
    fail(`не удалось прочитать ${BUDGET_PATH}: ${error.message}`);
  }
  const budget = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // `_comment` и прочие служебные поля
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      fail(`битая запись бюджета «${key}»: ожидается положительное число байт`);
    }
    budget.set(key, value);
  }
  return budget;
}

const chunks = scanAssets();
if (!chunks) {
  fail(`нет сборки UI: ${ASSETS_DIR}. Сначала: pnpm --filter @itphx/synth-ui build`);
}

// --- Режим --update ---------------------------------------------------------

if (UPDATE) {
  // Бюджет по префиксу = наибольший размер среди файлов с этим префиксом.
  const byKey = new Map();
  for (const chunk of chunks) {
    byKey.set(chunk.key, Math.max(byKey.get(chunk.key) ?? 0, chunk.bytes));
  }
  const sorted = [...byKey.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const manifest = { _comment: COMMENT };
  for (const [key, bytes] of sorted) manifest[key] = bytes;
  writeFileSync(BUDGET_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const rows = sorted.map(([key, bytes]) => [
    key,
    formatBytes(bytes),
    formatBytes(bytes),
    '0.0%',
    'ok',
  ]);
  console.log(renderTable(rows));
  console.log(
    `\nБюджет обновлён: ${sorted.length} ключей / ${chunks.length} файлов → ${BUDGET_PATH}`,
  );
  process.exit(0);
}

// --- Режим проверки --------------------------------------------------------

const budget = loadBudget();
if (!budget) {
  fail(`нет манифеста бюджета ${BUDGET_PATH}. Создать: node scripts/bundle-budget.mjs --update`);
}

const violations = [];
const coveredKeys = new Set();
const unknownKeys = new Map(); // key → { bytes, file }

/** Группы по ключу: для строки таблицы берём худший файл семейства. */
const groups = new Map(); // key → { bytes, file, count }
for (const chunk of chunks) {
  const known = budget.get(chunk.key);
  if (known === undefined) {
    unknownKeys.set(chunk.key, { bytes: chunk.bytes, file: chunk.file });
    if (chunk.bytes > UNKNOWN_HEAVY_BYTES) {
      violations.push(
        `новый тяжёлый чанк ${chunk.file} (${formatBytes(chunk.bytes)}, ключ «${chunk.key}») ` +
          'без бюджета: добавь бюджет (pnpm bundle:budget:update) или разбей чанк',
      );
    }
  } else {
    coveredKeys.add(chunk.key);
    const limit = known * (1 + TOLERANCE);
    if (chunk.bytes > limit) {
      violations.push(
        `превышен бюджет ${chunk.file}: ${formatBytes(chunk.bytes)} > ${formatBytes(known)} +5% ` +
          `(ключ «${chunk.key}»); если рост осознан — обнови бюджет (pnpm bundle:budget:update)`,
      );
    }
  }
  const group = groups.get(chunk.key);
  if (!group || chunk.bytes > group.bytes) {
    groups.set(chunk.key, { bytes: chunk.bytes, file: chunk.file, count: (group?.count ?? 0) + 1 });
  } else {
    group.count += 1;
  }
}

const staleKeys = [...budget.keys()].filter((key) => !coveredKeys.has(key));
for (const key of staleKeys) {
  violations.push(
    `бюджет устарел: чанка с ключом «${key}» больше нет в сборке — ` +
      'убери запись или обнови бюджет (pnpm bundle:budget:update)',
  );
}

const rows = [...groups.entries()]
  .sort((a, b) => b[1].bytes - a[1].bytes || a[0].localeCompare(b[0]))
  .map(([key, group]) => {
    const known = budget.get(key);
    const limit = known === undefined ? null : known * (1 + TOLERANCE);
    const label = group.count > 1 ? `${key} ×${group.count}` : key;
    let status = 'ok';
    if (known === undefined) status = group.bytes > UNKNOWN_HEAVY_BYTES ? 'превышен' : 'нет бюджета';
    else if (group.bytes > limit) status = 'превышен';
    return [
      label,
      formatBytes(group.bytes),
      known === undefined ? '—' : formatBytes(known),
      formatDelta(group.bytes, known ?? 0),
      status,
    ];
  });

console.log(renderTable(rows));

const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
console.log(
  `\nИтого: ${chunks.length} файлов (${groups.size} ключей), ${formatBytes(totalBytes)}; ` +
    `превышений: ${violations.length}; без бюджета: ${unknownKeys.size}; ` +
    `устаревших записей: ${staleKeys.length}.`,
);

if (violations.length > 0) {
  console.error('\nНарушения бюджета бандла:');
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    '\nЕсли рост ожидаемый — обнови бюджет: pnpm bundle:budget:update (осознанное решение, а не рефлекс).',
  );
  process.exit(1);
}

console.log('Бюджет бандла в норме.');
process.exit(0);
