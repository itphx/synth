/**
 * Порт исполнения команд (ADR-077, шаг 1).
 *
 * Домен (тулы `execute_shell`/`grep_files`, git-тулы, inline-shell, детект
 * внешних зависимостей) работает через интерфейс, а не через прямой вызов
 * `execFile`: физический исполнитель взаимозаменяем — сегодня
 * `InlineExecutionPort` (исполнение в процессе), позже `RemoteExecutionPort`
 * (HTTP к отдельному исполнителю). Образец — порты слоя хранения
 * (ADR-096/ADR-097).
 *
 * ## Почему команда — не строка
 *
 * В коде две формы вызова, и обе должны выражаться портом без потери
 * семантики:
 *
 * - **shell** — `sh -c <команда>`: тул `execute_shell`, inline-shell
 *   (`` !`cmd` ``). Строка идёт в shell без разбора — пайпы, редиректы,
 *   подстановки переменных работают как раньше;
 * - **argv** — прямой запуск бинарника **без shell**: `git`, `rg`, проба
 *   `bin --version`. Значения аргументов не проходят через shell — значит
 *   классическая инъекция невозможна, аallowlist значений в git-тулах
 *   (ADR-076) остаётся осмысленным.
 *
 * Поэтому запрос — дискриминированный union (`ExecCommand`), а не строка:
 * иначе «argv без shell» пришлось бы выражать строкой и потерять различие
 * (либо получить инъекцию, либо запретить shell-семантику).
 */

/** Форма команды: shell-строка или argv-массив (без shell). */
export type ExecCommand =
  /** Shell-семантика: `<shell> -c <command>` (по умолчанию — `sh`). */
  | { kind: 'shell'; command: string; shell?: string }
  /** Прямой запуск: `<file> <args…>` — без shell. */
  | { kind: 'argv'; file: string; args?: string[] };

/**
 * Секрет вызова (ADR-077, протокол 4).
 *
 * Материал, который нужен точке исполнения **на время одной команды**:
 * приватный SSH-ключ (ADR-076) с необязательной passphrase.
 *
 * ## Где материализуется
 *
 * - **inline** — в процессе control plane: временный ключ `0600` в каталоге
 *   `0700` (`createSshEnv`), удаление в `finally`;
 * - **remote** — на исполнителе: control plane передаёт ключ в теле
 *   `POST /exec` (`secrets[]`), исполнитель материализует его у себя и
 *   удаляет после вызова. Путь к файлу в control plane в контейнере
 *   исполнителя не существует — поэтому доставка идёт **значением**, а не
 *   путём.
 *
 * ## Правила
 *
 * - `kind` — дискриминатор закрытого union'а: набор видов расширяется
 *   аддитивно (новый вид ⇒ новое поле), а не сменой формы;
 * - значение **никогда не логируется** и **не возвращается** в ответе
 *   (ни в ошибке, ни в `/capabilities`);
 * - at-rest ключ лежит только в control plane (шифрование мастер-ключом,
 *   ADR-076): в Secret-том/K8s Secret исполнителя он не попадает.
 */
export interface ExecSecret {
  /** Вид секрета. */
  kind: 'ssh-key';
  /** Приватный ключ в формате OpenSSH (PEM/OPENSSH — как принят ssh). */
  privateKey: string;
  /** Passphrase ключа (необязательна): передаётся askpass-скриптом. */
  passphrase?: string;
}

export interface ExecRequest {
  /** Команда: shell-строка или argv. */
  command: ExecCommand;
  /**
   * Бинарные возможности, необходимые для успеха команды (ADR-077).
   *
   * Словарь — `EXECUTION_BASE_CAPABILITIES` (`git`/`rg`/`sh`): это те же
   * программы, доступность которых проверяет слой доступности тулов
   * (ADR-078). Удалённый порт использует поле как **условие маршрутизации**:
   * команда уходит в тот адрес пула, чей инвентарь (`GET /capabilities`)
   * покрывает все требуемые бинари. Inline-реализация поле игнорирует —
   * программа и так локальная.
   */
  requires?: string[];
  /** Рабочий каталог команды. Не задан — каталог процесса-исполнителя. */
  cwd?: string;
  /**
   * ДОПОЛНИТЕЛЬНОЕ окружение: мержится поверх базового окружения
   * исполнителя (в inline-режиме — `process.env`). Не заменяет его.
   */
  env?: Record<string, string>;
  /** Таймаут вызова (мс). Не задан — без таймаута. */
  timeoutMs?: number;
  /** Сигнал отмены («Стоп» сессии) — процесс прерывается. */
  signal?: AbortSignal;
  /**
   * Лимит буфера вывода (байт). Не задан — `DEFAULT_MAX_OUTPUT_BYTES`
   * (10 МБ, как `maxBuffer` у нынешних вызовов).
   */
  maxOutputBytes?: number;
  /**
   * Секреты вызова: материал доставляется точке исполнения **на время
   * вызова**, никогда не логируется и не возвращается в ответе; в
   * inline-режиме материализуется локально (временный ключ `0600` в
   * каталоге `0700`, удаление после вызова), в remote-режиме — уходит в теле
   * `POST /exec` и материализуется исполнителем (ADR-077, протокол 4).
   *
   * Не задано — обычный вызов без секретов (прежнее поведение).
   */
  secrets?: ExecSecret[];
}

