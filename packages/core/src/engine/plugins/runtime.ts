/**
 * PROP-090 §5/§10, фаза Ф5б (часть 1): `PluginRuntime` — сервис времени жизни
 * плагинов инстанса: **старт-активация** установленного, список со статусом
 * активации, точечные `activate`/`deactivate` и `dispose`.
 *
 * Здесь сходятся три уже готовых куска контура расширений:
 *
 * ```text
 * plugins.lock.json (порт PluginLockRepository)   — источник истины (что установлено)
 *   ↓ дескриптор активации (installed/<name>@<version>/ + synth.pack)
 * PluginHost (resolve → integrity → semver → trust/scan → policy → import → facade)
 *   ↓ вклады плагина
 * PromptBlockRegistry / LlmFilterRegistry / ToolRegistry  — те же экземпляры,
 *                                                           что у оркестратора
 * ```
 *
 * **Старт-активация** (`activateInstalled`) — deploy-time сценарий: инстанс
 * поднимается, а установленные плагины должны заработать без ручного запроса.
 * Правила:
 * 1. `plugins.executionEnabled === false` → **no-op** (`[]`): исполнение кода
 *    выключено политикой, это ожидаемый исход, а не ошибка (PROP-090 §10/Ф1).
 * 2. Порядок — по записям lock, детерминированно по имени плагина.
 * 3. Уже активный плагин пропускается (повторная активация — осмысленный отказ
 *    `plugin.already_active`, но старт не должен «шуметь» отказами).
 * 4. Ошибка одного плагина **не мешает** остальным: каждый шаг изолирован,
 *    причина уходит в лог (`logger.warn`) и в результат.
 * 5. Метод **никогда не бросает**: старт инстанса не падает из-за плагина.
 *
 * **Манифест — из бандла, файлы — тоже.** Дескриптор несёт `files` (состав
 * каталога установки): без них шаг `integrity` не может сверить
 * `content_hash` из lock и отклонил бы **любой** плагин
 * (`plugin.integrity_unverifiable`). Состав собирается тем же обходом, что у
 * установщика (`collectBundleFiles`), — иначе хеши разошлись бы. Гейт не
 * ослабляется: `content_hash` из lock сверяется с фактическим содержимым
 * каталога (подмена/порча бандла → `plugin.integrity_mismatch`).
 *
 * Сетевых вызовов нет, конфиги из env не читаются: всё приходит зависимостями
 * (ADR-096 — раскладка и порты; ADR-023 — конфиг снаружи).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CatalogTrustLevel,
  PackManifest,
  PackPluginMode,
  PluginLockEntry,
  PluginScanVerdict,
  PluginsConfig,
  PluginServerPolicy,
  PluginServerPolicyStatus,
} from '@itphx/synth-shared';

import type { PluginAuditRepository } from '../../storage/ports/plugin-audit-repository.js';
import type { PluginLockRepository } from '../../storage/ports/plugin-lock-repository.js';
import type { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import type { LlmFilterRegistry } from '../gateway/llm-filter-registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  PluginActivationDescriptor,
  PluginActivationResult,
  PluginDeactivationResult,
  PluginLoader,
  PluginLogger,
  PluginScanHook,
} from './activation.js';
import { createInlinePluginLoader, DEFAULT_PLUGIN_ENTRY } from './inline-loader.js';
import { collectBundleFiles, PluginInstaller } from './installer.js';
import { computePluginContentHash } from './integrity.js';
import { listDeployPlugins } from './deploy.js';
import type { PluginDeployScanEntry } from './deploy.js';
import type { PluginLayout } from './layout.js';
import { pluginInstalledDir } from './layout.js';
import { PluginHost } from './plugin-host.js';

/** Имя файла манифеста (`synth.pack`, ADR-086 §5). */
const MANIFEST_FILE = 'synth.pack';

/** Актор по умолчанию для операций времени жизни (аудит). */
const DEFAULT_ACTOR = 'system';

/** Итог deploy-установки при старте (`installDeployPlugins`, Ф5в). */
export interface PluginDeployInstallResult {
  /** Установленные (или переустановленные) плагины. */
  installed: string[];
  /** Пропущенные: та же версия и тот же content-hash, что в lock. */
  skipped: string[];
  /** Не установленные: `reason` — код отказа (`plugin.*`) или причина сбоя. */
  failed: Array<{ name: string; reason: string }>;
}

