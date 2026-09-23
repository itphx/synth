import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillDetail, SkillDiagnostic, SkillMeta, SkillSummary } from '@itphx/synth-shared';
import { SkillStore, type CreateSkillInput, type UpdateSkillMarkdownInput } from '../../storage/skill-store.js';
import { buildSkillSources } from './discovery.js';
import { refreshRemoteCatalogs } from './remote.js';
import { SkillRegistry } from './registry.js';
import { buildSkillCatalog, toSkillSummary, type ComposerSkillsCatalog } from './catalog.js';
import {
  collectSupportingFiles,
  loadSkill,
  readSupportingFile as readSkillSupportingFile,
} from './loader.js';
import { resolveSkillRule } from '../permission/evaluator.js';
import { missingCapabilities } from './scope.js';
import type { DiscoveredSkill, LoadedSkill, SkillCatalogOptions, SkillScanResult } from './types.js';

export interface SkillServiceOptions {
  dataDir: string;
  /** `config.skills.paths`. */
  configPaths?: readonly string[];
  /** AD-046 §4.2/§4.3: `config.skills.urls` — read-only индексация удалённых каталогов. */
  urls?: readonly string[];
  /** `config.skills.trustedProjectDirs`. */
  trustedProjectDirs?: readonly string[];
  /** `config.skills.toolsets` — экспансия `requires_toolsets` (AD-046 §3.2). */
  toolsets?: Record<string, readonly string[]>;
  home?: string;
  store?: SkillStore;
  registry?: SkillRegistry;
}

export interface SkillListOptions {
  projectWorkspace?: string;
  capabilities?: readonly string[];
}

/**
 * AD-046 §4–§6: сервис скиллов — единая точка discovery/реестра/каталога и
 * записи instance-скиллов. Оркестратор получает каталог и тул `skill` через
 * этот сервис; роуты `/api/v2/skills` — CRUD над instance-деревом.
 */
export class SkillService {
  private readonly _store: SkillStore;
  private readonly _registry: SkillRegistry;
  private readonly _toolsets: Record<string, readonly string[]>;
  private readonly _urls: readonly string[];
  private readonly _cacheDir: string;
  private _remoteDiagnostics: SkillDiagnostic[] = [];
  private _remoteRefresh: Promise<void> | null = null;

  constructor(opts: SkillServiceOptions) {
    this._store = opts.store ?? new SkillStore({ dataDir: opts.dataDir });
    this._toolsets = opts.toolsets ?? {};
    this._urls = opts.urls ?? [];
    this._cacheDir = join(opts.dataDir, 'skills-cache');
    this._registry = opts.registry ?? new SkillRegistry({
      sources: (o) => buildSkillSources({
        dataDir: opts.dataDir,
        projectWorkspace: o?.projectWorkspace,
        configPaths: opts.configPaths,
        urls: opts.urls,
        skillsCacheDir: this._cacheDir,
        trustedProjectDirs: opts.trustedProjectDirs,
        home: opts.home ?? homedir(),
      }),
    });
  }

  /**
   * Реестр скиллов (discovery + диагностика). Диагностика последней read-only
   * индексации `skills.urls` (`refreshRemote`) добавляется к результату.
   */
  async list(opts?: { projectWorkspace?: string }): Promise<SkillScanResult> {
    const result = await this._registry.list(opts);
    if (this._remoteDiagnostics.length === 0) return result;
    return {
      skills: result.skills,
      diagnostics: [...this._remoteDiagnostics, ...result.diagnostics],
    };
  }

  /**
   * AD-046 §4.2/§4.3: read-only индексация `skills.urls` в кэш + `reload`.
   * In-flight guard (параллельные вызовы разделяют одно обновление). Конструктор
   * сеть не трогает — вызов явный (при старте — fire-and-forget).
   */
  async refreshRemote(): Promise<void> {
    if (this._remoteRefresh) return this._remoteRefresh;
    const task = this._doRefreshRemote().finally(() => {
      this._remoteRefresh = null;
    });
    this._remoteRefresh = task;
    return task;
  }

  private async _doRefreshRemote(): Promise<void> {
    if (this._urls.length === 0) return;
    const { diagnostics } = await refreshRemoteCatalogs({
      urls: this._urls,
      cacheDir: this._cacheDir,
    });
    this._remoteDiagnostics = diagnostics;
    this.reload();
  }

