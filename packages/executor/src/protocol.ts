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
 * `too_many_requests` | `policy_denied` | `internal_error`).
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
 * - `mode` (протокол 6, PROP-124 §2) — режим доставки ключа: `git`
 *   (по умолчанию; ключ файлом + `GIT_SSH_COMMAND`) либо `agent`
 *   (эфемерный `ssh-agent`: `SSH_AUTH_SOCK`, ключ удаляется после `ssh-add`);
 *   иное значение — `400 invalid_request`;
 * - в `POST /exec/spawn` (фоновые процессы) секреты принимаются **на тех же
 *   условиях** (протокол 6, PROP-124 §7): те же лимиты и валидация, что у
 *   `POST /exec`; исполнитель материализует материал у себя и гасит его
 *   вместе с процессом (выход, `stop()`, таймаут). Признак поддержки —
 *   `features.secretsSpawn: true` в `GET /capabilities` (старый исполнитель
 *   признака не объявляет → адрес не выбирается, тихого фоллбека нет);
 * - признак поддержки синхронной доставки — `features.secrets: true` в
 *   `GET /capabilities` (и версия протокола ≥ 4); агентный режим —
 *   `features.sshAgent: true` (протокол ≥ 6).
 *
 * ## PTY-сессии (протокол 8)
 *
 * Псевдотерминал на исполнителе (план терминалов, Ф2a): оболочка живёт там,
 * где есть toolchain и рабочий каталог, а control plane общается с ней по
 * проводу.
 *
 * - `POST /pty/open` — тело `{ id?, cwd, shell?, args?, cols, rows, env? }` →
 *   `201 { id, pid?, cols, rows }`; `id` — **идемпотентность открытия**
 *   (повторный `open` с тем же `id` возвращает ту же сессию, `200`);
 * - `POST /pty/:id/input` — тело `{ data }` → запись во вход терминала;
 * - `POST /pty/:id/resize` — тело `{ cols, rows }` → изменение размера;
 * - `POST /pty/:id/close` → закрытие сессии (`SIGTERM` группе → 1 с →
 *   `SIGKILL`);
 * - `GET /pty/:id/status` → `200 { id, pid?, cols, rows, exited, exitCode?,
 *   signal?, seq }`;
 * - `GET /pty/:id/stream?since=` → **NDJSON** поток кадров
 *   `{"seq":n,"data":"…"}`: сначала буфер повтора (256 КиБ), затем живые
 *   кадры; `since` — номер последнего кадра, который видел клиент.
 *
 * Отказы: `501 pty_unsupported` (контур выключен — `SYNTH_EXECUTOR_PTY=0`, или
 * нативный модуль не загрузился), `404 pty_not_found` (сессии нет),
 * `429 pty_limit` (превышен лимит живых сессий), `400 cwd_outside_workspace`
 * (`cwd` вне workspace), `400 invalid_request` (невалидное тело/размеры).
 */

import type { ExecCommand, ExecSecret } from '@itphx/synth-core';

/**
 * Версия wire-протокола исполнителя.
 *
 * **8** — PTY-сессии (`/pty/open`, `/pty/:id/input`, `/pty/:id/resize`,
 * `/pty/:id/close`, `/pty/:id/status`, `/pty/:id/stream`) и признак
 * `features.pty` (план терминалов, Ф2a). Старый исполнитель (≤ 7) признака
 * не объявляет ⇒ control plane **не выбирает** такой адрес для терминала
 * (тихого фоллбека в inline нет: терминал должен жить там же, где
 * toolchain). Версия **повышается** — в отличие от FS-роутов: это новая
 * фича, а не расширение существующей.
 *
 * **7** — FS-операции (`/fs/stat`, `/fs/realpath`, `/fs/list`, `/fs/read-text`,
 * `/fs/sniff`, `/fs/read-bytes`, `/fs/write-file`, `/fs/mkdir`, `/fs/remove`) и
 * признак `features.fs`; старый исполнитель ≤ 6 признака не объявляет ⇒
 * файловые тулы в remote fail-closed (PROP-135). Тихого возврата в control
 * plane нет: рабочий каталог в split-топологии живёт на исполнителе.
 * Версия **не повышается** при добавлении записи/удаления (Ф2) — это та же
 * фича `features.fs`, расширенная аддитивными роутами.
 *
 * **6** — ssh-агент для секрета вызова (PROP-124 §2): у секрета появилось
 * аддитивное поле `mode` (`git` | `agent`), а исполнитель объявляет признак
 * `features.sshAgent: true` — он умеет материализовать ключ в эфемерный
 * `ssh-agent` (`SSH_AUTH_SOCK`), а не только файлом в `GIT_SSH_COMMAND`.
 * Старый исполнитель (≤ 5) поля `mode` не знает ⇒ агентный режим ему не
 * доступен (тихого фоллбека в git-режим нет).
 *
 * **5** — вложения MCP-результата (`attachments[]` в ответе `POST /mcp/call`,
 * ADR-115/ADR-077): нетекстовые блоки (`image`/`audio`/`resource.blob`)
 * передаются в base64, control plane материализует их в blob-хранилище.
 * Признак — `features.mcpAttachments: true`. Старый исполнитель (≤ 4) вложений
 * не отдаёт — control plane работает как прежде, только с текстом (деградация
 * без падения).
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
 *
 * **Поле `limits` в `/capabilities` — аддитивное, версию не повышает**
 * (как `features` и `attachments`): исполнитель объявляет эффективные
 * потолки таймаута и буфера вывода, чтобы control plane видел «тихий» потолок
 * заранее. Старый исполнитель поля не отдаёт — разбор терпимый.
 */
