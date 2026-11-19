import type { z } from 'zod';
import type { CatalogTrustLevel } from './trust.js';

export const ToolCapability = {
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  SHELL: 'shell',
  SEARCH: 'search',
  WEB: 'web',
  GIT_READ: 'git_read',
  GIT_WRITE: 'git_write',
  TASK: 'task',
  MCP: 'mcp',
  RUNTIME: 'runtime',
  USER: 'user',
  /**
   * Память (ADR-107, PROP-047): тулы плагина памяти (`memory_search`/
   * `memory_write`/`memory_forget`).
   *
   * Отдельная capability, а не `search`/`file_write`: память работает **всегда** —
   * она не привязана к рабочему каталогу проекта (`WORKSPACE_CAPABILITIES`),
   * поэтому в сессии без `project.workspace` тулы памяти остаются доступны.
   */
  MEMORY: 'memory',
  /**
   * Пайплайны (ADR-101): тулы работы с пайплайнами проекта и прогонами.
   *
   * Отдельная capability, а не `runtime`: пайплайн — доменный ресурс проекта
   * (спецификация с версиями + прогоны), а не примитив ядра. Capability
   * отключается админом через `tools.disabled` (группа `pipeline`).
   */
  PIPELINE: 'pipeline',
  /**
   * Расписания (ADR-051): тулы работы с расписаниями планировщика.
   *
   * Отдельная capability по той же причине, что и `pipeline`: расписание —
   * доменный ресурс, а не примитив ядра.
   */
  SCHEDULE: 'schedule',
  /**
   * Вопрос пользователю (этап 1 roadmap 0.13 — блок 1.3): тулы, задающие
   * пользователю вопрос и ждущие ответа.
   *
   * Отдельная capability по той же причине, что и `pipeline`/`schedule`:
   * вопрос — доменный ресурс (персистентная запись вопроса), а не примитив
   * ядра. Capability **не** привязана к рабочему каталогу проекта
   * (`WORKSPACE_CAPABILITIES`) — вопрос задаётся и без workspace.
   */
  QUESTION: 'question',
  /**
   * Реестр фоновых прогонов (ADR-111/PROP-097): тулы чтения реестра и логов
   * фоновых процессов (`process_list`/`process_logs`).
   *
   * Отдельная capability по той же причине, что и `pipeline`/`schedule`/
   * `question`: реестр фоновой работы — доменный ресурс, а не примитив ядра.
   * Capability **не** привязана к рабочему каталогу проекта
   * (`WORKSPACE_CAPABILITIES`) — реестр доступен и без workspace.
   */
  PROCESS: 'process',
  /**
   * Каталог моделей (ADR-115): тул `list_models` — модели инстанса с
   * модальностями, текущая пара и назначения aux-моделей.
   *
   * Отдельная capability по той же причине, что `pipeline`/`schedule`/`process`:
   * каталог — доменный ресурс инстанса, а не примитив ядра. Capability **не**
   * привязана к рабочему каталогу проекта (`WORKSPACE_CAPABILITIES`) — каталог
   * доступен и без workspace, и разрешён в plan-режиме (только чтение).
   */
  MODELS: 'models',
  /**
   * Адресный SSH-доступ (PROP-124 §4): тулы, обращающиеся к удалённому хосту
   * по SSH (`ssh_exec` и дальше `ssh_copy`/`ssh_tunnel`).
   *
   * Отдельная capability по той же причине, что `pipeline`/`schedule`/`process`:
   * адресный SSH — доменный ресурс инстанса (реестр ключей + политика
   * хостов/портов), а не примитив ядра. Capability **не** привязана к рабочему
   * каталогу проекта, но **зависит от режима инстанса** `ssh.mode`: в режиме
   * `agent` адресные тулы недоступны (`unavailable(policy)`), см.
   * `engine/permission/availability.ts`.
   */
  SSH: 'ssh',
  /**
   * Список задач сессии (ADR-039): тулы `todo_write`/`todo_list`/`todo_add`/
   * `todo_update`/`todo_delete`.
   *
   * Это **операционный список задач сессии** (`session.todos`), а не план
   * проекта (`project.plan`, тулы `plan_*`). Capability выдаётся **в
   * дополнение** к `runtime` (совместимость с существующими/кастомными
   * агентами): группа `runtime` продолжает матчить todo-тулы (имена остаются в
   * `RUNTIME_TOOLS`), а правило `permission.rules.todo` работает по capability.
   * Capability **не** привязана к рабочему каталогу проекта
   * (`WORKSPACE_CAPABILITIES`) — список задач доступен и без workspace.
   */
  TODO: 'todo',
  /**
   * Инстанс и MCP-реестр (read-only, Workstream A1): тулы `synth_info`,
   * `synth_mcp_list`, `synth_mcp_test`.
   *
   * Отдельная capability по той же причине, что `pipeline`/`schedule`/
   * `process`/`models`: инстанс и его MCP-реестр — доменный ресурс, а не
   * примитив ядра. Capability **не** привязана к рабочему каталогу проекта
   * (`WORKSPACE_CAPABILITIES`) — сведения об инстансе доступны и без workspace.
   * Write-тулы (`synth_mcp_add`/…) — следующий шаг.
   */
  INSTANCE: 'instance',
  /**
   * Интерактивные терминалы (PROP-132, Ф5): тулы `terminal_list`/
   * `terminal_open`/`terminal_read`/`terminal_write`/`terminal_close`.
   *
   * Отдельная capability, а не `shell`: терминал — **доменный ресурс
   * инстанса** (реестр живых терминалов в памяти процесса + PTY на точке
   * исполнения), а не примитив ядра. Capability **не** привязана к рабочему
   * каталогу проекта (`WORKSPACE_CAPABILITIES`) — терминал открывается в
   * каталоге, который вычисляет сервер (`session.worktree.directory` →
   * `project.workspace`).
   *
   * Доступность — по **мастер-выключателю инстанса** `terminal.enabled`:
   * выключен → тулы недоступны модели (`unavailable(policy)`), а не «deny в
   * момент вызова». В plan-режиме разрешены только чтение (`terminal_list`/
   * `terminal_read`); `terminal_open`/`terminal_write`/`terminal_close`
   * заблокированы (план ничего не исполняет).
   */
  TERMINAL: 'terminal',
  /**
   * Реестр агентов инстанса (самообслуживание из чата): тулы `synth_agent_list`,
   * `synth_agent_get` (чтение) и `synth_agent_save`/`synth_agent_delete`/
   * `synth_agent_enable`/`synth_agent_import` (запись, только ADMIN).
   *
   * Отдельная capability по той же причине, что `instance`/`pipeline`/`models`:
   * реестр агентов — доменный ресурс инстанса (JSON-записи `{dataDir}/agents` +
   * ролевые файлы `{dataDir}/context/roles`), а не примитив ядра. Capability
   * **не** привязана к рабочему каталогу проекта (`WORKSPACE_CAPABILITIES`) —
   * реестр доступен и без workspace. В plan-режиме разрешены только чтения.
   */
  AGENTS: 'agents',
} as const;

