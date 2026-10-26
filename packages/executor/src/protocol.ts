/**
 * Wire-протокол исполнителя (ADR-077, шаг 7a).
 *
 * Транспорт — HTTP/1.1 + JSON. Протокол версионируется полем `protocol`
 * (`GET /capabilities`): расхождение версий — признак несовместимого
 * исполнителя, а не «случайная» ошибка.
 *
 * ## Форма запроса
 *
 * `POST /exec`:
 *
 * ```json
 * {
 *   "command": { "kind": "shell", "command": "printf hi" },
 *   "cwd": "/workspace/project",
 *   "env": { "HOME": "/root" },
 *   "timeoutMs": 30000,
 *   "maxOutputBytes": 10485760
 * }
 * ```
 *
 * `command` — тот же union `ExecCommand`, что у порта core (`shell` | `argv`):
 * форма команды на проводе не переопределяется, чтобы удалённый исполнитель
 * вёл себя как inline (паритет семантики — главная ценность порта).
 *
 * ## Форма ответа
 *
 * - **Успех** — `200` + `{ stdout, stderr, exitCode, truncated, durationMs }`.
 *   Успешный вызов — всегда `exitCode: 0` (неуспешный код приходит ошибкой,
 *   как и в inline-режиме: текст «Command failed: …» должен остаться прежним).
 * - **Ошибка** — тело `{ error: { reason, code, message, stdout, stderr, killed,
 *   signal, truncated, durationMs } }` — зеркало `ExecutionError` из core.
 *   Код ответа — по классу ошибки (см. `EXEC_ERROR_STATUS`).
 *
 * `reason` — либо одна из причин порта (`timeout` | `aborted` | `spawn_failed` |
 * `nonzero_exit` | `max_output`), либо протокольная причина
 * (`invalid_request` | `cwd_outside_workspace` | `unauthorized` | `not_found` |
 * `too_many_requests` | `internal_error`).
 *
 * ## MCP-эндпоинты (протокол 2)
 *
 * Исполнитель **хостит MCP-серверы у себя** (stdio) — это основа для
 * браузерных и tier-4 инструментов в split-режиме, где control plane тонкий,
 * а toolchain живёт в исполнителе (ADR-077, шаг B1).
 *
 * - `GET /mcp/servers` → `[{ name, status, toolCount, error? }]` — состояние
 *   серверов (`idle` — не поднимался, `up` — работает, `down` — упал);
 *   значения `env` **не отдаются**;
 * - `GET /mcp/tools` → `[{ server, name, description, inputSchema }]` — инструменты
 *   всех **поднятых** серверов (серверы, которые не удалось поднять,
 *   пропускаются — их причина видна в `/mcp/servers`);
 * - `POST /mcp/call` — тело `{ server, tool, arguments? }` → `{ content, isError }`;
 *   неизвестный сервер/инструмент → `404`, ошибка MCP → `500` с текстом ошибки
 *   (без секретов).
 *
 * ## Фоновые процессы (протокол 3)
 *
 * Фоновый процесс **переживает ход агента** (ADR-077, шаг 7c; PROP-097):
 * в split-топологии он живёт **на исполнителе** — там, где есть toolchain и
 * рабочий каталог.
 *
 * - `POST /exec/spawn` — тело `{ command, cwd?, env?, timeoutMs?, requires? }` →
 *   `201 { processId, pid }`; `400` — невалидное тело или `cwd` вне workspace,
 *   `429` — превышен лимит живых фоновых процессов;
 * - `GET /exec/:processId` → `200 { processId, status, exitCode, signal, … }`;
 *   `404` — процесс не найден;
 * - `GET /exec/:processId/logs` → `200 { stdout, stderr, totalBytes, truncated, … }`;
 *   query `stdoutOffset`/`stderrOffset`/`limit` (потолок отрезка — 256 КиБ,
 *   по умолчанию — 64 КиБ); `404` — процесс не найден;
 * - `POST /exec/:processId/stop` → `200 { status: 'stopping' }` (тело
 *   `{ signal? }` — сигнал остановки: `SIGTERM` по умолчанию, допустимы только
 *   `SIGTERM`/`SIGKILL`, прочие → `400 invalid_request`; через 5 с после
 *   `SIGTERM` — `SIGKILL`); `404` — процесс не найден.
 *
 * Журналы — **раздельные** по потокам: `stdout` и `stderr` приходят
 * отдельными отрезками со своими смещениями. Идентификатор процесса —
 * `proc_<uuid>` (тот же формат, что у порта core).
 *
 * ## Секреты вызова (протокол 4)
 *
 * `POST /exec` принимает **аддитивное** поле `secrets[]` — материал, нужный
 * точке исполнения на время одной команды (сейчас — приватный SSH-ключ,
 * ADR-076/ADR-077):
 *
 * ```json
 * {
 *   "command": { "kind": "argv", "file": "git", "args": ["fetch"] },
 *   "secrets": [{ "kind": "ssh-key", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n" }]
 * }
 * ```
 *
 * Правила:
 *
 * - значения **не логируются** и **не возвращаются** в ответе (ни в успехе,
 *   ни в ошибке); в `/capabilities` их нет;
 * - исполнитель материализует материал **у себя** (временный каталог `0700`,
 *   ключ `0600`, askpass `0700`) и удаляет его после вызова;
 * - максимум 4 записи, `kind === 'ssh-key'`, `privateKey` — непустая строка до
 *   16 КиБ, `passphrase` — строка до 4 КиБ; иначе — `400 invalid_request`;
 * - в `POST /exec/spawn` (фоновые процессы) секреты **не поддерживаются**:
 *   процесс переживает вызов, а материал доставляется «на время вызова»;
 * - признак поддержки — `features.secrets: true` в `GET /capabilities`
 *   (и версия протокола ≥ 4).
 */

