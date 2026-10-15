import type { StoredDictionary } from '../../engine/router/dictionary-store.js';

/**
 * Порт словарей классификации (ADR-034/ADR-035, реализация — `DictionaryStore`).
 *
 * Системные словари + пользовательские override. Свойства-пути
 * (`systemDir`/`userDir`) намеренно НЕ входят в порт: это деталь файловой
 * реализации; домен работает через методы. @future-backend — словари из БД.
 */
export interface DictionaryRepository {
  getKeywords(category: string, language: string): string[];
  getCategorizedKeywords(category: string, language: string): Record<string, string[]>;
  getCodingTools(): string[];
  isKnownCategory(category: string): boolean;
  isValidLanguage(language: string): boolean;
  getDictionary(category: string, language: string): StoredDictionary | null;
  listDictionaries(): StoredDictionary[];
  saveUserDictionary(
    category: string,
    language: string,
    data: { keywords: string[]; tools?: string[] },
  ): Promise<StoredDictionary | null>;
  deleteUserDictionary(category: string, language: string): Promise<StoredDictionary | null>;
  getContent(category: string, language: string): string;
  saveUserContent(
    category: string,
    language: string,
    content: string,
  ): Promise<StoredDictionary | null>;
}
