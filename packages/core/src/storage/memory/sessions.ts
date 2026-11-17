/**
 * In-memory реализации портов «принципалов»: сессии, проекты, профили
 * (ADR-096, шаг W2.2).
 *
 * Второй backend за единым слоем хранения (после файлового): чистая
 * реализация без модулей ФС (`fs`/`path`), данные — в `Map`. Служит эталоном
 * семантики портов и базой для тестов (контрактный suite гоняется на обеих
 * реализациях). Семантика повторяет файловую (`FileStore`/`ProjectStore`/
 * `FileProfileStore`): сортировка `updatedAt` desc, `delete` отсутствующего —
 * не ошибка, `list` на пустом — `[]`.
 *
 * Клонирование на входе/выходе (`structuredClone`) защищает вызывающий код от
 * случайной мутации по ссылке.
 */

import type { Message, ProfileData, Project, ProjectViewer, Session, SessionReference } from '@itphx/synth-shared';
import type { CreateProfileParams, ExternalIdentity } from '@itphx/synth-shared';
import {
  ProjectRole,
  generateId,
  normalizeColorKey,
  normalizeIconKey,
  normalizeProjectEveryoneRole,
  normalizeProjectMemberRoles,
  nowISO,
  resolveProjectAccess,
  stripNullBytesDeep,
} from '@itphx/synth-shared';
import type {
  CreateProjectData,
  MutateHistoryOptions,
  MutateHistoryResult,
  MutateMessageOptions,
  MutateMessageResult,
  MutateMetaOptions,
  MutateMetaResult,
  ProfileRepository,
  ProjectRepository,
  SessionFilter,
  SessionMeta,
  SessionRepository,
} from '../ports/index.js';
import { findMessageIndex, isStaleDraftWrite, prepareMessageForAppend, prepareMessageForUpdate } from '../message-write.js';
import { assignMissingOrd, maxOrdOf, mergeSessionMeta, normalizeMessageSeq, toSessionMeta } from '../session-meta.js';

/**
 * Порт хранилища сессий поверх `Map` (семантика `FileStore`).
 *
 * Сообщения хранятся целиком (`structuredClone`), поэтому аддитивные поля
 * сообщения (ADR-118: `ord`/`turnId`/`stepIndex`/`status`) переживают
 * save/load без отдельной нормализации — как и в файловой реализации.
 */
export class MemorySessionRepository implements SessionRepository {
  private readonly _sessions = new Map<string, Session>();

  /** Клон с нормализацией метаданных при чтении (как `FileStore.deserializeSession`). */
  private _normalize(session: Session): Session {
    const clone = structuredClone(session);
    clone.icon = normalizeIconKey(clone.icon);
    clone.color = normalizeColorKey(clone.color);
    if (!clone.sessionOrigin) clone.sessionOrigin = 'user';
    return clone;
  }

  async load(sessionId: string): Promise<Session | null> {
    const session = this._sessions.get(sessionId);
    return session ? this._normalize(session) : null;
  }

  async save(session: Session): Promise<void> {
    // U+0000 несовместим с PostgreSQL-драйвером; чистим на границе порта,
    // чтобы file/memory/postgres вели себя одинаково (контракт сессий).
    this._sessions.set(session.id, structuredClone(stripNullBytesDeep(session)));
  }

  /**
   * Точечная дозапись сообщения (порт `SessionRepository.appendMessage`).
   * Операция синхронная (над `Map`) — гонок нет, лок не нужен.
   *
   * ADR-118: `ord` (монотонный счётчик сессии) выдаёт общий нормализатор
   * `prepareMessageForAppend` — тот же, что у файловой реализации; ранее
   * выданные значения не перенумеровываются.
   */
  async appendMessage(sessionId: string, message: Message): Promise<Message | null> {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    const stored = prepareMessageForAppend(session, message);
    session.messages.push(structuredClone(stored));
    session.updatedAt = nowISO();
    return structuredClone(stored);
  }