export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability];

export const TOOL_CAPABILITY_META: Record<string, { label: string; description: string }> = {
  [ToolCapability.FILE_READ]: { label: 'Чтение файлов', description: 'read_file, list_directory, glob' },
  [ToolCapability.FILE_WRITE]: { label: 'Запись файлов', description: 'write_file, edit_file, create_directory, delete_file' },
  [ToolCapability.SHELL]: { label: 'Shell-команды', description: 'execute_shell' },
  [ToolCapability.SEARCH]: { label: 'Поиск', description: 'grep_files, glob' },
  [ToolCapability.WEB]: { label: 'Веб', description: 'web_fetch, web_search' },
  [ToolCapability.GIT_READ]: { label: 'Чтение Git', description: 'git_status, git_diff, git_log, git_branch_list, git_show, git_blame' },
  [ToolCapability.GIT_WRITE]: { label: 'Запись Git', description: 'git_commit, git_push, git_pull, git_checkout, etc.' },
  [ToolCapability.TASK]: { label: 'Запуск сабагентов', description: 'task' },
  [ToolCapability.MCP]: { label: 'MCP-инструменты', description: 'внешние MCP-серверы' },
  [ToolCapability.RUNTIME]: { label: 'Управление сессией', description: 'classify_conversation' },
  [ToolCapability.USER]: { label: 'Работа с пользователем', description: 'profile_update' },
  [ToolCapability.MEMORY]: { label: 'Память', description: 'memory_search, memory_write, memory_forget' },
  [ToolCapability.PIPELINE]: {
    label: 'Пайплайны',
    description:
      'pipeline_list, pipeline_get, pipeline_save, pipeline_publish, pipeline_delete, pipeline_run, pipeline_run_status, pipeline_run_list, pipeline_run_resume, pipeline_run_cancel, pipeline_templates, pipeline_instantiate',
  },
  [ToolCapability.SCHEDULE]: {
    label: 'Расписания',
    description: 'schedule_list, schedule_get, schedule_save, schedule_delete, schedule_run, schedule_jobs',
  },
  [ToolCapability.QUESTION]: {
    label: 'Вопрос пользователю',
    description: 'question',
  },
  [ToolCapability.PROCESS]: {
    label: 'Фоновые процессы',
    description: 'process_list, process_logs, process_stop, process_delete',
  },
  [ToolCapability.MODELS]: {
    label: 'Модели',
    description: 'list_models',
  },
  [ToolCapability.SSH]: {
    label: 'Удалённый SSH',
    description: 'ssh_exec',
  },
  [ToolCapability.TODO]: {
    label: 'Список задач сессии',
    description: 'todo_write, todo_list, todo_add, todo_update, todo_delete',
  },
  [ToolCapability.INSTANCE]: {
    label: 'Инстанс и MCP',
    description: 'synth_info, synth_mcp_list, synth_mcp_test',
  },
  [ToolCapability.TERMINAL]: {
    label: 'Терминалы',
    description: 'terminal_list, terminal_open, terminal_read, terminal_write, terminal_close',
  },
  [ToolCapability.AGENTS]: {
    label: 'Агенты',
    description:
      'synth_agent_list, synth_agent_get, synth_agent_save, synth_agent_delete, synth_agent_enable, synth_agent_import',
  },
};

