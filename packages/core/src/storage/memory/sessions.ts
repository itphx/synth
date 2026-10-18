/**
 * In-memory реализации портов «принципалов»: сессии, проекты, профили
 * (PROP-032, шаг W2.2).
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

import type { Message, ProfileData, Project, Session, SessionReference } from '@itphx/synth-shared';
import type { CreateProfileParams, ExternalIdentity } from '@itphx/synth-shared';
import { ProjectRole, generateId, normalizeColorKey, normalizeIconKey, nowISO, stripNullBytesDeep } from '@itphx/synth-shared';
import type {
  CreateProjectData,
  ProfileRepository,
  ProjectRepository,
  SessionFilter,
  SessionRepository,
} from '../ports/index.js';
import { findMessageIndex, prepareMessageForAppend, prepareMessageForUpdate } from '../message-write.js';

/** Порт хранилища сессий поверх `Map` (семантика `FileStore`). */
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
   * (`id`/`seq`/`createdAt`) сохраняются.
   */
  async updateMessage(sessionId: string, message: Message): Promise<Message | null> {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    const index = findMessageIndex(session.messages, message);
    if (index < 0) return null;
    const updated = prepareMessageForUpdate(session.messages[index]!, message);
    session.messages[index] = structuredClone(updated);
    session.updatedAt = nowISO();
    return structuredClone(updated);
  }

  /** Метаданные без истории (порт `SessionRepository.loadLight`). */
  async loadLight(sessionId: string): Promise<Session | null> {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    const clone = this._normalize(session);
    clone.messages = [];
    clone.pendingMessages = [];
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
   * что у `list`, но `messages`/`pendingMessages`/`checkpoints` очищены.
   */
  async listLight(filter?: SessionFilter): Promise<Session[]> {
    const sessions = await this.list(filter);
    return sessions.map((s) => ({ ...s, messages: [], pendingMessages: [], checkpoints: [] }));
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

  async load(id: string): Promise<Project | null> {
    const project = this._projects.get(id);
    if (!project) return null;
    const clone = structuredClone(project);
    // Нормализация метаданных при чтении (как в `ProjectStore.load`).
    clone.icon = normalizeIconKey(clone.icon);
    clone.color = normalizeColorKey(clone.color);
    return clone;
  }

  async save(project: Project): Promise<void> {
    this._projects.set(project.id, structuredClone(project));
  }

  async delete(id: string): Promise<void> {
    this._projects.delete(id);
  }

  async list(userId?: string): Promise<Project[]> {
    let projects = [...this._projects.values()];
    if (userId) {
      projects = projects.filter((p) => p.ownerId === userId || userId in (p.members ?? {}));
    }
    const loaded = await Promise.all(projects.map((p) => this.load(p.id)));
    return loaded
      .filter((p): p is Project => p !== null)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  create(name: string, ownerId: string, data?: CreateProjectData): Project {
    return {
      id: generateId(),
      name,
      ownerId,
      members: { [ownerId]: 'owner' as ProjectRole },
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
