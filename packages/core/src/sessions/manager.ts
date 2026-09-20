import type { Session, Message, SessionSettings, Checkpoint, SessionOrigin, SessionReference, McpServerToolSettings } from '@itphx/synth-shared';
import { getForkedTitle, MessageRole } from '@itphx/synth-shared';
import { nowISO, generateId, makeTextPart, makePart } from '@itphx/synth-shared';
import { t as sm, i18n as i18nMeta } from '../engine/system-messages.js';
import type { FileStore } from '../storage/file-store.js';
import { mergeMcpToolSettings } from '../engine/mcp/settings.js';

export interface SessionManagerOptions {
  /** Поставщик глобальных настроек доступности MCP-серверов (runtime settings). */
  mcpSettingsProvider?: () => Promise<Record<string, McpServerToolSettings> | undefined>;
}

export interface SessionTree {
  session: Session | null;
  children: SessionTree[];
}

export class SessionManager {
  private _locks = new Map<string, Promise<void>>();

  constructor(private store: FileStore, private _options: SessionManagerOptions = {}) {}

  private _getLock(sessionId: string): Promise<void> {
    if (!this._locks.has(sessionId)) {
      this._locks.set(sessionId, Promise.resolve());
    }
    return this._locks.get(sessionId)!;
  }

  private _setLock(sessionId: string, promise: Promise<void>): void {
    this._locks.set(sessionId, promise);
  }

  async withLock<T>(sessionId: string, fn: (session: Session) => Promise<T>): Promise<T> {
    const prevLock = this._getLock(sessionId);
    let release: () => void;
    const newLock = new Promise<void>((resolve) => { release = resolve; });
    this._setLock(sessionId, newLock);

    await prevLock;
    try {
      const session = await this.store.load(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      return await fn(session);
    } finally {
      release!();
    }
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.store.load(sessionId);
  }

  async createSession(data: { title?: string; projectId?: string; engine?: string; parentId?: string; sessionOrigin?: SessionOrigin; settings?: Partial<SessionSettings>; userId?: string; ownerId?: string } = {}): Promise<Session> {
    const mcpToolSettings = await this._resolveMcpToolSettings(data.settings?.mcpToolSettings);
    const session: Session = {
      id: generateId(),
      title: data.title || sm('session.default_title'),
      sessionOrigin: data.sessionOrigin || 'user',
      parentId: data.parentId,
      userId: data.userId || '',
      projectId: data.projectId,
      engine: (data.engine || 'synth') as Session['engine'],
      messages: [],
      pendingMessages: [],
      status: {},
      settings: {
        temperature: data.settings?.temperature ?? 0.7,
        maxTokens: data.settings?.maxTokens ?? 4096,
        debugEnabled: data.settings?.debugEnabled ?? true,
        streamEnabled: data.settings?.streamEnabled ?? true,
        contextOptimization: data.settings?.contextOptimization ?? 'none',
        slidingWindowMode: data.settings?.slidingWindowMode ?? 'messages',
        slidingWindowMessageLimit: data.settings?.slidingWindowMessageLimit ?? 10,
        slidingWindowTokenThreshold: data.settings?.slidingWindowTokenThreshold ?? 80,
        summarizationEnabled: data.settings?.summarizationEnabled ?? false,
        summarizationTriggerMode: data.settings?.summarizationTriggerMode ?? 'messages',
        summarizeAfterN: data.settings?.summarizeAfterN ?? 10,
        summarizeTokenThreshold: data.settings?.summarizeTokenThreshold ?? 50,
        summarizationHeadMessages: data.settings?.summarizationHeadMessages ?? 2,
        summarizationTailMessages: data.settings?.summarizationTailMessages ?? 3,
        showInterview: data.settings?.showInterview ?? true,
        websocketEnabled: data.settings?.websocketEnabled ?? true,
        // AD-071 §2.1: активные MCP-серверы сессии. Раньше терялись при создании
        // (`POST /sessions` с `settings.mcpServers`) — сессия теряла их.
        mcpServers: data.settings?.mcpServers,
        provider: data.settings?.provider,
        model: data.settings?.model,
        systemPrompt: data.settings?.systemPrompt,
        agentRole: data.settings?.agentRole,
        language: data.settings?.language,
        planMode: data.settings?.planMode,
        // AD-071 §2.3: per-session override политики инструментов не теряется при создании.
        toolsPolicy: data.settings?.toolsPolicy,
        routingEnabled: data.settings?.routingEnabled ?? false,
        routingStrategy: data.settings?.routingStrategy ?? 'auto',
        routingContent: data.settings?.routingContent ?? { coding: { provider: '', model: '' }, chat: { provider: '', model: '' }, research: { provider: '', model: '' } },
        routingEscalation: data.settings?.routingEscalation ?? { enabled: false, fallbackProvider: '', fallbackModel: '', checks: ['min_length', 'constraint'], minLength: 10 },
        routingCost: data.settings?.routingCost ?? { enabled: false, cheapProvider: '', cheapModel: '', maxCheapTokens: 500 },
        subagentRouting: data.settings?.subagentRouting ?? { enabled: false },
        microFirst: data.settings?.microFirst ?? false,
        microConfidenceThreshold: data.settings?.microConfidenceThreshold ?? 0.8,
        embeddingEnabled: data.settings?.embeddingEnabled ?? false,
        embedProvider: data.settings?.embedProvider ?? 'ollama',
        embedModel: data.settings?.embedModel ?? 'local.nomic-embed-text:latest',
        mcpToolSettings,
      },
      checkpoints: [],
      stickyNotes: [],
      references: [],
      summarizationPending: false,
      canSummarize: false,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      cacheHitRate: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    await this.store.save(session);
    return session;
  }

  private async _resolveMcpToolSettings(
    local?: Record<string, McpServerToolSettings>,
  ): Promise<Record<string, McpServerToolSettings> | undefined> {
    if (!local && !this._options.mcpSettingsProvider) return undefined;
    const global = this._options.mcpSettingsProvider
      ? await this._options.mcpSettingsProvider()
      : undefined;
    return mergeMcpToolSettings(global, local);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
    this._locks.delete(sessionId);
  }

  async listSessions(filter?: { projectId?: string; userId?: string }): Promise<Session[]> {
    if (filter?.userId) return this.store.listForUser(filter.userId);
    return this.store.list(filter);
  }

  async listActiveSessions(): Promise<Session[]> {
    const sessions = await this.listSessions();
    return sessions.filter((s) => s.status.blocked || s.currentStream);
  }

  async updateSession(session: Session): Promise<void> {
    session.updatedAt = nowISO();
    await this.store.save(session);
  }

  async saveSession(session: Session): Promise<void> {
    await this.store.save(session);
  }

  async acquireLock(sessionId: string, processId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      if (session.status.blocked) return false;
      session.status.blocked = processId;
      session.status.blockedAt = nowISO();
      await this.store.save(session);
      return true;
    });
  }