export const EXECUTOR_PROTOCOL_VERSION = 8;

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
  /**
   * Путь существует, но это не каталог (FS-операция, протокол 7).
   *
   * Отдельная причина от `not_found`: вызывающий различает «нет такого пути»
   * и «путь есть, но листинг неприменим» — ответы различаются.
   */
  | 'not_directory'
  /**
   * Нет доступа к пути (FS-операция, протокол 7) — `EACCES`/`EPERM`.
   */
  | 'permission'
  /**
   * Путь не разрешается: битый симлинк, цикл симлинков, ошибка ФС
   * (FS-операция, протокол 7). Fail-closed: «угадывать» лексический путь
   * нельзя — это потенциальный обход периметра.
   */
  | 'unresolvable'
  /**
   * Объект больше запрошенного лимита (чтение байтов, протокол 7).
   *
   * Отдельная причина от `not_found`: файл **есть**, но он не влезает в
   * потолок перевозки — вызывающий различает «нет такого пути» и «файл
   * слишком большой».
   */
  | 'too_large'
  /**
   * Цель уже существует (публикация байтов, протокол 7).
   *
   * Отдельная причина от `not_found`: путь **есть** — и именно из-за этого
   * публикация отказана (файл не перезаписывается). HTTP-код — `409`.
   */
  | 'exists'
  /**
   * Тело запроса больше потолка (публикация байтов, протокол 7).
   *
   * Транспортная причина (не FS-ошибка): тело не влезает в потолок
   * исполнителя — HTTP-код `413`.
   */
  | 'payload_too_large'
  /** Превышен лимит одновременных команд. */
  | 'too_many_requests'
  /**
   * Внешний чекер команд запретил запуск (PROP-136b).
   *
   * Отдельная причина: команда **не запускалась вовсе** (отказ до `spawn`), и
   * вызывающий должен отличать это от неудачи исполнения. HTTP-код — `403`.
   */
  | 'policy_denied'
  /**
   * PTY недоступен на исполнителе (протокол 8): контур выключен
   * (`SYNTH_EXECUTOR_PTY=0`) либо нативный модуль терминала не загрузился.
   *
   * Отдельная причина от `internal_error`: вызывающий знает, что PTY здесь
   * **не будет** (адрес не выбирается), а не «сломалось». HTTP-код — `501`.
   */
  | 'pty_unsupported'
  /**
   * PTY-сессия не найдена (протокол 8) — неизвестный `id` или уже закрытая
   * и вычищенная сессия. HTTP-код — `404`.
   */
  | 'pty_not_found'
  /**
   * Превышен лимит живых PTY-сессий исполнителя (протокол 8).
   *
   * HTTP-код — `429`: лимит ресурса, а не конфликт состояния.
   */
  | 'pty_limit'
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

/** Эффективные лимиты исполнителя (`limits` в `GET /capabilities`). */
export interface ExecutorLimits {
  /** Потолок таймаута команды, мс (запрос выше — урезается до потолка). */
  timeoutMs: number;
  /** Потолок буфера вывода, байт (запрос выше — урезается до потолка). */
  maxOutputBytes: number;
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
   *
   * `mcpAttachments: true` — исполнитель отдаёт нетекстовые вложения
   * MCP-результата (`attachments[]` в `POST /mcp/call`, протокол 5, ADR-115).
   *
   * `sshAgent: true` — исполнитель умеет материализовать секрет вызова в
   * эфемерный `ssh-agent` (`mode: 'agent'`, протокол 6, PROP-124 §2):
   * `SSH_AUTH_SOCK` в окружении вызова, приватный ключ удаляется с диска
   * сразу после `ssh-add`.
   *
   * `secretsSpawn: true` — исполнитель принимает секреты вызова **в
   * фоновом запуске** (`secrets[]` в `POST /exec/spawn`, протокол 6,
   * PROP-124 §7): материал готовится у исполнителя и гасится вместе с
   * процессом. Признак — **только** явный: у старого исполнителя протокола
   * 6 его нет, поэтому control plane такой адрес не выбирает (тихого фоллбека
   * нет — процесс не должен пойти без ключа).
   */
  features?: ExecutorFeatures;
  /**
   * Эффективные лимиты исполнителя (аддитивно: старый control plane поле
   * просто не читает; у старого исполнителя поля нет — это норма).
   *
   * Поле снимает «тихий» потолок: control plane видит, чем исполнитель
   * ограничивает таймаут и буфер вывода, и может сообщить об этом заранее,
   * а не обнаружить усечение по факту.
   */
  limits?: ExecutorLimits;
}

