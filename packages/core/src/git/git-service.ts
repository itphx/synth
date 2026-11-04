import { readdir, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve, relative, dirname, join, isAbsolute, sep } from 'node:path';
import type { RepoStatus, CommitInfo, CommitDetail, CommitFileInfo } from '@itphx/synth-shared';
import type { ExecutionPort, ExecSecret } from '../execution/ports/index.js';
import { isExecutionError } from '../execution/ports/index.js';
import { inspectRepoPath } from './repo-occupancy.js';
import { gitExec, sanitizeGitEnv } from './exec.js';
import { isInsideReal, resolveRealPath } from '../engine/tools/path-utils.js';

/**
 * ADR-076 §T3: git-сервис ядра (перенос из backend `lib/git-service.ts`).
 * Единая реализация git — в core; backend (T4) переходит на core-фабрику роутов.
 *
 * ADR-077: исполнение — через `ExecutionPort` (`git/exec.ts`), без сторонней
 * git-библиотеки.
 * Публичный API класса не меняется; в remote-режиме те же команды уходят
 * исполнителю (control plane больше не требует git в своём образе).
 */

/** Санитайз окружения git — историческое место экспорта (реализация — `exec.ts`). */
export { sanitizeGitEnv };

/**
 * Опции git-вызова: дополнительное окружение и секреты вызова.
 *
 * `secrets` — SSH-ключ (ADR-077, протокол 4): он доставляется точке
 * исполнения на время вызова, а не прописывается путём в control plane.
 */
export interface GitEnvOptions {
  env?: Record<string, string>;
  /** Секреты вызова (SSH-ключ) — доставляются точке исполнения. */
  secrets?: ExecSecret[];
}

/** Опции fetch: окружение + конкретный remote (по умолчанию — все). */
export interface GitFetchOptions extends GitEnvOptions {
  remote?: string;
}

/**
 * Опции сервиса. `execution` — порт исполнения команд (ADR-077); не задан —
 * inline (`InlineExecutionPort`), то есть прежнее локальное поведение.
 *
 * `cloneTimeoutMs`/`fetchTimeoutMs` — пределы сетевых операций (ADR-076,
 * секция `git.*` конфига): значения подаёт вызывающий (роуты — из
 * `createGitRoutes`, оркестратор — из `gitConfig`), дефолт — 5 минут.
 * `0` — без таймаута.
 */
export interface GitServiceOptions {
  execution?: ExecutionPort;
  cloneTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /**
   * Предел размера diff коммита (байт). Не задан — `MAX_COMMIT_DIFF_BYTES`
   * (1 МиБ); при превышении diff обрезается, в DTO — `diff_truncated: true`.
   */
  maxDiffBytes?: number;
}

/**
 * Дефолтные таймауты сетевых git-операций (мс) — совпадают с дефолтами
 * секции `git` конфига (`git.cloneTimeoutMs`/`git.fetchTimeoutMs`).
 *
 * Сервис не читает конфиг сам (инвариант 10): значения подаёт вызывающий, а
 * эти константы — фоллбэк для конструкторов без опций (тесты, CLI-пути).
 */
export const DEFAULT_GIT_CLONE_TIMEOUT_MS = 300_000;
export const DEFAULT_GIT_FETCH_TIMEOUT_MS = 300_000;

/**
 * Предел размера diff коммита (`GET /api/v2/git/commit`), байт: 1 МиБ.
 * Diff больше предела обрезается, в DTO добавляется `diff_truncated: true` —
 * мегабайты патча по проводу не уходят.
 */
export const MAX_COMMIT_DIFF_BYTES = 1024 * 1024;

/**
 * Обрезка diff по пределу размера (байт). Возвращает обрезанный текст и
 * признак усечения. Граница режется по байтам, не разрывая UTF-8-последовательность
 * (хвостовой «битый» символ отбрасывается).
 */
