/**
 * In-memory реализации портов настроек, умолчаний, словарей, паттернов секретов
 * и защищённых путей (PROP-032, шаг W2.2).
 *
 * Чистая реализация без модулей ФС (`fs`/`path`): состояние — в памяти процесса.
 * Семантика повторяет файловую (runtime-настройки, «системный дефолт +
 * пользовательский override», сброс к дефолту).
 *
 * Особенности/расхождения с файловой реализацией:
 * - `MemorySettingsRepository` — один объект `RuntimeSettings` вместо
 *   `{dataDir}/settings.json`; поведение секций (get/set/clear, «не задана →
 *   undefined/{}») идентично.
 * - `MemoryDictionaryRepository` — системные словари не читаются из
 *   `dictionaries/*.yaml` (нет ФС): известные категории/языки заданы
 *   константами, системные keywords пусты; пользовательские override работают.
 * - `MemoryProtectedPathsRepository` — системный base не читается из
 *   `definitions/protected-paths.json`: base пуст, каскад add/remove и
 *   динамические префиксы `{dataDir}/secrets|security` отсутствуют.
 */

import type {
  EgressPolicy,
  EgressPolicyScope,
  WebhooksEgressPolicy,
  McpNetworkPolicy,
  McpServerToolSettings,
  SkillsDisabledRequest,
  ToolsDisabledConfig,
  ToolsPolicy,
  WorkspaceOutsideRootPolicy,
  ProxyConfig,
} from '@itphx/synth-shared';
import type {
  DecisionRuntimeSettings,
  EventsRuntimeSettings,
  LlmGatewayRuntimeSettings,
  RuntimeSettings,
  SecurityRuntimeSettings,
} from '../runtime-settings.js';
import type { AppearanceDefaults, DefaultsRepository, DictionaryRepository, ProtectedPathsRepository, SecretPatternRepository, SettingsRepository } from '../ports/index.js';
import type { SecretPattern, SecretPatternsRaw } from '../../engine/gateway/secret-pattern-store.js';
import type { ProtectedPathsOverride, ProtectedPathsPolicy } from '../../engine/security/protected-paths.js';
import type { ProtectedPathsRaw } from '../../engine/security/protected-paths-store.js';
import type { StoredDictionary } from '../../engine/router/dictionary-store.js';
import { DEFAULT_PATTERNS } from '../../engine/gateway/secret-detector.js';

/** In-memory порт runtime-настроек (семантика `RuntimeSettingsStore`). */
export class MemorySettingsRepository implements SettingsRepository {
  private _settings: RuntimeSettings = {};

  async load(): Promise<RuntimeSettings> {
    return structuredClone(this._settings);
  }

  private _patch(part: Partial<RuntimeSettings>): void {
    this._settings = { ...this._settings, ...structuredClone(part) };
  }

  private _clear(key: keyof RuntimeSettings): void {
    const next = { ...this._settings };
    delete next[key];
    this._settings = next;
  }

  async getWorkspace(): Promise<string | undefined> {
    return this._settings.workspace;
  }

  async setWorkspace(workspace: string): Promise<void> {
    this._patch({ workspace });
  }

  async clearWorkspace(): Promise<void> {
    this._clear('workspace');
  }

  async getMcpSettings(): Promise<Record<string, McpServerToolSettings>> {
    return structuredClone(this._settings.mcpServers ?? {});
  }

  async setMcpSettings(servers: Record<string, McpServerToolSettings>): Promise<void> {
    this._patch({ mcpServers: servers });
  }

  async clearMcpSettings(): Promise<void> {
    this._clear('mcpServers');
  }

  async getLlmGatewaySettings(): Promise<Partial<LlmGatewayRuntimeSettings>> {
    return structuredClone(this._settings.llmGateway ?? {});
  }

  async setLlmGatewaySettings(config: Partial<LlmGatewayRuntimeSettings>): Promise<void> {
    this._patch({ llmGateway: config });
  }

  async clearLlmGatewaySettings(): Promise<void> {
    this._clear('llmGateway');
  }

  async getSecuritySettings(): Promise<Partial<SecurityRuntimeSettings>> {
    return structuredClone(this._settings.security ?? {});
  }

  async setSecuritySettings(config: Partial<SecurityRuntimeSettings>): Promise<void> {
    this._patch({ security: config });
  }

  async clearSecuritySettings(): Promise<void> {
    this._clear('security');
  }

