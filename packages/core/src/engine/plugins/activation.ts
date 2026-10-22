/**
 * PROP-090 §10: контракты загрузчика плагинов (`PluginHost`).
 *
 * Ф1 — каркас: описанные здесь типы закрывают пайплайн активации (resolve →
 * integrity → semver-гейт → trust/scan → политика режима → import → facade),
 * реестр активаций и модель disposers. Исполнение кода в Ф1 **выключено**:
 * `plugins.executionEnabled` по умолчанию `false`, а загрузчик (`PluginLoader`)
 * в core не реализован — это точка расширения Ф3 (`inline`) / Ф4
 * (`out-of-process`).
 */
import type {
  CatalogTrustLevel,
  LlmCallFilter,
  LlmFilterFailMode,
  PackManifest,
  PackPluginMode,
  PluginAuditReason,
  PluginScanFinding,
  PluginScanVerdict,
  PromptBlockProvider,
} from '@itphx/synth-shared';

/**
 * Шаги пайплайна активации плагина (PROP-090 §10, шаги 1–8).
 *
 * Порядок фиксирован и **одинаков** для всех реализаций: отказ на раннем
 * шаге не даёт дойти до later-гейтов (например, до `import`).
 */
export const PLUGIN_ACTIVATION_STEPS = [
  'resolve',
  'integrity',
  'semver',
  'trust',
  'policy',
  'import',
  'facade',
] as const;
export type PluginActivationStep = (typeof PLUGIN_ACTIVATION_STEPS)[number];

/**
 * Disposer — обратная операция регистрации вклада плагина (снять блок/
 * фильтр/тул/хук). Выполняется при деактивации **в обратном порядке**
 * регистрации; ошибка одного disposer'а не прерывает остальные.
 */
export type PluginDisposer = () => void | Promise<void>;

/**
 * Дескриптор плагина, подготовленного к активации.
 *
 * В Ф1 источник — переданный дескриптор установки (полноценная установка,
 * карантин и `plugins.lock.json` — Ф2/Ф5).
 */
export interface PluginActivationDescriptor {
  /** Имя плагина (совпадает с `manifest.name`). */
  name: string;
  /** Версия плагина (совпадает с `manifest.version`). */
  version: string;
  /** Разобранный манифест `synth.pack` (`kind: 'plugin'`). */
  manifest: PackManifest;
  /** Файлы бандла (относительный путь → содержимое) — источник content-hash. */
  files?: Record<string, string>;
  /**
   * Каталог **распакованного** бандла (PROP-090 §5: `installed/<name>@<version>/`).
   *
   * Задан — сканер обходит каталог (файлы, бинарники, `.skillignore`); не
   * задан — сканируется `files` (бандл в памяти).
   */
  rootDir?: string;
  /**
   * Ожидаемый content-hash (из `plugins.lock.json`/`PLUGIN_INTEGRITY.json`).
   * Не задан — сверять нечего (шаг integrity пропускается).
   */
  contentHash?: string;
  /**
   * Фактический уровень доверия (резолвится по источнику/реестру, не по
   * манифесту). Не задан — fail-closed: считается `community`.
   */
  trustLevel?: CatalogTrustLevel;
  /** Источник установки (`npm`/`local`/`catalog`/`builtin`/…). */
  source?: string;
  /**
   * URL/идентификатор источника — часть ключа кэша сканов
   * (`sha256(source\0source_url)` + `content_hash`, PROP-068 §4.3).
   */
  sourceUrl?: string;
  /**
   * Как попал в инстанс: `deploy` (deploy-time, бандл в образе/PVC) или
   * `runtime` (установка во время работы). На `runtime` при
   * `plugins.runtimeInstall=deny` активация запрещена.
   */
  installKind?: 'deploy' | 'runtime';
  /** Инициатор активации (`userId` при API/UI, `'cli'`, `'startup'`). */
  actor?: string;
}

/** Дескриптор состоявшейся активации (реестр активаций `PluginHost`). */
export interface PluginActivationHandle {
  /** Имя плагина. */
  plugin: string;
  /** Версия плагина. */
  version: string;
  /** Момент активации (ISO-8601). */
  activatedAt: string;
  /** Уровень доверия на момент активации. */
  trustLevel?: CatalogTrustLevel;
  /** Content-hash бандла, проверенный при активации. */
  contentHash?: string;
  /** Режим исполнения, объявленный манифестом. */
  mode?: PackPluginMode;
  /** Disposer'ы в порядке регистрации (деактивация — обратный порядок). */
  disposers: PluginDisposer[];
}

/** Итог активации плагина. */
export interface PluginActivationResult {
  /**
   * `activated` — плагин активен; `rejected` — активация не состоялась
   * (отказ по гейту или остановка на шаге `import`).
   */
  outcome: 'activated' | 'rejected';
  /** Имя плагина. */
  plugin: string;
  /** Версия плагина. */
  version: string;
  /** Шаг пайплайна, на котором завершилась активация. */
  step: PluginActivationStep;
  /** Машиночитаемый код отказа (при `outcome: 'rejected'`). */
  reason?: PluginAuditReason;
  /** Человекочитаемое сообщение (при `outcome: 'rejected'`). */
  message?: string;
  /** Дескриптор активной активации (при `outcome: 'activated'`). */
  activation?: PluginActivationHandle;
}