  /**
   * Точечное обновление сообщения (порт `SessionRepository.updateMessage`):
   * цель — по `seq`, fallback по `id`; неизменяемые поля исходной записи
   * (`id`/`seq`/`createdAt`/`ord`) сохраняются.
   *
   * ADR-118: `ord` иммутабелен после выдачи.
   */
  async updateMessage(sessionId: string, message: Message): Promise<Message | null> {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    const index = findMessageIndex(session.messages, message);
    if (index < 0) return null;
    const target = session.messages[index]!;
    // ADR-118 §5: поздняя запись черновика не «воскрешает» закрытый шаг.
    if (isStaleDraftWrite(target, message)) return structuredClone(target);
    const updated = prepareMessageForUpdate(target, message);
    session.messages[index] = structuredClone(updated);
    session.updatedAt = nowISO();
    return structuredClone(updated);
  }

  /**
   * Атомарная правка метаданных (порт `SessionRepository.mutateMeta`).
   * Операция синхронная (над `Map`) — гонок нет; мутатор получает клон, поэтому
   * брошенное исключение не оставляет половинчатой записи.
   */
  async mutateMeta<T>(
    sessionId: string,
    mutator: (meta: SessionMeta) => T,
    opts?: MutateMetaOptions<T>,
  ): Promise<MutateMetaResult<T>> {
    const stored = this._sessions.get(sessionId);
    if (!stored) return { found: false };
    const session = structuredClone(stored);
    // `shouldWrite`: мутатор работает с клоном, при отказе от записи снимок
    // **до** мутатора уходит наружу, хранилище не меняется вовсе.
    const snapshot = toSessionMeta(session);
    const baseline = opts?.shouldWrite ? structuredClone(snapshot) : undefined;
    const meta = opts?.shouldWrite ? structuredClone(snapshot) : snapshot;
    const value = mutator(meta);
    if (opts?.shouldWrite && !opts.shouldWrite(value)) {
      return { found: true, value, session: baseline! };
    }
    // Идентичность сессии неизменяема (ключ `Map`/запись адресуются по `id`).
    meta.id = sessionId;
    const merged = mergeSessionMeta(session, meta);
    if (opts?.touchUpdatedAt !== false) merged.updatedAt = nowISO();
    const persisted = structuredClone(stripNullBytesDeep(merged));
    this._sessions.set(sessionId, persisted);
    // Возврат — санитизированная **копия** (паритет с PostgreSQL: там читается
    // записанное значение) и не алиас хранилища: правка результата не меняет
    // сохранённую сессию.
    return { found: true, value, session: toSessionMeta(structuredClone(persisted)) };
  }

  /** Атомарная правка истории (порт `SessionRepository.mutateHistory`). */
  async mutateHistory<T>(
    sessionId: string,
    mutator: (session: Session) => T,
    opts?: MutateHistoryOptions<T>,
  ): Promise<MutateHistoryResult<T>> {
    const stored = this._sessions.get(sessionId);
    if (!stored) return { ok: false, reason: 'not_found' };
    // Мутатор работает с клоном: при исключении сохранённая запись не меняется.
    const session = structuredClone(stored);
    if (opts?.expectMaxOrd !== undefined && maxOrdOf(session.messages) > opts.expectMaxOrd) {
      return { ok: false, reason: 'stale' };
    }
    const value = mutator(session);
    if (opts?.shouldWrite && !opts.shouldWrite(value)) return { ok: true, value };
    session.id = sessionId;
    // Новым записям (добавлены мутатором/импортом) порт выдаёт `ord` сам:
    // без него сортировка по `ord` поставила бы их в начало истории.
    assignMissingOrd(session.messages);
    normalizeMessageSeq(session.messages);
    // `touchUpdatedAt:false` — служебная запись истории не «оживляет» сессию.
    if (opts?.touchUpdatedAt !== false) session.updatedAt = nowISO();
    this._sessions.set(sessionId, structuredClone(stripNullBytesDeep(session)));
    return { ok: true, value };
  }