import type { ExecCommand, ExecSecret } from '@itphx/synth-core';

/**
 * Версия wire-протокола исполнителя.
 *
 * **4** — добавлены секреты вызова (`secrets[]` в `POST /exec`, ADR-077,
 * «Обновлено 2026-10-26», (б)). Старый исполнитель (версии 1–3) их не знает ⇒
 * control plane и исполнитель обязаны быть **одной версии** (ADR-077,
 * операционное следствие шага A: инвентарь пула приходит от исполнителя, а не
 * вычисляется на стороне control plane).
 *
 * **3** — добавлены фоновые процессы (`/exec/spawn`, `/exec/:processId`,
 * `/exec/:processId/logs`, `/exec/:processId/stop`).
 *
 * **2** — добавлены MCP-эндпоинты (`/mcp/servers`, `/mcp/tools`,
 * `/mcp/call`).
 */
export const EXECUTOR_PROTOCOL_VERSION = 4;

/** Причина неудачи на проводе. */
export type ExecutorErrorReason =
  /** Превышен таймаут — процесс прерван. */
  | 'timeout'
  /** Отмена («Стоп»): клиент разорвал запрос — процесс убит на сервере. */
  | 'aborted'
  /** Не удалось запустить процесс (нет бинарника, EACCES, …). */
  | 'spawn_failed'
  /** Процесс завершился с ненулевым кодом. */
  | 'nonzero_exit'
  /** Превышен лимит буфера вывода — вывод обрезан. */
  | 'max_output'
  /** Тело запроса невалидно (нет команды, неверные типы полей). */
  | 'invalid_request'
  /** `cwd` вне корня workspace исполнителя (включая симлинк-побег). */
  | 'cwd_outside_workspace'
  /** Нет или неверный bearer-токен. */
  | 'unauthorized'
  /** Запрошенный ресурс не найден (неизвестный MCP-сервер/инструмент). */
  | 'not_found'
  /** Превышен лимит одновременных команд. */
  | 'too_many_requests'
  /** Прочие ошибки сервера. */
  | 'internal_error';

