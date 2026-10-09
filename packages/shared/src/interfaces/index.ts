import type { Session, Project, Message, AgentDefinition, ProviderConfig, ModelConfig, SessionReference } from '../types/index.js';

export interface SessionStore {
  get(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<Session[]>;
  exists(id: string): Promise<boolean>;
  addReference(sessionId: string, ref: SessionReference): Promise<void>;
  removeReference(sessionId: string, refSessionId: string): Promise<void>;
  getReferences(sessionId: string): Promise<SessionReference[]>;
}

export interface SessionFilter {
  projectId?: string;
  search?: string;
  parentId?: string | null;
}

export interface ProjectStore {
  get(id: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: ProjectFilter): Promise<Project[]>;
  exists(id: string): Promise<boolean>;
}

export interface ProjectFilter {
  userId?: string;
}

export interface MessageQueue {
  enqueue(sessionId: string, message: Message): Promise<boolean>;
  dequeue(sessionId: string): Promise<Message | null>;
  peek(sessionId: string): Promise<Message | null>;
  clear(sessionId: string): Promise<number>;
  size(sessionId: string): Promise<number>;
}

export interface EventBus {
  subscribe(sessionId: string): AsyncGenerator<BusEvent>;
  unsubscribe(sessionId: string, subscriber: AsyncGenerator<BusEvent>): void;
  publish(sessionId: string, event: BusEvent): void;
}

export interface AgentRegistry {
  list(sessionId?: string): Promise<AgentDefinition[]>;
  get(id: string): Promise<AgentDefinition | null>;
}

export interface ProviderStore {
  list(): Promise<ProviderConfig[]>;
  get(name: string): Promise<ProviderConfig | null>;
  save(name: string, provider: ProviderConfig): Promise<void>;
  delete(name: string): Promise<void>;
  getDefault(): Promise<ProviderConfig | null>;
}

export interface ModelStore {
  list(provider?: string): Promise<ModelConfig[]>;
  get(provider: string, id: string): Promise<ModelConfig | null>;
  save(provider: string, id: string, model: ModelConfig): Promise<void>;
  delete(provider: string, id: string): Promise<void>;
  getDefault(provider?: string): Promise<ModelConfig | null>;
}

import type { ToolDefinition, ToolCapability } from '../types/index.js';

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  toLLMFormat(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  filterByCapabilities(capabilities: ToolCapability[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
}

import type { ProfileData } from '../types/index.js';

export interface CreateProfileParams {
  username: string;
  email?: string;
  roles?: string[];
  teamRoles?: string[];
  interviewCompleted?: boolean;
}

export interface ProfileStore {
  loadProfile(id: string): Promise<ProfileData | null>;
  saveProfile(profile: ProfileData): Promise<void>;
  listProfiles(): Promise<ProfileData[]>;
  deleteProfile(id: string): Promise<boolean>;
  getProfileByUsername(username: string): Promise<ProfileData | null>;
  getProfileByEmail(email: string): Promise<ProfileData | null>;
  getOrCreateProfile(params: CreateProfileParams): Promise<ProfileData>;
  updateLastLogin(id: string): Promise<void>;
}

// Re-export BusEvent for convenience
import type { BusEvent } from '../types/index.js';
export type { BusEvent };
