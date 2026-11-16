import type {
  CommandDiagnostic,
  CommandShellRunner,
  CommandSummary,
  PermissionConfig,
  SkillBundle,
} from '@itphx/synth-shared';

/**
 * ADR-126 §1: внутренние типы модуля slash-команд. Контракты (для оркестратора,
 * API, CLI) — в `@itphx/synth-shared` (`types/commands.ts`).
 */

/** Происхождение источника шаблонных команд (приоритет как у скиллов). */
export type CommandOrigin = 'instance' | 'project' | 'config';

/** Шаблонная `.md`-команда (ADR-126 §1). */
export interface TemplateCommand {
  name: string;
  description: string;
  argumentHint?: string;
  agent?: string;
  model?: string;
  /** Advisory-whitelist тулов (ADR-126 §10) — в права не транслируется. */
  allowedTools?: string[];
  body: string;
  file: string;
  dir: string;
  origin: CommandOrigin;
  /** `false` — команда видна в диагностике, но не резолвится (§4.4/§7.1). */
  trusted: boolean;
  mtimeMs: number;
}

/** Результат сканирования одного каталога шаблонных команд. */
export interface CommandScanResult {
  commands: TemplateCommand[];
  diagnostics: CommandDiagnostic[];
}

/** Каталог-источник шаблонных команд. */
export interface CommandSource {
  origin: CommandOrigin;
  dir: string;
  /** Доверен ли каталог (project-trust гейт, §4.4/§7.1). По умолчанию — да. */
  trusted?: boolean;
}

/** Конфиг конфликтов имён (`config.commands.conflict`). */
export interface CommandConflictConfig {
  mode: 'bundle-wins' | 'conservative' | 'namespace';
  /**
   * @deprecated ADR-126 §7: скиллов в `/`-каталоге нет, `<bundle>:<skill>`
   * не создаётся. Поле оставлено для совместимости конфига.
   */
  namespacePrefix: boolean;
}

/** Рантайм-конфиг модуля команд. */
export interface CommandRuntimeConfig {
  dataDir: string;
  commandsPaths: readonly string[];
  bundlesPath: string;
  conflict: CommandConflictConfig;
  maxArgumentsLength: number;
  maxRenderedBytes: number;
  /** `config.skills.toolsets` — экспансия `requires_toolsets` в capabilities. */
  toolsets: Record<string, readonly string[]>;
  trustedProjectDirs?: readonly string[];
  /** ADR-126 §15: `!`cmd`` в шаблонных командах (по умолчанию false). */
  inlineShell: boolean;
  home?: string;
}

/** Контекст выполнения команды (сессия/агент). */
export interface CommandContext {
  projectWorkspace?: string;
  capabilities?: readonly string[];
  agent?: { id?: string; groups?: string[] };
  sessionEnabled?: string[];
  sessionDisabled?: string[];
  permissionConfig?: PermissionConfig;
  /**
   * ADR-126 §15: раннер inline shell. Приходит готовым от оркестратора
   * (замыкание уже прошло `PermissionEvaluator`); сервис команд не строит
   * permission-проверки сам (ADR-029).
   */
  runShell?: CommandShellRunner;
}

/** Запись скилла для резолвера команд (проекция `SkillSummary`). */
export interface CommandSkillEntry {
  /** Имя команды (`metadata.synth.command` ?? `name`). */
  commandName: string;
  skillName: string;
  description: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  trusted: boolean;
  requiresCapabilities: string[];
  requiresToolsets: string[];
  available: boolean;
  argumentHint?: string;
}

/** Загрузка bundle: объединённый контент + вошедшие скиллы. */
export interface LoadedBundle {
  bundle: SkillBundle;
  prompt: string;
  skills: string[];
  diagnostics: CommandDiagnostic[];
}

/**
 * Полный набор источников для резолвера (после discovery).
 *
 * `skills` — **не** источник `/`-команд (ADR-126 §7): это список для
 * встроенной `/skills`; резолвинг `$name` живёт отдельно
 * (`engine/commands/dollar-skills.ts`).
 */
export interface CommandCatalog {
  builtins: string[];
  templates: TemplateCommand[];
  skills: CommandSkillEntry[];
  bundles: SkillBundle[];
  diagnostics: CommandDiagnostic[];
  /** Упорядоченный результат разрешения конфликтов (builtin/template/bundle). */
  entries: CommandEntry[];
}

/** Обобщённая запись для `list()`/резолвера. */
export type CommandEntry =
  | { kind: 'builtin'; summary: CommandSummary }
  | { kind: 'template'; summary: CommandSummary; template: TemplateCommand }
  | { kind: 'bundle'; summary: CommandSummary; bundle: SkillBundle };
