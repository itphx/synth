import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, ProfileData, Project, Session } from '@itphx/synth-shared';
import { MessageRole, ProjectRole, makeTextPart } from '@itphx/synth-shared';

/** Временный каталог под контрактный прогон + очистка. */
export async function createTmpDir(prefix = 'synth-contract-'): Promise<{
  dir: string;
  dispose: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** Минимальная валидная сессия (поля, которые трогает хранилище). */
export function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: `sess-${randomUUID()}`,
    sessionOrigin: 'user',
    messages: [],
    pendingMessages: [],
    status: {},
    settings: {},
    checkpoints: [],
    stickyNotes: [],
    references: [],
    summarizationPending: false,
    canSummarize: false,
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    ...overrides,
  } as unknown as Session;
}

/** Минимальное сообщение для проверки поиска по содержимому. */
export function makeMessage(content: string): Message {
  return {
    id: `msg-${randomUUID()}`,
    role: MessageRole.USER,
    seq: 0,
    origin: 'local',
    parts: [makeTextPart(content)],
    content,
    createdAt: new Date().toISOString(),
    disabled: false,
    pinned: false,
    hidden: false,
  } as unknown as Message;
}

/** Минимальный проект. */
export function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id,
    name: `project-${id}`,
    ownerId: 'owner-1',
    members: { 'owner-1': ProjectRole.OWNER },
    description: '',
    currentTask: '',
    invariants: '',
    statusMessages: [],
    log: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as Project;
}

/** Минимальный профиль. */
export function makeProfile(id: string, overrides: Partial<ProfileData> = {}): ProfileData {
  const now = new Date().toISOString();
  return {
    id,
    username: `user-${id}`,
    roles: ['USER'],
    teamRoles: [],
    isActive: true,
    preferences: {},
    notes: '',
    interviewCompleted: false,
    identities: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ProfileData;
}
