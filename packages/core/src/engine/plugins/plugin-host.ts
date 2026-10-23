/**
 * PROP-090 §10: `PluginHost` — загрузчик плагинов.
 *
 * Пайплайн активации (PROP-090 §10, шаги 1–9):
 * `resolve → integrity → semver-гейт → trust/scan → политика режима → import →
 * facade (сбор disposers) → аудит`.
 *
 * Каждый шаг — отдельная проверяемая функция с **машиночитаемым вердиктом**
 * (код причины + человекочитаемое сообщение). Отказ на раннем шаге не даёт
 * дойти до поздних: плагин, не прошедший integrity, не дойдёт до `import`.
 *
 * **Ф1: исполнение кода выключено по умолчанию.** `plugins.executionEnabled`
 * по умолчанию `false` — шаг `import` останавливается с
 * `plugin.execution_disabled` (это ожидаемый исход, а не ошибка). Загрузчик
 * `inline` реализован в Ф4а (`engine/plugins/inline-loader.ts`) и включается
 * опцией `loader`; без него при включённом `executionEnabled` шаг
 * останавливается с `plugin.loader_unavailable`.
 *
 * **Идемпотентность:** повторная активация уже активного плагина —
 * **осмысленный отказ** `plugin.already_active` (а не переактивация):
 * активация имеет побочные эффекты (регистрации), поэтому переключение
 * выполняется явно — `deactivate()` → `activate()`.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_EXTENSION_CONTRACT,
  checkExtensionCompatibility,
  diffPackProvides,
  generateId,
  installPolicyDecision,
  pluginToolLocalName,
  trustLevelRank,
} from '@itphx/synth-shared';
import type {
  CatalogTrustLevel,
  PackManifest,
  PackProvides,
  PackProvidesKind,
  PackProvidesMismatch,
  PluginAuditAction,
  PluginAuditEntry,
  PluginAuditReason,
  PluginScanVerdict,
  PluginsConfig,
  PluginServerPolicy,
  PluginServerPolicyStatus,
} from '@itphx/synth-shared';
import type { DictionaryRepository } from '../../storage/ports/dictionary-repository.js';
import type { PluginAuditRepository } from '../../storage/ports/plugin-audit-repository.js';
import type { PromptBlockRegistry } from '../context/prompt-block-registry.js';
import type { LlmFilterAuditEvent, LlmFilterRegistry } from '../gateway/llm-filter-registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  PluginActivationDescriptor,
  PluginActivationHandle,
  PluginActivationResult,
  PluginActivationStep,
  PluginDeactivationResult,
  PluginDisposer,
  PluginFacade,
  PluginLoader,
  PluginLogger,
  PluginScanHook,
} from './activation.js';
import { pluginLoadFailureReason } from './activation.js';
import { readExactHostExceptions } from './exact-host-exceptions.js';
import { evaluatePluginServerPolicy } from './hybrid-policy.js';
import { verifyPluginIntegrity } from './integrity.js';
import { DEFAULT_PLUGIN_ENTRY } from './inline-loader.js';
import { createPluginScanHook } from './scan/hook.js';

/**
 * Версия контракта Extension API, который предоставляет хост.
 * Манифест плагина объявляет совместимость через `contracts.extensionApi`.
 *
 * Полный semver обязателен: гейт (`satisfiesSemverRange`) разбирает версию
 * строго (`major.minor.patch`), поэтому `'1'` не прошёл бы даже диапазон `^1`.
 */
export const DEFAULT_EXTENSION_CONTRACT_VERSION = '1.0.0';

/**
 * Соответствие кодов решений фильтра каноническим причинам журнала плагинов.
 *
 * Колбэк `onAudit` зовётся gateway'ем **только** для канонических кодов
 * (`plugin_filter.denied`/`deny_downgraded`/`unavailable`); коды хоста
 * (`plugin_filter.timeout`/`error`/`allowed`/`redact_*`/`buffering_required`)
 * живут исключительно в аудите gateway — перечень `PLUGIN_AUDIT_REASONS` ими
 * не расширяется (решение Ф3б, 2026-10-22).
 */
const FILTER_JOURNAL_REASONS: ReadonlyMap<string, PluginAuditReason> = new Map([
  ['plugin_filter.denied', 'plugin_filter.denied'],
  ['plugin_filter.deny_downgraded', 'plugin_filter.deny_downgraded'],
  ['plugin_filter.unavailable', 'plugin_filter.unavailable'],
]);

/** Названия видов вкладов для сообщений об отказе (PROP-090 §«Правило соответствия»). */
const PROVIDES_KIND_LABELS: Record<PackProvidesKind, string> = {
  tool: 'тул',
  promptBlock: 'блок промпта',
  llmFilter: 'фильтр LLM-вызовов',
};

/** Человекочитаемое описание одного расхождения `provides` ↔ регистрации. */
function describeProvidesMismatch(mismatch: PackProvidesMismatch): string {
  const label = PROVIDES_KIND_LABELS[mismatch.kind] ?? mismatch.kind;
  return mismatch.issue === 'missing'
    ? `${label} «${mismatch.name}» объявлен, но не зарегистрирован`
    : `${label} «${mismatch.name}» зарегистрирован, но не объявлен`;
}