/** Зависимости `PluginRuntime`. */
export interface PluginRuntimeDeps {
  /** Раскладка слоя плагинов (`<home>/plugin` или `{dataDir}/plugin`). */
  layout: PluginLayout;
  /** Эффективная конфигурация слоя плагинов (runtime > config > defaults). */
  config: PluginsConfig;
  /** Версия host-приложения (Synth) — сверяется с `host` манифеста. */
  hostVersion: string;
  /** Порт журнала аудита плагинов (ADR-096). */
  audit: PluginAuditRepository;
  /** Порт lock-файла плагинов (`plugins.lock.json`) — источник истины. */
  lock: PluginLockRepository;
  /** **Тот же** экземпляр, что у композера/оркестратора (точка `promptBlocks`). */
  promptBlocks: PromptBlockRegistry;
  /** **Тот же** экземпляр, что у gateway (`orchestrator.getLlmFilters()`). */
  llmFilters: LlmFilterRegistry;
  /** **Тот же** экземпляр, что у оркестратора и permission-слоя (точка `tools`). */
  tools: ToolRegistry;
  /** Загрузчик кода плагина (по умолчанию — `inline`: `createInlinePluginLoader`). */
  loader?: PluginLoader;
  /**
   * Ф4б-2: загрузчики по транспорту. Хост сам выбирает транспорт по
   * `manifest.mode` (`inline`/`remote`/`both`): `inline` — код в процессе core,
   * `remote` — отдельный процесс на loopback (`PluginProcessManager`).
   */
  loaders?: { inline?: PluginLoader; remote?: PluginLoader };
  /**
   * Ф4б-2: менеджер процессов удалённых плагинов — его `stopAll()` вызывается
   * при `dispose()` (остановка инстанса): процессы не должны остаться висеть.
   */
  processManager?: { stopAll(): Promise<void> };
  /** Скан/проверка доверия (не задан — встроенный сканер `engine/plugins/scan/`). */
  scan?: PluginScanHook;
  /**
   * Ф7 (PROP-090): резолвер серверной политики плагинов в гибридном режиме.
   *
   * `undefined` — сервера нет/недоступен/политика неизвестна: плагины
   * работают в режиме cooperative и помечаются «не проверен сервером».
   * Политика `allowlist` без плагина в списке → активация отклоняется
   * (`plugin.hybrid_not_allowed`).
   */
  serverPolicy?: () => PluginServerPolicy | undefined | Promise<PluginServerPolicy | undefined>;
  /** Логгер (по умолчанию — `console.warn` с префиксом `[plugin-runtime]`). */
  logger?: PluginLogger;
  /** Инъекция часов — для детерминированных тестов (ISO-8601). */
  now?: () => string;
}

/**
 * Запись установленного плагина вместе со статусом активации
 * (для API/UI и диагностики).
 */
export interface PluginRuntimeEntry {
  /** Имя плагина. */
  name: string;
  /** Установленная версия. */
  version: string;
  /** Источник установки (`local`/`npm`/`catalog`/`builtin`/…). */
  source: string;
  /** Фактический уровень доверия (из lock). */
  trustLevel: CatalogTrustLevel;
  /** Вердикт последнего скана (из lock). */
  scanVerdict: PluginScanVerdict;
  /** Content-hash бандла (из lock). */
  contentHash: string;
  /** Точка входа бандла (из lock, если записана). */
  entry?: string;
  /** Время установки (ISO-8601, из lock). */
  installedAt: string;
  /** Время последней записи lock (ISO-8601). */
  updatedAt: string;
  /** Плагин активен в этом процессе? */
  active: boolean;
  /** Режим из активации (`inline`/`remote`/`both`), если активен. */
  mode?: PackPluginMode;
  /**
   * Ф7 (PROP-090): статус проверки сервером.
   *
   * `allowed` — сервер подтвердил (политика `off` или плагин в allow-list);
   * `denied` — сервер запретил; `unverified` — сервер недоступен или политика
   * неизвестна (cooperative: плагин работает, но сервер его не подтвердил).
   */
  serverPolicy: PluginServerPolicyStatus;
}

/**
 * Сервис времени жизни плагинов инстанса (Ф5б-1).
 *
 * Держит единственные на инстанс `PluginHost` и `PluginInstaller` (установщик
 * получает хост — иначе `uninstall` не деактивировал бы плагин, а
 * `installFromDirectory({ activate: true })` не активировал). HTTP API/CLI —
 * Ф5б-2/Ф5б-3: они работают через эти же два объекта.
 */
