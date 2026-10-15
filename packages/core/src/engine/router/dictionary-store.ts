/**
 * DictionaryStore — загрузка словарей классификации (ADR-034).
 * Принцип как у ContextConfig: системные файлы + пользовательские переопределения.
 *
 * Системные: packages/core/dictionaries/{category}.{lang}.yaml
 * Пользовательские: $SYNTH_DATA_DIR/dictionaries/{category}.{lang}.yaml
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '@itphx/synth-shared';
import { warning } from '../../logger.js';
import type { DictionaryRepository } from '../../storage/ports/dictionary-repository.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

interface DictionaryData {
  keywords: string[];
  tools?: string[];
}

/** Поддерживаемые языки словарей. */
export const DICTIONARY_LANGUAGES = ['ru', 'en'] as const;
export type DictionaryLanguage = (typeof DICTIONARY_LANGUAGES)[number];

/** Лимиты, общие для API управления словарями. */
export const DICTIONARY_MAX_KEYWORDS = 2000;
export const DICTIONARY_MAX_TOOLS = 500;

/** Ошибка разбора/валидации содержимого словаря (YAML-текста). */
export class DictionaryContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DictionaryContentError';
  }
}

/** Дедупликация строк с сохранением порядка. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Словарь с признаком источника (для API управления словарями). */
export interface StoredDictionary {
  category: string;
  language: string;
  source: 'system' | 'user';
  keywords: string[];
  tools?: string[];
}

/** Имя пользовательского файла tools (безъязыковой, для категории coding). */
const TOOLS_FILE = 'coding.tools.yaml';

export class DictionaryStore implements DictionaryRepository {
  readonly systemDir: string;
  readonly userDir: string;

  constructor(userDataDir: string, systemDir?: string) {
    // Fallback-поиск: dist/dictionaries (при запуске из собранного пакета)
    // или packages/core/dictionaries (при запуске из src через tsx).
    const candidates = [
      join(CURRENT_DIR, '..', '..', 'dictionaries'),
      join(CURRENT_DIR, '..', '..', '..', 'dictionaries'),
    ];
    this.systemDir = systemDir ?? candidates.find((p) => existsSync(p)) ?? candidates[0]!;
    this.userDir = join(userDataDir, 'dictionaries');
  }

  /**
   * Получить ключевые слова для категории на указанном языке.
   * Приоритет: пользовательский файл → системный → fallback на базовый .yaml.
   * Поддерживает категории: coding, research, small-talk, intents, enum.
   */
  getKeywords(category: string, language: string): string[] {
    return this._loadDictionary(category, language).keywords;
  }

  /**
   * Получить категоризированные ключевые слова (расширенный формат ADR-035).
   * Парсит категории верхнего уровня (greeting, farewell, ...) из YAML.
   * Возвращает Record с массивами keywords для каждой подкатегории.
   */
  getCategorizedKeywords(category: string, language: string): Record<string, string[]> {
    return this._loadCategorizedDictionary(category, language);
  }

  /** Получить список tool-имён, указывающих на coding-сессию (безъязыковой). */
  getCodingTools(): string[] {
    const data = this._loadTools();
    return data.tools ?? [];
  }

  // ── API управления словарями ──

  /** Известна ли категория (есть среди системных словарей). */
  isKnownCategory(category: string): boolean {
    return this._knownCategories().includes(category);
  }

  /** Поддерживается ли язык словаря (ru/en). */
  isValidLanguage(language: string): boolean {
    return (DICTIONARY_LANGUAGES as readonly string[]).includes(language);
  }

  /**
   * Словарь категории/языка с признаком источника.
   * Приоритет (как при классификации): пользовательский файл → системный.
   * Для категории coding в tools попадает безъязыковой coding.tools.yaml.
   */
  getDictionary(category: string, language: string): StoredDictionary | null {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;

    const userPath = join(this.userDir, `${category}.${language}.yaml`);
    const sysPath = join(this.systemDir, `${category}.${language}.yaml`);
    const fallbackPath = join(this.systemDir, `${category}.yaml`);
    const userToolsPath = join(this.userDir, TOOLS_FILE);
    const hasUserOverride = existsSync(userPath) || (category === 'coding' && existsSync(userToolsPath));

    if (!existsSync(userPath) && !existsSync(sysPath) && !existsSync(fallbackPath)) return null;

    const loaded = this._loadDictionary(category, language);
    const dictionary: StoredDictionary = {
      category,
      language,
      source: hasUserOverride ? 'user' : 'system',
      keywords: loaded.keywords,
    };

    if (category === 'coding') {
      dictionary.tools = this.getCodingTools();
    } else if (loaded.tools) {
      dictionary.tools = loaded.tools;
    }

    return dictionary;
  }

