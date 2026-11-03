import { randomUUID } from 'node:crypto';
import type { Session, Message, SessionSettings, Checkpoint, SessionOrigin, SessionReference, McpServerToolSettings, Project, ContextDefaults } from '@itphx/synth-shared';
import { getForkedTitle, MessageRole, MAX_STEER_INJECTIONS_PER_TURN, orderSteerInjections, isDefaultTitle } from '@itphx/synth-shared';
import { nowISO, generateId, makeTextPart, makePart, stripNullBytes, stripNullBytesDeep } from '@itphx/synth-shared';
import { t as sm, i18n as i18nMeta } from '../engine/system-messages.js';
import type { SessionRepository } from '../storage/ports/session-repository.js';
import type { ProjectRepository } from '../storage/ports/project-repository.js';
import { nextOrd } from '../storage/message-write.js';
import type { HookBus } from '../engine/hooks/hook-bus.js';
import { mergeMcpToolSettings } from '../engine/mcp/settings.js';
import type { ActivityMeasure, AnalyticsRecorder } from '../analytics/recorder.js';
import { activityMeasureForMessage, sessionAxes } from '../analytics/recorder.js';

/** Структурный контракт загрузки проекта (для снапшотов скоупа). */
export type SessionProjectStoreLike = Pick<ProjectRepository, 'load'>;

export interface SessionManagerOptions {
  /** Поставщик глобальных настроек доступности MCP-серверов (runtime settings). */
  mcpSettingsProvider?: () => Promise<Record<string, McpServerToolSettings> | undefined>;
  /** ADR-071 §2.4 / ADR-046 §4.5: загрузка проекта — снапшот `defaultOn` при создании сессии. */
  projectStore?: SessionProjectStoreLike;
  /**
   * ADR-071 §2.4 / ADR-046 §4.5: системные дефолты для сессий БЕЗ проекта —
   * снапшоты `mcpDefaultOn`/`skillsDefaultOn` при создании.
   */
  systemDefaultsProvider?: () => Promise<{ mcpDefaultOn?: string[]; skillsDefaultOn?: string[] } | undefined>;
  /**
   * ADR-030: ядровая шина хуков — `session_start` (создание) и `session_end`
   * (удаление). Не задана — эмиты не выполняются, поведение менеджера не меняется.
   */
  hooks?: HookBus;
  /**
   * ADR-102: сборщик аналитики — точка персиста сообщения инкрементирует
   * `messages_assistant`/`messages_tool` (семейство `activity`). Не задан —
   * запись не выполняется (поведение прежнее).
   */
  analytics?: AnalyticsRecorder;
  /**
   * Instance-wide дефолты оптимизации контекста для **новых** сессий
   * (`context.defaults`, runtime-патч поверх config). Геттер читается при
   * создании; явные `settings` запроса всегда приоритетнее.
   */
  contextDefaults?: () => Partial<ContextDefaults>;
  /**
   * Идентификатор процесса инстанса — владелец маркеров хода/блокировки
   * (`currentStream.owner`/`status.blockedOwner`). По умолчанию новый UUID на
   * процесс; тесты могут зафиксировать значение, чтобы отличать «свой» ход
   * от оставшегося после рестарта.
   */
  instanceId?: string;
}

export interface SessionTree {
  session: Session | null;
  children: SessionTree[];
}

/**
 * Санитизация нового сообщения перед записью: PostgreSQL не принимает U+0000
 * ни в `text`, ни в `jsonb`, поэтому NUL-байты удаляются в доменном слое —
 * одинаково для file/memory/postgres backend'ов (история/UI тоже чистая).
 */
function sanitizeMessageNullBytes(message: Message): Message {
  if (typeof message.content === 'string') message.content = stripNullBytes(message.content);
  if (typeof message.reasoning === 'string') message.reasoning = stripNullBytes(message.reasoning);
  if (message.parts) message.parts = stripNullBytesDeep(message.parts);
  if (message.toolCalls) message.toolCalls = stripNullBytesDeep(message.toolCalls);
  if (message.metadata) message.metadata = stripNullBytesDeep(message.metadata);
  if (message.debugData) message.debugData = stripNullBytesDeep(message.debugData);
  if (message.promptMeta) message.promptMeta = stripNullBytesDeep(message.promptMeta);
  return message;
}

/**
 * Лёгкая проекция «свои сессии» (паритет с `listForUser`): владелец задан в
 * `userId`/`ownerIds`. Применяется к лёгкому списку (`listLight`), где сообщения
 * не нужны.
 */
function filterByUser(sessions: Session[], userId: string, ownerIds: string[]): Session[] {
  const ids = new Set<string>([userId, ...ownerIds]);
  return sessions.filter(
    (s) => (s.userId !== undefined && ids.has(s.userId))
      || (s.ownerId !== undefined && ids.has(s.ownerId)),
  );
}

/**
 * Лёгкая проекция «свои + сессии проектов участия» (паритет с `listForUserScope`,
 * ADR-089).
 */
function filterByUserScope(
  sessions: Session[],
  userId: string,
  projectIds: string[],
  ownerIds: string[],
): Session[] {
  const ids = new Set<string>([userId, ...ownerIds]);
  return sessions.filter(
    (s) => (s.userId !== undefined && ids.has(s.userId))
      || (s.ownerId !== undefined && ids.has(s.ownerId))
      || (s.projectId !== undefined && projectIds.includes(s.projectId)),
  );
}

export class SessionManager {
  private _locks = new Map<string, Promise<void>>();
  /** Идентификатор процесса-владельца маркеров хода/блокировки. */
  readonly instanceId: string;

