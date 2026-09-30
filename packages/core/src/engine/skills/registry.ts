import { mergeSkillScans, scanSkillSource } from './discovery.js';
import { SkillWatcher } from './watcher.js';
import { BUILTIN_SOURCE } from './builtin.js';
import type { DiscoveredSkill, SkillScanResult, SkillSource } from './types.js';

export interface SkillRegistryOptions {
  /** Построитель источников (зависит от project workspace). */
  sources: (opts?: { projectWorkspace?: string }) => Promise<SkillSource[]> | SkillSource[];
  watcher?: SkillWatcher;
  /**
   * AD-046 §9.5: встроенные скиллы (объявлены в коде). Подмешиваются **первыми**
   * в порядке discovery, поэтому project/instance их не перекрывают.
   */
  builtin?: readonly DiscoveredSkill[];
}

interface CacheEntry {
  signature: string;
  trusted: boolean;
  result: SkillScanResult;
}

/**
 * AD-046 §4: реестр скиллов — discovery + кэш с ленивой инвалидацией по mtime
 * (watcher). Кэш — по каталогу-источнику, поэтому смена проекта не сбрасывает
 * instance/config-кеш.
 */
export class SkillRegistry {
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _watcher: SkillWatcher;
  private readonly _sources: SkillRegistryOptions['sources'];
  private readonly _builtin: readonly DiscoveredSkill[];

  constructor(opts: SkillRegistryOptions) {
    this._watcher = opts.watcher ?? new SkillWatcher();
    this._sources = opts.sources;
    this._builtin = opts.builtin ?? [];
  }

  /** Список скиллов + диагностика (кэш с mtime-инвалидацией). */
  async list(opts?: { projectWorkspace?: string }): Promise<SkillScanResult> {
    const sources = await this._sources(opts);
    const entries: Array<{ source: SkillSource; result: SkillScanResult }> = [];
    // AD-046 §9.5: builtin — первыми (system-приоритет), без сканирования ФС.
    if (this._builtin.length > 0) {
      entries.push({
        source: BUILTIN_SOURCE,
        result: { skills: [...this._builtin], diagnostics: [] },
      });
    }
    for (const source of sources) {
      entries.push({ source, result: await this._loadSource(source) });
    }
    return mergeSkillScans(entries);
  }

  /** Найденный скилл по имени (или undefined). */
  async get(name: string, opts?: { projectWorkspace?: string }): Promise<DiscoveredSkill | undefined> {
    const { skills } = await this.list(opts);
    return skills.find((s) => s.name === name);
  }

  /** Принудительный ре-скан (POST /api/v2/skills/reload). */
  reload(): void {
    this._cache.clear();
    this._watcher.clear();
  }

  private async _loadSource(source: SkillSource): Promise<SkillScanResult> {
    const signature = await this._watcher.snapshot(source.dir);
    const cached = this._cache.get(source.dir);
    if (cached && cached.signature === signature && cached.trusted === source.trusted) {
      return cached.result;
    }
    const result = await scanSkillSource(source);
    this._cache.set(source.dir, { signature, trusted: source.trusted, result });
    this._watcher.remember(source.dir, signature);
    return result;
  }
}