export interface ExecResult {
  /** Стандартный вывод. */
  stdout: string;
  /** Стандартный вывод ошибок. */
  stderr: string;
  /**
   * Код завершения. Успешный вызов — всегда `0`: неуспешный код приходит
   * **ошибкой** (`ExecutionError.code`), а не полем результата — так сохраняется
   * дословный текст «Command failed: …», который видит модель.
   */
  exitCode: number;
  /** Вывод обрезан по лимиту порта. */
  truncated: boolean;
  /** Длительность исполнения (мс). */
  durationMs: number;
}

/** Кусок вывода фонового процесса. */
export interface ExecBackgroundChunk {
  /** Поток, из которого пришёл кусок. */
  stream: 'stdout' | 'stderr';
  /** Текст куска (UTF-8). */
  data: string;
}

/** Завершение фонового процесса. */
export interface ExecBackgroundExit {
  /**
   * Код завершения; `null` — процесс убит сигналом.
   *
   * Неудача запуска (нет бинарника, неверный `cwd`) — отрицательный код
   * libuv (например `-2` для ENOENT), а не `null`.
   */
  exitCode: number | null;
  /** Сигнал, завершивший процесс; `null` — процесс вышел сам. */
  signal: string | null;
  /** Длительность жизни процесса (мс). */
  durationMs: number;
}

/** Хэндл фонового процесса (PROP-097). */
export interface ExecBackgroundProcess {
  /** Идентификатор фонового процесса (`proc_<uuid>`) — для реестра прогонов. */
  readonly processId: string;
  /** pid процесса ОС (если процесс запустился). */
  readonly pid?: number;
  /** Поток вывода; завершается вместе с процессом. */
  readonly output: AsyncIterable<ExecBackgroundChunk>;
  /** Промис завершения (резолвится один раз). */
  readonly exited: Promise<ExecBackgroundExit>;
  /** Сигнал процессу (по умолчанию SIGTERM). Не бросает. */
  stop(signal?: NodeJS.Signals): void;
}

/**
 * Порт исполнения команд. Реализации: `InlineExecutionPort` (в процессе) и
 * `RemoteExecutionPort` (HTTP к исполнителю, шаг 7 плана ADR-077).
 */
export interface ExecutionPort {
  execute(req: ExecRequest): Promise<ExecResult>;

  /**
   * Порт исполняет команды **вне** процесса control plane (ADR-077).
   *
   * Признак нужен точкам, которые передают локальную конфигурацию окружения
   * дочернему процессу: например, git-CA (`-c http.sslCAInfo=<path>`) имеет
   * смысл только там, где этот путь существует. В remote-режиме путь CA
   * принадлежит control plane, поэтому доверие задаёт исполнитель при старте
   * (ADR-099/ADR-077).
   *
   * Необязательное аддитивное поле: реализация без него считается локальной
   * (`inline`) — поведение существующих портов не меняется.
   */
  readonly isRemote?: boolean;

  /**
   * Фоновый запуск команды (PROP-097). Не задан — фоновое исполнение
   * недоступно в этой реализации (remote до шага 7c ADR-077).
   *
   * ## Отличия от `execute`
   *
   * Фоновый процесс **переживает ход** агента, поэтому:
   *
   * - `ExecRequest.signal` **не поддерживается** — отмена фонового процесса
   *   делается только через `stop()` хэндла;
   * - `ExecRequest.requires` **не проверяется** — проверка бинарных требований
   *   остаётся на слое тула (как и в `execute`);
   * - `ExecRequest.maxOutputBytes` **не применяется** — вывод не буферизуется
   *   портом, а стримится кусками в `output`;
   * - `ExecRequest.timeoutMs` (если `> 0`) — таймер, убивающий процесс
   *   (`SIGTERM`, затем `SIGKILL` через 5 с).
   */
  spawnBackground?(req: ExecRequest): Promise<ExecBackgroundProcess>;

  /**
   * Доступен ли бинарь в окружении, где исполняется порт (ADR-077).
   *
   * Смысл: «программа есть там, где команда будет выполнена». У inline-порта
   * это локальное окружение control plane, у удалённого — **состав пула
   * исполнителей** (инвентарь из `GET /capabilities`): бинарь считается
   * доступным, если он есть хотя бы у одного доступного адреса.
   *
   * Необязательный метод: порт без него проверяется локальной пробой
   * (`runtime-deps.ts` — ADR-078). Проба не бросает исключений: недоступность
   * бинаря — это `false`, а не ошибка.
   */
  probe?(bin: string, args?: string[]): Promise<boolean>;

