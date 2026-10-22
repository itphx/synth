/**
 * Containment рабочего каталога исполнителя (ADR-077, шаг 7a).
 *
 * Исполнитель выполняет команды от имени агента, поэтому `cwd` команды —
 * **граница безопасности**: каталог обязан лежать внутри корня workspace
 * исполнителя (`SYNTH_EXECUTOR_WORKSPACE`). Проверка — **fail-closed** и
 * **symlink-aware** (по образцу `resolveRepoCwd`/`isInsideReal` в
 * `packages/core/src/engine/tools/git.ts`):
 *
 * - абсолютный путь вне корня → отказ;
 * - выход через `..` → отказ;
 * - симлинк наружу (путь лексически внутри, реально — снаружи) → отказ;
 * - неразрешимый путь (битый симлинк, цикл симлинков, `EACCES`) → отказ.
 *
 * Канонизация повторяет `resolveRealPath` из core: разыменовывается ближайший
 * **существующий** предок, остаток пути присоединяется как есть (каталог может
 * быть создан позже), но битый симлинк в компоненте — отказ, а не подмена
 * лексического пути.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** Результат разрешения `cwd`. */
export type CwdResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'cwd_outside_workspace'; message: string };

/** `relative(root, abs)` означает «вне root». */
function isOutsideRel(rel: string): boolean {
  // `..foo` — имя каталога-потомка, а не выход наружу.
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Канонический путь (realpath) с поддержкой несуществующей цели:
 * разыменовывается ближайший существующий предок, остаток присоединяется как есть.
 *
 * Fail-closed: битый симлинк, цикл симлинков или иная ошибка ФС → `null`
 * (путь нельзя достоверно разрешить — вызывающий код обязан отказать).
 */
export function resolveRealPath(input: string): string | null {
  const abs = isAbsolute(input) ? normalize(input) : resolve(input);
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : resolve(real, ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      try {
        // Битый симлинк — потенциальный обход: не разрешаем.
        if (lstatSync(current).isSymbolicLink()) return null;
      } catch {
        // Компонент действительно отсутствует — поднимаемся к родителю.
      }
      const parent = dirname(current);
      if (parent === current) return null;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Containment с учётом симлинков: кандидат внутри root **после** разыменования
 * обоих. Не разрешается — `false` (fail-closed).
 */
export function isInsideReal(root: string, candidate: string): boolean {
  const realRoot = resolveRealPath(root);
  if (realRoot === null) return false;
  const realCandidate = resolveRealPath(candidate);
  if (realCandidate === null) return false;
  return !isOutsideRel(relative(realRoot, realCandidate));
}

/** Лексическая проверка вхождения (без обращения к ФС). */
export function isLexicallyInside(root: string, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(root, candidate);
  const dir = isAbsolute(root) ? normalize(root) : resolve(root);
  return !isOutsideRel(relative(dir, abs));
}

/**
 * Разрешить `cwd` команды внутри корня workspace.
 *
 * @param root корень workspace исполнителя
 * @param cwd запрошенный каталог (`undefined` — корень workspace)
 */
export function resolveContainedCwd(root: string, cwd: string | undefined): CwdResolution {
  if (typeof root !== 'string' || root.trim() === '') {
    return {
      ok: false,
      reason: 'cwd_outside_workspace',
      message: 'корень workspace исполнителя не задан — выполнение команды запрещено',
    };
  }

  const realRoot = resolveRealPath(root);
  if (realRoot === null) {
    return {
      ok: false,
      reason: 'cwd_outside_workspace',
      message: 'корень workspace исполнителя не разрешается (не существует или битый симлинк)',
    };
  }

  if (cwd === undefined) {
    return { ok: true, path: realRoot };
  }

  if (cwd.includes('\0')) {
    return {
      ok: false,
      reason: 'cwd_outside_workspace',
      message: 'cwd содержит недопустимые символы',
    };
  }

  // Относительный путь — отсчитывается от корня workspace; абсолютный — как есть.
  const candidate = isAbsolute(cwd) ? normalize(cwd) : resolve(realRoot, cwd);

  // 1) Лексическая проверка: отсекает `..` и абсолютные пути вне корня.
  if (!isLexicallyInside(realRoot, candidate)) {
    return {
      ok: false,
      reason: 'cwd_outside_workspace',
      message: 'cwd находится вне workspace исполнителя',
    };
  }

  // 2) Проверка с разыменованием: отсекает симлинк-побег.
  if (!isInsideReal(realRoot, candidate)) {
    return {
      ok: false,
      reason: 'cwd_outside_workspace',
      message: 'cwd (после разыменования симлинков) находится вне workspace исполнителя',
    };
  }

  return { ok: true, path: candidate };
}
