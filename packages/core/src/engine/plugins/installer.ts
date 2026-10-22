/**
 * PROP-090 §5/§9/§10, фаза Ф5а: `PluginInstaller` — сервис установки,
 * подтверждения и снятия плагина.
 *
 * Это **ядро** контура установки: HTTP API (`/api/v2/plugins*`), CLI
 * (`synth plugin *`), runtime-override (`plugins.json`) и старт-активация из
 * `plugins.lock.json` — остаток Ф5б/Ф5в. Здесь только операции над каталогом
 * бандла и портами слоя хранения:
 *
 * ```text
 * installFromDirectory → манифест → файлы → fail-closed(scan+execution) →
 *   trust-floor → скан → runtime-install → install-policy →
 *   allow: installed/<name>@<version>/ + lock.save + аудит install
 *   ask:   quarantine/<name>@<version>/ (lock НЕ пишется) + approval_required
 *   block: отказ plugin.scan_rejected (на диск не пишется)
 * approve  → скан карантина → releaseFromQuarantine → lock.save → аудит install
 * update   → источник из lock → сверка content_hash → installFromDirectory
 *            (keepPrevious) → деактивация старого модуля → активация нового
 * rollback → каталог previous → swap в lock → аудит rollback → активация
 * uninstall→ деактивация (если активен) → lock.delete → rm -rf каталога → аудит
 * ```
 *
 * **Порядок проверок важен** и повторяет `PluginHost` (Ф2/Ф3а): сначала
 * fail-closed «скан выключен, а исполнение включено», затем **trust-floor**,
 * затем скан и только потом install-policy. Плагин ниже `plugins.trustFloor`
 * не устанавливается ни при каком вердикте сканера; решение «можно ли ставить
 * по вердикту» принимает матрица `installPolicyDecision` (ячейка
 * `kind: 'plugin'`: `safe → allow`, `caution → ask`, `dangerous → block`).
 *
 * **Состав бандла и content-hash.** Файлы каталога читаются рекурсивно
 * (сортировка по имени — детерминизм), симлинки и `node_modules`/`.git`
 * пропускаются (как в сканере), `PLUGIN_INTEGRITY.json` исключается (это
 * служебный файл раскладки, а не часть бандла). Текстовые файлы
 * (включая `synth.pack`) входят в `files` и в content-hash; бинарные файлы в
 * `files` **не попадают** (их содержимое нельзя представить строкой без
 * порчи), но:
 * - **копируются байт-в-байт** при раскладке (Ф5б-3, `stagePluginBundle`:
 *   `binaryFiles` + `sourceDir`) — иначе установленный бандл терял бы ассеты;
 * - сканер видит их в каталоге: исполняемый бинарник → `high` → `dangerous` →
 *   отказ.
 * Поэтому content-hash **по-прежнему считается только по текстовым файлам** и
 * совпадает с хешем `scanPluginDirectory` — сверка целостности при активации
 * работает. Бинарники в хеш осознанно не входят: их целостность проверяет
 * скан каталога, а не хеш (иначе хеш и скан разошлись бы по составу файлов).
 *
 * **Точка входа (`entry`).** `dist/index.js`, если он есть в составе бандла;
 * иначе первый по алфавиту `.js`/`.mjs` внутри `dist/`; иначе
 * `dist/index.js` (значение по умолчанию загрузчика — отказ `import` будет
 * явным, а не «молча ничего не загрузили»).
 *
 * **Идемпотентность.** Lock-запись — upsert по имени плагина
 * (`PluginLockRepository`): повторная установка той же версии не плодит
 * записей, каталог перезаписывается, `installed_at` сохраняется, `updated_at`
 * обновляется. Установка **другой** версии заменяет lock-запись (по имени) и
 * удаляет каталог предыдущей версии — **только после** успешной раскладки и
 * записи lock; если плагин активен (модуль загружен в процесс), каталог
 * остаётся с предупреждением в лог (уборка — при следующей установке после
 * деактивации/рестарта: удалять код работающего плагина нельзя).
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  generateId,
  installPolicyDecision,
  packManifestSchema,
  trustLevelRank,
  validatePackManifest,
} from '@itphx/synth-shared';
import type {
  CatalogTrustLevel,
  PackManifest,
  PackPluginMode,
  PluginAuditAction,
  PluginAuditEntry,
  PluginAuditReason,
  PluginLockEntry,
  PluginLockPrevious,
  PluginScanVerdict,
  PluginsConfig,
} from '@itphx/synth-shared';

import type { PluginAuditRepository } from '../../storage/ports/plugin-audit-repository.js';
import type { PluginLockRepository } from '../../storage/ports/plugin-lock-repository.js';
import type {
  PluginActivationDescriptor,
  PluginActivationResult,
  PluginLogger,
  PluginScanHook,
  PluginScanResult,
} from './activation.js';
import { DEFAULT_PLUGIN_ENTRY } from './inline-loader.js';
import { computePluginContentHash } from './integrity.js';
import type { PluginIntegrityFile, PluginLayout } from './layout.js';
import {
  pluginInstalledDir,
  pluginQuarantineDir,
  releaseFromQuarantine,
  stagePluginBundle,
} from './layout.js';
import type { PluginHost } from './plugin-host.js';
import { createPluginScanHook } from './scan/hook.js';
import { isBinaryContent } from './scan/scanner.js';
import type { PluginSourceContext, PluginSourceRequest, ResolvedPluginSource } from './sources.js';
import { resolvePluginSource } from './sources.js';

/** Имя файла манифеста (`synth.pack`, ADR-086 §5). */
const MANIFEST_FILE = 'synth.pack';

/** Служебный файл раскладки — не часть бандла (не входит в хеш и в `files`). */
const INTEGRITY_FILE = 'PLUGIN_INTEGRITY.json';

/**
 * Серверная точка входа `out-of-process` (Ф4б-2): её наличие обязательно для
 * `mode: 'remote'` и записывается в lock (`remote_entry`).
 */
const REMOTE_ENTRY_FILE = 'dist/server.js';

/** Каталоги, которые не являются частью бандла (как в сканере, PROP-068 §4.3). */
const SKIPPED_DIRS: readonly string[] = ['node_modules', '.git'];

/** Расширение локального архива (`local`-источник в lock) — вид `archive` при update. */
const ARCHIVE_EXTENSION_REGEX = /\.(tgz|tar\.gz)$/i;

/** Зависимости сервиса установки (ADR-096: хранилище — только через порты). */
export interface PluginInstallerDeps {
  /** Раскладка слоя плагинов (`<home>/plugin` или `{dataDir}/plugin`). */
  layout: PluginLayout;
  /** Порт lock-файла плагинов (`plugins.lock.json`) — источник истины. */
  lock: PluginLockRepository;
  /** Порт журнала аудита плагинов. */
  audit: PluginAuditRepository;
  /** Эффективная конфигурация слоя плагинов (runtime > config > defaults). */
  config: PluginsConfig;
  /** Скан: не задан — встроенный (`createPluginScanHook`). */
  scan?: PluginScanHook;
  /** Хост плагинов — нужен для деактивации при `uninstall` и активации после установки. */
  host?: PluginHost;
  /** Логгер (по умолчанию — `console.warn`). */
  logger?: PluginLogger;
  /** Инъекция часов — для детерминированных тестов (ISO-8601). */
  now?: () => string;
}

/** Запрос установки из локального каталога (распаковка/скачивание — Ф5б). */
export interface PluginInstallRequest {
  /** Каталог распакованного бандла (`synth.pack` + `dist/index.js`). */
  dir: string;
  /** Фактический уровень доверия (резолвится источником, не манифестом). */
  trustLevel: CatalogTrustLevel;
  /** Источник установки (`local`/`npm`/`catalog`/`builtin`/…). */
  source: string;
  /** Идентификатор источника (`owner/repo`, npm-пакет, URL). */
  identifier?: string;
  /** Pin источника (sha/тег) — обязателен для воспроизводимого update. */
  ref?: string;
  /** `deploy` (бандл в образе) | `runtime` (по умолчанию). */
  installKind?: 'deploy' | 'runtime';
  /** Активировать после установки (по умолчанию `false`). */
  activate?: boolean;
  /**
   * Сохранить каталог предыдущей версии (долги Д2, `update`).
   *
   * `false` (по умолчанию) — прежнее поведение: после успешной установки
   * каталог прежней версии удаляется (`_cleanupPreviousVersion`), а в lock
   * ступень отката не пишется. `true` — каталог остаётся, а в lock
   * записывается `previous` (снимок текущей записи) — иначе `rollback` было
   * бы некуда возвращаться.
   */
  keepPrevious?: boolean;
  /** Инициатор операции (`userId` API/UI, `'cli'`, `'startup'`). */
  actor?: string;
}