  async getToolsPolicy(): Promise<ToolsPolicy | undefined> {
    return this._settings.toolsPolicy;
  }

  async setToolsPolicy(policy: ToolsPolicy): Promise<void> {
    this._patch({ toolsPolicy: policy });
  }

  async clearToolsPolicy(): Promise<void> {
    this._clear('toolsPolicy');
  }

  async getMcpPolicy(): Promise<ToolsPolicy | undefined> {
    return this._settings.mcpPolicy;
  }

  async setMcpPolicy(policy: ToolsPolicy): Promise<void> {
    this._patch({ mcpPolicy: policy });
  }

  async clearMcpPolicy(): Promise<void> {
    this._clear('mcpPolicy');
  }

  async getToolsDisabled(): Promise<ToolsDisabledConfig | undefined> {
    return this._settings.toolsDisabled;
  }

  async setToolsDisabled(config: ToolsDisabledConfig): Promise<void> {
    this._patch({ toolsDisabled: config });
  }

  async clearToolsDisabled(): Promise<void> {
    this._clear('toolsDisabled');
  }

  async getSkillsDisabled(): Promise<SkillsDisabledRequest | undefined> {
    return this._settings.skillsDisabled;
  }

  async setSkillsDisabled(config: SkillsDisabledRequest): Promise<void> {
    this._patch({ skillsDisabled: config });
  }

  async clearSkillsDisabled(): Promise<void> {
    this._clear('skillsDisabled');
  }

  async getSkillsDisabledForNewProjects(): Promise<SkillsDisabledRequest | undefined> {
    return this._settings.skillsDisabledForNewProjects;
  }

  async setSkillsDisabledForNewProjects(config: SkillsDisabledRequest): Promise<void> {
    this._patch({ skillsDisabledForNewProjects: config });
  }

  async clearSkillsDisabledForNewProjects(): Promise<void> {
    this._clear('skillsDisabledForNewProjects');
  }

  async getMigrationMarker(name: string): Promise<boolean> {
    return this._settings.migrations?.[name] === true;
  }

  async setMigrationMarker(name: string): Promise<void> {
    this._patch({ migrations: { ...(this._settings.migrations ?? {}), [name]: true } });
  }

  async getSkillsPolicy(): Promise<ToolsPolicy | undefined> {
    return this._settings.skillsPolicy;
  }

  async setSkillsPolicy(policy: ToolsPolicy): Promise<void> {
    this._patch({ skillsPolicy: policy });
  }

  async clearSkillsPolicy(): Promise<void> {
    this._clear('skillsPolicy');
  }

  async getTokenRatio(model: string): Promise<number | undefined> {
    return this._settings.tokenRatios?.[model];
  }

  async getTokenRatios(): Promise<Record<string, number>> {
    return { ...(this._settings.tokenRatios ?? {}) };
  }

  async setTokenRatio(model: string, ratio: number): Promise<void> {
    this._patch({ tokenRatios: { ...(this._settings.tokenRatios ?? {}), [model]: ratio } });
  }

  async getMcpNetworkPolicy(): Promise<McpNetworkPolicy | undefined> {
    return this._settings.mcpNetworkPolicy;
  }

  async setMcpNetworkPolicy(policy: McpNetworkPolicy): Promise<void> {
    this._patch({ mcpNetworkPolicy: policy });
  }

  async clearMcpNetworkPolicy(): Promise<void> {
    this._clear('mcpNetworkPolicy');
  }

  async getEgressPolicy(scope: EgressPolicyScope): Promise<EgressPolicy | WebhooksEgressPolicy | undefined> {
    return this._settings.egress?.[scope];
  }

  async setEgressPolicy(scope: EgressPolicyScope, policy: EgressPolicy | WebhooksEgressPolicy): Promise<void> {
    this._patch({ egress: { ...(this._settings.egress ?? {}), [scope]: policy } });
  }

  async clearEgressPolicy(scope: EgressPolicyScope): Promise<void> {
    const egress = this._settings.egress;
    if (!egress) return;
    const nextEgress = { ...egress };
    delete nextEgress[scope];
    if (Object.keys(nextEgress).length > 0) this._patch({ egress: nextEgress });
    else this._clear('egress');
  }

  async getDefaultAgent(): Promise<string | undefined> {
    return this._settings.defaultAgent;
  }

  async setDefaultAgent(id: string): Promise<void> {
    this._patch({ defaultAgent: id });
  }

