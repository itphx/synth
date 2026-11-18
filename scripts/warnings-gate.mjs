#!/usr/bin/env node
/**
 * scripts/warnings-gate.mjs — числовой гейт на количество предупреждений (Node 22+, только `node:*`).
 *
 * Зачем: у линта и сборки есть «мягкий» выход — предупреждения печатаются, но не ломают прогон.
 * `--max-warnings` в пакетных скриптах держит ратчет по пакету, однако общий счётчик нигде
 * не зафиксирован: один пакет мог вырасти, другой — упасть, и деградация проходила молча.
 * Этот скрипт фиксирует **число** предупреждений (`scripts/warnings-budget.json`) и падает
 * при превышении — в CI (шаг «Гейт предупреждений») и локально (`pnpm warnings`).
 *
 * Режимы:
 *   lint (по умолчанию) — `eslint src/ -f json` в каждом пакете `packages/*` (пакет определяется
 *     по `package.json` с непустым скриптом `lint`); суммируются warnings и errors по всем
 *     пакетам, печатается таблица «пакет / warnings / errors / бюджет», сумма сверяется с
 *     `lint`-бюджетом;
 *   --build [<logfile>] — разбор лога сборки (файл либо stdin): строки `(!) …`,
 *     `DeprecationWarning`, `warning TS####`, `WARN …`; совпадения из `buildAllow`
 *     подавляются (учтены отдельным счётчиком), остальные сверяются с `build`-бюджетом.
 *
 * В lint-режиме errors всегда блокируют (они и так ломают `pnpm lint`, но гейт не должен
 * показывать «зелено» при красном линте); бюджет считается только по warnings.
 *
 * Бюджет — `scripts/warnings-budget.json` (`lint`, `build`, `buildAllow`). Приоритет
 * переопределения: `--max N` > env `WARN_BUDGET` > значение из файла. `--max` заменяет
 * бюджет активного режима.
 *
 * Использование:
 *   node scripts/warnings-gate.mjs                        # линт против бюджета
 *   node scripts/warnings-gate.mjs --max 0                # разово: ноль предупреждений
 *   node scripts/warnings-gate.mjs --build tmp/build.log   # гейт лога сборки
 *   pnpm build 2>&1 | node scripts/warnings-gate.mjs --build
 *
 * Коды возврата: 0 — в бюджете, 1 — превышение бюджета (или ошибки линта),
 *                2 — ошибка запуска/конфигурации (нет бюджета, битый JSON, eslint не отдал отчёт).
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2);

/** Значение флага: `--flag value` или `--flag=value`; иначе `null`. */
function valueOf(name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? null : next;
}

const ROOT = resolve(valueOf('--root') ?? resolve(import.meta.dirname, '..'));
const BUILD_MODE = argv.includes('--build');
const BUILD_LOG = BUILD_MODE ? valueOf('--build') : null;
const BUDGET_PATH = resolve(ROOT, 'scripts/warnings-budget.json');
const PACKAGES_DIR = resolve(ROOT, 'packages');
const ESLINT_BIN = resolve(ROOT, 'node_modules/.bin/eslint');

const rel = (path) => relative(ROOT, path) || path;

const fail = (message) => {
  console.error(`warnings-gate: ${message}`);
  process.exit(2);
};

/** Снимает ANSI-последовательности: цветной вывод в логе джобы не должен ломать разбор. */
const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '');

// --- Бюджет -----------------------------------------------------------------

/**
 * Читает `scripts/warnings-budget.json`. `_comment` и прочие `_`-поля — служебные.
 * Отсутствие/битые значения — ошибка запуска (exit 2), а не «бюджета нет — пропускаем»:
 * иначе гейт молча перестаёт быть гейтом.
 */
function loadBudget() {
  if (!existsSync(BUDGET_PATH)) {
    fail(`нет файла бюджета ${rel(BUDGET_PATH)} — создайте его (см. комментарий в шапке скрипта)`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  } catch (error) {
    fail(`${rel(BUDGET_PATH)} не читается как JSON: ${error.message}`);
  }
  const readLimit = (field) => {
    const value = raw[field];
    if (!Number.isInteger(value) || value < 0) {
      fail(`битое поле «${field}» в ${rel(BUDGET_PATH)}: нужно целое ≥ 0, получено ${JSON.stringify(value)}`);
    }
    return value;
  };
  const buildAllow = raw.buildAllow ?? [];
  if (!Array.isArray(buildAllow) || buildAllow.some((item) => typeof item !== 'string' || !item.trim())) {
    fail(`поле buildAllow в ${rel(BUDGET_PATH)}: массив непустых строк (подстроки подавляемых строк)`);
  }
  return { lint: readLimit('lint'), build: readLimit('build'), buildAllow };
}

const configured = loadBudget();

/** Переопределение бюджета: `--max N` > env `WARN_BUDGET` > файл. */
function resolveBudget(modeBudget) {
  const override = valueOf('--max') ?? process.env.WARN_BUDGET ?? null;
  if (override === null) return { limit: modeBudget, source: rel(BUDGET_PATH) };
  const parsed = Number(override);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`некорректный бюджет «${override}»: нужно целое ≥ 0`);
  }
  const source = valueOf('--max') !== null ? '--max' : 'WARN_BUDGET';
  return { limit: parsed, source };
}