/** Опции `PluginHost`. */
export interface PluginHostOptions {
  /** Порт журнала аудита плагинов (ADR-096). */
  audit: PluginAuditRepository;
  /** Эффективная конфигурация слоя плагинов (runtime > config > defaults). */
  config: PluginsConfig;
  /** Версия host-приложения (Synth) — сверяется с `host` манифеста. */
  hostVersion: string;
  /** Версия контракта Extension API (по умолчанию `1`). */
  contractVersion?: string;
  /**
   * Явный список точных исключений семвер-гейта. Перекрывает файл из конфига
   * (`plugins.exactHostExceptions`) — используется в тестах и там, где список
   * приходит не из файла.
   */
  exactHostExceptions?: readonly string[];
  /**
   * Хук скана/проверки доверия — точка расширения Ф2.
   *
   * Не задан — используется **встроенный** сканер (`engine/plugins/scan/`):
   * статический разбор бандла + матрица install-policy.
   */
  scan?: PluginScanHook;
  /**
   * Словарь системных словарей — детектор prompt-injection для встроенного
   * сканера (категория `injection`).
   */
  dictionaryStore?: DictionaryRepository;
  /**
   * Загрузчик `inline` (код в процессе core) — исторически опция `loader`
   * (Ф4а). Эквивалент `loaders.inline`; `loaders.inline` приоритетнее.
   */
  loader?: PluginLoader;
  /**
   * Ф4б-2: загрузчики по режиму исполнения манифеста.
   *
   * Хост выбирает транспорт в шаге `import` (детерминированно):
   * - `mode: 'inline'` → `inline`;
   * - `mode: 'remote'` → `remote`;
   * - `mode: 'both'` → `inline`, если в бандле есть `dist/index.js`, иначе `remote`;
   * - режим не задан → `inline`;
   * - `descriptor.remote` (явный url+token) → `remote` приоритетнее режима.
   *
   * Не задан нужный загрузчик → шаг `import` завершается
   * `plugin.loader_unavailable` с пояснением, какой транспорт требуется.
   */
  loaders?: { inline?: PluginLoader; remote?: PluginLoader };
  /**
   * Ф3а: реестр провайдеров блоков системного промпта (точка `promptBlocks`).
   *
   * Не задан — точка `promptBlocks` плагину недоступна (регистрация
   * возвращает no-op disposer с предупреждением в лог).
   */
  promptBlocks?: PromptBlockRegistry;
  /**
   * Ф3б: реестр фильтров LLM-вызовов (точка `llmFilters`).
   *
   * Тот же экземпляр, что получает `GatewayProvider`
   * (`orchestrator.getLlmFilters()`): плагин регистрирует фильтр через фасад,
   * gateway применяет его в своей фазе. Не задан — точка `llmFilters` плагину
   * недоступна (регистрация возвращает no-op disposer с предупреждением в
   * лог, активация не падает).
   */
  llmFilters?: LlmFilterRegistry;
  /**
   * Ф3в: общий реестр инструментов (точка `tools`).
   *
   * Тот же экземпляр, что получает оркестратор (`Orchestrator`/
   * `PermissionEvaluator`): плагин регистрирует тул под namespace-именем
   * `plugin_<plugin>_<tool>`, доступность решает permission-слой. Не задан —
   * точка `tools` плагину недоступна (регистрация возвращает no-op disposer
   * с предупреждением в лог, активация не падает).
   */
  tools?: ToolRegistry;
  /**
   * Ф7 (PROP-090, Уровень 1 — cooperative): серверная политика плагинов в
   * гибридном режиме.
   *
   * Резолвер вызывается **перед активацией** плагина: серверная allow-list
   * (`plugins.hybrid` на сервере) — политика соответствия. Политика
   * `allowlist`, а плагина нет в списке → активация отклоняется с
   * `plugin.hybrid_not_allowed` (HTTP 403).
   *
   * Политика **неизвестна** (сервера нет, он недоступен или старый — без
   * сигнала) → плагин работает (cooperative), а в API/UI помечается
   * «не проверен сервером» (`serverPolicy: 'unverified'`).
   *
   * Не задан — политика сервера не проверяется (standalone, тесты).
   */
  serverPolicy?: () => PluginServerPolicy | undefined | Promise<PluginServerPolicy | undefined>;
  /** Логгер (по умолчанию — `console.warn`). */
  logger?: PluginLogger;
}

/**
 * Загрузчик плагинов: активация по пайплайну, реестр активных плагинов и
 * обратная прокрутка disposers.
 */
export class PluginHost {
  private readonly _audit: PluginAuditRepository;
  private readonly _config: PluginsConfig;
  private readonly _hostVersion: string;
  private readonly _contractVersion: string;
  private readonly _scan: PluginScanHook | undefined;
  /**
   * Встроенный сканер (Ф2) — используется, когда явный хук не задан.
   * Создаётся лениво (в конструкторе), чтобы не поднимать кэш сканов, если
   * скан выключен политикой.
   */
  private readonly _builtinScan: PluginScanHook;
  private readonly _inlineLoader: PluginLoader | undefined;
  /** Ф4б-2: загрузчик `out-of-process` (поднимает процесс или работает с `descriptor.remote`). */
  private readonly _remoteLoader: PluginLoader | undefined;
  /** Ф3а: реестр провайдеров блоков системного промпта (точка `promptBlocks`). */
  private readonly _promptBlocks: PromptBlockRegistry | undefined;
  /** Ф3б: реестр фильтров LLM-вызовов (точка `llmFilters`). */
  private readonly _llmFilters: LlmFilterRegistry | undefined;
  /** Ф3в: общий реестр инструментов (точка `tools`). */
  private readonly _tools: ToolRegistry | undefined;
  /** Ф7: резолвер серверной политики плагинов (гибрид; Уровень 1 — cooperative). */
  private readonly _serverPolicy: PluginHostOptions['serverPolicy'];
  private readonly _logger: PluginLogger;
  /** Реестр активных плагинов: имя → дескриптор активации. */
  private readonly _activations = new Map<string, PluginActivationHandle>();
  /** Явный список точных исключений семвер-гейта (из опций; `undefined` — читать из файла). */
  private readonly _explicitExceptions: readonly string[] | undefined;
  /** Кэш списка точных исключений (ленивый, один на инстанс). */
  private _exactHostExceptions: string[] | null = null;

