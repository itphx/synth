import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ADR-076: состояние целевого каталога клонирования (без запуска git).
 *
 * Прежняя проверка «путь непустой?» смешивала три РАЗНЫХ состояния в одно
 * сообщение «репозиторий уже существует»: полноценный репозиторий (его надо не
 * клонировать, а зарегистрировать), след прерванного клона (`.git` без
 * коммитов — его надо удалить) и непустой каталог без git (нужен другой путь).
 * Пользователь и агент не понимали, что делать; повтор клонирования после
 * оборванной сети упирался в 409 навсегда.
 *
 * Классификация — только по файловой системе (`readdir`/`stat`/`readFile`),
 * git **не** запускается: проверка не должна ни ходить в сеть, ни зависеть от
 * доступности бинаря, ни оставлять следов.
 */

/** Вид занятия пути: полноценный репозиторий | след прерванного клона | каталог без git. */
export type RepoOccupancy = 'repo' | 'stub' | 'dir';

/** Результат проверки занятости пути. */
export interface RepoOccupancyInfo {
  /** Что именно занимает путь. */
  occupied: RepoOccupancy;
  /** Число записей верхнего уровня — только для `dir` (для сообщения). */
  entries?: number;
}

/** Ошибка проверки: путь существует, но его состояние определить нельзя. */
export interface RepoPathUnreadableError {
  error: string;
  code: 'git.repo_path_unreadable';
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Есть ли в `.git` коммиты.
 *
 * Признаки по заданию: непустой `refs/heads` (любая ветка — в т.ч. вложенная:
 * верхний уровень `refs/heads` непуст) либо существующий и непустой
 * `packed-refs`.
 *
 * `.git` может быть **файлом** — это linked worktree (ADR-114) или сабмодуль:
 * такой путь считаем полноценным репозиторием (удалять его нельзя, а
 * зарегистрировать существующий — можно).
 */
async function gitDirHasCommits(repoPath: string): Promise<boolean> {
  const dotGit = join(repoPath, '.git');
  let info;
  try {
    info = await stat(dotGit);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw unreadable(repoPath, err);
  }
  if (!info.isDirectory()) {
    // `.git`-файл (`gitdir: …`) — рабочий каталог worktree/сабмодуля.
    try {
      const raw = await readFile(dotGit, 'utf8');
      return raw.trim().length > 0;
    } catch (err) {
      throw unreadable(repoPath, err);
    }
  }

  try {
    const heads = await readdir(join(dotGit, 'refs', 'heads'));
    if (heads.length > 0) return true;
  } catch (err) {
    // Нет каталога `refs/heads` (клон без веток / пустой `git init`) — не ошибка.
    if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTDIR') {
      throw unreadable(repoPath, err);
    }
  }

  try {
    const packed = await stat(join(dotGit, 'packed-refs'));
    if (packed.isFile() && packed.size > 0) return true;
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw unreadable(repoPath, err);
  }

  return false;
}

function unreadable(repoPath: string, cause?: unknown): RepoPathUnreadableError {
  const reason = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return {
    error: `Каталог «${repoPath}» существует, но недоступен для чтения${reason ? `: ${reason}` : ''}`,
    code: 'git.repo_path_unreadable',
  };
}

/**
 * Проверяет, занят ли целевой путь клонирования (ADR-076).
 *
 * Возвращает `null`, если путь свободен: каталога нет **или** он пуст
 * (`git clone` в пустой каталог допустим). Иначе — вид занятия.
 *
 * Нечитаемый каталог (EACCES/EPERM/…) — отдельная типизированная ошибка
 * `git.repo_path_unreadable`, а не «путь свободен»: иначе проверка «проходила»
 * и падение случалось уже внутри git с невнятным текстом.
 */
export async function inspectRepoPath(absPath: string): Promise<RepoOccupancyInfo | null> {
  let entries: string[];
  try {
    entries = await readdir(absPath);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return null;
    // Путь — файл: каталога нет, но место занято (git тоже не развернётся).
    if (code === 'ENOTDIR') return { occupied: 'dir', entries: 1 };
    throw unreadable(absPath, err);
  }

  if (!entries.includes('.git')) {
    return entries.length === 0 ? null : { occupied: 'dir', entries: entries.length };
  }

  const hasCommits = await gitDirHasCommits(absPath);
  return { occupied: hasCommits ? 'repo' : 'stub' };
}