/** Необязательные возможности исполнителя. */
export interface ExecutorFeatures {
  /** Фоновые процессы (`POST /exec/spawn`). */
  background?: boolean;
  /** Секреты вызова (`secrets[]` в `POST /exec`, протокол 4). */
  secrets?: boolean;
  /** Вложения MCP-результата (`attachments[]` в `POST /mcp/call`, протокол 5). */
  mcpAttachments?: boolean;
  /**
   * Секрет вызова в режиме ssh-агента (`mode: 'agent'`, протокол 6,
   * PROP-124 §2): эфемерный `ssh-agent` (`SSH_AUTH_SOCK`), приватный ключ
   * удаляется с диска сразу после `ssh-add`.
   */
  sshAgent?: boolean;
  /**
   * Секреты вызова в **фоновом** запуске (`secrets[]` в `POST /exec/spawn`,
   * протокол 6, PROP-124 §7): материал готовится у исполнителя и гасится
   * вместе с процессом (выход, `stop()`, таймаут).
   *
   * Признак **явный**: у старого исполнителя протокола 6 его нет — такой
   * адрес в кандидаты на фоновый запуск с секретами не попадает.
   */
  secretsSpawn?: boolean;
  /**
   * FS-операции (`/fs/stat`, `/fs/realpath`, `/fs/list`, протокол 7,
   * PROP-135): исполнитель умеет отдавать сведения о файлах и каталогах
   * своего workspace.
   *
   * Признак — **явный и обязательный**: старый исполнитель (≤ 6) его не
   * объявляет, и control plane такой адрес для файловых тулов **не
   * выбирает** — тихого возврата в control plane нет (рабочий каталог в
   * split-топологии живёт на исполнителе).
   */
  fs?: boolean;
  /**
   * PTY-сессии (протокол 8): исполнитель умеет открывать псевдотерминал
   * (`POST /pty/open`).
   *
   * Признак — **явный**: старый исполнитель (≤ 7) его не объявляет, и
   * control plane такой адрес для терминала **не выбирает** — тихого
   * возврата в inline нет (терминал должен жить там же, где toolchain).
   */
  pty?: boolean;
}

/** Ответ `GET /health`. */
export interface ExecutorHealth {
  status: 'ok';
  protocol: number;
  uptimeSec: number;
  concurrency: { limit: number; active: number };
  /** Фоновые процессы (ADR-077, шаг 7c). */
  background?: { limit: number; active: number };
  /** PTY-сессии (протокол 8). */
  pty?: { limit: number; active: number };
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
  /**
   * ADR-115 (протокол 5): нетекстовые блоки результата в base64. Поле
   * аддитивное — старый control plane его просто не читает; `isError` → не
   * заполняется.
   */
  attachments?: McpAttachmentPayloadBody[];
}