  async releaseLock(sessionId: string, processId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      if (session.status.blocked !== processId) return false;
      session.status.blocked = undefined;
      session.status.blockedAt = undefined;
      await this.store.save(session);
      return true;
    });
  }

  async forceReleaseLock(sessionId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      session.status.blocked = undefined;
      session.status.blockedAt = undefined;
      await this.store.save(session);
      return true;
    });
  }

  async cleanupStaleLocks(timeoutMinutes = 15): Promise<string[]> {
    const sessions = await this.listSessions();
    const stale: string[] = [];
    const now = new Date();

    for (const s of sessions) {
      if (!s.status.blocked) continue;
      if (!s.status.blockedAt) {
        stale.push(s.id);
        await this.forceReleaseLock(s.id);
        continue;
      }
      const blockedAt = new Date(s.status.blockedAt);
      if (now.getTime() - blockedAt.getTime() > timeoutMinutes * 60_000) {
        stale.push(s.id);
        await this.forceReleaseLock(s.id);
      }
    }
    return stale;
  }

  async addMessage(sessionId: string, message: Message): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (!message.id) message.id = generateId();
      if (!message.seq) message.seq = session.messages.length + 1;
      if (!message.origin) message.origin = 'local';
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      session.messages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async addPendingMessage(sessionId: string, message: Message, maxPending = 5): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (session.pendingMessages.length >= maxPending) return null;
      if (!message.id) message.id = generateId();
      if (!message.origin) message.origin = 'local';
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      session.pendingMessages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async createCheckpoint(sessionId: string): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      const checkpoint: Checkpoint = {
        id: generateId(),
        sessionId: session.id,
        messages: JSON.parse(JSON.stringify(session.messages)),
        createdAt: nowISO(),
      };
      session.checkpoints.push(checkpoint);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      const checkpoint = session.checkpoints.find((c) => c.id === checkpointId);
      if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
      session.messages = JSON.parse(JSON.stringify(checkpoint.messages));
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async safeUpdate(sessionId: string, updateFn: (session: Session) => Promise<void> | void): Promise<void> {
    await this.withLock(sessionId, async (stored) => {
      await updateFn(stored);
      stored.updatedAt = nowISO();
      await this.store.save(stored);
    });
  }

  async renameSession(sessionId: string, title: string): Promise<Session | null> {
    return this.withLock(sessionId, async (s) => {
      s.title = title;
      s.updatedAt = nowISO();
      await this.store.save(s);
      return s;
    });
  }

  async getChildren(parentId: string): Promise<Session[]> {
    return this.store.list({ parentId });
  }

  async getSessionTree(rootId: string): Promise<SessionTree> {
    const root = await this.getSession(rootId);
    const children = await this.getChildren(rootId);
    const childTrees = await Promise.all(
      children.map((c) => this.getSessionTree(c.id)),
    );
    return { session: root, children: childTrees };
  }

  async addReference(
    targetSessionId: string,
    sourceSessionId: string,
    options: { label?: string; messageRange?: [number, number]; autoSummarize?: boolean; position?: 'after' | 'before' },
  ): Promise<SessionReference> {
    return this.withLock(targetSessionId, async (target) => {
      const source = await this.getSession(sourceSessionId);
      if (!source) throw new Error(`Source session ${sourceSessionId} not found`);

      const range: [number, number] = options.messageRange || [1, source.messages.length];
      const label = options.label || source.title || sm('session.reference_label');

      let autoSummary: string | undefined;
      if (options.autoSummarize && range[0] <= range[1]) {
        const msgsInRange = source.messages
          .filter((m: Message) => m.seq >= range[0] && m.seq <= range[1] && !m.hidden && !m.disabled);
        autoSummary = msgsInRange
          .map((m: Message) => `[${m.role}]: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`)
          .join(' | ');
      }

      const ref: SessionReference = {
        type: 'session_reference',
        sessionId: sourceSessionId,
        label,
        messageRange: range,
        autoSummary,
        createdAt: nowISO(),
      };

      if (!target.references) target.references = [];
      const existingIdx = target.references.findIndex((r) => r.sessionId === sourceSessionId);
      if (existingIdx >= 0) {
        target.references[existingIdx] = ref;
      } else {
        target.references.push(ref);
      }

      const refMessage: Message = {
        id: generateId(),
        role: MessageRole.INFO,
        seq: target.messages.length + 1,
        origin: 'local',
        parts: [makePart('session_reference', {
          sessionId: ref.sessionId,
          label: ref.label,
          messageRange: ref.messageRange,
          autoSummary: ref.autoSummary,
        })],
        content: sm('session.reference_link', { label, id: sourceSessionId, from: String(range[0]), to: String(range[1]) }),
        createdAt: nowISO(),
        disabled: false,
        pinned: false,
        hidden: false,
        metadata: {
          type: 'session_reference',
          session_id: sourceSessionId,
          i18n: i18nMeta('session.reference_link', { label, id: sourceSessionId, from: String(range[0]), to: String(range[1]) }),
        },
      };
      if (options.position === 'before') {
        target.messages.unshift(refMessage);
      } else {
        target.messages.push(refMessage);
      }
      target.messages.forEach((m, i) => { m.seq = i + 1; });

      target.updatedAt = nowISO();
      await this.store.save(target);
      return ref;
    });
  }

  async batchMessageOperation(
    sessionId: string,
    action: 'pin' | 'toggle' | 'delete',
    indices: number[],
    state?: boolean,
  ): Promise<{ results: Array<{ index: number; success: boolean; state?: boolean }> }> {
    return this.withLock(sessionId, async (session) => {
      const results: Array<{ index: number; success: boolean; state?: boolean }> = [];
      const sorted = action === 'delete'
        ? [...indices].sort((a, b) => b - a)
        : [...indices].sort((a, b) => a - b);

      for (const idx of sorted) {
        const msg = session.messages[idx];
        if (!msg) { results.push({ index: idx, success: false }); continue; }

        if (action === 'pin') {
          msg.pinned = state !== undefined ? state : !msg.pinned;
          results.push({ index: idx, success: true, state: msg.pinned });
        } else if (action === 'toggle') {
          msg.disabled = state !== undefined ? state : !msg.disabled;
          results.push({ index: idx, success: true, state: msg.disabled });
        } else if (action === 'delete') {
          session.messages.splice(idx, 1);
          results.push({ index: idx, success: true });
        }
      }

      session.messages.forEach((m, i) => { m.seq = i + 1; });
      session.updatedAt = new Date().toISOString();
      await this.store.save(session);
      return { results };
    });
  }

  async removeReference(targetSessionId: string, refSessionId: string): Promise<void> {
    return this.withLock(targetSessionId, async (session) => {
      if (session.references) {
        session.references = session.references.filter((r) => r.sessionId !== refSessionId);
      }
      session.messages = session.messages.filter(
        (m) => m.metadata?.type !== 'session_reference' || m.metadata?.session_id !== refSessionId,
      );
      session.updatedAt = nowISO();
      await this.store.save(session);
    });
  }

  async getReferences(sessionId: string): Promise<SessionReference[]> {
    return this.store.getReferences(sessionId);
  }

  async mergeMessages(
    targetSessionId: string,
    sourceSessionId: string,
    options: {
      sourceRange: [number, number];
      position: 'after' | 'before';
      anchorMessageId?: string;
      summarize?: boolean;
    },
  ): Promise<Message[]> {
    return this.withLock(targetSessionId, async (target) => {
      const source = await this.getSession(sourceSessionId);
      if (!source) throw new Error(`Source session ${sourceSessionId} not found`);

      const [fromSeq, toSeq] = options.sourceRange;
      const sourceMsgs = source.messages.filter(
        (m) => m.seq >= fromSeq && m.seq <= toSeq && !m.hidden && !m.disabled,
      );

      if (sourceMsgs.length === 0) return [];

      let messagesToInsert: Message[];
      if (options.summarize) {
        const combined = sourceMsgs.map((m) => `[${m.role}]: ${m.content}`).join('\n\n');
        const summaryMsg: Message = {
          id: generateId(),
          role: MessageRole.SUMMARY,
          seq: 0,
          origin: 'merged',
          sourceMsgId: sourceSessionId,
          parts: [makeTextPart(combined.slice(0, 4000))],
          content: combined.slice(0, 4000),
          createdAt: nowISO(),
          disabled: false,
          pinned: false,
          hidden: false,
          metadata: { type: 'merged_summary', source_session_id: sourceSessionId, source_range: [fromSeq, toSeq] },
        };
        messagesToInsert = [summaryMsg];
      } else {
        messagesToInsert = sourceMsgs.map((m) => ({
          ...structuredClone(m),
          id: generateId(),
          origin: 'merged' as const,
          sourceMsgId: m.id,
          seq: 0,
        }));
      }

      let anchorIdx = target.messages.length;
      if (options.anchorMessageId) {
        const found = target.messages.findIndex((m) => m.id === options.anchorMessageId);
        if (found >= 0) {
          anchorIdx = options.position === 'after' ? found + 1 : found;
        }
      } else if (options.position === 'before') {
        anchorIdx = 0;
      }

      target.messages.splice(anchorIdx, 0, ...messagesToInsert);
      for (let i = 0; i < target.messages.length; i++) {
        const msg = target.messages[i];
        if (msg) msg.seq = i + 1;
      }
      target.updatedAt = nowISO();
      await this.store.save(target);
      return messagesToInsert;
    });
  }

  async forkSession(
    sourceSessionId: string,
    options: { messageId?: string; messageIndex?: number; title?: string; userId?: string; ownerId?: string },
  ): Promise<Session> {
    return this.withLock(sourceSessionId, async (source) => {
      const siblings = await this.getChildren(sourceSessionId);
      const existingTitles = siblings.map((s) => s.title || '');
      const forkedTitle = options.title || getForkedTitle(source.title, existingTitles);

      const forked = await this.createSession({
        title: forkedTitle,
        projectId: source.projectId,
        engine: source.engine,
        sessionOrigin: 'fork' as SessionOrigin,
        parentId: sourceSessionId,
        settings: { ...source.settings },
        userId: options.userId,
        ownerId: options.ownerId,
      });

      const cutoffIdx = options.messageIndex != null
        ? options.messageIndex
        : options.messageId
          ? source.messages.findIndex((m) => m.id === options.messageId)
          : source.messages.length;

      forked.branchPoint = options.messageId
        ?? (options.messageIndex != null && cutoffIdx >= 0 ? source.messages[cutoffIdx]?.id : undefined);

      const includeBranchMsg = cutoffIdx >= 0 && source.messages[cutoffIdx]?.role === MessageRole.ASSISTANT;
      const allSourceMsgs = cutoffIdx >= 0
        ? source.messages.slice(0, cutoffIdx + (includeBranchMsg ? 1 : 0))
        : [...source.messages];

      // Копируем только не скрытые и не отключенные сообщения
      const msgsToCopy = allSourceMsgs.filter((m) => !m.hidden && !m.disabled);

      forked.messages = msgsToCopy.map((m, i) => ({
        ...structuredClone(m),
        id: generateId(),
        seq: i + 1,
        origin: 'inherited' as const,
        sourceMsgId: m.id,
      }));

      // Копируем активные заметки родительской сессии
      forked.stickyNotes = source.stickyNotes
        .filter((n) => !n.disabled)
        .map((n) => ({ ...structuredClone(n), id: generateId() }));

      forked.pendingMessages = [];

      await this.store.save(forked);
      return forked;
    });
  }
}
