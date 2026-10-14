/**
 * ProtectedPaths — единый слой защиты защищённых путей для монорепозитория.
 *
 * Заменяет точечный денлист shell-guard (только execute_shell) на сквозную
 * проверку ВСЕХ тулов, чьи параметры содержат файловые пути (read_file,
 * write_file, edit_file, delete_file, git_* и т.д.) через PermissionEvaluator.
 *
 * Политика: системный дефолт `definitions/protected-paths.json` (публикуется
 * в npm, копируется в `dist/definitions/` при сборке) + пользовательский
 * override `{dataDir}/security/protected-paths.json`, который НЕ заменяет
 * системный полностью, а применяет каскад:
 *   итог = системный base + `add` − `remove`.
 *
 * Резолв путей: `~`, `$HOME`, `$PWD`, `$SYNTH_DATA_DIR` (dataDir инстанса),
 * относительные пути — переиспользует `tryResolvePath` из shell-guard (общая
 * логика без дублирования).
 * Динамические защищённые префиксы: при известном `dataDir` политика закрывает
 * `{dataDir}/secrets` и `{dataDir}/security` (в статическом JSON их нет).
 * Пути с динамикой (`$()`, `${}`, glob), литеральная часть которых указывает на
 * защищённый путь, — deny (fail-closed, общий с shell-guard механизм «маркеров»);
 * прочая динамика не блокируется (значение не раскрывается файловыми тулами).
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';

import { tokenTouchesProtectedMarker, tryResolvePath, resolveSystemDefinitionsDir } from './shell-guard.js';
import { t as sm } from '../system-messages.js';

/** Политика защищённых путей (структурно совпадает с ShellPolicy). */
export interface ProtectedPathsPolicy {
  /** Точные запрещённые пути (резолвятся с `~`). */
  deniedPaths: string[];
  /** Запрещённые префиксы директорий. */
  deniedPrefixes: string[];
  /** Пути, требующие подтверждения (ask). */
  approvalPaths: string[];
  /** Префиксы команд, запрещённые целиком — только для shell-команд. */
  deniedCommandPrefixes: string[];
  /**
   * dataDir инстанса (AD-005), если известен: политика дополняется динамическими
   * защищёнными префиксами `{dataDir}/secrets` и `{dataDir}/security` (их нет в
   * статическом JSON — путь зависит от инстанса). Передаётся и в shell-guard
   * (резолв `$SYNTH_DATA_DIR`, маркеры защищённых путей).
   */
  dataDir?: string;
}

/** Результат checkPath. */
export interface ProtectedPathCheckResult {
  action: 'allow' | 'deny' | 'ask';
  /** Человекочитаемая причина (fallback, без локализации). */
  reason?: string;
  /** Идентификатор локализованного сообщения (deny-protected-path и т.д.). */
  messageId?: string;
  /** Параметры подстановки в сообщение ({{path}}, {{dir}}). */
  params?: Record<string, string>;
  matchedRule?: string;
}

/** Пустая политика — fallback, если файлы не найдены или невалидны. */
export const DEFAULT_POLICY: ProtectedPathsPolicy = {
  deniedPaths: [],
  deniedPrefixes: [],
  approvalPaths: [],
  deniedCommandPrefixes: [],
};

/** Override-файл: каскад add/remove поверх системного base. */
export interface ProtectedPathsOverride {
  version: number;
  add: Partial<ProtectedPathsPolicy>;
  remove: Partial<ProtectedPathsPolicy>;
}

export interface ProtectedPathsOptions {
  /** Каталог системных definitions (по умолчанию резолвится от пакета). */
  systemDir?: string;
  /** Пользовательский override: {dataDir}/security/protected-paths.json. */
  overridePath?: string;
  /**
   * dataDir инстанса (AD-005). Задан — политика дополняется динамическими
   * защищёнными префиксами `{dataDir}/secrets` (мастер-ключ, api-key,
   * ssh-keys) и `{dataDir}/security` (override-файл политики). Не задан —
   * путь выводится из конвенции `overridePath` = `{dataDir}/security/
   * protected-paths.json`; если и это невозможно — динамических префиксов нет
   * (статическая политика).
   */
  dataDir?: string;
}

/** Подкаталоги dataDir, закрытые для тулов (динамические защищённые префиксы). */
const DATA_DIR_PROTECTED_SUBDIRS = ['secrets', 'security'] as const;

