/**
 * Перепись полных записей сессии (ADR-144).
 *
 * ## Зачем
 *
 * Полная запись документа сессии (`saveSession`/`updateSession`, `this.store.save`,
 * `dst.sessions.save`) переписывает снимок целиком. Если снимок прочитан **до**
 * точечной дозаписи (`appendMessage`, `mutateMessage`, `mutateHistory`), запись
 * затирает чужие изменения — классический lost update. Именно так терялись
 * tool-сообщения при timer-steer (инцидент `mwgvzwfc-33-2h30b0lt`).
 *
 * Поэтому правило (ADR-144): **домен пишет сессию только точечными мутациями**
 * (`mutateMeta`/`mutateHistory`/`mutateMessage`/`appendMessage`), а полная запись
 * допустима лишь там, где она и есть смысл операции — create/import/replace
 * (материализация, перенос проекта, импорт архива, миграция между backend'ами
 * хранения).
 *
 * ## Что проверяем
 *
 * Сканируются исходники `packages/core/src` и `packages/backend/src`
 * (без `*.test.ts`, `dist/`, `node_modules/`, `tmp/`). Любой вызов полной записи
 * вне allowlist — падение с `file:line` и подсказкой.
 *
 * Нарушение — это **вызов**, а не упоминание: регулярки требуют `(` после имени
 * метода, поэтому комментарии вида «паритет с прежним `saveSession`» не срабатывают.
 * Сам этот тест не сканируется (исключён как `*.test.ts`), поэтому строки-образцы
 * для self-check нарушением не считаются.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень репозитория (`<repo>/synth`): тест лежит в `packages/core/src/sessions`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Корни, которые сканируются (оба пакета, где живёт домен сессий). */
const SCAN_ROOTS = ['packages/core/src', 'packages/backend/src'] as const;

/** Каталоги, в которые не заходим (артефакты сборки и мусор). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'tmp', 'data']);

/** Расширения исходников. */
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;

/** Полная запись сессии: вызов метода менеджера или репозитория. */
interface FullWriteRule {
  /** Что именно ловим (для сообщения). */
  readonly label: string;
  readonly pattern: RegExp;
  /** Подсказка: чем заменить. */
  readonly hint: string;
}

