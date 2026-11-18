import type { GitFileStatusKind, GitWorktreeFile } from '@itphx/synth-shared';

/**
 * ADR-076 (этап 1): разбор `git status --porcelain=v2 -z --branch`.
 *
 * Чистая функция без исполнения команд: сервис (`GitService.getWorktreeStatus`)
 * получает stdout через `ExecutionPort` (ADR-077) и отдаёт его сюда. Так формат
 * git разбирается в одном месте, а в remote-режиме control plane не читает ФС
 * агента (инвариант 28) — весь ввод приходит текстом команды.
 *
 * Формат записей (`-z`, поэтому записи разделены NUL, пути НЕ квотируются):
 *
 * ```text
 * # branch.oid <oid> | # branch.head <name> | # branch.ab +N -M
 * 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 * 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
 * u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 * ? <path>
 * ! <path>
 * ```
 */

/**
 * Предел числа записей в ответе `GET /api/v2/git/status` (на один репозиторий).
 *
 * 2000 записей — размер, который панель файлов ещё отрисовывает; гигантский
 * `node_modules`/сгенерированные каталоги не раздувают ответ. При превышении
 * `truncated: true`, лишние записи отбрасываются (первые N по порядку git).
 */
export const MAX_WORKTREE_STATUS_FILES = 2000;

/** Результат разбора `git status --porcelain=v2 -z --branch`. */
export interface ParsedWorktreeStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitWorktreeFile[];
  truncated?: boolean;
}

/** Заголовки `--porcelain=v2 --branch` (NUL-терминированы, как и записи). */
const BRANCH_HEAD_PREFIX = '# branch.head ';
const BRANCH_AB_PREFIX = '# branch.ab ';

/**
 * Вид изменения из `XY` (X — индекс, Y — рабочее дерево, `.` — без изменений).
 *
 * Приоритет важен: конфликт слияния (`U` в любой позиции) — не «modified»;
 * удаление перекрывает добавление (rename с `D` в рабочем дереве — всё ещё
 * существовавшая ранее запись); `A`/`C` (добавлен/скопирован) — `added`;
 * `R` — `renamed`; `T` (смена типа файла: файл → симлинк и т.п.) — `typechange`.
 */
function kindOf(xy: string): GitFileStatusKind {
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  if (x === 'U' || y === 'U') return 'conflict';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || x === 'C' || y === 'A' || y === 'C') return 'added';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'T' || y === 'T') return 'typechange';
  return 'modified';
}

/** Файл из записи `1`/`2`/`u`: путь — остаток после фиксированных полей. */
function makeFile(
  xy: string,
  path: string,
  extra?: { orig_path?: string; kind?: GitFileStatusKind },
): GitWorktreeFile {
  return {
    path,
    ...(extra?.orig_path ? { orig_path: extra.orig_path } : {}),
    kind: extra?.kind ?? kindOf(xy),
    staged: (xy[0] ?? '.') !== '.',
    unstaged: (xy[1] ?? '.') !== '.',
  };
}

/**
 * Разбор вывода `git status --porcelain=v2 -z --branch
 * --untracked-files=all --ignored=matching`.
 *
 * Записи `2` (rename/copy) занимают ДВА NUL-токена: путь + исходный путь.
 * Исходный путь обязательно «съедается» — иначе он был бы разобран как
 * самостоятельная запись (и путь, начинающийся с `# `, — как заголовок ветки).
 */
export function parseWorktreeStatus(
  stdout: string,
  opts?: { maxFiles?: number },
): ParsedWorktreeStatus {
  const maxFiles = opts?.maxFiles !== undefined && opts.maxFiles >= 0
    ? opts.maxFiles
    : MAX_WORKTREE_STATUS_FILES;

  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: GitWorktreeFile[] = [];
  let truncated = false;

  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (!token) continue;

    if (token.startsWith(BRANCH_HEAD_PREFIX)) {
      const head = token.slice(BRANCH_HEAD_PREFIX.length);
      // Detached HEAD — ветки нет (в отличие от `rev-parse --abbrev-ref`, который
      // вернул бы `HEAD`): UI показывает «detached», а не ветку «HEAD».
      if (head && head !== '(detached)') branch = head;
      continue;
    }
    if (token.startsWith(BRANCH_AB_PREFIX)) {
      const m = /^\+(\d+) -(\d+)$/.exec(token.slice(BRANCH_AB_PREFIX.length));
      if (m) {
        ahead = parseInt(m[1] ?? '0', 10);
        behind = parseInt(m[2] ?? '0', 10);
      }
      continue;
    }
    // Прочие заголовки (`# branch.oid`, `# branch.upstream`) не нужны панели.
    if (token.startsWith('#')) continue;

    const type = token[0];
    let file: GitWorktreeFile | undefined;

    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = token.split(' ');
      const path = fields.slice(8).join(' ');
      if (path) file = makeFile(fields[1] ?? '..', path);
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const fields = token.split(' ');
      const path = fields.slice(9).join(' ');
      const origPath = tokens[i + 1] ?? '';
      // Исходный путь — отдельный NUL-токен: без `i += 1` он стал бы записью.
      i += 1;
      if (path) {
        file = makeFile(fields[1] ?? '..', path, origPath ? { orig_path: origPath } : undefined);
      }
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = token.split(' ');
      const path = fields.slice(10).join(' ');
      // Конфликт слияния — отдельный вид, приоритетнее любого `XY`.
      if (path) file = makeFile(fields[1] ?? '..', path, { kind: 'conflict' });
    } else if (type === '?') {
      const path = token.slice(2);
      if (path) file = { path, kind: 'untracked', staged: false, unstaged: true };
    } else if (type === '!') {
      const path = token.slice(2);
      // Игнорируемый файл не изменён ни в индексе, ни в дереве — вид отдельный,
      // чтобы панель могла показать его приглушённо.
      if (path) file = { path, kind: 'ignored', staged: false, unstaged: false };
    }

    if (!file) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      // Первые N по порядку вывода git — детерминированно; хвост отбрасываем.
      break;
    }
    files.push(file);
  }

  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}