/** Тело запроса `POST /exec`. */
export interface ExecRequestBody {
  /** Команда: shell-строка или argv (без shell). */
  command: ExecCommand;
  /** Рабочий каталог команды (внутри workspace исполнителя). */
  cwd?: string;
  /** Дополнительное окружение — мержится поверх окружения исполнителя. */
  env?: Record<string, string>;
  /** Таймаут команды, мс (исполнитель ограничивает своим максимумом). */
  timeoutMs?: number;
  /** Лимит буфера вывода, байт (исполнитель ограничивает своим максимумом). */
  maxOutputBytes?: number;
  /**
   * Секреты вызова (протокол 4): материал, нужный **на время вызова** —
   * исполнитель материализует его у себя и удаляет после команды. Значения не
   * логируются и не возвращаются в ответе.
   */
  secrets?: ExecSecret[];
}

/** Тело успешного ответа `POST /exec`. */
export interface ExecSuccessBody {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
}

/** Тело ошибочного ответа — зеркало `ExecutionError` из core. */
export interface ExecErrorBody {
  reason: ExecutorErrorReason;
  /** Код: `'ENOENT'`, код выхода, `null` или протокольный код (`EWORKSPACE`, …). */
  code: string | number | null;
  /** Текст ошибки (дословно, как его видит модель). */
  message: string;
  stdout: string;
  stderr: string;
  killed: boolean;
  signal: string | null;
  truncated: boolean;
  durationMs: number;
}

/** Ошибочный ответ исполнителя. */
export interface ExecErrorResponse {
  error: ExecErrorBody;
}

/** Ответ `GET /capabilities`. */
export interface ExecutorCapabilities {
  /** Версия wire-протокола. */
  protocol: number;
  /** Состав toolchain'а: бинарник → версия (нет бинарника — ключа нет). */
  toolchain: Record<string, string>;
  /** ОС исполнителя (`process.platform`). */
  os: string;
  /** Архитектура (`process.arch`). */
  arch: string;
  /** Версия Node.js исполнителя. */
  node: string;
  /**
   * Необязательные возможности исполнителя (аддитивно: старый control plane
   * поле просто не читает).
   *
   * `background: true` — исполнитель умеет фоновые процессы
   * (`/exec/spawn`, ADR-077 шаг 7c).
   *
   * `secrets: true` — исполнитель принимает секреты вызова (`secrets[]` в
   * `POST /exec`, протокол 4).
   */
  features?: ExecutorFeatures;
}

/** Необязательные возможности исполнителя. */
export interface ExecutorFeatures {
  /** Фоновые процессы (`POST /exec/spawn`). */
  background?: boolean;
  /** Секреты вызова (`secrets[]` в `POST /exec`, протокол 4). */
  secrets?: boolean;
}

/** Ответ `GET /health`. */
export interface ExecutorHealth {
  status: 'ok';
  protocol: number;
  uptimeSec: number;
  concurrency: { limit: number; active: number };
  /** Фоновые процессы (ADR-077, шаг 7c). */
  background?: { limit: number; active: number };
}

/**
 * Статус MCP-сервера у исполнителя (`GET /mcp/servers`).
 *
 * Значения `env` сервера **не отдаются** — только имя, состояние, число
 * инструментов и причина последней ошибки (без секретов).
 */
export interface McpServerStatusBody {
  name: string;
  /** `idle` — настроен, но ещё не поднимался; `up` — работает; `down` — упал. */
  status: 'idle' | 'up' | 'down';
  toolCount: number;
  /** Причина последней ошибки (без секретов). */
  error?: string;
}

