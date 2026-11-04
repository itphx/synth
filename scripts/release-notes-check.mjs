#!/usr/bin/env node
/**
 * scripts/release-notes-check.mjs — обязательная пара заметок релиза.
 *
 * Каждому релизу соответствует пара файлов: `docs/releases/<version>.md` (RU) и
 * `docs/releases/<version>.en.md` (EN). Без них `changelog.sh` уходит в авто-сборку
 * из коммитов, и описания релиза в репозитории не остаётся. Гейт `release-notes`
 * в `release.yaml` проверяет пару ДО сборки артефактов (`build.needs`).
 *
 * Что проверяется для каждого файла:
 *   * существует, размер > 0, после trim непуст;
 *   * первый непустой заголовок — `## <version>` (допускается `## <version> (дата)`).
 *
 * Версия: `--version` (приоритет, ведущий `v` допускается) → `--ref`
 * (только `refs/tags/vX.Y.Z`; `refs/heads/*` игнорируется) →
 * `packages/synth/package.json`.
 *
 * `--require-version` запрещает фоллбек на `packages/synth/package.json`:
 * версия обязана прийти из `--version` или `--ref` (иначе exit 2). Нужен в CI,
 * где версия релиза известна точно и молчаливая проверка чужой версии недопустима.
 *
 * Использование:
 *   node scripts/release-notes-check.mjs --version 0.13.4
 *   node scripts/release-notes-check.mjs --ref refs/tags/v0.13.4
 *   node scripts/release-notes-check.mjs --require-version --ref refs/tags/v0.13.4
 *   pnpm release:notes -- --version 0.13.4
 *
 * Коды возврата: 0 — пара на месте, 1 — заметки отсутствуют/некорректны,
 * 2 — версия не определена или не SemVer.
 *
 * Зависимостей нет: только `node:*`. Документация — docs/PUBLISHING.md,
 * §«Описания релизов».
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// Корень репозитория — от расположения скрипта (`scripts/..`), а не от cwd:
// иначе запуск из другого каталога искал бы docs/releases не там.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES_DIR = resolve(ROOT, 'docs/releases');
const PACKAGE_JSON = resolve(ROOT, 'packages/synth/package.json');

const argv = process.argv.slice(2);
const values = new Map();
const flags = new Set();
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--help' || a === '-h') {
    flags.add('--help');
  } else if (a === '--require-version') {
    flags.add('--require-version');
  } else if (a.startsWith('--') && a.includes('=')) {
    const idx = a.indexOf('=');
    values.set(a.slice(0, idx), a.slice(idx + 1));
  } else if (a.startsWith('--')) {
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      values.set(a, argv[i + 1]);
      i += 1;
    } else {
      values.set(a, '');
    }
  } else {
    console.error(`ОШИБКА: неизвестный аргумент «${a}» (см. --help)`);
    process.exit(2);
  }
}

if (flags.has('--help')) {
  console.log(`release-notes — проверка обязательной пары заметок релиза

Использование:
  node scripts/release-notes-check.mjs --version <x.y.z>
  node scripts/release-notes-check.mjs --ref refs/tags/vX.Y.Z
  node scripts/release-notes-check.mjs            # версия из packages/synth/package.json

Флаги:
  --version <x.y.z>   версия релиза (приоритет, ведущий «v» допускается)
  --ref <ref>         refs/tags/vX.Y.Z (refs/heads/* игнорируется)
  --require-version   запретить фоллбек на packages/synth/package.json:
                      версия обязана прийти из --version или --ref, иначе код 2

Проверяет docs/releases/<version>.md и docs/releases/<version>.en.md:
  * файл существует, не пуст;
  * первый непустой заголовок — «## <version>» (допускается «## <version> (дата)»).

Коды возврата: 0 — пара на месте; 1 — заметки отсутствуют/некорректны;
2 — версия не определена или не SemVer. Подробности — docs/PUBLISHING.md,
раздел «Описания релизов».`);
  process.exit(0);
}

/** Нормализация версии: ведущий `v` допускается. */
function normalize(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^v/, '');
}

