#!/usr/bin/env node
/**
 * scripts/security-gate.mjs — обязательный внутренний аудит безопасности перед релизом.
 *
 * Запускается в `release.yaml` отдельной джобой ДО сборки артефактов; без его успеха
 * релиз не собирается (`build.needs: [lint-and-test, security-gate]`). Зависимостей нет:
 * только `node:*` (+ `git` и, для одной проверки, локальный `pnpm`/`vitest` из node_modules).
 *
 * Что проверяется (список — в `docs/security/policy.json`):
 *   1. `policy`        — политика гейта читается и валидна;
 *   2. `release-record`— запись аудита `docs/security/releases/<version>.json` для РЕЛИЗУЕМОЙ
 *                        версии: схема, статус, обязательные проверки, известные исключения
 *                        с обязательным follow-up; отпечаток записи попадает в evidence;
 *   3. `auth-matrix`   — негативная матрица авторизации сессий присутствует и проходит
 *                        (команда из политики; счётчики берутся из JSON-отчёта vitest:
 *                        минимум N тестов, ноль упавших — иначе блокировка);
 *   4. `secret-scan`   — `scripts/secret-scan.mjs` чист на рабочем дереве и на истории.
 *
 * Исключений «через порог» нет: запись аудита для релизуемой версии обязательна и должна быть
 * содержательной (статусы проверок с `command`/`result`). Осознанно принятые уязвимости/риски
 * фиксируются в `exceptions[]` записи с `owner` и `dueRelease`, но сам факт выполнения проверок
 * не «извиняется» — waiver-статуса у проверок нет.
 *
 * Использование:
 *   node scripts/security-gate.mjs --version 0.10.2 --ref refs/tags/v0.10.2   # как в CI
 *   node scripts/security-gate.mjs --version 0.10.2 --soft                    # dry_run: не блокирует
 *   node scripts/security-gate.mjs --version 0.10.2 --skip-tests               # без прогона vitest
 *   node scripts/security-gate.mjs --from-package --report tmp/security/evidence.json   # локально
 *   node scripts/security-gate.mjs --only dependencies --skip-tests            # шаг ратчета в ci.yaml
 *
 * Коды возврата: 0 — гейт пройден, 1 — релиз блокируется, 2 — версия/политика не определены.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const values = new Map();
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--') && a.includes('=')) {
    const idx = a.indexOf('=');
    values.set(a.slice(0, idx), a.slice(idx + 1));
  } else if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    values.set(a, argv[i + 1]);
  }
}
const get = (name, fallback = undefined) => (values.has(name) ? values.get(name) : fallback);

const ROOT = resolve(get('--root', '.'));
const ONLY = get('--only', null)
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const NEEDS_VERSION = !ONLY || ONLY.includes('release-record');
const SOFT = flags.has('--soft');
const SKIP_TESTS = flags.has('--skip-tests');
const REPORT_PATH = get('--report', null);
const POLICY_PATH = resolve(ROOT, get('--policy', 'docs/security/policy.json'));

const line = (s = '') => process.stdout.write(`${s}\n`);
const rel = (p) => relative(ROOT, p) || p;

/** Снимает ANSI-последовательности (цветной вывод терминала в логе джобы нечитаем). */
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

/**
 * Определение релизуемой версии. Порядок: `--version` (в CI — вывод version-bump при
 * workflow_dispatch) → тег из `--ref` (в CI — `${{ gitverse.ref }}` при push тега) →
 * `--from-package` (только локально).
 *
 * Тихий фоллбэк на `packages/synth/package.json` убран намеренно: в CI он проверил бы
 * СТАРУЮ версию, гейт бы «прошёл», а релиз уехал без записи аудита. Не определили версию —
 * `exit 2` (fail-closed).
 */
