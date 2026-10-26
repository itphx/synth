/**
 * Контракт «git worktree» — per-session рабочий каталог (ADR-114, этап 1
 * roadmap 0.13 — блок 1.4.1a; спека подсистемы — `docs/WORKTREES.md` §1–§2).
 *
 * Worktree — вторичная рабочая копия репозитория: у каждой сессии может быть
 * свой каталог, чтобы правки соседних сессий не конфликтовали по рабочим
 * файлам и индексу (ADR-114).
 *
 * Здесь только контракты (тип записи + Zod-схемы HTTP-входа) — без
 * бизнес-логики: создание каталога (`git worktree add`), привязка сессии и
 * резолв рабочего каталога живут в core (следующий шаг).
 */
import { z } from 'zod';

/**
 * Стратегия записи worktree. Сейчас одна — `git` (ADR-114 §5: тулы
 * `git_worktree_*` работают через слой git, ADR-076/ADR-077).
 */
export type WorktreeStrategy = 'git';

/** Канонический набор стратегий worktree. */
export const WORKTREE_STRATEGIES: readonly WorktreeStrategy[] = ['git'];

/**
 * Запись worktree (`wkt_<uuid>`) — запись инвентаря проекта (ADR-114 §1.1).
 *
 * Запись переживает рестарт сервиса: её держит доменный порт
 * `WorktreeRepository` (ADR-096), физически — `{dataDir}/worktrees.json`
 * (файловый backend) либо generic-таблица `documents` (`kind='worktree'`,
 * PostgreSQL-драйвер).
 */
export interface WorktreeRecord {
  /** `wkt_<uuid>`, уникален в пределах инстанса. */
  id: string;
  /** Проект-владелец записи (обязателен). */
  projectId: string;
  /**
   * Репозиторий проекта относительно `project.workspace` (как `repo_path`
   * в ADR-076); отсутствует — репозиторий в корне workspace.
   */
  repoPath?: string;
  /** Абсолютный путь каталога worktree на диске. */
  directory: string;
  /** Ветка (`HEAD` — detached-состояние). */
  branch: string;
  /**
   * Человекочитаемое имя каталога (slug) внутри `.worktrees/<projectId>/`:
   * уникально в пределах проекта, формат — `WORKTREE_NAME_REGEX`.
   */
  name: string;
  /** Стратегия записи (сейчас только `git`). */
  strategy: WorktreeStrategy;
  /** Момент создания записи (ISO-8601) — иммутабельно. */
  createdAt: string;
  /** Момент последнего изменения (ISO-8601) — ставит вызывающий (порт «сейчас» не подставляет). */
  updatedAt: string;
  /** Пользователь, создавший запись (аудит, не авторизация). */
  createdBy?: string;
}

/**
 * Тело создания worktree (HTTP-вход).
 *
 * Все поля необязательные: сервис подставляет дефолты (имя каталога из
 * ветки, ветку — из базовой ветки репозитория). `from` — база ветки при
 * создании (`main`/`master`/SHA).
 */
export interface WorktreeCreateInput {
  /** Ветка worktree. */
  branch?: string;
  /** Человекочитаемое имя каталога (slug). */
  name?: string;
  /** Репозиторий относительно `project.workspace` (пусто/нет — корень workspace). */
  repoPath?: string;
  /** База ветки при создании (`main`/`master`/SHA). */
  from?: string;
}

/**
 * Сводка записи для API: сама запись + вычисляемые сервисом поля.
 *
 * Вычисляемые поля **в порт не пишутся** — их считает сервис (наличие
 * каталога на диске, «грязное» состояние, привязанная сессия).
 */
export interface WorktreeSummary extends WorktreeRecord {
  /** Сессия, привязанная к worktree (если есть). */
  attachedSessionId?: string;
  /** Есть ли незакоммиченные изменения в каталоге. */
  dirty?: boolean;
  /** Существует ли каталог worktree на диске. */
  exists?: boolean;
}