export function truncateDiff(
  diff: string,
  maxBytes: number = MAX_COMMIT_DIFF_BYTES,
): { diff: string; truncated: boolean } {
  const bytes = Buffer.from(diff, 'utf-8');
  if (bytes.length <= maxBytes) return { diff, truncated: false };
  let cut = bytes.subarray(0, maxBytes).toString('utf-8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return { diff: cut, truncated: true };
}

/** Нормализация таймаута: отрицательное/нечисловое значение → дефолт. */
function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'только что';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес назад`;
  const years = Math.floor(months / 12);
  return `${years} г назад`;
}

/**
 * ADR-076: резолвит относительный путь репозитория ВНУТРИ абсолютного workspace.
 *
 * Проверка двухступенчатая и **fail-closed**:
 *
 * 1. лексическая — абсолютный `repoRelPath` либо выход за workspace (`..`) →
 *    `PATH_TRAVERSAL`;
 * 2. реальная (с учётом симлинков) — корень и цель разыменовываются
 *    (`isInsideReal` из `engine/tools/path-utils.ts`, там же обработка
 *    несуществующей цели и ELOOP). Симлинк внутри workspace, ведущий наружу
 *    (в том числе в промежуточной компоненте: `link/sub`), и неразрешимый путь
 *    (dangling-симлинк, цикл, ошибка ФС) отклоняются тем же кодом. Без этого
 *    шага HTTP-слой (`init`/`clone`/`register`/`remove`) проходил сквозь симлинк
 *    наружу workspace, а `remove` делает `rm -rf`. Агентские git-тулы защищены
 *    тем же правилом (`resolveRepoCwd` → `isInsideReal`).
 *
 * Несуществующая цель разрешена (`initRepo` создаёт каталог, `cloneRepo` тоже):
 * `isInsideReal` разыменовывает ближайшего **существующего** предка, остаток
 * пути проверяется лексически.
 *
 * Возвращается **лексический** путь, а не realpath: это адрес вызывающего
 * (`git`, `inspectRepoPath`), с которым сравнивается/показывается запись
 * реестра (`project.repos` хранит относительный путь, роуты и тесты ждут
 * лексическую форму). Разыменование нужно только для проверки.
 *
 * **Контракт не меняем:** деструктивные и создающие операции (`removeLocal`,
 * `initRepo`, `cloneRepo`) не полагаются на этот путь как на адрес ФС — они
 * вычисляют канонический адрес операции (`resolveOperationalRepoPath`) и
 * перепроверяют containment непосредственно перед вызовом ФС (`assertInside`).
 * Иначе остаётся check-then-use: между проверкой и `rm`/`mkdir`/`rename`
 * компонент пути могут подменить симлинком, и операция уйдёт наружу.
 *
 * Функция синхронная осознанно: `path-utils` построена на `realpathSync`, и
 * ровно та же проверка в агентском слое (`resolveRepoCwd`) синхронная —
 * второго (async) варианта правила containment не заводим.
 */
export function resolveRepoPath(workspaceAbsPath: string, repoRelPath: string): string {
  const base = pathResolve(workspaceAbsPath);
  const repoPath = repoRelPath ? pathResolve(base, repoRelPath) : base;
  const rel = relative(base, repoPath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw { error: 'Путь репозитория выходит за пределы workspace', code: 'PATH_TRAVERSAL' };
  }
  if (!isInsideReal(base, repoPath)) {
    throw {
      error: 'Путь репозитория выходит за пределы workspace (симлинк или неразрешимый путь)',
      code: 'PATH_TRAVERSAL',
    };
  }
  return repoPath;
}

/** Ошибка выхода за пределы workspace — тот же код, что у `resolveRepoPath`. */
function traversalError(): { error: string; code: string } {
  return {
    error: 'Путь репозитория выходит за пределы workspace (симлинк или неразрешимый путь)',
    code: 'PATH_TRAVERSAL',
  };
}

/**
 * Канонический адрес операции: разыменованный путь (ближайший существующий
 * предок + остаток) с повторной проверкой containment по **реальному** пути.
 *
 * Нужен деструктивным/создающим операциям: `rm`/`mkdir`/`rename` должны идти
 * по адресу без симлинков в уже существующей части, а не по лексическому
 * пути. `resolveRealPath` = `null` (dangling-симлинк, цикл, ошибка ФС) —
 * fail-closed.
 */
function resolveOperationalRepoPath(workspaceAbsPath: string, repoRelPath: string): string {
  const base = pathResolve(workspaceAbsPath);
  const resolved = resolveRealPath(resolveRepoPath(base, repoRelPath));
  if (resolved === null || !isInsideReal(base, resolved)) {
    throw traversalError();
  }
  return resolved;
}

/**
 * Повторная проверка containment непосредственно перед операцией с ФС.
 *
 * Сужает окно TOCTOU: между `resolveOperationalRepoPath` и `rm`/`rename`
 * компонент пути могут подменить симлинком. Гонку это не закрывает полностью
 * (без `openat`/`O_NOFOLLOW`-семантики), но дешёвая перепроверка перед каждой
 * операцией отсекает подмену, случившуюся до неё.
 */
function assertInside(workspaceAbsPath: string, absPath: string): void {
  if (!isInsideReal(pathResolve(workspaceAbsPath), absPath)) {
    throw traversalError();
  }
}

/**
 * Best-effort уборка временного каталога клона: удаляем только если он всё ещё
 * разрешается внутрь workspace (иначе `rm -rf` по подменённому пути ушёл бы
 * наружу). Ошибки уборки не подменяют исходную ошибку операции.
 */
async function removeTmpQuietly(workspaceAbsPath: string, target: string): Promise<void> {
  try {
    const resolved = resolveRealPath(target);
    if (resolved === null || !isInsideReal(pathResolve(workspaceAbsPath), resolved)) return;
    await rm(resolved, { recursive: true, force: true });
  } catch {
    // уборка best-effort
  }
}

/** Имя репозитория из URL (последний сегмент без `.git`). */
export function deriveRepoName(url: string): string {
  let name = url.replace(/\/$/, '').split('/').pop() || 'repo';
  name = name.replace(/\.git$/, '');
  return name;
}

/** Поля заголовка `git status --porcelain=v2 --branch`. */
const STATUS_BRANCH_HEAD = '# branch.head ';

/**
 * Ветка из `git status --porcelain=v2 --branch -z`.
 *
 * Записи (`1`/`2`/`u`/`?`/`!`) пропускаются: у записи типа `2` (rename/copy)
 * исходный путь идёт отдельным NUL-полем — его тоже пропускаем, иначе путь,
 * начинающийся с `# `, был бы прочитан как заголовок.
 */
function parseStatusBranch(raw: string): string | undefined {
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.startsWith(STATUS_BRANCH_HEAD)) {
      const head = token.slice(STATUS_BRANCH_HEAD.length).trim();
      if (!head) return undefined;
      // `rev-parse --abbrev-ref HEAD` (прежняя реализация) на detached HEAD
      // возвращает `HEAD` — сохраняем это представление.
      return head === '(detached)' ? 'HEAD' : head;
    }
    if (token.startsWith('2 ')) i += 1;
  }
  return undefined;
}

