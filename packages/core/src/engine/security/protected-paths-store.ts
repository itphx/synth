/**
 * ProtectedPathsStore — редактируемый список защищённых путей.
 *
 * Схема «системный + override» (по аналогии с ContextConfig / SecretPatternStore):
 * - системный дефолт — definitions/protected-paths.json;
 * - пользовательский override — JSON-файл {dataDir}/security/protected-paths.json;
 * - итоговая политика = системный base + `add` − `remove` (каскад, см. protected-paths.ts);
 * - сброс = удаление override-файла → снова системный дефолт.
 *
 * Формат override-файла:
 *   { version: 1, add: { deniedPaths, deniedPrefixes, approvalPaths, deniedCommandPrefixes },
 *                    remove: { deniedPaths, deniedPrefixes, approvalPaths, deniedCommandPrefixes } }
 *
 * Миграция (однократно): если существует legacy {dataDir}/context/shell-policy.json и отсутствует
 * override — его содержимое (полная политика) преобразуется в каскад add/remove и записывается
 * в override-файл; legacy помечается полем "migrated": true.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { writeFile, rename as renameAsync, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { atomicWrite } from '@itphx/synth-shared';

import { info, warning } from '../../logger.js';
import {
  DEFAULT_POLICY,
  loadProtectedPaths,
  clearProtectedPathsCache,
  packageDirectoryForDefinitions,
} from './protected-paths.js';
import type { ProtectedPathsPolicy, ProtectedPathsOverride } from './protected-paths.js';

export interface ProtectedPathsStoreOptions {
  dataDir: string;
  /** Каталог системных definitions (по умолчанию резолвится от пакета). */
  systemDir?: string;
  /** Кастомный путь к override-файлу (для тестов). По умолчанию: {dataDir}/security/protected-paths.json. */
  overrideFile?: string;
}

export interface ProtectedPathsRaw {
  isOverridden: boolean;
  /** Эффективная политика (base + add − remove, или base без override). */
  policy: ProtectedPathsPolicy;
  /** Системный base (definitions/protected-paths.json). */
  base: ProtectedPathsPolicy;
  /** Системный base (алиас base для единообразия с SecretPatternStore). */
  defaultBase: ProtectedPathsPolicy;
}

/** Списковые ключи политики (без скалярного `dataDir`). */
type PolicyListKey = 'deniedPaths' | 'deniedPrefixes' | 'approvalPaths' | 'deniedCommandPrefixes';

const POLICY_KEYS: PolicyListKey[] = [
  'deniedPaths',
  'deniedPrefixes',
  'approvalPaths',
  'deniedCommandPrefixes',
];

