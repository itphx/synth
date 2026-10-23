import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults.js';

/**
 * ADR-090 — guard-тест: дефолты секции `plugins` в коде и в документации
 * (`docs/CONFIGURATION.md`, RU и EN) должны совпадать.
 *
 * Источник истины — код (`packages/shared/src/config/defaults.ts`, реэкспорт
 * `defaultConfig`). Документация проверяется по третьему столбцу таблицы
 * секции «Плагины (`plugins.*`)» (значение по умолчанию).
 *
 * Расхождение (например `plugins.deployTrust`: в коде `trusted`, в таблице
 * было `verified`) ломает сборку.
 */

/** Минимальное число распознанных ключей `plugins.*` (защита от «пустой» таблицы). */
const MIN_RECOGNIZED_KEYS = 12;

/** Ожидаемый набор ключей секции `plugins` (ADR-090) — таблица обязана их описывать. */
const EXPECTED_PLUGIN_KEYS = [
  'plugins.enabled',
  'plugins.executionEnabled',
  'plugins.runtimeInstall',
  'plugins.trustFloor',
  'plugins.scan',
  'plugins.allowlist',
  'plugins.denylist',
  'plugins.remoteAllowlist',
  'plugins.exactHostExceptions',
  'plugins.promptBlockMaxChars',
  'plugins.llmFilterTimeoutMs',
  'plugins.deployDir',
  'plugins.deployTrust',
  'plugins.managedReadonly',
  'plugins.hybrid.mode',
  'plugins.hybrid.allow',
] as const;

const DOC_FILES = [
  { lang: 'RU', relPath: 'docs/CONFIGURATION.md' },
  { lang: 'EN', relPath: 'docs/en/CONFIGURATION.md' },
] as const;

