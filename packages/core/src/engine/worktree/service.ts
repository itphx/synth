/**
 * Сервис worktree'ов (ADR-114, этап 1 roadmap 0.13 — блок 1.4.1b).
 *
 * Сервис владеет **поведением** вокруг записи worktree:
 *
 * - создание вторичной рабочей копии (`git worktree add`) в корне
 *   `{workspacesRoot}/.worktrees/<projectId>/` (ADR-114 §1);
 * - lifecycle: список, удаление (с `force`), prune, sweep осиротевших записей;
 * - детект secondary worktree (`git rev-parse --git-common-dir`);
 * - startup-скрипт проекта (`project.worktreeSetupScript`) — один раз на запись.
 *
 * Границы модуля:
 *
 * - **исполнение git — только через порт** `ExecutionPort` (`git/exec.ts`,
 *   ADR-077): argv без shell, `requires: ['git']`; в remote-режиме команды
 *   уходят исполнителю;
 * - **инвентарь — только через порт** `WorktreeRepository` (ADR-096): сервис не
 *   пишет в `{dataDir}/worktrees.json` напрямую;
 * - сервис **не знает про транспорт**: обновление инвентаря сигнализируется
 *   вызывающему через `onUpdated(projectId, detail)` — публикацию события
 *   делает тот, кто знает про шину (ADR-024);
 * - сервис **не знает про сессии**: привязанная сессия приходит через хук
 *   `resolveAttachedSession(worktreeId)` — так `SessionManager` не тащится в
 *   сервис.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  WORKTREE_NAME_REGEX,
  isValidWorktreeBranch,
  isValidWorktreeRepoPath,
  type Project,
  type WorktreeCreateInput,
  type WorktreeRecord,
  type WorktreeSummary,
  type WorktreeUpdateAction,
} from '@itphx/synth-shared';
import { InlineExecutionPort } from '../../execution/inline-execution-port.js';
import { DEFAULT_MAX_OUTPUT_BYTES, type ExecutionPort } from '../../execution/ports/index.js';
import { gitExec } from '../../git/exec.js';
import type { WorktreeRepository } from '../../storage/ports/worktree-repository.js';
import { warning } from '../../logger.js';
import {
  WorktreeBranchInvalidError,
  WorktreeBusyError,
  WorktreeDirtyError,
  WorktreeGitFailedError,
  WorktreeNameInvalidError,
  WorktreeNotARepoError,
  WorktreeNotFoundError,
  WorktreePathExistsError,
} from './errors.js';

/** Каталог worktree'ов внутри корня workspace (ADR-114 §1). */
const WORKTREES_DIRNAME = '.worktrees';

/**
 * Сколько имён каталога перебирается при коллизии (`name`, `name-2`, …).
 *
 * Коллизия разрешается **детерминированно** (суффикс `-2`, `-3`, …): поведение
 * воспроизводимо и не зависит от порядка каталогов в ФС.
 */
const MAX_NAME_ATTEMPTS = 20;

/** Предельная длина имени каталога worktree (совпадает с контрактом shared). */
const MAX_NAME_LENGTH = 64;

/** Таймаут git-команд сервиса, мс (страховка от зависшего git). */
const GIT_TIMEOUT_MS = 120_000;

/** Таймаут startup-скрипта проекта, мс (ADR-114 §7.6). */
const SETUP_SCRIPT_TIMEOUT_MS = 5 * 60_000;

/** Префикс ветки по умолчанию (ветка не задана — создаётся своя). */
const DEFAULT_BRANCH_PREFIX = 'worktree/';

/** Имя каталога по умолчанию, когда не заданы ни имя, ни ветка. */
const DEFAULT_NAME_PREFIX = 'wt-';

