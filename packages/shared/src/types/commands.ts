import type { SkillScope, SkillLevel } from './skills.js';
import type { PermissionConfig } from './permission.js';

/**
 * ADR-126 §1: slash-команды и bundles — контракты. Здесь только типы (без
 * бизнес-логики движка); резолвинг выполняется в core до обращения к LLM.
 */

/** Вид команды (ADR-126 §1). */
export const COMMAND_KINDS = ['builtin', 'template', 'skill', 'bundle'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** Режим разрешения конфликтов имён (настройка `commands.conflict.mode`). */
export const COMMAND_CONFLICT_MODES = ['bundle-wins', 'conservative', 'namespace'] as const;
export type CommandConflictMode = (typeof COMMAND_CONFLICT_MODES)[number];

/** Кто инициировал команду (для события `command.invoked`, §8.2). */
export const COMMAND_ACTORS = ['user', 'cli'] as const;
export type CommandActor = (typeof COMMAND_ACTORS)[number];

/** Уровень диагностики discovery/валидации команд. */
export type CommandDiagnosticLevel = 'error' | 'warning' | 'info';

/** Коды диагностики команд/бандлов (только реально эмитируемые). */
export type CommandIssueCode =
  | 'invalid-frontmatter'
  | 'missing-name'
  | 'shadowed'
  | 'collision'
  | 'invalid-bundle'
  | 'missing-skill'
  | 'read-error'
  /** ADR-126 §9/§7.1: проектный каталог недоверенный — команда не грузится. */
  | 'untrusted';

/** Диагностика реестра команд (видна в `GET /api/v2/commands?diagnostics=1`). */
export interface CommandDiagnostic {
  level: CommandDiagnosticLevel;
  code: CommandIssueCode;
  message: string;
  /** Имя команды/бандла (если известно). */
  command?: string;
  /** Путь к файлу/каталогу (если применимо). */
  path?: string;
}

/**
 * YAML-группа скиллов (ADR-126 §14). `/bundle-name` грузит N тел одним
 * сообщением; bundle побеждает одноимённый skill.
 */
export interface SkillBundle {
  name: string;
  description: string;
  skills: string[];
  /** Дополнительная инструкция над телами скиллов (опционально). */
  instruction?: string;
}

/** Сводка команды (для `GET /api/v2/commands` и автокомплита). */
export interface CommandSummary {
  name: string;
  kind: CommandKind;
  description: string;
  argumentHint?: string;
  scope?: SkillScope;
  level?: SkillLevel;
  /** Имя бандла-источника (для `kind: 'bundle'`). */
  bundle?: string;
  /** Скиллы, входящие в bundle. */
  skills?: string[];
  /** `false` — команда видна, но недоступна (capabilities/deny). */
  available: boolean;
  unavailableReason?: 'capabilities' | 'denied';
}

/**
 * Статус результата резолвинга команды. `skill` — legacy: `CommandService`
 * больше не резолвит скиллы через `/` (ADR-126 §7).
 */
export type CommandResolveStatus =
  | 'builtin'
  | 'prompt'
  | 'template'
  | 'skill'
  | 'bundle'
  | 'summarization'
  | 'unknown'
  | 'denied'
  | 'unavailable';

/**
 * ADR-119: профиль сжатия контекста для ручного запуска.
 *
 * - `summarization` — итоги беседы (`/summary`);
 * - `compaction` — рабочее состояние по коду/проекту (`/compact`, ADR-126 §1).
 */
export type CommandCompressionMode = 'summarization' | 'compaction';

/**
 * Результат резолвинга `/`-команды (ADR-126 §14).
 *
 * - `builtin` — локальный ответ (`output`), LLM не вызывается; user+assistant
 *   сообщения помечаются `ephemeral` и исключаются из LLM-контекста;
 * - `prompt` — встроенная команда, генерирующая prompt (`/init`): текст в
 *   `prompt` уходит в LLM как явный пользовательский контекст, локального
 *   ответа нет и CLI не короткозамыкает;
 * - `template`/`skill`/`bundle` — текст в `prompt` уходит в LLM как явный
 *   пользовательский контекст;
 * - `summarization` — триггер ручного сжатия контекста (`/summary` —
 *   суммаризация, `/compact` — компактизация; профиль — в `compressionMode`);
 * - `unknown`/`denied`/`unavailable` — ответ-объяснение, LLM не вызывается.
 */
export interface CommandResolveResult {
  status: CommandResolveStatus;
  /** Имя команды без `/`. */
  name: string;
  /** Аргументы после имени. */
  args: string;
  kind?: CommandKind;
  /** Текст, инжектируемый в LLM (template/skill/bundle). */
  prompt?: string;
  /** Локальный ответ (builtin/unknown/denied/unavailable). */
  output?: string;
  /** Загруженные тела скиллов (для событий `skill.invoked`). */
  skills?: string[];
  /**
   * ADR-119: профиль сжатия для ручного запуска (`status: 'summarization'`).
   *
   * `/summary` — `summarization`, `/compact` — `compaction` (ADR-126 §1).
   * Поле аддитивное: не задано — режим определяет эффективный режим сессии.
   */
  compressionMode?: CommandCompressionMode;
  /** Причина denied/unavailable. */
  message?: string;
}

/** ADR-126 §15: результат исполнения inline shell (`` !`cmd` ``). */
export interface CommandShellResult {
  output: string;
  isError: boolean;
}

/**
 * ADR-126 §15: раннер inline shell. Оркестратор передаёт замыкание, которое
 * само проходит `PermissionEvaluator` (ADR-029) и исполняет команду; сервис
 * команд только вызывает его для подстановки `` !`cmd` ``.
 */
export type CommandShellRunner = (command: string) => Promise<CommandShellResult>;

/** Общие опции фильтрации/резолвинга команд. */
export interface CommandRuntimeOpts {
  projectWorkspace?: string;
  capabilities?: readonly string[];
  agent?: { id?: string; groups?: string[] };
  sessionEnabled?: string[];
  sessionDisabled?: string[];
  permissionConfig?: PermissionConfig;
  /** ADR-126 §15: раннер inline shell (только при включённом `skills.inlineShell`). */
  runShell?: CommandShellRunner;
}

/**
 * ADR-126 §14: рантайм-контракт команд для оркестратора/CLI. Структурно
 * реализуется `CommandService`; прокидывается в `OrchestratorOptions`.
 */
export interface CommandRuntime {
  /** Список команд (builtin + template + skills + bundles) с учётом фильтров. */
  list(opts?: CommandRuntimeOpts): Promise<{ commands: CommandSummary[]; diagnostics: CommandDiagnostic[] }>;
  /** Резолвинг `/`-команды. `undefined` — сообщение не является командой. */
  resolve(input: string, opts?: CommandRuntimeOpts): Promise<CommandResolveResult | undefined>;
}