/**
 * Корень репозитория: поднимаемся вверх от файла теста, пока не найдём
 * `packages/shared/package.json` и `docs/CONFIGURATION.md` (тест запускается
 * и из корня пакета, и из корня монорепозитория).
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(join(dir, 'packages', 'shared', 'package.json')) &&
      existsSync(join(dir, 'docs', 'CONFIGURATION.md'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    'Не удалось определить корень репозитория: не найдены одновременно packages/shared/package.json и docs/CONFIGURATION.md',
  );
}

/** Разбор строки markdown-таблицы в ячейки (экранированный `\|` не разделяет ячейки). */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (char === '\\' && line.charAt(i + 1) === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

/** Тело секции «Плагины (`plugins.*`)» — от заголовка до следующего заголовка того же уровня. */
function extractPluginsSection(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,4}\s+.*`plugins\.\*`/.test(line));
  if (start === -1) {
    return null;
  }
  const level = (lines[start]?.match(/^#+/) ?? ['#'])[0]?.length ?? 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const heading = lines[i]?.match(/^(#{1,6})\s/);
    if (heading && (heading[1]?.length ?? 0) <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/**
 * Канонизация значения из документации.
 * Возвращает `undefined`, если формат значения не распознан (строка будет пропущена).
 */
function canonicalizeDocValue(cell: string): string | undefined {
  let value = cell.trim();
  const code = value.match(/^`([^`]*)`$/);
  if (code) {
    value = (code[1] ?? '').trim();
  }
  if (value === 'true' || value === 'false') {
    return value;
  }
  if (value === '[]') {
    return '[]';
  }
  if (/^-?\d+$/.test(value)) {
    return String(Number(value));
  }
  const single = value.match(/^'(.*)'$/);
  if (single) {
    return `'${single[1] ?? ''}'`;
  }
  const double = value.match(/^"(.*)"$/);
  if (double) {
    return `'${double[1] ?? ''}'`;
  }
  if (/^\S+$/.test(value)) {
    return `'${value}'`;
  }
  return undefined;
}

/** Канонизация значения из кода — в том же формате, что и документация. */
function canonicalizeCodeValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : JSON.stringify(value);
  }
  return JSON.stringify(value) ?? 'undefined';
}

interface DocEntry {
  key: string;
  value: string;
  raw: string;
}

interface ParsedTable {
  found: boolean;
  entries: Map<string, DocEntry>;
  skipped: string[];
}

/** Разбор таблицы секции «Плагины»: ключ → значение по умолчанию из третьего столбца. */
function parsePluginsTable(markdown: string): ParsedTable {
  const section = extractPluginsSection(markdown);
  if (!section) {
    return { found: false, entries: new Map(), skipped: [] };
  }
  const entries = new Map<string, DocEntry>();
  const skipped: string[] = [];
  for (const rawLine of section) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = splitTableRow(line);
    if (cells.length < 4) {
      skipped.push(line);
      continue;
    }
    const keyCell = (cells[1] ?? '').trim();
    const valueCell = (cells[cells.length - 2] ?? '').trim();
    const keys = [...keyCell.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1] ?? '')
      .filter((key) => key.startsWith('plugins.'));
    if (keys.length === 0) {
      // Заголовок/разделитель/строка другой секции — не наш ключ.
      skipped.push(line);
      continue;
    }
    const value = canonicalizeDocValue(valueCell);
    if (value === undefined) {
      // Формат значения не распознан — строку пропускаем (считаем в skipped).
      skipped.push(line);
      continue;
    }
    for (const key of keys) {
      entries.set(key, { key, value, raw: valueCell });
    }
  }
  return { found: true, entries, skipped };
}

/** Плоские дефолты секции `plugins` из кода: `plugins.<путь>` → значение. */
function collectCodeDefaults(): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [name, value] of Object.entries(node)) {
      const path = `${prefix}.${name}`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path);
        continue;
      }
      result.set(path, value);
    }
  };
  walk(defaultConfig.plugins as unknown as Record<string, unknown>, 'plugins');
  return result;
}

describe('docs/CONFIGURATION.md — дефолты plugins.* совпадают с кодом', () => {
  const repoRoot = findRepoRoot();
  const codeDefaults = collectCodeDefaults();

  for (const { lang, relPath } of DOC_FILES) {
    it(`${lang}: ${relPath} — таблица «Плагины (plugins.*)» совпадает с defaultConfig`, () => {
      const filePath = join(repoRoot, relPath);
      expect(
        existsSync(filePath),
        `Файл документации ${relPath} не найден (корень репозитория: ${repoRoot})`,
      ).toBe(true);

      const markdown = readFileSync(filePath, 'utf8');
      const { found, entries, skipped } = parsePluginsTable(markdown);

      expect(
        found,
        `В ${relPath} не найдена секция «Плагины (\`plugins.*\`)» — сверка дефолтов невозможна`,
      ).toBe(true);

      expect(
        entries.size,
        `В ${relPath} распознано ${entries.size} ключей plugins.* (минимум ${MIN_RECOGNIZED_KEYS}); ` +
          `пропущено строк: ${skipped.length}`,
      ).toBeGreaterThanOrEqual(MIN_RECOGNIZED_KEYS);

      const missingKeys = EXPECTED_PLUGIN_KEYS.filter((key) => !entries.has(key));
      expect(
        missingKeys,
        `В таблице секции «Плагины» (${relPath}) нет ключей: ${missingKeys.join(', ')}`,
      ).toEqual([]);

      const mismatches: string[] = [];
      for (const [key, codeValue] of codeDefaults) {
        const doc = entries.get(key);
        if (!doc) {
          mismatches.push(
            `${key}: нет в таблице (${relPath}); значение в коде: ${canonicalizeCodeValue(codeValue)}`,
          );
          continue;
        }
        const code = canonicalizeCodeValue(codeValue);
        if (doc.value !== code) {
          mismatches.push(
            `${key}: в ${relPath} — ${doc.value} (ячейка «${doc.raw}»), в коде — ${code}`,
          );
        }
      }
      for (const key of entries.keys()) {
        if (!codeDefaults.has(key)) {
          mismatches.push(`${key}: задокументирован в ${relPath}, но отсутствует в коде`);
        }
      }

      expect(
        mismatches,
        `Расхождения дефолтов plugins.* между кодом и ${relPath}:\n${mismatches.join('\n')}`,
      ).toEqual([]);
    });
  }
});