  async clearDefaultAgent(): Promise<void> {
    this._clear('defaultAgent');
  }

  async getWorkspacePolicy(): Promise<WorkspaceOutsideRootPolicy | undefined> {
    return this._settings.workspacePolicy;
  }

  async setWorkspacePolicy(policy: WorkspaceOutsideRootPolicy): Promise<void> {
    this._patch({ workspacePolicy: policy });
  }

  async clearWorkspacePolicy(): Promise<void> {
    this._clear('workspacePolicy');
  }

  async getEvents(): Promise<Partial<EventsRuntimeSettings>> {
    return structuredClone(this._settings.events ?? {});
  }

  async setEvents(config: Partial<EventsRuntimeSettings>): Promise<void> {
    this._patch({ events: config });
  }

  async clearEvents(): Promise<void> {
    this._clear('events');
  }

  async getDecision(): Promise<Partial<DecisionRuntimeSettings>> {
    return structuredClone(this._settings.decision ?? {});
  }

  async setDecision(config: Partial<DecisionRuntimeSettings>): Promise<void> {
    this._patch({ decision: config });
  }

  async clearDecision(): Promise<void> {
    this._clear('decision');
  }

  async getProxySettings(): Promise<Partial<ProxyConfig> | undefined> {
    return this._settings.proxy ? structuredClone(this._settings.proxy) : undefined;
  }

  async setProxySettings(config: Partial<ProxyConfig>): Promise<void> {
    this._patch({ proxy: config });
  }

  async clearProxySettings(): Promise<void> {
    this._clear('proxy');
  }
}

/**
 * In-memory порт умолчаний оформления. Реализует контракт «системный + override»:
 * `saveDefaults` — частичный патч поверх текущих значений (валидацию полей
 * выполняет вызывающая сторона/UI — как у backend `DefaultsStore`).
 *
 * В core нет файловой реализации (реализация — backend `DefaultsStore`); этот
 * класс — эталонная in-memory реализация для тестов и будущего `storage.backend`.
 */
export class MemoryDefaultsRepository implements DefaultsRepository {
  private _defaults: AppearanceDefaults = {};

  async loadDefaults(): Promise<AppearanceDefaults> {
    return structuredClone(this._defaults);
  }

  async saveDefaults(patch: AppearanceDefaults): Promise<AppearanceDefaults> {
    this._defaults = { ...this._defaults, ...structuredClone(patch) };
    return structuredClone(this._defaults);
  }
}

/** Дефолтные паттерны в сериализуемом виде (`RegExp.source` → строка). */
function defaultPatternsAsStrings(): SecretPattern[] {
  return DEFAULT_PATTERNS.map((p) => ({
    type: p.type,
    regex: typeof p.regex === 'string' ? p.regex : p.regex.source,
  }));
}

/** `true`, если паттерн валиден (непустой `type`, компилируемый `regex`). */
function isValidPattern(p: unknown): p is SecretPattern {
  if (typeof p !== 'object' || p === null) return false;
  const { type, regex } = p as Record<string, unknown>;
  if (typeof type !== 'string' || type.trim() === '') return false;
  if (typeof regex !== 'string') return false;
  try {
    new RegExp(regex);
    return true;
  } catch {
    return false;
  }
}

/** In-memory порт паттернов детекции секретов («дефолт в коде + override»). */
export class MemorySecretPatternRepository implements SecretPatternRepository {
  private readonly _defaults = defaultPatternsAsStrings();
  private _override: SecretPattern[] | null = null;

  hasOverride(): boolean {
    return this._override !== null;
  }

  getDefaultPatterns(): SecretPattern[] {
    return this._defaults.map((p) => ({ ...p }));
  }

  getPatterns(): SecretPattern[] {
    if (this._override === null) return this.getDefaultPatterns();
    return this._override.map((p) => ({ ...p }));
  }

  getEffectivePatterns(): SecretPattern[] {
    return this.getPatterns();
  }

  async savePatterns(patterns: SecretPattern[]): Promise<boolean> {
    if (!Array.isArray(patterns) || !patterns.every(isValidPattern)) return false;
    this._override = patterns.map((p) => ({ type: p.type, regex: p.regex }));
    return true;
  }

  async reset(): Promise<boolean> {
    if (this._override === null) return false;
    this._override = null;
    return true;
  }