/**
 * Запрос установки из **источника** (PROP-090 §«Источники установки», долги Д1):
 * локальный каталог, локальный `.tar.gz`/`.tgz`, npm-пакет или https-URL.
 *
 * Источник резолвится до каталога бандла (`resolvePluginSource`), дальше работает
 * обычный `installFromDirectory` — политика доверия, скан, install-policy и
 * раскладка не дублируются. Поэтому здесь нет полей `dir`/`source`/`identifier`/
 * `ref` установщика: они — **результат** резолвинга (что именно скачалось и с
 * какой контрольной суммой), а не ввод клиента.
 */
export interface PluginInstallFromSourceRequest extends PluginSourceRequest {
  /** Фактический уровень доверия (резолвится источником/оператором, не манифестом). */
  trustLevel: CatalogTrustLevel;
  /** `deploy` (бандл в образе) | `runtime` (по умолчанию). */
  installKind?: 'deploy' | 'runtime';
  /** Активировать после установки (по умолчанию `false`). */
  activate?: boolean;
  /** Инициатор операции (`userId` API/UI, `'cli'`, `'startup'`). */
  actor?: string;
  /** Инъекция сети/лимитов источника (тесты, CLI); по умолчанию — `egressFetch`. */
  sourceContext?: PluginSourceContext;
}

/** Итог установки/подтверждения. */
export type PluginInstallOutcome =
  | {
      outcome: 'installed';
      name: string;
      version: string;
      /** Каталог установленного бандла (`installed/<name>@<version>`). */
      dir: string;
      contentHash: string;
      /**
       * Результат активации — только если она запрашивалась **и** хост передан.
       * Отказ активации (`activated.outcome === 'rejected'`) установку не
       * отменяет: установка и активация — разные статусы (плагин остаётся
       * установленным, но неактивным, причина — в результате и аудите).
       */
      activated?: PluginActivationResult;
    }
  | {
      outcome: 'approval_required';
      name: string;
      version: string;
      /** Каталог карантина (`quarantine/<name>@<version>`). */
      dir: string;
      reason: string;
    }
  | {
      outcome: 'rejected';
      name?: string;
      version?: string;
      reason: PluginAuditReason;
      message: string;
    };

/** Итог снятия установки. */
export interface PluginUninstallResult {
  /** Запись lock была (и снята)? Повторный `uninstall` — `false` (идемпотентно). */
  removed: boolean;
  /** Плагин был активен и деактивирован? */
  deactivated?: boolean;
}

/** Параметры обновления (`PluginInstaller.update`, PROP-090 §«Запись lock»). */
export interface PluginUpdateOptions {
  /**
   * `npm`: точная версия или `latest` (по умолчанию `latest`); `local`/`url` —
   * не используется (источник берётся из lock).
   */
  version?: string;
  /**
   * `url`: **обязательный** новый pin — sha256 архива (64 hex). Для остальных
   * источников не нужен: npm проверяется SRI реестра, локальный архив — хешем
   * байтов.
   */
  sha256?: string;
  /**
   * Активация после обновления. Не задано — сохранить текущее состояние
   * (был активен → активировать новую версию); `true` — активировать в любом
   * случае; `false` — не активировать.
   */
  activate?: boolean;
  /**
   * Вид установки: `runtime` (по умолчанию, политика `plugins.runtimeInstall`)
   * или `deploy` (CLI — офлайн-операция оператора, как у `install`).
   */
  installKind?: 'deploy' | 'runtime';
  /** Инициатор операции (`userId` API/UI, `'cli'`). */
  actor?: string;
  /** Инъекция сети/лимитов источника (тесты, CLI); по умолчанию — `egressFetch`. */
  sourceContext?: PluginSourceContext;
}

/**
 * Итог обновления.
 *
 * `unchanged` — бандл источника совпал с установленным по `content_hash`
 * (ничего не пишется, каталог/ступень отката не трогаются). `updated` —
 * установлена новая версия; `previous` в lock указывает на прежнюю, её каталог
 * сохранён. `rejected` — отказ (источник/гейты/скан): состояние не изменилось.
 */
export type PluginUpdateOutcome =
  | { outcome: 'unchanged'; name: string; version: string; contentHash: string }
  | {
      outcome: 'updated';
      name: string;
      version: string;
      /** Версия, с которой ушли (та, что стала `previous` в lock). */
      previousVersion: string;
      /** Каталог установленной версии (`installed/<name>@<version>`). */
      dir: string;
      contentHash: string;
      /** Результат активации — если она запрашивалась/сохранялась и хост передан. */
      activated?: PluginActivationResult;
    }
  | { outcome: 'rejected'; name: string; reason: PluginAuditReason; message: string };

/**
 * Итог отката (`PluginInstaller.rollback`).
 *
 * `rolled_back` — версия и content-hash взяты из `previous`, прежняя текущая
 * версия стала `previous` (swap — откат обратим). `rejected` — откат
 * невозможен (`plugin.not_found`/`plugin.rollback_unavailable`), состояние не
 * изменилось.
 */
export type PluginRollbackOutcome =
  | {
      outcome: 'rolled_back';
      name: string;
      /** Версия, на которую откатились (из `previous`). */
      version: string;
      /** Версия, с которой откатились (стала `previous`). */
      previousVersion: string;
      /** Результат активации откатанной версии (если плагин был активен). */
      activated?: PluginActivationResult;
    }
  | { outcome: 'rejected'; name: string; reason: PluginAuditReason; message: string };

/**
 * Собранный бандл: текстовые файлы (в хеше и на диске) + пропущенные бинарные.
 *
 * Экспортируется вместе с {@link collectBundleFiles}: тем же обходом
 * пользуется `PluginRuntime` при старт-активации (шаг `integrity` сверяет
 * `content_hash` из lock с фактическим содержимым каталога — состав файлов
 * обязан считаться **одинаково**, иначе хеши разойдутся).
 */
export interface CollectedBundle {
  files: Record<string, string>;
  /**
   * Бинарные файлы (в `files` не попадают: содержимое нельзя представить
   * строкой). При установке копируются байт-в-байт (`stagePluginBundle`),
   * в content-hash не входят — там только текстовые (как у сканера).
   */
  binaryFiles: string[];}

/** Чтение манифеста: успех с разобранным манифестом либо причина отказа. */
export type PluginManifestReadResult =
  | { ok: true; manifest: PackManifest }
  | { ok: false; message: string; name?: string; version?: string };

/** Найденный карантин. */
type QuarantineLookup =
  | { kind: 'found'; version: string; dir: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; versions: string[] };

/** Вход записи аудита (внутренний — поля собираются из операции). */
interface AuditInput {
  action: PluginAuditAction;
  plugin: string;
  version: string;
  outcome: 'ok' | 'rejected';
  actor: string;
  reason?: PluginAuditReason;
  trustLevel?: CatalogTrustLevel;
  scanVerdict?: PluginScanVerdict;
  scanPerformed?: boolean;
  scanFindings?: number;
  contentHash?: string;
  source?: string;
  mode?: PackManifest['mode'];
}

/** Результат скана на шаге установки. */
type ScanStepResult =
  | { ok: true; verdict: PluginScanVerdict; performed: boolean; findings: number; note?: string }
  | { ok: false; reason: PluginAuditReason; message: string };

/** Успешный скан с вердиктом/находками (для записи аудита `install`). */
interface ScanSummary {
  verdict: PluginScanVerdict;
  performed: boolean;
  findings: number;
}

/** Есть ли путь (файл/каталог) — без исключений. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Объект ли значение (для чтения «сырого» манифеста до валидации). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Снимок записи lock как ступени отката (`PluginLockPrevious`).
 *
 * Хранится ровно то, что нужно для возврата: версия, content-hash, точка входа
 * и время установки. Источник/pin/доверие — свойства плагина, а не версии,
 * поэтому остаются в основной записи.
 */
function previousOf(entry: PluginLockEntry): PluginLockPrevious {
  return {
    version: entry.version,
    content_hash: entry.content_hash,
    ...(entry.entry ? { entry: entry.entry } : {}),
    installed_at: entry.installed_at,
  };
}

/** Человекочитаемая сводка проблем zod-валидации. */
function describeIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * Рекурсивный сбор файлов бандла.
 *
 * Обход детерминированный (сортировка по имени), симлинки не читаются,
 * `node_modules`/`.git` пропускаются, `PLUGIN_INTEGRITY.json` исключается.
 * Бинарные файлы (по расширению или NUL-признаку — та же функция, что у
 * сканера) в `files` не попадают.
 *
 * Экспортируется для `PluginRuntime` (старт-активация): гейт целостности
 * сверяет `content_hash` из lock с этим же составом файлов.
 */
