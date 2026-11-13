/**
 * Периметр файловых операций — общий для control plane и исполнителя
 * (PROP-135, Ф1/Ф2).
 *
 * ## Что здесь
 *
 * - **текст отказа «FS недоступна в этом контуре»** — его видят и читающие,
 *   и записывающие тулы; константа одна, чтобы текст не разъехался;
 * - **проверка симлинк-побега** (`escapesWorkspace`) — по **реальным** путям,
 *   которые берёт точка исполнения (в remote-режиме — исполнитель).
 *
 * ## Почему периметр считается на стороне исполнения
 *
 * Лексическая проверка в control plane не видит разыменования симлинков на
 * другой стороне: путь, лексически лежащий внутри workspace, может вести
 * наружу. Канонические пути поэтому запрашиваются у порта (`fs.realpath`) —
 * и в inline-режиме, и в remote-режиме это одна и та же точка.
 *
 * Правила `escapesWorkspace`:
 *
 * - путь лексически внутри корня, но после `realpath` — вне **всех** реальных
 *   корней ⇒ побег;
 * - `realpath` не разрешился (`unresolvable` — битый симлинк, цикл, ошибка
 *   ФС) ⇒ побег (fail-closed: доказать безопасность не удалось);
 * - пути нет (`not_found`) ⇒ **не** побег: это обычная ошибка операции, её
 *   сообщит вызывающий;
 * - путь лексически вне всех корней ⇒ **не** побег: внешний доступ решён
 *   permission-слоем (`external_directory`).
 */

import { basename, dirname, join } from 'node:path';
import { isLexicallyInside } from '../engine/tools/path-utils.js';
import {
  isExecutionFsUnavailableError,
  isFsPathError,
  type ExecutionFs,
} from './ports/execution-fs.js';

/**
 * Текст отказа «FS недоступна в этом контуре» (PROP-135).
 *
 * Английский — это техническое сообщение порта (его видит оператор), а не
 * текст движка для пользователя.
 */
export const FS_UNAVAILABLE_TEXT =
  'Filesystem operations are unavailable in the current execution environment.';

/**
 * Симлинк-побег за периметр сессии — по **реальным** путям (PROP-135).
 *
 * @param fs — порт исполнения (точка, где живёт ФС);
 * @param roots — корни периметра (рабочий каталог + `allowedRoots`);
 * @param path — проверяемый путь.
 */
export async function escapesWorkspace(
  fs: ExecutionFs,
  roots: readonly string[],
  path: string,
): Promise<boolean> {
  if (!roots.some((root) => isLexicallyInside(root, path))) return false;

  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await fs.realpath(root));
    } catch (err) {
      // «FS недоступна» — не про корень: контура нет вовсе ⇒ отказ должен
      // увидеть вызывающий (тул отдаст текст про `features.fs`), а не
      // выглядеть как «побег за периметр».
      if (isExecutionFsUnavailableError(err)) throw err;
      // Корень не разрешается — сравнить с ним нечем; пропускаем (решение
      // принимается по остальным корням).
    }
  }

  let realPath: string;
  try {
    realPath = await realpathWithMissingTail(fs, path);
  } catch (err) {
    // «FS недоступна» — не решение о пути (см. выше).
    if (isExecutionFsUnavailableError(err)) throw err;
    // «Пути нет» — не побег; любая другая неразрешимость (нет доступа,
    // цикл симлинков, битый симлинк) — fail-closed.
    if (isFsPathError(err) && err.code === 'not_found') return false;
    return true;
  }

  return !realRoots.some((root) => isLexicallyInside(root, realPath));
}

/**
 * Канонический путь с поддержкой **ещё не существующего** хвоста.
 *
 * Путь может не существовать (файл создаётся, каталог создаётся) — тогда
 * разрешается **ближайший существующий предок**, а остаток пути присоединяется
 * как есть. Без этого симлинк-компонент в пути не виден: `escape/evil.txt`
 * (где `escape` — симлинк наружу, а самого файла ещё нет) разрешился бы как
 * «пути нет» ⇒ побег не замечен, а запись ушла бы наружу.
 *
 * Fail-closed: битый симлинк в компоненте пути, цикл симлинков или иная
 * неразрешимость → ошибка (вызывающий считает путь побегом).
 */
async function realpathWithMissingTail(fs: ExecutionFs, path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (err) {
      // Разрешается только «пути нет» — иначе путь непригоден для решения
      // (доступ/цикл/битый симлинк) ⇒ fail-closed наверх.
      if (!isFsPathError(err) || err.code !== 'not_found') throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}