/**
 * PROP-138 (Ф1): узкий runtime плагинного тула — команды и файловые операции
 * **через порт исполнения сессии**.
 *
 * ## Зачем
 *
 * Плагинный тул с capability `file_read`/`file_write`/`shell`/`search`/
 * `git_read`/`git_write` должен работать в контуре исполнителя сессии, а не
 * в control plane: в split-топологии рабочий каталог живёт на исполнителе
 * (PROP-135), а прямой доступ к ФС control plane — неподдерживаемый путь.
 *
 * ## Что это НЕ
 *
 * - Не «второй `ToolContext`» и не замена `extra`: `extra`/`dataDir` плагину
 *   по-прежнему **не передаются** (ADR-090) — здесь только два явно
 *   перечисленных метода работы с окружением;
 * - не обход permission-слоя: runtime — это транспорт, а право на операцию
 *   решает хост (в capability-гейте — по capability тула).
 *
 * ## Контракт
 *
 * - `exec` — **argv без shell**: `[file, ...args]`. Значения аргументов не
 *   проходят через shell, поэтому классическая инъекция невозможна;
 * - `fs` — файловые операции в том же контуре, что и команды; пути
 *   **абсолютные** (относительные резолвит вызывающий тул — от
 *   `ctx.workingDir`).
 */
export interface PluginRuntimeExecOptions {
  /** Рабочий каталог команды (точка исполнения — исполнитель, а не control plane). */
  cwd?: string;
  /** Таймаут вызова, мс. Не задан — без таймаута. */
  timeoutMs?: number;
}