  constructor(options: PluginHostOptions) {
    this._audit = options.audit;
    this._config = options.config;
    this._hostVersion = options.hostVersion;
    this._contractVersion = options.contractVersion ?? DEFAULT_EXTENSION_CONTRACT_VERSION;
    this._scan = options.scan;
    this._builtinScan = createPluginScanHook({
      ...(options.dictionaryStore ? { dictionaryStore: options.dictionaryStore } : {}),
    });
    this._inlineLoader = options.loaders?.inline ?? options.loader;
    this._remoteLoader = options.loaders?.remote;
    this._promptBlocks = options.promptBlocks;
    this._llmFilters = options.llmFilters;
    this._tools = options.tools;
    this._serverPolicy = options.serverPolicy;
    this._explicitExceptions = options.exactHostExceptions;
    this._logger = options.logger ?? {
      warn: (message: string) => {
        console.warn(`[plugin-host] ${message}`);
      },
    };
  }

  // ── Реестр активаций ────────────────────────────────────────────────

  /** Все активные плагины (детерминированный порядок — по имени). */
  listActivations(): PluginActivationHandle[] {
    return [...this._activations.values()].sort((a, b) => a.plugin.localeCompare(b.plugin));
  }

  /** Дескриптор активной активации плагина (`undefined` — не активен). */
  getActivation(plugin: string): PluginActivationHandle | undefined {
    return this._activations.get(plugin);
  }

  /** Активен ли плагин. */
  isActive(plugin: string): boolean {
    return this._activations.has(plugin);
  }

  /**
   * Зарегистрировать disposer для **активного** плагина.
   *
   * Точка расширения для Ф3: точки расширения (тулы/хуки/блоки промпта/
   * фильтры LLM) регистрируют свои вклады и возвращают disposer'ы. Плагин не
   * активен — `false` (disposer некуда положить).
   */
  registerDisposer(plugin: string, disposer: PluginDisposer): boolean {
    const handle = this._activations.get(plugin);
    if (!handle) return false;
    handle.disposers.push(disposer);
    return true;
  }

  // ── Активация ───────────────────────────────────────────────────────

