/**
 * PROP-068 §4.3 / PROP-090 §9: контракты статического сканера расширений и
 * матрица install-policy.
 *
 * Модуль browser-safe (`zod` не нужен — только типы и чистые функции), чтобы
 * его можно было использовать и в UI (карточка плагина — Ф6), и в ядре
 * (сканер, `PluginHost`).
 *
 * **Канон границ.** Таблица `severity → verdict` и значения квот зафиксированы
 * в [PROP-068](../../../../docs/arch_decisions/prop-068-skills-agents-registry.md) §4.3
 * (согласовано с владельцем 2026-10-22);
 * [PROP-090](../../../../docs/arch_decisions/prop-090-extension-api.md) §9 ссылается
 * на неё и не дублирует. При изменении значений — правка обоих документов.
 */
import type { PluginScanVerdict } from './plugin-audit.js';

/**
 * Версия правил сканера (`PLUGIN_SCAN_RULES` в ядре).
 *
 * Входит в **ключ кэша сканов**: при изменении правил (новые категории,
 * другие severity) старый вердикт из кэша нельзя переиспользовать — иначе
 * бандл, признанный безопасным по старым правилам, получил бы «зелёный»
 * вердикт по новым. Правило: **любое изменение правил сканера поднимает
 * версию**.
 */
export const PLUGIN_SCAN_RULES_VERSION = '1';

/**
 * Категории находок сканера (PROP-068 §4.3).
 *
 * Шесть базовых категорий + отдельная `invisible_unicode` (скрытие инструкций
 * для LLM). Категория — **ось классификации**, а не severity: severity
 * определяет вердикт.
 */
export const PLUGIN_SCAN_CATEGORIES = [
  'exfiltration',
  'injection',
  'destructive',
  'persistence',
  'network',
  'obfuscation',
  'invisible_unicode',
] as const;
export type PluginScanCategory = (typeof PLUGIN_SCAN_CATEGORIES)[number];

/** Уровни серьёзности находки (PROP-068 §4.3). */
export const PLUGIN_SCAN_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type PluginScanSeverity = (typeof PLUGIN_SCAN_SEVERITIES)[number];

/**
 * Одна находка сканера (PROP-068 §4.3).
 *
 * Форма — как у threat-scan проектных инструкций
 * (`packages/core/src/engine/context/instructions.ts`): категория, серьёзность,
 * файл, строка, описание.
 */
export interface PluginScanFinding {
  /** Категория находки. */
  category: PluginScanCategory;
  /** Серьёзность находки. */
  severity: PluginScanSeverity;
  /** Относительный путь файла (в корне бандла). */
  file: string;
  /** Номер строки (1-based; `0` — находка не привязана к строке). */
  line: number;
  /** Человекочитаемое описание находки. */
  description: string;
}

/**
 * Границы `severity → verdict` (канон — PROP-068 §4.3).
 *
 * `info|low → safe`, `medium → caution`, `high|critical → dangerous`.
 * Вердикт бандла — **максимум** severity по находкам.
 */
export const PLUGIN_SCAN_SEVERITY_VERDICTS: Readonly<
  Record<PluginScanSeverity, PluginScanVerdict>
> = {
  info: 'safe',
  low: 'safe',
  medium: 'caution',
  high: 'dangerous',
  critical: 'dangerous',
};

/** Вердикт по серьёзности одной находки. */
export function severityToVerdict(severity: PluginScanSeverity): PluginScanVerdict {
  return PLUGIN_SCAN_SEVERITY_VERDICTS[severity];
}

/** Порядок вердиктов — от «мягкого» к «блокирующему». */
const VERDICT_ORDER: readonly PluginScanVerdict[] = ['safe', 'caution', 'dangerous'];

/** Ранг вердикта (больше — жёстче). */
export function verdictRank(verdict: PluginScanVerdict): number {
  return VERDICT_ORDER.indexOf(verdict);
}

/**
 * Вердикт бандла — **максимум** severity по находкам (PROP-068 §4.3).
 *
 * Находок нет — `safe`.
 */
export function verdictFromFindings(findings: readonly PluginScanFinding[]): PluginScanVerdict {
  let worst: PluginScanVerdict = 'safe';
  for (const finding of findings) {
    const verdict = severityToVerdict(finding.severity);
    if (verdictRank(verdict) > verdictRank(worst)) worst = verdict;
  }
  return worst;
}

/**
 * Квоты структуры бандла (PROP-068 §4.3).
 *
 * - `maxFileCount` / `maxTotalSizeKb` — превышение → минимум `caution`;
 * - `maxSingleFileKb` — превышение лимита **одного** файла → `dangerous`.
 */
export const PLUGIN_SCAN_QUOTAS = {
  /** Максимум файлов в бандле. */
  maxFileCount: 50,
  /** Максимум суммарного размера бандла, КиБ. */
  maxTotalSizeKb: 1024,
  /** Максимум размера одного файла, КиБ. */
  maxSingleFileKb: 256,
} as const;

/** Квоты сканера (с переопределением под тест/инстанс). */
export interface PluginScanQuotas {
  maxFileCount: number;
  maxTotalSizeKb: number;
  maxSingleFileKb: number;
}

/** Квоты по умолчанию. */
export const DEFAULT_PLUGIN_SCAN_QUOTAS: PluginScanQuotas = { ...PLUGIN_SCAN_QUOTAS };