/** Вложение MCP-результата на проводе (ADR-115). */
export interface McpAttachmentPayloadBody {
  /** MIME из блока MCP (`mimeType`); уточняется сервисом вложений control plane. */
  mime: string;
  /** Имя файла, если оно есть в блоке (`resource.uri`). */
  name?: string;
  /** Содержимое в base64 (без `data:`-префикса). */
  base64: string;
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
 * - `400` — некорректный запрос, `cwd` вне workspace, путь не каталог или
 *   не разрешается;
 * - `401` — нет/неверный токен;
 * - `403` — нет доступа к пути (FS-операция, протокол 7) либо запуск запрещён
 *   внешним чекером команд (`policy_denied`, PROP-136b);
 * - `404` — запрошенный ресурс не найден (неизвестный MCP-сервер/инструмент,
 *   отсутствующий путь);
 * - `409` — цель уже существует (публикация байтов, протокол 7);
 * - `413` — тело запроса больше потолка (публикация байтов, протокол 7);
 * - `429` — превышен лимит одновременных команд или живых PTY-сессий;
 * - `500` — прочие ошибки исполнения (включая ненулевой код выхода);
 * - `501` — PTY недоступен на исполнителе (протокол 8).
 */
export type ExecErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 501;

export const EXEC_ERROR_STATUS: Record<ExecutorErrorReason, ExecErrorStatus> = {
  invalid_request: 400,
  cwd_outside_workspace: 400,
  unauthorized: 401,
  not_found: 404,
  not_directory: 400,
  permission: 403,
  unresolvable: 400,
  too_large: 400,
  exists: 409,
  payload_too_large: 413,
  too_many_requests: 429,
  // PROP-136b: отказ внешнего чекера команд — команда не запускается.
  policy_denied: 403,
  // Протокол 8: PTY-контур.
  pty_unsupported: 501,
  pty_not_found: 404,
  pty_limit: 429,
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
  // PROP-136b: решение внешнего чекера — причина порта core (не `spawn_failed`),
  // иначе отказ политики выглядел бы как сбой запуска.
  'policy_denied',
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
 * нестроковая passphrase, неизвестный `mode` — отказ (`invalid_request`).
 * Молчаливый пропуск означал бы, что команда выполнится **без** ключа, а
 * операция упадёт с невнятной ошибкой аутентификации.
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
    // Режим доставки ключа (PROP-124 §2): `git` (по умолчанию) либо `agent`.
    // Неизвестное значение — отказ: молчаливый фоллбек в git-режим означал бы,
    // что команда выполнится без `SSH_AUTH_SOCK` (тихий сбой аутентификации).
    if (record.mode !== undefined) {
      if (record.mode !== 'git' && record.mode !== 'agent') {
        return {
          ok: false,
          message: `поле ${where}.mode: поддерживаются только "git" и "agent"`,
        };
      }
      secret.mode = record.mode;
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
  /**
   * Секреты вызова (протокол 6, PROP-124 §7): материал, нужный фоновому
   * процессу **на время его жизни** — исполнитель материализует его у себя
   * и гасит вместе с процессом (выход, `stop()`, таймаут). Лимиты и
   * валидация — те же, что у `POST /exec` (`parseExecSecrets`); значения не
   * логируются и не возвращаются в ответе.
   */
  secrets?: ExecSecret[];
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
 *
 * Секреты вызова принимаются **на тех же условиях**, что у `POST /exec`
 * (протокол 6, PROP-124 §7): тот же разбор `parseExecSecrets` — те же
 * лимиты и та же строгость. Молчаливый пропуск означал бы, что процесс
 * пойдёт **без ключа**, а операция упадёт с невнятной ошибкой
 * аутентификации.
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

  // Секреты вызова в фоне (протокол 6, PROP-124 §7) — тот же разбор, что у
  // `POST /exec`: те же лимиты и та же строгость (молчаливый пропуск ключа
  // означал бы запуск фонового процесса без ключа).
  if (raw.secrets !== undefined) {
    const secrets = parseExecSecrets(raw.secrets);
    if (!secrets.ok) return secrets;
    value.secrets = secrets.value;
  }

  return { ok: true, value };
}

/**
 * Тело запроса FS-операции (протокол 7, PROP-135): `/fs/stat`,
 * `/fs/realpath`, `/fs/list`.
 */
export interface FsRequestBody {
  /**
   * Путь к объекту.
   *
   * Абсолютный — используется как есть (тот же уровень доверия, что у
   * shell-команд; внешние пути уже отфильтрованы permission-слоем в control
   * plane). Относительный — резолвится от `cwd` (по умолчанию — корень
   * workspace исполнителя).
   */
  path: string;
  /**
   * Базовый каталог для относительного `path`.
   *
   * Обязан лежать внутри workspace исполнителя — та же проверка
   * containment'а, что и у `cwd` команды (`resolveContainedCwd`).
   */
  cwd?: string;
}

/** Вид объекта ФС на проводе. */
export type FsEntryKindBody = 'file' | 'directory' | 'other';

/** Сведения о файле/каталоге на проводе. */
export interface FsStatBody {
  kind: FsEntryKindBody;
  /** Размер в байтах; у каталога — `0`. */
  size: number;
  /** Время последнего изменения, мс. */
  mtimeMs: number;
}

/** Запись каталога на проводе. */
export interface FsDirEntryBody {
  name: string;
  kind: FsEntryKindBody;
  /** Размер в байтах; `0`, если `stat` записи не удался. */
  size: number;
}

/** Ответ `POST /fs/stat`. */
export interface FsStatResponse {
  stat: FsStatBody;
}

/** Ответ `POST /fs/realpath`. */
export interface FsRealpathResponse {
  /** Канонический путь. */
  path: string;
}

/** Ответ `POST /fs/list`. */
export interface FsListResponse {
  entries: FsDirEntryBody[];
}

/**
 * Тело запроса чтения текста (`POST /fs/read-text`, протокол 7).
 *
 * `offset`/`limit`/`maxBytes` — потолки страницы; не заданы — дефолты
 * исполнителя (те же, что у локального тула чтения).
 */
export interface FsTextRequestBody {
  path: string;
  cwd?: string;
  /** Номер первой строки (0-based); нумерация в выводе — исходная (1-based). */
  offset?: number;
  /** Максимум строк в странице. */
  limit?: number;
  /** Максимум байт вывода (UTF-8). */
  maxBytes?: number;
}

/** Тело запроса детекта содержимого (`POST /fs/sniff`). */
export interface FsSniffRequestBody {
  path: string;
  cwd?: string;
  /** Сколько первых байт смотреть (по умолчанию — 8 КиБ). */
  maxBytes?: number;
}

/** Тело запроса чтения байтов (`POST /fs/read-bytes`). */
export interface FsBytesRequestBody {
  path: string;
  cwd?: string;
  /** Потолок размера файла, байт (обязателен: файл больше — `too_large`). */
  maxBytes: number;
}

/** Страница текста на проводе. */
export interface FsTextPageBody {
  /** Готовые строки вывода (`N: текст`, нумерация исходная 1-based). */
  lines: string[];
  /** Всего строк в файле. */
  totalLines: number;
  /** Вывод усечён (по числу строк или по байтам). */
  truncated: boolean;
  /** Размер вывода в байтах (UTF-8). */
  bytes: number;
}

/** Ответ `POST /fs/read-text`. */
export interface FsTextResponse {
  page: FsTextPageBody;
}

/** Признак «бинарь» и MIME на проводе. */
export interface FsSniffBody {
  /** Файл выглядит бинарным (не текст). */
  binary: boolean;
  /** MIME по сигнатуре (если распознан). */
  mime?: string;
}

/** Ответ `POST /fs/sniff`. */
export interface FsSniffResponse {
  sniff: FsSniffBody;
}

/** Байты файла на проводе. */
export interface FsBytesBody {
  /** Содержимое в base64 (без `data:`-префикса). */
  dataBase64: string;
  /** Размер в байтах. */
  size: number;
}

/** Ответ `POST /fs/read-bytes`. */
export interface FsBytesResponse {
  bytes: FsBytesBody;
}

/**
 * Разбор тела FS-запроса → валидный запрос или причина отказа.
 *
 * Проверки строгие: путь обязателен, непустой и без NUL; `cwd` — необязателен,
 * но тоже непустой и без NUL. Молчаливый пропуск означал бы, что операция
 * выполнится над **не тем** путём (пустой путь — это корень процесса, а не
 * «каталог по умолчанию»).
 */
export function parseFsRequestBody(
  body: unknown,
): { ok: true; value: FsRequestBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
    return { ok: false, message: 'поле path обязательно: непустая строка' };
  }
  if (raw.path.includes('\0')) {
    return { ok: false, message: 'поле path содержит недопустимые символы' };
  }
  const value: FsRequestBody = { path: raw.path };
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== 'string' || raw.cwd.trim().length === 0) {
      return { ok: false, message: 'поле cwd должно быть непустой строкой' };
    }
    if (raw.cwd.includes('\0')) {
      return { ok: false, message: 'поле cwd содержит недопустимые символы' };
    }
    value.cwd = raw.cwd;
  }
  return { ok: true, value };
}

/**
 * Разбор тела запроса чтения текста (`POST /fs/read-text`).
 *
 * База — `parseFsRequestBody` (путь обязателен, `cwd` необязателен); сверху
 * — потолки страницы: `offset` ≥ 0, `limit`/`maxBytes` — положительные целые.
 * Молчаливый пропуск означал бы, что читается не та страница, которую
 * запросили.
 */