/**
 * Привязка сессии к worktree (ADR-114 §1.3) — **снимок** на момент привязки:
 * `directory`/`branch` копируются из записи, чтобы резолв рабочего каталога не
 * требовал чтения порта на каждом ходу.
 */
export interface SessionWorktree {
  /** Идентификатор записи worktree. */
  worktreeId: string;
  /** Проект-владелец worktree. */
  projectId: string;
  /** Репозиторий относительно `project.workspace` (если не корень workspace). */
  repoPath?: string;
  /** Абсолютный путь каталога worktree. */
  directory: string;
  /** Ветка на момент привязки. */
  branch: string;
}

// ── Zod-схемы (HTTP-вход и запись) ─────────────────────────────────────────────

/** Формат slug'а имени каталога worktree: строчные буквы/цифры, `-_.` внутри. */
export const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Предельная длина имени каталога worktree. */
export const WORKTREE_NAME_MAX_LENGTH = 64;

/** Символы, запрещённые в имени ветки (набор — как в `git check-ref-format`). */
const FORBIDDEN_BRANCH_CHARS: readonly string[] = ['~', '^', ':', '?', '*', '[', '\\'];

/**
 * Допустимо ли имя ветки: непустое, без пробелов, без `..` и без
 * запрещённых символов (`~`, `^`, `:`, `?`, `*`, `[`, `\`).
 */
export function isValidWorktreeBranch(branch: string): boolean {
  if (branch.length === 0) return false;
  if (/\s/.test(branch)) return false;
  if (branch.includes('..')) return false;
  return !FORBIDDEN_BRANCH_CHARS.some((char) => branch.includes(char));
}

/**
 * Допустим ли путь репозитория: относительный (без корня и без диска
 * Windows) и без сегмента `..` — как `repo_path` в ADR-076.
 */
export function isValidWorktreeRepoPath(repoPath: string): boolean {
  if (repoPath.trim().length === 0) return false;
  if (repoPath.startsWith('/') || repoPath.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(repoPath)) return false;
  return !repoPath.split(/[\\/]+/).includes('..');
}

/** Полная запись worktree (ответы API). */
export const worktreeRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  repoPath: z.string().min(1).optional(),
  directory: z.string().min(1),
  branch: z.string().min(1),
  name: z.string().regex(WORKTREE_NAME_REGEX),
  strategy: z.enum(['git']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: z.string().min(1).optional(),
});

/**
 * Тело создания worktree (`POST /api/v2/projects/:id/worktrees`).
 *
 * Валидация: `name` — slug (`WORKTREE_NAME_REGEX`), `branch` — без пробелов,
 * `..` и запрещённых символов, `repoPath` — относительный путь без `..`.
 */
export const worktreeCreateSchema = z.object({
  branch: z
    .string()
    .min(1)
    .refine(isValidWorktreeBranch, {
      message: 'Имя ветки недопустимо: без пробелов, «..», «~», «^», «:», «?», «*», «[», «\\»',
    })
    .optional(),
  name: z.string().regex(WORKTREE_NAME_REGEX).optional(),
  repoPath: z
    .string()
    .min(1)
    .refine(isValidWorktreeRepoPath, {
      message: 'Путь репозитория должен быть относительным и без «..»',
    })
    .optional(),
  from: z.string().min(1).optional(),
});

/**
 * Тело операции prune (`POST /api/v2/projects/:id/worktrees/prune`).
 *
 * Параметров у операции нет: проект берётся из пути, чистятся записи без
 * каталога (ADR-114 §7.3). Схема — строгая: лишние поля — ошибка валидации,
 * а не молчаливое игнорирование.
 */
export const worktreePruneSchema = z.object({}).strict();

/** Форма входа тела создания worktree. */
export type WorktreeCreateRequest = z.input<typeof worktreeCreateSchema>;
/** Форма входа тела prune. */
export type WorktreePruneRequest = z.input<typeof worktreePruneSchema>;
