import type { SecretPattern, SecretPatternsRaw } from '../../engine/gateway/secret-pattern-store.js';

/**
 * Порт редактируемого списка regex-паттернов детекции секретов
 * (ADR-036, реализация — `SecretPatternStore`).
 *
 * Схема «системный дефолт + пользовательский override»: `getPatterns` возвращает
 * override поверх дефолта, `reset` — сброс к дефолту. Методы синхронные: детекция
 * работает на горячем пути и не должна ждать I/O. @future-backend — синхронность
 * сохраняется за счёт кэша над БД.
 */
export interface SecretPatternRepository {
  hasOverride(): boolean;
  getDefaultPatterns(): SecretPattern[];
  getPatterns(): SecretPattern[];
  getEffectivePatterns(): SecretPattern[];
  savePatterns(patterns: SecretPattern[]): Promise<boolean>;
  reset(): Promise<boolean>;
  getRawPatterns(): SecretPatternsRaw;
}
