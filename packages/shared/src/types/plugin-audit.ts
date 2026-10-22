/**
 * PROP-090 §9: журнал аудита плагинов — **отдельный** тип и **отдельный** scope.
 *
 * Чем отличается от `SecurityAuditEntry` (`types/egress.ts`): security-аудит
 * фиксирует **изменение политики** (scope `tools|webhooks|mcp|proxy|tls`,
 * actions `update|reset`), а журнал плагинов — **жизненный цикл расширения**
 * (активация/деактивация) с доверием, вердиктом скана и целостностью.
 * Семантики разные ⇒ `SECURITY_AUDIT_SCOPES` **не расширяется** (это было бы
 * смешением «изменение политики» и «событие расширения» в одном журнале).
 *
 * Хранилище — доменный порт `PluginAuditRepository` (ADR-096), файловая
 * реализация — `{dataDir}/audit/plugins.jsonl` (append-only JSONL).
 * Секреты в журнал не пишутся (инвариант 13).
 */
import type { PackPluginMode } from './pack.js';
import type { CatalogTrustLevel } from './trust.js';

/**
 * Виды операций журнала плагинов (PROP-090 §9).
 *
 * Ф1 реализовал `activate`/`deactivate`; Ф2 добавил `scan` (сканер и
 * install-policy — вердикт и число находок пишутся отдельной записью, чтобы по
 * журналу было видно, **чем** решена активация); Ф3б добавил `filter` —
 * события решений фильтров LLM-вызовов (точка `llmFilters`): понижение вето
 * недоверенного фильтра, блокировка вызова доверенным фильтром, сбой/таймаут
 * фильтра. Ф5а добавил `install`/`uninstall` — события установки
 * (`PluginInstaller`: манифест → скан → trust-floor → install-policy →
 * раскладка → lock) и снятия (деактивация → lock → каталог).
 *
 * Порядок — жизненный цикл расширения: установка → активация → деактивация →
 * снятие, затем диагностические действия (`scan`/`filter`).
 */
export const PLUGIN_AUDIT_ACTIONS = [
  'install',
  'activate',
  'deactivate',
  'uninstall',
  'scan',
  'filter',
] as const;
export type PluginAuditAction = (typeof PLUGIN_AUDIT_ACTIONS)[number];

/**
 * Итог операции журнала плагинов:
 * - `ok` — плагин активен (активация состоялась / деактивация выполнена);
 * - `rejected` — активация **не состоялась** (отказ по гейту или остановка).
 */
export const PLUGIN_AUDIT_OUTCOMES = ['ok', 'rejected'] as const;
export type PluginAuditOutcome = (typeof PLUGIN_AUDIT_OUTCOMES)[number];

/**
 * Вердикт статического сканера (PROP-068 §4.3: `severity → verdict`).
 * Сканер появляется в Ф2; перечень verdict'ов уже зафиксирован канонически.
 */
export const PLUGIN_SCAN_VERDICTS = ['safe', 'caution', 'dangerous'] as const;
export type PluginScanVerdict = (typeof PLUGIN_SCAN_VERDICTS)[number];

/**
 * Машиночитаемые коды причин в журнале плагинов.
 *
 * Источник истины — загрузчик `PluginHost`
 * (`packages/core/src/engine/plugins/plugin-host.ts`): каждый отказ пайплайна
 * активации даёт свой код, поэтому по журналу видно, **на каком гейте**
 * плагин не прошёл.
 */