  /**
   * Активировать плагин: прогнать пайплайн и (при успехе) зарегистрировать
   * активацию в реестре.
   *
   * Отказ на любом шаге пишется в журнал аудита (`outcome: 'rejected'` с кодом
   * причины) и возвращается вызывающему — исключений шаги не бросают.
   */
  async activate(
    descriptor: PluginActivationDescriptor | null | undefined,
    opts?: { actor?: string },
  ): Promise<PluginActivationResult> {
    const plugin = descriptor?.name ?? '';
    const version = descriptor?.version ?? '';

    const failure = async (
      step: PluginActivationStep,
      reason: PluginAuditReason,
      message: string,
    ): Promise<PluginActivationResult> => {
      await this._writeAudit({
        action: 'activate',
        plugin,
        version,
        outcome: 'rejected',
        reason,
        descriptor,
        actor: opts?.actor,
      });
      return { outcome: 'rejected', plugin, version, step, reason, message };
    };

    // ── Шаг 1: resolve ────────────────────────────────────────────────
    const resolved = this._resolve(descriptor);
    if (!resolved.ok) {
      return failure(resolved.step, resolved.reason, resolved.message);
    }
    const ready = resolved.descriptor;

    // Повторная активация активного плагина — осмысленный отказ.
    if (this._activations.has(ready.name)) {
      return failure(
        'resolve',
        'plugin.already_active',
        `Плагин «${ready.name}» уже активен — сначала деактивируйте его (deactivate → activate).`,
      );
    }

    // ── Шаг 2: integrity ──────────────────────────────────────────────
    const integrity = verifyPluginIntegrity(ready);
    if (!integrity.ok) {
      return failure('integrity', integrity.code, integrity.message);
    }

    // ── Шаг 3: semver-гейт ────────────────────────────────────────────
    const semver = await this._checkSemver(ready);
    if (!semver.ok) {
      return failure('semver', semver.reason, semver.message);
    }

    // ── Шаг 4: trust/scan ─────────────────────────────────────────────
    const trust = await this._checkTrust(ready);
    if (!trust.ok) {
      return failure('trust', trust.reason, trust.message);
    }

    // ── Шаг 5: политика режима ────────────────────────────────────────
    const policy = await this._checkPolicy(ready);
    if (!policy.ok) {
      return failure('policy', policy.reason, policy.message);
    }

    // ── Шаг 6: import ─────────────────────────────────────────────────
    // Исполнение кода выключено политикой — шаг обязан явно остановиться.
    if (!this._config.executionEnabled) {
      return failure(
        'import',
        'plugin.execution_disabled',
        'Исполнение кода плагинов выключено (plugins.executionEnabled=false) — загрузчик остановлен на шаге import.',
      );
    }
    const selected = await this._selectLoader(ready);
    if (!selected.ok) {
      return failure('import', 'plugin.loader_unavailable', selected.message);
    }

    // ── Шаг 7: facade + шаг 8: сбор disposers ─────────────────────────
    const handle: PluginActivationHandle = {
      plugin: ready.name,
      version: ready.version,
      activatedAt: new Date().toISOString(),
      trustLevel: ready.trustLevel,
      ...(integrity.actual ? { contentHash: integrity.actual } : {}),
      ...(ready.manifest.mode ? { mode: ready.manifest.mode } : {}),
      disposers: [],
    };
    /**
     * Фактические регистрации вкладов (**только успешные**) — для сверки с
     * `provides` манифеста (`diffPackProvides`, PROP-090 §«Правило
     * соответствия»). Отклонённая регистрация сюда не попадает: иначе отказ
     * точки (например, тир `stable`) выглядел бы как «зарегистрировано».
     */
    const registeredPromptBlocks: string[] = [];
    const registeredLlmFilters: string[] = [];
    const registeredTools: string[] = [];
    const facade: PluginFacade = {
      registerDisposer: (disposer: PluginDisposer) => {
        handle.disposers.push(disposer);
      },
      // Ф3а: точка `promptBlocks` — регистрация провайдера блока системного
      // промпта. Отказ (например, тир `stable`) **не роняет** остальные точки
      // расширения плагина: фиксируется предупреждением, возвращается no-op
      // disposer (PROP-090, критерии приёмки точки `promptBlocks`).
      registerPromptBlock: (provider, opts) => {
        if (!this._promptBlocks) {
          this._logger.warn(
            `точка promptBlocks недоступна хосту — плагин «${handle.plugin}» не зарегистрировал блок «${provider?.key ?? '?'}».`,
          );
          return () => undefined;
        }
        try {
          const disposer = this._promptBlocks.register(provider, {
            provenance: `plugin:${handle.plugin}`,
            ...(opts?.title ? { title: opts.title } : {}),
          });
          handle.disposers.push(disposer);
          registeredPromptBlocks.push(provider.key);
          return disposer;
        } catch (err) {
          this._logger.warn(
            `регистрация блока промпта «${provider?.key ?? '?'}» отклонена: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          return () => undefined;
        }
      },
      // Ф3б: точка `llmFilters` — регистрация фильтра LLM-вызовов. Владелец
      // (имя/версия/доверие) подставляет хост: заявленный в манифесте trust
      // не поднимает фактический, право вето даёт только trust ≥ `trusted`.
      // Отказ регистрации — предупреждение + no-op disposer (активация не
      // падает), как у точки `promptBlocks`.
      registerLlmFilter: (filter, filterOpts) => {
        if (!this._llmFilters) {
          this._logger.warn(
            `точка llmFilters недоступна хосту — плагин «${handle.plugin}» не зарегистрировал фильтр «${filter?.id ?? '?'}».`,
          );
          return () => undefined;
        }
        try {
          const disposer = this._llmFilters.register(filter, {
            trustLevel: handle.trustLevel,
            pluginName: handle.plugin,
            pluginVersion: handle.version,
            // Журнал плагинов — только канонические коды (`denied`/
            // `deny_downgraded`/`unavailable`): gateway зовёт колбэк лишь для
            // них, перечень `PLUGIN_AUDIT_REASONS` не расширяется кодами хоста.
            onAudit: (event: LlmFilterAuditEvent) => this._writeFilterAudit(handle, event),
            ...(filterOpts?.failMode ? { failMode: filterOpts.failMode } : {}),
            ...(filterOpts?.timeoutMs !== undefined ? { timeoutMs: filterOpts.timeoutMs } : {}),
          });
          handle.disposers.push(disposer);
          registeredLlmFilters.push(filter.id);
          return disposer;
        } catch (err) {
          this._logger.warn(
            `регистрация фильтра LLM-вызовов «${filter?.id ?? '?'}» отклонена: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          return () => undefined;
        }
      },
      // Ф3в: точка `tools` — регистрация инструмента в общем `ToolRegistry`.
      // Имя с namespace составляет хост (`plugin_<plugin>_<tool>`), коллизия с
      // builtin/MCP — отказ; capability `runtime` неотключаема админом, `mcp`
      // зарезервирована (валидация в реестре). Отказ — предупреждение +
      // no-op disposer (активация не падает), как у прочих точек.
      registerTool: (def) => {
        if (!this._tools) {
          this._logger.warn(
            `точка tools недоступна хосту — плагин «${handle.plugin}» не зарегистрировал тул «${def?.name ?? '?'}».`,
          );
          return () => undefined;
        }
        const registered = this._tools.registerPlugin(
          {
            name: def.name,
            description: def.description,
            parameters: def.parameters,
            capabilities: def.capabilities,
            execute: def.execute,
            ...(def.jsonSchema ? { jsonSchema: def.jsonSchema } : {}),
          },
          handle.plugin,
        );
        if (!registered.ok) {
          this._logger.warn(`регистрация тула плагина отклонена: ${registered.message}`);
          return () => undefined;
        }
        const fullName = registered.name;
        let removed = false;
        const disposer = (): void => {
          if (removed) return;
          removed = true;
          this._tools?.deregister(fullName);
        };
        handle.disposers.push(disposer);
        // В сверку `provides.tools[]` идёт **локальное** имя: namespace-префикс —
        // деталь реестра, а не контракта манифеста.
        const local = pluginToolLocalName(fullName, handle.plugin);
        if (local) registeredTools.push(local);
        return disposer;
      },
    };

    let module;
    try {
      module = await selected.loader(ready);
    } catch (err) {
      // Причина берётся из `PluginLoadError` (Ф4а): «код загружен, но не
      // выполнил контракт» (`plugin.module_invalid`) — не то же самое, что
      // «загрузчик недоступен/сломался» (`plugin.loader_unavailable`).
      const reason = pluginLoadFailureReason(err);
      const detail = err instanceof Error ? err.message : String(err);
      return failure(
        'import',
        reason,
        reason === 'plugin.module_invalid'
          ? detail
          : `Загрузчик кода плагина завершился ошибкой: ${detail}`,
      );
    }
    try {
      await module.apply?.(facade);
    } catch (err) {
      // Ошибка `apply()` — откатываем уже зарегистрированные вклады.
      await this._runDisposers(handle);
      return failure(
        'facade',
        'plugin.loader_unavailable',
        `Фасад плагина отверг регистрацию вкладов: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Шаг 8б: сверка `provides` с фактическими регистрациями ────────
    // PROP-090 §«Правило соответствия»: расхождение — **отказ активации**
    // (признак несогласованной сборки, а не «мелочь»). Сверяются все три точки,
    // реализованные в Ф3 (`promptBlocks`, `llmFilters`, `tools`). Тулы
    // сверяются по **локальным** именам: в манифесте объявляется имя без
    // namespace-префикса (`memory_search`), в реестре живёт
    // `plugin_<plugin>_memory_search`.
    const declared = ready.manifest.provides as PackProvides | undefined;
    const mismatches = diffPackProvides(
      {
        tools: declared?.tools ?? [],
        promptBlocks: declared?.promptBlocks ?? [],
        llmFilters: declared?.llmFilters ?? [],
      },
      {
        tools: registeredTools,
        promptBlocks: registeredPromptBlocks,
        llmFilters: registeredLlmFilters,
      },
    );
    if (mismatches.length > 0) {
      // Вклады уже зарегистрированы — откатываем, иначе отклонённый плагин
      // оставил бы после себя блоки/фильтры в живых реестрах.
      await this._runDisposers(handle);
      return failure(
        'facade',
        'plugin.provides_mismatch',
        `Расхождение provides и фактических регистраций плагина «${ready.name}»: ` +
        `${mismatches.map(describeProvidesMismatch).join('; ')} — активация отклонена.`,
      );
    }

    // ── Шаг 9: аудит ──────────────────────────────────────────────────
    this._activations.set(handle.plugin, handle);
    await this._writeAudit({
      action: 'activate',
      plugin: handle.plugin,
      version: handle.version,
      outcome: 'ok',
      descriptor: ready,
      actor: opts?.actor,
      contentHash: handle.contentHash,
      trustLevel: handle.trustLevel,
      mode: handle.mode,
    });

    return {
      outcome: 'activated',
      plugin: handle.plugin,
      version: handle.version,
      step: 'facade',
      activation: handle,
    };
  }

  /**
   * Деактивировать плагин: обратная прокрутка disposers **в обратном порядке**
   * регистрации, затем аудит.
   *
   * Ошибка одного disposer'а **не прерывает** остальные (изолируется и
   * логируется) — снятие вкладов не должно оставлять половину плагина.
   */
  async deactivate(
    plugin: string,
    opts?: { actor?: string },
  ): Promise<PluginDeactivationResult> {
    const handle = this._activations.get(plugin);
    if (!handle) {
      await this._writeAudit({
        action: 'deactivate',
        plugin,
        version: '',
        outcome: 'rejected',
        reason: 'plugin.not_active',
        actor: opts?.actor,
      });
      return {
        outcome: 'rejected',
        plugin,
        version: '',
        reason: 'plugin.not_active',
        message: `Плагин «${plugin}» не активен — деактивировать нечего.`,
        disposed: 0,
        failures: [],
      };
    }

    const { disposed, failures } = await this._runDisposers(handle);
    this._activations.delete(plugin);

    await this._writeAudit({
      action: 'deactivate',
      plugin: handle.plugin,
      version: handle.version,
      outcome: 'ok',
      reason: failures.length > 0 ? 'plugin.disposer_failed' : undefined,
      actor: opts?.actor,
      contentHash: handle.contentHash,
      trustLevel: handle.trustLevel,
      mode: handle.mode,
    });

    return {
      outcome: 'ok',
      plugin: handle.plugin,
      version: handle.version,
      disposed,
      failures,
    };
  }

  // ── Шаги пайплайна ──────────────────────────────────────────────────

  /** Шаг 1: resolve — дескриптор установлен и манифест корректен. */
  private _resolve(
    descriptor: PluginActivationDescriptor | null | undefined,
  ):
    | { ok: true; descriptor: PluginActivationDescriptor }
    | { ok: false; step: PluginActivationStep; reason: PluginAuditReason; message: string } {
    if (!descriptor || !descriptor.name || !descriptor.version || !descriptor.manifest) {
      return {
        ok: false,
        step: 'resolve',
        reason: 'plugin.not_found',
        message: 'Плагин не найден: дескриптор установки пуст или неполон.',
      };
    }
    const manifest: PackManifest = descriptor.manifest;
    if (manifest.kind !== 'plugin') {
      return {
        ok: false,
        step: 'resolve',
        reason: 'plugin.manifest_invalid',
        message: `Манифест «${descriptor.name}» имеет kind «${manifest.kind}» — активировать можно только kind: 'plugin'.`,
      };
    }
    if (manifest.name !== descriptor.name || manifest.version !== descriptor.version) {
      return {
        ok: false,
        step: 'resolve',
        reason: 'plugin.manifest_invalid',
        message:
          'Дескриптор установки расходится с манифестом (имя/версия) — активация отклонена.',
      };
    }
    return { ok: true, descriptor };
  }

  /** Шаг 3: semver-гейт — `contracts` и `host` против версий хоста. */
  private async _checkSemver(
    descriptor: PluginActivationDescriptor,
  ): Promise<{ ok: true } | { ok: false; reason: PluginAuditReason; message: string }> {
    const manifest = descriptor.manifest;
    const verdict = checkExtensionCompatibility({
      contracts: manifest.contracts,
      host: manifest.host,
      hostVersion: this._hostVersion,
      contractVersion: this._contractVersion,
      contractName: DEFAULT_EXTENSION_CONTRACT,
      exactHostExceptions: await this._resolveExactHostExceptions(),
    });
    if (verdict.ok) return { ok: true };

    if (verdict.reason === 'contract_mismatch') {
      return {
        ok: false,
        reason: 'plugin.contract_mismatch',
        message:
          `Контракт расширения несовместим: требуется «${verdict.expected ?? '?'}», ` +
          `хост предоставляет «${verdict.actual ?? '?'}».`,
      };
    }
    return {
      ok: false,
      reason: 'plugin.host_mismatch',
      message:
        `Версия Synth несовместима с плагином: требуется «${verdict.expected ?? '?'}», ` +
        `установлено «${verdict.actual ?? this._hostVersion}».`,
    };
  }

  /**
   * Шаг 4: trust/scan.
   *
   * Порядок (**важно**):
   * 1. **trust-floor** (`plugins.trustFloor`) — ниже порога плагин не
   *    активируется **в любом случае** (`plugin.trust_below_floor`);
   * 2. **скан** — вердикт статического сканера (встроенный или подключённый
   *    хук); при `dangerous` → `plugin.scan_rejected`;
   * 3. **install-policy** (PROP-068 §4.2 + ячейка `kind: plugin`) — для
   *    плагина `caution` → `ask` (явное подтверждение владельца), а не блок:
   *    `plugin.approval_required`.
   *
   * Скан выключен политикой (`plugins.scan: 'disabled'`) — это **не** ошибка:
   * вердикт по умолчанию `safe`, а в журнале аудита видно, что скана не было
   * (`scanPerformed: false`). **Исключение:** если при этом включено
   * исполнение кода (`plugins.executionEnabled=true`) — активация
   * отклоняется (fail-closed, `plugin.scan_disabled_with_execution`).
   */
  private async _checkTrust(
    descriptor: PluginActivationDescriptor,
  ): Promise<{ ok: true } | { ok: false; reason: PluginAuditReason; message: string }> {
    // Решение владельца (Ф3а, 2026-10-22): исполняемый код обязан быть
    // просканирован. `plugins.scan='disabled'` вместе с
    // `plugins.executionEnabled=true` — **fail-closed**: активация отклоняется
    // (без скана нельзя допускать исполнение кода). Проверка — до скана,
    // чтобы в журнале не оставалось записи «скан выполнен, вердикт safe».
    if (this._config.scan === 'disabled' && this._config.executionEnabled) {
      return {
        ok: false,
        reason: 'plugin.scan_disabled_with_execution',
        message:
          'Сканирование расширений выключено (plugins.scan=disabled), а исполнение кода ' +
          'плагинов включено (plugins.executionEnabled=true) — активация отклонена: ' +
          'исполняемый код обязан быть просканирован.',
      };
    }

    const floor = this._config.trustFloor;
    // Неизвестное доверие — fail-closed: считаем `community` (ниже порога).
    const level: CatalogTrustLevel = descriptor.trustLevel ?? 'community';
    // `trustLevelRank`: меньше — довереннее (`builtin` = 0). Ниже порога ⇒ rank больше.
    if (trustLevelRank(level) > trustLevelRank(floor)) {
      return {
        ok: false,
        reason: 'plugin.trust_below_floor',
        message:
          `Уровень доверия плагина «${level}» ниже trust-floor инстанса «${floor}» — ` +
          'плагин может быть установлен, но не активирован.',
      };
    }

    // Сканер (встроенный или подключённый хук).
    const scan = await this._runScan(descriptor, level);
    if (!scan.ok) return scan;

    // Install-policy: ячейка `kind: plugin` (PROP-090 §9).
    const action = installPolicyDecision({
      trust: level,
      verdict: scan.verdict,
      kind: 'plugin',
    });
    if (action === 'block') {
      return {
        ok: false,
        reason: 'plugin.scan_rejected',
        message:
          `Install-policy: вердикт сканера «${scan.verdict}» для плагина — ` +
          'установка/активация заблокированы.',
      };
    }
    if (action === 'ask') {
      return {
        ok: false,
        reason: 'plugin.approval_required',
        message:
          `Install-policy: вердикт сканера «${scan.verdict}» для плагина — ` +
          'требуется явное подтверждение владельца (решение не принято автоматически).',
      };
    }
    return { ok: true };
  }

  /**
   * Прогон сканера + запись события аудита `scan`.
   *
   * Скан выключен политикой — вердикт `safe` по умолчанию, но событие аудита
   * всё равно пишется: по журналу видно, что скана **не было**.
   */
  private async _runScan(
    descriptor: PluginActivationDescriptor,
    trustLevel: CatalogTrustLevel,
  ): Promise<
    | { ok: true; verdict: PluginScanVerdict; performed: boolean }
    | { ok: false; reason: PluginAuditReason; message: string }
  > {
    const plugin = descriptor.name;
    const version = descriptor.version;

    if (this._config.scan === 'disabled') {
      await this._writeAudit({
        action: 'scan',
        plugin,
        version,
        outcome: 'ok',
        scanVerdict: 'safe',
        scanPerformed: false,
        scanFindings: 0,
        trustLevel,
        descriptor,
      });
      return { ok: true, verdict: 'safe', performed: false };
    }

    const hook = this._scan ?? this._builtinScan;
    let result;
    try {
      result = await hook(descriptor);
    } catch (err) {
      // Сбой сканера — fail-closed: активация не выполняется.
      return {
        ok: false,
        reason: 'plugin.scan_rejected',
        message: `Сканер завершился ошибкой: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const performed = result.performed !== false;
    const findings = result.findings?.length ?? 0;
    const rejected =
      result.verdict === 'dangerous' || result.verdict === 'caution';
    await this._writeAudit({
      action: 'scan',
      plugin,
      version,
      outcome: rejected ? 'rejected' : 'ok',
      reason: rejected
        ? result.verdict === 'dangerous'
          ? 'plugin.scan_rejected'
          : 'plugin.approval_required'
        : undefined,
      scanVerdict: result.verdict,
      scanPerformed: performed,
      scanFindings: findings,
      trustLevel,
      descriptor,
      ...(result.contentHash ? { contentHash: result.contentHash } : {}),
    });

    if (result.verdict === 'dangerous') {
      return {
        ok: false,
        reason: 'plugin.scan_rejected',
        message:
          `Сканер отклонил плагин (вердикт «dangerous», находок: ${findings})` +
          (result.reason ? `: ${result.reason}` : '.'),
      };
    }
    return { ok: true, verdict: result.verdict, performed };
  }

  /** Шаг 5: политика режима — мастер-выключатель, списки имён, runtime-install. */
  private async _checkPolicy(
    descriptor: PluginActivationDescriptor,
  ): Promise<{ ok: true } | { ok: false; reason: PluginAuditReason; message: string }> {
    if (!this._config.enabled) {
      return {
        ok: false,
        reason: 'plugin.disabled',
        message: 'Слой плагинов выключен (plugins.enabled=false) — активация запрещена.',
      };
    }
    if (this._config.denylist.includes(descriptor.name)) {
      return {
        ok: false,
        reason: 'plugin.denylisted',
        message: `Плагин «${descriptor.name}» входит в plugins.denylist — активация запрещена.`,
      };
    }
    if (this._config.allowlist.length > 0 && !this._config.allowlist.includes(descriptor.name)) {
      return {
        ok: false,
        reason: 'plugin.not_allowlisted',
        message:
          `Плагин «${descriptor.name}» не входит в plugins.allowlist — активация запрещена.`,
      };
    }
    // Ф7 (Уровень 1 — cooperative): серверная allow-list в гибриде. Проверка
    // идёт **после** локальной политики имён и **до** runtime-install: сервер —
    // внешний источник запрета, его решение приоритетнее локального.
    // Политика неизвестна (сервера нет/недоступен/старый) — проверка не
    // применяется: плагин работает, но помечается «не проверен сервером».
    const serverPolicy = await this._resolveServerPolicy();
    if (serverPolicy && evaluatePluginServerPolicy(serverPolicy, descriptor.name) === 'denied') {
      return {
        ok: false,
        reason: 'plugin.hybrid_not_allowed',
        message:
          `Плагин «${descriptor.name}» не разрешён серверной политикой гибрида ` +
          '(plugins.hybrid.mode=allowlist) — активация отклонена.',
      };
    }
    if (descriptor.installKind === 'runtime' && this._config.runtimeInstall === 'deny') {
      return {
        ok: false,
        reason: 'plugin.runtime_install_denied',
        message:
          'Установка плагинов во время работы инстанса запрещена ' +
          '(plugins.runtimeInstall=deny) — активация не выполняется.',
      };
    }
    return { ok: true };
  }

  /**
   * Текущая серверная политика плагинов (Ф7): `undefined` — сервера нет,
   * он недоступен или политика неизвестна (cooperative).
   *
   * Резолвер не бросает: сбой опроса сервера — «политика неизвестна», а не
   * отказ активации (Уровень 1 — политика соответствия, не запрет).
   */
  private async _resolveServerPolicy(): Promise<PluginServerPolicy | undefined> {
    if (!this._serverPolicy) return undefined;
    try {
      return await this._serverPolicy();
    } catch (err) {
      this._logger.warn(
        `не удалось получить серверную политику плагинов — активация не проверяется сервером: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Статус проверки плагина сервером (Ф7) — для API/UI: маркер
   * «не проверен сервером» (cooperative) либо «запрещён сервером».
   */
  async serverPolicyStatus(plugin: string): Promise<PluginServerPolicyStatus> {
    const policy = await this._resolveServerPolicy();
    return evaluatePluginServerPolicy(policy, plugin);
  }

  /**
   * Запись события в журнал аудита плагинов извне (Ф7 — выдача
   * server-scoped токена плагину, действие `token`).
   *
   * Секрет токена в журнал не пишется (инвариант 13) — только имя плагина и
   * факт выдачи.
   */
  async recordTokenIssued(input: {
    plugin: string;
    version?: string;
    actor?: string;
  }): Promise<void> {
    await this._writeAudit({
      action: 'token',
      plugin: input.plugin,
      version: input.version ?? '',
      outcome: 'ok',
      ...(input.actor ? { actor: input.actor } : {}),
    });
  }

  // ── Вспомогательное ────────────────────────────────────────────────

  /**
   * Выбрать загрузчик по режиму исполнения (Ф4б-2, «детерминированный выбор
   * хоста»).
   *
   * Приоритет: явный `descriptor.remote` (уже запущенный процесс) → `mode`
   * манифеста. Для `both` inline выбирается ровно тогда, когда в бандле есть
   * `dist/index.js` (на диске `rootDir` или в переданных `files`): иначе
   * inline-загрузчик гарантированно отказал бы, поэтому берётся remote.
   * Режим не задан — дефолт манифеста `inline`.
   */
  private async _selectLoader(
    descriptor: PluginActivationDescriptor,
  ): Promise<
    | { ok: true; loader: PluginLoader; transport: 'inline' | 'remote' }
    | { ok: false; message: string }
  > {
    const inlineLoader = this._inlineLoader;
    const remoteLoader = this._remoteLoader;

    if (descriptor.remote) {
      return remoteLoader
        ? { ok: true, loader: remoteLoader, transport: 'remote' }
        : {
            ok: false,
            message:
              `Плагин «${descriptor.name}»: в дескрипторе задан удалённый процесс ` +
              '(descriptor.remote), но загрузчик out-of-process не подключён ' +
              '(PluginHostOptions.loaders.remote) — шаг import остановлен.',
          };
    }

    const mode = descriptor.manifest.mode ?? 'inline';
    if (mode === 'inline') {
      return inlineLoader
        ? { ok: true, loader: inlineLoader, transport: 'inline' }
        : {
            ok: false,
            message:
              `Плагин «${descriptor.name}»: режим inline, но inline-загрузчик не подключён ` +
              '(PluginHostOptions.loader/loaders.inline) — шаг import остановлен.',
          };
    }
    if (mode === 'remote') {
      return remoteLoader
        ? { ok: true, loader: remoteLoader, transport: 'remote' }
        : {
            ok: false,
            message:
              `Плагин «${descriptor.name}»: режим remote, но загрузчик out-of-process не ` +
              'подключён (PluginHostOptions.loaders.remote) — шаг import остановлен.',
          };
    }

    // mode === 'both': inline — только при наличии dist/index.js в бандле.
    const preferInline = await hasInlineBundle(descriptor);
    const preferred = preferInline ? inlineLoader : remoteLoader;
    if (preferred) {
      return {
        ok: true,
        loader: preferred,
        transport: preferInline ? 'inline' : 'remote',
      };
    }
    // Предпочтительного загрузчика нет — берём второй, если он есть (иначе
    // установка «both» без файла dist/index.js не активировалась бы вовсе).
    const fallback = preferInline ? remoteLoader : inlineLoader;
    if (fallback) {
      return {
        ok: true,
        loader: fallback,
        transport: preferInline ? 'remote' : 'inline',
      };
    }
    return {
      ok: false,
      message:
        `Плагин «${descriptor.name}»: режим both, но ни один загрузчик не подключён ` +
        '(PluginHostOptions.loader/loaders) — шаг import остановлен.',
    };
  }

  /**
   * Список точных исключений семвер-гейта: явный список из опций перекрывает
   * файл конфига; файл читается один раз и кэшируется.
   */
  private async _resolveExactHostExceptions(): Promise<string[]> {
    if (this._explicitExceptions !== undefined) return [...this._explicitExceptions];
    if (this._exactHostExceptions === null) {
      this._exactHostExceptions = await readExactHostExceptions(this._config.exactHostExceptions);
    }
    return this._exactHostExceptions;
  }

  /**
   * Обратная прокрутка disposers: **обратный порядок** регистрации, ошибка
   * одного не прерывает остальные (изолируется и логируется).
   */
  private async _runDisposers(handle: PluginActivationHandle): Promise<{
    disposed: number;
    failures: Array<{ error: string }>;
  }> {
    const failures: Array<{ error: string }> = [];
    let disposed = 0;
    for (const disposer of [...handle.disposers].reverse()) {
      try {
        await disposer();
        disposed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ error: message });
        this._logger.warn(
          `disposer плагина «${handle.plugin}» завершился ошибкой (${message}) — остальные disposer'ы выполняются.`,
        );
      }
    }
    return { disposed, failures };
  }

  /**
   * Запись решения фильтра в журнал плагинов (Ф3б, действие `filter`).
   *
   * Пишется только канонический код причины (`plugin_filter.denied`/
   * `plugin_filter.deny_downgraded`/`plugin_filter.unavailable`) и итог
   * операции: вердикт после понижения `deny` ⇒ вызов заблокирован
   * (`outcome: 'rejected'`), иначе `ok`. Идентификатор фильтра и фаза остаются
   * в аудите gateway (`filterId`/`filterPhase`); текст запроса/ответа не
   * пишется ни там, ни здесь (инвариант 13).
   */
  private async _writeFilterAudit(
    handle: PluginActivationHandle,
    event: LlmFilterAuditEvent,
  ): Promise<void> {
    const reason = FILTER_JOURNAL_REASONS.get(event.code ?? '');
    await this._writeAudit({
      action: 'filter',
      plugin: handle.plugin,
      version: handle.version,
      outcome: event.effectiveVerdict === 'deny' ? 'rejected' : 'ok',
      ...(reason ? { reason } : {}),
      trustLevel: handle.trustLevel,
    });
  }

  /**
   * Запись в журнал аудита плагинов (best-effort: сбой записи не ломает
   * активацию — предупреждение в лог, как в аудите обслуживания, ADR-092).
   */
  private async _writeAudit(input: {
    action: PluginAuditAction;
    plugin: string;
    version: string;
    outcome: 'ok' | 'rejected';
    reason?: PluginAuditReason;
    descriptor?: PluginActivationDescriptor | null;
    actor?: string;
    contentHash?: string;
    trustLevel?: CatalogTrustLevel;
    mode?: PluginActivationHandle['mode'];
    scanVerdict?: PluginScanVerdict;
    scanPerformed?: boolean;
    scanFindings?: number;
  }): Promise<void> {
    const descriptor = input.descriptor ?? undefined;
    const entry: PluginAuditEntry = {
      id: `pa_${generateId()}`,
      ts: new Date().toISOString(),
      actor: input.actor ?? descriptor?.actor ?? 'system',
      scope: 'plugin',
      action: input.action,
      plugin: input.plugin,
      version: input.version,
      outcome: input.outcome,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.trustLevel ?? descriptor?.trustLevel
        ? { trustLevel: input.trustLevel ?? descriptor?.trustLevel }
        : {}),
      ...(input.scanVerdict ? { scanVerdict: input.scanVerdict } : {}),
      ...(input.scanPerformed !== undefined ? { scanPerformed: input.scanPerformed } : {}),
      ...(input.scanFindings !== undefined ? { scanFindings: input.scanFindings } : {}),
      ...(input.contentHash ?? descriptor?.contentHash
        ? { contentHash: input.contentHash ?? descriptor?.contentHash }
        : {}),
      ...(input.mode ?? descriptor?.manifest.mode
        ? { mode: input.mode ?? descriptor?.manifest.mode }
        : {}),
      ...(descriptor?.source ? { source: descriptor.source } : {}),
    };
    try {
      await this._audit.append(entry);
    } catch (err) {
      this._logger.warn(
        `не удалось записать событие аудита плагинов (${input.action}/${input.plugin}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Есть ли в бандле точка входа inline (`dist/index.js`).
 *
 * Сначала — состав файлов дескриптора (активация из установки/старта), затем
 * каталог `rootDir` (если дескриптор без `files`). Ошибки чтения — `false`.
 */
async function hasInlineBundle(descriptor: PluginActivationDescriptor): Promise<boolean> {
  if (descriptor.files && DEFAULT_PLUGIN_ENTRY in descriptor.files) return true;
  if (!descriptor.rootDir) return false;
  try {
    return (await stat(join(descriptor.rootDir, DEFAULT_PLUGIN_ENTRY))).isFile();
  } catch {
    return false;
  }
}
