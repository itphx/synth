/**
 * Runtime-зависимости встроенных инструментов от внешних программ окружения.
 *
 * Часть встроенных тулов работает только через внешние бинарники (`git`, `rg`,
 * `sh`). Если бинарника нет, тул всё равно остаётся в реестре (инвариант
 * постоянного набора дефинишенов, ADR-070), но помечается недоступным с причиной
 * `dependency` — слой доступности сообщает об этом модели и UI.
 *
 * Модуль листовой: не импортирует permission/evaluator (иначе цикл) — только
 * `node:child_process`. Детекция кэшируется на уровне модуля (одноразовый
 * пробинг на процесс), `resetRuntimeDepsCache()` — для тестов.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 3_000;

export type RuntimeDependency = 'git' | 'rg' | 'sh';

export interface RuntimeDeps {
  git: boolean;
  rg: boolean;
  sh: boolean;
}

/** Человекочитаемое имя программы для текстов модели/UI. */
export const RUNTIME_DEP_BINARY: Record<RuntimeDependency, string> = {
  git: 'git',
  rg: 'rg (ripgrep)',
  sh: 'sh',
};

/** Фактические имена бинарников для пробинга (`--version`). */
const RUNTIME_DEP_COMMAND: Record<RuntimeDependency, string> = {
  git: 'git',
  rg: 'rg',
  sh: 'sh',
};

/**
 * Соответствие встроенных тулов внешней зависимости. Тулы без внешней
 * зависимости в карте отсутствуют (файловые/plan/todo/web/task/skill).
 */
export const TOOL_RUNTIME_DEP: Record<string, RuntimeDependency> = {
  grep_files: 'rg',
  execute_shell: 'sh',
  git_status: 'git',
  git_diff: 'git',
  git_log: 'git',
  git_commit: 'git',
  git_push: 'git',
  git_pull: 'git',
  git_checkout: 'git',
  git_branch_list: 'git',
  git_show: 'git',
  git_blame: 'git',
  git_stash: 'git',
};

/** Fail-open дефолт: все зависимости считаются доступными. */
export const ALL_RUNTIME_DEPS_AVAILABLE: RuntimeDeps = { git: true, rg: true, sh: true };

/** Доступна ли зависимость. `undefined` (детекция не выполнена) → доступна (fail-open). */
export function isRuntimeDepAvailable(deps: RuntimeDeps | undefined, dep: RuntimeDependency): boolean {
  if (!deps) return true;
  return deps[dep] !== false;
}

/**
 * Пробинг одного бинарника: `bin --version`. `ENOENT` → false (нет бинарника);
 * любая прочая ошибка (таймаут, ненулевой код выхода, EACCES) → true (fail-open,
 * не блокируем тул из-за неоднозначной ошибки).
 */
export async function probeBinary(bin: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code !== 'ENOENT';
  }
}

let cache: Promise<RuntimeDeps> | undefined;

/**
 * Детекция всех зависимостей параллельно. Промис кэшируется на уровне модуля:
 * повторные вызовы возвращают тот же промис (дедупликация пробинга).
 */
export function detectRuntimeDeps(): Promise<RuntimeDeps> {
  if (!cache) {
    cache = Promise.all([
      probeBinary(RUNTIME_DEP_COMMAND.git),
      probeBinary(RUNTIME_DEP_COMMAND.rg),
      probeBinary(RUNTIME_DEP_COMMAND.sh),
    ]).then(([git, rg, sh]) => ({ git, rg, sh }));
  }
  return cache;
}

/** Сброс кэша детекции (тесты). */
export function resetRuntimeDepsCache(): void {
  cache = undefined;
}
