import { realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { MessageI18n, ToolContext } from '@itphx/synth-shared';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';

const HOME = homedir();

export function resolvePath(input: string | undefined, workingDir: string): string {
  if (input === undefined) return resolve(workingDir);
  const trimmed = input.trim();
  if (trimmed === '') return resolve(workingDir);

  let base = '';
  let rest = trimmed;
  const homeMatch = /^~(?:\/|$)/.exec(trimmed);
  if (homeMatch) {
    base = HOME;
    rest = trimmed.slice(1);
    if (rest.startsWith('/')) rest = rest.slice(1);
  } else {
    const dollar = /^(\$(?:HOME|PWD)|\$\{(?:HOME|PWD)\})(?:\/|$)/.exec(trimmed);
    if (dollar) {
      const varName = dollar[1]!.includes('PWD') ? 'PWD' : 'HOME';
      base = varName === 'HOME' ? HOME : workingDir;
      rest = trimmed.slice(dollar[1]!.length);
      if (rest.startsWith('/')) rest = rest.slice(1);
    }
  }
  if (base !== '') {
    return rest === '' ? normalize(base) : resolve(base, rest);
  }
  if (isAbsolute(trimmed)) return normalize(trimmed);
  return resolve(workingDir, trimmed);
}

export function validateInputPath(input: string, paramName: string): void {
  if (input.trim() === '') {
    throw new Error(`Параметр "${paramName}" не может быть пустым`);
  }
  if (input.includes('\0')) {
    throw new Error(`Параметр "${paramName}" содержит недопустимые символы`);
  }
}

// ---------------------------------------------------------------------------
// Containment с учётом симлинков (единый хелпер для всех точек файлового доступа)
// ---------------------------------------------------------------------------

/** true, если `rel` (результат `relative(root, abs)`) означает «вне root». */
function isOutsideRel(rel: string): boolean {
  // `..foo` — имя каталога-потомка, не выход наружу; проверяем только `..`/`../`.
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Канонический путь (realpath) с поддержкой несуществующей цели: разыменовывается
 * ближайший существующий предок, остаток пути присоединяется как есть (нужно для
 * `write_file`/`create_directory`/`move` в ещё не созданное место).
 *
 * Fail-closed: битый симлинк в компоненте пути, цикл симлинков или иная ошибка
 * (`ELOOP`/`EACCES`/…) → `null` — путь нельзя достоверно разрешить. Это ключевой
 * момент защиты: `write_file` в dangling-симлинк (`evil -> /etc/cron.d/x`) не
 * подменяется лексическим путём, а отклоняется вызывающим кодом.
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
      // Компонент отсутствует. Если это симлинк с недоступной целью (dangling) —
      // это потенциальный обход: не разрешаем (fail-closed).
      try {
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

/** Лексическая (без обращения к ФС) проверка вхождения `candidate` в `root`. */
export function isLexicallyInside(root: string, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(root, candidate);
  const dir = isAbsolute(root) ? normalize(root) : resolve(root);
  return !isOutsideRel(relative(dir, abs));
}

/**
 * Containment с учётом симлинков: кандидат лежит внутри root ПОСЛЕ разыменования
 * обоих. Не разрешается (битый симлинк/цикл/ошибка) — `false` (fail-closed).
 */
export function isInsideReal(root: string, candidate: string): boolean {
  const realRoot = resolveRealPath(root);
  if (realRoot === null) return false;
  const realCandidate = resolveRealPath(candidate);
  if (realCandidate === null) return false;
  return !isOutsideRel(relative(realRoot, realCandidate));
}

/**
 * Побег за пределы `root` через симлинк: путь ЛЕКСИЧЕСКИ внутри root, но после
 * разыменования ведёт наружу (или не разрешается — fail-closed).
 *
 * Путь, лексически лежащий снаружи root, не является «побегом»: это обычный
 * внешний доступ, и его гейтит permission-слой (`external_directory`), а не
 * файловый тул (иначе сломались бы легитимные чтения внешних файлов).
 */
export function isSymlinkEscape(root: string, candidate: string): boolean {
  if (!isLexicallyInside(root, candidate)) return false;
  return !isInsideReal(root, candidate);
}

// ---------------------------------------------------------------------------
// Perimeter сессии: рабочий каталог + дополнительные корни (allowedRoots)
// ---------------------------------------------------------------------------

/**
 * Корни perimeter'а сессии: рабочий каталог (`workingDir`) и дополнительные
 * разрешённые корни (`allowedRoots`).
 *
 * Зачем: сессия в git-worktree (ADR-114) работает в каталоге worktree, а
 * основной checkout проекта (`project.workspace`) для неё — не «внешний мир»,
 * а вторая часть того же периметра. Относительные пути при этом по-прежнему
 * резолвятся от `workingDir`.
 *
 * Возвращаются абсолютные нормализованные пути без пустых значений и дублей
 * (порядок сохраняется: `workingDir` первым).
 */
export function toolRoots(ctx: Pick<ToolContext, 'workingDir' | 'allowedRoots'>): string[] {
  const roots: string[] = [];
  for (const raw of [ctx.workingDir, ...(ctx.allowedRoots ?? [])]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const abs = isAbsolute(raw) ? normalize(raw) : resolve(raw);
    if (!roots.includes(abs)) roots.push(abs);
  }
  return roots;
}

/**
 * Путь внутри **любого** из корней — с учётом симлинков (семантика
 * `isInsideWorkingDir`, но по списку корней).
 *
 * Лексически лежащий внутри, но ведущий через симлинк наружу, внутренним не
 * считается; не разрешается (битый симлинк/цикл) — `false` (fail-closed).
 */
export function isInsideAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isLexicallyInside(root, candidate) && isInsideReal(root, candidate));
}

/**
 * Побег через симлинк за пределы **всех** корней perimeter'а: путь лексически
 * внутри какого-то корня, но после разыменования не внутри ни одного.
 *
 * Путь, лексически лежащий вне всех корней, «побегом» не является — это обычный
 * внешний доступ, и его гейтит permission-слой (`external_directory`).
 */
export function isSymlinkEscapeInRoots(roots: readonly string[], candidate: string): boolean {
  if (!roots.some((root) => isLexicallyInside(root, candidate))) return false;
  return !roots.some((root) => isInsideReal(root, candidate));
}

/**
 * Результат-ошибка tool-вызова при попытке выйти за пределы рабочего каталога
 * через симлинк. Текст — из общего ключа `external_directory` (путь вне workspace).
 */
export function pathEscapesWorkspaceResult(path: string): {
  content: string;
  isError: true;
  metadata: { path: string; i18n: MessageI18n };
} {
  const params = { path, action: 'deny' };
  return {
    content: sm('permission.external_directory_default', params),
    isError: true,
    metadata: { path, i18n: i18nMeta('permission.external_directory_default', params) },
  };
}

/**
 * Служебный путь поиска (`glob`/`grep_files`), который не должен попадать в
 * вывод.
 *
 * Фильтр нужен поверх флагов ripgrep: явный `--glob <pattern>` перекрывает
 * собственное скрытие рипгрепа (файл `.hidden.ts` подходит под маску `*.ts`),
 * а негативный `--glob '!.git/**'` матчится относительно `cwd` процесса, а не
 * каталога поиска — если путь передан аргументом, `.git` не исключается.
 * Поэтому служебные пути отсекаем по сегментам относительного пути:
 *
 *   - `.git` (на любой глубине, включая вложенные репозитории) — всегда;
 *   - любые сегменты с точкой в начале — когда `hidden` не запрошен.
 *
 * @param relPath путь относительно каталога поиска (`/` или `\` — разделитель)
 * @param hidden  запрошены ли скрытые файлы (`hidden: true`)
 */
export function isIgnoredSearchPath(relPath: string, hidden: boolean): boolean {
  // `.`/`..` — навигация, а не имена файлов (иначе путь `../x` считался бы скрытым)
  const segments = relPath.split(/[\\/]+/).filter((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
  if (segments.some((segment) => segment === '.git')) return true;
  return !hidden && segments.some((segment) => segment.startsWith('.'));
}
