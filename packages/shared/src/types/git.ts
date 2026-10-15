// --- Git ---
/**
 * ADR-076: запись реестра git-репозиториев проекта. Старые данные (`repos` как
 * `string[]` либо `{ path }`) нормализуются через `normalizeGitRepoConfig`.
 */
export interface GitRepoConfig {
  /** Стабильный id записи реестра (uuid); отсутствует у обнаруженных scan-ом. */
  id?: string;
  name?: string;
  url?: string;
  type?: 'https' | 'ssh';
  /** Относительный путь ВНУТРИ project.workspace (допускает вложенность). */
  path: string;
  defaultBranch?: string;
  sshKeyId?: string;
  lastFetch?: string;
}

/**
 * ADR-076: SSH-ключ агента — отдельная сущность реестра (не в
 * `AgentDefinition`). Секреты `privateKey`/`passphrase` шифруются at-rest
 * (AES-256-GCM; реализация — в core) и НИКОГДА не отдаются через API.
 */
export interface SSHKey {
  id: string;
  name: string;
  /** Метка типа ключа, дефолт `'user'`. */
  type?: string;
  privateKey: string;
  passphrase?: string;
  /** Привязка к агентам: один ключ может обслуживать несколько агентов. */
  agentIds: string[];
  createdAt: string;
  updatedAt?: string;
}

/** Публичное представление ключа (без `privateKey`/`passphrase`). */
export type SSHKeyMeta = Omit<SSHKey, 'privateKey' | 'passphrase'>;

export interface RepoStatus {
  path: string;
  isRepo: boolean;
  currentBranch?: string;
  lastCommitAt?: string;
  lastCommitSubject?: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
  relativeDate: string;
  branch: string;
}

export interface CommitFileInfo {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface CommitDetail extends CommitInfo {
  files: CommitFileInfo[];
  diff: string;
}