function resolveVersion({ requireVersion = false } = {}) {
  const explicit = normalize(values.get('--version'));
  if (explicit) {
    if (!SEMVER.test(explicit)) {
      return { version: null, source: '--version', error: `не SemVer-версия: «${explicit}»` };
    }
    return { version: explicit, source: '--version' };
  }

  const ref = String(values.get('--ref') ?? '').trim();
  if (ref) {
    const m = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(ref);
    if (m) return { version: m[1], source: `--ref (${ref})` };
    // `refs/heads/*` и прочие ref — игнорируются, версия берётся из package.json
    // (кроме --require-version: там это отказ).
  }

  if (requireVersion) {
    return {
      version: null,
      source: '—',
      error:
        'версия не определена, а --require-version запрещает фоллбек на package.json ' +
        '(передайте --version X.Y.Z или --ref refs/tags/vX.Y.Z)',
    };
  }

  if (existsSync(PACKAGE_JSON)) {
    try {
      const version = normalize(JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version);
      if (version) return { version, source: 'packages/synth/package.json' };
      return { version: null, source: 'packages/synth/package.json', error: 'поле version пустое' };
    } catch (err) {
      return {
        version: null,
        source: 'packages/synth/package.json',
        error: `не читается как JSON: ${err.message}`,
      };
    }
  }

  return {
    version: null,
    source: '—',
    error: 'версия не определена: передайте --version X.Y.Z или --ref refs/tags/vX.Y.Z',
  };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Проверка одного файла: существование, размер, непустота, заголовок `## <version>`. */
function checkFile(version, fileName) {
  const path = resolve(RELEASES_DIR, fileName);
  const rel = `docs/releases/${fileName}`;
  if (!existsSync(path)) return { ok: false, rel, error: `файл отсутствует (${rel})` };

  let size;
  try {
    size = statSync(path).size;
  } catch (err) {
    return { ok: false, rel, error: `не удалось прочитать размер (${rel}): ${err.message}` };
  }
  if (size <= 0) return { ok: false, rel, error: `файл пуст (${rel}: 0 байт)` };

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, rel, error: `не удалось прочитать (${rel}): ${err.message}` };
  }
  if (!text.trim()) return { ok: false, rel, error: `файл содержит только пробелы (${rel})` };

  const lines = text.split(/\r?\n/);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line.trim()));
  if (!heading) {
    return { ok: false, rel, error: `нет заголовка «## ${version}» (${rel})` };
  }

  const expected = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s+\\(.*\\))?\\s*$`);
  if (!expected.test(heading.trim())) {
    return {
      ok: false,
      rel,
      error: `первый заголовок «${heading.trim()}» не соответствует «## ${version}» / «## ${version} (дата)» (${rel})`,
    };
  }

  return { ok: true, rel, size };
}

const resolved = resolveVersion({ requireVersion: flags.has('--require-version') });
if (!resolved.version) {
  console.error(`ОШИБКА: ${resolved.error}; источник: ${resolved.source}`);
  console.error('Подсказка: docs/PUBLISHING.md, §«Описания релизов».');
  process.exit(2);
}
const version = resolved.version;

if (!existsSync(RELEASES_DIR)) {
  console.error(`ОШИБКА: нет каталога docs/releases — заметки релиза ${version} негде взять.`);
  console.error('Подсказка: docs/PUBLISHING.md, §«Описания релизов».');
  process.exit(1);
}

const files = [`${version}.md`, `${version}.en.md`];
const results = files.map((name) => checkFile(version, name));
const errors = results.filter((r) => !r.ok);

if (errors.length) {
  console.error(`ОШИБКА: обязательная пара заметок релиза ${version} не готова:`);
  for (const e of errors) console.error(`  ✗ ${e.error}`);
  console.error(
    'Заметки обязательны: без них changelog.sh уходит в авто-сборку из коммитов и описание релиза в репозитории не остаётся.',
  );
  console.error('Подсказка: docs/PUBLISHING.md, §«Описания релизов».');
  process.exit(1);
}

console.log(`release-notes OK: ${version}`);
for (const r of results) console.log(`  ✓ ${r.rel} (${r.size} байт)`);
process.exit(0);
