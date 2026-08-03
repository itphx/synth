/**
 * DictionaryStore — загрузка словарей классификации (AD-034).
 * Принцип как у ContextConfig: системные файлы + пользовательские переопределения.
 *
 * Системные: packages/core/dictionaries/{category}.{lang}.yaml
 * Пользовательские: $SYNTH_DATA_DIR/dictionaries/{category}.{lang}.yaml
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { warning } from '../../logger.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

interface DictionaryData {
  keywords: string[];
  tools?: string[];
}

export class DictionaryStore {
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
   * Получить категоризированные ключевые слова (расширенный формат AD-035).
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

  // ── private ──

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

  /** Загрузка категоризированного словаря (AD-035). */
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

  /** Парсер для категоризированных словарей (AD-035). */
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
}
