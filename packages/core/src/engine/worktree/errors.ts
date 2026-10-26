/**
 * Типизированные ошибки подсистемы «git worktree» (ADR-114, этап 1 roadmap
 * 0.13 — блок 1.4.1b).
 *
 * Образец — `RepoPathError` в `engine/tools/git.ts` (ADR-076): ошибка несёт
 * **машинный код** и машинночитаемые поля, а текст — по-русски (для логов и
 * UI). Коды нужны HTTP-контуру (400/404/409) и будущим тулам/событиям; сами
 * тексты движка появятся на своём i18n-слое (ADR-041), поэтому ошибка отдаёт
 * код, а не готовую строку для модели.
 */

/**
 * Канонический набор машинных кодов ошибок подсистемы worktree.
 *
 * Набор **закрытый**: коды переиспользуются HTTP-контуром, тулами и UI, поэтому
 * новый код добавляется сюда (и в `WORKTREE_ERROR_CODES`), а не вводится
 * «на месте» строкой.
 */
export const WORKTREE_ERROR_CODES = [
  /** Записи worktree нет (или она чужого проекта). */
  'WORKTREE_NOT_FOUND',
  /** К записи привязана живая сессия — удалять нельзя. */
  'WORKTREE_BUSY',
  /** В каталоге есть незакоммиченные изменения — нужен явный `force`. */
  'WORKTREE_DIRTY',
  /** Имя ветки недопустимо (`git check-ref-format`-совместимо). */
  'WORKTREE_BRANCH_INVALID',
  /** Имя каталога worktree недопустимо (не slug). */
  'WORKTREE_NAME_INVALID',
  /** Указанный путь не является git-репозиторием (или путь недопустим). */
  'WORKTREE_NOT_A_REPO',
  /** Каталог/имя занято — свободного имени не нашлось. */
  'WORKTREE_PATH_EXISTS',
  /** Каталог привязанного worktree исчез — резолв cwd fail-closed (ADR-114 §3.2). */
  'WORKTREE_DIRECTORY_MISSING',
  /** Команда git завершилась ошибкой (fallback с текстом git). */
  'WORKTREE_GIT_FAILED',
] as const;

/** Код ошибки подсистемы worktree. */
export type WorktreeErrorCode = (typeof WORKTREE_ERROR_CODES)[number];

/**
 * HTTP-статус по коду ошибки.
 *
 * - `404` — ресурса нет;
 * - `409` — конфликт состояния (занят каталог/ветка, запись занята сессией,
 *   есть несохранённые изменения);
 * - `400` — некорректный ввод (имя/ветка/путь репозитория).
 *
 * Единая карта — чтобы HTTP-контур не разводил код и статус по разным местам.
 */
const HTTP_STATUS_BY_CODE: Record<WorktreeErrorCode, 400 | 404 | 409> = {
  WORKTREE_NOT_FOUND: 404,
  WORKTREE_BUSY: 409,
  WORKTREE_DIRTY: 409,
  WORKTREE_BRANCH_INVALID: 400,
  WORKTREE_NAME_INVALID: 400,
  WORKTREE_NOT_A_REPO: 400,
  WORKTREE_PATH_EXISTS: 409,
  WORKTREE_DIRECTORY_MISSING: 409,
  WORKTREE_GIT_FAILED: 409,
};

/** HTTP-статус ответа для кода ошибки worktree. */
export function worktreeErrorHttpStatus(code: WorktreeErrorCode): 400 | 404 | 409 {
  return HTTP_STATUS_BY_CODE[code];
}

/**
 * База ошибок подсистемы worktree: машинный код + текст (для логов/UI).
 */
export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

/** Записи worktree нет (или она принадлежит другому проекту). */
export class WorktreeNotFoundError extends WorktreeError {
  readonly worktreeId: string;

  constructor(worktreeId: string) {
    super('WORKTREE_NOT_FOUND', `Worktree ${worktreeId} не найден`);
    this.name = 'WorktreeNotFoundError';
    this.worktreeId = worktreeId;
  }
}

/**
 * К записи привязана живая сессия: удаление worktree сломало бы её рабочий
 * каталог (ADR-114 §7.2) — сначала отвязать сессию.
 */
export class WorktreeBusyError extends WorktreeError {
  readonly worktreeId: string;
  /** Id привязанной сессии (если удалось определить). */
  readonly sessionId?: string;

