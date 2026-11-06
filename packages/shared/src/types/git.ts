// --- Git ---
import { HOST_RULE_FORMAT_HINT, isValidHostRule } from './host-pattern.js';

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
 * PROP-124: способы использования SSH-ключа.
 *
 * - `git` — ключ подставляется в git-операции (`GIT_SSH_COMMAND`), как раньше;
 * - `ssh` — ключ выдаётся командам вызова (режим инстанса `agent`) или
 *   адресным тулам (режим `tools`).
 *
 * Поле `usages` опционально ради обратной совместимости: у ключей, созданных
 * до Ф1, его нет — при чтении нормализуется в `['git']` (fail-closed).
 */
export type SSHKeyUsage = 'git' | 'ssh';

/** Канонический список типов использования SSH-ключа (PROP-124). */
export const SSH_KEY_USAGES = ['git', 'ssh'] as const;

/**
 * PROP-124: режим работы инстанса с SSH-ключами.
 *
 * - `tools` — ключ попадает к потребителю через argv адресных тулов (`-i`),
 *   политика хостов/портов на ключе обязательна;
 * - `agent` — ключ выдаётся через эфемерный `ssh-agent` на время вызова,
 *   фильтрация по хостам не применяется (ограничение — на стороне хоста,
 *   `authorized_keys`).
 *
 * Дефолт — `tools` (fail-closed: без явного выбора ключ в окружение команд не
 * попадает).
 */
export type SshMode = 'tools' | 'agent';

/** Канонический список режимов инстанса (PROP-124). */
export const SSH_MODES = ['tools', 'agent'] as const;

/** Предел числа хостов в политике ключа (PROP-124) — `allowHosts`. */
export const MAX_SSH_ALLOW_HOSTS = 50;

/** Предел числа портов в политике ключа (PROP-124) — `allowPorts`. */
export const MAX_SSH_ALLOW_PORTS = 10;

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
  /**
   * PROP-124: способы использования ключа (`git`/`ssh`). Отсутствует у ключей,
   * созданных до Ф1 → при чтении нормализуется в `['git']`.
   */
  usages?: SSHKeyUsage[];
  /**
   * PROP-124: политика хостов (режим `tools`): точный hostname, `*.suffix`,
   * IP-литерал или CIDR. В режиме `agent` не применяется.
   */
  allowHosts?: string[];
  /**
   * PROP-124: политика портов (режим `tools`): 1..65535; пусто — 22 (ssh).
   */
  allowPorts?: number[];
  createdAt: string;
  updatedAt?: string;
}

/** Публичное представление ключа (без `privateKey`/`passphrase`). */
export type SSHKeyMeta = Omit<SSHKey, 'privateKey' | 'passphrase'>;

/**
 * PROP-124: нормализация типов использования ключа.
 *
 * Поле отсутствует (ключ создан до Ф1) → `['git']` (fail-closed: git-путь
 * работает как раньше). Явно пустой массив сохраняется пустым — но записать
 * его больше нельзя (см. `validateSshKeyPolicy`): в таких легаси-записях ключ
 * не проходит гейт ни для git, ни для ssh.
 */
export function normalizeSshKeyUsages(
  usages: readonly SSHKeyUsage[] | undefined,
): SSHKeyUsage[] {
  if (usages === undefined) return ['git'];
  return [...usages];
}

/**
 * PROP-124: нормализация списка хостов — отсутствует → `[]`; элементы
 * обрезаются от пробелов, пустые отбрасываются.
 */
export function normalizeSshKeyAllowHosts(hosts: readonly string[] | undefined): string[] {
  if (!hosts) return [];
  return hosts.map((host) => host.trim()).filter((host) => host !== '');
}

/**
 * PROP-124: нормализация списка портов — отсутствует → `[]`.
 * Порты-дубликаты сохраняются (смысла дедуплицировать нет, порядок важен
 * только для отображения).
 */
export function normalizeSshKeyAllowPorts(ports: readonly number[] | undefined): number[] {
  if (!ports) return [];
  return [...ports];
}

/** Результат проверки политики SSH-ключа (PROP-124). */
export type SshKeyPolicyValidation = { ok: true } | { ok: false; message: string };

/**
 * PROP-124: проверка политики ключа — типы использования, правила хостов и
 * порты. Fail-closed: любое нарушение → отказ с понятным сообщением
 * (`message` — для ответа API `400 VALIDATION_ERROR`).
 */
export function validateSshKeyPolicy(input: {
  usages?: readonly SSHKeyUsage[];
  allowHosts?: readonly string[];
  allowPorts?: readonly number[];
}): SshKeyPolicyValidation {
  if (input.usages) {
    // Пустой список — «ключ, который ничего не умеет»: не годен ни для git,
    // ни для ssh. Запрещён на записи (и в API-схеме, и в хранилищах).
    if (input.usages.length === 0) {
      return {
        ok: false,
        message: `usages: нужен хотя бы один способ использования (${SSH_KEY_USAGES.join('|')})`,
      };
    }
    for (const usage of input.usages) {
      if (!(SSH_KEY_USAGES as readonly string[]).includes(usage)) {
        return { ok: false, message: `usages: недопустимое значение "${usage}" (ожидается ${SSH_KEY_USAGES.join('|')})` };
      }
    }
  }
  if (input.allowHosts) {
    if (input.allowHosts.length > MAX_SSH_ALLOW_HOSTS) {
      return {
        ok: false,
        message: `allowHosts: не больше ${MAX_SSH_ALLOW_HOSTS} правил на ключ`,
      };
    }
    for (const raw of input.allowHosts) {
      const rule = typeof raw === 'string' ? raw.trim() : '';
      if (!rule) {
        return { ok: false, message: 'allowHosts: пустые правила недопустимы' };
      }
      if (!isValidHostRule(rule)) {
        return {
          ok: false,
          message: `allowHosts: невалидный шаблон хоста "${rule}" — ${HOST_RULE_FORMAT_HINT}`,
        };
      }
    }
  }
  if (input.allowPorts) {
    if (input.allowPorts.length > MAX_SSH_ALLOW_PORTS) {
      return {
        ok: false,
        message: `allowPorts: не больше ${MAX_SSH_ALLOW_PORTS} портов на ключ`,
      };
    }
    for (const port of input.allowPorts) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return {
          ok: false,
          message: `allowPorts: недопустимый порт "${port}" (ожидается целое 1..65535)`,
        };
      }
    }
  }
  return { ok: true };
}

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
  /**
   * Diff обрезан по лимиту размера (`MAX_COMMIT_DIFF_BYTES`): поле присутствует
   * и равно `true`, когда diff неполон. Отсутствует — diff отдан целиком.
   */
  diff_truncated?: boolean;
}