// --- Таблица ----------------------------------------------------------------

const pad = (text, width, align = 'left') =>
  align === 'right' ? String(text).padStart(width) : String(text).padEnd(width);

function renderTable(columns, rows) {
  const lines = [columns.map(([title, width, align]) => pad(title, width, align)).join('  ')];
  lines.push(columns.map(([, width]) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    lines.push(
      columns.map(([, width, align], index) => pad(row[index] ?? '', width, align)).join('  ').trimEnd(),
    );
  }
  return lines.join('\n');
}

// --- Режим lint -------------------------------------------------------------

/** Пакеты с линтом: каталог `packages/*` + `package.json` + непустой скрипт `lint`. */
function discoverPackages() {
  if (!existsSync(PACKAGES_DIR)) fail(`нет каталога пакетов ${rel(PACKAGES_DIR)}`);
  const found = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES_DIR, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      fail(`${rel(manifestPath)} не читается как JSON: ${error.message}`);
    }
    const lintScript = manifest.scripts?.lint;
    if (typeof lintScript !== 'string' || !lintScript.trim()) continue;
    found.push({ dir, name: manifest.name ?? entry.name });
  }
  if (!found.length) fail(`в ${rel(PACKAGES_DIR)} нет пакетов со скриптом lint`);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** `execFile` в промис: код выхода, stdout/stderr (без исключений на ненулевом коде). */
const run = (command, args, options) =>
  new Promise((done) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      done({ code, stdout: stdout ?? '', stderr: stderr ?? '', spawnError: error?.message ?? null });
    });
  });

/** Пул на N параллельных задач — eslint по пакетам тяжёлый, но независимый. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Прогон eslint с JSON-отчётом в каталоге пакета (конфиг — общий корневой, flat config). */
async function lintPackage(pkg) {
  const args = ['src/', '-f', 'json', '--no-color'];
  const hasLocalEslint = existsSync(ESLINT_BIN);
  const command = hasLocalEslint ? ESLINT_BIN : 'pnpm';
  const fullArgs = hasLocalEslint ? args : ['exec', 'eslint', ...args];
  const result = await run(command, fullArgs, { cwd: pkg.dir, encoding: 'utf8' });

  const output = stripAnsi(result.stdout);
  const start = output.indexOf('[');
  if (start === -1) {
    fail(
      `eslint в ${pkg.name} не отдал JSON-отчёт (exit ${result.code})` +
        `${result.spawnError ? `: ${result.spawnError}` : ''}` +
        `${result.stderr.trim() ? `: ${stripAnsi(result.stderr).trim().split('\n').slice(-5).join(' | ')}` : ''}`,
    );
  }
  let report;
  try {
    report = JSON.parse(output.slice(start));
  } catch (error) {
    fail(`JSON-отчёт eslint в ${pkg.name} не разобран: ${error.message}`);
  }
  const warnings = report.reduce((sum, file) => sum + (file.warningCount ?? 0), 0);
  const errors = report.reduce((sum, file) => sum + (file.errorCount ?? 0), 0);
  const fatal = report.filter((file) => (file.fatalErrorCount ?? 0) > 0).length;
  return { ...pkg, warnings, errors, fatal };
}