/** Итог деактивации плагина (обратная прокрутка disposers). */
export interface PluginDeactivationResult {
  /** `ok` — плагин снят; `rejected` — деактивировать было нечего. */
  outcome: 'ok' | 'rejected';
  /** Имя плагина. */
  plugin: string;
  /** Версия плагина (пустая — плагин не был активен). */
  version: string;
  /** Код отказа (при `outcome: 'rejected'`). */
  reason?: PluginAuditReason;
  /** Человекочитаемое сообщение. */
  message?: string;
  /** Сколько disposer'ов выполнено успешно. */
  disposed: number;
  /** Сбои disposer'ов (изолированы: остальные disposer'ы всё равно выполнены). */
  failures: Array<{ error: string }>;
}

/**
 * Фасад плагина (PROP-090 §10, шаг 7).
 *
 * Ф1: только сбор disposers. **Ф3а**: регистрация провайдера блока системного
 * промпта (точка `promptBlocks`) — с возвратом disposer'а, который снимает
 * блок при деактивации плагина. **Ф3б**: регистрация фильтра LLM-вызовов
 * (точка `llmFilters`) — с тем же контрактом disposer'а.
 */
export interface PluginFacade {
  /**
   * Зарегистрировать обратную операцию (disposer). Выполняется при
   * деактивации в обратном порядке регистрации.
   */
  registerDisposer(disposer: PluginDisposer): void;
  /**
   * Ф3а: зарегистрировать провайдера блока системного промпта (точка
   * `promptBlocks`).
   *
   * Провайдер с тиром `stable` **отклоняется** (граница prompt-cache,
   * ADR-070) — тихого понижения до `context` нет. Отказ фиксируется
   * предупреждением в лог хоста: остальные точки расширения плагина при этом
   * регистрируются (PROP-090, критерии приёмки точки `promptBlocks`).
   *
   * @returns disposer — снимает блок (идемпотентен). При отказе — no-op.
   */
  registerPromptBlock(
    provider: PromptBlockProvider,
    opts?: { title?: string },
  ): PluginDisposer;
  /**
   * Ф3б: зарегистрировать фильтр LLM-вызовов (точка `llmFilters`).
   *
   * Хост сам подставляет владельца регистрации: `pluginName`/`pluginVersion`
   * и **уровень доверия плагина** (фактический, из активации, — не из
   * манифеста). Право вето фильтр получает только при trust ≥ `trusted`:
   * `deny` фильтра недоверенного плагина хост понижает до `allow`
   * (PROP-090 §«Кто вправе блокировать»), факт уходит в журнал плагинов.
   *
   * Отказ регистрации (пустой/занятый идентификатор, неизвестная фаза,
   * недоступный реестр) **не роняет активацию**: предупреждение в лог хоста
   * и no-op disposer (как у точки `promptBlocks`).
   *
   * @returns disposer — снимает фильтр (идемпотентен). При отказе — no-op.
   */
  registerLlmFilter(filter: LlmCallFilter, opts?: PluginLlmFilterOptions): PluginDisposer;
}

/**
 * Опции регистрации фильтра от плагина: хост-политика поверх контракта
 * `LlmCallFilter` (сам фильтр тоже может задать `failMode`/`timeoutMs`).
 */
export interface PluginLlmFilterOptions {
  /** Переопределение режима отказа (`open`/`closed`). */
  failMode?: LlmFilterFailMode;
  /** Переопределение бюджета времени на вызов фильтра, мс. */
  timeoutMs?: number;
}

/**
 * Модуль плагина, подготовленный загрузчиком (Ф3: результат `import()` бандла).
 */
export interface PluginModule {
  /** Вызывается с фасадом — плагин регистрирует свои вклады. */
  apply?(facade: PluginFacade): void | Promise<void>;
}

/**
 * Загрузчик кода плагина — **точка расширения Ф3/Ф4**.
 *
 * В Ф1 загрузчика в core нет: `import()` чужого кода в ядре отсутствует, а
 * шаг `import` без загрузчика останавливается с `plugin.loader_unavailable`.
 */
export type PluginLoader = (descriptor: PluginActivationDescriptor) => Promise<PluginModule>;

/**
 * Вердикт сканера/проверки доверия (точка расширения Ф2).
 *
 * Заполняется сканером (`engine/plugins/scan/`): вердикт + находки + хеш
 * просканированного содержимого. Вердикт ≠ `safe` → отказ активации:
 * `dangerous` → `plugin.scan_rejected`, `caution` → `plugin.approval_required`
 * (install-policy, PROP-068 §4.2 / PROP-090 §9).
 */
export interface PluginScanResult {
  /** Вердикт скана (PROP-068 §4.3). */
  verdict: PluginScanVerdict;
  /** Причина отказа (человекочитаемая) — при вердикте не `safe`. */
  reason?: string;
  /**
   * Скан выполнен? `false` — скан выключен политикой (`plugins.scan=disabled`)
   * или сканировать было нечего; вердикт в этом случае по умолчанию `safe`,
   * но по журналу аудита видно, что скана не было.
   */
  performed?: boolean;
  /** Находки сканера (для UI/аудита). */
  findings?: PluginScanFinding[];
  /** Content-hash просканированного содержимого. */
  contentHash?: string;
  /** Число просканированных файлов. */
  scannedFiles?: number;
  /** Отчёт взят из кэша сканов? */
  cached?: boolean;
}

/**
 * Хук скана/проверки доверия — **точка расширения Ф2**.
 *
 * Дефолтная реализация — встроенный статический сканер
 * (`engine/plugins/scan/`, `createPluginScanHook`): вердикт выносится по
 * правилам `severity → verdict` (PROP-068 §4.3), решение — по матрице
 * install-policy (`installPolicyDecision`, `@itphx/synth-shared`).
 */
export type PluginScanHook = (descriptor: PluginActivationDescriptor) => Promise<PluginScanResult>;

/** Логгер загрузчика (по умолчанию — `console.warn`). */
export interface PluginLogger {
  warn(message: string): void;
}