export function parseFsTextRequestBody(
  body: unknown,
): { ok: true; value: FsTextRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  const value: FsTextRequestBody = { ...base.value };

  if (raw.offset !== undefined) {
    if (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0) {
      return { ok: false, message: 'поле offset должно быть целым числом >= 0' };
    }
    value.offset = raw.offset;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit <= 0) {
      return { ok: false, message: 'поле limit должно быть целым числом > 0' };
    }
    value.limit = raw.limit;
  }
  if (raw.maxBytes !== undefined) {
    if (typeof raw.maxBytes !== 'number' || !Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
      return { ok: false, message: 'поле maxBytes должно быть целым числом > 0' };
    }
    value.maxBytes = raw.maxBytes;
  }
  return { ok: true, value };
}

/**
 * Разбор тела запроса детекта содержимого (`POST /fs/sniff`).
 *
 * База — `parseFsRequestBody`; сверху — необязательный потолок `maxBytes`.
 */
export function parseFsSniffRequestBody(
  body: unknown,
): { ok: true; value: FsSniffRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  const value: FsSniffRequestBody = { ...base.value };
  if (raw.maxBytes !== undefined) {
    if (typeof raw.maxBytes !== 'number' || !Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
      return { ok: false, message: 'поле maxBytes должно быть целым числом > 0' };
    }
    value.maxBytes = raw.maxBytes;
  }
  return { ok: true, value };
}

/**
 * Разбор тела запроса чтения байтов (`POST /fs/read-bytes`).
 *
 * `maxBytes` **обязателен**: без потолка размер не ограничен, и файл любого
 * размера уехал бы в ответе целиком.
 */
export function parseFsBytesRequestBody(
  body: unknown,
): { ok: true; value: FsBytesRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  if (typeof raw.maxBytes !== 'number' || !Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
    return { ok: false, message: 'поле maxBytes обязательно: целое число > 0 (потолок размера файла)' };
  }
  return { ok: true, value: { ...base.value, maxBytes: raw.maxBytes } };
}

/**
 * Тело запроса записи файла (`POST /fs/write-file`, протокол 7, PROP-135 Ф2).
 *
 * `content` — текст файла целиком (запись строковая: бинарные данные через
 * порт не едут — это Ф3, потоковая передача).
 */
export interface FsWriteRequestBody {
  path: string;
  cwd?: string;
  /** Новое содержимое файла. */
  content: string;
}

/**
 * Тело запроса создания каталога (`POST /fs/mkdir`).
 */
export interface FsMkdirRequestBody {
  path: string;
  cwd?: string;
}

/**
 * Тело запроса удаления (`POST /fs/remove`).
 */
export interface FsRemoveRequestBody {
  path: string;
  cwd?: string;
}

/**
 * Тело запроса чтения «сырого» текста (`POST /fs/read-raw`).
 *
 * `maxBytes` **обязателен**: без потолка размер не ограничен, и файл любого
 * размера уехал бы в ответе целиком.
 */
export interface FsRawTextRequestBody {
  path: string;
  cwd?: string;
  /** Потолок размера файла, байт (файл больше — `too_large`). */
  maxBytes: number;
}

/**
 * Тело запроса переименования (`POST /fs/rename`).
 *
 * `path` — источник, `to` — цель; обе стороны резолвятся от `cwd` (как и
 * остальные пути FS-операций).
 */
export interface FsRenameRequestBody {
  /** Текущий путь файла (источник). */
  path: string;
  /** Новый путь файла (цель). */
  to: string;
  cwd?: string;
}

/**
 * Тело запроса бинарной передачи файла (`POST /fs/download`).
 *
 * `maxBytes` — потолок размера файла **вызывающего**: файл больше — отказ
 * `too_large` (файл не читается вовсе, размер известен до чтения).
 */
export interface FsDownloadRequestBody {
  /** Путь файла. */
  path: string;
  cwd?: string;
  /** Потолок размера файла, байт (обязателен: файл больше — `too_large`). */
  maxBytes: number;
}

/**
 * Тело запроса вычисления хэша файла (`POST /fs/hash`).
 *
 * Путь и `cwd` — как у прочих FS-операций (`parseFsRequestBody`).
 */
export interface FsHashRequestBody {
  path: string;
  cwd?: string;
}

/** Ответ `POST /fs/hash` — SHA-256 файла (hex). */
export interface FsHashResponse {
  /** SHA-256 файла в hex (строчные буквы). */
  sha256: string;
}

/**
 * Что делать, если цель уже существует (публикация байтов, протокол 7).
 *
 * `fail` (по умолчанию) — отказ `exists` (цель не перезаписывается);
 * `overwrite` — атомарная замена (права существующего файла сохраняются).
 */
export type FsUploadMode = 'fail' | 'overwrite';

/**
 * Разобранные параметры публикации байтов (`PUT /fs/upload`).
 *
 * Путь и `cwd` — как у прочих FS-операций; `ifExists` — режим публикации.
 */
export interface FsUploadRequest {
  /** Путь целевого файла. */
  path: string;
  /** Базовый каталог для относительного `path`. */
  cwd?: string;
  /** Что делать, если цель уже существует. */
  ifExists: FsUploadMode;
}

/**
 * Разбор query-параметров публикации байтов (`PUT /fs/upload`).
 *
 * Параметры — **в query**, а не в теле: тело запроса — сырые байты
 * (`application/octet-stream`), JSON-обёртка раздула бы их и мешала бы
 * потоковой передаче. Значения — URL-encoded (путь может содержать `/`,
 * пробелы и не-ASCII).
 *
 * Проверки строгие: `path` обязателен (непустая строка без NUL), `cwd` —
 * необязателен, но тоже непустой и без NUL, `ifExists` — только `fail` или
 * `overwrite`. Молчаливый пропуск означал бы запись **не туда**.
 */