/** Результат команды плагинного runtime. */
export interface PluginRuntimeExecResult {
  /** Стандартный вывод. */
  stdout: string;
  /** Стандартный вывод ошибок. */
  stderr: string;
  /** Код завершения. */
  exitCode: number;
}

/** Файловые операции плагинного runtime (через порт исполнения сессии). */
export interface PluginRuntimeFs {
  /**
   * Прочитать файл.
   *
   * @param path — абсолютный путь на точке исполнения.
   * @param maxBytes — потолок размера; не задан — дефолт runtime.
   */
  readFile(path: string, maxBytes?: number): Promise<Buffer>;
  /** Записать файл (перезапись существующего — штатный режим). */
  writeFile(path: string, data: Buffer | string): Promise<void>;
  /** Сведения о файле/каталоге. */
  stat(path: string): Promise<{ kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number }>;
  /** Записи каталога. */
  readdir(path: string): Promise<Array<{ name: string; kind: 'file' | 'directory' | 'other'; size: number }>>;
  /** Канонический путь (симлинки разыменовываются). */
  realpath(path: string): Promise<string>;
}

/**
 * Узкий runtime плагинного тула (PROP-138, Ф1).
 *
 * Инжектится хостом в `ToolContext.runtime` **только** для тулов с
 * `source: 'plugin'`. Встроенные и MCP-тулы получают контекст без изменений.
 */
export interface PluginRuntime {
  /**
   * Выполнить команду в контуре исполнителя сессии.
   *
   * @param argv — `[file, ...args]`, **без shell**.
   * @param opts — рабочий каталог и таймаут (необязательны).
   */
  exec(argv: string[], opts?: PluginRuntimeExecOptions): Promise<PluginRuntimeExecResult>;
  /** Файловые операции в том же контуре. */
  fs: PluginRuntimeFs;
}

export interface ToolContext {
  sessionId: string;
  messageId: string;
  abortSignal?: AbortSignal;
  agentRole?: string;
  /**
   * Проект сессии — метаданные хода, а не internals ядра.
   *
   * Нужен плагину, который сужает контекст (ADR-107): без него плагинный тул
   * не знает, чей это проект, и не может ограничить себя его данными.
   */
  projectId?: string;
  workingDir: string;
  /**
   * Дополнительные абсолютные корни, внутри которых файловые/поисковые/shell-
   * и git-тулы считаются «своими» (perimeter сессии).
   *
   * `workingDir` остаётся **базой для относительных** путей (и каталогом
   * исполнения shell/git): относительный путь резолвится от него. Containment
   * же проверяется по `workingDir` + `allowedRoots` — так сессия в git-worktree
   * (ADR-114) видит и рабочий каталог worktree, и корень проекта
   * (`project.workspace`), как в opencode (`FileAccess.resolve`:
   * internal = location.directory ИЛИ project worktree).
   */
  allowedRoots?: string[];
  /**
   * ADR-114: привязка сессии к git-worktree.
   *
   * `worktreeId` — id записи worktree (пусто — сессия не привязана: рабочий
   * каталог = `project.workspace`). `worktreeRepoPath` — репозиторий worktree
   * **относительно `project.workspace`** (`.` — репозиторий в корне
   * workspace); по нему git-тулы ищут запись реестра `project.repos`
   * (ADR-076), потому что каталог worktree лежит вне `project.workspace`.
   */
  worktreeId?: string;
  worktreeRepoPath?: string;
  dataDir?: string;
  extra?: Record<string, unknown>;
  /**
   * PROP-138 (Ф1): узкий runtime плагинного тула (команды и файловые операции
   * через порт исполнения сессии).
   *
   * Поле **аддитивное** и заполняется хостом **только** для тулов с
   * `source: 'plugin'`; встроенные и MCP-тулы его не видят (у них
   * `ctx.extra` — полный контекст ядра). Плагину runtime даёт ровно то, что
   * нужно capability-зависимым тулам (`file_read`/`file_write`/`shell`/
   * `search`/`git_read`/`git_write`), и **не** даёт доступа к internals ядра.
   */
  runtime?: PluginRuntime;
}