  getRawPatterns(): SecretPatternsRaw {
    return {
      isOverridden: this.hasOverride(),
      patterns: this.getPatterns(),
      defaultPatterns: this.getDefaultPatterns(),
    };
  }
}

/** Списковые ключи политики защищённых путей. */
const PROTECTED_PATH_KEYS = ['deniedPaths', 'deniedPrefixes', 'approvalPaths', 'deniedCommandPrefixes'] as const;

const EMPTY_POLICY: ProtectedPathsPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Каскад: base + add − remove. */
function applyCascade(base: string[], add: string[], remove: string[]): string[] {
  const removed = new Set(remove);
  const kept = base.filter((x) => !removed.has(x));
  const added = new Set(kept);
  for (const item of add) {
    if (!added.has(item)) kept.push(item);
  }
  return kept;
}

/**
 * In-memory порт защищённых путей. Системный base пуст (нет ФС/`definitions`);
 * override хранится в памяти в формате `add`/`remove` и применяется каскадом.
 */
export class MemoryProtectedPathsRepository implements ProtectedPathsRepository {
  private _override: ProtectedPathsOverride | null = null;

  hasOverride(): boolean {
    return this._override !== null;
  }

  getBase(): ProtectedPathsPolicy {
    return structuredClone(EMPTY_POLICY);
  }

  getPolicy(): ProtectedPathsPolicy {
    const base = this.getBase();
    if (!this._override) return base;
    const result: ProtectedPathsPolicy = structuredClone(EMPTY_POLICY);
    for (const key of PROTECTED_PATH_KEYS) {
      result[key] = applyCascade(base[key] ?? [], this._override.add[key] ?? [], this._override.remove[key] ?? []);
    }
    return result;
  }

  getEffective(): ProtectedPathsPolicy {
    return this.getPolicy();
  }

  getRaw(): ProtectedPathsRaw {
    const base = this.getBase();
    const policy = this.getPolicy();
    delete policy.dataDir;
    return { isOverridden: this.hasOverride(), policy, base, defaultBase: base };
  }

  getOverride(): ProtectedPathsOverride | null {
    return this._override ? structuredClone(this._override) : null;
  }

  async savePolicy(effective: ProtectedPathsPolicy): Promise<boolean> {
    if (!PROTECTED_PATH_KEYS.every((k) => isStringArray(effective[k] ?? []))) return false;
    const base = this.getBase();
    const override: ProtectedPathsOverride = { version: 1, add: {}, remove: {} };
    for (const key of PROTECTED_PATH_KEYS) {
      const baseArr = base[key] ?? [];
      const effArr = effective[key] ?? [];
      const effSet = new Set(effArr);
      const baseSet = new Set(baseArr);
      override.add[key] = effArr.filter((x) => !baseSet.has(x));
      override.remove[key] = baseArr.filter((x) => !effSet.has(x));
    }
    this._override = override;
    return true;
  }

  async saveRawOverride(raw: Partial<ProtectedPathsOverride>): Promise<boolean> {
    const toArr = (v: unknown): string[] => (isStringArray(v) ? [...v] : []);
    const add = raw.add ?? {};
    const remove = raw.remove ?? {};
    const override: ProtectedPathsOverride = { version: typeof raw.version === 'number' ? raw.version : 1, add: {}, remove: {} };
    for (const key of PROTECTED_PATH_KEYS) {
      override.add[key] = toArr(add[key]);
      override.remove[key] = toArr(remove[key]);
    }
    this._override = override;
    return true;
  }

  async reset(): Promise<boolean> {
    if (this._override === null) return false;
    this._override = null;
    return true;
  }
}

/** Известные категории словарей (системные файлы `dictionaries/*.yaml`). */
const DICTIONARY_KNOWN_CATEGORIES = ['coding', 'enum', 'injection', 'intents', 'research', 'small-talk'];
/** Поддерживаемые языки словарей. */
const DICTIONARY_LANGUAGES = ['ru', 'en'];

interface DictionaryOverrideData {
  keywords: string[];
  tools?: string[];
}

/**
 * In-memory порт словарей классификации.
 *
 * Системные словари не читаются (нет ФС): известные категории/языки — константы,
 * системные keywords пусты. Пользовательские override хранятся в памяти и
 * работают как в файловой реализации (включая безъязыковой `coding.tools`).
 */
export class MemoryDictionaryRepository implements DictionaryRepository {
  private readonly _overrides = new Map<string, DictionaryOverrideData>();
  private _codingTools: string[] = [];

