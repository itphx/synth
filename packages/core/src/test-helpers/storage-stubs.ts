// ADR-096 (W2.3): тестовые заглушки доменных портов слоя хранения.
//
// Потребители типизированы портами (`storage/ports/*`), поэтому в тестах нужны
// полные no-op реализации интерфейсов — без `as`-приведений к конкретным
// классам реализаций. Фабрики принимают частичный override: методы, которые
// тест реально проверяет, заменяются, остальные остаются безопасными дефолтами.
import type {
  ContextCategory,
  ContextFileContent,
  ContextFileInfo,
  ProfileData,
  CreateProfileParams,
  Project,
  SSHKey,
  SSHKeyCreateRequest,
  SSHKeyMeta,
  SSHKeyUpdateRequest,
} from '@itphx/synth-shared';
import type { ContextFileRepository } from '../storage/ports/context-file-repository.js';
import type { DictionaryRepository } from '../storage/ports/dictionary-repository.js';
import type { ProfileRepository } from '../storage/ports/profile-repository.js';
import type { ProjectRepository } from '../storage/ports/project-repository.js';
import type { SSHKeyRepository } from '../storage/ports/ssh-key-repository.js';

/**
 * Заглушка `ContextFileRepository` (реализация — `ContextConfig`): синхронные
 * геттеры промптов возвращают пустые значения, файловые операции — no-op.
 */
export function stubContextFiles(
  overrides: Partial<ContextFileRepository> = {},
): ContextFileRepository {
  return {
    systemPromptsDir: '/tmp/prompts',
    listAllFiles: (): ContextFileInfo[] => [],
    getFile: (_filename: string, _category: ContextCategory): ContextFileContent | null => null,
    saveFile: async (): Promise<boolean> => false,
    deleteFile: async (): Promise<boolean> => false,
    restoreFile: async (): Promise<boolean> => false,
    getEnabledFiles: (): string[] => [],
    setEnabledFiles: (_files: string[]): void => {},
    getRolePrompt: (): string | null => null,
    getRolesDescription: (): string => '',
    getInterviewTemplate: (): string => '',
    getParticipantsNotice: (): string => '',
    getSchedulerNotice: (): string => '',
    getSchedulerTurnNotice: (): string => '',
    getMaxStepsPrompt: (): string => '',
    getSummarizerPrompt: (): string => '',
    getUserContextTemplate: (): string => '',
    getCompressedDialogTemplate: (): string => '',
    getAttachmentsDroppedTemplate: (): string => '',
    getAudioAsVideoNote: (): string => '',
    getMediaDeriveTemplate: (): string => '',
    getStickyNotesTemplate: (): string => '',
    getRoutingInstructions: (): string => '',
    getRules: (): string => '',
    getGatewayInstructions: (): string => '',
    getMemoryInstructions: (): string => '',
    getSecurityMessage: (): string | null => null,
    getModePrompt: (): string | null => null,
    getPlanModePrompt: (): string | null => null,
    getPlanGuide: (): string | null => null,
    getModePolicy: (): string | null => null,
    getClassificationInstructions: (): string => '',
    ...overrides,
  };
}

/** Заглушка `DictionaryRepository` (реализация — `DictionaryStore`). */
export function stubDictionary(
  overrides: Partial<DictionaryRepository> = {},
): DictionaryRepository {
  return {
    getKeywords: (): string[] => [],
    getCategorizedKeywords: (): Record<string, string[]> => ({}),
    getCodingTools: (): string[] => [],
    isKnownCategory: (): boolean => false,
    isValidLanguage: (): boolean => false,
    getDictionary: () => null,
    listDictionaries: () => [],
    saveUserDictionary: async () => null,
    deleteUserDictionary: async () => null,
    getContent: (): string => '',
    saveUserContent: async () => null,
    ...overrides,
  };
}

/** Заглушка `ProfileRepository` (доменный контракт — `ProfileStore` из shared). */
export function stubProfiles(
  overrides: Partial<ProfileRepository> = {},
): ProfileRepository {
  return {
    loadProfile: async (): Promise<ProfileData | null> => null,
    saveProfile: async (_profile: ProfileData): Promise<void> => {},
    listProfiles: async (): Promise<ProfileData[]> => [],
    deleteProfile: async (): Promise<boolean> => false,
    getProfileByUsername: async (): Promise<ProfileData | null> => null,
    getProfileByEmail: async (): Promise<ProfileData | null> => null,
    getOrCreateProfile: async (params: CreateProfileParams): Promise<ProfileData> => ({
      id: `id-${params.username}`,
      username: params.username,
      roles: params.roles ?? [],
      teamRoles: [],
      isActive: true,
      preferences: {},
      notes: '',
      interviewCompleted: false,
      createdAt: '',
      updatedAt: '',
    }),
    updateLastLogin: async (): Promise<void> => {},
    findProfileByExternalId: async (): Promise<ProfileData | null> => null,
    linkIdentity: async (): Promise<ProfileData | null> => null,
    unlinkIdentity: async (): Promise<ProfileData | null> => null,
    ...overrides,
  };
}

/** Заглушка `ProjectRepository` (реализация — `ProjectStore`). */
export function stubProjectStore(
  overrides: Partial<ProjectRepository> = {},
): ProjectRepository {
  return {
    load: async (): Promise<Project | null> => null,
    save: async (_project: Project): Promise<void> => {},
    delete: async (): Promise<void> => {},
    list: async (): Promise<Project[]> => [],
    create: (_name: string, _ownerId: string): Project => {
      throw new Error('stubProjectStore.create не реализован');
    },
    ...overrides,
  };
}

/** Заглушка `SSHKeyRepository` (реализация — `SSHKeyStore`). */
export function stubSshKeys(
  overrides: Partial<SSHKeyRepository> = {},
): SSHKeyRepository {
  return {
    list: async (): Promise<SSHKeyMeta[]> => [],
    listRaw: async (): Promise<SSHKey[]> => [],
    rotateMasterKey: async () => ({ total: 0, rotated: 0, upgraded: 0, skipped: 0, ids: [] }),
    listForAgent: async (): Promise<SSHKeyMeta[]> => [],
    get: async (): Promise<SSHKeyMeta | null> => null,
    create: async (_input: SSHKeyCreateRequest): Promise<SSHKeyMeta> => {
      throw new Error('stubSshKeys.create не реализован');
    },
    update: async (_id: string, _patch: SSHKeyUpdateRequest): Promise<SSHKeyMeta | null> => null,
    delete: async (): Promise<boolean> => false,
    linkAgent: async (): Promise<SSHKeyMeta | null> => null,
    unlinkAgent: async (): Promise<SSHKeyMeta | null> => null,
    reveal: async (): Promise<{ privateKey: string; passphrase?: string } | null> => null,
    ...overrides,
  };
}
