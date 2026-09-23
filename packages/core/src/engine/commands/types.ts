import type { CommandDiagnostic, CommandSummary, PermissionConfig, SkillBundle } from '@itphx/synth-shared';

/**
 * AD-046 §7: внутренние типы модуля slash-команд. Контракты (для оркестратора,
 * API, CLI) — в `@itphx/synth-shared` (`types/commands.ts`).
 */

/** Происхождение источника шаблонных команд (приоритет как у скиллов). */
export type CommandOrigin = 'instance' | 'project' | 'config';

/** Шаблонная `.md`-команда (AD-046 §7.2). */
export interface TemplateCommand {
  name: string;
  description: string;
  argumentHint?: string;
  agent?: string;
  model?: string;
  /** Advisory-whitelist тулов (AD-046 §8.1) — в права не транслируется. */
  allowedTools?: string[];
  body: string;
  file: string;
  dir: string;
  origin: CommandOrigin;
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
}

/** Конфиг конфликтов имён (`config.commands.conflict`). */
export interface CommandConflictConfig {
  mode: 'bundle-wins' | 'conservative' | 'namespace';
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

/** Полный набор источников для резолвера (после discovery). */
export interface CommandCatalog {
  builtins: string[];
  templates: TemplateCommand[];
  skills: CommandSkillEntry[];
  bundles: SkillBundle[];
  diagnostics: CommandDiagnostic[];
  /** Упорядоченный результат разрешения конфликтов. */
  entries: CommandEntry[];
}

/** Обобщённая запись для `list()`/резолвера. */
export type CommandEntry =
  | { kind: 'builtin'; summary: CommandSummary }
  | { kind: 'template'; summary: CommandSummary; template: TemplateCommand }
  | { kind: 'skill'; summary: CommandSummary; skill: CommandSkillEntry }
  | { kind: 'bundle'; summary: CommandSummary; bundle: SkillBundle };