  constructor(private store: SessionRepository, private _options: SessionManagerOptions = {}) {
    this.instanceId = _options.instanceId ?? randomUUID();
  }

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

  async createSession(data: { title?: string; icon?: string; color?: string; projectId?: string; parentId?: string; sessionOrigin?: SessionOrigin; settings?: Partial<SessionSettings>; userId?: string; ownerId?: string; expiresAt?: string } = {}): Promise<Session> {
    const mcpToolSettings = await this._resolveMcpToolSettings(data.settings?.mcpToolSettings);
    // Дефолты инстанса для новых сессий (`context.defaults` + runtime). Явные
    // настройки запроса (`data.settings.*`) всегда приоритетнее.
    const contextDefaults = this._options.contextDefaults?.() ?? {};
    const session: Session = {
      id: generateId(),
      title: data.title || sm('session.default_title'),
      icon: data.icon,
      color: data.color,
      sessionOrigin: data.sessionOrigin || 'user',
      parentId: data.parentId,
      userId: data.userId || '',
      // ADR-075/D5: владелец сессии нужен для атрибуции при RBAC проектных данных
      // (plan_write). Раньше поле объявлялось, но не проставлялось.
      ownerId: data.ownerId || data.userId || '',
      projectId: data.projectId,
      messages: [],
      pendingMessages: [],
      status: {},
      settings: {
        // undefined = дефолт модели (см. SessionSettings.temperature).
        temperature: data.settings?.temperature,
        // ADR-117: тир размышлений модели (`reasoning_effort`/`thinking`/`think`)
        // не теряется при создании — иначе `POST /sessions` с `reasoningLevel`
        // не применял effort до `PATCH`.
        reasoningLevel: data.settings?.reasoningLevel,
        // ADR-117: явный тир усилия (effort) — `xhigh`/`max` не выводятся из
        // `reasoningLevel`; без проброса в whitelist они терялись бы при
        // создании (`POST /sessions`, дочерняя сессия саб-агента).
        effort: data.settings?.effort,
        maxTokens: data.settings?.maxTokens ?? 0,
        debugEnabled: data.settings?.debugEnabled ?? true,
        streamEnabled: data.settings?.streamEnabled ?? true,
        contextOptimization: data.settings?.contextOptimization ?? contextDefaults.contextOptimization ?? 'none',
        slidingWindowMode: data.settings?.slidingWindowMode ?? contextDefaults.slidingWindowMode ?? 'messages',
        slidingWindowMessageLimit: data.settings?.slidingWindowMessageLimit ?? contextDefaults.slidingWindowMessageLimit ?? 10,
        slidingWindowTokenThreshold: data.settings?.slidingWindowTokenThreshold ?? contextDefaults.slidingWindowTokenThreshold ?? 80,
        summarizationEnabled: data.settings?.summarizationEnabled ?? contextDefaults.summarizationEnabled ?? false,
        summarizationTriggerMode: data.settings?.summarizationTriggerMode ?? contextDefaults.summarizationTriggerMode ?? 'messages',
        summarizeAfterN: data.settings?.summarizeAfterN ?? contextDefaults.summarizeAfterN ?? 10,
        summarizeTokenThreshold: data.settings?.summarizeTokenThreshold ?? contextDefaults.summarizeTokenThreshold ?? 50,
        summarizationHeadMessages: data.settings?.summarizationHeadMessages ?? contextDefaults.summarizationHeadMessages ?? 2,
        summarizationTailMessages: data.settings?.summarizationTailMessages ?? contextDefaults.summarizationTailMessages ?? 3,
        summarizationKeepTokens: data.settings?.summarizationKeepTokens ?? contextDefaults.summarizationKeepTokens ?? 5000,
        compactionKeepTokens: data.settings?.compactionKeepTokens ?? contextDefaults.compactionKeepTokens ?? 15000,
        compactionTokenThreshold: data.settings?.compactionTokenThreshold ?? contextDefaults.compactionTokenThreshold ?? 85,
        showInterview: data.settings?.showInterview ?? true,
        websocketEnabled: data.settings?.websocketEnabled ?? true,
        // ADR-071 §2.1: активные MCP-серверы сессии. Раньше терялись при создании
        // (`POST /sessions` с `settings.mcpServers`) — сессия теряла их.
        mcpServers: data.settings?.mcpServers,
        // ADR-071 §2.4: явные opt-out сессии (включая системные) не теряются.
        mcpDisabledServers: data.settings?.mcpDisabledServers,
        // ADR-046 §4.5: session-level overrides скиллов (ранее терялись при создании).
        skills: data.settings?.skills,
        skillsDisabled: data.settings?.skillsDisabled,
        provider: data.settings?.provider,
        model: data.settings?.model,
        systemPrompt: data.settings?.systemPrompt,
        agentRole: data.settings?.agentRole,
        language: data.settings?.language,
        planMode: data.settings?.planMode,
        // ADR-071 §2.3: per-session override политик встроенных/MCP-инструментов
        // не теряется при создании.
        toolsPolicy: data.settings?.toolsPolicy,
        mcpPolicy: data.settings?.mcpPolicy,
        // ADR-029: per-session override гранулярных permissions не теряется при
        // создании. Раньше опускался в whitelist — none-режим саб-агента (создание
        // через `createSession`/funnel) терял унаследованные от родителя правила, а
        // resume (`child.settings.permission ?? deps.permissionConfig`) брал
        // глобальный конфиг вместо родительского.
        permission: data.settings?.permission,
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
      // ADR-089: ephemeral-сессия архивируется sweeper'ом по `expiresAt`.
      expiresAt: data.expiresAt,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    // ADR-071 §2.4 / ADR-046 §4.5: снапшоты скоупа на момент создания сессии.
    await this._materializeScopeSnapshots(session, data.projectId, data.settings);
    await this.store.save(session);
    // ADR-030: `session_start` — неблокирующий эмит после сохранения сессии.
    this._options.hooks?.emitAsync('session_start', {
      sessionId: session.id,
      ...(data.projectId ? { projectId: data.projectId } : {}),
      ...(session.settings.agentRole ? { agent: session.settings.agentRole } : {}),
      // ADR-102: ось `user` для сборщика `activity` — значение уже под рукой.
      ...(session.userId ? { userId: session.userId } : {}),
    });
    return session;
  }

  /**
   * ADR-071 §2.4 / ADR-046 §4.5: материализует `mcpDefaultOn`/`skillsDefaultOn`
   * сессии из `project.defaultOn` (или системного дефолта, если проекта нет).
   * Явно переданные в `settings` значения не перетираются. Не заданы нигде —
   * остаются `undefined` (legacy-режим каталога до миграции).
   */
  private async _materializeScopeSnapshots(
    session: Session,
    projectId: string | undefined,
    settings?: Partial<SessionSettings>,
  ): Promise<void> {
    let mcpDefaultOn = settings?.mcpDefaultOn;
    let skillsDefaultOn = settings?.skillsDefaultOn;
    if (mcpDefaultOn !== undefined && skillsDefaultOn !== undefined) {
      session.settings.mcpDefaultOn = mcpDefaultOn;
      session.settings.skillsDefaultOn = skillsDefaultOn;
      return;
    }

    let project: Project | null = null;
    if (projectId && this._options.projectStore) {
      project = await this._options.projectStore.load(projectId).catch(() => null);
    }
    if (project) {
      if (mcpDefaultOn === undefined) mcpDefaultOn = project.mcp?.defaultOn;
      if (skillsDefaultOn === undefined) skillsDefaultOn = project.skills?.defaultOn;
    }
    if ((mcpDefaultOn === undefined || skillsDefaultOn === undefined) && this._options.systemDefaultsProvider) {
      const systemDefaults = await this._options.systemDefaultsProvider().catch(() => undefined);
      if (mcpDefaultOn === undefined) mcpDefaultOn = systemDefaults?.mcpDefaultOn;
      if (skillsDefaultOn === undefined) skillsDefaultOn = systemDefaults?.skillsDefaultOn;
    }
    if (mcpDefaultOn !== undefined) session.settings.mcpDefaultOn = mcpDefaultOn;
    if (skillsDefaultOn !== undefined) session.settings.skillsDefaultOn = skillsDefaultOn;
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
    // ADR-030: `session_end` — неблокирующий эмит после удаления сессии.
    this._options.hooks?.emitAsync('session_end', { sessionId });
  }

  /**
   * Список сессий — **всегда лёгкий** (метаданные без истории, ADR-096).
   *
   * Полная история списком **не отдаётся**: `GET /api/v2/sessions` для
   * ADMIN/LEAD грузил все сессии со всей историей → пик heap и OOM на входе
   * (решение владельца: полный список не отдаём, только постранично и без
   * истории). Очередь (`pendingMessages`) при этом сохраняется — она мала и
   * нужна recovery/автозапуску.
   *
   * За полной историей — только экспорт/публикация проекта:
   * {@link SessionManager.listSessionsWithMessages}.
   */
  async listSessions(
    filter?: { projectId?: string; userId?: string; projectIds?: string[]; ownerIds?: string[] },
    options?: { includeArchived?: boolean },
  ): Promise<Session[]> {
    const sessions = await this._listLight(filter);
    // ADR-089: архивированные сессии скрыты из списков по умолчанию (доступ — getSession по id).
    if (options?.includeArchived) return sessions;
    return sessions.filter((s) => !s.archivedAt);
  }

  /**
   * Список сессий **с историей** (`messages`/`checkpoints`) — только для
   * экспорта/публикации/переноса проекта (ADR-091 §6, ADR-042).
   *
   * Вызывающий обязан понимать цену вызова: выборка тянет полные истории всех
   * подходящих сессий. Для обычных списков (UI, метрики, recovery, события
   * проекта) используется {@link SessionManager.listSessions} — он всегда лёгкий.
   */
  async listSessionsWithMessages(
    filter?: { projectId?: string; userId?: string; projectIds?: string[]; ownerIds?: string[] },
    options?: { includeArchived?: boolean },
  ): Promise<Session[]> {
    const sessions = await this._listFull(filter);
    if (options?.includeArchived) return sessions;
    return sessions.filter((s) => !s.archivedAt);
  }

  /**
   * Лёгкая выборка (метаданные без истории): «свои/проектные» проекции
   * считаются в памяти — семантика идентична `listForUser`/`listForUserScope`,
   * но без загрузки `messages`/`checkpoints`.
   */
  private async _listLight(
    filter?: { projectId?: string; userId?: string; projectIds?: string[]; ownerIds?: string[] },
  ): Promise<Session[]> {
    // ADR-089: `projectIds` — командная видимость (свои + сессии проектов-участий),
    // `userId` — только свои. Оба заданы — `projectIds` приоритетнее (он шире).
    // `ownerIds` — доп. id владельца (standalone: legacy-UUID профиля `local`,
    // нормализованный при чтении, ADR-089).
    if (filter?.projectIds) {
      return filterByUserScope(
        await this.store.listLight(),
        filter.userId ?? '',
        filter.projectIds,
        filter.ownerIds ?? [],
      );
    }
    if (filter?.userId) {
      return filterByUser(await this.store.listLight(), filter.userId, filter.ownerIds ?? []);
    }
    return this.store.listLight(filter);
  }

  /** Полная выборка (с историей) — только для экспорта/публикации. */
  private async _listFull(
    filter?: { projectId?: string; userId?: string; projectIds?: string[]; ownerIds?: string[] },
  ): Promise<Session[]> {
    if (filter?.projectIds) {
      return this.store.listForUserScope(filter.userId ?? '', filter.projectIds, filter.ownerIds);
    }
    if (filter?.userId) {
      return this.store.listForUser(filter.userId, filter.ownerIds);
    }
    return this.store.list(filter);
  }

  async listActiveSessions(options?: { includeArchived?: boolean }): Promise<Session[]> {
    // Лёгкая выборка: нужны только `status.blocked`/`currentStream` (без истории).
    const sessions = await this.listSessions(undefined, { ...options });
    return sessions.filter((s) => s.status.blocked || s.currentStream);
  }

  /**
   * ADR-089: архивирует сессию (идемпотентно). Уже архивированная или
   * отсутствующая — `null`. Успешный архив эмитит `session_end` (ADR-030).
   */
  async archiveSession(sessionId: string): Promise<Session | null> {
    const session = await this.store.load(sessionId);
    if (!session || session.archivedAt) return null;
    session.archivedAt = nowISO();
    session.updatedAt = nowISO();
    await this.store.save(session);
    // ADR-102: `archived:true` отличает архив от удаления (мера `sessions_archived`).
    this._options.hooks?.emitAsync('session_end', {
      sessionId,
      archived: true,
      ...sessionAxes(session),
    });
    return session;
  }

  /**
   * ADR-089: архивирует все ephemeral-сессии с истёкшим `expiresAt`
   * (`expiresAt <= now`, `archivedAt` не задан). Возвращает id архивированных.
   */
  async archiveExpired(now: Date = new Date()): Promise<string[]> {
    // Лёгкая выборка: нужны только `expiresAt`/`archivedAt`; архивация подгружает
    // сессию целиком (`archiveSession` → `store.load`), поэтому история не теряется.
    const sessions = await this.listSessions(undefined, { includeArchived: true });
    const archived: string[] = [];
    for (const session of sessions) {
      if (!session.expiresAt || session.archivedAt) continue;
      const expiresAt = Date.parse(session.expiresAt);
      if (Number.isNaN(expiresAt) || expiresAt > now.getTime()) continue;
      const result = await this.archiveSession(session.id);
      if (result) archived.push(session.id);
    }
    return archived;
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
      session.status.blockedOwner = this.instanceId;
      await this.store.save(session);
      return true;
    });
  }