/** Списковые ключи политики (без скалярного `dataDir`). */
type PolicyListKey = 'deniedPaths' | 'deniedPrefixes' | 'approvalPaths' | 'deniedCommandPrefixes';

const POLICY_KEYS: PolicyListKey[] = [
  'deniedPaths',
  'deniedPrefixes',
  'approvalPaths',
  'deniedCommandPrefixes',
];

/** Кэш политик по ключу «systemDir|overridePath». */
const policyCache = new Map<string, ProtectedPathsPolicy>();

/** Сброс кэша (для тестов и после save/reset override-файла). */
export function clearProtectedPathsCache(): void {
  policyCache.clear();
}

function readBasePolicy(path: string): ProtectedPathsPolicy | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProtectedPathsPolicy>;
    return {
      deniedPaths: Array.isArray(parsed.deniedPaths) ? parsed.deniedPaths : [],
      deniedPrefixes: Array.isArray(parsed.deniedPrefixes) ? parsed.deniedPrefixes : [],
      approvalPaths: Array.isArray(parsed.approvalPaths) ? parsed.approvalPaths : [],
      deniedCommandPrefixes: Array.isArray(parsed.deniedCommandPrefixes) ? parsed.deniedCommandPrefixes : [],
    };
  } catch {
    return null;
  }
}

function readOverride(path: string): ProtectedPathsOverride | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProtectedPathsOverride>;
    const add = parsed.add ?? {};
    const remove = parsed.remove ?? {};
    const toArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
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
  } catch {
    return null;
  }
}

/** Применяет каскад add/remove к одному списку: base + add − remove. */
function applyCascade(baseArr: string[], addArr: string[], removeArr: string[]): string[] {
  const removed = new Set(removeArr);
  const kept = baseArr.filter((x) => !removed.has(x));
  const addedSet = new Set(kept);
  for (const item of addArr) {
    if (!addedSet.has(item)) kept.push(item);
  }
  return kept;
}

/** Применяет override к политике: итог = base + add − remove. */
function applyOverride(base: ProtectedPathsPolicy, override: ProtectedPathsOverride): ProtectedPathsPolicy {
  const result = { ...DEFAULT_POLICY };
  for (const key of POLICY_KEYS) {
    result[key] = applyCascade(base[key] ?? [], override.add[key] ?? [], override.remove[key] ?? []);
  }
  return result;
}

/** dataDir из опций или из конвенции `{dataDir}/security/protected-paths.json`. */
function resolveDataDirOption(options: ProtectedPathsOptions): string | undefined {
  if (options.dataDir && options.dataDir.trim() !== '') return resolve(options.dataDir);
  const overridePath = options.overridePath;
  if (overridePath && basename(overridePath) === 'protected-paths.json' && basename(dirname(overridePath)) === 'security') {
    return resolve(dirname(dirname(overridePath)));
  }
  return undefined;
}

/**
 * Динамические запрещённые префиксы `{dataDir}/secrets` и `{dataDir}/security`.
 * Добавляются ПОСЛЕ каскада base + add − remove: override не может их снять
 * (fail-safe — пользователь не знает путь инстанса, а снятие = обход защиты).
 */
function dynamicDeniedPrefixes(dataDir: string | undefined): string[] {
  if (!dataDir) return [];
  return DATA_DIR_PROTECTED_SUBDIRS.map((sub) => join(dataDir, sub));
}

/**
 * Загружает политику: системный дефолт definitions/protected-paths.json +
 * override {dataDir}/security/protected-paths.json. Если override существует —
 * применяется каскад add/remove. Некорректные файлы игнорируются; результат
 * кэшируется по ключу «systemDir|overridePath|dataDir».
 *
 * При известном `dataDir` политика всегда дополняется динамическим запретом
 * `{dataDir}/secrets` (мастер-ключ секретов at-rest, api-key, ssh-keys) и
 * `{dataDir}/security` (override-файл политики) — они не перечисляются в JSON.
 */