export const PLUGIN_AUDIT_REASONS = [
  /** Плагин не найден (resolve). */
  'plugin.not_found',
  /** Манифест не прошёл проверку целостности (`validatePackManifest`). */
  'plugin.manifest_invalid',
  /** Content-hash бандла не совпал с ожидаемым. */
  'plugin.integrity_mismatch',
  /** Ожидаемый content-hash задан, а проверить его нечем (нет файлов). */
  'plugin.integrity_unverifiable',
  /** Несовместимая версия контракта точки расширения. */
  'plugin.contract_mismatch',
  /** Несовместимая версия host-приложения (SemVer). */
  'plugin.host_mismatch',
  /** Уровень доверия ниже trust-floor инстанса. */
  'plugin.trust_below_floor',
  /** Сканер/политика установки отклонили плагин (Ф2). */
  'plugin.scan_rejected',
  /**
   * Вердикт сканера `caution` — требуется **явное подтверждение** владельца
   * (install-policy: `ask`, Ф2). Это не блокировка: активация прерывается с
   * требованием подтверждения, а не запрещается.
   */
  'plugin.approval_required',
  /** Слой плагинов выключен мастер-выключателем (`plugins.enabled=false`). */
  'plugin.disabled',
  /** Плагин не входит в `plugins.allowlist` (список задан — разрешены только перечисленные). */
  'plugin.not_allowlisted',
  /** Плагин входит в `plugins.denylist`. */
  'plugin.denylisted',
  /** Установка во время работы инстанса запрещена (`plugins.runtimeInstall=deny`). */
  'plugin.runtime_install_denied',
  /**
   * Сканирование выключено (`plugins.scan='disabled'`), а исполнение кода
   * плагинов включено (`plugins.executionEnabled=true`) — **fail-closed**:
   * исполняемый код обязан быть просканирован. Решение владельца (Ф3а,
   * 2026-10-22).
   */
  'plugin.scan_disabled_with_execution',
  /** Исполнение кода выключено (`plugins.executionEnabled=false`). */
  'plugin.execution_disabled',
  /**
   * Загрузчик кода недоступен (`PluginHost` без `loader`, Ф1) или загрузка
   * бандла сорвалась (Ф4а: нет `rootDir`, файл вне `rootDir`, не `.js`/`.mjs`,
   * превышен размер, ошибка `import()`).
   */
  'plugin.loader_unavailable',
  /**
   * Ф4а: модуль **загружен**, но не выполнил контракт `PluginModule` — нет
   * `apply(facade)` (ни `module.apply`, ни `module.default.apply`, ни
   * `module.default`-функции). Исполнять нечего: активация отклонена
   * (`engine/plugins/inline-loader.ts` → `PluginLoadError`).
   */
  'plugin.module_invalid',
  /** Плагин уже активен — повторная активация отклонена. */
  'plugin.already_active',
  /** Плагин не активен — деактивация нечего снимать. */
  'plugin.not_active',
  /** Сбой disposer'а при обратной прокрутке (остальные disposer'ы выполнены). */
  'plugin.disposer_failed',
  /**
   * Ф3б: фактические регистрации вкладов не совпали с `provides` манифеста
   * (`diffPackProvides`: объявлено, но не зарегистрировано — или наоборот).
   * PROP-090 §«Правило соответствия»: расхождение — **отказ активации**
   * (признак несогласованной сборки). Проверяются точки, реализованные в Ф3:
   * `provides.promptBlocks[]` и `provides.llmFilters[]`; `provides.tools[]`
   * присоединится вместе с точкой `tools` (Ф3в).
   */
  'plugin.provides_mismatch',
  /**
   * Ф3б (точка `llmFilters`): фильтр вернул блокирующий вердикт (`deny`/
   * `redact`), но доверие его владельца ниже `trusted` — **хост понизил
   * вердикт до `allow`**. Право вето — только у доверенных (PROP-090
   * §«Кто вправе блокировать»).
   */
  'plugin_filter.deny_downgraded',
  /**
   * Ф3б: фильтр доверенного плагина заблокировал LLM-вызов (`deny`) —
   * вызов не ушёл провайдеру.
   */
  'plugin_filter.denied',
  /**
   * Ф3б: фильтр завершился ошибкой или не уложился в бюджет времени —
   * по `failMode` вызов либо заблокирован (`closed`), либо прошёл (`open`).
   */
  'plugin_filter.unavailable',
] as const;
export type PluginAuditReason = (typeof PLUGIN_AUDIT_REASONS)[number];

/**
 * Одна запись журнала аудита плагинов (append-only).
 *
 * `id` формирует вызывающий (`pa_<uuid>`), `ts` — ISO-8601. `actor` —
 * инициатор (`userId` при API/UI, `'cli'` при командной строке, `'startup'` при
 * активации на старте). При `outcome: 'ok'` поле `reason` — примечание
 * (сейчас — `plugin.disposer_failed`); при `outcome: 'rejected'` — код отказа.
 */
export interface PluginAuditEntry {
  /** `pa_<uuid>`, уникален в пределах инстанса. */
  id: string;
  /** Метка события, ISO-8601. */
  ts: string;
  /** Инициатор операции. */
  actor: string;
  /** Scope журнала — всегда `plugin` (отдельная семантика от security-аудита). */
  scope: 'plugin';
  /** Вид операции: установка/активация/деактивация/снятие/скан/фильтр. */
  action: PluginAuditAction;
  /** Имя плагина (из манифеста `synth.pack`). */
  plugin: string;
  /** Версия плагина (semver). */
  version: string;
  /** Фактический уровень доверия (резолвится по источнику, не по манифесту). */
  trustLevel?: CatalogTrustLevel;
  /** Вердикт статического сканера (Ф2+). */
  scanVerdict?: PluginScanVerdict;
  /**
   * Число находок сканера (Ф2). Заполняется в записях действия `scan`.
   */
  scanFindings?: number;
  /**
   * Выполнялся ли скан (Ф2). `false` — скан **выключен политикой**
   * (`plugins.scan: 'disabled'`) или сканировать было нечего; вердикт в этом
   * случае по умолчанию `safe`, но по журналу видно, что скана не было.
   */
  scanPerformed?: boolean;
  /** Content-hash бандла (sha256 от отсортированного набора файлов). */
  contentHash?: string;
  /** Режим исполнения, объявленный манифестом (`inline`/`remote`/`both`). */
  mode?: PackPluginMode;
  /** Итог операции. */
  outcome: PluginAuditOutcome;
  /** Код причины (машиночитаемый). */
  reason?: PluginAuditReason;
  /** Источник установки (`npm`/`local`/`catalog`/`builtin`/…). */
  source?: string;
}
