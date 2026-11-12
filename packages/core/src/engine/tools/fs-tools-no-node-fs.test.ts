/**
 * Lint-инвариант PROP-135 (Ф1): файловые тулы **не ходят в `node:fs`**.
 *
 * ## Зачем
 *
 * Файловые операции агента уезжают в **контур исполнения** (PROP-135): в
 * split-топологии рабочий каталог лежит на исполнителе, а control plane —
 * тонкий. Если тул читает ФС сам (`node:fs`), то в remote-режиме он читает
 * **не тот** каталог: пути исполнителя и пути control plane — разные вещи.
 * Молчаливый обход порта — это тихая поломка топологии, поэтому его надо
 * ловить **тестом**, а не просмотром кода.
 *
 * ## Правило
 *
 * - файлы `engine/tools/*.ts` (без `*.test.ts`) не импортируют `node:fs` и
 *   `node:fs/promises`;
 * - список **allowlist** — файлы, которые ещё остаются локальными (следующие
 *   слайсы PROP-135 переводят их на порт, и список сокращается);
 * - новый файл с `node:fs` вне списка — **тест падает**.
 *
 * Список allowlist:
 *
 * ```
 * attach-workspace-file.ts,
 * save-attachment.ts, send-attachment.ts, project-context.ts,
 * path-utils.ts, search.ts
 * ```
 *
 * (`path-utils.ts` и `search.ts` — помощники периметра и поиска: их ещё
 * используют `glob`/`grep_files`, которые на порт не переведены.)
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Каталог тулов (тот же, где лежат `fs-read.ts`/`fs-write.ts`). */
const TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Файлы тулов (и их помощников), в которых `node:fs` **ещё** допустим.
 *
 * Список сокращается по мере перевода тулов на порт исполнения
 * (PROP-135 Ф2: запись/правка/удаление; Ф3: вложения).
 *
 * - `path-utils.ts` — помощник периметра: `realpathSync`/`lstatSync` для
 *   детекта симлинк-побега (нужны и поисковым тулам, они на порт не переведены);
 * - `search.ts` — `classifySearchPath` (`stat` пути поиска) для `glob`/`grep_files`.
 *
 * `fs-write.ts` и `atomic-file-write.ts` из списка **убраны** (Ф2, слайс 3a):
 * запись/создание каталога/удаление идут через порт (`ExecutionFs`), а общая
 * реализация атомарной записи лежит в `execution/fs-atomic.ts` — вне
 * `engine/tools/`.
 *
 * `patch.ts` из списка **убран** (Ф2, слайс 3b): пат целиком ушёл на порт
 * (чтение — `fs.readRawText`, запись — `fs.writeFile`, перенос — `fs.rename`,
 * каталоги — `fs.mkdir`, удаление — `fs.remove`), а фасад
 * `engine/tools/atomic-file-write.ts` удалён вместе с ним.
 */
const ALLOWED_NODE_FS_FILES: readonly string[] = [
  'attach-workspace-file.ts',
  'save-attachment.ts',
  'send-attachment.ts',
  'project-context.ts',
  'path-utils.ts',
  'search.ts',
];

/** Запрещённые импорты `node:fs`. */
const FORBIDDEN_IMPORTS = ['node:fs', 'node:fs/promises'];

/** Исходники тулов (без тестов). */
function toolSources(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

/** Есть ли в исходнике запрещённый импорт. */
function hasForbiddenImport(source: string): string | undefined {
  for (const specifier of FORBIDDEN_IMPORTS) {
    // `from 'node:fs'` / `from "node:fs/promises"` / `import('node:fs')`
    const pattern = new RegExp(`['"]${specifier.replace('/', '\\/')}['"]`);
    if (pattern.test(source)) return specifier;
  }
  return undefined;
}

describe('PROP-135: файловые тулы не ходят в node:fs', () => {
  it('allowlist существует и не содержит тестовых файлов', () => {
    for (const name of ALLOWED_NODE_FS_FILES) {
      expect(name.endsWith('.ts')).toBe(true);
      expect(name.endsWith('.test.ts')).toBe(false);
    }
  });

  it('ни один файл тула вне allowlist не импортирует node:fs', () => {
    const violations: string[] = [];
    for (const name of toolSources()) {
      if (ALLOWED_NODE_FS_FILES.includes(name)) continue;
      const source = readFileSync(join(TOOLS_DIR, name), 'utf-8');
      const specifier = hasForbiddenImport(source);
      if (specifier) violations.push(`${name} → ${specifier}`);
    }
    expect(violations).toEqual([]);
  });

  it('fs-read.ts и fs-read-media.ts — чисты (node:fs там нет)', () => {
    for (const name of ['fs-read.ts', 'fs-read-media.ts']) {
      const source = readFileSync(join(TOOLS_DIR, name), 'utf-8');
      expect(hasForbiddenImport(source), `${name} импортирует node:fs`).toBeUndefined();
    }
  });

  it('allowlist не шире реального списка (файлы из списка существуют)', () => {
    const sources = new Set(toolSources());
    for (const name of ALLOWED_NODE_FS_FILES) {
      expect(sources.has(name), `allowlist ссылается на несуществующий ${name}`).toBe(true);
    }
  });
});