/**
 * ADR-115 §«Медиа из инструментов»: ссылка на вложение, которое тул положил в
 * blob-хранилище и хочет показать модели.
 *
 * Тул **не** возвращает байты: в результате — только адрес объекта и
 * метаданные (та же content-addressed схема, что у вложений сообщений).
 * Оркестратор вставляет ссылки в текущий ход отдельной user-репликой, и
 * модель получает их штатной гидратацией на следующей итерации.
 *
 * Поля обязательные (кроме `name`): `blobPath` — путь порта `BlobStore`,
 * `sha256` — 64 hex-символа, `mime`, `size` > 0. Невалидные ссылки
 * отбрасываются с логом (текст результата тула модель всё равно получит).
 */
export interface ToolAttachmentRef {
  /** Путь объекта в blob-хранилище (обязан быть под `attachments/`). */
  blobPath: string;
  /** SHA-256 объекта (64 hex). */
  sha256: string;
  /** MIME-тип по содержимому (sniff сервиса вложений). */
  mime: string;
  /** Размер в байтах (> 0). */
  size: number;
  /** Имя файла для модели/UI (необязательно). */
  name?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * ADR-115: вложения результата тула (ссылки на объекты blob-хранилища).
   *
   * Аддитивное поле: тулы, которые умеют отдавать медиа (например
   * `web_fetch` с `include_media`), складывают сюда ссылки; оркестратор
   * превращает их в user-реплику текущего хода. Тул без поля работает как
   * прежде — результат остаётся текстом.
   */
  attachments?: ToolAttachmentRef[];
}

export type ToolExecutor = (params: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * ADR-071 §2.1 + ADR-090: источник инструмента.
 *
 * - `builtin` — встроенный (слой `tools`, `stable`);
 * - `mcp` — инструмент MCP-сервера (слой `mcp.tools`, `volatile`);
 * - `plugin` — инструмент, зарегистрированный плагином через
 *   `PluginFacade.registerTool` (ADR-090, Ф3в): в промпте идёт после
 *   встроенных (вне stable-префикса — плагин можно снять в runtime).
 *
 * Для встроенных проставляется по умолчанию в `ToolRegistry.register`.
 */
export type ToolSource = 'builtin' | 'mcp' | 'plugin';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  capabilities: ToolCapability[];
  execute: ToolExecutor;
  jsonSchema?: Record<string, unknown>;
  /**
   * Нормализация аргументов **до** zod-валидации — терпимость к типовым обёрткам
   * слабых моделей (`{todos: {item: …}}` вместо `{todos: …}`).
   *
   * На JSON Schema не влияет (схема для модели остаётся прежней); вызывается
   * один раз в `executeToolDef` перед `safeParse`, возвращает аргументы для
   * проверки. Аддитивное поле: тул без него работает как прежде.
   */
  normalizeArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** ADR-071 §2.1: источник инструмента (builtin/mcp/plugin). */
  source?: ToolSource;
  /** ADR-071 §2.1: имя MCP-сервера для `source: 'mcp'`. */
  mcpServer?: string;
  /**
   * ADR-090: имя плагина-владельца для `source: 'plugin'`.
   *
   * Имя тула в реестре — с namespace (`plugin_<plugin>_<tool>`,
   * `pluginToolFullName`), локальное имя хранится только здесь и в манифесте
   * (`provides.tools[]`).
   */
  pluginName?: string;
  /**
   * ADR-090 × IPI: фактический уровень доверия установки плагина на момент
   * регистрации тула (`CatalogTrustLevel`). Матрица доверия контента
   * (`engine/security/trust.ts`) считает результат плагинного тула
   * `trusted` только при уровне не ниже `trusted`; не задан — `untrusted`
   * (fail-closed). Аддитивное поле: тул без него работает как прежде.
   */
  pluginTrust?: CatalogTrustLevel;
}

export interface ToolForLLM {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface PendingToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  startedAt: string;
}

export interface CompletedToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  startedAt: string;
  completedAt: string;
}