/** Опции сервиса worktree'ов. */
export interface WorktreeServiceOptions {
  /** Порт инвентаря worktree'ов (ADR-096) — единственный способ записи и чтения. */
  repository: WorktreeRepository;  /** Корень workspace инстанса; worktree'ы лежат в `<root>/.worktrees/<projectId>`. */
  workspacesRoot: string;
  /** Порт исполнения команд (ADR-077); не задан — inline (локально). */
  execution?: ExecutionPort;
  /** Рабочий каталог по умолчанию — fallback, когда у проекта нет workspace. */
  defaultWorkingDir?: string;
  /** Id сессии, привязанной к worktree (если есть); ошибка хука — «привязки нет». */
  resolveAttachedSession?: (worktreeId: string) => Promise<string | undefined>;
  /**
   * Сигнал «инвентарь проекта изменился» (вызывающий публикует событие).
   *
   * Второй аргумент — **что** изменилось (ADR-114 §6): действие и, когда
   * известно, id записи. Обратная совместимость: реализация с одним
   * параметром остаётся валидной (TypeScript допускает меньше параметров).
   */
  onUpdated?: (projectId: string, detail: WorktreeUpdateDetail) => void;
}

/**
 * Детали изменения инвентаря worktree'ов — для события `worktree.updated`
 * (ADR-114 §6).
 */
export interface WorktreeUpdateDetail {
  /** Id изменившейся записи (не задан — изменение по проекту целиком). */
  worktreeId?: string;
  /** Что произошло. */
  action: WorktreeUpdateAction;
}

/** Итог выполнения startup-скрипта проекта. */
export interface WorktreeSetupResult {
  /** Скрипт завершился успешно. */
  ok: boolean;
  /** Код завершения скрипта (если он отработал). */
  exitCode?: number;
  /** Текст ошибки (если скрипт упал). */
  error?: string;
}

/** Итог создания worktree. */
export interface WorktreeCreateResult {
  /** Сохранённая запись worktree. */
  worktree: WorktreeRecord;
  /** Итог startup-скрипта (только если скрипт у проекта задан). */
  setup?: WorktreeSetupResult;
}

/** Опции удаления worktree. */
export interface WorktreeRemoveOptions {
  /** Удалить и грязный worktree (ADR-114 §7.2): без `force` — `WORKTREE_DIRTY`. */
  force?: boolean;
}

/** Итог prune проекта. */
export interface WorktreePruneResult {
  /** Сколько записей удалено (записи без каталога). */
  recordsRemoved: number;
  /** Выполнен ли `git worktree prune` в репозитории. */
  gitPruned: boolean;
}

/** Итог sweep'а осиротевших записей (на старте процесса). */
export interface WorktreeSweepResult {
  /** Сколько записей удалено. */
  recordsRemoved: number;
}

/** Результат детекта secondary worktree (ADR-114 §6). */
export interface WorktreeSecondaryInfo {
  /** Каталог — вторичная рабочая копия (общий `.git` с основной). */
  isSecondary: boolean;
  /** Верхний уровень рабочей копии (`git rev-parse --show-toplevel`). */
  toplevel?: string;
  /** Общий каталог git (`git rev-parse --git-common-dir`). */
  commonDir?: string;
}

/**
 * Сервис worktree'ов: git-операции, lifecycle инвентаря, детект secondary.
 */
export class WorktreeService {
  private readonly _repository: WorktreeRepository;
  private readonly _workspacesRoot: string;
  private readonly _execution: ExecutionPort | undefined;
  private readonly _defaultWorkingDir: string | undefined;
  private readonly _resolveAttachedSession:
    | ((worktreeId: string) => Promise<string | undefined>)
    | undefined;
  private readonly _onUpdated: ((projectId: string, detail: WorktreeUpdateDetail) => void) | undefined;

  constructor(options: WorktreeServiceOptions) {
    this._repository = options.repository;
    this._workspacesRoot = options.workspacesRoot;
    this._execution = options.execution;
    this._defaultWorkingDir = options.defaultWorkingDir;
    this._resolveAttachedSession = options.resolveAttachedSession;
    this._onUpdated = options.onUpdated;
  }

  /**
   * Корень worktree'ов проекта: `{workspacesRoot}/.worktrees/<projectId>`.
   *
   * Каталог внутри корня workspace — иначе каталог сессии вышел бы за
   * containment исполнителя (ADR-077) и за политику workspace (ADR-075).
   */
  rootFor(projectId: string): string {
    return join(this._workspacesRoot, WORKTREES_DIRNAME, projectId);
  }