export async function collectBundleFiles(rootDir: string): Promise<CollectedBundle> {
  const files: Record<string, string> = {};
  const binaryFiles: string[] = [];

  const walk = async (dir: string, rel: string): Promise<void> => {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (SKIPPED_DIRS.includes(item.name)) continue;
        await walk(join(dir, item.name), relPath);
        continue;
      }
      // Симлинки не читаем: выход за пределы бандла (как в сканере).
      if (!item.isFile() || item.isSymbolicLink()) continue;
      if (relPath === INTEGRITY_FILE) continue;
      const buffer = await readFile(join(dir, item.name));
      if (isBinaryContent(buffer, relPath)) {
        binaryFiles.push(relPath);
        continue;
      }
      files[relPath] = buffer.toString('utf8');
    }
  };

  await walk(rootDir, '');
  return { files, binaryFiles };
}

/**
 * Точка входа бандла: `dist/index.js` → первый `.js`/`.mjs` в `dist/` →
 * `dist/index.js` (дефолт загрузчика, чтобы отказ `import` был явным).
 */
export function resolvePluginEntry(files: Record<string, string>): string {
  const preferred = DEFAULT_PLUGIN_ENTRY;
  if (preferred in files) return preferred;
  const candidates = Object.keys(files)
    .filter((path) => path.startsWith('dist/') && /\.(js|mjs)$/.test(path))
    .sort();
  return candidates[0] ?? preferred;
}

/**
 * Прочитать и проверить `synth.pack` (fail-closed: любая проблема — отказ).
 *
 * Экспортируется для CLI (`synth plugin scan`): dry-run обязан проверять
 * манифест **тем же** кодом, что установка, иначе «разрешено сканом» и
 * «разрешено установкой» разошлись бы.
 */