export class PluginRuntime {
  /** Загрузчик плагинов (пайплайн активации, реестр активаций, аудит). */
  readonly host: PluginHost;
  /** Сервис установки/подтверждения/снятия (с тем же хостом). */
  readonly installer: PluginInstaller;
  /**
   * Раскладка слоя плагинов (`installed/`/`quarantine/`/lock) — нужна HTTP API
   * для чтения манифеста и `PLUGIN_INTEGRITY.json` каталога установки (Ф5б-2).
   */
  readonly layout: PluginLayout;
  /**
   * Эффективная конфигурация слоя, с которой собран этот рантайм (на старте
   * процесса). API настроек отдаёт её как `running` (применение — рестартом).
   */
  readonly config: PluginsConfig;

  private readonly _lock: PluginLockRepository;
  private readonly _logger: PluginLogger;
  /** Менеджер процессов удалённых плагинов (Ф4б-2) — гасится в `dispose`. */
  private readonly _processManager: PluginRuntimeDeps['processManager'];

  constructor(deps: PluginRuntimeDeps) {
    this.layout = deps.layout;
    this.config = deps.config;
    this._lock = deps.lock;
    this._processManager = deps.processManager;
    this._logger = deps.logger ?? {
      warn: (message: string) => {
        console.warn(`[plugin-runtime] ${message}`);
      },
    };

    this.host = new PluginHost({
      ...(deps.loaders ? { loaders: deps.loaders } : {}),
      audit: deps.audit,
      config: deps.config,
      hostVersion: deps.hostVersion,
      loader: deps.loader ?? createInlinePluginLoader(),
      promptBlocks: deps.promptBlocks,
      llmFilters: deps.llmFilters,
      tools: deps.tools,
      ...(deps.scan ? { scan: deps.scan } : {}),
      ...(deps.serverPolicy ? { serverPolicy: deps.serverPolicy } : {}),
      logger: this._logger,
    });
    this.installer = new PluginInstaller({
      layout: deps.layout,
      lock: deps.lock,
      audit: deps.audit,
      config: deps.config,
      // Тот же хост: `uninstall` деактивирует, `installFromDirectory({activate})`
      // активирует — иначе установщик и рантайм разошлись бы по реестру активаций.
      host: this.host,
      ...(deps.scan ? { scan: deps.scan } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      logger: this._logger,
    });
  }

  // ── Старт-активация ─────────────────────────────────────────────────

  /**
   * Активировать всё установленное (deploy-time старт инстанса).
   *
   * Не бросает: сбой чтения lock или отдельного плагина логируется и
   * отражается в результате (`outcome: 'rejected'`), остальные плагины
   * активируются. Пустой массив — исполнение кода выключено
   * (`plugins.executionEnabled=false`) либо нечего активировать.
   */
  async activateInstalled(opts: { actor?: string } = {}): Promise<PluginActivationResult[]> {
    // Исполнение кода выключено политикой — ожидаемый no-op, не ошибка.
    if (!this.config.executionEnabled) return [];

    const actor = opts.actor ?? 'startup';
    let entries: PluginLockEntry[];
    try {
      entries = await this._installedEntries();
    } catch (err) {
      this._logger.warn(
        `не удалось прочитать lock-файл плагинов — старт-активация пропущена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }

    const results: PluginActivationResult[] = [];
    for (const entry of entries) {
      // Уже активен (повторный вызов/активация из API до старта) — не трогаем.
      if (this.host.isActive(entry.name)) continue;
      results.push(await this._activateEntrySafe(entry, actor));
    }
    return results;
  }

  // ── Установка deploy-плагинов (Ф5в) ────────────────────────────────

  /**
   * Установить бандлы из deploy-каталога (`plugins.deployDir`) — образ/PVC.
   *
   * Запускается **при старте** инстанса (managed и standalone) до
   * {@link activateInstalled}: сначала плагины ставятся (гейты те же, что у
   * ручной установки), затем активируются из lock.
   *
   * Правила:
   * 1. Каталог не задан (`deployDir` пуст) → no-op: пустой результат. Это
   *    штатный случай standalone и образов без плагинов.
   * 2. Установка — **без активации**: активация отдельным шагом, чтобы
   *    `plugins.executionEnabled` оставался единственным переключателем
   *    исполнения кода.
   * 3. Идемпотентность: та же версия и тот же `content_hash`, что в lock →
   *    `skipped` (каталог не перезаписывается).
   * 4. Ошибка одного бандла (манифест, trust-floor, скан, раскладка) **не
   *    ломает старт**: запись в `failed` + `logger.warn`; остальные ставятся.
   * 5. Доверие — `plugins.deployTrust` (образ — доверенный источник кода, но
   *    политика инстанса важнее: ниже `trustFloor` — штатный отказ
   *    `plugin.trust_below_floor`). Скан и install-policy — **те же**, что у
   *    ручной установки: образ не повод отключать проверку содержимого.
   *
   * Метод **никогда не бросает**.
   */
  async installDeployPlugins(
    opts: { actor?: string } = {},
  ): Promise<PluginDeployInstallResult> {
    const result: PluginDeployInstallResult = { installed: [], skipped: [], failed: [] };
    const deployDir = (this.config.deployDir ?? '').trim();
    if (!deployDir) return result;

    const actor = opts.actor ?? 'startup';
    let entries: PluginDeployScanEntry[];
    try {
      entries = await listDeployPlugins(deployDir, { logger: this._logger });
    } catch (err) {
      this._logger.warn(
        `не удалось прочитать каталог deploy-плагинов «${deployDir}» — установка пропущена: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return result;
    }

    for (const entry of entries) {
      try {
        // Сверка с lock до установки: тот же бандл не переустанавливаем.
        const existing = await this._lock.get(entry.name);
        if (existing) {
          const { files } = await collectBundleFiles(entry.dir);
          const contentHash = computePluginContentHash(files);
          if (
            existing.version === entry.version &&
            existing.content_hash === contentHash
          ) {
            result.skipped.push(entry.name);
            continue;
          }
        }

        const outcome = await this.installer.installFromDirectory({
          dir: entry.dir,
          // Доверие deploy-бандлов задаёт конфиг инстанса; манифест его не
          // повышает (trust-floor проверяется установщиком до install-policy).
          trustLevel: this.config.deployTrust,
          source: 'deploy',
          identifier: entry.dir,
          installKind: 'deploy',
          actor,
        });

        if (outcome.outcome === 'installed') {
          result.installed.push(outcome.name);
          continue;
        }
        if (outcome.outcome === 'approval_required') {
          this._logger.warn(
            `deploy-плагин «${entry.name}@${entry.version}» требует подтверждения ` +
              '(install-policy ask) — бандл оставлен в карантине, установка при старте не выполнена.',
          );
          result.failed.push({ name: entry.name, reason: 'plugin.approval_required' });
          continue;
        }
        this._logger.warn(
          `deploy-плагин «${entry.name}@${entry.version}» не установлен: ` +
            `${outcome.reason} — ${outcome.message}`,
        );
        result.failed.push({ name: entry.name, reason: outcome.reason });
      } catch (err) {
        this._logger.warn(
          `deploy-плагин «${entry.name}@${entry.version}» не установлен: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        // Бандл не читается/не раскладывается — «источник недоступен».
        result.failed.push({ name: entry.name, reason: 'plugin.source_unavailable' });
      }
    }
    return result;
  }

  // ── Список/точечные операции ────────────────────────────────────────

  /**
   * Установленные плагины + статус активации (детерминированный порядок по
   * имени). Карантин сюда не входит: он не установлен (lock не пишется).
   */
  async list(): Promise<PluginRuntimeEntry[]> {
    const entries = await this._installedEntries();
    const result: PluginRuntimeEntry[] = [];
    for (const entry of entries) {
      const activation = this.host.getActivation(entry.name);
      result.push({
        name: entry.name,
        version: entry.version,
        source: entry.source,
        trustLevel: entry.trust_level,
        scanVerdict: entry.scan_verdict,
        contentHash: entry.content_hash,
        ...(entry.entry ? { entry: entry.entry } : {}),
        installedAt: entry.installed_at,
        updatedAt: entry.updated_at,
        active: activation !== undefined,
        ...(activation?.mode ? { mode: activation.mode } : {}),
        // Ф7: статус проверки сервером (cooperative-маркер для UI/CLI).
        serverPolicy: await this.host.serverPolicyStatus(entry.name),
      });
    }
    return result;
  }

  /**
   * Активировать установленный плагин по имени.
   *
   * Нет lock-записи — осмысленный отказ `plugin.not_found` (не исключение):
   * «активировать нечего» — штатный ответ API/CLI.
   */
  async activate(name: string, opts: { actor?: string } = {}): Promise<PluginActivationResult> {
    const entry = await this._lock.get(name);
    if (!entry) {
      return {
        outcome: 'rejected',
        plugin: name,
        version: '',
        step: 'resolve',
        reason: 'plugin.not_found',
        message: `Плагин «${name}» не установлен (нет записи в plugins.lock.json) — активировать нечего.`,
      };
    }
    return this._activateEntrySafe(entry, opts.actor ?? DEFAULT_ACTOR);
  }

  /** Деактивировать плагин (обратная прокрутка disposers, аудит). */
  async deactivate(name: string, opts: { actor?: string } = {}): Promise<PluginDeactivationResult> {
    return this.host.deactivate(name, { actor: opts.actor ?? DEFAULT_ACTOR });
  }

  /**
   * Запись в журнал аудита плагинов: выдача server-scoped токена (Ф7,
   * Уровень 2). Действие `token`; секрет токена не пишется (инвариант 13).
   */
  async recordTokenIssued(input: {
    plugin: string;
    version?: string;
    actor?: string;
  }): Promise<void> {
    await this.host.recordTokenIssued(input);
  }

  /**
   * Деактивировать всё (обратный порядок активации) — остановка инстанса и
   * тесты. Ошибка одного плагина не мешает остальным и не бросается наружу.
   */
  async dispose(): Promise<void> {
    const active = [...this.host.listActivations()].reverse();
    for (const handle of active) {
      try {
        await this.host.deactivate(handle.plugin, { actor: 'shutdown' });
      } catch (err) {
        this._logger.warn(
          `не удалось деактивировать плагин «${handle.plugin}»: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ── Вспомогательное ────────────────────────────────────────────────

  /** Записи lock в детерминированном порядке (по имени плагина). */
  private async _installedEntries(): Promise<PluginLockEntry[]> {
    const entries = await this._lock.list();
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Активировать запись lock; любое исключение (fs/импорт/порт) превращается в
   * отказ `plugin.loader_unavailable` и предупреждение в лог — старт цел.
   */
  private async _activateEntrySafe(
    entry: PluginLockEntry,
    actor: string,
  ): Promise<PluginActivationResult> {
    try {
      return await this._activateEntry(entry, actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.warn(
        `активация плагина «${entry.name}@${entry.version}» завершилась ошибкой: ${message}`,
      );
      return {
        outcome: 'rejected',
        plugin: entry.name,
        version: entry.version,
        step: 'import',
        reason: 'plugin.loader_unavailable',
        message: `Активация плагина «${entry.name}» завершилась ошибкой: ${message}`,
      };
    }
  }

  /**
   * Дескриптор активации из записи lock + активация через `PluginHost`.
   *
   * `installKind: 'deploy'` — плагин лежит в инстансе (образ/PVC), а не
   * ставится во время работы, поэтому `plugins.runtimeInstall=deny` его не
   * блокирует (это политика runtime-установок).
   */
  private async _activateEntry(
    entry: PluginLockEntry,
    actor: string,
  ): Promise<PluginActivationResult> {
    const rootDir = pluginInstalledDir(this.layout, entry.name, entry.version);
    const manifest = await this._readManifest(rootDir);
    if (!manifest) {
      // Манифеста нет/он битый: дескриптор не собрать (манифест — обязательное
      // поле), отказ штатный и с тем же кодом, что у гейта resolve хоста.
      this._logger.warn(
        `плагин «${entry.name}@${entry.version}»: манифест «${MANIFEST_FILE}» в каталоге ` +
          'установки не читается — активация отклонена (plugin.manifest_invalid).',
      );
      return {
        outcome: 'rejected',
        plugin: entry.name,
        version: entry.version,
        step: 'resolve',
        reason: 'plugin.manifest_invalid',
        message:
          `В каталоге установки плагина «${entry.name}@${entry.version}» нет читаемого ` +
          `манифеста «${MANIFEST_FILE}» — активация отклонена.`,
      };
    }

    // Файлы бандла — обязательны для шага integrity: ожидаемый content-hash из
    // lock сверяется с фактическим содержимым каталога (подмена → mismatch).
    const { files } = await collectBundleFiles(rootDir);

    const descriptor: PluginActivationDescriptor = {
      name: entry.name,
      version: entry.version,
      manifest,
      files,
      rootDir,
      entry: entry.entry ?? DEFAULT_PLUGIN_ENTRY,
      // Ф4б-2: режим `remote` — хост поднимает отдельный процесс плагина;
      // точка входа сервера приходит из lock (`dist/server.js`).
      ...(entry.remote_entry ? { remoteEntry: entry.remote_entry } : {}),
      contentHash: entry.content_hash,
      trustLevel: entry.trust_level,
      installKind: 'deploy',
      source: entry.source,
      actor,
    };
    return this.host.activate(descriptor, { actor });
  }

  /**
   * Прочитать `synth.pack` каталога установки (`null` — нет/не JSON/не объект).
   *
   * Содержательная валидация манифеста остаётся за `PluginHost` (шаг `resolve`
   * и семвер-гейт): здесь только «есть ли из чего собрать дескриптор».
   */
  private async _readManifest(rootDir: string): Promise<PackManifest | null> {
    let text: string;
    try {
      text = await readFile(join(rootDir, MANIFEST_FILE), 'utf8');
    } catch {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    return raw as PackManifest;
  }
}