  /**
   * Список worktree'ов проекта с вычисленными полями: `exists`, `dirty`,
   * `attachedSessionId`.
   *
   * Недоступный каталог **не** роняет список: запись без каталога показывается
   * как `exists: false` (её чистит `prune`/sweep), а «грязное» состояние
   * неизвестного каталога — `dirty: false` (нет данных — нет утверждения).
   *
   * Второй параметр (`project`) оставлен для симметрии с `create`/`remove`:
   * самому списку он не требуется.
   */
  async list(projectId: string, _project?: Project): Promise<WorktreeSummary[]> {
    const records = await this._repository.list({ projectId });
    const summaries: WorktreeSummary[] = [];
    for (const record of records) {
      const exists = await directoryExists(record.directory);
      const dirty = exists ? await this._isDirty(record.directory) : false;
      const attachedSessionId = await this._attachedSession(record.id);
      summaries.push({
        ...record,
        exists,
        dirty,
        ...(attachedSessionId ? { attachedSessionId } : {}),
      });
    }
    return summaries;
  }

  /**
   * Создание worktree: `git worktree add` + запись в инвентаре + startup-скрипт.
   *
   * Порядок: валидация входа → проверка репозитория → выбор имени/каталога →
   * `git worktree add` → запись → `onUpdated` → startup-скрипт.
   *
   * Ошибка git **не** оставляет записи в инвентаре (запись создаётся только
   * после успешного `git worktree add`).
   */
  async create(
    projectId: string,
    project: Project,
    input: WorktreeCreateInput = {},
    actor?: string,
  ): Promise<WorktreeCreateResult> {
    const branch = input.branch;
    if (branch !== undefined && !isValidWorktreeBranch(branch)) {
      throw new WorktreeBranchInvalidError(branch);
    }
    const repoPath = input.repoPath;
    if (repoPath !== undefined && !isValidWorktreeRepoPath(repoPath)) {
      throw new WorktreeNotARepoError(
        repoPath,
        `Недопустимый путь репозитория: ${repoPath} (ожидается относительный путь без «..»)`,
      );
    }

    const requestedName = resolveWorktreeName(input.name, branch);
    const repoRoot = this._resolveRepoRoot(project, repoPath);
    await this._assertRepo(repoRoot, repoPath);

    const target = await this._resolveDirectory(projectId, requestedName);
    // Ветка по умолчанию следует за **итоговым** именем каталога: при коллизии
    // (`name` → `name-2`) две записи не получили бы одну и ту же ветку.
    const effectiveBranch = branch ?? `${DEFAULT_BRANCH_PREFIX}${target.name}`;
    await mkdir(this.rootFor(projectId), { recursive: true });

    const args = await this._buildAddArgs(repoRoot, target.directory, effectiveBranch, input.from);
    try {
      await this._git(args, repoRoot);
    } catch (err) {
      // Ошибка git — fallback с её текстом; запись в инвентаре не создаётся.
      throw new WorktreeGitFailedError(
        `git worktree add завершился ошибкой: ${errorText(err)}`,
        errorText(err),
      );
    }

    const now = new Date().toISOString();
    const record: WorktreeRecord = {
      id: `wkt_${randomUUID()}`,
      projectId,
      ...(repoPath !== undefined ? { repoPath } : {}),
      directory: target.directory,
      branch: effectiveBranch,
      name: target.name,
      strategy: 'git',
      createdAt: now,
      updatedAt: now,
      ...(actor !== undefined ? { createdBy: actor } : {}),
    };
    await this._repository.save(record);
    this._onUpdated?.(projectId, { worktreeId: record.id, action: 'created' });

    const script = project.worktreeSetupScript?.trim();
    if (!script) return { worktree: record };

    // Сбой скрипта worktree НЕ откатывает: запись остаётся, ошибка уходит в
    // результат операции (ADR-114 §7.6).
    const setup = await this._runSetupScript(script, projectId, target.directory);
    return { worktree: record, setup };
  }