const RULES: readonly FullWriteRule[] = [
  {
    label: 'полная запись сессии через менеджер',
    pattern:
      /(?:sessionManager|_sessionManager|localSessionManager|manager|extra\.sessionManager)\.(?:saveSession|updateSession)\(/,
    hint: 'используй mutateMeta/mutateHistory/mutateMessage/appendMessage',
  },
  {
    label: 'полная запись через порт (`this.store.save`)',
    pattern: /this\.store\.save\(/,
    hint: 'в домене — mutateMeta/mutateHistory/mutateMessage/appendMessage',
  },
  {
    label: 'полная запись при переносе между backend\'ами хранения',
    pattern: /dst\.sessions\.save\(/,
    hint: 'полная замена документа допустима только в `synth storage migrate`',
  },
];

/**
 * Запись сессии, допустимая в этих файлах целиком (путь от корня репозитория).
 *
 * Каждая запись — **осмысленная** полная запись, а не «удобный save»:
 * - `sessions/manager.ts` — определения `save`/`updateSession` и сами
 *   materialization-примитивы (`createSession`, `forkSession`);
 * - `projects/portable.ts` — импорт портативного архива проекта (новые сессии);
 * - `remote/transfer.ts` — перенос проекта между инстансами (materialization);
 * - `backend/src/routes/sessions.ts` — импорт сессии (`POST /sessions/import`);
 * - `maintenance/storage-migrate.ts` — перенос данных между backend'ами хранения.
 */
const ALLOWED_FULL_WRITES: Readonly<Record<string, string>> = {
  'packages/core/src/sessions/manager.ts':
    'определения save/updateSession + materialization (createSession/forkSession)',
  'packages/core/src/projects/portable.ts': 'импорт портативного архива проекта (replace)',
  'packages/core/src/remote/transfer.ts': 'перенос проекта между инстансами (materialization)',
  'packages/backend/src/routes/sessions.ts': 'импорт сессии (`POST /sessions/import`)',
  'packages/core/src/maintenance/storage-migrate.ts':
    'storage migrate — перенос между backend\'ами хранения (replace)',
};

/** Найденный вызов полной записи. */
interface FullWriteHit {
  /** Путь от корня репозитория. */
  file: string;
  /** Номер строки (1-based). */
  line: number;
  /** Текст строки (trim). */
  text: string;
  label: string;
  hint: string;
}

/** Рекурсивный обход исходников (детерминированный порядок). */
function listSources(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      result.push(...listSources(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXT.test(entry.name)) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    result.push(full);
  }
  return result;
}

/** Строки `file:line` полных записей в одном исходнике (построчно). */
function scanSource(relPath: string, source: string): FullWriteHit[] {
  const hits: FullWriteHit[] = [];
  const lines = source.split(/\r?\n/);
  for (const rule of RULES) {
    // Новый объект на файл: `lastIndex` глобального регэкспа не протекает между файлами.
    const regex = new RegExp(rule.pattern.source);
    lines.forEach((line, index) => {
      if (!regex.test(line)) return;
      hits.push({ file: relPath, line: index + 1, text: line.trim(), label: rule.label, hint: rule.hint });
    });
  }
  return hits;
}

/** Все вызовы полной записи в сканируемых пакетах. */
function scanRepo(): FullWriteHit[] {
  const hits: FullWriteHit[] = [];
  for (const root of SCAN_ROOTS) {
    const absRoot = resolve(REPO_ROOT, root);
    if (!existsSync(absRoot)) continue;
    for (const absPath of listSources(absRoot)) {
      const relPath = relative(REPO_ROOT, absPath).split('\\').join('/');
      hits.push(...scanSource(relPath, readFileSync(absPath, 'utf-8')));
    }
  }
  return hits;
}

/** Человекочитаемый отчёт о нарушениях (падает тест с `file:line` и подсказкой). */
function formatViolations(hits: readonly FullWriteHit[]): string {
  const lines = hits.map(
    (hit) => `  ${hit.file}:${hit.line} — ${hit.label}: ${hit.text}\n    → ${hit.hint} (ADR-144)`,
  );
  return [
    'Полная запись сессии вне allowlist (ADR-144).',
    'Домен пишет сессию только точечными мутациями, полная запись — create/import/replace.',
    ...lines,
  ].join('\n');
}

describe('ADR-144: census полных записей сессии', () => {
  it('вне allowlist полных записей нет', () => {
    const violations = scanRepo().filter((hit) => !(hit.file in ALLOWED_FULL_WRITES));
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it('полные записи есть ровно в allowlist-файлах (whitelist не шире и не уже)', () => {
    const files = new Set(scanRepo().map((hit) => hit.file));
    expect([...files].sort()).toEqual(Object.keys(ALLOWED_FULL_WRITES).sort());
  });

  it('у каждой записи allowlist есть пояснение', () => {
    for (const [file, reason] of Object.entries(ALLOWED_FULL_WRITES)) {
      expect(reason.length, `${file}: пустое пояснение`).toBeGreaterThan(10);
    }
  });

  it('self-check: детектор ловит все три вида полной записи', () => {
    const sample = [
      'const x = 1;',
      'await extra.sessionManager.updateSession(fork);',
      'await extra.sessionManager.saveSession(session);',
      'await manager.saveSession(session);',
      'await this.store.save(session);',
      'await dst.sessions.save(session);',
    ].join('\n');
    const hits = scanSource('packages/core/src/engine/tools/example.ts', sample);
    expect(hits.map((hit) => hit.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it('self-check: файл из allowlist нарушением не считается, а точечные мутации — тоже', () => {
    const allowed = [
      'await sessionManager.saveSession(session);',
      'await this.store.save(session);',
    ].join('\n');
    const allowedHits = scanSource('packages/core/src/sessions/manager.ts', allowed);
    expect(allowedHits).toHaveLength(2);
    expect(allowedHits.filter((hit) => !(hit.file in ALLOWED_FULL_WRITES))).toEqual([]);

    const fine = [
      'await sessionManager.mutateMeta(id, (meta) => { meta.title = t; });',
      'await sessionManager.mutateHistory(id, (s) => s.messages.length);',
      'await sessionManager.mutateMessage(id, mid, (m) => { m.disabled = true; });',
      'await sessionManager.appendMessage(id, message);',
    ].join('\n');
    expect(scanSource('packages/core/src/domain/example.ts', fine)).toEqual([]);
  });
});