export function parseFsUploadQuery(
  query: URLSearchParams,
): { ok: true; value: { path: string; cwd?: string; ifExists: FsUploadMode } } | { ok: false; message: string } {
  const path = query.get('path');
  if (path === null || path.trim().length === 0) {
    return { ok: false, message: 'параметр path обязателен: непустая строка' };
  }
  if (path.includes('\0')) {
    return { ok: false, message: 'параметр path содержит недопустимые символы' };
  }
  const cwd = query.get('cwd');
  if (cwd !== null) {
    if (cwd.trim().length === 0) {
      return { ok: false, message: 'параметр cwd должен быть непустой строкой' };
    }
    if (cwd.includes('\0')) {
      return { ok: false, message: 'параметр cwd содержит недопустимые символы' };
    }
  }
  const rawMode = query.get('ifExists');
  let ifExists: FsUploadMode = 'fail';
  if (rawMode !== null) {
    if (rawMode !== 'fail' && rawMode !== 'overwrite') {
      return { ok: false, message: 'параметр ifExists: поддерживаются только "fail" и "overwrite"' };
    }
    ifExists = rawMode;
  }
  return {
    ok: true,
    value: {
      path,
      ...(cwd !== null ? { cwd } : {}),
      ifExists,
    },
  };
}

/** Текст файла на проводе (как есть, без нумерации строк). */
export interface FsRawTextBody {
  /** Содержимое файла (UTF-8, без нумерации строк). */
  text: string;
  /** Размер файла в байтах. */
  size: number;
}

/** Ответ `POST /fs/read-raw`. */
export interface FsRawTextResponse {
  raw: FsRawTextBody;
}

/**
 * Потолок тела запроса чтения «сырого» текста (`POST /fs/read-raw`), байт.
 *
 * Текст едет по проводу **целиком** (строкой), поэтому размер ограничен:
 * иначе один вызов `edit_file`/`patch` может забить память исполнителя.
 * Потолок **выше** прикладного лимита тула (`MAX_TOOL_FILE_BYTES` = 5 МиБ в
 * core) — транспортный запас.
 */
export const EXECUTOR_FS_MAX_READ_RAW_BYTES = 16 * 1024 * 1024;

/**
 * Потолок тела запроса записи (`POST /fs/write-file`), байт (UTF-8).
 *
 * Содержимое едет по проводу **целиком** (строкой), поэтому размер должен быть
 * ограничен: иначе один вызов `write_file` может забить память исполнителя.
 * Потолок **выше** прикладного лимита тула (`MAX_TOOL_FILE_BYTES` = 5 МиБ в
 * core) — транспортный запас на разницу кодировок/обёрток не нужен, запас
 * нужен на «файл крупнее лимита тула»: такой вызов отсекается на стороне
 * control plane, а исполнитель получает только то, что прошло лимит.
 */
export const EXECUTOR_FS_MAX_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * Потолок бинарной передачи файла (`POST /fs/download`), байт.
 *
 * Файл едет по проводу **бинарно** (без base64) — потолок выше, чем у
 * base64-роутов: раздувания ×4/3 нет. 100 МиБ — потолок исполнителя;
 * прикладной лимит (`attachments.maxBytesPerFile`, по умолчанию те же 100 МиБ)
 * остаётся на туле, а исполнитель **обрезает** свой потолок до меньшего из
 * двух (`min`), а не отвергает запрос: иначе конфиг инстанса с лимитом выше
 * потолка исполнителя давал бы невнятный `invalid_request`.
 */
export const EXECUTOR_FS_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Потолок тела публикации байтов (`PUT /fs/upload`), байт.
 *
 * Байты едут по проводу **бинарно** (без base64) — потолок тот же, что у
 * бинарной передачи файла: прикладной лимит (`attachments.maxBytesPerFile`,
 * по умолчанию те же 100 МиБ) остаётся на туле, а исполнитель **отвергает**
 * тело больше своего потолка (`413 payload_too_large`): тело уже пришло —
 * обрезать его нельзя, а принять частично нельзя тем более.
 */
export const EXECUTOR_FS_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Разбор тела запроса записи файла (`POST /fs/write-file`).
 *
 * База — `parseFsRequestBody` (путь обязателен, `cwd` необязателен); сверху —
 * `content` (обязательная строка) и потолок размера содержимого.
 */
export function parseFsWriteRequestBody(
  body: unknown,
): { ok: true; value: FsWriteRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  if (typeof raw.content !== 'string') {
    return { ok: false, message: 'поле content обязательно: строка с содержимым файла' };
  }
  if (Buffer.byteLength(raw.content, 'utf-8') > EXECUTOR_FS_MAX_WRITE_BYTES) {
    return {
      ok: false,
      message: `поле content: больше ${EXECUTOR_FS_MAX_WRITE_BYTES} байт`,
    };
  }
  return { ok: true, value: { ...base.value, content: raw.content } };
}

/**
 * Разбор тела запроса создания каталога (`POST /fs/mkdir`).
 *
 * База — `parseFsRequestBody`: путь обязателен, `cwd` необязателен.
 */
export function parseFsMkdirRequestBody(
  body: unknown,
): { ok: true; value: FsMkdirRequestBody } | { ok: false; message: string } {
  return parseFsRequestBody(body);
}

