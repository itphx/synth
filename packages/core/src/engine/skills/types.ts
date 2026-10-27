import type {
  PermissionConfig,
  SkillDiagnostic,
  SkillLevel,
  SkillMeta,
  SkillScope,
  SkillSummary,
} from '@itphx/synth-shared';
import type { SkillRepository } from '../../storage/ports/skill-repository.js';

/**
 * Виртуальный каталог instance-скиллов, приходящих из порта (ADR-116):
 * содержимое живёт в blob-сторе/на диске, ФС-пути домену не отдаются. Значение —
 * стабильный идентификатор источника (ключ кэша реестра), а не путь.
 */
export const PORT_SKILLS_SOURCE_DIR = 'instance:skills';

/** Префикс виртуального каталога скилла в blob-сторе: `blob:skills/<name>`. */
export const BLOB_SKILL_DIR_PREFIX = 'blob:';

/**
 * Происхождение каталога-источника (ADR-046 §4.2/§4.3).
 * `external` — локальные каталоги совместимости (`.opencode`/`.claude`/`.agents`,
 * `~/.config/opencode`); `url` — кэш удалённого каталога (`skills.urls`,
 * read-only, `trusted: false`).
 */
export type SkillOrigin = 'instance' | 'project' | 'config' | 'external' | 'url';

/** Каталог-источник скиллов (ADR-046 §4.2/§4.4). */
export interface SkillSource {
  scope: SkillScope;
  level: SkillLevel;
  origin: SkillOrigin;
  /**
   * Идентификатор каталога-источника: абсолютный путь для ФС-источников либо
   * стабильная метка порта (`instance:skills`, ADR-116).
   */
  dir: string;
  /** Доверен ли каталог (project-trust гейт, §4.4). */
  trusted: boolean;
  /**
   * ADR-116: instance-источник из порта `SkillRepository` (метаданные в SQL,
   * содержимое — в blob-сторе). Задан — сканирование идёт через порт
   * (`listNames`/`readMarkdown`/`listFiles`), а не обходом каталога.
   */
  repository?: SkillRepository;
}

/** Найденный и провалидированный скилл. */
export interface DiscoveredSkill {
  name: string;
  meta: SkillMeta;
  body: string;
  /**
   * Идентификатор каталога скилла: абсолютный путь для ФС-источников либо
   * виртуальный blob-каталог для порт-источника (`blob:skills/<name>`).
   */
  dir: string;
  /** Путь `SKILL.md`: абсолютный для ФС-источников, blob-путь для порт-источника. */
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

/**
 * ADR-046 §4.5: параметры гейтов скиллов (система/проект/сессия) — общие для
 * каталога, API скоупа и тула `skill`.
 */
export interface SkillScopeOptions {
  /**
   * Проектный hard-gate (`project.skills.enabled`). Не задан — гейт не настроен
   * (legacy, доступно всё); задан — allow-list (пустой = всё выключено).
   */
  projectEnabled?: string[];
  /** СНАПШОТ скиллов «по умолчанию» (`skillsDefaultOn`); не задан — legacy. */
  defaultOn?: string[];
  /** Системный hard-gate (категории/группы/имена) — скиллы исключаются. */
  systemDisabled?: { categories?: readonly string[]; groups?: readonly string[]; skills?: readonly string[] };
  /** Системный сид для новых проектов (в каталоге не фильтрует). */
  systemDisabledForNewProjects?: { categories?: readonly string[]; groups?: readonly string[]; skills?: readonly string[] };
  /** Per-session явное включение имён (§4.5). */
  sessionEnabled?: string[];
  /** Per-session opt-out имён/категорий/групп (§4.5). */
  sessionDisabled?: string[];
}

/** Параметры сборки каталога для промпта (ADR-046 §5/§6). */
export interface SkillCatalogOptions extends SkillScopeOptions {
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
 * ADR-046: рантайм скиллов, прокидываемый в тул `skill` через
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
   * ADR-046 §3.2: отсутствующие capabilities с учётом экспансии
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
