import type { Session, TsmState, Message, SessionSettings, Checkpoint } from '@synth/shared';
import { TsmState as TsmStateEnum } from '@synth/shared';
import { nowISO, generateId } from '@synth/shared';
import type { FileStore } from '../storage/file-store.js';

const VALID_TSM_TRANSITIONS: Record<TsmState, TsmState[]> = {
  [TsmStateEnum.PLANNING]: [TsmStateEnum.EXECUTION],
  [TsmStateEnum.EXECUTION]: [TsmStateEnum.VALIDATION, TsmStateEnum.PLANNING],
  [TsmStateEnum.VALIDATION]: [TsmStateEnum.DONE, TsmStateEnum.EXECUTION],
  [TsmStateEnum.DONE]: [],
};

export class SessionManager {
  private _locks = new Map<string, Promise<void>>();

  constructor(private store: FileStore) {}

  private _getLock(sessionId: string): Promise<void> {
    if (!this._locks.has(sessionId)) {
      this._locks.set(sessionId, Promise.resolve());
    }
    return this._locks.get(sessionId)!;
  }

  private _setLock(sessionId: string, promise: Promise<void>): void {
    this._locks.set(sessionId, promise);
  }

  // Атомарный read-modify-write (как в Python AD-013)
  async withLock<T>(sessionId: string, fn: (session: Session) => Promise<T>): Promise<T> {
    const prevLock = this._getLock(sessionId);
    let release: () => void;
    const newLock = new Promise<void>((resolve) => { release = resolve; });
    this._setLock(sessionId, newLock);

    await prevLock; // дождаться предыдущей операции
    try {
      const session = await this.store.load(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      return await fn(session);
    } finally {
      release!();
    }
  }

  // CRUD

  async getSession(sessionId: string): Promise<Session | null> {
    return this.store.load(sessionId);
  }

  async createSession(data: { title?: string; projectId?: string; engine?: string; settings?: Partial<SessionSettings> } = {}): Promise<Session> {
    const session: Session = {
      id: generateId(),
      title: data.title,
      userId: '',
      projectId: data.projectId,
      engine: (data.engine || 'synth') as Session['engine'],
      messages: [],
      pendingMessages: [],
      status: {
        state: TsmStateEnum.PLANNING,
        iteration: 0,
        validationAttempts: 0,
        taskName: '',
      },
      settings: {
        temperature: data.settings?.temperature ?? 0.7,
        maxTokens: data.settings?.maxTokens ?? 4096,
        debugEnabled: data.settings?.debugEnabled ?? true,
        streamEnabled: data.settings?.streamEnabled ?? true,
        tsmMode: data.settings?.tsmMode ?? 'simple',
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
        provider: data.settings?.provider,
        model: data.settings?.model,
        systemPrompt: data.settings?.systemPrompt,
        agentRole: data.settings?.agentRole,
        language: data.settings?.language,
      },
      branches: [],
      checkpoints: [],
      stickyNotes: [],
      summarizationPending: false,
      canSummarize: false,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
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

  // Блокировки (AD-013)

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

  // Сообщения

  async addMessage(sessionId: string, message: Message): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      session.messages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  async addPendingMessage(sessionId: string, message: Message, maxPending = 5): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (session.pendingMessages.length >= maxPending) return null;
      session.pendingMessages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  // TSM

  async updateTsmState(sessionId: string, newState: TsmState): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      const valid = VALID_TSM_TRANSITIONS[session.status.state as TsmState] || [];
      if (!valid.includes(newState)) throw new Error(`Invalid TSM transition: ${session.status.state} → ${newState}`);
      session.status.state = newState;
      if (newState === 'execution') {
        session.status.iteration += 1;
      }
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  // Checkpoints

  async createCheckpoint(sessionId: string): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      const checkpoint: Checkpoint = {
        id: generateId(),
        sessionId: session.id,
        messages: JSON.parse(JSON.stringify(session.messages)),
        tsmState: session.status.state as TsmState,
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
      session.status.state = checkpoint.tsmState;
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  // Safe update (сохраняет pending_messages из хранилища — AD-013)
  async safeUpdate(sessionId: string, updateFn: (session: Session) => Promise<void> | void): Promise<void> {
    await this.withLock(sessionId, async (stored) => {
      if (stored.pendingMessages.length > 0) {
        // merge свежие pending_messages с хранилища
        const fresh = await this.store.load(sessionId);
        if (fresh?.pendingMessages.length) {
          stored.pendingMessages = fresh.pendingMessages;
        }
      }
      await updateFn(stored);
      stored.updatedAt = nowISO();
      await this.store.save(stored);
    });
  }
}