/**
 * Разбор тела запроса удаления (`POST /fs/remove`).
 *
 * База — `parseFsRequestBody`: путь обязателен, `cwd` необязателен.
 */
export function parseFsRemoveRequestBody(
  body: unknown,
): { ok: true; value: FsRemoveRequestBody } | { ok: false; message: string } {
  return parseFsRequestBody(body);
}

/**
 * Разбор тела запроса чтения «сырого» текста (`POST /fs/read-raw`).
 *
 * База — `parseFsRequestBody`; сверху — `maxBytes` (обязателен, положительный
 * целый, не выше потолка тела).
 */
export function parseFsRawTextRequestBody(
  body: unknown,
): { ok: true; value: FsRawTextRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  if (typeof raw.maxBytes !== 'number' || !Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
    return { ok: false, message: 'поле maxBytes обязательно: целое число > 0 (потолок размера файла)' };
  }
  if (raw.maxBytes > EXECUTOR_FS_MAX_READ_RAW_BYTES) {
    return {
      ok: false,
      message: `поле maxBytes: больше ${EXECUTOR_FS_MAX_READ_RAW_BYTES} байт`,
    };
  }
  return { ok: true, value: { ...base.value, maxBytes: raw.maxBytes } };
}

/**
 * Разбор тела запроса переименования (`POST /fs/rename`).
 *
 * База — `parseFsRequestBody` (путь-источник обязателен, `cwd` необязателен);
 * сверху — `to` (цель): непустая строка без NUL.
 */
export function parseFsRenameRequestBody(
  body: unknown,
): { ok: true; value: FsRenameRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  if (typeof raw.to !== 'string' || raw.to.trim().length === 0) {
    return { ok: false, message: 'поле to обязательно: непустая строка (путь цели)' };
  }
  if (raw.to.includes('\0')) {
    return { ok: false, message: 'поле to содержит недопустимые символы' };
  }
  return { ok: true, value: { ...base.value, to: raw.to } };
}

/**
 * Разбор тела запроса бинарной передачи файла (`POST /fs/download`).
 *
 * База — `parseFsRequestBody`; сверху — `maxBytes` (обязателен, положительный
 * целый). Верхняя граница **не проверяется**: исполнитель обрезает свой
 * потолок до меньшего из двух (`min`) — см. `EXECUTOR_FS_MAX_DOWNLOAD_BYTES`.
 */
export function parseFsDownloadRequestBody(
  body: unknown,
): { ok: true; value: FsDownloadRequestBody } | { ok: false; message: string } {
  const base = parseFsRequestBody(body);
  if (!base.ok) return base;
  const raw = body as Record<string, unknown>;
  if (typeof raw.maxBytes !== 'number' || !Number.isInteger(raw.maxBytes) || raw.maxBytes <= 0) {
    return { ok: false, message: 'поле maxBytes обязательно: целое число > 0 (потолок размера файла)' };
  }
  return { ok: true, value: { ...base.value, maxBytes: raw.maxBytes } };
}

/**
 * Границы размера терминала (протокол 8).
 *
 * Слишком маленький терминал бессмысленен (оболочка не рисует промпт), а
 * огромный — это способ занять память исполнителя. Значение **на проводе**
 * проверяется строго: молчаливый clamp означал бы, что клиент думает о
 * терминале 200×50, а получил 80×24.
 */
export const EXECUTOR_PTY_MIN_COLS = 1;
export const EXECUTOR_PTY_MAX_COLS = 1_000;
export const EXECUTOR_PTY_MIN_ROWS = 1;
export const EXECUTOR_PTY_MAX_ROWS = 1_000;

/**
 * Потолок тела ввода PTY по умолчанию, байт (протокол 8).
 *
 * Переопределяется оператором (`SYNTH_EXECUTOR_PTY_INPUT_MAX_BYTES`): ввод
 * терминала — это keystroke'ы, поток не должен превращаться в способ забить
 * память исполнителя.
 */
export const EXECUTOR_PTY_DEFAULT_INPUT_MAX_BYTES = 16 * 1024;

/**
 * Тело запроса открытия PTY-сессии (`POST /pty/open`, протокол 8).
 *
 * Форма повторяет `PtyOpenRequest` порта core: те же `cwd`/`env`/`shell`,
 * но **без команды** — запускается оболочка, а ввод идёт через
 * `POST /pty/:id/input`.
 */
export interface PtyOpenBody {
  /**
   * Идентификатор сессии (необязателен).
   *
   * Клиентский `id` — **ключ идемпотентности**: повторный `open` с тем же
   * `id` возвращает уже открытую сессию (новый терминал не заводится).
   * Не задан — исполнитель выдаёт свой (`pty_<uuid>`).
   */
  id?: string;
  /** Рабочий каталог сессии (внутри workspace исполнителя). */
  cwd: string;
  /** Оболочка; не задана — `$SHELL` окружения, иначе `/bin/bash`. */
  shell?: string;
  /** Аргументы оболочки. */
  args?: string[];
  /** Ширина терминала (колонки). */
  cols: number;
  /** Высота терминала (строки). */
  rows: number;
  /** Дополнительное окружение — мержится поверх очищенного базового. */
  env?: Record<string, string>;
}

/** Ответ `POST /pty/open` (протокол 8). */
export interface PtyOpenResponse {
  /** Идентификатор PTY-сессии (`pty_<uuid>` или клиентский). */
  id: string;
  /** pid процесса ОС (лидер PTY-сессии). */
  pid?: number;
  /** Ширина терминала (колонки). */
  cols: number;
  /** Высота терминала (строки). */
  rows: number;
}

/** Тело запроса записи во вход терминала (`POST /pty/:id/input`). */
export interface PtyInputBody {
  /** Данные для ввода (keystroke'ы). */
  data: string;
}