  /**
   * Удаление worktree: проверка привязки сессии → проверка «грязности» →
   * `git worktree remove` → `git worktree prune` → удаление записи.
   *
   * Привязанная сессия — `WORKTREE_BUSY` (даже с `force`: привязку снимает
   * сессия, а не удаление). Незакоммиченные изменения без `force` —
   * `WORKTREE_DIRTY` (`forceRequired: true`).
   */
  async remove(
    projectId: string,
    id: string,
    project: Project,
    opts: WorktreeRemoveOptions = {},
  ): Promise<WorktreeRecord> {
    const record = await this._repository.get(id);
    if (!record || record.projectId !== projectId) throw new WorktreeNotFoundError(id);

    const sessionId = await this._attachedSession(record.id);
    if (sessionId) throw new WorktreeBusyError(record.id, sessionId);

    const repoRoot = this._tryRepoRoot(project, record.repoPath);
    if (await directoryExists(record.directory)) {
      if (!repoRoot) {
        throw new WorktreeNotARepoError(
          record.repoPath ?? '',
          'У проекта не задан рабочий каталог — worktree удалить негде',
        );
      }
      const dirty = await this._isDirty(record.directory);
      if (dirty && !opts.force) throw new WorktreeDirtyError(record.id, record.directory);
      const args = ['worktree', 'remove', record.directory];
      if (opts.force) args.push('--force');
      try {
        await this._git(args, repoRoot);
      } catch (err) {
        throw new WorktreeGitFailedError(
          `git worktree remove завершился ошибкой: ${errorText(err)}`,
          errorText(err),
        );
      }
    }

    // Метаданные worktree в общем `.git` — чистим (каталога уже нет).
    if (repoRoot) await this._git(['worktree', 'prune'], repoRoot).catch(() => undefined);

    await this._repository.delete(record.id);
    this._onUpdated?.(projectId, { worktreeId: record.id, action: 'removed' });
    return record;
  }

  /**
   * Prune проекта: удаляет **только записи без каталога** и чистит метаданные
   * git (`git worktree prune`).
   *
   * Каталоги без записей **не трогаются**: worktree, созданный вручную внутри
   * `.worktrees/<projectId>/`, — собственность пользователя.
   */
  async prune(projectId: string, project: Project): Promise<WorktreePruneResult> {
    const records = await this._repository.list({ projectId });
    let recordsRemoved = 0;
    for (const record of records) {
      if (await directoryExists(record.directory)) continue;
      await this._repository.delete(record.id);
      recordsRemoved += 1;
    }

    let gitPruned = false;
    try {
      const repoRoot = this._resolveRepoRoot(project);
      await this._git(['worktree', 'prune'], repoRoot);
      gitPruned = true;
    } catch {
      // Репозитория нет/недоступен — prune записей уже выполнен; «gitPruned»
      // остаётся false (причина — в логе вызывающего).
      gitPruned = false;
    }

    if (recordsRemoved > 0) this._onUpdated?.(projectId, { action: 'pruned' });
    return { recordsRemoved, gitPruned };
  }

  /**
   * Sweep осиротевших записей (на старте процесса, ADR-114 §7.4).
   *
   * Удаляются **только записи без каталога**; живые записи не трогаются,
   * каталоги не удаляются, `git worktree prune` здесь **не** выполняется
   * (чистку метаданных делает prune проекта).
   */
  async sweepOrphans(): Promise<WorktreeSweepResult> {
    const records = await this._repository.list();
    let recordsRemoved = 0;
    const touched = new Set<string>();
    for (const record of records) {
      if (await directoryExists(record.directory)) continue;
      await this._repository.delete(record.id);
      recordsRemoved += 1;
      touched.add(record.projectId);
    }
    for (const projectId of touched) this._onUpdated?.(projectId, { action: 'pruned' });
    return { recordsRemoved };
  }

  /**
   * Детект secondary worktree (ADR-114 §6).
   *
   * В основной рабочей копии `--git-common-dir` совпадает с `--git-dir`
   * (`.git`); во вторичной — общий `.git` основного репозитория против
   * `.git/worktrees/<name>` самой копии. Ошибка git (каталог не репозиторий) —
   * `{ isSecondary: false }`: ход сессии не ломается.
   */
  async detectSecondary(directory: string): Promise<WorktreeSecondaryInfo> {
    try {
      const commonDir = (await this._git(['rev-parse', '--git-common-dir'], directory)).stdout.trim();
      const gitDir = (await this._git(['rev-parse', '--git-dir'], directory)).stdout.trim();
      const toplevel = (await this._git(['rev-parse', '--show-toplevel'], directory)).stdout.trim();
      const isSecondary = resolve(directory, commonDir) !== resolve(directory, gitDir);
      return {
        isSecondary,
        ...(toplevel ? { toplevel } : {}),
        ...(commonDir ? { commonDir } : {}),
      };
    } catch {
      return { isSecondary: false };
    }
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  /** Git-команда через порт исполнения (ADR-077). */
  private _git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return gitExec(args, { execution: this._execution, cwd, timeoutMs: GIT_TIMEOUT_MS });
  }