  /**
   * Атомарная правка одного сообщения по `id` (порт `SessionRepository.mutateMessage`).
   * `opts.touchUpdatedAt === false` — запись сообщения есть, `updatedAt` сессии
   * не двигается (служебные метки: `turnId`, `last_error`).
   */
  async mutateMessage<T>(
    sessionId: string,
    messageId: string,
    mutator: (message: Message) => T,
    opts?: MutateMessageOptions,
  ): Promise<MutateMessageResult<T>> {
    const stored = this._sessions.get(sessionId);
    if (!stored) return { found: false };
    const session = structuredClone(stored);
    const index = session.messages.findIndex((candidate) => candidate.id === messageId);
    if (index < 0) return { found: false };

    const original = structuredClone(session.messages[index]!);
    const target = structuredClone(original);
    const value = mutator(target);
    // ADR-118 §5: поздняя запись черновика не «воскрешает» закрытый шаг.
    if (isStaleDraftWrite(original, target)) {
      return { found: true, value, message: original };
    }
    const updated = prepareMessageForUpdate(original, target);
    session.messages[index] = updated;
    if (opts?.touchUpdatedAt !== false) session.updatedAt = nowISO();
    this._sessions.set(sessionId, structuredClone(stripNullBytesDeep(session)));
    return { found: true, value, message: structuredClone(updated) };
  }

  /** Метаданные без истории (порт `SessionRepository.loadLight`). */
  async loadLight(sessionId: string): Promise<Session | null> {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    const clone = this._normalize(session);
    clone.messages = [];
    clone.pendingMessages = [];
    clone.steerInbox = [];
    clone.checkpoints = [];
    return clone;
  }

  async delete(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId);
  }

  async list(filter?: SessionFilter): Promise<Session[]> {
    const f = filter ?? {};
    let sessions = [...this._sessions.values()];

    if (f.projectId) sessions = sessions.filter((s) => s.projectId === f.projectId);
    if (f.parentId !== undefined) {
      sessions = f.parentId === null
        ? sessions.filter((s) => !s.parentId)
        : sessions.filter((s) => s.parentId === f.parentId);
    }
    if (f.search) {
      const search = f.search.toLowerCase();
      sessions = sessions.filter((s) => {
        const matchTitle = s.title?.toLowerCase().includes(search) ?? false;
        const matchMsg = s.messages.some((m) => m.content.toLowerCase().includes(search));
        return matchTitle || matchMsg;
      });
    }

    return sessions
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((s) => this._normalize(s));
  }

  /**
   * Лёгкий список (порт `SessionRepository.listLight`): тот же набор id и порядок,
   * что у `list`, но **без истории** (`messages`/`checkpoints` очищены) и **с
   * очередью** (`pendingMessages`/`steerInbox` сохранены — нужны recovery и
   * автозапуску очередей).
   */
  async listLight(filter?: SessionFilter): Promise<Session[]> {
    const sessions = await this.list(filter);
    return sessions.map((s) => ({ ...s, messages: [], checkpoints: [] }));
  }

  async search(query: string, filter?: SessionFilter): Promise<Session[]> {
    return this.list({ ...filter, search: query });
  }

  async exists(sessionId: string): Promise<boolean> {
    return this._sessions.has(sessionId);
  }

  async listForUser(userId: string, ownerIds: string[] = []): Promise<Session[]> {
    const ids = new Set<string>([userId, ...ownerIds]);
    const match = (id: string | undefined): boolean => id !== undefined && ids.has(id);
    const all = await this.list();
    return all.filter((s) => match(s.userId) || match(s.ownerId));
  }

  async listForUserScope(userId: string, projectIds: string[], ownerIds: string[] = []): Promise<Session[]> {
    if (projectIds.length === 0) return this.listForUser(userId, ownerIds);
    const ids = new Set<string>([userId, ...ownerIds]);
    const match = (id: string | undefined): boolean => id !== undefined && ids.has(id);
    const all = await this.list();
    return all.filter(
      (s) =>
        match(s.userId)
        || match(s.ownerId)
        || (s.projectId !== undefined && projectIds.includes(s.projectId)),
    );
  }

  async addReference(sessionId: string, ref: SessionReference): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!session.references) session.references = [];
    session.references.push(structuredClone(ref));
  }

  async removeReference(sessionId: string, refSessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.references) {
      session.references = session.references.filter((r) => r.sessionId !== refSessionId);
    }
  }

  async getReferences(sessionId: string): Promise<SessionReference[]> {
    const session = this._sessions.get(sessionId);
    return session ? structuredClone(session.references ?? []) : [];
  }
}