function _isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export class ProtectedPathsStore {
  readonly overridePath: string;
  private readonly _systemDir: string;
  private readonly _legacyPath: string;
  private readonly _dataDir: string;

  constructor(options: ProtectedPathsStoreOptions) {
    this._dataDir = options.dataDir;
    this.overridePath = options.overrideFile ?? join(options.dataDir, 'security', 'protected-paths.json');
    this._systemDir = options.systemDir ?? packageDirectoryForDefinitions();
    this._legacyPath = join(options.dataDir, 'context', 'shell-policy.json');
    // Миграция legacy shell-policy → override (однократно).
    this._migrateLegacy();
  }

  /** Существует ли пользовательский override-файл. */
  hasOverride(): boolean {
    return existsSync(this.overridePath);
  }

  /** Системный base (definitions/protected-paths.json), всегда свежая копия. */
  getBase(): ProtectedPathsPolicy {
    try {
      const raw = JSON.parse(readFileSync(join(this._systemDir, 'protected-paths.json'), 'utf-8')) as Partial<ProtectedPathsPolicy>;
      return {
        deniedPaths: _isStringArray(raw.deniedPaths) ? raw.deniedPaths : [],
        deniedPrefixes: _isStringArray(raw.deniedPrefixes) ? raw.deniedPrefixes : [],
        approvalPaths: _isStringArray(raw.approvalPaths) ? raw.approvalPaths : [],
        deniedCommandPrefixes: _isStringArray(raw.deniedCommandPrefixes) ? raw.deniedCommandPrefixes : [],
      };
    } catch {
      return { ...DEFAULT_POLICY, deniedPaths: [], deniedPrefixes: [], approvalPaths: [], deniedCommandPrefixes: [] };
    }
  }

  /**
   * Эффективная политика: base + add − remove + динамические префиксы
   * `{dataDir}/secrets` и `{dataDir}/security` (см. loadProtectedPaths).
   */
  getPolicy(): ProtectedPathsPolicy {
    return loadProtectedPaths({
      systemDir: this._systemDir,
      overridePath: this.overridePath,
      dataDir: this._dataDir,
    });
  }

  /** Алиас getPolicy для единообразия. */
  getEffective(): ProtectedPathsPolicy {
    return this.getPolicy();
  }

  /**
   * Полное состояние: признак override + эффективная и системная политики.
   * Служебное поле `dataDir` клиенту (API/UI) не отдаётся — динамические
   * префиксы `{dataDir}/secrets` и `{dataDir}/security` при этом видны в списках.
   */
  getRaw(): ProtectedPathsRaw {
    const base = this.getBase();
    const isOverridden = this.hasOverride();
    const policy: ProtectedPathsPolicy = { ...this.getPolicy() };
    delete policy.dataDir;
    return {
      isOverridden,
      policy,
      base,
      defaultBase: base,
    };
  }

  /** Читает сырой override-файл (add/remove). */
  getOverride(): ProtectedPathsOverride | null {
    if (!this.hasOverride()) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.overridePath, 'utf-8')) as Partial<ProtectedPathsOverride>;
      const add = parsed.add ?? {};
      const remove = parsed.remove ?? {};
      const toArr = (v: unknown): string[] => (_isStringArray(v) ? v : []);
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        add: {
          deniedPaths: toArr(add.deniedPaths),
          deniedPrefixes: toArr(add.deniedPrefixes),
          approvalPaths: toArr(add.approvalPaths),
          deniedCommandPrefixes: toArr(add.deniedCommandPrefixes),
        },
        remove: {
          deniedPaths: toArr(remove.deniedPaths),
          deniedPrefixes: toArr(remove.deniedPrefixes),
          approvalPaths: toArr(remove.approvalPaths),
          deniedCommandPrefixes: toArr(remove.deniedCommandPrefixes),
        },
      };
    } catch (e) {
      warning('SECURITY', `Не удалось прочитать protected-paths override (${this.overridePath}): ${e}`);
      return null;
    }
  }

  /**
   * Сохраняет эффективную политику (списки целиком). Относительно системного base
   * вычисляется каскад: add = effective − base, remove = base − effective. Это
   * приводит итоговую политику ровно к переданной effective. Атомарная запись.
   */
  async savePolicy(effective: ProtectedPathsPolicy): Promise<boolean> {
    if (!POLICY_KEYS.every((k) => _isStringArray(effective[k] ?? []))) {
      warning('SECURITY', 'Отказ: невалидная политика защищённых путей (ожидаются строковые массивы)');
      return false;
    }
    const base = this.getBase();
    const override: ProtectedPathsOverride = { version: 1, add: {}, remove: {} };
    for (const key of POLICY_KEYS) {
      const baseArr = base[key] ?? [];
      const effArr = effective[key] ?? [];
      const effSet = new Set(effArr);
      const baseSet = new Set(baseArr);
      // add — то, что есть в effective, но нет в base
      override.add[key] = effArr.filter((x) => !baseSet.has(x));
      // remove — то, что есть в base, но нет в effective
      override.remove[key] = baseArr.filter((x) => !effSet.has(x));
    }
    try {
      await mkdir(dirname(this.overridePath), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => renameAsync(o, n),
        this.overridePath,
        JSON.stringify(override, null, 2),
      );
      clearProtectedPathsCache();
      info('SECURITY', `Сохранена политика защищённых путей: ${this.overridePath}`);
      return true;
    } catch (e) {
      warning('SECURITY', `Не удалось сохранить политику защищённых путей: ${e}`);
      return false;
    }
  }

  /**
   * Сохраняет сырой override (формат add/remove, version: 1) — без пересчёта.
   * Используется при передаче add/remove напрямую (например из UI/API).
   * Приводит к каноничному виду (все 4 ключа в add/remove), атомарная запись.
   */
  async saveRawOverride(raw: Partial<ProtectedPathsOverride>): Promise<boolean> {
    const toArr = (v: unknown): string[] => (_isStringArray(v) ? v : []);
    const add = raw.add ?? {};
    const remove = raw.remove ?? {};
    const override: ProtectedPathsOverride = {
      version: typeof raw.version === 'number' ? raw.version : 1,
      add: {
        deniedPaths: toArr(add.deniedPaths),
        deniedPrefixes: toArr(add.deniedPrefixes),
        approvalPaths: toArr(add.approvalPaths),
        deniedCommandPrefixes: toArr(add.deniedCommandPrefixes),
      },
      remove: {
        deniedPaths: toArr(remove.deniedPaths),
        deniedPrefixes: toArr(remove.deniedPrefixes),
        approvalPaths: toArr(remove.approvalPaths),
        deniedCommandPrefixes: toArr(remove.deniedCommandPrefixes),
      },
    };
    try {
      await mkdir(dirname(this.overridePath), { recursive: true });
      await atomicWrite(
        (p, d) => writeFile(p, d, 'utf-8'),
        (o, n) => renameAsync(o, n),
        this.overridePath,
        JSON.stringify(override, null, 2),
      );
      clearProtectedPathsCache();
      info('SECURITY', `Сохранён override защищённых путей (add/remove): ${this.overridePath}`);
      return true;
    } catch (e) {
      warning('SECURITY', `Не удалось сохранить override защищённых путей: ${e}`);
      return false;
    }
  }

  /** Удаляет override-файл → снова системный дефолт. true — файл удалён. */
  async reset(): Promise<boolean> {
    if (!this.hasOverride()) return false;
    try {
      unlinkSync(this.overridePath);
      clearProtectedPathsCache();
      info('SECURITY', 'Политика защищённых путей сброшена к системной');
      return true;
    } catch (e) {
      warning('SECURITY', `Не удалось сбросить политику защищённых путей: ${e}`);
      return false;
    }
  }

  /**
   * Однократная миграция legacy {dataDir}/context/shell-policy.json (полная
   * замена) → override add/remove. Выполняется в конструкторе при первом
   * запуске. Старый файл помечается "migrated": true.
   */
  private _migrateLegacy(): void {
    try {
      if (!existsSync(this._legacyPath) || existsSync(this.overridePath)) return;
      const legacy = JSON.parse(readFileSync(this._legacyPath, 'utf-8')) as Partial<ProtectedPathsPolicy>;
      if (!legacy || typeof legacy !== 'object') return;
      const legacyPolicy: ProtectedPathsPolicy = {
        deniedPaths: _isStringArray(legacy.deniedPaths) ? legacy.deniedPaths : [],
        deniedPrefixes: _isStringArray(legacy.deniedPrefixes) ? legacy.deniedPrefixes : [],
        approvalPaths: _isStringArray(legacy.approvalPaths) ? legacy.approvalPaths : [],
        deniedCommandPrefixes: _isStringArray(legacy.deniedCommandPrefixes) ? legacy.deniedCommandPrefixes : [],
      };

      const base = this.getBase();
      const override: ProtectedPathsOverride = { version: 1, add: {}, remove: {} };
      for (const key of POLICY_KEYS) {
        const baseArr = base[key] ?? [];
        const effArr = legacyPolicy[key] ?? [];
        const effSet = new Set(effArr);
        const baseSet = new Set(baseArr);
        override.add[key] = effArr.filter((x) => !baseSet.has(x));
        override.remove[key] = baseArr.filter((x) => !effSet.has(x));
      }

      mkdirSync(dirname(this.overridePath), { recursive: true });
      const tmp = `${this.overridePath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(override, null, 2), 'utf-8');
      renameSync(tmp, this.overridePath);

      // Помечаем legacy как устаревший (migrated: true).
      writeFileSync(this._legacyPath, JSON.stringify({ ...legacy, migrated: true }, null, 2), 'utf-8');
      clearProtectedPathsCache();
      info('SECURITY', 'Мигрирована legacy shell-policy.json → protected-paths.json');
    } catch (e) {
      warning('SECURITY', `Не удалось выполнить миграцию shell-policy.json: ${e}`);
    }
  }
}