  /** Есть ли незакоммиченные изменения в каталоге worktree. */
  private async _isDirty(directory: string): Promise<boolean> {
    try {
      const { stdout } = await this._git(['status', '--porcelain'], directory);
      return stdout.trim().length > 0;
    } catch {
      // Каталог недоступен/не репозиторий — «грязного» состояния не утверждаем.
      return false;
    }
  }

  /** Id привязанной сессии (если есть); ошибка хука — «привязки нет». */
  private async _attachedSession(worktreeId: string): Promise<string | undefined> {
    if (!this._resolveAttachedSession) return undefined;
    try {
      return await this._resolveAttachedSession(worktreeId);
    } catch {
      return undefined;
    }
  }

  /**
   * Корень репозитория проекта: `project.workspace` (или `defaultWorkingDir`),
   * плюс `repoPath` относительно него.
   */
  private _resolveRepoRoot(project: Project, repoPath?: string): string {
    const base = project.workspace ?? this._defaultWorkingDir;
    if (!base) {
      throw new WorktreeNotARepoError(
        repoPath ?? '',
        'У проекта не задан рабочий каталог — worktree создать негде',
      );
    }
    const root = resolve(base);
    if (!repoPath) return root;
    const abs = resolve(root, repoPath);
    const rel = relative(root, abs);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorktreeNotARepoError(
        repoPath,
        `Путь репозитория выходит за пределы рабочего каталога проекта: ${repoPath}`,
      );
    }
    return abs;
  }

  /**
   * Корень репозитория или `undefined`, если рабочего каталога нет.
   *
   * Мягкий вариант `_resolveRepoRoot`: нужен там, где отсутствие корня не
   * повод отказать (чистка метаданных git после удаления каталога).
   */
  private _tryRepoRoot(project: Project, repoPath?: string): string | undefined {
    try {
      return this._resolveRepoRoot(project, repoPath);
    } catch {
      return undefined;
    }
  }

  /** Каталог должен быть git-репозиторием — иначе `WORKTREE_NOT_A_REPO`. */
  private async _assertRepo(repoRoot: string, repoPath?: string): Promise<void> {
    try {
      await this._git(['rev-parse', '--git-dir'], repoRoot);
    } catch (err) {
      throw new WorktreeNotARepoError(
        repoPath ?? repoRoot,
        `Каталог не является git-репозиторием: ${repoRoot} (${errorText(err)})`,
      );
    }
  }

  /**
   * Свободное имя каталога и сам каталог.
   *
   * Коллизия (запись с таким именем или каталог на диске) — детерминированный
   * суффикс `-2`, `-3`, … (до 20 попыток); дальше — `WORKTREE_PATH_EXISTS`.
   */
  private async _resolveDirectory(
    projectId: string,
    name: string,
  ): Promise<{ name: string; directory: string }> {
    const root = this.rootFor(projectId);
    const records = await this._repository.list({ projectId });
    const taken = new Set(records.map((record) => record.name));
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      // Суффикс входит в предел длины имени (64 символа).
      const candidate = suffix ? `${truncateName(name, suffix.length)}${suffix}` : name;
      const directory = join(root, candidate);
      if (!taken.has(candidate) && !(await directoryExists(directory))) {
        return { name: candidate, directory };
      }
    }
    throw new WorktreePathExistsError(name, join(root, name));
  }

  /**
   * Команда `git worktree add`.
   *
   * Выбор формы (ADR-114 §7.2):
   *
   * - задана база `from` и она существует → **новая** ветка от неё:
   *   `git worktree add <dir> -b <branch> <from>`;
   * - база задана, но её нет → `WORKTREE_GIT_FAILED` (fail-closed: молча брать
   *   HEAD вместо запрошенной базы нельзя — ветка уехала бы не туда);
   * - база не задана, а ветка уже существует → **существующая** ветка:
   *   `git worktree add <dir> <branch>`;
   * - иначе → новая ветка от текущего HEAD: `git worktree add <dir> -b <branch>`.
   */
  private async _buildAddArgs(
    repoRoot: string,
    directory: string,
    branch: string,
    from?: string,
  ): Promise<string[]> {
    const base = from?.trim();
    if (base) {
      if (!(await this._refExists(repoRoot, base))) {
        throw new WorktreeGitFailedError(
          `База ветки не найдена в репозитории: ${base}`,
          `invalid reference: ${base}`,
        );
      }
      return ['worktree', 'add', directory, '-b', branch, base];
    }
    if (await this._refExists(repoRoot, `refs/heads/${branch}`)) {
      return ['worktree', 'add', directory, branch];
    }
    return ['worktree', 'add', directory, '-b', branch];
  }

  /** Существует ли ref в репозитории (`git rev-parse --verify`). */
  private async _refExists(repoRoot: string, ref: string): Promise<boolean> {
    try {
      await this._git(['rev-parse', '--verify', '--quiet', ref], repoRoot);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Startup-скрипт проекта (ADR-114 §7.6): один раз на запись, через порт
   * исполнения (в remote-режиме — на исполнителе).
   *
   * Окружение: `SYNTH_WORKTREE_BASE` — корень worktree'ов проекта,
   * `SYNTH_WORKTREE_PATH` — каталог нового worktree. Рабочий каталог — сам
   * worktree. Таймаут — 5 минут.
   */
  private async _runSetupScript(
    command: string,
    projectId: string,
    directory: string,
  ): Promise<WorktreeSetupResult> {
    const execution = this._execution ?? new InlineExecutionPort();
    try {
      const result = await execution.execute({
        command: { kind: 'shell', command },
        cwd: directory,
        env: {
          SYNTH_WORKTREE_BASE: this.rootFor(projectId),
          SYNTH_WORKTREE_PATH: directory,
        },
        timeoutMs: SETUP_SCRIPT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });
      return { ok: result.exitCode === 0, exitCode: result.exitCode };
    } catch (err) {
      warning('WORKTREE', `Стартовый скрипт worktree завершился ошибкой: ${errorText(err)}`);
      // Порт исполнения сообщает неуспех **ошибкой** (`ExecutionError.code` —
      // код завершения), а не полем результата: код достаём оттуда.
      const code = (err as { code?: unknown }).code;
      const exitCode = typeof code === 'number' ? code : undefined;
      return {
        ok: false,
        ...(exitCode !== undefined ? { exitCode } : {}),
        error: errorText(err),
      };
    }
  }
}

/**
 * Имя каталога worktree: заданное имя (проверяется) либо выведенное из ветки,
 * либо `wt-<8 hex>` (когда не заданы ни имя, ни ветка).
 */
export function resolveWorktreeName(name?: string, branch?: string): string {
  if (name !== undefined) {
    if (!WORKTREE_NAME_REGEX.test(name)) throw new WorktreeNameInvalidError(name);
    return name;
  }
  if (branch) {
    const derived = slugifyBranch(branch);
    if (derived && WORKTREE_NAME_REGEX.test(derived)) return derived;
  }
  return `${DEFAULT_NAME_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

/** Имя ветки → slug имени каталога (`feature/x` → `feature-x`). */
function slugifyBranch(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, MAX_NAME_LENGTH);
}

/** Обрезка имени с учётом суффикса (предел — 64 символа). */
function truncateName(name: string, extra: number): string {
  const limit = MAX_NAME_LENGTH - extra;
  if (name.length <= limit) return name;
  return name.slice(0, Math.max(1, limit));
}

/** Есть ли каталог на диске. */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** Текст ошибки (stderr/сообщение команды) — коротко и без стектрейсов. */
function errorText(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === 'string' && e.stderr.trim().length > 0) return e.stderr.trim();
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
  }
  return String(err);
}
