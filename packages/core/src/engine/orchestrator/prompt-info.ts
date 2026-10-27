/**
 * ADR-095 (шаг 6a): read-only диагностика промпта (слой истории, promptMeta,
 * ключ мемоизации инструкций) и маппинг истории в LLM-сообщения.
 *
 * Вынесено из `engine/orchestrator.ts` без изменения поведения. Класс
 * `ChatOrchestrator` сохраняет статический `_sessionMessagesToLlm` и делегации
 * `_buildPromptHistoryInfo`, `_lastPromptMeta`, `_instructionsMemoKey`.
 */
import type { Message, PromptHistoryInfo, PromptHistoryStateMessage, PromptMeta, Session } from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import type { LLMMessage } from '../../providers/base.js';
import { PLACEHOLDER_PATTERN } from '../gateway/index.js';
import { wrapStateContent } from '../context/state-messages.js';
import { suppressDisabledTurns } from '../context/disabled-turns.js';
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from '../context/token-ratio.js';
import { estimateMediaTokens } from '../context/media-tokens.js';
import type { InjectionPolicy } from '../security/prompt-injection.js';

/**
 * Маппинг истории сессии в LLM-сообщения (ADR-070 §2.8, ADR-041, tool-chain).
 *
 * Defensive pairing (фикс «осиротевших» tool): id вызовов, для которых уже
 * выдан assistant с tool_use. Tool-результат валиден только после своего
 * вызова в этой же выдаче; всё остальное (disabled/hidden assistant, или
 * результат без вызова) уходит user-текстом — `tool` без `tool_calls`
 * ломает OpenAI-совместимые API и Anthropic.
 */
export function sessionMessagesToLlm(
  messages: Message[],
  currentAgentRole?: string,
  currentAuthor?: string,
): LLMMessage[] {
  const result: LLMMessage[] = [];

  const emittedToolCallIds = new Set<string>();

  // Атрибуция чужого сообщения: `[agent]: ` / `{author}: ` / `[anonymous]: `.
  const withAttribution = (m: Message): string => {
    if (m.agentRole) return `[${m.agentRole}]: ${m.content}`;
    if (m.author) return `{${m.author}}: ${m.content}`;
    return `[anonymous]: ${m.content}`;
  };

  for (const msg of messages) {
    if (msg.disabled || msg.hidden) continue;

    const role = msg.role;
    if (role === MessageRole.INFO) continue;

    // ADR-070 §2.6 / ADR-041: assistant-сообщение о терминальной ошибке LLM
    // (metadata.status='error') персистится для UI и аудита, но не является
    // частью диалога — не отдаём его модели как обычную реплику assistant,
    // иначе на следующем ходу модель видит собственный «сбой» в контексте.
    if (role === MessageRole.ASSISTANT && msg.metadata?.status === 'error') continue;

    // ADR-070 §2.8: durable state-сообщения хранятся с role system (скрыты в
    // UI), но в LLM-запрос уходят как синтетическое user-сообщение с
    // обёрткой `<system-state>` — Anthropic не принимает role system в
    // messages. Без префикса `[anonymous]`.
    if (role === MessageRole.SYSTEM) {
      const stateType = typeof msg.metadata?.type === 'string' ? msg.metadata.type : 'state';
      result.push({
        id: '',
        role: 'user',
        content: wrapStateContent(stateType, msg.content),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        disabled: false,
        pinned: false,
        branchId: '',
      });
      continue;
    }

    // Сообщение считается «своим», если agentRole не задан (легаси/сабагент —
    // иначе такие assistant порождали бы сирот) или совпадает с активным
    // агентом. User — по автору.
    const isOwnAssistant =
      role === MessageRole.ASSISTANT &&
      (msg.agentRole === undefined || msg.agentRole === currentAgentRole);
    const isOwnUser = role === MessageRole.USER && msg.author === currentAuthor;
    const hasToolCalls =
      role === MessageRole.ASSISTANT && !!msg.toolCalls && msg.toolCalls.length > 0;
    // Tool-результат валиден только в паре с уже выданным assistant(tool_use).
    // Осиротевший результат отдаём user-текстом: `tool` без `tool_calls`
    // ломает OpenAI-совместимые API и Anthropic (`invalid_request_error`:
    // на каждый `tool_result` нужен `tool_use`).
    const isPairedTool =
      role === MessageRole.TOOL && !!msg.toolCallId && emittedToolCallIds.has(msg.toolCallId);

    let content: string;
    let llmRole: string;
    let toolUse: Record<string, unknown>[] | undefined;

    if (hasToolCalls) {
      // Assistant с tool_calls — своего ИЛИ чужого агента — сохраняет
      // структуру вызова (role assistant + toolUse), чтобы парные
      // tool-результаты не осиротели. Чужому агенту добавляем текстовый
      // префикс атрибуции (при пустом content достаточно одних tool_calls).
      llmRole = MessageRole.ASSISTANT;
      toolUse = msg.toolCalls;
      for (const tc of msg.toolCalls ?? []) {
        if (typeof tc.id === 'string') emittedToolCallIds.add(tc.id);
      }
      content = isOwnAssistant || !msg.content
        ? msg.content
        : `[${msg.agentRole}]: ${msg.content}`;
    } else if (isOwnAssistant || isOwnUser || isPairedTool) {
      content = msg.content;
      llmRole = role;
    } else {
      llmRole = 'user';
      content = withAttribution(msg);
    }

    result.push({
      id: '',
      role: llmRole,
      content,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      disabled: false,
      pinned: false,
      branchId: '',
      toolUse,
      toolCallId: isPairedTool ? msg.toolCallId : undefined,
      // Reasoning чужого агента не прокидываем; у tool-сообщений его нет.
      reasoning: isOwnAssistant ? msg.reasoning : undefined,
      agentRole: msg.agentRole,
    });
  }

  return result;
}

