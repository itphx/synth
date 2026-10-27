/**
 * Runtime-зависимости встроенных инструментов от внешних программ окружения.
 *
 * Часть встроенных тулов работает только через внешние бинарники (`git`, `rg`,
 * `sh`). Если бинарника нет, тул всё равно остаётся в реестре (инвариант
 * постоянного набора дефинишенов, ADR-070), но помечается недоступным с причиной
 * `dependency` — слой доступности сообщает об этом модели и UI.
 *
 * Модуль листовой: не импортирует permission/evaluator (иначе цикл) — только
 * порт исполнения. Детекция кэшируется **по экземпляру порта** на TTL (см.
 * ниже), `refreshRuntimeDeps()` перечитывает снимок по месту (ход сессии),
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
 * не мешают друг другу. Срок жизни записи — `RUNTIME_DEPS_CACHE_TTL_MS`:
 * состав пула меняется (раскатка), поэтому кэш не бессрочный; сам снимок в
 * домене перечитывает `refreshRuntimeDeps` (ход сессии).
 */

import { InlineExecutionPort } from '../../execution/inline-execution-port.js';
import { probeBinaryThroughPort } from '../../execution/probe.js';
import type { ExecutionPort } from '../../execution/ports/index.js';

export type RuntimeDependency = 'git' | 'rg' | 'sh' | 'ffmpeg';

/**
 * Зависимости, входящие в **снимок** `RuntimeDeps` (требования встроенных
 * тулов). `ffmpeg` — программа слоя обработки медиа (ADR-115): в снимок не
 * входит, проверяется по запросу (`isFfmpegAvailable`).
 */
export type ToolRuntimeDependency = Exclude<RuntimeDependency, 'ffmpeg'>;

/** Все зависимости тулов — в порядке проверки (тот же, что и словарь core, ADR-077). */
export const RUNTIME_DEPENDENCIES: readonly ToolRuntimeDependency[] = ['git', 'rg', 'sh'];

/**
 * ADR-115: программы обработки медиа (aux-модели, `engine/attachments/derive.ts`).
 *
 * Отдельный список, а не часть `RUNTIME_DEPENDENCIES`: `ffmpeg` не является
 * требованием встроенного тула, поэтому в снимок `RuntimeDeps` (его читает
 * permission-слой и отдаёт модель) он не входит — иначе изменился бы контракт
 * снимка для всех потребителей. Доступность проверяется по запросу
 * (`isFfmpegAvailable`, тот же TTL и кэш «по экземпляру порта»).
 */
export const MEDIA_RUNTIME_DEPENDENCIES: readonly RuntimeDependency[] = ['ffmpeg'];

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
  ffmpeg: 'ffmpeg',
};

/** Фактические имена бинарников для пробинга (`--version`). */
export const RUNTIME_DEP_COMMAND: Record<RuntimeDependency, string> = {
  git: 'git',
  rg: 'rg',
  sh: 'sh',
  ffmpeg: 'ffmpeg',
};

/**
 * Соответствие встроенных тулов внешней зависимости. Тулы без внешней
 * зависимости в карте отсутствуют (файловые/plan/todo/web/task/skill).
 */
export const TOOL_RUNTIME_DEP: Record<string, ToolRuntimeDependency> = {
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
  // ADR-114: тулы инвентаря git-worktree'ов — git тоже нужен
  // (`git worktree add/remove/prune`).
  git_worktree_list: 'git',
  git_worktree_create: 'git',
  git_worktree_remove: 'git',
  git_worktree_prune: 'git',
};

/** Fail-open дефолт: все зависимости считаются доступными. */
export const ALL_RUNTIME_DEPS_AVAILABLE: RuntimeDeps = { git: true, rg: true, sh: true };

/** Доступна ли зависимость. `undefined` (детекция не выполнена) → доступна (fail-open). */
export function isRuntimeDepAvailable(
  deps: RuntimeDeps | undefined,
  dep: ToolRuntimeDependency,
): boolean {
  if (!deps) return true;
  return deps[dep] !== false;
}

/**
 * Деталь недоступности зависимости (ADR-077). Нет детали → `undefined`.
 */