/** Разбор `--numstat -z`: `add\tdel\tpath`, у rename путь — два NUL-поля. */
function parseNumstatZ(raw: string): CommitFileInfo[] {
  const files: CommitFileInfo[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (!token) continue;
    const parts = token.split('\t');
    if (parts.length < 2) continue;
    const additions = parseInt(parts[0] ?? '', 10) || 0;
    const deletions = parseInt(parts[1] ?? '', 10) || 0;
    const path = parts.slice(2).join('\t');
    if (!path) {
      // Rename/copy: `add\tdel\t` + исходный путь + новый путь.
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (newPath) {
        files.push({ path: newPath, status: 'renamed', additions, deletions });
      }
      continue;
    }
    files.push({ path, status: 'modified', additions, deletions });
  }
  return files;
}

export class GitService {
  private readonly _execution: ExecutionPort | undefined;
  private readonly _cloneTimeoutMs: number;
  private readonly _fetchTimeoutMs: number;
  private readonly _maxDiffBytes: number;

  constructor(
    private workspacesRoot: string,
    options: GitServiceOptions = {},
  ) {
    this._execution = options.execution;
    this._cloneTimeoutMs = normalizeTimeout(options.cloneTimeoutMs, DEFAULT_GIT_CLONE_TIMEOUT_MS);
    this._fetchTimeoutMs = normalizeTimeout(options.fetchTimeoutMs, DEFAULT_GIT_FETCH_TIMEOUT_MS);
    this._maxDiffBytes = normalizeTimeout(options.maxDiffBytes, MAX_COMMIT_DIFF_BYTES);
  }

  /** Публичный доступ к проверке containment (для роутов/тулов/тестов) — realpath-safe. */
  resolveRepoPath(workspaceAbsPath: string, repoRelPath: string): string {
    return resolveRepoPath(workspaceAbsPath, repoRelPath);
  }

  /** Действующий таймаут клонирования (мс; `0` — без таймаута) — для сообщений. */
  get cloneTimeoutMs(): number {
    return this._cloneTimeoutMs;
  }