  /**
   * Сводка о составе окружения порта — для объяснения недоступности
   * (ADR-077/ADR-078). Необязательна: без неё слой доступности даёт деталь
   * общего вида («программа не установлена»).
   */
  capabilitySummary?(bin: string): Promise<ExecutionCapabilitySummary>;

  /**
   * ADR-077 (шаг B2): параметры пула исполнителей для MCP-хоста.
   *
   * Заполняет удалённый порт (фабрика core, `execution/remote.ts`): по этим
   * адресам control plane забирает MCP-серверы исполнителя. `inline`-порт поля
   * не имеет — поведение прежнее. Значение **не сериализуется** и не пишется в
   * логи: `token` — секрет (инвариант 13).
   */
  readonly executorMcp?: { readonly urls: string[]; readonly token: string };
}

/**
 * Канонический словарь бинарных возможностей (ADR-077).
 *
 * Единственный источник истины для обеих сторон: control plane сверяет с ним
 * требования тулов (`ExecRequest.requires`), исполнитель отдаёт состав по
 * этому же словарю (`GET /capabilities`). Дополнительные программы
 * (например `python3`) в словарь **не** входят: они — сведения о составе
 * окружения, а не условие доступности встроенного тула.
 */
export const EXECUTION_BASE_CAPABILITIES = ['git', 'rg', 'sh'] as const;

/** Имя бинарной возможности из канонического словаря. */
export type ExecutionBaseCapability = (typeof EXECUTION_BASE_CAPABILITIES)[number];

/**
 * Исход исполненной команды — закрытый набор (ADR-094, метрики исполнителя).
 *
 * Тот же набор на обеих сторонах: control plane (`outcome` в
 * `synth_executor_commands_total`) и исполнитель (свой счётчик). Значения
 * приводятся к этому набору — иначе кардинальность серий не ограничена.
 */
export type ExecutionMetricsOutcome = 'ok' | 'error' | 'timeout' | 'cancelled';

/**
 * Приёмник метрик исполнения (ADR-094).
 *
 * ## Почему инъекция, а не реестр в клиенте
 *
 * Удалённый порт живёт в пакете `@itphx/synth-executor` (ADR-077), а реестр
 * метрик — в core. Тянуть реестр в клиент нельзя: пакет исполнителя не должен
 * знать про подсистему наблюдаемости control plane (иначе «клиент» и «ядро»
 * связались бы напрямую, минуя порт). Поэтому порт объявляет **узкий
 * приёмник** — четыре необязательных колбэка без единой зависимости на
 * реестр, — а реализация живёт в core (`metrics/collectors/executor.ts`).
 *
 * ## Точки вызова (клиент удалённого порта)
 *
 * - `onQueued` — запрос поставлен в очередь на отправку исполнителю;
 * - `onDequeued` — получен слот пула, `waitMs` — сколько ждали в очереди;
 * - `onStarted` — команда ушла исполнителю (слот занят);
 * - `onFinished` — команда завершена: исход + длительность.
 */
export interface ExecutionMetricsSink {
  /** Запрос поставлен в очередь на отправку исполнителю. */
  onQueued?(): void;
  /** Получен слот пула; `waitMs` — время ожидания в очереди. */
  onDequeued?(waitMs: number): void;
  /** Команда отправлена исполнителю (слот занят). */
  onStarted?(): void;
  /** Команда завершена (успех или ошибка). */
  onFinished?(outcome: ExecutionMetricsOutcome, durationMs: number): void;
}

/**
 * Сводка о составе пула исполнителей по одному бинарю (ADR-077).
 *
 * Числа нужны слою доступности, чтобы объяснить модели не просто «программы
 * нет», а **где** её нет: «в пуле: 2 из 3 адресов».
 */
export interface ExecutionCapabilitySummary {
  /** Есть ли бинарь хотя бы в одной доступной среде исполнения. */
  available: boolean;
  /** Сколько доступных адресов пула не имеют бинаря. */
  missing: number;
  /** Всего адресов пула (включая не ответившие). */
  total: number;
  /** Сколько адресов не ответили — их состав неизвестен. */
  unreachable: number;
}

