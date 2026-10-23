/**
 * Защита продакшн-бандла: публичная поверхность пакета **не должна** тянуть
 * тестовые зависимости (`vitest`).
 *
 * Контекст (PROP-090, Ф4б-3): контрактный suite расширений
 * (`engine/plugins/contract/*`) тянет `vitest` — как и контрактные suite'ы
 * слоя хранения (`storage/contract/*`). Их нельзя экспортировать наружу: в
 * прод-образе dev-зависимостей нет, и `import('@itphx/synth-core')` падал с
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'` (поймала сборка образа
 * исполнителя).
 *
 * Проверка: обход графа импортов от публичных точек входа (`src/index.ts` и
 * `src/server/app.ts` — их грузит рантайм) по **относительным** импортам;
 * если достижим модуль, импортирующий `vitest`, — тест падает.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Корень исходников пакета (`packages/core/src`). */
const SRC = HERE;

/** Точки входа, которые грузит рантайм (публичный API пакета и сервер приложения). */
const ENTRY_POINTS = ['index.ts', join('server', 'app.ts')];

/** Тестовые пакеты, которых не должно быть в продакшн-графе. */
const TEST_ONLY_PACKAGES = ['vitest'];

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

/** Разобрать импорты модуля (только статические, без динамических `import()`). */
function readImports(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

describe('прод-бандл core: тестовые зависимости не должны попадать в рантайм-граф', () => {
  it('от публичных точек входа не достижим ни один модуль с vitest', () => {
    const visited = new Set<string>();
    const offenders: string[] = [];

    const walk = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      let text: string;
      try {
        text = readFileSync(file, 'utf-8');
      } catch {
        return; // файл не существует (опциональная точка входа) — пропускаем
      }
      for (const pkg of TEST_ONLY_PACKAGES) {
        if (new RegExp(`from\\s+['"]${pkg}['"]`).test(text)) {
          offenders.push(`${file.replace(SRC, 'src')} → ${pkg}`);
        }
      }
      for (const spec of readImports(file)) {
        // Только относительные импорты: пакетные — внешние зависимости, их
        // состав определяется сборщиком (в прод-бандле их нет).
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
        walk(target);
      }
    };

    for (const entry of ENTRY_POINTS) walk(join(SRC, entry));

    expect(
      offenders,
      `тестовые зависимости достижимы из рантайм-графа: ${offenders.join(', ')}`,
    ).toEqual([]);
    expect(visited.size).toBeGreaterThan(20);
  });
});