/**
 * ADR-090: «вопрос хода» — текст последнего сообщения
 * пользователя (то, по чему идёт retrieval в провайдере блока промпта).
 *
 * Правила:
 * - только сообщения **пользователя** (`role: user`); системные и
 *   state-сообщения (`role: system`, `metadata.state=true`) — не вопрос;
 * - сообщения, выключенные из контекста (`disabled`/`hidden`), не берутся:
 *   в LLM они не уходят, значит и retrieval по ним не идёт;
 * - сначала — сообщение, которым инициирован ход (`ProcessSetupArgs.message`),
 *   затем — последнее пользовательское сообщение истории (на случай, если ход
 *   начат не пользователем: cron/внешнее событие).
 *
 * Текст не логируется и не пишется в состояние промпта — он живёт только в
 * контексте вызова провайдера.
 */
export function resolveTurnQuery(session: Session, message?: Message): string | undefined {
  const candidates: Message[] = [];
  if (message) candidates.push(message);
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]!;
    if (!message || msg.id !== message.id) candidates.push(msg);
  }
  for (const candidate of candidates) {
    const text = userQueryText(candidate);
    if (text) return text;
  }
  return undefined;
}

/** Текст сообщения, если оно является «вопросом хода». */
function userQueryText(message: Message): string | undefined {
  if (message.role !== MessageRole.USER) return undefined;
  if (message.disabled || message.hidden) return undefined;
  if (message.metadata?.state === true) return undefined;
  const text = message.content?.trim();
  return text ? text : undefined;
}

/**
 * ADR-070 §2.5: состав слоя истории (`messages`) — read-only. Зеркалит
 * реальную отправку через тот же `sessionMessagesToLlm`, что и
 * `_processMessage`, чтобы статистика не расходилась с запросом.
 */
