/**
 * ADR-101 (Pipeline Engine): permission-обёртка пайплайна.
 *
 * Пайплайн **не обходит** permission-слой (ADR-025/ADR-028/ADR-029): шаг
 * спрашивает право тем же `PermissionEvaluator`, что и сессия, — с теми же
 * правилами per-tool/per-pattern, той же shell-policy и теми же защищёнными
 * путями. Разница только в источнике режима:
 *
 * | Параметр permission-слоя | Значение для пайплайна | Почему |
 * |---|---|---|
 * | `sessionMode` | `spec.mode` (`plan`/`act`/`yolo`) | режим пайплайна объявляется спецификацией (ADR-025) |
 * | `planMode` | `auto` | цикла plan→build в пайплайне нет — ветка `strict` (план должен быть утверждён) не срабатывает никогда; но режимная рестрикция `plan` (write/edit/git-write запрещены, ADR-025) остаётся включённой |
 * | `planApproved` | `true` | спецификация опубликована — шаг выполняется в рамках утверждённого плана |
 * | `workingDir` | рабочий каталог проекта (ADR-075) | тот же, что у сессий проекта |
 * | `workspaceReady` | `workspaceReady` контекста шага | гейт `workspace` (ADR-075) |
 *
 * > ⚠️ `planMode: 'off'` здесь **нельзя**: в ядре `isPlanRestricted()` (ADR-025)
 * > трактует `'off'` как «планирование отключено полностью» — режимная
 * > рестрикция `plan` при этом тоже выключается, и режим пайплайна `plan`
 * > перестал бы запрещать запись (ADR-025/ADR-070 §2.9.1). Значение `auto`
 * > даёт то же отсутствие цикла plan→build (ветка `strict` не срабатывает)
 * > при сохранённой смысле режима.
 *
 * Результат — `{action:'allow'|'deny'|'ask', reason?}`. Три исхода разведены по
 * разным ветвям движка:
 *
 * - `allow` — шаг исполняется;
 * - `deny` — шаг `failed` с кодом `permission.denied` (обход невозможен);
 * - `ask` — **эскалация в human-гейт**: наблюдателя-сессии у пайплайна нет,
 *   спросить некого → прогон встаёт на паузу (`awaiting_human`) и ждёт решения
 *   оператора (ADR-101 §6).
 */
import type {
  McpServerToolSettings,
  PermissionConfig,
  PipelineMode,
} from '@itphx/synth-shared';

import { PermissionEvaluator } from '../permission/evaluator.js';
import type { ProtectedPathsPolicy } from '../security/protected-paths.js';
import type { ShellPolicy } from '../security/shell-guard.js';
import type { RuntimeDeps } from '../tools/runtime-deps.js';

/** Решение permission-слоя для шага пайплайна. */
export interface PipelinePermissionDecision {
  /** Разрешение: `allow` — исполнять, `deny` — отказ, `ask` — эскалация в гейт. */
  action: 'allow' | 'deny' | 'ask';
  /** Пояснение (причина отказа/эскалации или источник разрешения). */
  reason?: string;
  /** Сработавшее правило (имя тула, группа, паттерн или `*`). */
  matchedRule?: string;
  /** Идентификатор локализованного сообщения (deny-protected-path и т.п.). */
  messageId?: string;
  /** Параметры подстановки в сообщение. */
  params?: Record<string, string>;
}

/**
 * Зависимости permission-обёртки пайплайна — те же объекты, что собраны в
 * `server/app/deps.ts` для сессий.
 *
 * `evaluator` важнее `permissionConfig`: если задан готовый экземпляр
 * `PermissionEvaluator`, используется именно он (один источник правил).
 */
export interface PipelinePermissionDeps {
  /** Правила прав инстанца (ADR-029). */
  permissionConfig?: PermissionConfig;
  /** Готовый эвалуатор (приоритетнее конфига). */
  evaluator?: PermissionEvaluator;
  /** Политика безопасности `execute_shell` (definitions/*.json). */
  shellPolicy?: ShellPolicy;
  /** Единая политика защищённых путей (ADR-099). */
  protectedPaths?: ProtectedPathsPolicy;
  /** Тумблер проверки защищённых путей (`false` — проверка пропускается). */
  protectedPathsEnabled?: boolean;
  /** Доступность внешних программ окружения (git/rg/sh) — ADR-078. */
  runtimeDeps?: RuntimeDeps;
  /** Доступность MCP-инструментов по режимам (ADR-071). */
  mcpToolSettings?: Record<string, McpServerToolSettings>;
}

/** Проверяемый вызов инструмента шага. */
export interface PipelineToolPermissionCheck {
  /** Имя инструмента. */
  toolName: string;
  /** Аргументы вызова (пути/команда разбираются permission-слоем). */
  params: Record<string, unknown>;
  /** Рабочий каталог (ADR-075). */
  workingDir: string;
  /** Capabilities инструмента. */
  capabilities?: readonly string[];
  /** Режим пайплайна (`plan`/`act`/`yolo`). */
  mode: PipelineMode;
  /** Готов ли рабочий каталог проекта (ADR-075). */
  workspaceReady?: boolean;
  /** Capabilities агента шага (ADR-070 §2.9.1). */
  agentCapabilities?: readonly string[];
}

/**
 * Проверка права на инструмент шага пайплайна.
 *
 * Обёртка над `PermissionEvaluator.check()`: тот же слой, те же правила; режим
 * пайплайна передаётся как `sessionMode`, цикл plan→build отключён
 * (`planMode: 'off'`, `planApproved: true`).
 */
export function checkPipelineToolPermission(
  check: PipelineToolPermissionCheck,
  deps: PipelinePermissionDeps = {},
): PipelinePermissionDecision {
  const evaluator =
    deps.evaluator ?? new PermissionEvaluator(deps.permissionConfig ?? { rules: {}, askTimeoutMs: 30_000 });

  const decision = evaluator.check({
    toolName: check.toolName,
    params: check.params,
    workingDir: check.workingDir,
    ...(check.capabilities ? { capabilities: check.capabilities } : {}),
    // ADR-025: режим пайплайна — это режим permission-слоя.
    sessionMode: check.mode,
    // Цикла plan→build в пайплайне нет: ветка `strict` (план должен быть
    // утверждён) не срабатывает никогда, а режимная рестрикция `plan` —
    // остаётся включённой (см. предупреждение в шапке модуля).
    planMode: 'auto',
    planApproved: true,
    ...(deps.mcpToolSettings ? { mcpToolSettings: deps.mcpToolSettings } : {}),
    ...(deps.shellPolicy ? { shellPolicy: deps.shellPolicy } : {}),
    ...(deps.protectedPaths ? { protectedPaths: deps.protectedPaths } : {}),
    ...(deps.protectedPathsEnabled !== undefined
      ? { protectedPathsEnabled: deps.protectedPathsEnabled }
      : {}),
    ...(deps.runtimeDeps ? { runtimeDeps: deps.runtimeDeps } : {}),
    ...(check.workspaceReady !== undefined ? { workspaceReady: check.workspaceReady } : {}),
    ...(check.agentCapabilities ? { agentCapabilities: check.agentCapabilities } : {}),
  });

  return {
    action: decision.action,
    reason: decision.reason,
    ...(decision.matchedRule !== undefined ? { matchedRule: decision.matchedRule } : {}),
    ...(decision.messageId !== undefined ? { messageId: decision.messageId } : {}),
    ...(decision.params !== undefined ? { params: decision.params } : {}),
  };
}