  /** Действующий таймаут fetch (мс; `0` — без таймаута) — для сообщений. */
  get fetchTimeoutMs(): number {
    return this._fetchTimeoutMs;
  }

  /** Git-команда через порт исполнения (ADR-077) с общим окружением. */
  private run(
    args: string[],
    cwd?: string,
    opts?: GitEnvOptions,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return gitExec(args, {
      execution: this._execution,
      cwd,
      env: opts?.env,
      // `0`/не задано — без таймаута (прежнее поведение для прочих команд).
      ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeoutMs } : {}),
      ...(opts?.secrets && opts.secrets.length > 0 ? { secrets: opts.secrets } : {}),
    });
  }

  async isRepo(repoPath: string, opts?: GitEnvOptions): Promise<boolean> {
    try {
      const { stdout } = await this.run(['rev-parse', '--is-inside-work-tree'], repoPath, opts);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getRepoStatus(repoAbsPath: string, opts?: GitEnvOptions): Promise<RepoStatus | null> {
    if (!(await this.isRepo(repoAbsPath, opts))) return null;
    try {
      const { stdout } = await this.run(
        ['status', '--porcelain=v2', '-z', '--branch'],
        repoAbsPath,
        opts,
      );
      const { stdout: logOut } = await this.run(
        ['log', '-1', '--format=%aI%x00%s'],
        repoAbsPath,
        opts,
      );
      const [lastCommitAt, lastCommitSubject] = logOut.split('\0');
      return {
        path: '',
        isRepo: true,
        currentBranch: parseStatusBranch(stdout),
        lastCommitAt: lastCommitAt || undefined,
        // `git log` добавляет завершающий перевод строки — оставляем только subject.
        lastCommitSubject: lastCommitSubject?.split('\n')[0] || undefined,
      };
    } catch {
      return null;
    }
  }

  async scanWorkspace(wsAbsPath: string): Promise<RepoStatus[]> {
    const results: RepoStatus[] = [];

    const rootStatus = await this.getRepoStatus(wsAbsPath);
    if (rootStatus) {
      rootStatus.path = '';
      results.push(rootStatus);
    }

    const subdirs = await this.listSubdirs(wsAbsPath, 3);
    for (const subdir of subdirs) {
      const fullPath = join(wsAbsPath, subdir);
      const status = await this.getRepoStatus(fullPath);
      if (status) {
        status.path = subdir;
        results.push(status);
      }
    }

    return results;
  }

  private async listSubdirs(root: string, maxDepth: number): Promise<string[]> {
    const result: string[] = [];

    async function walk(dir: string, depth: number, relPrefix: string) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        result.push(relPath);
        await walk(join(dir, entry.name), depth + 1, relPath);
      }
    }

    await walk(root, 1, '');
    return result;
  }

  async initRepo(
    wsAbsPath: string,
    repoRelPath: string,
    defaultBranch?: string,
    opts?: GitEnvOptions,
  ): Promise<RepoStatus> {
    const base = pathResolve(wsAbsPath);
    // Создание — по каноническому адресу (без симлинков в существующей части):
    // `mkdir -p`/`git init` не должны проходить сквозь подменённую компоненту.
    const repoPath = resolveOperationalRepoPath(base, repoRelPath);
    // Перепроверка непосредственно перед созданием (check-then-use).
    assertInside(base, repoPath);
    try {
      await mkdir(repoPath, { recursive: true });
    } catch {
      // directory might already exist
    }
    const args = defaultBranch ? ['init', '--initial-branch', defaultBranch] : ['init'];
    // Каталог уже создан нами, но перепроверяем и перед git init: между
    // mkdir и запуском путь могли подменить.
    assertInside(base, repoPath);
    await this.run(args, repoPath, opts);
    return {
      path: repoRelPath,
      isRepo: true,
    };
  }

  /**
   * ADR-076: клонирование репозитория — **атомарно**.
   *
   * Прежняя реализация запускала `git clone` прямо в целевой путь: падение на
   * фазе fetch (сеть, таймаут, отмена) оставляло каталог с `.git` и
   * `[remote "origin"]`, но без коммитов, а регистрация в `project.repos` шла
   * только после успеха — повтор упирался в «409 уже существует», и путь
   * навсегда оставался «ни репозиторий, ни свободное место».
   *
   * Теперь клон идёт в **соседний** временный каталог `<repoPath>.tmp-<uuid>`
   * (тот же родитель → `rename` атомарен в пределах одной ФС), а целевой путь
   * появляется только после успешного клонирования. Любая ошибка (таймаут,
   * сеть, отмена, гонка за путь) убирает временный каталог: на диске **не
   * остаётся ничего**.
   *
   * Адрес операции — канонический (`resolveOperationalRepoPath`): и целевой
   * путь, и `tmpPath` строятся от разрешённого родителя и проверяются на
   * containment перед `mkdir`/`clone`/`rename`; уборка временного каталога — тоже
   * только внутри workspace (`removeTmpQuietly`).
   *
   * Ошибки типизированы: таймаут → `git.clone_timeout` (HTTP 504), занятый
   * целевой путь → `git.repo_exists`, прочее — как есть.
   */
  async cloneRepo(
    wsAbsPath: string,
    repoRelPath: string,
    url: string,
    branch?: string,
    opts?: GitEnvOptions,
  ): Promise<RepoStatus> {
    const base = pathResolve(wsAbsPath);
    const effectivePath = repoRelPath || deriveRepoName(url);
    // Канонический адрес цели: `mkdir`/`clone`/`rename` идут по нему, а не по
    // лексическому пути (иначе подменённая компонента уводит операцию наружу).
    const repoPath = resolveOperationalRepoPath(base, effectivePath);
    const parentDir = dirname(repoPath);
    // Родитель тоже обязан быть внутри workspace: иначе временный каталог
    // оказался бы снаружи (цель — корень workspace).
    assertInside(base, parentDir);
    try {
      await mkdir(parentDir, { recursive: true });
    } catch {
      // директория может уже существовать
    }

    // Временный каталог — рядом с целью (разрешённый родитель): `rename` в
    // пределах одной ФС. Строится от канонического `repoPath`, проверяется
    // отдельно — до создания.
    const tmpPath = `${repoPath}.tmp-${randomUUID()}`;
    assertInside(base, tmpPath);
    const args = ['clone'];
    if (branch) args.push('--branch', branch);
    args.push(url, tmpPath);

    try {
      // `cwd` — родительский каталог внутри workspace: в remote-режиме
      // containment проверяет исполнитель, и абсолютный путь назначения обязан
      // лежать в его workspace (том общий, ADR-077).
      await this.run(args, parentDir, opts, this._cloneTimeoutMs);

      // Путь могли занять, пока шёл клон (гонка) — `rename` не должен молча
      // затирать чужой каталог.
      if ((await inspectRepoPath(repoPath)) !== null) {
        throw {
          error: `Репозиторий уже существует по пути «${effectivePath}»`,
          code: 'git.repo_exists',
        };
      }
      // Перепроверка обоих концов непосредственно перед `rename`.
      assertInside(base, tmpPath);
      assertInside(base, repoPath);
      await rename(tmpPath, repoPath);
    } catch (err) {
      // Главный критерий: после неуспеха на диске не остаётся ничего. Уборка —
      // только если временный каталог всё ещё внутри workspace.
      await removeTmpQuietly(base, tmpPath);
      if (isExecutionError(err) && err.reason === 'timeout') {
        throw {
          error: `Клонирование репозитория прервано по таймауту (${this._cloneTimeoutMs} мс)`,
          code: 'git.clone_timeout',
        };
      }
      throw err;
    }

    return {
      path: effectivePath,
      isRepo: true,
    };
  }

  /**
   * ADR-076: fetch репозитория (при необходимости с SSH-доступом).
   *
   * Таймаут — `git.fetchTimeoutMs` (сеть git может идти минутами, но зависший
   * вызов не должен держать ход агента бесконечно); истечение →
   * `git.fetch_timeout` (HTTP 504).
   */
  async fetchRepo(wsAbsPath: string, repoRelPath: string, opts?: GitFetchOptions): Promise<void> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const args = opts?.remote ? ['fetch', opts.remote] : ['fetch'];
    try {
      await this.run(args, repoPath, opts, this._fetchTimeoutMs);
    } catch (err) {
      if (isExecutionError(err) && err.reason === 'timeout') {
        throw {
          error: `git fetch прерван по таймауту (${this._fetchTimeoutMs} мс)`,
          code: 'git.fetch_timeout',
        };
      }
      throw err;
    }
  }

  /**
   * ADR-076: удаляет локальный каталог репозитория. `rm -rf` выполняется ТОЛЬКО
   * по каноническому пути внутри workspace (разыменование симлинков — через
   * `resolveOperationalRepoPath`) и после повторной проверки containment
   * непосредственно перед `rm`; корень workspace удалять запрещено (и в
   * лексической, и в реальной форме). Это файловая операция, не git-команда.
   */
  async removeLocal(wsAbsPath: string, repoRelPath: string): Promise<void> {
    const base = pathResolve(wsAbsPath);
    const rootResolved = resolveRealPath(base);
    if (rootResolved === null) throw traversalError();
    const repoPath = resolveOperationalRepoPath(base, repoRelPath);
    // Корень workspace — и лексически (путь без симлинков), и после разыменования.
    if (repoPath === base || repoPath === rootResolved) {
      throw { error: 'Нельзя удалить корень workspace', code: 'PATH_TRAVERSAL' };
    }
    // Перепроверка непосредственно перед `rm` (check-then-use).
    assertInside(base, repoPath);
    await rm(repoPath, { recursive: true, force: true });
  }

  async getLog(
    wsAbsPath: string,
    repoRelPath: string,
    maxCount = 30,
    opts?: GitEnvOptions,
  ): Promise<CommitInfo[]> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const branch = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, opts)).stdout.trim();
    const { stdout } = await this.run(
      [
        'log',
        '-n',
        String(maxCount),
        '-z',
        '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s',
      ],
      repoPath,
      opts,
    );
    const tokens = stdout.split('\0');
    // `-z` завершает каждый коммит NUL — последний токен пустой.
    if (tokens.at(-1) === '') tokens.pop();
    const commits: CommitInfo[] = [];
    for (let i = 0; i + 5 < tokens.length; i += 6) {
      const hash = tokens[i] ?? '';
      const shortHash = tokens[i + 1] || hash.slice(0, 7);
      const author = tokens[i + 2] ?? '';
      const authorEmail = tokens[i + 3] ?? '';
      const date = tokens[i + 4] ?? '';
      const subject = tokens[i + 5] ?? '';
      commits.push({
        hash,
        shortHash,
        subject,
        message: subject,
        author,
        authorEmail,
        date,
        relativeDate: relativeTime(date),
        branch,
      });
    }
    return commits;
  }

  async getCommitDetail(
    wsAbsPath: string,
    repoRelPath: string,
    hash: string,
    opts?: GitEnvOptions,
  ): Promise<CommitDetail> {
    const repoPath = resolveRepoPath(wsAbsPath, repoRelPath);
    await this.ensureRepo(repoPath, opts);
    const branch = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, opts)).stdout.trim();

    const { stdout: showRaw } = await this.run(
      ['show', '-s', '--no-patch', '--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00%B', hash],
      repoPath,
      opts,
    );
    const meta = showRaw.split('\0');
    const commitHash = (meta[0] ?? '').trim() || hash;
    const author = meta[1] ?? '';
    const authorEmail = meta[2] ?? '';
    const date = meta[3] ?? '';
    const subject = meta[4] ?? '';
    // `%B` — полное сообщение; git добавляет завершающий перевод строки.
    const message = (meta[5] ?? '').replace(/\n+$/, '') || subject;

    const { stdout: statRaw } = await this.run(
      ['show', '--numstat', '-z', '--format=', hash],
      repoPath,
      opts,
    );
    const files = parseNumstatZ(statRaw);

    const rawDiff = (
      await this.run(['show', hash, '--patch', '--format='], repoPath, opts)
    ).stdout;
    // Предел размера diff: мегабайты патча по проводу не уходят.
    const { diff: diff, truncated: diffTruncated } = truncateDiff(rawDiff, this._maxDiffBytes);

    return {
      hash: commitHash,
      shortHash: commitHash.slice(0, 7),
      subject,
      message,
      author,
      authorEmail,
      date,
      relativeDate: relativeTime(date),
      branch,
      files,
      diff: diff || '',
      ...(diffTruncated ? { diff_truncated: true } : {}),
    };
  }

  private async ensureRepo(repoPath: string, opts?: GitEnvOptions): Promise<void> {
    if (!(await this.isRepo(repoPath, opts))) {
      throw { error: 'Директория не является git-репозиторием', code: 'NOT_FOUND' };
    }
  }
}
