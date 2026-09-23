import type {
  PermissionConfig,
  SkillDiagnostic,
  SkillLevel,
  SkillMeta,
  SkillScope,
  SkillSummary,
} from '@itphx/synth-shared';

/**
 * Происхождение каталога-источника (AD-046 §4.2/§4.3).
 * `external` — локальные каталоги совместимости (`.opencode`/`.claude`/`.agents`,
 * `~/.config/opencode`); `url` — кэш удалённого каталога (`skills.urls`,
 * read-only, `trusted: false`).
 */
export type SkillOrigin = 'instance' | 'project' | 'config' | 'external' | 'url';

/** Каталог-источник скиллов (AD-046 §4.2/§4.4). */
export interface SkillSource {
  scope: SkillScope;
  level: SkillLevel;
  origin: SkillOrigin;
  /** Абсолютный путь каталога, содержащего подкаталоги-скиллы. */
  dir: string;
  /** Доверен ли каталог (project-trust гейт, §4.4). */
  trusted: boolean;
}

/** Найденный и провалидированный скилл. */
export interface DiscoveredSkill {
  name: string;
  meta: SkillMeta;
  body: string;
  /** Абсолютный путь каталога скилла (base directory). */
  dir: string;
  /** Абсолютный путь `SKILL.md`. */
  file: string;
  source: SkillSource;
  /** `false` — скилл виден в реестре, но не грузится (§4.4). */
  trusted: boolean;
  mtimeMs: number;
}

/** Результат сканирования одного каталога-источника. */
export interface SkillScanResult {
  skills: DiscoveredSkill[];
  diagnostics: SkillDiagnostic[];
}

/** Параметры сборки каталога для промпта (AD-046 §5/§6). */
export interface SkillCatalogOptions {
  /** Рабочий каталог проекта (источник project-скиллов и trust-статуса). */
  projectWorkspace?: string;
  /** Привязка агента (`agents`/`groups`, §6.2). */
  agent?: { id?: string; groups?: string[] };
  /** Capabilities агента для capability-aware (§6.3). */
  capabilities?: readonly string[];
  /** `config.skills.toolsets` — экспансия `requires_toolsets` (§3.2). */
  toolsets?: Record<string, readonly string[]>;
  /** Permission-конфиг сессии (deny скрывает скилл, §8.1). */
  permissionConfig?: PermissionConfig;
  /** Per-session явное включение имён (§4.5). */
  sessionEnabled?: string[];
  /** Per-session opt-out имён/категорий/групп (§4.5). */
  sessionDisabled?: string[];
}

/** Загруженный скилл (тело + supporting-файлы) для core-тула `skill`. */
export interface LoadedSkill {
  summary: SkillSummary;
  meta: SkillMeta;
  body: string;
  dir: string;
  /** Относительные пути supporting-файлов (без `SKILL.md`). */
  files: string[];
}

/**
 * AD-046: рантайм скиллов, прокидываемый в тул `skill` через
 * `ToolContext.extra` (в `ToolContext` нет `dataDir`). Структурно реализуется
 * `SkillService`; саб-агенты получают тот же объект через `TaskExtra`.
 */
export interface SkillRuntime {
  buildCatalog(opts: SkillCatalogOptions): Promise<import('./catalog.js').ComposerSkillsCatalog>;
  get(name: string, opts?: { projectWorkspace?: string }): Promise<DiscoveredSkill | undefined>;
  load(
    name: string,
    opts?: { projectWorkspace?: string; capabilities?: readonly string[] },
  ): Promise<LoadedSkill | undefined>;
  /**
   * AD-046 §3.2: отсутствующие capabilities с учётом экспансии
   * `requires_toolsets` (config.skills.toolsets). Необязателен — вызывающие
   * без конфига используют `requires_capabilities` напрямую.
   */
  missingCapabilities?(
    meta: SkillMeta,
    capabilities: readonly string[] | undefined,
  ): string[];
  readSupportingFile(
    name: string,
    relPath: string,
    opts?: { projectWorkspace?: string },
  ): Promise<string | undefined>;
}
