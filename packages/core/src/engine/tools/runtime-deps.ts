/**
 * Runtime-зависимости встроенных инструментов от внешних программ окружения.
 *
 * Часть встроенных тулов работает только через внешние бинарники (`git`, `rg`,
 * `sh`). Если бинарника нет, тул всё равно остаётся в реестре (инвариант
 * постоянного набора дефинишенов, ADR-070), но помечается недоступным с причиной
 * `dependency` — слой доступности сообщает об этом модели и UI.
 *
 * Модуль листовой: не импортирует permission/evaluator (иначе цикл) — только
 * порт исполнения. Детекция кэшируется **по экземпляру порта** (см. ниже),
 * `resetRuntimeDepsCache()` — для тестов.
 *
 * ADR-077: проба идёт через порт исполнения. Ответ порта зависит от режима:
 *
 *   - **inline** — локальная проба `bin --version` (прежнее поведение);
 *   - **remote** — состав **пула исполнителей**: порт отвечает по своему
 *     инвентарю (`GET /capabilities` у каждого адреса), программа считается
 *     доступной, если она есть хотя бы у одного доступного адреса. Именно так
 *     состав пула, а не одиночная проба в control plane, определяет
 *     доступность инструментов.
 *
 * ## Кэш детекции — по экземпляру порта
 *
 * Кэш общий на модуль был ловушкой: первая же проверка без порта (inline)
 * «отравляла» кэш, и последующая проверка с remote-портом получала результат
 * локальной пробы — детект и исполнение расходились (control plane считал
 * доступным бинарь, которого нет ни у одного исполнителя). Теперь кэш
 * привязан к инстансу порта (`WeakMap`), поэтому inline- и remote-детекты
 * не мешают друг другу.
 */

import { InlineExecutionPort } from '../../execution/inline-execution-port.js';
import { probeBinaryThroughPort } from '../../execution/probe.js';
import type { ExecutionPort } from '../../execution/ports/index.js';

export type RuntimeDependency = 'git' | 'rg' | 'sh';

/** Все зависимости — в порядке проверки (тот же, что и словарь core, ADR-077). */
export const RUNTIME_DEPENDENCIES: readonly RuntimeDependency[] = ['git', 'rg', 'sh'];

export interface RuntimeDeps {
  git: boolean;
  rg: boolean;
  sh: boolean;
  /**
   * Детали недоступности — по зависимости (ADR-077).
   *
   * Технический текст (не переводится): в remote-режиме — «в пуле: 2 из 3
   * адресов», в inline-режиме — «программа не установлена». Показывается
   * рядом с причиной `dependency`, чтобы модель видела не только «программы
   * нет», но и **где** её нет.
   */
  details?: Partial<Record<RuntimeDependency, string>>;
}

/** Человекочитаемое имя программы для текстов модели/UI. */
export const RUNTIME_DEP_BINARY: Record<RuntimeDependency, string> = {
  git: 'git',
  rg: 'rg (ripgrep)',
  sh: 'sh',
};