  constructor(worktreeId: string, sessionId?: string) {
    super(
      'WORKTREE_BUSY',
      sessionId
        ? `Worktree ${worktreeId} занят сессией ${sessionId}`
        : `Worktree ${worktreeId} занят сессией`,
    );
    this.name = 'WorktreeBusyError';
    this.worktreeId = worktreeId;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

/**
 * В каталоге worktree есть незакоммиченные изменения: удаление требует
 * явного `force` (ADR-114 §7.2 — «каталог worktree — зона выката»).
 */
export class WorktreeDirtyError extends WorktreeError {
  readonly worktreeId: string;
  /** Признак «нужен явный force» — HTTP-контур отдаёт `409 FORCE_REQUIRED`. */
  readonly forceRequired = true as const;

  constructor(worktreeId: string, directory: string) {
    super(
      'WORKTREE_DIRTY',
      `В worktree ${worktreeId} есть незакоммиченные изменения (${directory}) — требуется force`,
    );
    this.name = 'WorktreeDirtyError';
    this.worktreeId = worktreeId;
  }
}

/** Имя ветки недопустимо. */
export class WorktreeBranchInvalidError extends WorktreeError {
  readonly branch: string;

  constructor(branch: string) {
    super('WORKTREE_BRANCH_INVALID', `Недопустимое имя ветки: ${branch}`);
    this.name = 'WorktreeBranchInvalidError';
    this.branch = branch;
  }
}

/** Имя каталога worktree недопустимо (не slug). */
export class WorktreeNameInvalidError extends WorktreeError {
  /** Имя каталога, которое отвергли (поле `name` занято кодом класса ошибки). */
  readonly worktreeName: string;

  constructor(worktreeName: string) {
    super('WORKTREE_NAME_INVALID', `Недопустимое имя worktree: ${worktreeName}`);
    this.name = 'WorktreeNameInvalidError';
    this.worktreeName = worktreeName;
  }
}

/**
 * Указанный путь не является git-репозиторием — либо каталога нет, либо это
 * не репозиторий, либо сам путь недопустим (абсолютный/`..`).
 */
export class WorktreeNotARepoError extends WorktreeError {
  readonly repoPath: string;

  constructor(repoPath: string, message?: string) {
    super('WORKTREE_NOT_A_REPO', message ?? `Путь не является git-репозиторием: ${repoPath}`);
    this.name = 'WorktreeNotARepoError';
    this.repoPath = repoPath;
  }
}

/** Свободного имени каталога не нашлось (каталог/запись заняты). */
export class WorktreePathExistsError extends WorktreeError {
  /** Занятое имя каталога (поле `name` занято кодом класса ошибки). */
  readonly worktreeName: string;
  readonly directory: string;

  constructor(worktreeName: string, directory: string) {
    super('WORKTREE_PATH_EXISTS', `Каталог worktree занят: ${directory}`);
    this.name = 'WorktreePathExistsError';
    this.worktreeName = worktreeName;
    this.directory = directory;
  }
}

/**
 * Каталог привязанного worktree исчез с диска — резолв рабочего каталога
 * сессии **fail-closed** (ADR-114 §3.2): ход не стартует, тихий фоллбек в
 * `project.workspace` запрещён (он перенёс бы правки сессии в чужое дерево).
 *
 * Текст для модели — по i18n-ключу `worktree.directory_missing` (ADR-041);
 * класс несёт машинный код и путь каталога.
 */
export class WorktreeDirectoryMissingError extends WorktreeError {
  /** Каталог привязки, которого нет на диске. */
  readonly directory: string;
  /** Id записи worktree (для журнала/UI). */
  readonly worktreeId?: string;

  constructor(directory: string, worktreeId?: string) {
    super('WORKTREE_DIRECTORY_MISSING', `Каталог worktree не найден: ${directory}`);
    this.name = 'WorktreeDirectoryMissingError';
    this.directory = directory;
    if (worktreeId !== undefined) this.worktreeId = worktreeId;
  }
}

/**
 * Команда git завершилась ошибкой — fallback с текстом git (ADR-114 §7.2:
 * ошибка git не превращается в тихий успех).
 */
export class WorktreeGitFailedError extends WorktreeError {
  /** Текст git (stderr/сообщение команды) — для разбора вызывающим. */
  readonly gitOutput?: string;

  constructor(message: string, gitOutput?: string) {
    super('WORKTREE_GIT_FAILED', message);
    this.name = 'WorktreeGitFailedError';
    if (gitOutput !== undefined) this.gitOutput = gitOutput;
  }
}

/**
 * Структурная проверка ошибки worktree.
 *
 * `instanceof` здесь ненадёжен: модуль может быть загружен из двух копий
 * (`src` и `dist`), и тогда объекты класса различаются (та же причина, по
 * которой `isExecutionError` в порту исполнения проверяет `name`).
 */
export function isWorktreeError(value: unknown): value is WorktreeError {
  if (value instanceof WorktreeError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; code?: unknown; message?: unknown };
  return (
    e.name === 'WorktreeError' &&
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    (WORKTREE_ERROR_CODES as readonly string[]).includes(e.code)
  );
}
