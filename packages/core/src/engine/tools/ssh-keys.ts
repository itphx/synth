/**
 * ADR-076: тул `ssh_keys_list` — метаданные SSH-ключей, доступных инстансу.
 *
 * ## Зачем
 *
 * `project_repo_clone` требует `sshKeyId` для SSH-URL (ADR-076 §T6), но у агента
 * не было ни одного тула, чтобы узнать доступные ключи: требование выполнить
 * нечем, а сообщение «SSH key is required…» не подсказывало следующий шаг —
 * агент упирался в тупик и повторял вызов.
 *
 * ## Что отдаёт
 *
 * Только **метаданные** (`id`, `name`, `type`, `agentIds`, `createdAt`): стор
 * читается через `list()`/`listForAgent()`, а не `reveal()`, поэтому приватный
 * ключ и passphrase не могут попасть в контекст модели даже при ошибке в
 * форматировании (`SSHKeyMeta` структурно не содержит секретов).
 *
 * ## Границы
 *
 * - **Только чтение**: capability `git_read` (группа `git_read` — в plan-режиме
 *   разрешён), к рабочему каталогу проекта тул **не привязан**: `ssh_keys_list`
 *   исключён из `isWorkspaceDependentTool` (`availability.ts`). Ключи — ресурс
 *   инстанса, поэтому тул работает и в сессии без проекта.
 * - **Стор — из `ctx.extra.sshKeyStore`** (как у `project_repos_*`): не задан —
 *   понятная ошибка `sshkeys.tool.deps_unavailable`, а не падение.
 * - Тексты — только через ключи `shared/i18n` (ADR-041).
 */
import { z } from 'zod';
import { ToolCapability } from '@itphx/synth-shared';
import type { SSHKeyMeta, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { isAborted, abortedResult } from './abort.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';

/** Имя тула (используется в permission-группах, trust и authority). */
export const SSH_KEYS_LIST_TOOL = 'ssh_keys_list';

/** Предел списка ключей в подсказке: больше модели не нужно — она зовёт тул. */
const MAX_HINT_KEYS = 10;

/** Зависимости тула из `ToolContext.extra` (упаковка — оркестратор). */
export interface SshKeysListExtra {
  /** Порт хранилища SSH-ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  sshKeyStore?: SSHKeyRepository;
}

/**
 * Строка ключа для списка: машиночитаемые `key=value` (как у `process_list`).
 *
 * Поля — ровно `SSHKeyMeta` без секретов; `privateKey`/`passphrase` здесь не
 * читаются вовсе (стор их и не отдаёт через `list()`/`listForAgent()`).
 */
function formatKeyLine(key: SSHKeyMeta): string {
  return [
    `- ${key.id} → ${key.name}`,
    `type=${key.type ?? 'user'}`,
    `agents=${key.agentIds.length > 0 ? key.agentIds.join(',') : '-'}`,
    `created=${key.createdAt}`,
  ].join(' | ');
}

/**
 * Текст `{keys}` подсказки: `id → name` (максимум 10) либо явное «ключей нет».
 *
 * Форма `id → name` — не украшение: `sshKeyId` принимает **ровно id**, и модель
 * должна видеть, какой ключ ей подходит по имени.
 */
export function formatSshKeysForHint(keys: SSHKeyMeta[]): string {
  if (keys.length === 0) return sm('git.ssh_keys_none');
  const shown = keys.slice(0, MAX_HINT_KEYS).map((key) => `${key.id} → ${key.name}`);
  if (keys.length > MAX_HINT_KEYS) shown.push(`… +${keys.length - MAX_HINT_KEYS}`);
  return shown.join(', ');
}

/**
 * ADR-076: подсказка вместо тупика — какие SSH-ключи есть и что с ними делать.
 *
 * `null` — стор ключей не сконфигурирован либо отказывает: вызывающий оставляет
 * прежний текст `git.ssh_key_required` без списка (поведение не ломается).
 */
export async function buildSshKeyRequiredResult(
  store: SSHKeyRepository | undefined,
  path: string,
): Promise<ToolResult | null> {
  if (!store) return null;

  let keys: SSHKeyMeta[];
  try {
    keys = await store.list();
  } catch {
    // Стор недоступен — подсказка без списка: текст остаётся прежним.
    return null;
  }

  const params = { path, keys: formatSshKeysForHint(keys) };
  return {
    content: sm('git.ssh_key_required_hint', params),
    isError: true,
    metadata: {
      i18n: i18nMeta('git.ssh_key_required_hint', params),
      // Метаданные без секретов: id/name/type/agentIds/createdAt.
      keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        type: key.type ?? 'user',
        agentIds: key.agentIds,
        createdAt: key.createdAt,
      })),
    },
  };
}

const sshKeysListSchema = z
  .object({
    agent_id: z
      .string()
      .min(1)
      .optional()
      .describe('Only keys linked to this agent (agent id, e.g. "fixer"). Omit to list all keys'),
  })
  .strict();

export const sshKeysListTool: ToolDefinition = {
  name: SSH_KEYS_LIST_TOOL,
  description:
    'List SSH keys available for git network operations (id, name, type, linked agents, creation time). '
    + 'Secrets are never returned — only metadata. Use it to find the id to pass as sshKeyId to '
    + 'project_repo_clone / project_repo_fetch for SSH URLs. Filter by agent_id to see the keys linked '
    + 'to a specific agent. If the list is empty, the user has to add a key in Settings → SSH keys.',
  parameters: sshKeysListSchema,
  capabilities: [ToolCapability.GIT_READ],
  async execute(args, ctx) {
    // «Стоп» пришёл до запуска — стор не читаем (см. tools/abort.ts)
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args ?? {});
    if (!parsed.success) return argErrorResult(this.name, parsed.error.issues);
    const params = parsed.data as { agent_id?: string };

    const extra = (ctx.extra ?? {}) as SshKeysListExtra;
    const store = extra.sshKeyStore;
    if (!store) {
      return {
        content: sm('sshkeys.tool.deps_unavailable'),
        isError: true,
        metadata: { i18n: i18nMeta('sshkeys.tool.deps_unavailable') },
      };
    }

    let keys: SSHKeyMeta[];
    try {
      keys = params.agent_id ? await store.listForAgent(params.agent_id) : await store.list();
    } catch (err) {
      return {
        content: sm('tool.exec_error', {
          tool: this.name,
          error: err instanceof Error ? err.message : String(err),
        }),
        isError: true,
      };
    }

    const keyMeta = keys.map((key) => ({
      id: key.id,
      name: key.name,
      type: key.type ?? 'user',
      agentIds: key.agentIds,
      createdAt: key.createdAt,
    }));

    if (keys.length === 0) {
      return {
        content: sm('sshkeys.tool.empty'),
        metadata: { count: 0, keys: [], i18n: i18nMeta('sshkeys.tool.empty') },
      };
    }

    const lines = [
      sm('sshkeys.tool.header', { count: String(keys.length) }),
      ...keys.map(formatKeyLine),
    ];
    // Без metadata.i18n: блок многострочный (заголовок + строки ключей), как у
    // `process_list`/`list_models` — иначе UI подменил бы content переводом
    // одного ключа и список бы потерялся.
    return {
      content: lines.join('\n'),
      metadata: {
        count: keys.length,
        keys: keyMeta,
        ...(params.agent_id ? { agent_id: params.agent_id } : {}),
      },
    };
  },
};