export function buildPromptHistoryInfo(
  session: Session,
  agentRole?: string,
  tokenRatio: number = DEFAULT_CHARS_PER_TOKEN,
): PromptHistoryInfo {
  // Отключённая пользовательская реплика выключает весь свой ход — зеркалим
  // то же подавление, что и в реальном ходе (`process-setup`).
  const contextMessages = suppressDisabledTurns(session.messages);
  const sent = sessionMessagesToLlm(contextMessages, agentRole, session.userId);

  // Сообщения: chars = content + JSON(toolUse) + reasoning, estTokens — по
  // калиброванному chars-per-token (как в манифесте промпта).
  let chars = 0;
  let secretPlaceholders = 0;
  const placeholderRe = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  for (const msg of sent) {
    let msgChars = msg.content.length;
    if (msg.toolUse) msgChars += JSON.stringify(msg.toolUse).length;
    if (msg.reasoning) msgChars += msg.reasoning.length;
    chars += msgChars;
    const matches = msg.content.match(placeholderRe);
    if (matches) secretPlaceholders += matches.length;
  }

  // State-сообщения: role system (не disabled/hidden), текст — как уходит в LLM.
  const stateMap = new Map<string, { count: number; chars: number }>();
  for (const msg of contextMessages) {
    if (msg.role !== MessageRole.SYSTEM || msg.disabled || msg.hidden) continue;
    const type = typeof msg.metadata?.type === 'string' ? msg.metadata.type : 'state';
    const entry = stateMap.get(type) ?? { count: 0, chars: 0 };
    entry.count += 1;
    entry.chars += wrapStateContent(type, msg.content).length;
    stateMap.set(type, entry);
  }
  const stateMessages: PromptHistoryStateMessage[] = [...stateMap.entries()]
    .map(([type, v]) => ({
      type,
      count: v.count,
      chars: v.chars,
      estTokens: estimateTokens(v.chars, tokenRatio),
    }))
    .sort((a, b) => b.chars - a.chars || a.type.localeCompare(b.type));

  // Исключённые: ровно то, что отфильтровывает `sessionMessagesToLlm`.
  const excluded = { disabled: 0, hidden: 0, info: 0 };
  for (const msg of contextMessages) {
    if (msg.disabled) excluded.disabled += 1;
    if (msg.hidden) excluded.hidden += 1;
    if (msg.role === MessageRole.INFO) excluded.info += 1;
  }

  // Вложения: нетекстовые части отправляемых сообщений.
  let attachmentCount = 0;
  let attachmentChars = 0;
  // ADR-115: медиа-части стоят модели не по символам, а фиксированными
  // оценками (см. `media-tokens.ts`) — добавляем их к текстовой оценке
  // `messages.estTokens`. Формат `PromptHistoryInfo` не меняется.
  let mediaTokens = 0;
  for (const msg of contextMessages) {
    if (msg.disabled || msg.hidden || msg.role === MessageRole.INFO) continue;
    if (msg.role === MessageRole.ASSISTANT && msg.metadata?.status === 'error') continue;
    mediaTokens += estimateMediaTokens(msg.parts);
    for (const part of msg.parts) {
      if (part.type === 'text') continue;
      attachmentCount += 1;
      const data = part.data === undefined ? '' : JSON.stringify(part.data) ?? '';
      const meta = (part as { metadata?: unknown }).metadata;
      const metaStr = meta === undefined ? '' : JSON.stringify(meta) ?? '';
      attachmentChars += data.length + metaStr.length;
    }
  }

  return {
    messages: {
      count: sent.length,
      chars,
      estTokens: estimateTokens(chars, tokenRatio) + mediaTokens,
    },
    stateMessages,
    excluded,
    attachments: { count: attachmentCount, chars: attachmentChars },
    secretPlaceholders,
  };
}

/** `promptMeta` последнего assistant-сообщения активного агента. */
export function lastPromptMeta(session: Session, agentRole?: string): PromptMeta | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]!;
    if (msg.role !== MessageRole.ASSISTANT || !msg.promptMeta) continue;
    if (agentRole && msg.promptMeta.agentRole && msg.promptMeta.agentRole !== agentRole) continue;
    return msg.promptMeta;
  }
  return null;
}

/** Ключ мемоизации хода — все входы, влияющие на результат резолва инструкций. */
export function instructionsMemoKey(input: {
  workingDir: string;
  contextWindow: number;
  model: string;
  language: string;
  projectId?: string;
  injection: { enabled: boolean; mode: InjectionPolicy };
}): string {
  return JSON.stringify([
    input.workingDir,
    input.model,
    input.contextWindow,
    input.language,
    input.projectId ?? '',
    `${input.injection.enabled ? 1 : 0}:${input.injection.mode}`,
  ]);
}