/** Инструмент MCP-сервера в плоском виде (`GET /mcp/tools`). */
export interface McpToolInfoBody {
  /** Имя сервера-источника. */
  server: string;
  /** Имя инструмента в MCP-сервере (без префикса сервера). */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Тело запроса `POST /mcp/call`. */
export interface McpCallRequestBody {
  /** Имя MCP-сервера. */
  server: string;
  /** Имя инструмента в сервере. */
  tool: string;
  /** Аргументы вызова. */
  arguments?: Record<string, unknown>;
}

/** Тело ответа `POST /mcp/call`. */
export interface McpCallResultBody {
  /** Текстовый результат вызова. */
  content: string;
  /** Инструмент отработал с ошибкой (сам вызов состоялся). */
  isError: boolean;
}

/** Разбор тела запроса `POST /mcp/call` → валидный запрос или причина отказа. */
export function parseMcpCallRequestBody(
  body: unknown,
): { ok: true; value: McpCallRequestBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.server !== 'string' || raw.server.trim().length === 0) {
    return { ok: false, message: 'поле server обязательно: имя MCP-сервера' };
  }
  if (typeof raw.tool !== 'string' || raw.tool.trim().length === 0) {
    return { ok: false, message: 'поле tool обязательно: имя инструмента MCP-сервера' };
  }
  const value: McpCallRequestBody = { server: raw.server.trim(), tool: raw.tool.trim() };
  if (raw.arguments !== undefined) {
    if (typeof raw.arguments !== 'object' || raw.arguments === null || Array.isArray(raw.arguments)) {
      return { ok: false, message: 'поле arguments должно быть объектом' };
    }
    value.arguments = raw.arguments as Record<string, unknown>;
  }
  return { ok: true, value };
}

/**
 * HTTP-код ответа по классу ошибки.
 *
 * - `400` — некорректный запрос или `cwd` вне workspace;
 * - `401` — нет/неверный токен;
 * - `404` — запрошенный ресурс не найден (неизвестный MCP-сервер/инструмент);
 * - `429` — превышен лимит одновременных команд;
 * - `500` — прочие ошибки исполнения (включая ненулевой код выхода).
 */
export type ExecErrorStatus = 400 | 401 | 404 | 429 | 500;

export const EXEC_ERROR_STATUS: Record<ExecutorErrorReason, ExecErrorStatus> = {
  invalid_request: 400,
  cwd_outside_workspace: 400,
  unauthorized: 401,
  not_found: 404,
  too_many_requests: 429,
  timeout: 500,
  aborted: 500,
  spawn_failed: 500,
  nonzero_exit: 500,
  max_output: 500,
  internal_error: 500,
};

/** Причины порта core (`ExecutionError.reason`) — подмножество причин провода. */
export const PORT_FAILURE_REASONS = [
  'timeout',
  'aborted',
  'spawn_failed',
  'nonzero_exit',
  'max_output',
] as const;

export type PortFailureReason = (typeof PORT_FAILURE_REASONS)[number];

/** Причина на проводе — причина порта? */
export function isPortFailureReason(reason: string): reason is PortFailureReason {
  return (PORT_FAILURE_REASONS as readonly string[]).includes(reason);
}

/** Структурная проверка команды из тела запроса. */
export function isValidExecCommand(value: unknown): value is ExecCommand {
  if (typeof value !== 'object' || value === null) return false;
  const cmd = value as { kind?: unknown; command?: unknown; shell?: unknown; file?: unknown; args?: unknown };
  if (cmd.kind === 'shell') {
    if (typeof cmd.command !== 'string' || cmd.command.length === 0) return false;
    if (cmd.shell !== undefined && typeof cmd.shell !== 'string') return false;
    return true;
  }
  if (cmd.kind === 'argv') {
    if (typeof cmd.file !== 'string' || cmd.file.length === 0) return false;
    if (cmd.args !== undefined) {
      if (!Array.isArray(cmd.args)) return false;
      if (!cmd.args.every((a) => typeof a === 'string')) return false;
    }
    return true;
  }
  return false;
}

/**
 * Пределы секретов вызова (протокол 4).
 *
 * Секрет — это материал, который исполнитель записывает на диск (временный
 * ключ `0600`), поэтому размер ограничен: слишком большой ключ — это не
 * ключ, а попытка забить tmp исполнителя.
 */
export const EXEC_SECRET_LIMITS = {
  /** Максимум записей `secrets[]` в одном вызове. */
  maxEntries: 4,
  /** Максимальный размер приватного ключа, байт. */
  maxPrivateKeyBytes: 16 * 1024,
  /** Максимальный размер passphrase, байт. */
  maxPassphraseBytes: 4 * 1024,
} as const;