/**
 * Вид нарушения квоты (канон — PROP-068 §4.3).
 *
 * Ключи не совпадают с именами полей `PluginScanQuotas` намеренно: здесь важно
 * **что именно нарушено**, а не как называется лимит.
 */
export type PluginScanQuotaKind = 'fileCount' | 'totalSize' | 'singleFile';

/**
 * Серьёзность нарушения квоты структуры бандла (PROP-068 §4.3).
 *
 * Канон — здесь, чтобы сканер (core) и проверки не разъезжались:
 * - превышение **числа файлов** или **суммарного размера** → `medium`
 *   (вердикт не выше `caution` — подтверждение владельца);
 * - превышение размера **одного** файла → `high` (вердикт `dangerous` —
 *   установка блокируется).
 */
export const PLUGIN_SCAN_QUOTA_SEVERITIES = {
  /** Превышено число файлов в бандле. */
  fileCount: 'medium',
  /** Превышен суммарный размер бандла. */
  totalSize: 'medium',
  /** Превышен размер одного файла. */
  singleFile: 'high',
} as const satisfies Record<PluginScanQuotaKind, PluginScanSeverity>;

// ── Install-policy (PROP-068 §4.2 + новая ячейка `kind: plugin`) ──────────

/** Исход install-policy. */
export const INSTALL_POLICY_ACTIONS = ['allow', 'ask', 'block'] as const;
export type InstallPolicyAction = (typeof INSTALL_POLICY_ACTIONS)[number];

/**
 * Уровни доверия в install-policy (PROP-068 §4.2).
 *
 * Шире `CATALOG_TRUST_LEVELS`: матрица включает `agent-created` (создано
 * агентом) — в каталоге расширений этот уровень не используется, но в
 * install-policy ячейка обязательна (PROP-068 §4.2).
 */
export const INSTALL_POLICY_TRUST_LEVELS = [
  'builtin',
  'verified',
  'trusted',
  'community',
  'agent-created',
] as const;
export type InstallPolicyTrustLevel = (typeof INSTALL_POLICY_TRUST_LEVELS)[number];

/**
 * Класс расширения, для которого считается install-policy.
 *
 * - `content` — контент-паки/скиллы/агенты (матрица PROP-068 §4.2);
 * - `plugin` — плагины (PROP-090 §9): **новая ячейка** матрицы.
 */
export type InstallPolicyKind = 'content' | 'plugin';

/** Вход решения install-policy. */
export interface InstallPolicyInput {
  /** Фактический уровень доверия (резолвится по источнику). */
  trust: InstallPolicyTrustLevel;
  /** Вердикт сканера. */
  verdict: PluginScanVerdict;
  /** Класс расширения (по умолчанию — `content`). */
  kind?: InstallPolicyKind;
}

/**
 * Матрица `trust × verdict` (PROP-068 §4.2).
 *
 * Содержимое (`kind: 'content'`):
 *
 * | Trust \ Вердикт | `safe` | `caution` | `dangerous` |
 * |---|---|---|---|
 * | `builtin` | allow | allow | allow |
 * | `verified` | allow | allow | block |
 * | `trusted` | allow | allow | block |
 * | `community` | allow | block | block |
 * | `agent-created` | allow | allow | ask |
 *
 * Плагин (`kind: 'plugin'`) — **новая ячейка** (PROP-090 §9): блокирующий
 * вердикт — `dangerous` (→ `block`), `caution` → `ask` (явное подтверждение
 * владельца), `safe` → `allow`. Ячейка не зависит от уровня доверия.
 */
const CONTENT_POLICY: Readonly<
  Record<InstallPolicyTrustLevel, Readonly<Record<PluginScanVerdict, InstallPolicyAction>>>
> = {
  builtin: { safe: 'allow', caution: 'allow', dangerous: 'allow' },
  verified: { safe: 'allow', caution: 'allow', dangerous: 'block' },
  trusted: { safe: 'allow', caution: 'allow', dangerous: 'block' },
  community: { safe: 'allow', caution: 'block', dangerous: 'block' },
  'agent-created': { safe: 'allow', caution: 'allow', dangerous: 'ask' },
};

/** Ячейка матрицы для плагинов (любой уровень доверия). */
const PLUGIN_POLICY: Readonly<Record<PluginScanVerdict, InstallPolicyAction>> = {
  safe: 'allow',
  caution: 'ask',
  dangerous: 'block',
};

/**
 * Решение install-policy по матрице `trust × verdict`.
 *
 * Одна функция на оба класса расширений (плагины и, в перспективе,
 * контент-паки) — матрица не дублируется по подсистемам.
 *
 * **Порядок вызовов (важно):** trust-floor проверяется **до** install-policy —
 * плагин ниже `plugins.trustFloor` не активируется ни при каком вердикте
 * (`plugin.trust_below_floor`). Матрица отвечает только на вопрос «можно ли
 * ставить/активировать по вердикту скана».
 */
export function installPolicyDecision(input: InstallPolicyInput): InstallPolicyAction {
  const kind: InstallPolicyKind = input.kind ?? 'content';
  if (kind === 'plugin') return PLUGIN_POLICY[input.verdict];
  const row = CONTENT_POLICY[input.trust];
  // Неизвестный уровень доверия — fail-closed: трактуем как `community`.
  return (row ?? CONTENT_POLICY.community)[input.verdict];
}

// ── Lock (PROP-068 §4.4 / PROP-090 §5) ───────────────────────────────────
// Запись lock-файла вынесена в отдельный модуль `plugin-lock.ts`.
