import type {
  Message,
  Session,
  SessionAgentStats,
  SessionStats,
  SessionSubagentStats,
  SessionUserStats,
  TokenUsage,
} from '@itphx/synth-shared';
import { MessageRole } from '@itphx/synth-shared';
import { computeCacheHitRate, computeUsageCost, type UsagePricing } from '../providers/usage.js';

/** Максимальная глубина рекурсии по дочерним сессиям саб-агентов. */
export const MAX_SUBAGENT_DEPTH = 5;

export interface SessionStatsDeps {
  /** Чтение сессии по id (обязательно `SessionManager.getSession`). */
  getSession: (sessionId: string) => Promise<Session | null>;
  /** Цены модели (обычно `ChatOrchestrator.getModelPricing`) для `cost_usd`. */
  getModelPricing?: (modelName: string) => UsagePricing | null;
  /**
   * Display name автора user-сообщения (обычно профиль по username).
   * `null`/отсутствие профиля — поле `display_name` не добавляется.
   */
  resolveAuthorName?: (author: string) => Promise<string | null>;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface AgentAccumulator {
  agent_role: string;
  messages: number;
  usage: UsageTotals;
  cost: number;
  durationMs: number;
  subagentSessions: number;
  subagentTokens: number;
}

interface UserAccumulator {
  author: string;
  messages: number;
  usage: UsageTotals;
  cost: number;
}

interface TaskChildRef {
  agentRole: string;
  childSessionId: string;
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addUsage(totals: UsageTotals, usage: TokenUsage | undefined): void {
  if (!usage) return;
  totals.input += usage.inputTokens || 0;
  totals.output += usage.outputTokens || 0;
  totals.cacheRead += usage.cacheReadTokens || 0;
  totals.cacheWrite += usage.cacheWriteTokens || 0;
  totals.reasoning += usage.reasoningTokens || 0;
}

/** Стоимость сообщения: по цене модели, иначе — из `metadata.cost_usd` (AD-070 §2.6). */
function messageCost(msg: Message, getModelPricing?: SessionStatsDeps['getModelPricing']): number {
  if (getModelPricing && msg.usage && msg.model) {
    const cost = computeUsageCost(msg.usage, getModelPricing(msg.model));
    if (cost) return cost.costUsd;
  }
  const metaCost = msg.metadata?.cost_usd;
  return typeof metaCost === 'number' ? metaCost : 0;
}

function messageDuration(msg: Message): number {
  const d = msg.metadata?.duration_ms;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Общее число токенов usage (input + output) — для `subagent_tokens`. */
function totalTokens(session: Session): number {
  let total = 0;
  for (const msg of session.messages) {
    if (!msg.usage) continue;
    total += msg.usage.totalTokens
      || (msg.usage.inputTokens || 0) + (msg.usage.outputTokens || 0);
  }
  return total;
}

/**
 * Извлечь дочерние сессии, созданные tool-вызовом `task` (metadata
 * `child_session_id`). Источники: tool-chain tool-сообщения и финальное
 * assistant-сообщение с `metadata.tool_results`. Дубликаты отбрасываются.
 */
function extractTaskChildren(session: Session): TaskChildRef[] {
  const out: TaskChildRef[] = [];
  const seen = new Set<string>();
  const fallbackRole = session.settings.agentRole || 'unknown';

  const add = (childSessionId: string, agentRole: string): void => {
    if (seen.has(childSessionId)) return;
    seen.add(childSessionId);
    out.push({ agentRole, childSessionId });
  };

  for (const msg of session.messages) {
    const meta = msg.metadata;
    if (!meta) continue;
    const agentRole = msg.agentRole || fallbackRole;

    // tool-chain tool-сообщение: metadata проброшена из tool_result.
    if (typeof meta.child_session_id === 'string' && (meta.tool_name === 'task' || meta.subagent_type)) {
      add(meta.child_session_id, agentRole);
    }

    // финальное assistant-сообщение: metadata.tool_results[].result.metadata.
    const toolResults = meta.tool_results;
    if (Array.isArray(toolResults)) {
      for (const raw of toolResults) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        const resultMeta = (entry.result as { metadata?: Record<string, unknown> } | undefined)?.metadata;
        const childId = resultMeta?.child_session_id;
        if (typeof childId === 'string' && (entry.name === 'task' || resultMeta?.subagent_type)) {
          add(childId, agentRole);
        }
      }
    }
  }

  return out;
}

/** Рекурсивно собрать usage поддерева дочерних сессий (защита от циклов/глубины). */
async function collectSubagentUsage(
  sessionId: string,
  deps: SessionStatsDeps,
  visited: Set<string>,
  depth: number,
): Promise<{ sessions: number; tokens: number; usage: UsageTotals; cost: number }> {
  if (depth > MAX_SUBAGENT_DEPTH) {
    return { sessions: 0, tokens: 0, usage: emptyUsage(), cost: 0 };
  }
  const session = await deps.getSession(sessionId);
  if (!session) return { sessions: 0, tokens: 0, usage: emptyUsage(), cost: 0 };

  let sessions = 1;
  let tokens = totalTokens(session);
  const usage = emptyUsage();
  let cost = 0;
  // Разбивка по всем сообщениям дочерней сессии (та же семантика, что у
  // `totalTokens`, но с детализацией и стоимостью по ценам моделей).
  for (const msg of session.messages) {
    addUsage(usage, msg.usage);
    cost += messageCost(msg, deps.getModelPricing);
  }

  for (const child of extractTaskChildren(session)) {
    if (visited.has(child.childSessionId)) continue;
    visited.add(child.childSessionId);
    const sub = await collectSubagentUsage(child.childSessionId, deps, visited, depth + 1);
    sessions += sub.sessions;
    tokens += sub.tokens;
    usage.input += sub.usage.input;
    usage.output += sub.usage.output;
    usage.cacheRead += sub.usage.cacheRead;
    usage.cacheWrite += sub.usage.cacheWrite;
    usage.reasoning += sub.usage.reasoning;
    cost += sub.cost;
  }
  return { sessions, tokens, usage, cost };
}

/** Агрегация по `agent_role` сообщений сессии + рекурсивный usage саб-агентов. */
function buildAgentStats(
  session: Session,
  getModelPricing?: SessionStatsDeps['getModelPricing'],
): Map<string, AgentAccumulator> {
  const fallbackRole = session.settings.agentRole || 'unknown';
  const agents = new Map<string, AgentAccumulator>();

  const get = (role: string): AgentAccumulator => {
    let acc = agents.get(role);
    if (!acc) {
      acc = {
        agent_role: role,
        messages: 0,
        usage: emptyUsage(),
        cost: 0,
        durationMs: 0,
        subagentSessions: 0,
        subagentTokens: 0,
      };
      agents.set(role, acc);
    }
    return acc;
  };

  for (const msg of session.messages) {
    // Пользовательские и tool-сообщения не принадлежат агенту-генератору.
    if (msg.role === MessageRole.USER || msg.role === MessageRole.TOOL) continue;
    const acc = get(msg.agentRole || fallbackRole);
    // Скрытые промежуточные сообщения tool-chain не считаем за ответ агента.
    if (msg.metadata?.tool_chain !== true) acc.messages += 1;
    addUsage(acc.usage, msg.usage);
    acc.cost += messageCost(msg, getModelPricing);
    acc.durationMs += messageDuration(msg);
  }

  return agents;
}

/** Атрибуция usage автору user-сообщения (до следующего user-сообщения). */
function buildUserStats(
  session: Session,
  getModelPricing?: SessionStatsDeps['getModelPricing'],
): Map<string, UserAccumulator> {
  const users = new Map<string, UserAccumulator>();
  let currentAuthor: string | null = null;

  const get = (author: string): UserAccumulator => {
    let acc = users.get(author);
    if (!acc) {
      acc = { author, messages: 0, usage: emptyUsage(), cost: 0 };
      users.set(author, acc);
    }
    return acc;
  };

  for (const msg of session.messages) {
    if (msg.role === MessageRole.USER) {
      currentAuthor = msg.author || 'unknown';
      get(currentAuthor).messages += 1;
      continue;
    }
    if (!currentAuthor) continue;
    const acc = get(currentAuthor);
    addUsage(acc.usage, msg.usage);
    acc.cost += messageCost(msg, getModelPricing);
  }

  return users;
}

/**
 * AD-070 §2.6: статистика сессии для `GET /api/v2/sessions/:id/stats`.
 *
 * - `agents` — агрегация по `agent_role` сообщений сессии; usage суммируется,
 *   `cost_usd` — по цене модели каждого сообщения, `cache_hit_rate` —
 *   `computeCacheHitRate`, `output_tps` = output / (duration_ms / 1000),
 *   `duration_ms` — сумма длительностей ответов агента. `subagent_*` —
 *   рекурсивно подтянутый usage дочерних сессий tool `task` (глубина ≤ 5,
 *   защита от циклов).
 * - `users` — атрибуция usage автору предыдущего user-сообщения.
 */
export async function computeSessionStats(
  session: Session,
  deps: SessionStatsDeps,
): Promise<SessionStats> {
  const agents = buildAgentStats(session, deps.getModelPricing);
  const users = buildUserStats(session, deps.getModelPricing);

  // Сабагенты: глобальный visited на весь расчёт — каждый ребёнок учитывается
  // один раз, циклы (ребёнок == предок) отсекаются. Параллельно с `subagent_*`
  // в агентах собираем отдельную суммарную разбивку по всем дочерним сессиям.
  const subagents: SessionSubagentStats = {
    sessions: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
  };
  const visited = new Set<string>([session.id]);
  for (const ref of extractTaskChildren(session)) {
    if (visited.has(ref.childSessionId)) continue;
    visited.add(ref.childSessionId);
    const sub = await collectSubagentUsage(ref.childSessionId, deps, visited, 1);
    let acc = agents.get(ref.agentRole);
    if (!acc) {
      acc = {
        agent_role: ref.agentRole,
        messages: 0,
        usage: emptyUsage(),
        cost: 0,
        durationMs: 0,
        subagentSessions: 0,
        subagentTokens: 0,
      };
      agents.set(ref.agentRole, acc);
    }
    acc.subagentSessions += sub.sessions;
    acc.subagentTokens += sub.tokens;
    subagents.sessions += sub.sessions;
    subagents.input_tokens += sub.usage.input;
    subagents.output_tokens += sub.usage.output;
    subagents.cache_read_tokens += sub.usage.cacheRead;
    subagents.cache_write_tokens += sub.usage.cacheWrite;
    subagents.reasoning_tokens += sub.usage.reasoning;
    subagents.cost_usd += sub.cost;
  }

  const agentStats: SessionAgentStats[] = [...agents.values()]
    .map((acc) => ({
      agent_role: acc.agent_role,
      messages: acc.messages,
      input_tokens: acc.usage.input,
      output_tokens: acc.usage.output,
      cache_read_tokens: acc.usage.cacheRead,
      cache_write_tokens: acc.usage.cacheWrite,
      reasoning_tokens: acc.usage.reasoning,
      cost_usd: round(acc.cost, 6),
      cache_hit_rate: computeCacheHitRate(acc.usage.cacheRead, acc.usage.input),
      duration_ms: acc.durationMs,
      output_tps: acc.durationMs > 0 ? round(acc.usage.output / (acc.durationMs / 1000), 2) : 0,
      subagent_sessions: acc.subagentSessions,
      subagent_tokens: acc.subagentTokens,
    }))
    .sort((a, b) => b.messages - a.messages || a.agent_role.localeCompare(b.agent_role));

  // Display name автора: резолвим один раз на автора (кэш), иначе — не добавляем.
  const displayNameCache = new Map<string, string | null>();
  const resolveDisplayName = async (author: string): Promise<string | null> => {
    if (!deps.resolveAuthorName) return null;
    if (displayNameCache.has(author)) return displayNameCache.get(author)!;
    const name = await deps.resolveAuthorName(author);
    displayNameCache.set(author, name);
    return name;
  };

  const userStats: SessionUserStats[] = await Promise.all(
    [...users.values()].map(async (acc) => {
      const displayName = await resolveDisplayName(acc.author);
      return {
        author: acc.author,
        ...(displayName ? { display_name: displayName } : {}),
        messages: acc.messages,
        input_tokens: acc.usage.input,
        output_tokens: acc.usage.output,
        cache_read_tokens: acc.usage.cacheRead,
        cache_write_tokens: acc.usage.cacheWrite,
        reasoning_tokens: acc.usage.reasoning,
        cost_usd: round(acc.cost, 6),
        cache_hit_rate: computeCacheHitRate(acc.usage.cacheRead, acc.usage.input),
      };
    }),
  );

  userStats.sort((a, b) => b.messages - a.messages || a.author.localeCompare(b.author));

  return {
    session_id: session.id,
    agents: agentStats,
    users: userStats,
    subagents: { ...subagents, cost_usd: round(subagents.cost_usd, 6) },
  };
}