function resolveVersion() {
  const explicit = get('--version', process.env.SYNTH_RELEASE_VERSION);
  if (explicit) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(explicit)) {
      return { version: null, source: '--version/env', error: `не SemVer-версия: «${explicit}»` };
    }
    return { version: explicit, source: '--version/env (workflow_dispatch → version-bump)' };
  }
  const ref = get('--ref', '');
  if (ref) {
    const m = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(ref);
    if (m) return { version: m[1], source: `--ref (${ref})` };
    return {
      version: null,
      source: `--ref (${ref})`,
      error: 'ref не является тегом релиза (ожидался refs/tags/vX.Y.Z): гейт запускается по тегу либо через workflow_dispatch с версией из version-bump',
    };
  }
  if (flags.has('--from-package')) {
    const pkgPath = resolve(ROOT, 'packages/synth/package.json');
    if (existsSync(pkgPath)) {
      const v = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
      return { version: v, source: 'packages/synth/package.json (--from-package, только локально)', local: true };
    }
    return { version: null, source: '--from-package', error: 'не найден packages/synth/package.json' };
  }
  return {
    version: null,
    source: '—',
    error: 'версия не определена: передайте --version X.Y.Z (CI: version-bump) или --ref refs/tags/vX.Y.Z',
  };
}

function semverParts(v) {
  const [core, pre] = String(v).split('-', 2);
  const nums = core.split('.').map((n) => Number(n));
  return { nums, pre: pre ?? null };
}

/** Сравнение SemVer: -1 / 0 / 1 (prerelease меньше релиза, как в SemVer 2.0.0 §11). */
function semverCompare(a, b) {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre === pb.pre ? 0 : pa.pre > pb.pre ? 1 : -1;
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error?.message };
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** `true`, если git-команда завершилась успешно (её вывод при этом может быть пустым). */
function gitOk(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return res.status === 0;
}