  private _key(category: string, language: string): string {
    return `${category}.${language}`;
  }

  getKeywords(category: string, language: string): string[] {
    return [...(this._overrides.get(this._key(category, language))?.keywords ?? [])];
  }

  getCategorizedKeywords(category: string, language: string): Record<string, string[]> {
    void category;
    void language;
    return {};
  }

  getCodingTools(): string[] {
    return [...this._codingTools];
  }

  isKnownCategory(category: string): boolean {
    return DICTIONARY_KNOWN_CATEGORIES.includes(category);
  }

  isValidLanguage(language: string): boolean {
    return DICTIONARY_LANGUAGES.includes(language);
  }

  getDictionary(category: string, language: string): StoredDictionary | null {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    const override = this._overrides.get(this._key(category, language));
    const dictionary: StoredDictionary = {
      category,
      language,
      source: override ? 'user' : 'system',
      keywords: override ? [...override.keywords] : [],
    };
    if (category === 'coding') {
      dictionary.tools = this.getCodingTools();
    } else if (override?.tools) {
      dictionary.tools = [...override.tools];
    }
    return dictionary;
  }

  listDictionaries(): StoredDictionary[] {
    const out: StoredDictionary[] = [];
    for (const category of DICTIONARY_KNOWN_CATEGORIES) {
      for (const language of DICTIONARY_LANGUAGES) {
        const dictionary = this.getDictionary(category, language);
        if (dictionary) out.push(dictionary);
      }
    }
    return out;
  }

  async saveUserDictionary(
    category: string,
    language: string,
    data: { keywords: string[]; tools?: string[] },
  ): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    this._overrides.set(this._key(category, language), {
      keywords: [...data.keywords],
      ...(data.tools !== undefined ? { tools: [...data.tools] } : {}),
    });
    if (category === 'coding' && data.tools !== undefined) {
      this._codingTools = [...data.tools];
    }
    return this.getDictionary(category, language);
  }

  async deleteUserDictionary(category: string, language: string): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    this._overrides.delete(this._key(category, language));
    if (category === 'coding') this._codingTools = [];
    return this.getDictionary(category, language);
  }

  getContent(category: string, language: string): string {
    const override = this._overrides.get(this._key(category, language));
    if (!override) return '';
    const lines: string[] = [];
    lines.push('keywords:');
    for (const keyword of override.keywords) lines.push(`  - ${keyword}`);
    if (override.tools !== undefined) {
      lines.push('tools:');
      for (const tool of override.tools) lines.push(`  - ${tool}`);
    }
    return `${lines.join('\n')}\n`;
  }

  async saveUserContent(category: string, language: string, content: string): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;
    const parsed = parseDictionaryContent(content);
    return this.saveUserDictionary(category, language, parsed);
  }
}

/**
 * Упрощённый строгий парсер YAML-содержимого словаря (`keywords:`/`tools:`) —
 * правила те же, что у файловой реализации; ошибка — `Error` (в памяти нет
 * типизированного `DictionaryContentError`).
 */
function parseDictionaryContent(raw: string): { keywords: string[]; tools?: string[] } {
  const keywords: string[] = [];
  const tools: string[] = [];
  let current: 'keywords' | 'tools' | null = null;
  let keywordsSeen = false;
  let toolsSeen = false;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === 'keywords:' || trimmed === 'tools:') {
      current = trimmed === 'keywords:' ? 'keywords' : 'tools';
      if (current === 'keywords') keywordsSeen = true;
      else toolsSeen = true;
      continue;
    }
    if (trimmed.startsWith('-')) {
      if (!current) throw new Error(`Строка ${i + 1}: элемент списка вне keywords/tools`);
      let value = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed.slice(1);
      value = value.trim().replace(/^["']|["']$/g, '');
      if (!value) throw new Error(`Строка ${i + 1}: пустое значение списка`);
      if (current === 'keywords') keywords.push(value.toLowerCase());
      else tools.push(value);
      continue;
    }
    throw new Error(`Строка ${i + 1}: некорректный YAML — ${trimmed}`);
  }
  if (!keywordsSeen) throw new Error('YAML: отсутствует ключ keywords');
  return toolsSeen
    ? { keywords: dedupeStrings(keywords), tools: dedupeStrings(tools) }
    : { keywords: dedupeStrings(keywords) };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