/** Причина неудачного вызова. */
export type ExecFailureReason =
  /** Превышен таймаут — процесс прерван. */
  | 'timeout'
  /** Отмена по `AbortSignal` («Стоп»). */
  | 'aborted'
  /** Не удалось запустить процесс (нет бинарника, EACCES, …). */
  | 'spawn_failed'
  /** Процесс завершился с ненулевым кодом. */
  | 'nonzero_exit'
  /** Превышен лимит буфера вывода — вывод обрезан. */
  | 'max_output'
  /**
   * Требуемая бинарная возможность отсутствует в пуле исполнителей
   * (ADR-077): команда с `requires` не может быть выполнена ни одним
   * адресом. Различимая причина — слой доступности превращает её в
   * `unavailable(dependency)`.
   */
  | 'dependency_missing';

/** Базовая оболочка shell-формы (совпадает с текущим `sh -c`). */
export const DEFAULT_SHELL_BINARY = 'sh';

/** Лимит буфера вывода по умолчанию (10 МБ — как нынешний `maxBuffer`). */
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Код ошибки порта: **исполнитель не умеет фоновые процессы**.
 *
 * Удалённый порт сообщает это кодом в `ExecutionError.code` (исполнитель
 * протокола < 3 не знает `/exec/spawn`); реестр фоновых прогонов
 * (`engine/processes`) превращает его в `background_unsupported`
 * (`process.background_unsupported` для модели).
 */
export const EXECUTION_BACKGROUND_UNSUPPORTED_CODE = 'EBACKGROUND';

/**
 * Код ошибки порта: **исполнитель не умеет принимать секреты вызова**.
 *
 * Удалённый порт сообщает это кодом в `ExecutionError.code` (исполнитель
 * протокола < 4 не знает `secrets[]` в `POST /exec`); «тихое» выполнение
 * команды без ключа недопустимо — SSH-операция упала бы с невнятной
 * ошибкой аутентификации.
 */
export const EXECUTION_SECRETS_UNSUPPORTED_CODE = 'ESECRETS';

export interface ExecutionErrorInit {
  /** Текст ошибки (дословно как у процесса — его видит модель). */
  message: string;
  /** Код: `'ENOENT'`, код выхода или `null`. */
  code?: string | number | null;
  /** Частичный stdout. */
  stdout?: string;
  /** Частичный stderr. */
  stderr?: string;
  /** Процесс был убит (таймаут/отмена). */
  killed?: boolean;
  /** Сигнал завершения. */
  signal?: string | null;
  /** Причина неудачи. */
  reason: ExecFailureReason;
  /** Вывод был обрезан по лимиту. */
  truncated?: boolean;
  /** Длительность до ошибки (мс). */
  durationMs?: number;
}

/**
 * Типизированная ошибка исполнения (ADR-077). Несёт те же поля, что и
 * ошибка `execFile` (`code`/`stdout`/`stderr`/`killed`/`message`), поэтому
 * тексты, которые видит модель, не меняются.
 *
 * ## Имя класса — стабильный признак типа
 *
 * `name` всегда `ExecutionError`: по нему ошибка опознаётся **структурно**
 * (`isExecutionError`) — в том числе когда она пришла из другой копии
 * модуля (`src` против `dist`), где `instanceof` не срабатывает: это два
 * разных объекта класса. Отмена опознаётся по `reason: 'aborted'`
 * (не по имени — имя принадлежит типу ошибки).
 */
export class ExecutionError extends Error {
  readonly reason: ExecFailureReason;
  readonly code: string | number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly durationMs: number;

  constructor(init: ExecutionErrorInit) {
    super(init.message);
    // Имя класса фиксировано: оно же — признак типа для структурной
    // проверки (см. `isExecutionError`). Дословность текста ошибки
    // (`init.message`) сохраняется — её показывают тулы.
    this.name = 'ExecutionError';
    this.reason = init.reason;
    this.code = init.code ?? null;
    this.stdout = init.stdout ?? '';
    this.stderr = init.stderr ?? '';
    this.killed = init.killed === true;
    this.signal = init.signal ?? null;
    this.truncated = init.truncated === true;
    this.durationMs = init.durationMs ?? 0;
  }
}

/**
 * Структурная проверка `ExecutionError` (устойчива к копиям класса: src/dist).
 *
 * `instanceof` здесь ненадёжен: клиент удалённого порта создаёт ошибку через
 * динамический `import('@itphx/synth-core')` (то есть из `dist`), а код в
 * core импортирует класс из исходников — это два разных объекта класса, и
 * `instanceof` не срабатывает. Поэтому проверка опирается на стабильный
 * признак типа (`name`) и на форму ошибки (`reason`/`message`).
 */
export function isExecutionError(value: unknown): value is ExecutionError {
  if (value instanceof ExecutionError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const e = value as { name?: unknown; reason?: unknown; message?: unknown };
  return e.name === 'ExecutionError' && typeof e.reason === 'string' && typeof e.message === 'string';
}

/** Структурная проверка: переданное значение — порт исполнения. */
export function isExecutionPort(value: unknown): value is ExecutionPort {
  return typeof (value as { execute?: unknown } | null | undefined)?.execute === 'function';
}