  /** Сводки реестра (capability-aware). */
  async listSummaries(opts?: SkillListOptions): Promise<{ skills: SkillSummary[]; diagnostics: SkillDiagnostic[] }> {
    const { skills, diagnostics } = await this.list({ projectWorkspace: opts?.projectWorkspace });
    return {
      skills: skills.map((s) => toSkillSummary(s, { capabilities: opts?.capabilities, toolsets: this._toolsets })),
      diagnostics,
    };
  }

  /** Детали скилла (тело + supporting-файлы). Тело недоверенного не отдаётся. */
  async detail(name: string, opts?: SkillListOptions): Promise<SkillDetail | undefined> {
    const skill = await this._registry.get(name, { projectWorkspace: opts?.projectWorkspace });
    if (!skill) return undefined;
    const summary = toSkillSummary(skill, { capabilities: opts?.capabilities, toolsets: this._toolsets });
    const files = skill.trusted ? await collectSupportingFiles(skill.dir) : [];
    return { ...summary, meta: skill.meta, body: skill.trusted ? skill.body : '', files };
  }

  async get(name: string, opts?: { projectWorkspace?: string }): Promise<DiscoveredSkill | undefined> {
    return this._registry.get(name, opts);
  }

  /** Каталог скиллов для промпта (AD-046 §5; deny скрывает, §8.1). */
  async buildCatalog(opts: SkillCatalogOptions): Promise<ComposerSkillsCatalog> {
    const { skills } = await this._registry.list({ projectWorkspace: opts.projectWorkspace });
    return buildSkillCatalog(skills, {
      ...opts,
      toolsets: opts.toolsets ?? this._toolsets,
      isDenied: (name) => resolveSkillRule(opts.permissionConfig, name)?.action === 'deny',
    });
  }

  /**
   * AD-046 §3.2: отсутствующие capabilities агента с экспансией
   * `requires_toolsets` через config.skills.toolsets.
   */
  missingCapabilities(
    meta: SkillMeta,
    capabilities: readonly string[] | undefined,
  ): string[] {
    return missingCapabilities(meta, capabilities, this._toolsets);
  }

  /** Загружает тело + supporting-файлы (core-тул `skill`). */
  async load(
    name: string,
    opts?: { projectWorkspace?: string; capabilities?: readonly string[] },
  ): Promise<LoadedSkill | undefined> {
    const skill = await this._registry.get(name, { projectWorkspace: opts?.projectWorkspace });
    if (!skill || !skill.trusted) return undefined;
    const summary = toSkillSummary(skill, { capabilities: opts?.capabilities });
    return loadSkill(skill, summary);
  }

  /** Читает supporting-файл скилла (тул `skill({name, file_path})`). */
  async readSupportingFile(
    name: string,
    relPath: string,
    opts?: { projectWorkspace?: string },
  ): Promise<string | undefined> {
    const skill = await this._registry.get(name, { projectWorkspace: opts?.projectWorkspace });
    if (!skill || !skill.trusted) return undefined;
    return readSkillSupportingFile(skill.dir, relPath);
  }

  /** Принудительный ре-скан (POST /api/v2/skills/reload). */
  reload(): void {
    this._registry.reload();
  }

  // --- Instance CRUD (запись только через сервис/FileStore-паттерн) ---

  async instanceExists(name: string): Promise<boolean> {
    return this._store.exists(name);
  }

  async createInstance(input: CreateSkillInput): Promise<SkillDetail | undefined> {
    await this._store.create(input);
    return this.detail(input.name);
  }

  async updateInstance(name: string, patch: UpdateSkillMarkdownInput): Promise<SkillDetail | undefined> {
    await this._store.updateMarkdown(name, patch);
    return this.detail(name);
  }

  async removeInstance(name: string): Promise<boolean> {
    return this._store.remove(name);
  }

  /** `true`, если скилл принадлежит instance-дереву (редактируем). */
  async isInstanceSkill(name: string): Promise<boolean> {
    return this._store.exists(name);
  }

  async listInstanceFiles(name: string): Promise<string[]> {
    return collectSupportingFiles(this._store.skillDir(name));
  }

  async readInstanceFile(name: string, relPath: string): Promise<string | null> {
    return this._store.readFile(name, relPath);
  }

  async writeInstanceFile(name: string, relPath: string, content: string): Promise<void> {
    await this._store.writeFile(name, relPath, content);
  }

  async deleteInstanceFile(name: string, relPath: string): Promise<boolean> {
    return this._store.deleteFile(name, relPath);
  }

  /** Абсолютный путь каталога instance-скилла (для API-ответов). */
  instanceDir(name: string): string {
    return this._store.skillDir(name);
  }
}