/** Порт хранилища проектов поверх `Map` (семантика `ProjectStore`). */
export class MemoryProjectRepository implements ProjectRepository {
  private readonly _projects = new Map<string, Project>();

  /**
   * PROP-133: нормализация состояния доступа (битые роли → `viewer`,
   * `everyoneRole` — только `owner|editor|viewer`/`null`, `groupMembers` —
   * объект). Паритет с файловой реализацией.
   */
  private _normalizeAccessState(project: Project): void {
    project.members = normalizeProjectMemberRoles(project.members);
    if (project.groupMembers !== undefined) {
      project.groupMembers = normalizeProjectMemberRoles(project.groupMembers);
    }
    const everyoneRole = normalizeProjectEveryoneRole(project.everyoneRole);
    if (everyoneRole === undefined) delete project.everyoneRole;
    else project.everyoneRole = everyoneRole;
  }

  async load(id: string): Promise<Project | null> {
    const project = this._projects.get(id);
    if (!project) return null;
    const clone = structuredClone(project);
    // Нормализация метаданных при чтении (как в `ProjectStore.load`).
    clone.icon = normalizeIconKey(clone.icon);
    clone.color = normalizeColorKey(clone.color);
    this._normalizeAccessState(clone);
    return clone;
  }

  async save(project: Project): Promise<void> {
    this._projects.set(project.id, structuredClone(project));
  }

  /**
   * Атомарный read-modify-write (порт `ProjectRepository.mutate`).
   *
   * Операция синхронная (над `Map`), поэтому чтение-правка-запись происходит в
   * одном тике — гонок нет, лок не нужен. Мутатор работает с клоном: если он
   * бросит, сохранённая запись остаётся нетронутой (как в файловой реализации,
   * где запись идёт после успешного мутатора).
   */
  async mutate(id: string, mutator: (project: Project) => void): Promise<Project | null> {
    const stored = this._projects.get(id);
    if (!stored) return null;
    const project = structuredClone(stored);
    mutator(project);
    project.icon = normalizeIconKey(project.icon);
    project.color = normalizeColorKey(project.color);
    this._normalizeAccessState(project);
    this._projects.set(id, structuredClone(project));
    return project;
  }

  async delete(id: string): Promise<void> {
    this._projects.delete(id);
  }