  /** Список всех известных словарей (категория × язык), включая системные. */
  listDictionaries(): StoredDictionary[] {
    const out: StoredDictionary[] = [];
    for (const category of this._knownCategories()) {
      for (const language of DICTIONARY_LANGUAGES) {
        const dictionary = this.getDictionary(category, language);
        if (dictionary) out.push(dictionary);
      }
    }
    return out;
  }

  /**
   * Записать пользовательское переопределение словаря (атомарно).
   * Файл: {userDir}/{category}.{lang}.yaml (keywords: [...], при наличии — tools: [...]).
   * Для coding tools дополнительно зеркалируются в безъязыковой coding.tools.yaml,
   * чтобы их подхватывал getCodingTools() (используется классификатором).
   */
  async saveUserDictionary(
    category: string,
    language: string,
    data: { keywords: string[]; tools?: string[] },
  ): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;

    await mkdir(this.userDir, { recursive: true });
    await this._writeYamlAtomic(join(this.userDir, `${category}.${language}.yaml`), {
      keywords: data.keywords,
      tools: data.tools,
    });

    if (category === 'coding' && data.tools !== undefined) {
      await this._writeYamlAtomic(join(this.userDir, TOOLS_FILE), { tools: data.tools });
    }

    return this.getDictionary(category, language);
  }

  /**
   * Удалить пользовательское переопределение → словарь возвращается к системному.
   * Для coding вместе с файлом языка сбрасываются и tools (coding.tools.yaml).
   */
  async deleteUserDictionary(category: string, language: string): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;

    await rm(join(this.userDir, `${category}.${language}.yaml`), { force: true });
    if (category === 'coding') {
      await rm(join(this.userDir, TOOLS_FILE), { force: true });
    }

    return this.getDictionary(category, language);
  }

  /**
   * Действующее содержимое словаря (YAML-текст) — то, что редактируется в UI.
   * Приоритет: пользовательский файл → системный {category}.{lang}.yaml →
   * системный {category}.yaml. Формат — как у файлов (keywords: [...], tools: [...]).
   */
  getContent(category: string, language: string): string {
    const candidates = [
      join(this.userDir, `${category}.${language}.yaml`),
      join(this.systemDir, `${category}.${language}.yaml`),
      join(this.systemDir, `${category}.yaml`),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        // пробуем следующий источник
      }
    }
    return '';
  }

  /**
   * Записать пользовательское переопределение из YAML-текста (атомарно).
   * Текст парсится и валидируется (те же правила: keywords — непустые строки,
   * лимиты 2000/500), затем записывается нормализованный YAML.
   * Бросает DictionaryContentError при ошибке разбора/валидации;
   * null — если категория/язык неизвестны.
   */
  async saveUserContent(
    category: string,
    language: string,
    content: string,
  ): Promise<StoredDictionary | null> {
    if (!this.isKnownCategory(category) || !this.isValidLanguage(language)) return null;

    const parsed = this._parseContentYaml(content);
    if (parsed.keywords.length > DICTIONARY_MAX_KEYWORDS) {
      throw new DictionaryContentError(`keywords: не более ${DICTIONARY_MAX_KEYWORDS} слов`);
    }
    if (parsed.tools && parsed.tools.length > DICTIONARY_MAX_TOOLS) {
      throw new DictionaryContentError(`tools: не более ${DICTIONARY_MAX_TOOLS} элементов`);
    }

    return this.saveUserDictionary(category, language, {
      keywords: parsed.keywords,
      tools: parsed.tools,
    });
  }

  // ── private ──

  /** Категории системных словарей (coding, research, small-talk, intents, enum, injection). */
  private _knownCategories(): string[] {
    const categories = new Set<string>();
    let files: string[];
    try {
      files = readdirSync(this.systemDir);
    } catch {
      return [];
    }
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue;
      const base = file.slice(0, -'.yaml'.length);
      // Безъязыковой список инструментов (coding.tools) — не отдельная категория.
      if (base.endsWith('.tools')) continue;
      const dot = base.indexOf('.');
      if (dot <= 0) continue;
      categories.add(base.slice(0, dot));
    }
    return [...categories].sort();
  }

  /** Сериализовать словарь в YAML и записать атомарно (tmp + rename). */
  private async _writeYamlAtomic(
    path: string,
    data: { keywords?: string[]; tools?: string[] },
  ): Promise<void> {
    const lines: string[] = [];
    if (data.keywords !== undefined) {
      lines.push('keywords:');
      for (const keyword of data.keywords) lines.push(`  - ${this._yamlScalar(keyword)}`);
    }
    if (data.tools !== undefined) {
      lines.push('tools:');
      for (const tool of data.tools) lines.push(`  - ${this._yamlScalar(tool)}`);
    }
    const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    await atomicWrite(
      (p, d) => writeFile(p, d, 'utf-8'),
      (o, n) => rename(o, n),
      path,
      content,
    );
  }

  /** Значение списка для упрощённого парсера: кавычим только начинающиеся с '#'. */
  private _yamlScalar(value: string): string {
    return value.startsWith('#') ? `"${value}"` : value;
  }

  private _loadDictionary(category: string, language: string): DictionaryData {
    // 1. Пользовательский: {userDir}/{category}.{lang}.yaml
    const userPath = join(this.userDir, `${category}.${language}.yaml`);
    if (existsSync(userPath)) {
      const data = this._parseYaml(userPath);
      if (data) return data;
    }

    // 2. Системный: {systemDir}/{category}.{lang}.yaml
    const sysPath = join(this.systemDir, `${category}.${language}.yaml`);
    if (existsSync(sysPath)) {
      const data = this._parseYaml(sysPath);
      if (data) return data;
    }

    // 3. Fallback: {systemDir}/{category}.yaml (без языка)
    const fallbackPath = join(this.systemDir, `${category}.yaml`);
    if (existsSync(fallbackPath)) {
      const data = this._parseYaml(fallbackPath);
      if (data) return data;
    }

    warning('DICTIONARY', `Словарь не найден: ${category}.${language}.yaml`);
    return { keywords: [] };
  }

  private _loadTools(): DictionaryData {
    // Пользовательский
    const userPath = join(this.userDir, 'coding.tools.yaml');
    if (existsSync(userPath)) {
      const data = this._parseYaml(userPath);
      if (data) return data;
    }

    // Системный
    const sysPath = join(this.systemDir, 'coding.tools.yaml');
    if (existsSync(sysPath)) {
      const data = this._parseYaml(sysPath);
      if (data) return data;
    }

    return { keywords: [], tools: [] };
  }

  /** Загрузка категоризированного словаря (ADR-035). */
  private _loadCategorizedDictionary(category: string, language: string): Record<string, string[]> {
    // 1. Пользовательский
    const userPath = join(this.userDir, `${category}.${language}.yaml`);
    if (existsSync(userPath)) {
      const data = this._parseCategorizedYaml(userPath);
      if (data) return data;
    }

    // 2. Системный
    const sysPath = join(this.systemDir, `${category}.${language}.yaml`);
    if (existsSync(sysPath)) {
      const data = this._parseCategorizedYaml(sysPath);
      if (data) return data;
    }

    // 3. Fallback: без языка
    const fallbackPath = join(this.systemDir, `${category}.yaml`);
    if (existsSync(fallbackPath)) {
      const data = this._parseCategorizedYaml(fallbackPath);
      if (data) return data;
    }

    warning('DICTIONARY', `Категоризированный словарь не найден: ${category}.${language}.yaml`);
    return {};
  }

  /** Парсер для категоризированных словарей (ADR-035). */
  private _parseCategorizedYaml(path: string): Record<string, string[]> | null {
    try {
      const raw = readFileSync(path, 'utf-8');
      return this._parseSimpleCategorizedYaml(raw);
    } catch {
      return null;
    }
  }

  /**
   * Парсит YAML с вложенными категориями:
   * categories:
   *   greeting:
   *     keywords: [...]
   *     answers: [...]
   *   farewell:
   *     keywords: [...]
   *     answers: [...]
   */
  private _parseSimpleCategorizedYaml(raw: string): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    const lines = raw.split('\n');
    let currentCategory: string | null = null;
    let currentKey: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.length - line.trimStart().length;

      // Корневой ключ (отступ 0): categories: или keywords:
      if (indent === 0 && (trimmed === 'categories:' || trimmed === 'keywords:')) {
        currentCategory = null;
        currentKey = null;
        continue;
      }

      // Подкатегория первого уровня (отступ 2): yes:, no:, greeting: и т.д.
      if (indent === 2 && !trimmed.startsWith('-') && trimmed.endsWith(':')
        && trimmed !== 'keywords:' && trimmed !== 'answers:') {
        currentCategory = trimmed.slice(0, -1).trim();
        if (!result[`${currentCategory}_keywords`]) {
          result[`${currentCategory}_keywords`] = [];
        }
        currentKey = null;
        continue;
      }

      // Вложенный ключ (отступ 4): keywords: или answers:
      if (indent === 4 && currentCategory) {
        if (trimmed === 'keywords:') {
          currentKey = 'keywords';
          continue;
        }
        if (trimmed === 'answers:') {
          currentKey = 'answers';
          continue;
        }
      }

      // Элемент списка
      if (trimmed.startsWith('- ') || trimmed.startsWith('-')) {
        let value = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed.slice(1);
        value = value.trim().replace(/^["']|["']$/g, '');

        if (value && currentCategory) {
          if (indent === 4 && !currentKey) {
            // Прямой элемент подкатегории (keywords без явного keywords:)
            result[`${currentCategory}_keywords`]!.push(value.toLowerCase());
          } else if (indent === 6 && currentKey) {
            // Вложенный элемент внутри keywords: или answers:
            const suffix = currentKey === 'answers' ? '_answers' : '_keywords';
            const targetKey = `${currentCategory}${suffix}`;
            if (!result[targetKey]) {
              result[targetKey] = [];
            }
            result[targetKey]!.push(
              currentKey === 'answers' ? value : value.toLowerCase(),
            );
          }
        }
      }
    }

    return result;
  }

  /** Простой парсер YAML — только для списков keywords: [...] и tools: [...] */
  private _parseYaml(path: string): DictionaryData | null {
    try {
      const raw = readFileSync(path, 'utf-8');
      return this._parseSimpleYaml(raw);
    } catch {
      return null;
    }
  }

  /** Упрощённый парсер: keywords: [...], tools: [...]. Без внешних зависимостей. */
  private _parseSimpleYaml(raw: string): DictionaryData {
    const result: DictionaryData = { keywords: [] };
    const lines = raw.split('\n');
    let currentKey: 'keywords' | 'tools' | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Ключ верхнего уровня: keywords: или tools:
      if (trimmed === 'keywords:' || trimmed === 'tools:') {
        currentKey = trimmed === 'keywords:' ? 'keywords' : 'tools';
        if (currentKey === 'tools') result.tools = [];
        continue;
      }

      // Элемент списка: - "значение" или - значение
      if (trimmed.startsWith('- ') || trimmed.startsWith('-')) {
        let value = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed.slice(1);
        value = value.trim().replace(/^["']|["']$/g, ''); // убрать кавычки
        if (value && currentKey) {
          if (currentKey === 'keywords') {
            result.keywords.push(value.toLowerCase());
          } else if (currentKey === 'tools') {
            result.tools!.push(value);
          }
        }
      }
    }

    return result;
  }

  /**
   * Строгий парсер YAML-содержимого словаря (keywords/tools) для PUT { content }.
   * В отличие от _parseSimpleYaml отвергает неизвестные ключи, элементы без
   * ключа и пустые значения — ошибка разбора → DictionaryContentError (400).
   * Ключевые слова нормализуются (trim/lowercase/дедупликация), tools — trim/дедуп.
   */
  private _parseContentYaml(raw: string): DictionaryData {
    const keywords: string[] = [];
    const tools: string[] = [];
    let current: 'keywords' | 'tools' | null = null;
    let keywordsSeen = false;
    let toolsSeen = false;

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = (lines[i] ?? '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed === 'keywords:' || trimmed === 'tools:') {
        current = trimmed === 'keywords:' ? 'keywords' : 'tools';
        if (current === 'keywords') keywordsSeen = true;
        else toolsSeen = true;
        continue;
      }

      if (trimmed.startsWith('-')) {
        if (!current) {
          throw new DictionaryContentError(
            `Строка ${i + 1}: элемент списка вне keywords/tools`,
          );
        }
        let value = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed.slice(1);
        value = value.trim().replace(/^["']|["']$/g, '');
        if (!value) {
          throw new DictionaryContentError(`Строка ${i + 1}: пустое значение списка`);
        }
        if (current === 'keywords') keywords.push(value.toLowerCase());
        else tools.push(value);
        continue;
      }

      throw new DictionaryContentError(`Строка ${i + 1}: некорректный YAML — ${trimmed}`);
    }

    if (!keywordsSeen) {
      throw new DictionaryContentError('YAML: отсутствует ключ keywords');
    }

    return toolsSeen
      ? { keywords: dedupe(keywords), tools: dedupe(tools) }
      : { keywords: dedupe(keywords) };
  }
}
