import type { ToolCapability } from './tools.js';

/**
 * ADR-046 §2/§4: скиллы — переиспользуемые инструкции (`SKILL.md` + supporting-файлы).
 * Здесь только контракты (типы), без бизнес-логики движка.
 */

/** Фактический источник скилла (ADR-046 §4.1). */
export const SKILL_SCOPES = ['instance', 'project'] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** Уровень включения скилла (модель ADR-071 §2.4/ADR-046 §4.5). */
export const SKILL_LEVELS = ['system', 'project', 'session'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/**
 * ADR-046 §6.1: способ вызова скилла — комбинация `user-invocable` /
 * `disable-model-invocation`.
 */
export const SKILL_INVOCATIONS = ['both', 'user', 'model', 'none'] as const;
export type SkillInvocation = (typeof SKILL_INVOCATIONS)[number];

/** ADR-046 §3.2: подсказка авто-применения (не разрешение). */
export const SKILL_TRIGGERS = ['manual', 'auto'] as const;
export type SkillTrigger = (typeof SKILL_TRIGGERS)[number];

/** ADR-046 §3.2: применимость скилла по режиму сессии (ADR-025). */
export const SKILL_MODES = ['plan', 'act', 'any'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

/**
 * ADR-046 §3.2: нормализованный frontmatter `SKILL.md` (после толерантного парсинга).
 * Неизвестные top-level ключи не теряются — попадают в `extra`.
 */
export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Свободный контейнер Anthropic/opencode (толерантен к любым ключам). */
  metadata?: Record<string, unknown>;
  /** Claude Code: рекомендуемый whitelist тулов (advisory). */
  allowedTools?: string[];
  whenToUse?: string;
  model?: string;
  agent?: string;
  argumentHint?: string;
  /** default `true`. */
  userInvocable: boolean;
  /** default `false`. */
  disableModelInvocation: boolean;
  /** Вычисляется из двух флагов (§6.1). */
  invocation: SkillInvocation;
  // --- metadata.synth.* (ADR-046 §3.2) ---
  tags?: string[];
  category?: string;
  relatedSkills?: string[];
  requiresCapabilities?: ToolCapability[];
  requiresToolsets?: string[];
  fallbackForCapabilities?: ToolCapability[];
  /** Пусто = все агенты. */
  agents?: string[];
  /** Пусто = все группы. */
  groups?: string[];
  /** Декларативная подсказка; фактический scope задаёт источник. */
  scope?: SkillScope;
  trigger?: SkillTrigger;
  command?: string;
  mode?: SkillMode;
  /** Неизвестные top-level ключи frontmatter (совместимость). */
  extra?: Record<string, unknown>;
}

/** Уровень диагностики discovery/валидации. */
export type SkillDiagnosticLevel = 'error' | 'warning' | 'info';

/** Код диагностики/проблемы парсинга. */
export type SkillIssueCode =
  | 'missing-frontmatter'
  | 'invalid-frontmatter'
  | 'invalid-frontmatter-type'
  | 'missing-name'
  | 'invalid-name'
  | 'name-mismatch'
  | 'missing-description'
  | 'invalid-description'
  | 'none-invocation'
  | 'shadowed'
  | 'untrusted'
  | 'read-error'
  /** ADR-046 §4.2: ошибка удалённого каталога (`skills.urls`): URL/индекс/парсинг. */
  | 'remote';

/** Проблема парсинга/валидации одного скилла. */
export interface SkillIssue {
  code: SkillIssueCode;
  message: string;
  /** Путь к файлу (если применимо). */
  path?: string;
}

/** Диагностика реестра (видна в `GET /api/v2/skills?diagnostics=1`). */
export interface SkillDiagnostic extends SkillIssue {
  level: SkillDiagnosticLevel;
  /** Имя скилла (если известно). */
  skill?: string;
  /** Каталог-источник (если известно). */
  dir?: string;
}

/**
 * Запись реестра скиллов (ADR-046 §4.5). Доступна через API/диагностику; тело
 * скилла в каталог промпта не попадает (progressive disclosure, §5).
 */
export interface SkillSummary {
  name: string;
  description: string;
  /** Фактический scope из источника. */
  scope: SkillScope;
  /** Уровень из источника (system/project; session — ADR-046 §4.5, Фаза 1 без хранения). */
  level: SkillLevel;
  /** Абсолютный путь каталога скилла. */
  dir: string;
  invocation: SkillInvocation;
  userInvocable: boolean;
  modelInvocable: boolean;
  category?: string;
  tags: string[];
  agents: string[];
  groups: string[];
  requiresCapabilities: string[];
  trusted: boolean;
  /**
   * Capability-aware: `false` — агенту не хватает `requires_capabilities`;
   * скилл виден, но помечен `unavailable` (§6.3).
   */
  available: boolean;
  unavailableReason?: 'capabilities';
}

/** Детали скилла (тело + supporting-файлы). */
export interface SkillDetail extends SkillSummary {
  meta: SkillMeta;
  body: string;
  /** Относительные пути supporting-файлов (без `SKILL.md`). */
  files: string[];
}

/** Параметры capability-aware/binding-фильтра каталога. */
export interface SkillCatalogFilter {
  /** Привязка агента (id + группы). */
  agent?: { id?: string; groups?: string[] };
  /** Capabilities агента для проверки `requires_capabilities`. */
  capabilities?: readonly string[];
  /** Per-session явное включение имён (volatile, ADR-046 §4.5). */
  sessionEnabled?: string[];
  /** Per-session opt-out имён/групп/категорий (volatile). */
  sessionDisabled?: string[];
}