  async list(viewer?: ProjectViewer): Promise<Project[]> {
    let projects = [...this._projects.values()];
    // PROP-133: единый предикат доступа (резолвер — источник истины).
    if (viewer) {
      projects = projects.filter((p) => resolveProjectAccess(p, viewer).read);
    }
    const loaded = await Promise.all(projects.map((p) => this.load(p.id)));
    return loaded
      .filter((p): p is Project => p !== null)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  create(name: string, ownerId: string, data?: CreateProjectData): Project {
    // PROP-133: роль владельца всегда `owner` (понизить её нельзя).
    const members = normalizeProjectMemberRoles(data?.members);
    members[ownerId] = ProjectRole.OWNER;
    const groupMembers = data?.groupMembers
      ? normalizeProjectMemberRoles(data.groupMembers)
      : undefined;
    const everyoneRole = normalizeProjectEveryoneRole(data?.everyoneRole);
    return {
      id: generateId(),
      name,
      ownerId,
      members,
      ...(groupMembers ? { groupMembers } : {}),
      ...(everyoneRole !== undefined ? { everyoneRole } : {}),
      description: data?.description || '',
      currentTask: '',
      invariants: '',
      icon: data?.icon,
      color: data?.color,
      workspace: data?.workspace,
      repos: data?.repos,
      ...(data?.mcp ? { mcp: data.mcp } : {}),
      ...(data?.skills ? { skills: data.skills } : {}),
      statusMessages: [],
      plan: {
        version: 1,
        updatedAt: nowISO(),
        columns: [
          { id: 'backlog', name: 'Бэклог', order: 0 },
          { id: 'todo', name: 'К выполнению', order: 1 },
          { id: 'in_progress', name: 'В работе', order: 2 },
          { id: 'done', name: 'Готово', order: 3 },
        ],
        items: [],
      },
      log: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
  }
}

/** Порт хранилища профилей поверх `Map` (семантика `FileProfileStore`). */
export class MemoryProfileRepository implements ProfileRepository {
  private readonly _profiles = new Map<string, ProfileData>();

  async loadProfile(id: string): Promise<ProfileData | null> {
    const profile = this._profiles.get(id);
    return profile ? structuredClone(profile) : null;
  }

  async saveProfile(profile: ProfileData): Promise<void> {
    // Как `FileProfileStore.saveProfile`: `updatedAt` выставляется при записи.
    this._profiles.set(profile.id, { ...structuredClone(profile), updatedAt: new Date().toISOString() });
  }

  async listProfiles(): Promise<ProfileData[]> {
    return [...this._profiles.values()]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((p) => structuredClone(p));
  }

  async deleteProfile(id: string): Promise<boolean> {
    return this._profiles.delete(id);
  }

  async getProfileByUsername(username: string): Promise<ProfileData | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.username === username) ?? null;
  }

  async getProfileByEmail(email: string): Promise<ProfileData | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.email === email) ?? null;
  }

  async getOrCreateProfile(params: CreateProfileParams): Promise<ProfileData> {
    const existing = await this.getProfileByUsername(params.username);
    if (existing) {
      if (params.email) existing.email = params.email;
      if (params.roles) existing.roles = params.roles;
      if (params.teamRoles) existing.teamRoles = params.teamRoles;
      if (params.interviewCompleted !== undefined) existing.interviewCompleted = params.interviewCompleted;
      await this.saveProfile(existing);
      return existing;
    }

    const now = new Date().toISOString();
    const profile: ProfileData = {
      id: generateId(),
      username: params.username,
      email: params.email,
      roles: params.roles ?? ['USER'],
      teamRoles: params.teamRoles ?? [],
      isActive: true,
      preferences: {},
      notes: '',
      interviewCompleted: params.interviewCompleted ?? false,
      displayName: params.username,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveProfile(profile);
    return profile;
  }

  async updateLastLogin(id: string): Promise<void> {
    const profile = await this.loadProfile(id);
    if (!profile) return;
    profile.lastLogin = new Date().toISOString();
    await this.saveProfile(profile);
  }

  async findProfileByExternalId(provider: string, externalId: string): Promise<ProfileData | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) =>
      (p.identities ?? []).some((i) => i.provider === provider && i.externalId === externalId),
    ) ?? null;
  }

  async linkIdentity(userId: string, identity: ExternalIdentity): Promise<ProfileData | null> {
    const profile = this._profiles.get(userId);
    if (!profile) return null;

    const existing = await this.findProfileByExternalId(identity.provider, identity.externalId);
    if (existing && existing.id !== userId) return null;

    const identities = profile.identities ?? [];
    if (identities.some((i) => i.provider === identity.provider && i.externalId === identity.externalId)) {
      return structuredClone(profile);
    }

    profile.identities = [...identities, structuredClone(identity)];
    await this.saveProfile(profile);
    return this.loadProfile(userId);
  }

  async unlinkIdentity(userId: string, provider: string, externalId: string): Promise<ProfileData | null> {
    const profile = this._profiles.get(userId);
    if (!profile) return null;

    const identities = profile.identities ?? [];
    const next = identities.filter((i) => !(i.provider === provider && i.externalId === externalId));
    if (next.length === identities.length) return null;

    profile.identities = next;
    await this.saveProfile(profile);
    return this.loadProfile(userId);
  }
}
