/**
 * ADR-095 (шаг 6a): персистентность сообщений оркестратора.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет делегации `_saveAssistantMessage`,
 * `_persistToolChain`, `_getAssistantSecrets`, `_resolveAssistantStatus`,
 * `_joinAccumulatedTexts`; тип `AssistantMessageStatus` реэкспортируется из
 * `orchestrator.ts` (публичный контракт).
 */
import type { Message, Part, PromptMeta, TokenUsage } from '@itphx/synth-shared';
import { MessageRole, generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { BlobRefRepository } from '../../storage/ports/blob-ref-repository.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { EventBus } from '../../events/bus.js';
import type { DebugCollector } from '../../debug.js';
import { computeCacheHitRate, computeUsageCost, type UsageCost } from '../../providers/usage.js';
import type { ObfuscationMapStore } from '../gateway/index.js';
import { PLACEHOLDER_PATTERN } from '../gateway/index.js';
import { validateExpected } from '../context/prompt-state.js';
import { warning } from '../../logger.js';
import type { AnalyticsRecorder } from '../../analytics/recorder.js';
import { sessionAxes } from '../../analytics/recorder.js';
import {
  aggregateSubagentStats,
  collectSubagentUsageByModel,
  computeMessageCost,
  type ModelPriceLoader,
} from './usage.js';

/**
 * ADR-070 §2.6: статус ответа ассистента для строки статистики в UI.
 * - `completed` — нормальный ответ (без префикса);
 * - `cancelled` — отменён пользователем («Стоп»);
 * - `stopped` — остановлен (отказ в туле / блокировка);
 * - `error` — ошибка/пустой ответ LLM;
 * - `limit` — достигнут лимит итераций;
 * - `interrupted` — генерация прервана пользователем (ADR-104 `interrupt`:
 *   ход продолжается, ответ — частичный).
 */
export type AssistantMessageStatus =
  | 'completed'
  | 'cancelled'
  | 'stopped'
  | 'error'
  | 'limit'
  | 'interrupted';

const ASSISTANT_MESSAGE_STATUSES: readonly AssistantMessageStatus[] = [
  'completed', 'cancelled', 'stopped', 'error', 'limit', 'interrupted',
];

/** Валидный ли статус (защита от произвольного значения в metadata.status). */
export function isAssistantMessageStatus(value: unknown): value is AssistantMessageStatus {
  return typeof value === 'string' && (ASSISTANT_MESSAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * ADR-070 §2.6: статус ответа по данным сохранения. Централизованно, чтобы
 * ни один путь (`saveAssistantMessage`) не пропустил поле `metadata.status`.
 */
export function resolveAssistantStatus(
  isCancelled: boolean,
  metadataExtra?: Record<string, unknown>,
): AssistantMessageStatus {
  if (isCancelled) return 'cancelled';
  // ADR-104 (этап 2): прерванная генерация (`interrupt`) — не «остановлено»
  // («Стоп») и не ошибка: ход продолжается, ответ частичный.
  if (metadataExtra?.interrupted === true) return 'interrupted';
  const key = (metadataExtra?.i18n as { key?: string } | undefined)?.key;
  switch (key) {
    case 'session.stopped':
    case 'session.denied_blocked':
    case 'session.role_tool_blocked':
      return 'stopped';
    case 'session.max_iterations':
      return 'limit';
    case 'session.empty_response':
    case 'router.timeout':
    case 'router.network_error':
    case 'router.rate_limit_exceeded':
    case 'router.context_length_exceeded':
    case 'router.no_user_query':
      return 'error';
    default:
      return 'completed';
  }
}

/**
 * Склейка накопленного текста: все завершённые итерации (allIntermediateTexts)
 * + текст текущей (незавершённой) итерации. Пустые фрагменты пропускаются.
 * Используется при отмене (abort), чтобы в истории сохранялся полный
 * частичный ответ, а не только обрывок последней итерации.
 */
export function joinAccumulatedTexts(
  intermediateTexts: Array<{ text: string; iteration: number }>,
  current: string,
): string {
  const parts = [...intermediateTexts.map((t) => t.text), current]
    .filter((t) => t && t.trim().length > 0);
  return parts.join('\n\n');
}

/**
 * ADR-036: возвращает реальные значения секретов для плейсхолдеров
 * ⟦SYNTH_SECRET_N⟧ в тексте сообщения (из карты обфускации сессии).
 * Пустой объект если карты нет, плейсхолдеров нет или gateway выключен.
 */
export async function getAssistantSecrets(
  sessionId: string,
  content: string,
  obfMapStore: ObfuscationMapStore | null,
): Promise<Record<string, string>> {
  if (!content || !obfMapStore) return {};
  try {
    const obfMap = await obfMapStore.get(sessionId);
    if (Object.keys(obfMap).length === 0) return {};
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    const placeholderRe = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
    while ((match = placeholderRe.exec(content)) !== null) {
      found.add(match[0]);
    }
    const secrets: Record<string, string> = {};
    for (const ph of found) {
      if (ph in obfMap) secrets[ph] = obfMap[ph]!;
    }
    return secrets;
  } catch (e) {
    warning('ORCHESTRATOR', `Ошибка раскрытия секретов в metadata: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/**
 * ADR-102: есть ли в usage реальные токены (нулевой ответ не создаёт бакет).
 */
function hasUsageTokens(usage: TokenUsage | undefined): boolean {
  if (!usage) return false;
  return (
    (usage.inputTokens || 0) > 0
    || (usage.outputTokens || 0) > 0
    || (usage.cacheReadTokens || 0) > 0
    || (usage.cacheWriteTokens || 0) > 0
    || (usage.reasoningTokens || 0) > 0
  );
}

/**
 * Персистентность tool-chain (Вариант B): настоящие пары
 * «assistant с toolCalls + tool-результаты» в session.messages, чтобы
 * sessionMessagesToLlm на следующем запросе выдавал OpenAI-совместимый
 * диалог. Промежуточные сообщения помечаются metadata.tool_chain=true —
 * UI их скрывает (визуализация уже есть в финальном сообщении).
 *
 * Шаг 2а: продовый путь оркестратора больше не вызывает этот helper —
 * сообщения пишутся пошагово (`SessionManager.appendMessage` сразу после
 * итерации/каждого тула), чтобы падение в середине хода их не теряло.
 * Функция сохранена как экспортируемый пакетный helper (unit-тесты,
 * переиспользование), поведение прежнее.
 */
export async function persistToolChain(
  sessionManager: SessionManager,
  sessionId: string,
  streamId: string,
  providerName: string,
  agentRole: string | undefined,
  finalModel: string | undefined,
  allRawToolCalls: Array<{ iteration: number; calls: Record<string, unknown>[] }>,
  allToolCalls: Array<Record<string, unknown>>,
  allIntermediateTexts: Array<{ text: string; iteration: number }>,
  allReasoning: Array<{ text: string; iteration: number }>,
): Promise<void> {
  for (const raw of allRawToolCalls) {
    const iteration = raw.iteration;
    const iterText = allIntermediateTexts.find((t) => t.iteration === iteration)?.text ?? '';
    const iterReasoning = allReasoning.find((r) => r.iteration === iteration)?.text;

    const assistantMsg: Message = {
      id: generateId(),
      role: MessageRole.ASSISTANT,
      seq: 0,
      origin: 'local',
      parts: [makeTextPart(iterText)],
      content: iterText,
      toolCalls: raw.calls,
      createdAt: nowISO(),
      disabled: false,
      pinned: false,
      hidden: false,
      model: finalModel,
      provider: providerName,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      agentRole,
      metadata: { stream_id: streamId, tool_chain: true },
      ...(iterReasoning ? { reasoning: iterReasoning } : {}),
    };
    await sessionManager.addMessage(sessionId, assistantMsg);

    for (const tc of allToolCalls.filter((t) => t.iteration === iteration)) {
      const toolContent = String((tc.result as { content?: string } | undefined)?.content ?? '');
      // metadata ToolResult (в т.ч. i18n) пробрасывается в metadata сообщения —
      // иначе локализационные ключи не доходят до истории и UI.
      const toolResultMeta = (tc.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
      const toolMsg: Message = {
        id: generateId(),
        role: MessageRole.TOOL,
        seq: 0,
        origin: 'local',
        parts: [makeTextPart(toolContent)],
        content: toolContent,
        toolCallId: tc.id as string,
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        model: finalModel,
        provider: providerName,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        agentRole,
        metadata: {
          ...(toolResultMeta ?? {}),
          stream_id: streamId,
          tool_chain: true,
          tool_name: tc.name,
          args: tc.args,
        },
      };
      await sessionManager.addMessage(sessionId, toolMsg);
    }
  }
}

/** Зависимости `saveAssistantMessage` (сессия/события/обфускация/цены). */
export interface SaveAssistantMessageDeps {
  sessionManager: SessionManager;
  eventBus: EventBus;
  obfMapStore: ObfuscationMapStore | null;
  modelPriceLoader: ModelPriceLoader | null;
  /** ADR-102: сборщик `usage`-роллапа (не задан — запись не выполняется). */
  analytics?: AnalyticsRecorder;
  /**
   * ADR-115 (outbound): учёт ссылок на объекты blob-хранилища. Нужен, когда к
   * сообщению прикреплены медиа-части (`extraParts`): без ссылки GC сочёл бы
   * объект сиротой по TTL. Best-effort — ошибка не отменяет сохранение.
   */
  blobRefs?: BlobRefRepository;
}

/** Ссылка на уже созданное сообщение (черновик частичного стрима, шаг 2б). */
export interface ExistingMessageRef {
  id: string;
  seq: number;
}

/** Сигнатура `saveAssistantMessage` (для делегации/передачи колбэком). */
export type SaveAssistantMessageFn = (
  sessionId: string,
  content: string,
  streamId: string,
  agentRole: string | undefined,
  usage: TokenUsage,
  model: string | undefined,
  reasoning: string | undefined,
  debugCollector: DebugCollector,
  isCancelled: boolean,
  provider?: string,
  role?: MessageRole,
  summaryOf?: number[],
  skipEvent?: boolean,
  toolResults?: Array<Record<string, unknown>>,
  intermediateTextBlocks?: Array<{ text: string; iteration: number }>,
  qaPass?: boolean,
  qaReason?: string,
  metadataExtra?: Record<string, unknown>,
  promptMeta?: PromptMeta,
  precomputedCost?: UsageCost | null,
  /**
   * Шаг 2б: сообщение уже создано черновиком частичного стрима — обновить его
   * (`updateMessage`) вместо `addMessage`, чтобы в истории не было дубля.
   */
  existing?: ExistingMessageRef,
  /**
   * ADR-115 (outbound): медиа-части ответа, накопленные тулом `send_attachment`
   * за ход. Добавляются в `parts` **после** текста: оттуда их читает
   * `collectOutboundAttachments` (вложения финального сообщения →
   * `stream.done.attachments`). Пусто/не задано — прежнее поведение.
   */
  extraParts?: Part[],
) => Promise<string>;

export async function saveAssistantMessage(
  deps: SaveAssistantMessageDeps,
  sessionId: string,
  content: string,
  streamId: string,
  agentRole: string | undefined,
  usage: TokenUsage,
  model: string | undefined,
  reasoning: string | undefined,
  debugCollector: DebugCollector,
  isCancelled: boolean,
  provider?: string,
  role: MessageRole = MessageRole.ASSISTANT,
  summaryOf?: number[],
  skipEvent = false,
  toolResults?: Array<Record<string, unknown>>,
  intermediateTextBlocks?: Array<{ text: string; iteration: number }>,
  qaPass?: boolean,
  qaReason?: string,
  /** Дополнительные поля metadata (например metadata.i18n фоллбек-статусов). */
  metadataExtra?: Record<string, unknown>,
  /** ADR-070 §2.4: предсказание prompt-cache; cachedTokens/validated — из usage. */
  promptMeta?: PromptMeta,
  /**
   * ADR-070 §2.6: уже посчитанная стоимость сообщения (если вызывающая сторона
   * считала её для события) — избегаем повторного `_computeMessageCost`.
   */
  precomputedCost?: UsageCost | null,
  /** Шаг 2б: обновить существующий черновик вместо создания нового сообщения. */
  existing?: ExistingMessageRef,
  /** ADR-115 (outbound): медиа-части ответа хода (после текста). */
  extraParts?: Part[],
): Promise<string> {
  const sessionManager = deps.sessionManager;
  const finalContent = content;

  if (!isCancelled && content) {
    debugCollector.captureRawModelResponse(content);
  }

  if (debugCollector.enabled) {
    debugCollector.captureReasoning(reasoning);
  }

  const debugInfo = debugCollector.getDebugInfo();

  // ADR-070 §2.4: usage доступен в момент сохранения — заполняем фактические
  // cachedTokens и подтверждаем/опровергаем предсказание.
  const resolvedPromptMeta: PromptMeta | undefined = promptMeta
    ? {
        ...promptMeta,
        cachedTokens: usage?.cacheReadTokens ?? 0,
        validated: validateExpected(promptMeta.expected, usage?.cacheReadTokens ?? 0),
      }
    : undefined;

  const metadata: Record<string, unknown> = { stream_id: streamId, ...metadataExtra };
  // ADR-070 §2.6: единая точка простановки статуса ответа — ни один путь
  // сохранения (обычный, cancel, tool-chain, summary, debug, micro) не
  // пропускает его. UI показывает префикс по этому полю.
  // Явный status (например 'error' для assistant-сообщения о сбое LLM)
  // приоритетнее вывода из i18n — иначе rate_limit/context_length без
  // маппинга получили бы 'completed'.
  metadata.status = isAssistantMessageStatus(metadataExtra?.status)
    ? metadataExtra.status
    : resolveAssistantStatus(isCancelled, metadataExtra);
  if (toolResults && toolResults.length > 0) {
    metadata.tool_results = toolResults;
    // ADR-070 §2.6: per-message статистика сабагентов (попап сообщения и
    // «Последний ответ») — агрегируется из task-результатов этого хода.
    const subagents = aggregateSubagentStats(
      toolResults,
      (m, u) => computeMessageCost(m, u, deps.modelPriceLoader),
    );
    if (subagents) metadata.subagents = subagents;
  }
  if (intermediateTextBlocks && intermediateTextBlocks.length > 0) {
    metadata.intermediate_text_blocks = intermediateTextBlocks;
  }

  // ADR-070 §2.6: стоимость хода по цене модели (только если цены известны).
  const messageCost = precomputedCost !== undefined
    ? precomputedCost
    : computeMessageCost(model, usage, deps.modelPriceLoader);
  if (messageCost) {
    metadata.cost_usd = messageCost.costUsd;
    metadata.cost_currency = messageCost.currency;
    metadata.cost_breakdown = messageCost.breakdown;
  }

  // ADR-036: раскрытие секретов в UI. Реальные значения плейсхолдеров из
  // карты обфускации сессии встраиваются в metadata.secrets (клик раскрывает
  // локально). Только существующие плейсхолдеры; карта — секрет, в логи не пишется.
  if (role === MessageRole.ASSISTANT && finalContent && deps.obfMapStore) {
    const secrets = await getAssistantSecrets(sessionId, finalContent, deps.obfMapStore);
    if (Object.keys(secrets).length > 0) {
      metadata.secrets = { ...(metadata.secrets as Record<string, string> | undefined), ...secrets };
    }
  }

  const msg: Message = {
    id: existing?.id ?? generateId(),
    role,
    seq: existing?.seq ?? 0, // filled by addMessage (или уже назначен черновиком)
    origin: 'local',
    // ADR-115 (outbound): текст + медиа-части ответа (`send_attachment`).
    parts: [makeTextPart(finalContent), ...(extraParts ?? [])],
    content: finalContent,
    createdAt: nowISO(),
    disabled: false,
    pinned: false,
    hidden: false,
    model,
    provider: provider || '',
    usage,
    reasoning,
    agentRole,
    debugData: debugInfo ?? undefined,
    metadata,
    ...(resolvedPromptMeta ? { promptMeta: resolvedPromptMeta } : {}),
    ...(summaryOf ? { summaryOf } : {}),
    ...(qaPass !== undefined ? { qa_pass: qaPass } : {}),
    ...(qaReason !== undefined ? { qa_reason: qaReason } : {}),
  };

  if (existing) {
    // Шаг 2б: черновик частичного стрима уже в истории — заменяем его
    // финальной версией (id/seq сохраняет порт). `recordActivity` — потому
    // что при создании черновика активность не писалась (streaming).
    const updated = await sessionManager.updateMessage(sessionId, msg, { recordActivity: true });
    if (!updated) {
      // Черновик не найден (удалён/перезаписана история) — безопасный fallback.
      msg.id = generateId();
      msg.seq = 0;
      await sessionManager.addMessage(sessionId, msg);
    }
  } else {
    await sessionManager.addMessage(sessionId, msg);
  }

  // ADR-115 (outbound): сообщение ссылается на объекты вложений — учитываем
  // ссылки, иначе GC удалит их по TTL, а получатель останется без файла.
  // Best-effort: учёт ссылок — производная, он не отменяет сохранение.
  if (extraParts && extraParts.length > 0 && deps.blobRefs) {
    for (const part of extraParts) {
      const data = part?.data as { blobPath?: unknown } | undefined;
      if (!data || typeof data.blobPath !== 'string' || data.blobPath === '') continue;
      try {
        await deps.blobRefs.add({
          blobPath: data.blobPath,
          ownerKind: 'message',
          ownerId: msg.id,
        });
      } catch {
        // учёт ссылок — производная: не роняет ход и не отменяет сообщение
      }
    }
  }

  // ADR-102 §3: шов записи `usage` — значение уже посчитано (usage/model/cost/
  // сабагенты). Best-effort: рекордер не пробрасывает ошибки и не блокирует ход.
  // Числа согласованы с `computeSessionStats`: собственный usage сообщения +
  // usage сабагентов из `metadata.subagents` (их сообщения персистятся мимо
  // этой точки, поэтому двойного счёта нет).
  if (deps.analytics?.enabled) {
    try {
      const analyticsSession = await sessionManager.getSession(sessionId);
      const axes = sessionAxes(analyticsSession);
      const durationMs =
        typeof metadataExtra?.duration_ms === 'number' && Number.isFinite(metadataExtra.duration_ms)
          ? metadataExtra.duration_ms
          : undefined;
      const ownCosts: Record<string, number> = {};
      if (messageCost) ownCosts[messageCost.currency] = messageCost.costUsd;
      const subagentGroups = toolResults && toolResults.length > 0
        ? collectSubagentUsageByModel(
            toolResults,
            (m, u) => computeMessageCost(m, u, deps.modelPriceLoader),
          )
        : [];
      // Собственный ответ — 1 запрос; запросы сабагентов идут в их собственных
      // бакетах ниже (иначе `requests` удвоился бы при группировке по `user`).
      const ownRequests = hasUsageTokens(usage) ? 1 : 0;

      void deps.analytics.recordUsage({
        ...axes,
        ...(model ? { model } : {}),
        ...(agentRole ? { agent: agentRole } : {}),
        usage,
        ...(ownRequests > 0 ? { requests: ownRequests } : {}),
        ...(role === MessageRole.ASSISTANT ? { messages: 1 } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(Object.keys(ownCosts).length > 0 ? { costByCurrency: ownCosts } : {}),
      });

      // Usage сабагентов — отдельные бакеты по своей модели/агенту (ось
      // `model`/`agent` не схлопывается в модель родителя).
      for (const group of subagentGroups) {
        void deps.analytics.recordUsage({
          ...axes,
          ...(group.model ? { model: group.model } : {}),
          ...(group.agent ? { agent: group.agent } : {}),
          usage: group.usage,
          requests: group.sessions,
          ...(Object.keys(group.costByCurrency).length > 0
            ? { costByCurrency: group.costByCurrency }
            : {}),
        });
      }
    } catch {
      // best-effort: аналитика не должна ломать сохранение сообщения
    }
  }
  // Accumulate session token counters and costs
  if (usage) {
    await sessionManager.withLock(sessionId, async (s) => {
      s.inputTokens += usage.inputTokens || 0;
      s.outputTokens += usage.outputTokens || 0;
      s.totalTokens += usage.totalTokens || 0;
      s.cacheReadTokens += usage.cacheReadTokens || 0;
      s.cacheWriteTokens += usage.cacheWriteTokens || 0;
      s.reasoningTokens += usage.reasoningTokens || 0;
      // ADR-070 §2.3: hit rate по накопленным токенам сессии.
      s.cacheHitRate = computeCacheHitRate(s.cacheReadTokens, s.inputTokens);

      // ADR-070 §2.6: единый helper стоимости — тот же, что для per-message.
      const effectiveModel = model || msg.model;
      const cost = effectiveModel
        ? computeUsageCost(usage, deps.modelPriceLoader?.(effectiveModel) ?? null)
        : null;
      if (cost) {
        s.inputCost += cost.breakdown.input;
        s.outputCost += cost.breakdown.output;
        s.cacheReadCost += cost.breakdown.cacheRead;
        s.cacheWriteCost += cost.breakdown.cacheWrite;
      }
      s.updatedAt = nowISO();
      await sessionManager.saveSession(s);
    });
  }

  // Publish message.added for UI
  if (!skipEvent) {
    const session = await sessionManager.getSession(sessionId);
    if (session) {
      deps.eventBus.publish(sessionId, 'message.added', {
        message_index: session.messages.length - 1,
        role: msg.role,
        content: finalContent.slice(0, 500),
        model,
        provider: provider || '',
        agent_role: agentRole,
        reasoning: reasoning || null,
        tool_calls: toolResults && toolResults.length > 0 ? toolResults : null,
        intermediate_text_blocks: intermediateTextBlocks && intermediateTextBlocks.length > 0 ? intermediateTextBlocks : null,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    }
  }

  return finalContent;
}