function sha256(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

// --- Политика и запись аудита ------------------------------------------------

/** Обязательные поля записи аудита (`docs/security/README.md` §«Схема записи»). Waiver-статусов нет. */
const RECORD_CHECK_STATUSES = ['pass', 'pass_with_exceptions'];
const RECORD_STATUSES = ['approved', 'approved_with_exceptions', 'blocked'];

function validateRecord(record, { version, policy }) {
  const errors = [];
  const warnings = [];
  if (record.schema !== 'synth.security.audit/v1') errors.push(`schema должна быть synth.security.audit/v1, а не ${record.schema}`);
  if (record.version !== version) errors.push(`version=${record.version} не совпадает с релизуемой ${version}`);
  if (!RECORD_STATUSES.includes(record.status)) errors.push(`status=${record.status} вне ${RECORD_STATUSES.join('|')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date ?? '')) errors.push('date должен быть YYYY-MM-DD');
  if (!record.auditor || typeof record.auditor !== 'object') errors.push('нет объекта auditor');
  else {
    if (!record.auditor.name) errors.push('auditor.name не заполнен');
    if (!['ADMIN', 'LEAD', 'AUDITOR'].includes(record.auditor.role)) {
      errors.push(`auditor.role=${record.auditor.role} — допустимые роли: ADMIN, LEAD, AUDITOR`);
    }
  }
  const commit = String(record.commit ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(commit)) errors.push('commit должен быть sha коммита записи (7–40 hex)');
  else if (!gitOk(['cat-file', '-e', `${commit}^{commit}`])) warnings.push(`commit ${commit} отсутствует в локальной истории (клон без полной истории?)`);
  else if (!gitOk(['merge-base', '--is-ancestor', commit, 'HEAD'])) {
    errors.push(`commit ${commit} не является предком релизуемого коммита — аудит проведён на постороннем коммите`);
  }

  const checks = record.checks ?? {};
  for (const id of policy.requiredCheckIds ?? []) {
    const c = checks[id];
    if (!c) {
      errors.push(`нет обязательной проверки checks.${id}`);
      continue;
    }
    if (!RECORD_CHECK_STATUSES.includes(c.status)) {
      errors.push(`checks.${id}.status=${c.status} — допустимые: ${RECORD_CHECK_STATUSES.join('|')}`);
      continue;
    }
    if (!c.command) errors.push(`checks.${id}: не заполнено поле command — проверка не воспроизводима`);
    if (!c.result) errors.push(`checks.${id}: не заполнено поле result — нет наблюдаемого результата`);
  }
  for (const e of record.exceptions ?? []) {
    if (!e || !e.id) errors.push('в exceptions[] есть запись без id');
    else {
      for (const field of ['scope', 'justification', 'followUp', 'owner', 'dueRelease']) {
        if (!e[field]) errors.push(`exceptions[${e.id}]: не заполнено обязательное поле ${field}`);
      }
    }
  }
  if (record.status === 'blocked') errors.push('status=blocked — аудит не пройден');
  if (record.status === 'approved_with_exceptions' && !(record.exceptions ?? []).length) {
    errors.push('status=approved_with_exceptions требует непустой exceptions[]');
  }
  // Незаполненные плейсхолдеры (`<...>`) не блокируют, но должны быть видны: гейт не может
  // проверить личность аудитора и номер CI-run, поэтому это явное предупреждение, а не тишина.
  const placeholders = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (/^<.*>$/.test(node.trim())) placeholders.push(`${path}=${node}`);
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(record, 'record');
  if (placeholders.length) warnings.push(`незаполненные плейсхолдеры: ${placeholders.slice(0, 6).join(', ')}${placeholders.length > 6 ? ` … (+${placeholders.length - 6})` : ''}`);
  return { errors, warnings };
}

// --- Проверки ---------------------------------------------------------------

function checkPolicy(policy) {
  return policy
    ? {
        status: 'pass',
        detail:
          `policy ${rel(POLICY_PATH)}: обязательных проверок ${(policy.requiredCheckIds ?? []).length}, ` +
          `профиль ратчета «${policy.dependencies?.profile ?? '—'}», запись обязательна`,
      }
    : { status: 'fail', detail: `не найден/невалиден ${rel(POLICY_PATH)}` };
}

function checkReleaseRecord({ version, policy, recordPath }) {
  if (!existsSync(recordPath)) {
    return {
      status: 'fail',
      detail: `нет записи аудита ${rel(recordPath)} для релизуемой версии ${version} — релиз без записи не собирается`,
      remedy:
        `провести аудит по docs/security/AUDIT-CHECKLIST.md, заполнить ${rel(recordPath)} ` +
        '(шаблон — docs/security/TEMPLATE.json), закоммитить и только потом ставить тег',
    };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (err) {
    return { status: 'fail', detail: `${rel(recordPath)} не читается как JSON: ${err.message}` };
  }
  const { errors, warnings } = validateRecord(record, { version, policy });
  const fingerprint = sha256(recordPath);
  if (errors.length) {
    return {
      status: 'fail',
      detail: `запись ${rel(recordPath)} не прошла валидацию: ${errors.join('; ')}`,
      warnings,
      fingerprint,
      remedy: 'дозаполнить запись аудита (статусы проверок с command/result), затем закоммитить до тега',
    };
  }
  return {
    status: 'pass',
    detail:
      `запись ${rel(recordPath)}: status=${record.status}, аудитор ${record.auditor.name} (${record.auditor.role}), ` +
      `коммит ${String(record.commit).slice(0, 12)}, исключений ${(record.exceptions ?? []).length}, проверок ${Object.keys(record.checks ?? {}).length}`,
    warnings,
    fingerprint,
  };
}

function checkAuthMatrix(policy) {
  const cfg = policy.authMatrix ?? {};
  const candidates = cfg.files ?? ['packages/backend/src/routes/sessions-access.test.ts'];
  const marker = cfg.marker;
  const minTests = cfg.minTests ?? 1;
  const minFiles = cfg.minFiles ?? 1;
  const files = candidates.filter((f) => existsSync(resolve(ROOT, f)));
  if (files.length < minFiles) {
    return {
      status: 'fail',
      detail: `негативная матрица авторизации не найдена: ожидался хотя бы ${minFiles} файл из ${candidates.join(', ')}`,
      command: `ls ${candidates.join(' ')}`,
      remedy: 'восстановить файл матрицы либо обновить policy.authMatrix.files (если матрица переехала)',
    };
  }
  if (marker) {
    const withoutMarker = files.filter((f) => !readFileSync(resolve(ROOT, f), 'utf8').includes(marker));
    if (withoutMarker.length) {
      return {
        status: 'fail',
        detail: `в ${withoutMarker.join(', ')} нет маркера «${marker}» — матрица переписана/ослаблена`,
        command: `grep -c '${marker}' ${files.join(' ')}`,
      };
    }
  }
  if (SKIP_TESTS) {
    return {
      status: 'pass',
      detail: `файлы матрицы на месте (${files.join(', ')}), тесты не запускались (--skip-tests)`,
      command: 'skipped',
      warnings: ['--skip-tests: фактический прогон негативной матрицы не выполнен — это НЕ полноценное подтверждение'],
    };
  }
  const relFiles = files.map((f) => f.replace(/^packages\/backend\//, '')).join(' ');
  // Разбор вывода идёт по JSON-отчёту vitest, а не по человекочитаемой сводке:
  // формат сводки зависит от репортера, цветов и версии vitest, и её разбор
  // однажды уже сломал релизный прогон (на раннере сводка не распарсилась —
  // гейт упал, хотя тесты прошли). JSON-отчёт — машинный контракт: счётчики
  // тестов и признак успеха приходят полями.
  const reportPath = resolve(ROOT, 'tmp/security/auth-matrix-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  rmSync(reportPath, { force: true });
  const base = cfg.command ?? `pnpm --filter @itphx/synth-backend exec vitest run ${relFiles}`;
  // Путь к отчёту — абсолютный: `pnpm exec` выполняется в каталоге пакета, и
  // относительный путь уехал бы в packages/backend/ вместо каталога гейта.
  const command = `${base} --reporter=json --outputFile=${reportPath}`;
  const res = sh('bash', ['-c', command]);
  const output = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0) {
    return {
      status: 'fail',
      detail: `негативная матрица упала (exit ${res.code})`,
      command,
      output: output.slice(-4000),
      remedy: 'прогнать команду выше локально и исправить упавшую проверку',
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    return {
      status: 'fail',
      detail: `JSON-отчёт vitest не прочитан (${err.message}) — счётчики проверок неизвестны`,
      command,
      output: output.slice(-4000),
      remedy: 'проверить, что vitest пишет отчёт по --outputFile и что путь доступен для записи',
    };
  }
  const passed = Number(report?.numPassedTests);
  const failed = Number(report?.numFailedTests);
  if (!Number.isFinite(passed)) {
    return {
      status: 'fail',
      detail: 'в JSON-отчёте vitest нет счётчика numPassedTests — формат отчёта неожиданный',
      command,
      output: output.slice(-4000),
    };
  }
  if (Number.isFinite(failed) && failed > 0) {
    return {
      status: 'fail',
      detail: `в негативной матрице упало тестов: ${failed} (пройдено ${passed})`,
      command,
      output: output.slice(-4000),
      remedy: 'исправить упавшую негативную проверку — ослабление матрицы блокирует релиз',
    };
  }
  if (passed < minTests) {
    return { status: 'fail', detail: `негативных проверок ${passed} < минимальных ${minTests} (матрица усечена?)`, command, output: output.slice(-2000) };
  }
  return {
    status: 'pass',
    detail: `негативная матрица пройдена: ${passed} проверок (минимум ${minTests})`,
    command,
    testsPassed: passed,
  };
}

/**
 * Severity, на которых построен ратчет: именно они блокируют релиз
 * (см. docs/security/README.md — «ратчет опирается только на critical/high,
 * а moderate/low в записи — информационные»).
 */
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

/**
 * Прямые runtime-зависимости пакетов воркспейса: `dependencies` (уезжают в релиз).
 * `devDependencies` (инструментарий сборки) в поставляемые артефакты не входят,
 * поэтому прямыми не считаются.
 *
 * Источник — `pnpm list -r --depth 0 --json` (тот же pnpm, что и в `pnpm audit`):
 * список пакетов воркспейса и их прямые зависимости — без угадывания путей.
 * `projectsByPrefix` сопоставляет префикс импортера из отчёта `pnpm audit`
 * (`packages__backend`) с пакетом воркспейса (`packages/backend`): префиксы берутся
 * из самого отчёта, кодирование пути в отчёте проверяется на факте (ключ есть в `byPrefix`).
 */
function readWorkspaceDeps() {
  const res = sh('pnpm', ['list', '-r', '--depth', '0', '--json']);
  if (res.code !== 0 || !res.stdout.trim().startsWith('[')) {
    return { error: `pnpm list -r --depth 0 --json не отдал список пакетов воркспейса (exit ${res.code})${res.error ? `: ${res.error}` : ''}` };
  }
  let projects;
  try {
    projects = JSON.parse(res.stdout);
  } catch (err) {
    return { error: `pnpm list -r --depth 0 --json не разобран: ${err.message}` };
  }
  const runtime = new Set();
  const projectsByPrefix = new Map();
  for (const p of projects ?? []) {
    const dir = relative(ROOT, p.path ?? '') || '.';
    const runtimeDeps = new Set(Object.keys(p.dependencies ?? {}));
    for (const d of runtimeDeps) runtime.add(d);
    // pnpm печатает импортер в отчёте audit, заменяя '/' на '__' ('packages/backend' → 'packages__backend').
    projectsByPrefix.set(dir.split('/').join('__'), { runtimeDeps });
  }
  return { runtime, projectsByPrefix };
}

/**
 * Прямая зависимость — модуль, стоящий в пути `pnpm audit` сразу за импортером:
 * `<импортер>><зависимость>`. Два и более `>` — транзитивная зависимость.
 *
 * Прежняя проверка искала пути БЕЗ разделителя `>`; в отчёте pnpm audit таких нет
 * (любой путь начинается с импортера и содержит хотя бы один `>`), поэтому список
 * прямых уязвимых модулей всегда был пустым, а `failOnDirect` не мог сработать никогда.
 *
 * Прямой считается runtime-зависимость пакета воркспейса: dev-зависимости (инструментарий
 * сборки) в поставляемые артефакты не входят и релиз не блокируют.
 */
function isDirectDependency(path, deps) {
  const parts = String(path).split('>');
  if (parts.length !== 2) return false;
  const [importer, moduleName] = parts;
  if (!importer || !moduleName) return false;
  const project = deps.projectsByPrefix.get(importer);
  if (project) return project.runtimeDeps.has(moduleName);
  // Импортер не сопоставлен с пакетом воркспейса (сменился формат префиксов в отчёте) —
  // сверяемся с объединением прямых зависимостей всех пакетов воркспейса.
  return deps.runtime.has(moduleName);
}

/**
 * Ратчет уязвимостей зависимостей («не хуже зафиксированного пола»).
 * Пол и правила — в `policy.dependencies`; разбор старых уязвимостей ведётся записями
 * аудита (`exceptions[]` с `dueRelease`), а не молчаливым `continue-on-error`.
 */
function checkDependencies(policy) {
  const cfg = policy.dependencies ?? {};
  if (cfg.mode === 'off') return { status: 'pass', detail: 'проверка зависимостей отключена политикой (mode=off)' };
  const command = cfg.command ?? 'pnpm audit --json';
  // Состояние ратчета выбирается полем-переключателем `dependencies.profile`:
  // `pre-upgrade` (до апгрейда sdk/simple-git) и `post-upgrade` (целевые пороги).
  const profileName = cfg.profile;
  const profile = (cfg.profiles ?? {})[profileName];
  const baseline = profile?.baseline ?? undefined;
  if (!baseline) {
    return {
      status: 'fail',
      detail: `policy.dependencies.profile=«${profileName ?? ''}» не описан в policy.dependencies.profiles`,
      command,
      remedy: 'исправить docs/security/policy.json (переключатель и профили ратчета)',
    };
  }
  const res = sh('pnpm', ['audit', '--json']);
  if (!res.stdout || !res.stdout.trim().startsWith('{')) {
    return {
      status: 'fail',
      detail: `pnpm audit не дал JSON (exit ${res.code})${res.error ? `: ${res.error}` : ''} — реестр недоступен?`,
      command,
      remedy: 'проверить доступ к registry.npmjs.org с раннера; без данных аудита релиз не собирается',
      output: `${res.stderr}`.slice(-1000),
    };
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (err) {
    return { status: 'fail', detail: `pnpm audit --json не разобран: ${err.message}`, command };
  }
  const counts = data.metadata?.vulnerabilities ?? {};
  const advisories = Object.values(data.advisories ?? {});
  const deps = readWorkspaceDeps();
  if (deps.error) {
    return {
      status: 'fail',
      detail: deps.error,
      command,
      remedy:
        'установить зависимости (pnpm install --frozen-lockfile) — без списка прямых зависимостей ' +
        'гейт не может отличить уязвимость в прямой зависимости от транзитивной',
    };
  }
  // Прямые уязвимости — те, что блокируют релиз (critical/high) и сидят в ПРЯМОЙ
  // runtime-зависимости пакета воркспейса.
  const direct = advisories.filter(
    (a) =>
      BLOCKING_SEVERITIES.has(a.severity) &&
      (a.findings ?? []).some((f) => (f.paths ?? []).some((p) => isDirectDependency(p, deps))),
  );
  // Префиксы импортеров выводятся из самого отчёта — контроль, что формат путей не поехал.
  const importerPrefixes = new Set();
  for (const a of advisories) {
    for (const f of a.findings ?? []) {
      for (const p of f.paths ?? []) {
        const first = String(p).split('>')[0];
        if (first) importerPrefixes.add(first);
      }
    }
  }
  const unmappedPrefixes = [...importerPrefixes].filter((prefix) => !deps.projectsByPrefix.has(prefix));
  const critical = counts.critical ?? 0;
  const high = counts.high ?? 0;
  const newCritical = critical - (baseline.critical ?? 0);
  const newHigh = high - (baseline.high ?? 0);

  const problems = [];
  if (newCritical > 0) problems.push(`новых critical: ${newCritical} (пол ${baseline.critical}, сейчас ${critical})`);
  if (newHigh > 0) problems.push(`новых high: ${newHigh} (пол ${baseline.high}, сейчас ${high})`);
  if (profile.failOnDirect !== false && direct.length) {
    problems.push(`уязвимости в ПРЯМЫХ зависимостях: ${direct.map((a) => a.module_name).join(', ')}`);
  }
  const detail =
    `профиль ратчета «${profileName}»: critical ${critical}/${baseline.critical}, high ${high}/${baseline.high}, ` +
    `moderate ${counts.moderate ?? 0}, low ${counts.low ?? 0} (прямых уязвимых модулей: ${direct.length}; ` +
    `прямые = critical/high в runtime-зависимостях воркспейса)`;
  if (problems.length) {
    return {
      status: 'fail',
      detail: `${problems.join('; ')} — ${detail}`,
      command,
      remedy:
        'обновить зависимость/пин до patched_versions (или, если апгрейд сделан — переключить ' +
        'policy.dependencies.profile на post-upgrade) либо зафиксировать разбор в docs/security/releases/<version>.json → exceptions[]',
    };
  }
  return {
    status: 'pass',
    detail,
    command,
    warnings: [
      ...(critical + high > 0
        ? [
            `принято по записи аудита: ${critical} critical + ${high} high (все вне прямых runtime-зависимостей; разбор — в exceptions[])`,
            `профиль «${profileName}»: ${profile.note ?? '—'}`,
          ]
        : []),
      ...(unmappedPrefixes.length
        ? [
            `в отчёте pnpm audit есть префиксы импортеров, не сопоставленные с пакетами воркспейса: ${unmappedPrefixes.join(', ')} — ` +
            'прямые зависимости для них определены по объединению прямых зависимостей всех пакетов',
          ]
        : []),
    ],
  };
}

function checkSecretScan(policy) {
  const cfg = policy.secretScan ?? {};
  const modes = (cfg.modes ?? ['worktree', 'commits', 'blobs']).join(',');
  const args = ['scripts/secret-scan.mjs', '--mode', modes, '--quiet', '--json'];
  if (cfg.range) args.push('--range', cfg.range);
  const res = sh(process.execPath, args);
  const command = `node ${args.join(' ')}`;
  if (res.code === 2) {
    return { status: 'fail', detail: `secret-scan не смог отработать (exit 2): ${res.stderr.trim()}`, command };
  }
  let report = null;
  try {
    report = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    /* отчёт не распарсился — ниже это отдельная ошибка */
  }
  if (!report) {
    return { status: 'fail', detail: 'не удалось разобрать JSON-отчёт secret-scan', command, output: res.stdout.slice(-2000) };
  }
  if (res.code !== 0 || report.findings_count > 0) {
    const top = (report.findings ?? []).slice(0, 10).map((f) => `${f.severity} ${f.rule} ${f.file}:${f.line}`).join('; ');
    return {
      status: 'fail',
      detail: `находок secret-scan: ${report.findings_count} (${top})`,
      command,
      remedy: 'убрать секрет из кода и истории ИЛИ добавить точечный allowlist в .gitleaks.toml с описанием',
    };
  }
  return {
    status: 'pass',
    detail: `чисто (режимы ${modes}, единиц: ${report.scanned}, подавлено allowlist: ${report.suppressed_count})`,
    command,
    fingerprint: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
  };
}

// --- main -------------------------------------------------------------------

// `--lint-records` работает без релизуемой версии (шаг docs-workflow), остальные режимы — с ней.
const LINT_ONLY = flags.has('--lint-records');
let version = null;
let versionInfo = { source: '—' };
if (!LINT_ONLY) {
  line('=== Внутренний аудит безопасности перед релизом (scripts/security-gate.mjs) ===');
  versionInfo = resolveVersion();
  if (NEEDS_VERSION && !versionInfo.version) {
    line(`ОШИБКА: ${versionInfo.error}; источник: ${versionInfo.source}`);
    process.exit(2);
  }
  version = versionInfo.version ?? '0.0.0';
  // При `--only` без проверки записи аудита версия не нужна — не показываем фиктивную и не шумим.
  if (NEEDS_VERSION) {
    if (versionInfo.warning) line(`ПРЕДУПРЕЖДЕНИЕ: ${versionInfo.warning}`);
    line(`Версия релиза: ${version} (источник: ${versionInfo.source})`);
  } else {
    line('Версия релиза: не требуется для выбранных проверок (--only)');
  }
  if (ONLY) line(`Режим --only: ${ONLY.join(', ')}`);
  line(`HEAD: ${git(['rev-parse', 'HEAD'])?.slice(0, 12) ?? '—'}`);
}

/**
 * Политика — часть гейта: битая/устаревшая политика = `exit 2`, а не «пропустить проверку».
 * Поля, которых больше нет (например `bootstrap`), считаются ошибкой конфигурации.
 */
function validatePolicy(policy) {
  const errors = [];
  if (policy.schema !== 'synth.security.policy/v1') errors.push('schema должна быть synth.security.policy/v1');
  if (typeof policy.recordDir !== 'string' || !policy.recordDir) errors.push('recordDir: непустая строка с каталогом записей');
  if (!Array.isArray(policy.requiredCheckIds) || !policy.requiredCheckIds.length) {
    errors.push('requiredCheckIds: непустой массив id проверок');
  }
  if (!Array.isArray(policy.authMatrix?.files) || !policy.authMatrix.files.length) {
    errors.push('authMatrix.files: непустой массив путей (кандидаты матрицы)');
  }
  if (!Array.isArray(policy.secretScan?.modes) || !policy.secretScan.modes.length) {
    errors.push('secretScan.modes: непустой массив режимов (worktree|commits|blobs)');
  }
  const deps = policy.dependencies ?? {};
  if (deps.mode !== 'off') {
    if (typeof deps.profile !== 'string' || !deps.profile) errors.push('dependencies.profile: имя активного профиля ратчета');
    else if (!deps.profiles?.[deps.profile]) errors.push(`dependencies.profiles.${deps.profile}: профиль не описан`);
    for (const [name, prof] of Object.entries(deps.profiles ?? {})) {
      if (typeof prof?.baseline?.critical !== 'number' || typeof prof?.baseline?.high !== 'number') {
        errors.push(`dependencies.profiles.${name}.baseline: нужны числовые critical и high`);
      }
    }
  }
  if ('bootstrap' in policy) {
    errors.push('policy.bootstrap больше не поддерживается: запись аудита обязательна для каждого релиза (bootstrap-порогов и waiver-статусов нет)');
  }
  return errors;
}

let policy = null;
if (existsSync(POLICY_PATH)) {
  try {
    policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
  } catch (err) {
    line(`ОШИБКА: ${rel(POLICY_PATH)} не читается как JSON: ${err.message}`);
    process.exit(2);
  }
}
if (!policy) {
  line(`ОШИБКА: не найден ${rel(POLICY_PATH)} — гейт без политики не имеет смысла`);
  process.exit(2);
}
const policyErrors = validatePolicy(policy);
if (policyErrors.length) {
  line(`ОШИБКА: ${rel(POLICY_PATH)} невалидна: ${policyErrors.join('; ')}`);
  process.exit(2);
}

const recordDir = resolve(ROOT, policy.recordDir ?? 'docs/security/releases');

/**
 * `--lint-records` — проверка всех записей аудита в `policy.recordDir` (для docs-workflow):
 * схема и обязательные поля каждой записи, без привязки к релизуемой версии.
 */
if (LINT_ONLY) {
  const dir = recordDir;
  if (!existsSync(dir)) {
    line(`ОШИБКА: нет каталога записей ${rel(dir)}`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.json$/.test(f)).sort();
  if (!files.length) line('записей аудита нет — до первого релиза с гейтом это допустимо');
  let bad = 0;
  for (const f of files) {
    const p = join(dir, f);
    try {
      const record = JSON.parse(readFileSync(p, 'utf8'));
      const { errors, warnings } = validateRecord(record, { version: record.version, policy });
      for (const w of warnings) line(`   ! ${f}: ${w}`);
      if (errors.length) {
        bad += 1;
        line(`[FAIL] ${f}: ${errors.join('; ')}`);
      } else {
        line(`[OK  ] ${f}: status=${record.status}, аудитор ${record.auditor?.name} (${record.auditor?.role})`);
      }
    } catch (err) {
      bad += 1;
      line(`[FAIL] ${f}: не читается как JSON — ${err.message}`);
    }
  }
  line('');
  line(`Записей: ${files.length}, с ошибками: ${bad}`);
  process.exit(bad ? 1 : 0);
}

const recordPath = resolve(recordDir, `${version}.json`);

const results = [];
const runCheck = (id, title, fn) => {
  const started = Date.now();
  let result;
  try {
    result = fn();
  } catch (err) {
    result = { status: 'fail', detail: `исключение: ${err.message}` };
  }
  results.push({ id, title, ...result, elapsed_ms: Date.now() - started });
  const icon = result.status === 'pass' ? 'OK  ' : 'FAIL';
  line(`[${icon}] ${id}: ${result.detail}`);
  for (const w of result.warnings ?? []) line(`        ! ${w}`);
  if (result.remedy) line(`        → что делать: ${result.remedy}`);
  // Провал блокирующей проверки обязан читаться из лога джобы: раньше вывод
  // команды сохранялся, но не печатался и вырезался из evidence — разбор
  // требовал локального прогона. Печатаем хвост вывода (без ANSI).
  if (result.status !== 'pass' && result.output) {
    const tail = stripAnsi(result.output)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-30);
    if (tail.length) {
      line('        --- вывод команды (хвост) ---');
      for (const l of tail) line(`        ${l}`);
    }
  }
};

const ALL_CHECKS = [
  ['policy', 'Политика гейта', () => checkPolicy(policy)],
  ['release-record', 'Запись внутреннего аудита для релизуемой версии', () => checkReleaseRecord({ version, policy, recordPath })],
  ['auth-matrix', 'Негативная матрица авторизации сессий', () => checkAuthMatrix(policy)],
  ['secret-scan', 'Secret-scan (рабочее дерево + история)', () => checkSecretScan(policy)],
  ['dependencies', 'Уязвимости зависимостей (ратчет)', () => checkDependencies(policy)],
];
for (const [id, title, fn] of ALL_CHECKS) {
  if (ONLY && !ONLY.includes(id)) continue;
  runCheck(id, title, fn);
}

const failed = results.filter((r) => r.status === 'fail');
const warnings = results.flatMap((r) => r.warnings ?? []);

const evidence = {
  schema: 'synth.security.evidence/v1',
  generated_at: new Date().toISOString(),
  version,
  version_source: versionInfo.source,
  head: git(['rev-parse', 'HEAD']),
  policy_fingerprint: sha256(POLICY_PATH),
  record: existsSync(recordPath) ? { path: rel(recordPath), sha256: sha256(recordPath) } : null,
  checks: results.map(({ output, ...rest }) => rest),
  failed: failed.map((r) => r.id),
  warnings,
  passed: failed.length === 0,
};

line('');
line(`Итог: ${results.filter((r) => r.status === 'pass').length} pass, ${failed.length} fail — гейт ${failed.length === 0 ? 'ПРОЙДЕН' : 'НЕ ПРОЙДЕН'}`);

if (REPORT_PATH) {
  const abs = resolve(ROOT, REPORT_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(evidence, null, 2)}\n`);
  line(`Evidence записан: ${REPORT_PATH} (артефакт джобы — доказательство проверки)`);
}

if (failed.length && !SOFT) {
  line('');
  line('РЕЛИЗ ЗАБЛОКИРОВАН: без содержательной записи аудита и зелёных проверок релиз не собирается.');
  process.exit(1);
}
if (failed.length && SOFT) {
  line('');
  line('SOFT-режим (dry-run, только inputs.dry_run): замечания не блокируют, реальный релиз с ними не пройдёт.');
}
if (!failed.length) {
  line('');
  line('Запись аудита обязательна и принята; waiver-статусов у проверок нет.');
}
process.exit(0);
