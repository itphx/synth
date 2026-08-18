/**
 * SecretPatternStore (AD-036) — редактируемый список regex-паттернов детекции секретов.
 *
 * Схема «системный + override» (по аналогии с ContextConfig):
 * - дефолтный список встроен в код (DEFAULT_PATTERNS из secret-detector.ts);
 * - пользовательский override — JSON-файл {dataDir}/gateway/patterns.json;
 * - если override существует, он ПОЛНОСТЬЮ заменяет дефолтный;
 * - сброс = удаление override-файла → снова дефолт.
 *
 * Формат каждого паттерна: { type: string, regex: string }.
 * regex — строка-source без слешей и флагов; при компиляции в детекторе добавляется флаг 'g'.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { atomicWrite } from '@itphx/synth-shared';

import { info, warning } from '../../logger.js';
import { DEFAULT_PATTERNS } from './secret-detector.js';

/** Сериализуемый паттерн детекции: regex — строка (source), компилируется с флагом 'g'. */
export interface SecretPattern {
  type: string;
  regex: string;
}

export interface SecretPatternStoreOptions {
  dataDir: string;
  /** Кастомный путь к override-файлу (для тестов). По умолчанию: {dataDir}/gateway/patterns.json. */
  patternsFile?: string;
}

export interface SecretPatternsRaw {
  isOverridden: boolean;
  patterns: SecretPattern[];
  defaultPatterns: SecretPattern[];
}

/** Дефолтные паттерны в сериализуемом виде (RegExp.source → строка). */
function _defaultPatternsAsStrings(): SecretPattern[] {
  return DEFAULT_PATTERNS.map((p) => ({
    type: p.type,
    regex: typeof p.regex === 'string' ? p.regex : p.regex.source,
  }));
}

function _isValidPattern(p: unknown): p is SecretPattern {
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

export class SecretPatternStore {
  readonly overridePath: string;
  private readonly _defaultPatterns: SecretPattern[];

  constructor(options: SecretPatternStoreOptions) {
    this.overridePath = options.patternsFile ?? join(options.dataDir, 'gateway', 'patterns.json');
    this._defaultPatterns = _defaultPatternsAsStrings();
  }

  /** Существует ли пользовательский override-файл. */
  hasOverride(): boolean {
    return existsSync(this.overridePath);
  }

  /** Дефолтный список (независимо от наличия override), всегда свежая копия. */
  getDefaultPatterns(): SecretPattern[] {
    return this._defaultPatterns.map((p) => ({ ...p }));
  }

  /**
   * Актуальный список паттернов: override ?? дефолт.
   * Если override-файл повреждён (битый JSON или невалидные элементы) — warning
   * и fallback на дефолт: детекция не должна падать из-за конфигурации.
   */
  getPatterns(): SecretPattern[] {
    if (!this.hasOverride()) return this.getDefaultPatterns();
    try {
      const raw = JSON.parse(readFileSync(this.overridePath, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) {
        warning('GATEWAY', `Невалидный override паттернов (ожидается массив): ${this.overridePath}`);
        return this.getDefaultPatterns();
      }
      const patterns = raw.filter(_isValidPattern).map((p) => ({ type: p.type, regex: p.regex }));
      if (patterns.length !== raw.length) {
        warning('GATEWAY', `Часть элементов override-паттернов пропущена (${raw.length - patterns.length} шт): ${this.overridePath}`);
      }
      return patterns;
    } catch (e) {
      warning('GATEWAY', `Не удалось прочитать паттерны обфускации (${this.overridePath}): ${e}`);
      return this.getDefaultPatterns();
    }
  }

  /** Алиас getPatterns для единообразия вызовов. */
  getEffectivePatterns(): SecretPattern[] {
    return this.getPatterns();
  }

  /**
   * Сохраняет override-файл (атомарная запись через atomicWrite).
   * Пустой массив — валиден: детекция секретов полностью отключается (предупреждаем об этом).
   */
  async savePatterns(patterns: SecretPattern[]): Promise<boolean> {
    if (!Array.isArray(patterns) || !patterns.every(_isValidPattern)) {
      warning('GATEWAY', 'Отказ: невалидные паттерны (ожидается [{type, regex}] с компилируемым regex)');
      return false;
    }
    if (patterns.length === 0) {
      info('GATEWAY', 'Сохранён пустой список паттернов обфускации: детекция секретов отключена');
    }
    try {
      await mkdir(dirname(this.overridePath), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        rename,
        this.overridePath,
        JSON.stringify(patterns, null, 2),
      );
      info('GATEWAY', `Сохранены паттерны обфускации (${patterns.length} шт): ${this.overridePath}`);
      return true;
    } catch (e) {
      warning('GATEWAY', `Не удалось сохранить паттерны обфускации: ${e}`);
      return false;
    }
  }

  /** Удаляет override-файл → снова дефолт. true — файл удалён, false — override не существовал. */
  async reset(): Promise<boolean> {
    if (!this.hasOverride()) return false;
    try {
      await unlink(this.overridePath);
      info('GATEWAY', 'Паттерны обфускации сброшены к дефолтным');
      return true;
    } catch (e) {
      warning('GATEWAY', `Не удалось сбросить паттерны обфускации: ${e}`);
      return false;
    }
  }

  /** Полное состояние: есть ли override, эффективный список и дефолтный. */
  getRawPatterns(): SecretPatternsRaw {
    const isOverridden = this.hasOverride();
    return {
      isOverridden,
      patterns: this.getPatterns(),
      defaultPatterns: this.getDefaultPatterns(),
    };
  }
}