  async releaseLock(sessionId: string, processId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      if (session.status.blocked !== processId) return false;
      session.status.blocked = undefined;
      session.status.blockedAt = undefined;
      session.status.blockedOwner = undefined;
      await this.store.save(session);
      return true;
    });
  }

  async forceReleaseLock(sessionId: string): Promise<boolean> {
    return this.withLock(sessionId, async (session) => {
      session.status.blocked = undefined;
      session.status.blockedAt = undefined;
      session.status.blockedOwner = undefined;
      await this.store.save(session);
      return true;
    });
  }

  async cleanupStaleLocks(timeoutMinutes = 15): Promise<string[]> {
    // ADR-089: архивированные сессии тоже могут держать устаревший lock — проходим все.
    // Лёгкая выборка: нужен только `status.blocked`/`blockedAt`.
    const sessions = await this.listSessions(undefined, { includeArchived: true });
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

  /**
   * Снять маркеры хода/блокировки, оставшиеся от прошлых процессов.
   *
   * Процесс, убитый при rolling update/рестарте, не успевает убрать
   * `currentStream`/`status.blocked` — процессор очереди такую сессию считает
   * занятой и не стартует, а UI вечно показывает активность. Маркер считается
   * чужим, если его `owner` (`currentStream.owner`/`status.blockedOwner`) не
   * совпадает с `instanceId` этого процесса; отсутствие owner — legacy-запись,
   * тоже чужая.
   *
   * Для каждой такой сессии: под `withLock` снимаются маркеры и состояния
   * отмены/ретрая, затем **вне лока** вызывается `recoverStreamingMessages`
   * (он сам берёт лок — вкладывать нельзя). Возвращаются прежние
   * `turnId`/`streamId` — для события `turn.finished` в UI.
   *
   * Живой ход своего процесса (owner === instanceId) не трогается.
   */
  async recoverInterruptedSessions(): Promise<Array<{
    sessionId: string;
    turnId?: string;
    streamId?: string;
    resumeMessage?: Message;
    pendingLeft: number;
  }>> {
    const sessions = await this.listSessions(undefined, { includeArchived: true });
    const recovered: Array<{
      sessionId: string;
      turnId?: string;
      streamId?: string;
      resumeMessage?: Message;
      pendingLeft: number;
    }> = [];

    for (const listed of sessions) {
      const streamStale = !!listed.currentStream && listed.currentStream.owner !== this.instanceId;
      const blockedStale = !!listed.status.blocked && listed.status.blockedOwner !== this.instanceId;
      if (!streamStale && !blockedStale) continue;

      let turnId: string | undefined;
      let streamId: string | undefined;
      let resumeMessage: Message | undefined;
      let pendingLeft = 0;
      let changed = false;
      let ownLiveStream = false;

      try {
        await this.withLock(listed.id, async (session) => {
          // Перепроверяем под локом: за время обхода список мог устареть, а
          // ход — смениться (в т.ч. на собственный).
          const staleStream = !!session.currentStream && session.currentStream.owner !== this.instanceId;
          const staleBlocked = !!session.status.blocked && session.status.blockedOwner !== this.instanceId;
          if (!staleStream && !staleBlocked) {
            ownLiveStream = !!session.currentStream;
            pendingLeft = session.pendingMessages.length;
            return;
          }
          changed = true;
          if (staleStream && session.currentStream) {
            turnId = session.currentStream.turnId;
            streamId = session.currentStream.streamId;
            session.currentStream = undefined;
          }
          if (session.currentStream) ownLiveStream = true;
          if (staleBlocked) {
            session.status.blocked = undefined;
            session.status.blockedAt = undefined;
            session.status.blockedOwner = undefined;
          } else if (!session.status.blocked) {
            // Блокировки нет — владелец не имеет смысла (например, сняли
            // маркер напрямую, не тронув `blockedOwner`).
            session.status.blockedOwner = undefined;
          }
          session.status.cancelRequested = undefined;
          session.status.cancelRequestedAt = undefined;
          session.retry = undefined;

          // In-flight сообщение прерванного хода: забираем из очереди (оно уже
          // взято в работу — в очереди ему не место) либо, если очередь его не
          // содержит, берём user-копию из истории. Процессор получит копию как
          // `resumeMessage`; в историю повторно она не пишется (Phase 1 дедуп
          // по `stream_id`). Флаг `resumed` — чтобы не эмитить `message_received`.
          if (staleStream && streamId) {
            const pendingIdx = session.pendingMessages.findIndex(
              (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
            );
            const source = pendingIdx >= 0
              ? session.pendingMessages.splice(pendingIdx, 1)[0]
              : [...session.messages].reverse().find(
                (m) => m.role === MessageRole.USER && m.metadata?.stream_id === streamId,
              );
            if (source) {
              resumeMessage = {
                ...source,
                metadata: { ...(source.metadata ?? {}), resumed: true },
              };
            }
          }

          pendingLeft = session.pendingMessages.length;
          session.updatedAt = nowISO();
          await this.store.save(session);
        });
      } catch {
        // Сессия могла быть удалена — пропускаем, восстановление best-effort.
        continue;
      }

      if (!changed) continue;
      // Сообщения «живого стрима» помечаем прерванными только если своего
      // живого хода в сессии нет (иначе погасили бы его сегменты).
      if (!ownLiveStream) {
        await this.recoverStreamingMessages(listed.id);
      }
      recovered.push({
        sessionId: listed.id,
        ...(turnId ? { turnId } : {}),
        ...(streamId ? { streamId } : {}),
        ...(resumeMessage ? { resumeMessage } : {}),
        pendingLeft,
      });
    }

    return recovered;
  }

  /**
   * Забрать из очереди первое сообщение, если оно **уже материализовано в
   * истории** — это in-flight ход, переживший рестарт.
   *
   * Сценарий: прошлый recovery уже снял `currentStream`/`blocked`, но исходное
   * сообщение осталось одновременно в истории и в `pendingMessages`. Обычный
   * автозапуск очереди обработал бы его как новую работу — без info-блока и без
   * `resumed`-метки (повторная материализация в историю/`message_received`).
   * Поэтому сообщение снимается из очереди и возвращается **копией** с
   * `metadata.resumed: true` — процессор обработает его как resume.
   *
   * Признак in-flight: первое pending-сообщение (роль `user`) совпадает с
   * user-сообщением истории по `id` либо по непустому `stream_id`. Нет
   * совпадения — это обычная очередь: `undefined`, `pendingMessages` не трогаем.
   * История и `queueStopped` не меняются; повторный вызов идемпотентен.
   */
  async takePendingInFlight(sessionId: string): Promise<Message | undefined> {
    return this.withLock(sessionId, async (session) => {
      const first = session.pendingMessages[0];
      if (!first) return undefined;
      const streamId = first.metadata?.stream_id as string | undefined;
      const alreadyInHistory = session.messages.some((m) => {
        if (m.role !== MessageRole.USER) return false;
        if (first.id && m.id === first.id) return true;
        return !!streamId && m.metadata?.stream_id === streamId;
      });
      if (!alreadyInHistory) return undefined;
      session.pendingMessages.splice(0, 1);
      session.updatedAt = nowISO();
      await this.store.save(session);
      return {
        ...first,
        metadata: { ...(first.metadata ?? {}), resumed: true },
      };
    });
  }

  async addMessage(sessionId: string, message: Message): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (!message.id) message.id = generateId();
      if (!message.seq) message.seq = session.messages.length + 1;
      if (!message.origin) message.origin = 'local';
      // ADR-118 §2: `ord` — монотонный счётчик сессии (выдаётся в момент
      // материализации записи в историю). Уже проставленный `ord` не
      // перетирается; ранее выданные значения не перенумеровываются.
      if (!Number.isFinite(message.ord)) {
        message.ord = nextOrd(session.messages);
      }
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      sanitizeMessageNullBytes(message);
      session.messages.push(message);
      session.updatedAt = nowISO();
      await this.store.save(session);
      // ADR-102: точка персиста сообщения — инкремент `activity`
      // (`messages_assistant`/`messages_tool`); пользовательские сообщения
      // персистит `QueueProcessor` (своя точка записи). Скрытые промежуточные
      // assistant-сообщения tool-chain не считаем (паритет с `computeSessionStats`).
      // Запись best-effort: рекордер не пробрасывает ошибки и не блокирует сохранение.
      const measure =
        message.metadata?.tool_chain === true ? null : activityMeasureForMessage(message.role);
      if (measure) {
        void this._options.analytics?.recordActivity(measure, sessionAxes(session));
      }
      return session;
    });
  }

  /**
   * ADR-096: точечная дозапись сообщения (без чтения/перезаписи всей истории).
   * `id`/`seq`/`origin` назначает порт (`SessionRepository.appendMessage`),
   * здесь — NUL-санитайзинг и best-effort аналитика (та же, что в `addMessage`).
   *
   * ADR-118: `ord` (монотонный счётчик сессии) тоже выдаёт порт — в момент
   * материализации записи в историю; ранее выданные значения не
   * перенумеровываются.
   */
  async appendMessage(sessionId: string, message: Message): Promise<Message | null> {
    sanitizeMessageNullBytes(message);
    const saved = await this.store.appendMessage(sessionId, message);
    if (!saved) return null;

    // Черновик частичного стрима (`metadata.streaming`) — промежуточный:
    // активность запишет финальный `updateMessage(..., { recordActivity: true })`
    // (или сообщение останется прерванным). Иначе один и тот же ответ
    // посчитался бы дважды — при создании черновика и при его финализации.
    const measure =
      saved.metadata?.tool_chain === true || saved.metadata?.streaming === true
        ? null
        : activityMeasureForMessage(saved.role);
    if (measure) {
      void this._recordAppendActivity(sessionId, measure);
    }
    return saved;
  }

  /**
   * ADR-096: точечное обновление существующего сообщения (без перезаписи
   * истории). По умолчанию аналитика не инкрементируется — нового сообщения
   * нет. `recordActivity` нужен финализации черновика частичного стрима
   * (шаг 2б): само сообщение уже создано `appendMessage` (там активность не
   * писалась), поэтому финальный `updateMessage` — единственная точка учёта.
   *
   * ADR-118: `ord` исходного сообщения сохраняется — он иммутабелен после
   * выдачи (перебить его обновлением нельзя).
   */
  async updateMessage(
    sessionId: string,
    message: Message,
    opts?: { recordActivity?: boolean },
  ): Promise<Message | null> {
    sanitizeMessageNullBytes(message);
    const saved = await this.store.updateMessage(sessionId, message);
    if (!saved) return null;

    if (opts?.recordActivity && saved.metadata?.tool_chain !== true) {
      const measure = activityMeasureForMessage(saved.role);
      if (measure) {
        void this._recordAppendActivity(sessionId, measure);
      }
    }
    return saved;
  }

  /**
   * Шаг 2б: восстановление сообщений, «зависших» после падения/рестарта.
   *
   * - `metadata.streaming === true` → `streaming:false`, `interrupted:true`,
   *   `metadata.status='error'` (частичный текст остаётся в истории);
   * - assistant с `toolCalls`, для которого хотя бы у одного `id` нет
   *   последующего tool-сообщения с этим `toolCallId`, помечается
   *   `disabled:true` + `metadata.interrupted:true` — `sessionMessagesToLlm`
   *   не отдаст провайдеру assistant(tool_calls) без пары (осиротевшие
   *   tool-сообщения он и так превращает в user-текст).
   *
   * Запись — одна, под `withLock`, и только если что-то изменилось.
   * Возвращает число исправленных сообщений.
   */
  async recoverStreamingMessages(sessionId: string): Promise<number> {
    return this.withLock(sessionId, async (session) => {
      let changed = 0;

      for (const message of session.messages) {
        if (message.metadata?.streaming === true) {
          message.metadata = {
            ...message.metadata,
            streaming: false,
            interrupted: true,
            status: 'error',
          };
          changed++;
        }
      }

      for (let i = 0; i < session.messages.length; i++) {
        const message = session.messages[i]!;
        if (message.role !== MessageRole.ASSISTANT || !message.toolCalls || message.toolCalls.length === 0) {
          continue;
        }
        const callIds = message.toolCalls
          .map((call) => (typeof call.id === 'string' ? call.id : null))
          .filter((id): id is string => id !== null);
        if (callIds.length === 0) continue;

        // Пары ищем только среди последующих tool-сообщений: tool обязан идти
        // после своего assistant(tool_calls) в OpenAI-совместимой истории.
        const laterToolIds = new Set<string>();
        for (let j = i + 1; j < session.messages.length; j++) {
          const candidate = session.messages[j]!;
          if (candidate.role === MessageRole.TOOL && candidate.toolCallId) {
            laterToolIds.add(candidate.toolCallId);
          }
        }

        const hasOrphan = callIds.some((id) => !laterToolIds.has(id));
        if (!hasOrphan) continue;
        if (message.disabled === true && message.metadata?.interrupted === true) continue;

        message.disabled = true;
        message.metadata = { ...(message.metadata ?? {}), interrupted: true };
        changed++;
      }

      if (changed > 0) {
        session.updatedAt = nowISO();
        await this.store.save(session);
      }
      return changed;
    });
  }

  /**
   * ADR-102: `activity` для дозаписанного сообщения. Оси `user`/`project`
   * берутся из **метаданных** сессии (`loadLight`), а не из полной истории:
   * запись остаётся дешёвой и best-effort — ошибки чтения/рекордера не всплывают.
   */
  private async _recordAppendActivity(sessionId: string, measure: ActivityMeasure): Promise<void> {
    const analytics = this._options.analytics;
    if (!analytics) return;
    try {
      const meta = await this.store.loadLight(sessionId);
      await analytics.recordActivity(measure, sessionAxes(meta));
    } catch {
      // best-effort: аналитика не должна ломать персист сообщения
    }
  }

  async addPendingMessage(
    sessionId: string,
    message: Message,
    maxPending = 5,
    options?: {
      /**
       * Снимать `queueStopped` при постановке (по умолчанию — да для нового
       * пользовательского ввода). Возврат сообщений в очередь
       * (`requeueMessages`) флаг не снимает: остановка была осознанной.
       */
      clearQueueStopped?: boolean;
    },
  ): Promise<Session | null> {
    return this.withLock(sessionId, async (session) => {
      if (session.pendingMessages.length >= maxPending) return null;
      if (!message.id) message.id = generateId();
      if (!message.origin) message.origin = 'local';
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      sanitizeMessageNullBytes(message);
      session.pendingMessages.push(message);
      // Новый пользовательский ввод возобновляет осознанно остановленную
      // обработку (Stop/stall): очередь снова живёт.
      if (options?.clearQueueStopped !== false && message.role === MessageRole.USER) {
        session.status.queueStopped = undefined;
        session.status.queueStoppedAt = undefined;
      }
      session.updatedAt = nowISO();
      await this.store.save(session);
      return session;
    });
  }

  /**
   * ADR-104: поставить сообщение в очередь инъекций (`steerInbox`) — отправка
   * во время активного хода (`mode: 'steer'`). Очередь отдельна от
   * `pendingMessages`: её вычитывает оркестратор на границе шага.
   *
   * `accepted: false` — превышен лимит инъекций на ход (`maxInjections`).
   *
   * `options.fromPending` — **атомарный перенос** из обычной очереди
   * (`pendingMessages`) в очередь инъекций: проверка лимита, снятие из очереди,
   * снятие user-копии из истории и постановка в `steerInbox` выполняются под
   * **одним** локом сессии. Так сообщение не остаётся «в двух местах»
   * (обработчик очереди мог бы подхватить его как обычное сообщение) и не
   * пропадает: при отказе по лимиту очередь не меняется вовсе.
   */
  async enqueueSteerMessage(
    sessionId: string,
    message: Message,
    maxInjections = MAX_STEER_INJECTIONS_PER_TURN,
    options?: {
      /** Перенос из `pendingMessages` (снять из очереди и из истории). */
      fromPending?: boolean;
      /** id активного стрима — его user-копию в истории не снимаем. */
      activeStreamId?: string;
    },
  ): Promise<{ accepted: boolean; pending: number; reason?: 'limit' | 'not_found' }> {
    return this.withLock(sessionId, async (session) => {
      const inbox = session.steerInbox ?? [];
      if (inbox.length >= maxInjections) {
        return { accepted: false, pending: inbox.length, reason: 'limit' };
      }
      if (!message.id) message.id = generateId();
      if (options?.fromPending) {
        // Сообщения нет в обычной очереди (уже отправлено «в разрыв» или
        // исчезло) — принимать нечего: очередь не трогаем.
        const idx = session.pendingMessages.findIndex(
          (m) => (message.id ? m.id === message.id : m === message),
        );
        if (idx < 0) {
          return { accepted: false, pending: inbox.length, reason: 'not_found' };
        }
        session.pendingMessages.splice(idx, 1);
        // User-копия из истории (по `stream_id`) — активный стрим не трогаем
        // (как в `/return`): иначе после инъекции был бы дубль реплики.
        const sid = message.metadata?.stream_id as string | undefined;
        if (sid && sid !== options.activeStreamId) {
          session.messages = session.messages.filter((m) => {
            if (m.role !== MessageRole.USER) return true;
            const copySid = m.metadata?.stream_id as string | undefined;
            if (!copySid) return true;
            return copySid !== sid;
          });
        }
      }
      if (!message.origin) message.origin = 'local';
      if (!message.parts || message.parts.length === 0) {
        message.parts = [makeTextPart(message.content)];
      }
      sanitizeMessageNullBytes(message);
      inbox.push(message);
      session.steerInbox = inbox;
      // Вмешательство пользователя — новая работа: осознанная остановка
      // обработки снимается.
      session.status.queueStopped = undefined;
      session.status.queueStoppedAt = undefined;
      session.updatedAt = nowISO();
      await this.store.save(session);
      return { accepted: true, pending: inbox.length };
    });
  }

  /**
   * ADR-104: забрать сообщения инъекций из очереди для вплетения в
   * текущий ход. Забираются не больше `maxInjections` — остальные возвращаются
   * как `dropped` (лимит инъекций на ход; вызывающий публикует `steer.dropped`).
   *
   * Этап 3: порядок применения — сначала класс `interrupt` (прерывание
   * генерации), затем `steer`; внутри класса — FIFO (порядок постановки).
   */
  async takeSteerMessages(
    sessionId: string,
    maxInjections = MAX_STEER_INJECTIONS_PER_TURN,
  ): Promise<{ messages: Message[]; dropped: Message[] }> {
    return this.withLock(sessionId, async (session) => {
      const inbox = session.steerInbox ?? [];
      if (inbox.length === 0) return { messages: [], dropped: [] };
      const limit = Math.max(0, maxInjections);
      const ordered = orderSteerInjections(inbox);
      const messages = ordered.slice(0, limit);
      const dropped = ordered.slice(limit);
      session.steerInbox = [];
      session.updatedAt = nowISO();
      await this.store.save(session);
      return { messages, dropped };
    });
  }

  /**
   * ADR-104 (решение 2026-10-28): снять очередь инъекций целиком.
   *
   * Очередь вычитывается только на границе шага, поэтому при «Стоп» и в конце
   * хода оставшиеся сообщения иначе применились бы в начале следующего хода.
   * Возвращает снятые сообщения (пустая очередь — `[]`); в историю они не
   * попадают — о снятии сообщает `steer.dropped`.
   */
  async clearSteerInbox(sessionId: string): Promise<Message[]> {
    return this.withLock(sessionId, async (session) => {
      const inbox = session.steerInbox ?? [];
      if (inbox.length === 0) return [];
      session.steerInbox = [];
      session.updatedAt = nowISO();
      await this.store.save(session);
      return inbox;
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

  /**
   * Переименовать сессию **только если** заголовок ещё дефолтный
   * (`isDefaultTitle`) — авто-заголовок не перетирает заголовок, заданный
   * пользователем. Проверка и запись — под одним локом (гонка двух ходов не
   * должна затереть чужое имя). Возвращает обновлённую сессию; `null` — имя
   * уже задано (или сессии нет).
   */
  async renameSessionIfDefault(sessionId: string, title: string): Promise<Session | null> {
    return this.withLock(sessionId, async (s) => {
      if (!isDefaultTitle(s.title)) return null;
      s.title = title;
      s.updatedAt = nowISO();
      await this.store.save(s);
      return s;
    });
  }

  /**
   * Дочерние сессии. `options.light` — метаданные без истории (нужны только
   * `id`/`title`/`parentId`): оптимизация для дерева (`getSessionTree`) и
   * fork (уникализация title). По умолчанию — полная сессия (роут
   * `GET /:id/children` и CLI `children` сериализуют/считают сообщения).
   */
  async getChildren(parentId: string, options?: { light?: boolean }): Promise<Session[]> {
    return options?.light === true
      ? this.store.listLight({ parentId })
      : this.store.list({ parentId });
  }

  async getSessionTree(rootId: string): Promise<SessionTree> {
    const root = await this.getSession(rootId);
    // Дети нужны только для рекурсии по `id`; сами сессии загружаются `getSession`.
    const children = await this.getChildren(rootId, { light: true });
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
        // ADR-118: ссылка — новая запись истории, получает свежий `ord`
        // (монотонный счётчик сессии); `seq` ниже перенумеровывается под
        // позицию, `ord` — нет.
        ord: nextOrd(target.messages),
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
    messageIds: string[],
    state?: boolean,
  ): Promise<{ results: Array<{ messageId: string; success: boolean; state?: boolean }> }> {
    return this.withLock(sessionId, async (session) => {
      const results: Array<{ messageId: string; success: boolean; state?: boolean }> = [];
      // ADR-118 §7: адресация — по `id` сообщения; позиция находится внутри лока.
      // Удаление идёт от конца к началу (splice сдвигает массив), остальные
      // действия — в порядке позиций в истории.
      const positions = messageIds.map((messageId) => ({
        messageId,
        index: session.messages.findIndex((m) => m.id === messageId),
      }));
      const sorted = action === 'delete'
        ? [...positions].sort((a, b) => b.index - a.index)
        : [...positions].sort(
          (a, b) => (a.index < 0 ? Number.POSITIVE_INFINITY : a.index) - (b.index < 0 ? Number.POSITIVE_INFINITY : b.index),
        );

      for (const { messageId, index } of sorted) {
        const msg = index >= 0 ? session.messages[index] : undefined;
        if (!msg) { results.push({ messageId, success: false }); continue; }

        if (action === 'pin') {
          msg.pinned = state !== undefined ? state : !msg.pinned;
          results.push({ messageId, success: true, state: msg.pinned });
        } else if (action === 'toggle') {
          msg.disabled = state !== undefined ? state : !msg.disabled;
          results.push({ messageId, success: true, state: msg.disabled });
        } else if (action === 'delete') {
          session.messages.splice(index, 1);
          results.push({ messageId, success: true });
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

      // ADR-118: копии получают собственный `ord` сессии-получателя — `ord`
      // исходной сессии здесь не значит ничего (счётчик монотонный в рамках
      // одной сессии). Счётчик считается ДО вставки, чтобы новые записи не
      // повторяли `ord` уже существующих.
      const baseOrd = nextOrd(target.messages);
      target.messages.splice(anchorIdx, 0, ...messagesToInsert);
      messagesToInsert.forEach((m, i) => { m.ord = baseOrd + i; });
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
      // Нужны только заголовки детей (уникализация title) — метаданные без истории.
      const siblings = await this.getChildren(sourceSessionId, { light: true });
      const existingTitles = siblings.map((s) => s.title || '');
      const forkedTitle = options.title || getForkedTitle(source.title, existingTitles);

      // ADR-089: materialization (ветвление как факт копии истории), не request —
      // прямой `createSession`; funnel `session.requested` сюда не применяется.
      const forked = await this.createSession({
        title: forkedTitle,
        icon: source.icon,
        color: source.color,
        projectId: source.projectId,
        sessionOrigin: 'fork' as SessionOrigin,
        parentId: sourceSessionId,
        settings: { ...source.settings },
        // ADR-075/D5: при отсутствии явной атрибуции наследуем владельца источника,
        // иначе форк терял владельца и выпадал из RBAC проектных данных.
        userId: options.userId ?? source.userId,
        ownerId: options.ownerId ?? source.ownerId,
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
        // ADR-118: форк — новая сессия, её `ord`-счётчик начинается заново
        // (`ord` исходной сессии — счётчик чужой сессии).
        ord: i + 1,
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