/**
 * Разбор `secrets[]` — валидный список секретов или причина отказа.
 *
 * Проверки строгие: неизвестный `kind`, непустой/слишком большой ключ,
 * нестроковая passphrase — отказ (`invalid_request`). Молчаливый пропуск
 * означал бы, что команда выполнится **без** ключа, а операция упадёт с
 * невнятной ошибкой аутентификации.
 */
export function parseExecSecrets(
  raw: unknown,
): { ok: true; value: ExecSecret[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'поле secrets должно быть массивом секретов вызова' };
  }
  if (raw.length > EXEC_SECRET_LIMITS.maxEntries) {
    return {
      ok: false,
      message: `поле secrets: не больше ${EXEC_SECRET_LIMITS.maxEntries} секретов на вызов`,
    };
  }
  const secrets: ExecSecret[] = [];
  for (const [index, item] of raw.entries()) {
    const where = `secrets[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, message: `поле ${where}: секрет должен быть объектом` };
    }
    const record = item as Record<string, unknown>;
    if (record.kind !== 'ssh-key') {
      return {
        ok: false,
        message: `поле ${where}.kind: поддерживается только "ssh-key"`,
      };
    }
    if (typeof record.privateKey !== 'string' || record.privateKey.length === 0) {
      return { ok: false, message: `поле ${where}.privateKey: обязательное непустое поле` };
    }
    if (Buffer.byteLength(record.privateKey, 'utf-8') > EXEC_SECRET_LIMITS.maxPrivateKeyBytes) {
      return {
        ok: false,
        message: `поле ${where}.privateKey: больше ${EXEC_SECRET_LIMITS.maxPrivateKeyBytes} байт`,
      };
    }
    const secret: ExecSecret = { kind: 'ssh-key', privateKey: record.privateKey };
    if (record.passphrase !== undefined) {
      if (typeof record.passphrase !== 'string') {
        return { ok: false, message: `поле ${where}.passphrase: должно быть строкой` };
      }
      if (Buffer.byteLength(record.passphrase, 'utf-8') > EXEC_SECRET_LIMITS.maxPassphraseBytes) {
        return {
          ok: false,
          message: `поле ${where}.passphrase: больше ${EXEC_SECRET_LIMITS.maxPassphraseBytes} байт`,
        };
      }
      secret.passphrase = record.passphrase;
    }
    secrets.push(secret);
  }
  return { ok: true, value: secrets };
}

/** Разбор тела запроса `POST /exec` → валидный запрос или причина отказа. */
export function parseExecRequestBody(
  body: unknown,
): { ok: true; value: ExecRequestBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (!isValidExecCommand(raw.command)) {
    return {
      ok: false,
      message: 'поле command обязательно: {kind:"shell",command} или {kind:"argv",file,args?}',
    };
  }
  const value: ExecRequestBody = { command: raw.command };

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) {
      return { ok: false, message: 'поле cwd должно быть непустой строкой' };
    }
    value.cwd = raw.cwd;
  }

  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      return { ok: false, message: 'поле env должно быть объектом со строковыми значениями' };
    }
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof val !== 'string') {
        return { ok: false, message: `поле env.${key} должно быть строкой` };
      }
      env[key] = val;
    }
    value.env = env;
  }

  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0) {
      return { ok: false, message: 'поле timeoutMs должно быть целым числом > 0' };
    }
    value.timeoutMs = raw.timeoutMs;
  }

  if (raw.maxOutputBytes !== undefined) {
    if (
      typeof raw.maxOutputBytes !== 'number' ||
      !Number.isInteger(raw.maxOutputBytes) ||
      raw.maxOutputBytes <= 0
    ) {
      return { ok: false, message: 'поле maxOutputBytes должно быть целым числом > 0' };
    }
    value.maxOutputBytes = raw.maxOutputBytes;
  }

  if (raw.secrets !== undefined) {
    const secrets = parseExecSecrets(raw.secrets);
    if (!secrets.ok) return secrets;
    value.secrets = secrets.value;
  }

  return { ok: true, value };
}

/** Тело запроса `POST /exec/spawn` — фоновый запуск команды. */
export interface SpawnExecRequest {
  /** Команда: shell-строка или argv (без shell). */
  command: ExecCommand;
  /** Рабочий каталог команды (внутри workspace исполнителя). */
  cwd?: string;
  /** Дополнительное окружение — мержится поверх окружения исполнителя. */
  env?: Record<string, string>;
  /**
   * Таймаут процесса, мс (`0` или не задано — без таймаута: процесс живёт,
   * пока жив; `> 0` — таймер `SIGTERM` → через 5 с `SIGKILL`).
   */
  timeoutMs?: number;
  /**
   * Требуемые бинари — принимаются, но **не проверяются**: проверка
   * бинарных требований остаётся на слое тула (как в портовом контракте
   * `ExecutionPort.spawnBackground`).
   */
  requires?: string[];
}

/** Тело успешного ответа `POST /exec/spawn`. */
export interface SpawnExecResponse {
  /** Идентификатор фонового процесса (`proc_<uuid>`). */
  processId: string;
  /** pid процесса ОС (не задан, если запуск не удался). */
  pid?: number;
}

/** Статус фонового процесса. */
export type BackgroundProcessStatus = 'running' | 'exited' | 'failed' | 'killed';

/** Тело ответа `GET /exec/:processId` — состояние фонового процесса. */
export interface BackgroundStatusResponse {
  /** Идентификатор фонового процесса (`proc_<uuid>`). */
  processId: string;
  /** pid процесса ОС (не задан, если запуск не удался). */
  pid?: number;
  /** Команда запуска. */
  command: ExecCommand;
  /** Рабочий каталог. */
  cwd: string;
  /** Статус процесса. */
  status: BackgroundProcessStatus;
  /** Код завершения; `null` — процесс убит сигналом или ещё жив. */
  exitCode: number | null;
  /** Сигнал завершения; `null` — процесс вышел сам. */
  signal: string | null;
  /** Момент старта, мс. */
  startedAt: number;
  /** Момент завершения, мс (не задан, пока процесс жив). */
  finishedAt?: number;
  /** Длительность жизни процесса, мс (не задана, пока процесс жив). */
  durationMs?: number;
  /** Записано байт в stdout. */
  stdoutBytes: number;
  /** Записано байт в stderr. */
  stderrBytes: number;
  /** Хотя бы один поток упёрся в лимит журнала. */
  truncated: boolean;
}

/** Отрезок журнала фонового процесса. */
export interface BackgroundLogChunkBody {
  /** Текст отрезка (UTF-8). */
  content: string;
  /** Смещение, с которого прочитан отрезок. */
  offset: number;
  /** Смещение следующего чтения. */
  nextOffset: number;
}

/** Тело ответа `GET /exec/:processId/logs`. */
export interface BackgroundLogsResponse {
  /** Идентификатор фонового процесса (`proc_<uuid>`). */
  processId: string;
  /** Статус процесса. */
  status: BackgroundProcessStatus;
  /** Код завершения. */
  exitCode: number | null;
  /** Сигнал завершения. */
  signal: string | null;
  /** Отрезок stdout. */
  stdout: BackgroundLogChunkBody;
  /** Отрезок stderr. */
  stderr: BackgroundLogChunkBody;
  /** Всего записано байт (stdout + stderr). */
  totalBytes: number;
  /** Хотя бы один поток упёрся в лимит журнала. */
  truncated: boolean;
}

/** Тело ответа `POST /exec/:processId/stop`. */
export interface StopBackgroundResponse {
  /** Процесс остановлен (или уже завершается) — `stopping`. */
  status: 'stopping';
}

/**
 * Сигналы остановки фонового процесса, которые принимает исполнитель.
 *
 * Белый список: `SIGTERM` — мягкое завершение, `SIGKILL` — немедленное.
 * Прочие сигналы отклоняются (`400 invalid_request`): набор допустимых
 * сигналов — часть контракта, а не поведение «как придёт».
 */
export const BACKGROUND_STOP_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;

/** Допустимый сигнал остановки фонового процесса. */
export type BackgroundStopSignal = (typeof BACKGROUND_STOP_SIGNALS)[number];

/** Тело запроса `POST /exec/:processId/stop`. */
export interface StopBackgroundRequest {
  /** Сигнал остановки (по умолчанию — `SIGTERM`). */
  signal?: BackgroundStopSignal;
}

/**
 * Разбор тела запроса `POST /exec/:processId/stop`.
 *
 * Пустое тело (или его отсутствие) — `SIGTERM` (прежнее поведение).
 * Невалидный сигнал — отказ: `invalid_request`.
 */
export function parseStopBackgroundRequestBody(
  body: unknown,
): { ok: true; value: StopBackgroundRequest } | { ok: false; message: string } {
  if (body === undefined || body === null) {
    return { ok: true, value: {} };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (raw.signal === undefined) {
    return { ok: true, value: {} };
  }
  if (
    typeof raw.signal !== 'string' ||
    !(BACKGROUND_STOP_SIGNALS as readonly string[]).includes(raw.signal)
  ) {
    return {
      ok: false,
      message: `поле signal должно быть одним из: ${BACKGROUND_STOP_SIGNALS.join(', ')}`,
    };
  }
  return { ok: true, value: { signal: raw.signal as BackgroundStopSignal } };
}

/**
 * Разбор тела запроса `POST /exec/spawn` → валидный запрос или причина отказа.
 *
 * Правила те же, что у `parseExecRequestBody`, но без `maxOutputBytes`
 * (в фоне вывод не буферизуется) и с полем `requires`.
 */
export function parseSpawnExecRequestBody(
  body: unknown,
): { ok: true; value: SpawnExecRequest } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (!isValidExecCommand(raw.command)) {
    return {
      ok: false,
      message: 'поле command обязательно: {kind:"shell",command} или {kind:"argv",file,args?}',
    };
  }
  // Секреты вызова в фоне не поддерживаются: фоновый процесс переживает
  // вызов, а материал доставляется «на время вызова» (протокол 4).
  if (raw.secrets !== undefined) {
    return {
      ok: false,
      message: 'секреты доступны только для синхронного /exec (фоновые процессы их не поддерживают)',
    };
  }
  const value: SpawnExecRequest = { command: raw.command };

  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.length === 0) {
      return { ok: false, message: 'поле cwd должно быть непустой строкой' };
    }
    value.cwd = raw.cwd;
  }

  if (raw.env !== undefined) {
    if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
      return { ok: false, message: 'поле env должно быть объектом со строковыми значениями' };
    }
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof val !== 'string') {
        return { ok: false, message: `поле env.${key} должно быть строкой` };
      }
      env[key] = val;
    }
    value.env = env;
  }

  if (raw.timeoutMs !== undefined) {
    // Фоновый процесс по умолчанию **без таймаута** — порт передаёт `0`
    // (`timeoutMs: 0`), поэтому ноль допустим; отрицательное значение — нет.
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 0) {
      return { ok: false, message: 'поле timeoutMs должно быть целым числом >= 0' };
    }
    value.timeoutMs = raw.timeoutMs;
  }

  if (raw.requires !== undefined) {
    if (
      !Array.isArray(raw.requires) ||
      !raw.requires.every((item) => typeof item === 'string' && item.length > 0)
    ) {
      return { ok: false, message: 'поле requires должно быть массивом непустых строк' };
    }
    value.requires = [...(raw.requires as string[])];
  }

  return { ok: true, value };
}

/** Ошибочный ответ с корректным HTTP-кодом. */
export function errorResponse(
  reason: ExecutorErrorReason,
  message: string,
  extra: Partial<Omit<ExecErrorBody, 'reason' | 'message'>> = {},
): { status: ExecErrorStatus; body: ExecErrorResponse } {
  const body: ExecErrorBody = {
    reason,
    code: extra.code ?? null,
    message,
    stdout: extra.stdout ?? '',
    stderr: extra.stderr ?? '',
    killed: extra.killed ?? false,
    signal: extra.signal ?? null,
    truncated: extra.truncated ?? false,
    durationMs: extra.durationMs ?? 0,
  };
  return { status: EXEC_ERROR_STATUS[reason], body: { error: body } };
}
