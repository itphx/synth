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
    this.systemDir = systemDir ?? join(CURRENT_DIR, '..', '..', '..', 'dictionaries');
    this.userDir = join(userDataDir, 'dictionaries');
  }

  /**
   * Получить ключевые слова для категории на указанном языке.
   * Приоритет: пользовательский файл → системный → fallback на базовый .yaml.
   */
  getKeywords(category: 'coding' | 'research', language: string): string[] {
    return this._loadDictionary(category, language).keywords;
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