export function runtimeDepUnavailableDetail(
  deps: RuntimeDeps | undefined,
  dep: ToolRuntimeDependency,
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

/**
 * Срок жизни кэша детекции, мс.
 *
 * Бессрочный кэш «по порту» был дефектом: в split-режиме состав пула
 * появляется не мгновенно (control plane и исполнитель стартуют вместе, при
 * раскатке control plane может застать **старый** под без нужных бинарей).
 * Отрицательный результат «sh нет» запоминался на весь процесс — `execute_shell`
 * оставался недоступен до перезапуска backend (наблюдалось в test после
 * раскатки: `sh: отсутствует в 1 из 1 адресов пула`, хотя /bin/sh в образе
 * есть). Теперь детекция переиспользуется минуту, а состав пула порт обновляет
 * сам по своему TTL.
 */
export const RUNTIME_DEPS_CACHE_TTL_MS = 60_000;

interface DepsCacheEntry {
  promise: Promise<RuntimeDeps>;
  /** Момент создания записи (мс). */
  at: number;
}

/** Кэш детекции по экземпляру порта (см. шапку модуля). */
let cacheByPort = new WeakMap<ExecutionPort, DepsCacheEntry>();
/** Кэш детекции для inline-порта по умолчанию. */
let inlineCache: DepsCacheEntry | undefined;

/**
 * Детекция всех зависимостей параллельно. Результат кэшируется **по порту** на
 * `ttlMs` (по умолчанию `RUNTIME_DEPS_CACHE_TTL_MS`): повторные вызовы с тем же
 * портом возвращают тот же промис (дедупликация пробинга), а вызовы с другим
 * портом (или без порта) считаются отдельно — детект и исполнение всегда
 * смотрят в одно окружение.
 *
 * Порт исполнения — параметр запуска процесса (инвариант 24), сменить его
 * «на лету» нельзя; состав пула при этом обновляется портом сам (TTL), поэтому
 * и детекцию нельзя кэшировать бессрочно.
 */
export function detectRuntimeDeps(
  execution?: ExecutionPort,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<RuntimeDeps> {
  const ttlMs = opts.ttlMs ?? RUNTIME_DEPS_CACHE_TTL_MS;
  const now = opts.now ?? Date.now();
  if (!execution) {
    if (inlineCache && now - inlineCache.at < ttlMs) return inlineCache.promise;
    const promise = detectDeps(new InlineExecutionPort());
    inlineCache = { promise, at: now };
    return promise;
  }
  const cached = cacheByPort.get(execution);
  if (cached && now - cached.at < ttlMs) return cached.promise;
  const promise = detectDeps(execution);
  cacheByPort.set(execution, { promise, at: now });
  return promise;
}

/** Кэш детекции `ffmpeg` — тот же приём, что у снимка тулов (см. выше). */
interface MediaDepsCacheEntry {
  promise: Promise<boolean>;
  /** Момент создания записи (мс). */
  at: number;
}

let mediaCacheByPort = new WeakMap<ExecutionPort, MediaDepsCacheEntry>();
let mediaInlineCache: MediaDepsCacheEntry | undefined;

/**
 * ADR-115: есть ли `ffmpeg` для обработки медиа (транскод аудио, кадры видео).
 *
 * Проба — через **порт** исполнения (ADR-077): в split-режиме доступность
 * определяет состав пула исполнителей, а не control plane; в inline — локальная
 * проба `ffmpeg --version` (fail-open: неоднозначная ошибка → доступен).
 * Кэш — по экземпляру порта на `RUNTIME_DEPS_CACHE_TTL_MS` (как у снимка
 * зависимостей тулов): бессрочный кэш залипал бы на «нет ffmpeg» после
 * раскатки исполнителя.
 *
 * Результат — промис (дедупликация параллельных проверок одного хода); ошибки
 * пробы не бросаются: порт/проба бросили → `false` (обработка не выполняется,
 * вложение идёт обычным путём).
 */
export function isFfmpegAvailable(
  execution?: ExecutionPort,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<boolean> {
  const ttlMs = opts.ttlMs ?? RUNTIME_DEPS_CACHE_TTL_MS;
  const now = opts.now ?? Date.now();

  const detect = async (port: ExecutionPort): Promise<boolean> => {
    const bin = RUNTIME_DEP_COMMAND.ffmpeg;
    try {
      const available =
        typeof port.probe === 'function'
          ? await port.probe(bin)
          : await probeBinaryThroughPort(port, bin);
      return available;
    } catch {
      return false;
    }
  };

  if (!execution) {
    if (mediaInlineCache && now - mediaInlineCache.at < ttlMs) return mediaInlineCache.promise;
    const promise = detect(new InlineExecutionPort());
    mediaInlineCache = { promise, at: now };
    return promise;
  }

  const cached = mediaCacheByPort.get(execution);
  if (cached && now - cached.at < ttlMs) return cached.promise;
  const promise = detect(execution);
  mediaCacheByPort.set(execution, { promise, at: now });
  return promise;
}

/** Сброс кэша детекции (тесты). */
export function resetRuntimeDepsCache(): void {
  inlineCache = undefined;
  mediaInlineCache = undefined;
  // WeakMap не очищается — пересоздаём (записи старых инстансов портов теряются).
  cacheByPort = new WeakMap<ExecutionPort, DepsCacheEntry>();
  mediaCacheByPort = new WeakMap<ExecutionPort, MediaDepsCacheEntry>();
}

/**
 * Перечитать доступность зависимостей в **живой** снимок (ADR-070 §2.9.1/ADR-077).
 *
 * Снимок, снятый при старте, устаревает: в split-режиме состав пула появляется
 * не мгновенно (control plane стартует раньше исполнителя, при раскатке — с
 * прошлым образом). Без перечитывания отрицательный результат пробы залипал бы
 * до перезапуска процесса даже при TTL-кэше: кэш ограничивает срок жизни
 * результата, но кто-то должен спросить детект заново (наблюдалось в test:
 * `sh: отсутствует в 1 из 1 адресов пула`, хотя `/bin/sh` в образе есть).
 *
 * Запись — **по месту**, а не заменой ссылки: объект снимка разделяется с
 * другими потребителями, собранными в точке сборки (permission-слой шагов
 * пайплайнов), иначе они остались бы со значением на момент старта.
 *
 * Ошибка детекта снимок не меняет (fail-open, ADR-078): прежнее значение лучше,
 * чем «доступность неизвестна». Повторные вызовы дешевы — `detectRuntimeDeps`
 * кэширует результат на `RUNTIME_DEPS_CACHE_TTL_MS`.
 *
 * @returns тот же объект-снимок (для цепочек вызовов и тестов)
 */
export async function refreshRuntimeDeps(
  target: RuntimeDeps,
  execution?: ExecutionPort,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<RuntimeDeps> {
  let fresh: RuntimeDeps;
  try {
    fresh = await detectRuntimeDeps(execution, opts);
  } catch {
    // Детект не удался (порт/проба бросили) — оставляем прежний снимок.
    return target;
  }
  target.git = fresh.git;
  target.rg = fresh.rg;
  target.sh = fresh.sh;
  target.details = fresh.details;
  return target;
}