async function runLintMode() {
  const packages = discoverPackages();
  const { limit, source } = resolveBudget(configured.lint);

  console.log('=== Гейт предупреждений: линт (scripts/warnings-gate.mjs) ===');
  console.log(`Пакетов со скриптом lint: ${packages.length}; бюджет: ${limit} (${source})\n`);

  const rows = await mapLimit(packages, 4, lintPackage);
  const totalWarnings = rows.reduce((sum, row) => sum + row.warnings, 0);
  const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);

  const table = renderTable(
    [
      ['пакет', 34],
      ['warnings', 9, 'right'],
      ['errors', 7, 'right'],
      ['бюджет', 7, 'right'],
    ],
    [
      ...rows.map((row) => [row.name, row.warnings, row.errors, '—']),
      ['итого', totalWarnings, totalErrors, limit],
    ],
  );
  console.log(table);
  console.log(`\nбюджет: ${limit}, факт: ${totalWarnings} (warnings), errors: ${totalErrors}`);

  const failing = rows.filter((row) => row.errors > 0 || row.fatal > 0);
  if (failing.length) {
    console.error('\nОшибки линта (гейт не оценивает бюджет, пока линт красный):');
    for (const row of failing) {
      console.error(`  - ${row.name}: errors ${row.errors}${row.fatal ? `, файлов с fatal ${row.fatal}` : ''}`);
    }
    process.exit(1);
  }

  if (totalWarnings > limit) {
    const worst = [...rows].sort((a, b) => b.warnings - a.warnings).slice(0, 5);
    console.error(`\nПревышение бюджета предупреждений: ${totalWarnings} > ${limit} (перебор ${totalWarnings - limit}).`);
    console.error('Больше всего предупреждений:');
    for (const row of worst) console.error(`  - ${row.name}: ${row.warnings}`);
    console.error(
      '\nЧто делать: починить новые предупреждения (а не поднять бюджет). ' +
        `Ратчет — ${rel(BUDGET_PATH)}; осознанное решение фиксируется там же, разово — --max N.`,
    );
    process.exit(1);
  }

  console.log('\nПредупреждений в пределах бюджета.');
  process.exit(0);
}

// --- Режим --build ----------------------------------------------------------

/** Правила поиска предупреждений в логе сборки (порядок важен: первое совпадение). */
const BUILD_RULES = [
  { id: '(!)', test: (line) => /^\s*\(!\)/.test(line) },
  { id: 'DeprecationWarning', test: (line) => /DeprecationWarning/.test(line) },
  { id: 'warning TS', test: (line) => /\bwarning TS\d+/.test(line) },
  { id: 'WARN', test: (line) => /\bWARN\b/.test(line) },
];

function readBuildLog() {
  if (BUILD_LOG) {
    const path = resolve(ROOT, BUILD_LOG);
    if (!existsSync(path)) fail(`лог сборки не найден: ${BUILD_LOG}`);
    return readFileSync(path, 'utf8');
  }
  if (process.stdin.isTTY) {
    fail('нет источника лога: передайте файл (`--build tmp/build.log`) или подайте лог в stdin');
  }
  try {
    return readFileSync(0, 'utf8');
  } catch (error) {
    fail(`stdin не читается: ${error.message}`);
  }
}

function runBuildMode() {
  const { limit, source } = resolveBudget(configured.build);
  const raw = stripAnsi(readBuildLog());
  const allow = configured.buildAllow;

  const found = [];
  const allowed = [];
  raw.split('\n').forEach((line, index) => {
    const text = line.trimEnd();
    if (!text.trim()) return;
    const rule = BUILD_RULES.find((candidate) => candidate.test(text));
    if (!rule) return;
    const entry = { line: index + 1, rule: rule.id, text: text.trim() };
    const allowHit = allow.find((pattern) => text.includes(pattern));
    if (allowHit) allowed.push({ ...entry, allowHit });
    else found.push(entry);
  });

  console.log('=== Гейт предупреждений: сборка (scripts/warnings-gate.mjs) ===');
  console.log(`Источник: ${BUILD_LOG ?? 'stdin'}; бюджет: ${limit} (${source})\n`);

  if (found.length) {
    console.log('Найденные предупреждения:');
    for (const entry of found.slice(0, 80)) {
      console.log(`  строка ${entry.line} [${entry.rule}] ${entry.text}`);
    }
    if (found.length > 80) console.log(`  … и ещё ${found.length - 80}`);
    console.log('');
  }
  if (allowed.length) {
    console.log(`Подавлено allowlist (${rel(BUDGET_PATH)} → buildAllow): ${allowed.length}`);
    for (const entry of allowed.slice(0, 20)) {
      console.log(`  строка ${entry.line} [${entry.rule}] ${entry.text} (по «${entry.allowHit}»)`);
    }
    if (allowed.length > 20) console.log(`  … и ещё ${allowed.length - 20}`);
    console.log('');
  }

  console.log(`бюджет: ${limit}, факт: ${found.length}`);

  if (found.length > limit) {
    console.error(`\nПревышение бюджета предупреждений сборки: ${found.length} > ${limit} (перебор ${found.length - limit}).`);
    console.error(
      'Что делать: убрать причину предупреждения (размер чанка — бюджет `pnpm bundle:budget`, ' +
        'deprecation — апгрейд зависимости). Осознанно принятый шум — точечная подстрока в buildAllow ' +
        `(${rel(BUDGET_PATH)}), а не поднятый бюджет.`,
    );
    process.exit(1);
  }

  console.log('\nПредупреждений сборки нет (в пределах бюджета).');
  process.exit(0);
}

// --- main -------------------------------------------------------------------

if (BUILD_MODE) runBuildMode();
else await runLintMode();