export function loadProtectedPaths(options: ProtectedPathsOptions = {}): ProtectedPathsPolicy {
  const systemDir = options.systemDir ?? resolveSystemDefinitionsDir();
  const overridePath = options.overridePath ?? '';
  const dataDir = resolveDataDirOption(options);
  const key = `${systemDir}|${overridePath}|${dataDir ?? ''}`;

  const cached = policyCache.get(key);
  if (cached) return cached;

  let base = DEFAULT_POLICY;
  const systemPolicy = readBasePolicy(join(systemDir, 'protected-paths.json'));
  if (systemPolicy) base = systemPolicy;

  let result = base;
  if (overridePath) {
    const override = readOverride(overridePath);
    if (override) result = applyOverride(base, override);
  }

  // Динамические префиксы инстанса: append после каскада (не удаляются override).
  const dynamic = dynamicDeniedPrefixes(dataDir);
  if (dynamic.length > 0) {
    const seen = new Set(result.deniedPrefixes.map((p) => normalize(p)));
    const merged = [...result.deniedPrefixes];
    for (const entry of dynamic) {
      if (!seen.has(normalize(entry))) {
        seen.add(normalize(entry));
        merged.push(entry);
      }
    }
    result = { ...result, deniedPrefixes: merged };
  }

  const policy: ProtectedPathsPolicy = dataDir ? { ...result, dataDir } : result;
  policyCache.set(key, policy);
  return policy;
}

/** Резолвит запись политики (deniedPath/approvalPath/deniedPrefix) в абсолютный путь. */
function resolvePolicyEntry(entry: string, cwd: string): string {
  const r = tryResolvePath(entry, cwd);
  if (r && r.source === 'literal') return normalize(r.path);
  // Резолв не удался на 100% (динамика в записи политики) — используем сырое значение.
  return normalize(entry);
}

/**
 * Проверяет один путь по политике. Резолвит `~`, `$HOME`, `$PWD`,
 * `$SYNTH_DATA_DIR` (при известном `policy.dataDir`), относительные пути через
 * общий `tryResolvePath`. Приоритет: deniedPaths (точное совпадение) →
 * approvalPaths (ask) → deniedPrefixes (префикс директории).
 *
 * Неразрешимая динамика (`$()`, `${}`, glob, неизвестная переменная):
 * fail-closed по «маркерам» защищённых путей — если литеральная часть пути
 * указывает на защищённый путь/префикс (`$X/secrets/master.key`, `~/.ssh/*`) →
 * deny; иначе путь не блокируется (файловые тулы не раскрывают переменные —
 * значение используется как литеральный путь внутри workspace).
 */
export function checkPath(path: string, cwd: string, policy: ProtectedPathsPolicy): ProtectedPathCheckResult {
  const env = policy.dataDir ? { vars: { SYNTH_DATA_DIR: policy.dataDir } } : undefined;
  const resolved = tryResolvePath(path, cwd, env);
  if (!resolved) {
    return { action: 'allow', reason: sm('protectedpaths.unresolvable') };
  }
  if (resolved.source !== 'literal') {
    if (tokenTouchesProtectedMarker(path, policy)) {
      return {
        action: 'deny',
        messageId: 'deny-protected-path',
        params: { path },
        matchedRule: 'protected-paths.deny',
      };
    }
    return { action: 'allow', reason: sm('protectedpaths.dynamic') };
  }

  const norm = normalize(resolved.path);
  const deniedPaths = policy.deniedPaths.map((p) => resolvePolicyEntry(p, cwd));
  const approvalPaths = policy.approvalPaths.map((p) => resolvePolicyEntry(p, cwd));
  const deniedPrefixes = policy.deniedPrefixes.map((p) => resolvePolicyEntry(p, cwd));

  for (const denied of deniedPaths) {
    if (normalize(denied) === norm) {
      return {
        action: 'deny',
        messageId: 'deny-protected-path',
        params: { path: norm },
        matchedRule: 'protected-paths.deny',
      };
    }
  }

  for (const approval of approvalPaths) {
    if (normalize(approval) === norm) {
      return {
        action: 'ask',
        messageId: 'ask-protected-path',
        params: { path: norm },
        matchedRule: 'protected-paths.ask',
      };
    }
  }

  for (const prefix of deniedPrefixes) {
    const normalizedPrefix = normalize(prefix);
    if (norm === normalizedPrefix || norm.startsWith(normalizedPrefix.endsWith(sep) ? normalizedPrefix : normalizedPrefix + sep)) {
      return {
        action: 'deny',
        messageId: 'deny-protected-dir',
        params: { path: norm, dir: normalizedPrefix },
        matchedRule: 'protected-paths.deny',
      };
    }
  }

  return { action: 'allow', reason: sm('protectedpaths.allow_default') };
}

/** Вспомогательный экспорт для ProtectedPathsStore: каталог системных definitions. */
export function packageDirectoryForDefinitions(): string {
  return resolveSystemDefinitionsDir();
}