/** Фактические имена бинарников для пробинга (`--version`). */
export const RUNTIME_DEP_COMMAND: Record<RuntimeDependency, string> = {
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
 * Деталь недоступности зависимости (ADR-077). Нет детали → `undefined`.
 */
export function runtimeDepUnavailableDetail(
  deps: RuntimeDeps | undefined,
  dep: RuntimeDependency,
): string | undefined {
  return deps?.details?.[dep];
}

/**
 * Бинарные требования зависимости — для `ExecRequest.requires` (ADR-077).
 *
 * Источник истины — тот же словарь, что и карта тулов: строки не дублируются
 * вручную ни в одном туле.
 */
export function runtimeRequires(dep: RuntimeDependency): string[] {
  return [RUNTIME_DEP_COMMAND[dep]];
}

/**
 * Бинарные требования тула — из карты `TOOL_RUNTIME_DEP` (ADR-077).
 *
 * Тул без внешней зависимости → пустой список (требований нет).
 */
export function toolRuntimeRequires(toolName: string): string[] {
  const dep = TOOL_RUNTIME_DEP[toolName];
  return dep ? runtimeRequires(dep) : [];
}

/**
 * Пробинг одного бинарника: `bin --version`. `ENOENT` → false (нет бинарника);
 * любая прочая ошибка (таймаут, ненулевой код выхода, EACCES) → true (fail-open,
 * не блокируем тул из-за неоднозначной ошибки).
 *
 * ADR-077: `execution` — порт исполнения; не задан — inline (прежнее поведение).
 * Если порт умеет отвечать о своих возможностях (`probe`) — спрашиваем его:
 * в remote-режиме только порт знает состав пула исполнителей.
 */
export async function probeBinary(
  bin: string,
  args: string[] = ['--version'],
  execution?: ExecutionPort,
): Promise<boolean> {
  const port = execution ?? new InlineExecutionPort();
  if (typeof port.probe === 'function') return port.probe(bin, args);
  return probeBinaryThroughPort(port, bin, args);
}

/**
 * Деталь недоступности бинаря — из сводки порта (ADR-077).
 *
 * Порт без сводки (inline) → деталь общего вида: программа не установлена в
 * окружении. Порт со сводкой (remote) → деталь по составу пула: в скольких
 * адресах программы нет.
 */
async function describeUnavailable(
  port: ExecutionPort,
  dep: RuntimeDependency,
  bin: string,
): Promise<string> {
  if (typeof port.capabilitySummary === 'function') {
    try {
      const summary = await port.capabilitySummary(bin);
      const parts = [`${bin}: отсутствует в ${summary.missing} из ${summary.total} адресов пула`];
      if (summary.unreachable > 0) {
        parts.push(`${summary.unreachable} адресов не ответили`);
      }
      return parts.join('; ');
    } catch {
      // Сводка недоступна — деталь общего вида (не блокируем тул из-за неё).
    }
  }
  return `${bin}: программа не установлена в окружении`;
}

/** Детекция всех зависимостей одного порта. */
async function detectDeps(port: ExecutionPort): Promise<RuntimeDeps> {
  const probe = typeof port.probe === 'function' ? port.probe.bind(port) : undefined;
  const results = await Promise.all(
    RUNTIME_DEPENDENCIES.map(async (dep) => {
      const bin = RUNTIME_DEP_COMMAND[dep];
      const available = probe
        ? await probe(bin)
        : await probeBinaryThroughPort(port, bin);
      return { dep, bin, available };
    }),
  );

  const deps: RuntimeDeps = { git: false, rg: false, sh: false };
  const details: Partial<Record<RuntimeDependency, string>> = {};
  for (const result of results) {
    deps[result.dep] = result.available;
    if (!result.available) {
      details[result.dep] = await describeUnavailable(port, result.dep, result.bin);
    }
  }
  if (Object.keys(details).length > 0) deps.details = details;
  return deps;
}

/** Кэш детекции по экземпляру порта (см. шапку модуля). */
let cacheByPort = new WeakMap<ExecutionPort, Promise<RuntimeDeps>>();
/** Кэш детекции для inline-порта по умолчанию. */
let inlineCache: Promise<RuntimeDeps> | undefined;

/**
 * Детекция всех зависимостей параллельно. Промис кэшируется **по порту**:
 * повторные вызовы с тем же портом возвращают тот же промис (дедупликация
 * пробинга), а вызовы с другим портом (или без порта) считаются отдельно —
 * детект и исполнение всегда смотрят в одно окружение.
 *
 * Порт исполнения — параметр запуска процесса (инвариант 24), сменить его
 * «на лету» нельзя; состав пула при этом обновляется портом сам (TTL).
 */
export function detectRuntimeDeps(execution?: ExecutionPort): Promise<RuntimeDeps> {
  if (!execution) {
    inlineCache ??= detectDeps(new InlineExecutionPort());
    return inlineCache;
  }
  const cached = cacheByPort.get(execution);
  if (cached) return cached;
  const promise = detectDeps(execution);
  cacheByPort.set(execution, promise);
  return promise;
}

/** Сброс кэша детекции (тесты). */
export function resetRuntimeDepsCache(): void {
  inlineCache = undefined;
  // WeakMap не очищается — пересоздаём (записи старых инстансов портов теряются).
  cacheByPort = new WeakMap<ExecutionPort, Promise<RuntimeDeps>>();
}
