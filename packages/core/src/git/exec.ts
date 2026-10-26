import { InlineExecutionPort } from '../execution/inline-execution-port.js';
import { DEFAULT_MAX_OUTPUT_BYTES, type ExecutionPort, type ExecSecret } from '../execution/ports/index.js';
import { runtimeRequires } from '../engine/tools/runtime-deps.js';
import { gitProxyEnv } from '../security/proxy-state.js';
import { gitCaConfig } from '../security/tls.js';

/**
 * Исполнение git-команд через `ExecutionPort` (ADR-077).
 *
 * Обёртка над бинарём `git` в сторонней библиотеке заставляла slim-образ
 * control plane содержать git-библиотеку и её транзитивные зависимости, поэтому
 * git-команды идут через тот же порт, что и остальные агентские команды (`argv` без shell, `requires: ['git']`). В inline-режиме
 * исполнение локальное (прежнее поведение), в remote — на исполнителе.
 *
 * Порт — источник истины для «где исполняется команда»; собственного процесса
 * модуль не запускает.
 */

/**
 * Не-git ключи, которые прежняя git-библиотека блокировала по blocklist
 * (`isGitEnvKey` — `EDITOR`, `VISUAL`, `PAGER`, `PREFIX`, `SSH_ASKPASS`, …).
 * Остальные блокируемые ключи — `GIT_*`
 * (`GIT_EDITOR`, `GIT_PAGER`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, …) —
 * вырезаются по префиксу в `sanitizeGitEnv`. `SSH_ASKPASS_REQUIRE` сам не в
 * blocklist, но вырезается вместе с `SSH_ASKPASS`: сервис ставит его только сам
 * (см. `createSshEnv`) — ambient-значение не должно протекать в git.
 * `allowUnsafeEditor`/`allowUnsafePager` сознательно НЕ включаем.
 */
const BLOCKED_ENV_KEYS = new Set(['editor', 'visual', 'pager', 'prefix', 'ssh_askpass', 'ssh_askpass_require']);

/**
 * Санитизирует окружение перед передачей дочернему git: вырезает `git*`-ключи
 * (без учёта регистра) и не-git blocklist (`EDITOR`, `VISUAL`, `PAGER`,
 * `PREFIX`, `SSH_ASKPASS`, …). Иначе ambient-окружение хоста (например
 * `EDITOR` из dev-шелла) утекает в git и меняет его поведение
 * (интерактивный редактор, пейджер).
 */
export function sanitizeGitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('git') || BLOCKED_ENV_KEYS.has(lower)) continue;
    out[key] = value;
  }
  return out;
}

/** Опции git-вызова через порт. */
export interface GitExecOptions {
  /** Порт исполнения; не задан — inline (локальное исполнение). */
  execution?: ExecutionPort;
  /** Рабочий каталог команды. */
  cwd?: string;
  /** Дополнительное окружение (например SSH из ADR-076). */
  env?: Record<string, string>;
  /**
   * Секреты вызова (ADR-077, протокол 4): SSH-ключ доставляется точке
   * исполнения на время вызова — в inline-режиме материализуется локально,
   * в remote-режиме уезжает в теле `POST /exec`.
   */
  secrets?: ExecSecret[];
  /** Таймаут вызова (мс); не задан — без таймаута (прежнее поведение). */
  timeoutMs?: number;
  /** Сигнал отмены («Стоп»). */
  signal?: AbortSignal;
}

/**
 * Окружение дочернего git. Семантика прежнего `withEnv`: санитайзенный
 * `process.env` + `GIT_TERMINAL_PROMPT=0` (неинтерактивность) + прокси/no_proxy
 * (ADR-099 D2b — только env, не argv) + дополнительные переменные вызова
 * (перекрывают базовые).
 */
export function buildGitEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    ...sanitizeGitEnv(process.env),
    GIT_TERMINAL_PROMPT: '0',
    ...gitProxyEnv(),
    ...extra,
  };
}

/** Исполнение командного порта — удалённое (не в процессе control plane). */
function isRemoteExecution(execution?: ExecutionPort): boolean {
  return execution?.isRemote === true;
}

/**
 * ADR-099: CA доверия передаётся git пер-вызовом (`-c http.sslCAInfo=<path>`)
 * **только когда исполнение локальное**. В remote-режиме путь CA принадлежит
 * control plane и в окружении исполнителя его нет — у исполнителя своя
 * политика доверия (инициализируется при старте, ADR-077/ADR-099).
 * Env-канал (`GIT_SSL_CAINFO`) не используем: `sanitizeGitEnv` вырезает
 * `git*`-env.
 */
function gitTrustConfigArgs(execution?: ExecutionPort): string[] {
  if (isRemoteExecution(execution)) return [];
  const config = gitCaConfig();
  const args: string[] = [];
  for (const entry of config) args.push('-c', entry);
  return args;
}

/**
 * Запуск `git <args>` через порт исполнения.
 *
 * Команда — `argv` (без shell): значения аргументов не проходят через shell и
 * не могут быть инъекцией. Ошибка процесса приходит `ExecutionError` (порт
 * сохраняет текст «Command failed: …»), успешный вызов — `{ stdout, stderr }`.
 */
export async function gitExec(
  args: string[],
  opts: GitExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const execution = opts.execution ?? new InlineExecutionPort();
  const { stdout, stderr } = await execution.execute({
    command: { kind: 'argv', file: 'git', args: [...gitTrustConfigArgs(opts.execution), ...args] },
    // ADR-077: бинарное требование — в remote-режиме команда уходит в адрес
    // пула, где git есть.
    requires: runtimeRequires('git'),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    env: buildGitEnv(opts.env),
    // ADR-077 (протокол 4): SSH-ключ — секрет вызова, а не путь к файлу в
    // control plane: материал готовит точка исполнения.
    ...(opts.secrets && opts.secrets.length > 0 ? { secrets: opts.secrets } : {}),
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  });
  return { stdout, stderr };
}