export async function readPluginManifest(dir: string): Promise<PluginManifestReadResult> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch {
    return { ok: false, message: `В каталоге бандла нет манифеста «${MANIFEST_FILE}».` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: `Манифест «${MANIFEST_FILE}» — не JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const name =
    isRecord(raw) && typeof raw.name === 'string' ? raw.name : undefined;
  const version =
    isRecord(raw) && typeof raw.version === 'string' ? raw.version : undefined;

  const problems = validatePackManifest(raw);
  if (problems.length > 0) {
    return {
      ok: false,
      message: `Манифест не прошёл проверку целостности: ${problems.join('; ')}`,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
    };
  }

  const parsed = packManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: `Манифест не соответствует схеме: ${describeIssues(parsed.error)}`,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
    };
  }
  const manifest = parsed.data;
  if (manifest.kind !== 'plugin') {
    return {
      ok: false,
      message:
        `Манифест «${manifest.name}» имеет kind «${manifest.kind}» — ` +
        'установке подлежит только kind: \'plugin\'.',
      name: manifest.name,
      version: manifest.version,
    };
  }
  return { ok: true, manifest };
}

/**
 * Режим исполнения и серверная точка входа для lock-записи (Ф4б-2).
 *
 * `mode` — эффективный режим манифеста (`inline`, если не задан). Для
 * `remote`/`both` пишется `remote_entry`, только если файл `dist/server.js`
 * реально есть в бандле; для `remote` его отсутствие — отказ установки
 * (`plugin.remote_entry_missing`, проверяет вызывающий).
 */
async function resolveExecutionMode(
  rootDir: string,
  manifest: PackManifest,
): Promise<{ mode: PackPluginMode; remoteEntry?: string }> {
  const mode = manifest.mode ?? 'inline';
  if (mode !== 'remote' && mode !== 'both') return { mode };
  if (!(await pathExists(join(rootDir, REMOTE_ENTRY_FILE)))) return { mode };
  return { mode, remoteEntry: REMOTE_ENTRY_FILE };
}

/** Прочитать `PLUGIN_INTEGRITY.json` карантина (`null` — нет/битый). */async function readIntegrityFile(dir: string): Promise<PluginIntegrityFile | null> {
  try {
    const text = await readFile(join(dir, INTEGRITY_FILE), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || typeof parsed.sha256 !== 'string') return null;
    return parsed as unknown as PluginIntegrityFile;
  } catch {
    return null;
  }
}

/**
 * Сервис установки/подтверждения/снятия плагина (Ф5а).
 *
 * Все проверки — **fail-closed**: непрочитанный манифест, сбой сканера,
 * несовпадение хеша карантина и отсутствие данных доверия ведут к отказу, а не
 * к «пропустить проверку». На диск (lock/installed/quarantine) ничего не
 * пишется до прохождения всех гейтов.
 */
export class PluginInstaller {
  private readonly _layout: PluginLayout;
  private readonly _lock: PluginLockRepository;
  private readonly _audit: PluginAuditRepository;
  private readonly _config: PluginsConfig;
  private readonly _host: PluginHost | undefined;
  private readonly _scan: PluginScanHook | undefined;
  /** Встроенный сканер (Ф2) — используется, когда явный хук не задан. */
  private readonly _builtinScan: PluginScanHook;
  private readonly _logger: PluginLogger;
  private readonly _now: () => string;

  constructor(deps: PluginInstallerDeps) {
    this._layout = deps.layout;
    this._lock = deps.lock;
    this._audit = deps.audit;
    this._config = deps.config;
    this._host = deps.host;
    this._scan = deps.scan;
    this._builtinScan = createPluginScanHook();
    this._logger = deps.logger ?? {
      warn: (message: string) => {
        console.warn(`[plugin-installer] ${message}`);
      },
    };
    this._now = deps.now ?? (() => new Date().toISOString());
  }

  // ── Установка ───────────────────────────────────────────────────────

  /**
   * Установить плагин из локального каталога.
   *
   * Порядок проверок (важен, каждый шаг fail-closed):
   * 1. манифест (`synth.pack`: JSON, `validatePackManifest`, `kind: 'plugin'`);
   * 2. состав бандла + content-hash (детерминированный обход);
   * 3. скан выключен, а исполнение включено → отказ
   *    (`plugin.scan_disabled_with_execution`);
   * 4. trust-floor (`plugin.trust_below_floor`) — **до** install-policy;
   * 5. скан (сбой → `plugin.scan_rejected`, `dangerous` → `plugin.scan_rejected`);
   * 6. `installKind: 'runtime'` при `plugins.runtimeInstall: 'deny'` → отказ;
   * 7. install-policy: `allow` → установка, `ask` → карантин, `block` → отказ.
   */
  async installFromDirectory(request: PluginInstallRequest): Promise<PluginInstallOutcome> {
    const actor = request.actor ?? 'system';
    const installKind = request.installKind ?? 'runtime';

    // ── Шаг 1: манифест ───────────────────────────────────────────────
    const manifestRead = await readPluginManifest(request.dir);
    if (!manifestRead.ok) {
      await this._writeAudit({
        action: 'install',
        plugin: manifestRead.name ?? '',
        version: manifestRead.version ?? '',
        outcome: 'rejected',
        reason: 'plugin.manifest_invalid',
        actor,
        trustLevel: request.trustLevel,
        source: request.source,
      });
      return {
        outcome: 'rejected',
        ...(manifestRead.name ? { name: manifestRead.name } : {}),
        ...(manifestRead.version ? { version: manifestRead.version } : {}),
        reason: 'plugin.manifest_invalid',
        message: manifestRead.message,
      };
    }
    const manifest = manifestRead.manifest;
    const { name, version } = manifest;

    // ── Шаг 2: состав бандла и content-hash ───────────────────────────
    // Бинарные файлы в хеш не входят (хеш = код/текстовые ассеты, как у
    // сканера), но при раскладке копируются байт-в-байт (Ф5б-3).
    const { files, binaryFiles } = await collectBundleFiles(request.dir);
    const contentHash = computePluginContentHash(files);
    const entry = resolvePluginEntry(files);

    // ── Шаг 2б: режим исполнения и серверная точка входа (Ф4б-2) ──────
    // `remote` без `dist/server.js` — отказ: поднимать нечего (fail-closed).
    const execution = await resolveExecutionMode(request.dir, manifest);
    if (execution.mode === 'remote' && !execution.remoteEntry) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.remote_entry_missing',
        message:
          `Плагин «${name}» объявлен с mode: 'remote', но в бандле нет серверной точки ` +
          `входа «${REMOTE_ENTRY_FILE}» — установка отклонена (поднимать нечего).`,
        request,
        contentHash,
        mode: execution.mode,
      });
    }

    // ── Шаг 3: fail-closed — скан выключен, а исполнение включено ─────
    if (this._config.scan === 'disabled' && this._config.executionEnabled) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.scan_disabled_with_execution',
        message:
          'Сканирование расширений выключено (plugins.scan=disabled), а исполнение кода ' +
          'плагинов включено (plugins.executionEnabled=true) — установка отклонена: ' +
          'исполняемый код обязан быть просканирован.',
        request,
        contentHash,
        mode: manifest.mode,
      });
    }

    // ── Шаг 4: trust-floor (до install-policy, как в PluginHost) ──────
    if (trustLevelRank(request.trustLevel) > trustLevelRank(this._config.trustFloor)) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.trust_below_floor',
        message:
          `Уровень доверия плагина «${request.trustLevel}» ниже trust-floor инстанса ` +
          `«${this._config.trustFloor}» — установка запрещена.`,
        request,
        contentHash,
        mode: manifest.mode,
      });
    }

    // ── Шаг 5: скан ───────────────────────────────────────────────────
    const scan = await this._scanBundle({
      name,
      version,
      manifest,
      files,
      rootDir: request.dir,
      trustLevel: request.trustLevel,
      installKind,
      source: request.source,
      identifier: request.identifier,
      actor,
      contentHash,
    });
    if (!scan.ok) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: scan.reason,
        message: scan.message,
        request,
        contentHash,
        mode: manifest.mode,
      });
    }
    const scanSummary: ScanSummary = {
      verdict: scan.verdict,
      performed: scan.performed,
      findings: scan.findings,
    };

    // ── Шаг 6: runtime-install ────────────────────────────────────────
    if (installKind === 'runtime' && this._config.runtimeInstall === 'deny') {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.runtime_install_denied',
        message:
          'Установка плагинов во время работы инстанса запрещена ' +
          '(plugins.runtimeInstall=deny) — бандл не установлен.',
        request,
        contentHash,
        mode: manifest.mode,
        scan: scanSummary,
      });
    }

    // ── Шаг 7: install-policy ─────────────────────────────────────────
    const action = installPolicyDecision({
      trust: request.trustLevel,
      verdict: scan.verdict,
      kind: 'plugin',
    });

    if (action === 'block') {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.scan_rejected',
        message:
          `install-policy: block — вердикт сканера «${scan.verdict}» ` +
          `(находок: ${scan.findings}): установка заблокирована.` +
          (scan.note ? ` ${scan.note}.` : ''),
        request,
        contentHash,
        mode: manifest.mode,
        scan: scanSummary,
      });
    }

    // Раскладка: `allow` → installed/, `ask` → quarantine/ (lock не пишется).
    // Бинарные ассеты копируются байтами из каталога-источника (Ф5б-3).
    const staged = await stagePluginBundle(this._layout, {
      name,
      version,
      files,
      binaryFiles,
      sourceDir: request.dir,
      action,
      source: request.source,
      contentHash,
      fetchedAt: this._now(),
      trustLevel: request.trustLevel,
      installKind,
      ...(request.identifier ? { identifier: request.identifier } : {}),
      ...(request.ref ? { ref: request.ref } : {}),
    });

    if (action === 'ask') {
      await this._writeAudit({
        action: 'install',
        plugin: name,
        version,
        outcome: 'rejected',
        reason: 'plugin.approval_required',
        actor,
        trustLevel: request.trustLevel,
        scanVerdict: scan.verdict,
        scanPerformed: scan.performed,
        scanFindings: scan.findings,
        contentHash,
        source: request.source,
        mode: manifest.mode,
      });
      return {
        outcome: 'approval_required',
        name,
        version,
        dir: staged.dir,
        reason:
          `install-policy: ask — вердикт сканера «${scan.verdict}» ` +
          `(находок: ${scan.findings}); бандл помещён в карантин ` +
          `(${staged.dir}) и будет установлен после подтверждения.`,
      };
    }

    // ── Шаг 8: lock + аудит + (опционально) активация ─────────────────
    // Предыдущая версия того же плагина — её каталог убирается **после**
    // успешной записи lock (Ф5б-3, см. `_cleanupPreviousVersion`). При
    // `keepPrevious` (update) каталог и снимок записи сохраняются: это ступень
    // отката (`previous` в lock, долги Д2).
    const previous = await this._lock.get(name);
    const keepPrevious = request.keepPrevious === true;
    await this._lock.save(
      this._buildLockEntry({
        name,
        version,
        source: request.source,
        trustLevel: request.trustLevel,
        verdict: scan.verdict,
        contentHash,
        entry,
        mode: execution.mode,
        ...(execution.remoteEntry ? { remoteEntry: execution.remoteEntry } : {}),
        ...(request.identifier ? { identifier: request.identifier } : {}),
        ...(request.ref ? { ref: request.ref } : {}),
        ...(keepPrevious && previous ? { previous: previousOf(previous) } : {}),
      }),
    );
    await this._writeAudit({
      action: 'install',
      plugin: name,
      version,
      outcome: 'ok',
      actor,
      trustLevel: request.trustLevel,
      scanVerdict: scan.verdict,
      scanPerformed: scan.performed,
      scanFindings: scan.findings,
      contentHash,
      source: request.source,
      mode: manifest.mode,
    });

    await this._cleanupPreviousVersion(name, previous?.version, version, keepPrevious);

    const activated = request.activate
      ? await this._activate({
          name,
          version,
          manifest,
          files,
          rootDir: staged.dir,
          entry,
          ...(execution.remoteEntry ? { remoteEntry: execution.remoteEntry } : {}),
          contentHash,
          trustLevel: request.trustLevel,
          installKind,
          source: request.source,
          actor,
        })
      : undefined;

    return {
      outcome: 'installed',
      name,
      version,
      dir: staged.dir,
      contentHash,
      ...(activated ? { activated } : {}),
    };
  }

  /**
   * Установить плагин из **источника** (Д1): `dir`/`archive`/`npm`/`url`.
   *
   * Резолвинг источника (`resolvePluginSource`) отдаёт каталог бандла и
   * провенанс для lock-записи (`source`/`identifier`/`ref`), после чего
   * вызывается {@link installFromDirectory} — все гейты (манифест, скан,
   * trust-floor, install-policy, раскладка) остаются **теми же**, отдельной
   * «упрощённой» ветки установки нет.
   *
   * **Fail-closed.** Любая ошибка резолвинга (сеть, реестр, SRI/sha256, разбор
   * архива, локальный путь без `synth.pack`) — отказ `plugin.source_unavailable`
   * с аудитом `install/rejected`: разбирать нечего, на диск ничего не пишется.
   *
   * **Временный каталог.** `cleanup()` источника вызывается **всегда** (`finally`),
   * в том числе при отказе установки; ошибка уборки — предупреждение, не отказ
   * (установка уже состоялась/отклонена по существу).
   */
  async installFromSource(request: PluginInstallFromSourceRequest): Promise<PluginInstallOutcome> {
    const actor = request.actor ?? 'system';

    let resolved: ResolvedPluginSource;
    try {
      resolved = await resolvePluginSource(request, request.sourceContext ?? {});
    } catch (err) {
      return this._rejectInstall({
        actor,
        reason: 'plugin.source_unavailable',
        message:
          `Не удалось получить бандл плагина из источника «${request.kind}» ` +
          `(${request.ref}): ${err instanceof Error ? err.message : String(err)}`,
        trustLevel: request.trustLevel,
        source: request.kind,
      });
    }

    try {
      return await this.installFromDirectory({
        dir: resolved.dir,
        trustLevel: request.trustLevel,
        source: resolved.source,
        ...(resolved.identifier ? { identifier: resolved.identifier } : {}),
        ...(resolved.ref ? { ref: resolved.ref } : {}),
        ...(request.installKind ? { installKind: request.installKind } : {}),
        ...(request.activate ? { activate: true } : {}),
        actor,
      });
    } finally {
      try {
        await resolved.cleanup();
      } catch (err) {
        this._logger.warn(
          `не удалось удалить временный каталог источника плагина «${request.ref}»: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Обновление и откат ─────────────────────────────────────────────

  /**
   * Обновить установленный плагин из **того же источника**, что записан в lock
   * (PROP-090 §«Запись lock», долги Д2).
   *
   * Правила:
   * 1. Нет записи в lock → `plugin.not_found`.
   * 2. Источник — из lock (`source`/`identifier`/`ref`), а не из запроса:
   *    `npm` → `kind: 'npm'` (`version ?? 'latest'`), `local` → существующий
   *    каталог (`dir`) или `.tgz`/`.tar.gz` (`archive`), `url` → `kind: 'url'`
   *    с **обязательным** новым `sha256` (pin), прочее → отказ
   *    `plugin.source_unavailable`.
   * 3. Резолвинг → content-hash: совпал с lock → **`unchanged`** (ничего не
   *    пишется; временный каталог убирается).
   * 4. Иначе — обычная установка (`installFromDirectory`) с `keepPrevious`:
   *    гейты (манифест/скан/trust-floor/install-policy) те же, доверие —
   *    **из lock**, каталог прежней версии сохраняется, в lock пишется
   *    `previous`.
   * 5. Активация: был активен → старый модуль деактивируется **после**
   *    успешной установки, затем активируется новая версия; `activate: false`
   *    не активирует, не задано — сохраняет прежнее состояние. Отказ активации
   *    обновление не отменяет (возвращается `activated` с `rejected`).
   *
   * `cleanup()` резолвера вызывается всегда (в `finally`).
   */
  async update(name: string, opts: PluginUpdateOptions = {}): Promise<PluginUpdateOutcome> {
    const actor = opts.actor ?? 'system';

    const entry = await this._lock.get(name);
    if (!entry) {
      return this._rejectUpdate({
        name,
        actor,
        reason: 'plugin.not_found',
        message:
          `Плагин «${name}» не установлен (нет записи в plugins.lock.json) — обновлять нечего.`,
      });
    }

    const source = await this._updateSource(entry, opts);
    if ('message' in source) {
      return this._rejectUpdate({
        name,
        actor,
        reason: 'plugin.source_unavailable',
        message: source.message,
        entry,
      });
    }

    let resolved: ResolvedPluginSource;
    try {
      resolved = await resolvePluginSource(source, opts.sourceContext ?? {});
    } catch (err) {
      return this._rejectUpdate({
        name,
        actor,
        reason: 'plugin.source_unavailable',
        message:
          `Не удалось получить бандл обновления плагина «${name}» из источника ` +
          `«${source.kind}» (${source.ref}): ${err instanceof Error ? err.message : String(err)}`,
        entry,
      });
    }

    try {
      // Сверка с установленным: тот же состав файлов — обновлять нечего.
      // Манифест не читается здесь: с ним разберётся `installFromDirectory`
      // (и запишет осмысленный отказ `plugin.manifest_invalid` с аудитом).
      const { files } = await collectBundleFiles(resolved.dir);
      const contentHash = computePluginContentHash(files);
      if (contentHash === entry.content_hash) {
        this._logger.warn(
          `плагин «${name}» уже на версии ${entry.version}: бандл источника совпал по ` +
            'content-hash — обновление не требуется.',
        );
        return { outcome: 'unchanged', name, version: entry.version, contentHash };
      }

      const wasActive = this._host?.isActive(name) ?? false;
      const installed = await this.installFromDirectory({
        dir: resolved.dir,
        // Доверие — из lock: update не «переспрашивает» оператора заново.
        trustLevel: entry.trust_level,
        source: resolved.source,
        ...(resolved.identifier ? { identifier: resolved.identifier } : {}),
        ...(resolved.ref ? { ref: resolved.ref } : {}),
        installKind: opts.installKind ?? 'runtime',
        // Ступень отката: каталог прежней версии остаётся, в lock — `previous`.
        keepPrevious: true,
        actor,
      });

      if (installed.outcome === 'approval_required') {
        return {
          outcome: 'rejected',
          name,
          reason: 'plugin.approval_required',
          message: installed.reason,
        };
      }
      if (installed.outcome === 'rejected') {
        return {
          outcome: 'rejected',
          name: installed.name ?? name,
          reason: installed.reason,
          message: installed.message,
        };
      }

      const updated = await this._lock.get(name);
      // Старый модуль ещё загружен (активация в реестре — по имени): снимаем
      // его **после** успешной раскладки новой версии, затем активируем новую.
      if (wasActive) {
        await this._host?.deactivate(name, { actor });
      }
      const shouldActivate = opts.activate === true ? true : opts.activate === false ? false : wasActive;
      const activated = shouldActivate
        ? await this._activateInstalledVersion({
            name,
            version: installed.version,
            rootDir: installed.dir,
            ...(updated?.entry ? { entry: updated.entry } : {}),
            ...(updated?.remote_entry ? { remoteEntry: updated.remote_entry } : {}),
            contentHash: installed.contentHash,
            trustLevel: entry.trust_level,
            installKind: opts.installKind ?? 'runtime',
            source: resolved.source,
            actor,
          })
        : undefined;

      return {
        outcome: 'updated',
        name,
        version: installed.version,
        previousVersion: entry.version,
        dir: installed.dir,
        contentHash: installed.contentHash,
        ...(activated ? { activated } : {}),
      };
    } finally {
      try {
        await resolved.cleanup();
      } catch (err) {
        this._logger.warn(
          `не удалось удалить временный каталог источника обновления плагина «${name}»: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Откатить плагин на предыдущую установленную версию (PROP-090 §«Запись
   * lock», долги Д2).
   *
   * `previous` в lock — **одна ступень**: откат меняет местами текущую и
   * предыдущую, поэтому повторный `rollback` возвращает обратно. Каталог
   * предыдущей версии обязан существовать (иначе `plugin.rollback_unavailable`:
   * возвращаться некуда). Активный плагин деактивируется, затем активируется
   * откатанная версия; отказ активации откат не отменяет.
   */
  async rollback(
    name: string,
    opts: { actor?: string } = {},
  ): Promise<PluginRollbackOutcome> {
    const actor = opts.actor ?? 'system';
    const entry = await this._lock.get(name);
    if (!entry) {
      return this._rejectRollback({
        name,
        actor,
        reason: 'plugin.not_found',
        message:
          `Плагин «${name}» не установлен (нет записи в plugins.lock.json) — откатывать нечего.`,
      });
    }

    const previous = entry.previous;
    if (!previous) {
      return this._rejectRollback({
        name,
        version: entry.version,
        actor,
        reason: 'plugin.rollback_unavailable',
        message:
          `У плагина «${name}» нет предыдущей версии для отката (плагин не обновлялся).`,
        entry,
      });
    }

    const previousDir = pluginInstalledDir(this._layout, name, previous.version);
    if (!(await pathExists(join(previousDir, MANIFEST_FILE)))) {
      return this._rejectRollback({
        name,
        version: entry.version,
        actor,
        reason: 'plugin.rollback_unavailable',
        message:
          `Каталог предыдущей версии плагина «${name}@${previous.version}» отсутствует ` +
          '(удалён вручную или почищен) — откат невозможен.',
        entry,
      });
    }

    const wasActive = this._host?.isActive(name) ?? false;
    if (wasActive) {
      await this._host?.deactivate(name, { actor });
    }

    // Swap: текущая версия становится ступенью отката. `installed_at` записи —
    // исходный (иммутабелен), меняется только `updated_at`.
    await this._lock.save({
      name: entry.name,
      version: previous.version,
      source: entry.source,
      ...(entry.identifier ? { identifier: entry.identifier } : {}),
      trust_level: entry.trust_level,
      scan_verdict: entry.scan_verdict,
      content_hash: previous.content_hash,
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(previous.entry ? { entry: previous.entry } : {}),
      // Режим исполнения и серверная точка входа — свойства плагина, не версии.
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.remote_entry ? { remote_entry: entry.remote_entry } : {}),
      previous: previousOf(entry),
      installed_at: entry.installed_at,
      updated_at: this._now(),
    });

    await this._writeAudit({
      action: 'rollback',
      plugin: name,
      version: previous.version,
      outcome: 'ok',
      actor,
      trustLevel: entry.trust_level,
      scanVerdict: entry.scan_verdict,
      contentHash: previous.content_hash,
      source: entry.source,
    });

    const activated = wasActive
      ? await this._activateInstalledVersion({
          name,
          version: previous.version,
          rootDir: previousDir,
          ...(previous.entry ? { entry: previous.entry } : {}),
          ...(entry.remote_entry ? { remoteEntry: entry.remote_entry } : {}),
          contentHash: previous.content_hash,
          trustLevel: entry.trust_level,
          installKind: 'deploy',
          source: entry.source,
          actor,
        })
      : undefined;

    return {
      outcome: 'rolled_back',
      name,
      version: previous.version,
      previousVersion: entry.version,
      ...(activated ? { activated } : {}),
    };
  }

  // ── Подтверждение ───────────────────────────────────────────────────

  /**
   * Подтвердить бандл из карантина (`ask` → установка).
   *
   * Сначала ищется карантин (`opts.version` либо единственный каталог по
   * префиксу `name@`); если его нет, но lock-запись есть — установка уже
   * состоялась, результат идемпотентный (`installed`). Карантин **повторно**
   * сканируется: `block`/`dangerous` → отказ, бандл остаётся в карантине
   * (перенос «назад» из `installed/` не выполняется — мы туда не переносили).
   * `caution` при явном подтверждении владельца — достаточное основание для
   * установки: запрос `approve` и есть ответ на `ask`.
   *
   * Доверие/вид установки/источник берутся из `PLUGIN_INTEGRITY.json`
   * карантина (их резолвит источник, а не манифест); нет данных доверия —
   * fail-closed `community` (ниже любого дефолтного trust-floor).
   */
  async approve(
    name: string,
    opts: { version?: string; activate?: boolean; actor?: string } = {},
  ): Promise<PluginInstallOutcome> {
    const actor = opts.actor ?? 'system';
    const existing = await this._lock.get(name);
    const requestedVersion = opts.version ?? existing?.version;
    const lookup = await this._findQuarantine(name, requestedVersion);

    if (lookup.kind === 'ambiguous') {
      return this._rejectInstall({
        name,
        actor,
        reason: 'plugin.not_found',
        message:
          `В карантине несколько версий плагина «${name}» ` +
          `(${lookup.versions.join(', ')}) — укажите version явно.`,
      });
    }

    if (lookup.kind === 'none') {
      const installedDir = existing
        ? pluginInstalledDir(this._layout, name, existing.version)
        : undefined;
      const installedPresent = installedDir ? await pathExists(installedDir) : false;

      // Уже установлен — подтверждение идемпотентно (активация по запросу).
      if (
        existing &&
        installedDir &&
        installedPresent &&
        (!opts.version || opts.version === existing.version)
      ) {
        const dir = installedDir;
        const { files } = await collectBundleFiles(dir);
        const entry = existing.entry ?? resolvePluginEntry(files);
        let activated: PluginActivationResult | undefined;
        if (opts.activate) {
          const manifestRead = await readPluginManifest(dir);
          if (!manifestRead.ok) {
            return this._rejectInstall({
              name,
              version: existing.version,
              actor,
              reason: 'plugin.manifest_invalid',
              message: manifestRead.message,
            });
          }
          activated = await this._activate({
            name,
            version: existing.version,
            manifest: manifestRead.manifest,
            files,
            rootDir: dir,
            entry,
            contentHash: existing.content_hash,
            trustLevel: existing.trust_level,
            installKind: 'runtime',
            source: existing.source,
            actor,
          });
        }
        return {
          outcome: 'installed',
          name,
          version: existing.version,
          dir,
          contentHash: existing.content_hash,
          ...(activated ? { activated } : {}),
        };
      }
      return this._rejectInstall({
        name,
        ...(requestedVersion ? { version: requestedVersion } : {}),
        actor,
        reason: 'plugin.not_found',
        message: existing
          ? `Lock-запись плагина «${name}» есть, но каталог ` +
            `installed/<name>@${existing.version} отсутствует, а карантина нет — подтверждать нечего.`
          : `Плагин «${name}» не найден ни в lock-файле, ни в карантине — ` +
            'подтверждать нечего.',
      });
    }

    // ── Карантин: манифест, файлы, целостность ────────────────────────
    const qdir = lookup.dir;
    const manifestRead = await readPluginManifest(qdir);
    if (!manifestRead.ok) {
      return this._rejectInstall({
        name,
        version: lookup.version,
        actor,
        reason: 'plugin.manifest_invalid',
        message: manifestRead.message,
      });
    }
    const manifest = manifestRead.manifest;
    const version = manifest.version;
    const { files } = await collectBundleFiles(qdir);
    const contentHash = computePluginContentHash(files);
    const entry = resolvePluginEntry(files);

    const integrity = await readIntegrityFile(qdir);
    if (!integrity) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.integrity_unverifiable',
        message:
          `В карантине «${name}@${version}» нет читаемого ${INTEGRITY_FILE} — ` +
          'целостность и доверие бандла подтвердить нечем.',
      });
    }
    if (integrity.sha256 !== contentHash) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.integrity_mismatch',
        message:
          `content-hash карантина «${name}@${version}» не совпал с записанным в ` +
          `${INTEGRITY_FILE} (файлы изменены после сканирования) — подтверждение отклонено.`,
      });
    }

    const trustLevel: CatalogTrustLevel = integrity.trust_level ?? 'community';
    const installKind = integrity.install_kind ?? 'runtime';
    const source = integrity.source ?? 'unknown';

    // ── Повторные гейты (те же, что при установке) ────────────────────
    if (this._config.scan === 'disabled' && this._config.executionEnabled) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.scan_disabled_with_execution',
        message:
          'Сканирование расширений выключено (plugins.scan=disabled), а исполнение кода ' +
          'плагинов включено (plugins.executionEnabled=true) — подтверждение отклонено.',
        trustLevel,
        source,
        contentHash,
        mode: manifest.mode,
      });
    }

    if (trustLevelRank(trustLevel) > trustLevelRank(this._config.trustFloor)) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.trust_below_floor',
        message:
          `Уровень доверия плагина «${trustLevel}» ниже trust-floor инстанса ` +
          `«${this._config.trustFloor}» — подтверждение отклонено.`,
        trustLevel,
        source,
        contentHash,
        mode: manifest.mode,
      });
    }

    const scan = await this._scanBundle({
      name,
      version,
      manifest,
      files,
      rootDir: qdir,
      trustLevel,
      installKind,
      source,
      identifier: integrity.identifier,
      actor,
      contentHash,
    });
    if (!scan.ok) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: scan.reason,
        message: scan.message,
        trustLevel,
        source,
        contentHash,
        mode: manifest.mode,
      });
    }
    const scanSummary: ScanSummary = {
      verdict: scan.verdict,
      performed: scan.performed,
      findings: scan.findings,
    };

    if (installKind === 'runtime' && this._config.runtimeInstall === 'deny') {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.runtime_install_denied',
        message:
          'Установка плагинов во время работы инстанса запрещена ' +
          '(plugins.runtimeInstall=deny) — подтверждение отклонено.',
        trustLevel,
        source,
        contentHash,
        mode: manifest.mode,
        scan: scanSummary,
      });
    }

    if (installPolicyDecision({ trust: trustLevel, verdict: scan.verdict, kind: 'plugin' }) === 'block') {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.scan_rejected',
        message:
          `install-policy: block — повторный скан карантина дал вердикт «${scan.verdict}» ` +
          `(находок: ${scan.findings}); бандл остаётся в карантине.` +
          (scan.note ? ` ${scan.note}.` : ''),
        trustLevel,
        source,
        contentHash,
        mode: manifest.mode,
        scan: scanSummary,
      });
    }

    // Ф4б-2: режим исполнения и точка входа удалённого процесса — те же, что
    // при установке: режим `remote` без `dist/server.js` отклоняем (иначе
    // подтверждённый плагин нельзя было бы активировать).
    const { mode, remoteEntry } = await resolveExecutionMode(qdir, manifest);
    if (mode === 'remote' && !remoteEntry) {
      return this._rejectInstall({
        name,
        version,
        actor,
        reason: 'plugin.remote_entry_missing',
        message:
          `Плагин «${name}@${version}» объявлен в режиме «remote», но в бандле нет ` +
          `точки входа «${REMOTE_ENTRY_FILE}» — подтверждение отклонено.`,
        trustLevel,
        source,
        contentHash,
        mode,
      });
    }

    const dir = await releaseFromQuarantine(this._layout, name, version);
    await this._lock.save(
      this._buildLockEntry({
        name,
        version,
        source,
        trustLevel,
        verdict: scan.verdict,
        contentHash,
        entry,
        mode,
        ...(remoteEntry ? { remoteEntry } : {}),
        ...(integrity.identifier ? { identifier: integrity.identifier } : {}),
        ...(integrity.ref ? { ref: integrity.ref } : {}),
      }),
    );
    await this._writeAudit({
      action: 'install',
      plugin: name,
      version,
      outcome: 'ok',
      actor,
      trustLevel,
      scanVerdict: scan.verdict,
      scanPerformed: scan.performed,
      scanFindings: scan.findings,
      contentHash,
      source,
      mode: manifest.mode,
    });

    // Подтверждение — тоже установка: каталог предыдущей версии убирается
    // (если плагин не активен), как и в `installFromDirectory`.
    await this._cleanupPreviousVersion(name, existing?.version, version);

    const activated = opts.activate
      ? await this._activate({
          name,
          version,
          manifest,
          files,
          rootDir: dir,
          entry,
          contentHash,
          trustLevel,
          installKind,
          source,
          actor,
          // Ф4б-2: режим `remote` — дескриптору нужна точка входа процесса.
          ...(remoteEntry ? { remoteEntry } : {}),
        })
      : undefined;

    return {
      outcome: 'installed',
      name,
      version,
      dir,
      contentHash,
      ...(activated ? { activated } : {}),
    };
  }

  // ── Снятие ──────────────────────────────────────────────────────────

  /**
   * Снять установку: деактивация (если активен) → запись lock → каталог.
   *
   * Идемпотентно: нет записи в lock — `{removed: false}` (аудит не пишется,
   * снимать нечего). Каталоги `installed/<name>@<version>` и
   * `quarantine/<name>@<version>` (версия из lock) удаляются, если
   * `removeFiles !== false`.
   */
  async uninstall(
    name: string,
    opts: { removeFiles?: boolean; actor?: string } = {},
  ): Promise<PluginUninstallResult> {
    const actor = opts.actor ?? 'system';
    const entry = await this._lock.get(name);
    if (!entry) return { removed: false };

    let deactivated = false;
    if (this._host?.isActive(name)) {
      await this._host.deactivate(name, { actor });
      deactivated = true;
    }

    await this._lock.delete(name);

    if (opts.removeFiles !== false) {
      await rm(pluginInstalledDir(this._layout, name, entry.version), {
        recursive: true,
        force: true,
      });
      await rm(pluginQuarantineDir(this._layout, name, entry.version), {
        recursive: true,
        force: true,
      });
    }

    await this._writeAudit({
      action: 'uninstall',
      plugin: name,
      version: entry.version,
      outcome: 'ok',
      actor,
      trustLevel: entry.trust_level,
      scanVerdict: entry.scan_verdict,
      contentHash: entry.content_hash,
      source: entry.source,
    });

    return { removed: true, ...(deactivated ? { deactivated: true } : {}) };
  }

  /** Установленные плагины (записи lock, детерминированный порядок). */
  async list(): Promise<PluginLockEntry[]> {
    return this._lock.list();
  }

  // ── Вспомогательное ────────────────────────────────────────────────

  /**
   * Источник обновления по записи lock → запрос резолвера (или причина отказа).
   *
   * Клиент не выбирает источник при `update` (иначе «обновление» могло бы
   * подменить провенанс); поддерживаются те же виды, что ставились: `npm`,
   * локальный каталог/архив и https-URL (с **новым** pin).
   */
  private async _updateSource(
    entry: PluginLockEntry,
    opts: PluginUpdateOptions,
  ): Promise<
    | { kind: 'dir' | 'archive' | 'npm' | 'url'; ref: string; version?: string; sha256?: string }
    | { message: string }
  > {
    const identifier = entry.identifier?.trim();
    switch (entry.source) {
      case 'npm': {
        if (!identifier) {
          return {
            message:
              `У записи плагина «${entry.name}» нет npm-пакета в lock — ` +
              'источник обновления не восстановить, поставьте нужную версию установкой.',
          };
        }
        return { kind: 'npm', ref: identifier, version: opts.version?.trim() || 'latest' };
      }
      case 'local': {
        if (!identifier) {
          return { message: 'источник установки не найден по записи lock (нет identifier)' };
        }
        // Каталог — приоритетнее расширения: имя каталога может оканчиваться
        // на `.tgz`, но это всё ещё каталог бандла.
        if (await this._isDirectory(identifier)) {
          return { kind: 'dir', ref: identifier };
        }
        if (ARCHIVE_EXTENSION_REGEX.test(identifier)) {
          return { kind: 'archive', ref: identifier };
        }
        return {
          message:
            `источник установки не найден по записи lock: «${identifier}» не каталог и не ` +
            'архив (.tgz/.tar.gz) — обновите плагин установкой из доступного источника.',
        };
      }
      case 'url': {
        if (!identifier) {
          return { message: 'источник установки не найден по записи lock (нет identifier)' };
        }
        const sha256 = opts.sha256?.trim().toLowerCase() ?? '';
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
          return {
            message:
              'для обновления из URL укажите новый sha256 (pin) — адрес из lock сам по себе ' +
              'не гарантирует целостность.',
          };
        }
        return { kind: 'url', ref: identifier, sha256 };
      }
      default:
        return {
          message:
            `источник обновления «${entry.source}» не поддерживается: ` +
            'обновление возможно для local/npm/url — поставьте нужную версию установкой.',
        };
    }
  }

  /** Каталог ли путь (без исключений; отсутствующий — `false`). */
  private async _isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Отказ обновления: аудит `install/rejected` + результат вызывающему. */
  private async _rejectUpdate(input: {
    name: string;
    actor: string;
    reason: PluginAuditReason;
    message: string;
    entry?: PluginLockEntry;
  }): Promise<PluginUpdateOutcome> {
    await this._writeAudit({
      action: 'install',
      plugin: input.name,
      version: input.entry?.version ?? '',
      outcome: 'rejected',
      reason: input.reason,
      actor: input.actor,
      ...(input.entry
        ? {
            trustLevel: input.entry.trust_level,
            scanVerdict: input.entry.scan_verdict,
            contentHash: input.entry.content_hash,
            source: input.entry.source,
          }
        : {}),
    });
    return {
      outcome: 'rejected',
      name: input.name,
      reason: input.reason,
      message: input.message,
    };
  }

  /** Отказ отката: аудит `rollback/rejected` + результат вызывающему. */
  private async _rejectRollback(input: {
    name: string;
    version?: string;
    actor: string;
    reason: PluginAuditReason;
    message: string;
    entry?: PluginLockEntry;
  }): Promise<PluginRollbackOutcome> {
    await this._writeAudit({
      action: 'rollback',
      plugin: input.name,
      version: input.version ?? '',
      outcome: 'rejected',
      reason: input.reason,
      actor: input.actor,
      ...(input.entry
        ? {
            trustLevel: input.entry.trust_level,
            scanVerdict: input.entry.scan_verdict,
            contentHash: input.entry.content_hash,
            source: input.entry.source,
          }
        : {}),
    });
    return {
      outcome: 'rejected',
      name: input.name,
      reason: input.reason,
      message: input.message,
    };
  }

  /**
   * Активировать установленную версию по каталогу (update/rollback).
   *
   * Манифест и состав файлов перечитываются из каталога: шаг integrity хоста
   * сверяет переданный `contentHash` с фактическим содержимым — без `files`
   * проверка была бы «непроверяема». Хост не передан — активации нет.
   */
  private async _activateInstalledVersion(input: {
    name: string;
    version: string;
    rootDir: string;
    entry?: string;
    /** Ф4б-2: серверная точка входа (remote/both) из lock. */
    remoteEntry?: string;
    contentHash: string;
    trustLevel: CatalogTrustLevel;
    installKind: 'deploy' | 'runtime';
    source: string;
    actor: string;
  }): Promise<PluginActivationResult | undefined> {
    if (!this._host) return undefined;
    const manifestRead = await readPluginManifest(input.rootDir);
    if (!manifestRead.ok) {
      return {
        outcome: 'rejected',
        plugin: input.name,
        version: input.version,
        step: 'resolve',
        reason: 'plugin.manifest_invalid',
        message: manifestRead.message,
      };
    }
    const { files } = await collectBundleFiles(input.rootDir);
    return this._activate({
      name: input.name,
      version: input.version,
      manifest: manifestRead.manifest,
      files,
      rootDir: input.rootDir,
      entry: input.entry ?? resolvePluginEntry(files),
      ...(input.remoteEntry ? { remoteEntry: input.remoteEntry } : {}),
      contentHash: input.contentHash,
      trustLevel: input.trustLevel,
      installKind: input.installKind,
      source: input.source,
      actor: input.actor,
    });
  }

  /**
   * Удалить каталог предыдущей версии плагина после успешной установки новой
   * (PROP-090 §5, Ф5б-3).
   *
   * Правила:
   * - вызывается **только после** раскладки новой версии и записи lock —
   *   сбой уборки не должен превращать успешную установку в отказ;
   * - `keepPrevious` (update, долги Д2) — каталог **не** удаляется: это
   *   ступень отката (`previous` в lock);
   * - плагин **активен** (модуль загружен в процесс) → каталог остаётся:
   *   удалять код работающего плагина нельзя, предупреждение в лог; уборка
   *   произойдёт при следующей установке после деактивации/рестарта;
   * - ошибка удаления — предупреждение, не исключение (best-effort).
   */
  private async _cleanupPreviousVersion(
    name: string,
    previousVersion: string | undefined,
    version: string,
    keepPrevious = false,
  ): Promise<void> {
    if (!previousVersion || previousVersion === version) return;
    if (keepPrevious) return;
    const previousDir = pluginInstalledDir(this._layout, name, previousVersion);
    if (!(await pathExists(previousDir))) return;

    if (this._host?.isActive(name)) {
      this._logger.warn(
        `плагин «${name}» активен (версия ${this._host.getActivation(name)?.version ?? '?'}) — ` +
          `каталог предыдущей версии ${previousVersion} оставлен; он будет удалён ` +
          'при следующей установке после деактивации/рестарта.',
      );
      return;
    }

    try {
      await rm(previousDir, { recursive: true, force: true });
    } catch (err) {
      this._logger.warn(
        `не удалось удалить каталог предыдущей версии плагина «${name}@${previousVersion}»: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Найти карантин по имени (и версии, если задана). */
  private async _findQuarantine(
    name: string,
    version: string | undefined,
  ): Promise<QuarantineLookup> {
    if (version) {
      const dir = pluginQuarantineDir(this._layout, name, version);
      if (await pathExists(dir)) return { kind: 'found', version, dir };
      return { kind: 'none' };
    }

    let items: string[];
    try {
      items = await readdir(this._layout.quarantineDir);
    } catch {
      return { kind: 'none' };
    }
    const prefix = `${name}@`;
    const versions = items
      .filter((item) => item.startsWith(prefix))
      .map((item) => item.slice(prefix.length))
      .sort();
    if (versions.length === 0) return { kind: 'none' };
    if (versions.length > 1) return { kind: 'ambiguous', versions };
    return {
      kind: 'found',
      version: versions[0] as string,
      dir: pluginQuarantineDir(this._layout, name, versions[0] as string),
    };
  }

  /**
   * Шаг скана: прогон хука + запись аудита `scan` (всегда, как в `PluginHost`).
   *
   * `plugins.scan = 'disabled'` — скан не выполняется: вердикт `safe`, в
   * аудите `scanPerformed: false` (по журналу видно, что скана не было).
   * Сбой сканера — fail-closed (`plugin.scan_rejected`).
   */
  private async _scanBundle(input: {
    name: string;
    version: string;
    manifest: PackManifest;
    files: Record<string, string>;
    rootDir: string;
    trustLevel: CatalogTrustLevel;
    installKind: 'deploy' | 'runtime';
    source: string;
    identifier?: string;
    actor: string;
    contentHash: string;
  }): Promise<ScanStepResult> {
    if (this._config.scan === 'disabled') {
      await this._writeAudit({
        action: 'scan',
        plugin: input.name,
        version: input.version,
        outcome: 'ok',
        actor: input.actor,
        trustLevel: input.trustLevel,
        scanVerdict: 'safe',
        scanPerformed: false,
        scanFindings: 0,
        contentHash: input.contentHash,
        source: input.source,
      });
      return { ok: true, verdict: 'safe', performed: false, findings: 0 };
    }

    const hook = this._scan ?? this._builtinScan;
    const descriptor: PluginActivationDescriptor = {
      name: input.name,
      version: input.version,
      manifest: input.manifest,
      files: input.files,
      rootDir: input.rootDir,
      trustLevel: input.trustLevel,
      installKind: input.installKind,
      source: input.source,
      ...(input.identifier ? { sourceUrl: input.identifier } : {}),
    };

    let result: PluginScanResult;
    try {
      result = await hook(descriptor);
    } catch (err) {
      return {
        ok: false,
        reason: 'plugin.scan_rejected',
        message: `Сканер недоступен: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const performed = result.performed !== false;
    const findings = result.findings?.length ?? 0;
    const risky = result.verdict === 'dangerous' || result.verdict === 'caution';

    // Человекочитаемая сводка находок (для сообщения об отказе): первые три —
    // полный список в аудите не хранится (только число), а владельцу нужен
    // хотя бы один конкретный повод.
    const findingsNote = (result.findings ?? [])
      .slice(0, 3)
      .map((finding) => `${finding.category}/${finding.severity}: ${finding.description}`)
      .join('; ');
    const note = [result.reason, findingsNote].filter(Boolean).join('; ');

    await this._writeAudit({
      action: 'scan',
      plugin: input.name,
      version: input.version,
      outcome: risky ? 'rejected' : 'ok',
      actor: input.actor,
      ...(risky
        ? {
            reason:
              result.verdict === 'dangerous'
                ? ('plugin.scan_rejected' as const)
                : ('plugin.approval_required' as const),
          }
        : {}),
      trustLevel: input.trustLevel,
      scanVerdict: result.verdict,
      scanPerformed: performed,
      scanFindings: findings,
      contentHash: result.contentHash ?? input.contentHash,
      source: input.source,
    });

    if (result.verdict === 'dangerous') {
      return {
        ok: false,
        reason: 'plugin.scan_rejected',
        message:
          `Сканер отклонил плагин (вердикт «dangerous», находок: ${findings})` +
          (note ? `: ${note}.` : '.'),
      };
    }

    return {
      ok: true,
      verdict: result.verdict,
      performed,
      findings,
      ...(note ? { note } : {}),
    };
  }

  /** Активировать установленный бандл (хост не передан — не ошибка). */
  private async _activate(input: {
    name: string;
    version: string;
    manifest: PackManifest;
    files: Record<string, string>;
    rootDir: string;
    entry: string;
    /** Ф4б-2: серверная точка входа (для `out-of-process`). */
    remoteEntry?: string;
    contentHash: string;
    trustLevel: CatalogTrustLevel;
    installKind: 'deploy' | 'runtime';
    source: string;
    actor: string;
  }): Promise<PluginActivationResult | undefined> {
    if (!this._host) return undefined;
    const descriptor: PluginActivationDescriptor = {
      name: input.name,
      version: input.version,
      manifest: input.manifest,
      // Файлы передаются обязательно: шаг integrity сверяет content-hash,
      // а ожидаемый хеш известен — без файлов проверка «непроверяема».
      files: input.files,
      rootDir: input.rootDir,
      entry: input.entry,
      ...(input.remoteEntry ? { remoteEntry: input.remoteEntry } : {}),
      contentHash: input.contentHash,
      trustLevel: input.trustLevel,
      installKind: input.installKind,
      source: input.source,
      actor: input.actor,
    };
    return this._host.activate(descriptor, { actor: input.actor });
  }

  /** Запись lock-файла (upsert по имени — семантика порта). */
  private _buildLockEntry(input: {
    name: string;
    version: string;
    source: string;
    trustLevel: CatalogTrustLevel;
    verdict: PluginScanVerdict;
    contentHash: string;
    entry: string;
    /** Ф4б-2: эффективный режим исполнения из манифеста. */
    mode?: PackPluginMode;
    /** Ф4б-2: серверная точка входа `dist/server.js` (remote/both). */
    remoteEntry?: string;
    identifier?: string;
    ref?: string;
    /** Ступень отката (update): снимок прежней записи. */
    previous?: PluginLockPrevious;
  }): PluginLockEntry {
    const ts = this._now();
    return {
      name: input.name,
      version: input.version,
      source: input.source,
      ...(input.identifier ? { identifier: input.identifier } : {}),
      trust_level: input.trustLevel,
      scan_verdict: input.verdict,
      content_hash: input.contentHash,
      ...(input.ref ? { ref: input.ref } : {}),
      entry: input.entry,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.remoteEntry ? { remote_entry: input.remoteEntry } : {}),
      installed_at: ts,
      updated_at: ts,
      ...(input.previous ? { previous: input.previous } : {}),
    };
  }

  /** Отказ установки/подтверждения: аудит `install` + результат вызывающему. */
  private async _rejectInstall(input: {
    name?: string;
    version?: string;
    actor: string;
    reason: PluginAuditReason;
    message: string;
    request?: PluginInstallRequest;
    trustLevel?: CatalogTrustLevel;
    source?: string;
    contentHash?: string;
    mode?: PackManifest['mode'];
    scan?: ScanSummary;
  }): Promise<PluginInstallOutcome> {
    const name = input.name ?? '';
    const trustLevel = input.trustLevel ?? input.request?.trustLevel;
    const source = input.source ?? input.request?.source;
    await this._writeAudit({
      action: 'install',
      plugin: name,
      version: input.version ?? '',
      outcome: 'rejected',
      reason: input.reason,
      actor: input.actor,
      ...(trustLevel ? { trustLevel } : {}),
      ...(input.scan
        ? {
            scanVerdict: input.scan.verdict,
            scanPerformed: input.scan.performed,
            scanFindings: input.scan.findings,
          }
        : {}),
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      ...(source ? { source } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
    return {
      outcome: 'rejected',
      ...(input.name ? { name: input.name } : {}),
      ...(input.version ? { version: input.version } : {}),
      reason: input.reason,
      message: input.message,
    };
  }

  /**
   * Запись в журнал аудита плагинов (best-effort: сбой записи не ломает
   * установку — предупреждение в лог, как в `PluginHost`/ADR-092).
   */
  private async _writeAudit(input: AuditInput): Promise<void> {
    const entry: PluginAuditEntry = {
      id: `pa_${generateId()}`,
      ts: this._now(),
      actor: input.actor,
      scope: 'plugin',
      action: input.action,
      plugin: input.plugin,
      version: input.version,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.trustLevel ? { trustLevel: input.trustLevel } : {}),
      ...(input.scanVerdict ? { scanVerdict: input.scanVerdict } : {}),
      ...(input.scanPerformed !== undefined ? { scanPerformed: input.scanPerformed } : {}),
      ...(input.scanFindings !== undefined ? { scanFindings: input.scanFindings } : {}),
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    };
    try {
      await this._audit.append(entry);
    } catch (err) {
      this._logger.warn(
        `не удалось записать событие аудита плагинов (${input.action}/${input.plugin}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
