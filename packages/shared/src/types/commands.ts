import type { SkillScope, SkillLevel } from './skills.js';
import type { PermissionConfig } from './permission.js';

/**
 * AD-046 §7: slash-команды и bundles — контракты. Здесь только типы (без
 * бизнес-логики движка); резолвинг выполняется в core до обращения к LLM.
 */

/** Вид команды (AD-046 §7.2). */
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
  | 'read-error';

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
 * YAML-группа скиллов (AD-046 §7.3). `/bundle-name` грузит N тел одним
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

/** Статус результата резолвинга команды. */
export type CommandResolveStatus =
  | 'builtin'
  | 'template'
  | 'skill'
  | 'bundle'
  | 'summarization'
  | 'unknown'
  | 'denied'
  | 'unavailable';

/**
 * Результат резолвинга `/`-команды (AD-046 §7.1).
 *
 * - `builtin` — локальный ответ (`output`), LLM не вызывается; user+assistant
 *   сообщения помечаются `ephemeral` и исключаются из LLM-контекста;
 * - `template`/`skill`/`bundle` — текст в `prompt` уходит в LLM как явный
 *   пользовательский контекст;
 * - `summarization` — триггер ручной суммаризации (`/summary`);
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
  /** Причина denied/unavailable. */
  message?: string;
}

/**
 * AD-046 §7.3: рантайм-контракт команд для оркестратора/CLI. Структурно
 * реализуется `CommandService`; прокидывается в `OrchestratorOptions`.
 */
export interface CommandRuntime {
  /** Список команд (builtin + template + skills + bundles) с учётом фильтров. */
  list(opts?: {
    projectWorkspace?: string;
    capabilities?: readonly string[];
    agent?: { id?: string; groups?: string[] };
    sessionEnabled?: string[];
    sessionDisabled?: string[];
    permissionConfig?: PermissionConfig;
  }): Promise<{ commands: CommandSummary[]; diagnostics: CommandDiagnostic[] }>;
  /** Резолвинг `/`-команды. `undefined` — сообщение не является командой. */
  resolve(
    input: string,
    opts?: {
      projectWorkspace?: string;
      capabilities?: readonly string[];
      agent?: { id?: string; groups?: string[] };
      sessionEnabled?: string[];
      sessionDisabled?: string[];
      permissionConfig?: PermissionConfig;
    },
  ): Promise<CommandResolveResult | undefined>;
}