/** Ответ `POST /pty/:id/input` (протокол 8). */
export interface PtyInputResponse {
  /** Идентификатор PTY-сессии. */
  id: string;
  /** Сколько байт записано во вход терминала. */
  bytes: number;
}

/** Тело запроса изменения размера терминала (`POST /pty/:id/resize`). */
export interface PtyResizeBody {
  /** Ширина терминала (колонки). */
  cols: number;
  /** Высота терминала (строки). */
  rows: number;
}

/** Ответ `POST /pty/:id/close` (протокол 8). */
export interface PtyCloseResponse {
  /** Идентификатор PTY-сессии. */
  id: string;
  /** Сессия закрыта (или уже была закрыта — идемпотентно). */
  closed: true;
}

/** Состояние PTY-сессии (`GET /pty/:id/status`, протокол 8). */
export interface PtyStatusBody {
  /** Идентификатор PTY-сессии. */
  id: string;
  /** pid процесса ОС (лидер PTY-сессии). */
  pid?: number;
  /** Ширина терминала (колонки). */
  cols: number;
  /** Высота терминала (строки). */
  rows: number;
  /** Терминал завершился. */
  exited: boolean;
  /** Код завершения (не задан, пока терминал жив). */
  exitCode?: number;
  /** Сигнал завершения (не задан, пока терминал жив). */
  signal?: string;
  /** Номер последнего выданного кадра вывода (монотонный). */
  seq: number;
}

/** Кадр вывода терминала (`GET /pty/:id/stream`, протокол 8). */
export interface PtyStreamFrame {
  /** Номер кадра (монотонный, начиная с 1). */
  seq: number;
  /** Данные кадра (текст терминала). */
  data: string;
}

/**
 * Разбор тела `POST /pty/open` (протокол 8).
 *
 * Проверки строгие: `cwd` обязателен, размеры терминала — в границах,
 * `env` — объект со строковыми значениями. Молчаливый пропуск означал бы
 * запуск терминала **не с теми** параметрами, которые запросили.
 */
export function parsePtyOpenBody(
  body: unknown,
): { ok: true; value: PtyOpenBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.cwd !== 'string' || raw.cwd.trim().length === 0) {
    return { ok: false, message: 'поле cwd обязательно: непустая строка' };
  }
  if (raw.cwd.includes('\0')) {
    return { ok: false, message: 'поле cwd содержит недопустимые символы' };
  }

  const size = parsePtySize(raw.cols, raw.rows);
  if (!size.ok) return size;

  const value: PtyOpenBody = { cwd: raw.cwd, cols: size.cols, rows: size.rows };

  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
      return { ok: false, message: 'поле id должно быть непустой строкой' };
    }
    if (raw.id.includes('\0')) {
      return { ok: false, message: 'поле id содержит недопустимые символы' };
    }
    value.id = raw.id.trim();
  }

  if (raw.shell !== undefined) {
    if (typeof raw.shell !== 'string' || raw.shell.trim().length === 0) {
      return { ok: false, message: 'поле shell должно быть непустой строкой' };
    }
    value.shell = raw.shell.trim();
  }

  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === 'string')) {
      return { ok: false, message: 'поле args должно быть массивом строк' };
    }
    value.args = [...(raw.args as string[])];
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

  return { ok: true, value };
}

/**
 * Разбор тела `POST /pty/:id/input` (протокол 8).
 *
 * Потолок `maxBytes` — размер входа терминала; превышение → отказ
 * (`payload_too_large`, 413): тело уже пришло, обрезать keystroke'и нельзя.
 */
export function parsePtyInputBody(
  body: unknown,
  maxBytes: number = EXECUTOR_PTY_DEFAULT_INPUT_MAX_BYTES,
): { ok: true; value: PtyInputBody } | { ok: false; message: string; tooLarge?: boolean } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.data !== 'string') {
    return { ok: false, message: 'поле data обязательно: строка с вводом терминала' };
  }
  if (Buffer.byteLength(raw.data, 'utf-8') > maxBytes) {
    return {
      ok: false,
      tooLarge: true,
      message: `поле data: больше ${maxBytes} байт`,
    };
  }
  return { ok: true, value: { data: raw.data } };
}

/** Разбор тела `POST /pty/:id/resize` (протокол 8). */
export function parsePtyResizeBody(
  body: unknown,
): { ok: true; value: PtyResizeBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'тело запроса должно быть JSON-объектом' };
  }
  const raw = body as Record<string, unknown>;
  const size = parsePtySize(raw.cols, raw.rows);
  if (!size.ok) return size;
  return { ok: true, value: { cols: size.cols, rows: size.rows } };
}

/**
 * Разбор размера терминала (`cols`/`rows`) — общий для `open` и `resize`.
 */
function parsePtySize(
  cols: unknown,
  rows: unknown,
): { ok: true; cols: number; rows: number } | { ok: false; message: string } {
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < EXECUTOR_PTY_MIN_COLS || cols > EXECUTOR_PTY_MAX_COLS) {
    return {
      ok: false,
      message: `поле cols должно быть целым числом ${EXECUTOR_PTY_MIN_COLS}..${EXECUTOR_PTY_MAX_COLS}`,
    };
  }
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < EXECUTOR_PTY_MIN_ROWS || rows > EXECUTOR_PTY_MAX_ROWS) {
    return {
      ok: false,
      message: `поле rows должно быть целым числом ${EXECUTOR_PTY_MIN_ROWS}..${EXECUTOR_PTY_MAX_ROWS}`,
    };
  }
  return { ok: true, cols, rows };
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
