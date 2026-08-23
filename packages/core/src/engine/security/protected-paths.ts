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
 * Резолв путей: `~`, `$HOME`, `$PWD`, относительные пути — переиспользует
 * `tryResolvePath` из shell-guard (общая логика без дублирования).
 * Пути с динамикой (`$()`, `${}`, glob) считаются не достоверными —
 * не блокируются, но и не разрешаются с уверенностью.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

import { tryResolvePath, resolveSystemDefinitionsDir } from './shell-guard.js';

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
}

/** Результат checkPath. */
export interface ProtectedPathCheckResult {
  action: 'allow' | 'deny' | 'ask';
  reason: string;
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
}

const POLICY_KEYS: Array<keyof ProtectedPathsPolicy> = [
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

/**
 * Загружает политику: системный дефолт definitions/protected-paths.json +
 * override {dataDir}/security/protected-paths.json. Если override существует —
 * применяется каскад add/remove. Некорректные файлы игнорируются; результат
 * кэшируется по ключу «systemDir|overridePath».
 */
export function loadProtectedPaths(options: ProtectedPathsOptions = {}): ProtectedPathsPolicy {
  const systemDir = options.systemDir ?? resolveSystemDefinitionsDir();
  const overridePath = options.overridePath ?? '';
  const key = `${systemDir}|${overridePath}`;

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

  policyCache.set(key, result);
  return result;
}

/** Резолвит запись политики (deniedPath/approvalPath/deniedPrefix) в абсолютный путь. */
function resolvePolicyEntry(entry: string, cwd: string): string {
  const r = tryResolvePath(entry, cwd);
  if (r && r.source === 'literal') return normalize(r.path);
  // Резолв не удался на 100% (динамика в записи политики) — используем сырое значение.
  return normalize(entry);
}

/**
 * Проверяет один путь по политике. Резолвит `~`, `$HOME`, `$PWD`, относительные
 * пути через общий `tryResolvePath`. Приоритет: deniedPaths (точное совпадение)
 * → approvalPaths (ask) → deniedPrefixes (префикс директории).
 */
export function checkPath(path: string, cwd: string, policy: ProtectedPathsPolicy): ProtectedPathCheckResult {
  const resolved = tryResolvePath(path, cwd);
  if (!resolved) {
    return { action: 'allow', reason: 'путь не поддаётся резолву — не блокируем' };
  }
  if (resolved.source !== 'literal') {
    return { action: 'allow', reason: 'путь содержит динамику — не удалось проверить (не блокируем)' };
  }

  const norm = normalize(resolved.path);
  const deniedPaths = policy.deniedPaths.map((p) => resolvePolicyEntry(p, cwd));
  const approvalPaths = policy.approvalPaths.map((p) => resolvePolicyEntry(p, cwd));
  const deniedPrefixes = policy.deniedPrefixes.map((p) => resolvePolicyEntry(p, cwd));

  for (const denied of deniedPaths) {
    if (normalize(denied) === norm) {
      return {
        action: 'deny',
        reason: `Доступ запрещён: путь "${norm}" защищён`,
        matchedRule: 'protected-paths.deny',
      };
    }
  }

  for (const approval of approvalPaths) {
    if (normalize(approval) === norm) {
      return {
        action: 'ask',
        reason: `Путь "${norm}" требует подтверждения по политике защищённых путей`,
        matchedRule: 'protected-paths.ask',
      };
    }
  }

  for (const prefix of deniedPrefixes) {
    const normalizedPrefix = normalize(prefix);
    if (norm === normalizedPrefix || norm.startsWith(normalizedPrefix.endsWith(sep) ? normalizedPrefix : normalizedPrefix + sep)) {
      return {
        action: 'deny',
        reason: `Доступ запрещён: путь "${norm}" в защищённой директории "${normalizedPrefix}"`,
        matchedRule: 'protected-paths.deny',
      };
    }
  }

  return { action: 'allow', reason: 'путь не нарушает политику защищённых путей' };
}

/** Вспомогательный экспорт для ProtectedPathsStore: каталог системных definitions. */
export function packageDirectoryForDefinitions(): string {
  return resolveSystemDefinitionsDir();
}
