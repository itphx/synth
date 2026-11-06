/**
 * Контракт отказа гейта SSH-доступа (PROP-124 §3) — **общий для всех
 * потребителей** гейта.
 *
 * ## Зачем отдельный модуль
 *
 * Гейт (`engine/ssh/access.ts`) решает, можно ли раскрыть ключ; **как** этот
 * отказ выглядит для модели и для UI — отдельный контракт. Адресных ssh-тулов
 * больше одного (`ssh_exec`, `ssh_copy`, дальше `ssh_tunnel`), и текст отказа,
 * машинный код и `metadata.i18n` у них должны совпадать: иначе один и тот же
 * отказ гейта выглядел бы по-разному в зависимости от тула.
 *
 * Поэтому здесь лежат:
 *
 * - `sshAccessErrorKey` — ключ i18n по машинному коду отказа;
 * - `sshAccessErrorParams` — параметры подстановки (имя ключа/хост/порт);
 * - `sshAccessFailureResult` — готовый `ToolResult` отказа (content + код +
 *   i18n);
 * - `sshToolFailureResult` — отказ ключом i18n без машинного кода (стор
 *   недоступен, ключ не расшифрован).
 *
 * ## Правила оформления текста
 *
 * - **Материал ключа в текст не попадает**: только имя ключа (метаданные
 *   стора), хост и порт. Перечень ключей инстанса наружу не отдаётся — его
 *   даёт инструмент `ssh_keys_list`;
 * - отказ гейта **не раскрывает** ключ: `reveal()` внутри гейта не вызывается
 *   при отказе (см. `engine/ssh/access.ts`).
 */
import type { ToolResult } from '@itphx/synth-shared';
import { normalizeSshKeyUsages } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import type { SystemMessageKey } from '../system-messages.js';
import { SshAccessError, type SshAccessErrorCode } from './access.js';

/**
 * Контекст текста отказа гейта.
 *
 * Те же поля, что у запроса гейта (`SshAccessSshRequest`), — но без `mode`:
 * текст отказа от режима инстанса не зависит.
 */
export interface SshAccessErrorContext {
  /** Порт хранилища SSH-ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  store: SSHKeyRepository;
  /** Явный id ключа (его запросил агент). */
  keyId?: string;
  /** Роль агента — по ней выбирается имя ключа в тексте отказа. */
  agentRole?: string;
  /** Хост подключения — попадает в текст отказа `host_denied`. */
  host: string;
  /** Порт подключения — попадает в текст отказа `port_denied`. */
  port?: number;
}

/**
 * Ключ i18n отказа гейта (ADR-041).
 *
 * У каждого машинного кода гейта (`SshAccessErrorCode`) свой ключ
 * `ssh.access.<code>` — текст отказа единый для всех потребителей гейта
 * (адресные ssh-тулы, HTTP-роуты), а не только для `ssh_exec`.
 */
export function sshAccessErrorKey(code: SshAccessErrorCode): SystemMessageKey {
  switch (code) {
    case 'key_not_found':
      return 'ssh.access.key_not_found';
    case 'usage_denied':
      return 'ssh.access.usage_denied';
    case 'agent_not_linked':
      return 'ssh.access.agent_not_linked';
    case 'host_denied':
      return 'ssh.access.host_denied';
    case 'port_denied':
      return 'ssh.access.port_denied';
    case 'policy_required':
      return 'ssh.access.policy_required';
    case 'ambiguous':
      return 'ssh.access.ambiguous';
  }
}

/**
 * Параметры подстановки отказа гейта.
 *
 * `{key}` — **имя** выбранного ключа (не список ключей: перечень реестра в
 * текст отказа не попадает — модель берёт нужный id через `ssh_keys_list`).
 * `{keys}` (код `ambiguous`) — тоже без перечисления: вместо него указывается
 * инструмент, который перечень даёт.
 */
export async function sshAccessErrorParams(
  err: SshAccessError,
  ctx: SshAccessErrorContext,
): Promise<Record<string, string>> {
  switch (err.code) {
    case 'usage_denied':
      return { key: await resolveKeyLabel(ctx), usage: 'ssh' };
    case 'agent_not_linked':
      return { key: await resolveKeyLabel(ctx), agent: ctx.agentRole ?? '—' };
    case 'host_denied':
      return { key: await resolveKeyLabel(ctx), host: ctx.host };
    case 'port_denied':
      return {
        key: await resolveKeyLabel(ctx),
        port: String(ctx.port ?? 22),
      };
    case 'policy_required':
      return { key: await resolveKeyLabel(ctx) };
    case 'ambiguous':
      // Перечень ключей не раскрываем: указываем инструмент, который его даёт.
      return { keys: 'ssh_keys_list' };
    case 'key_not_found':
      // Ключа нет — называем его id (тот, что запросил агент); без явного id
      // подходящих ключей в инстансе нет вовсе.
      return { key: ctx.keyId ?? '—' };
  }
}

/**
 * Имя ключа для текста отказа.
 *
 * Только **имя выбранного** ключа (метаданные стора, без секретов): гейт уже
 * выбрал ключ, а перечень реестра наружу не уходит. Явный `key_id` известен
 * точно; без него подходит ровно один ключ (иначе гейт вернул бы `ambiguous`).
 */
async function resolveKeyLabel(ctx: {
  store: SSHKeyRepository;
  keyId?: string;
  agentRole?: string;
}): Promise<string> {
  try {
    if (ctx.keyId) {
      const meta = await ctx.store.get(ctx.keyId);
      return meta?.name ?? ctx.keyId;
    }
    const agentRole = ctx.agentRole?.trim();
    if (!agentRole) return '';
    const candidates = (await ctx.store.list()).filter(
      (meta) =>
        normalizeSshKeyUsages(meta.usages).includes('ssh') && meta.agentIds.includes(agentRole),
    );
    return candidates.length === 1 ? candidates[0]!.name : '';
  } catch {
    // Хранилище недоступно — текст отказа без имени ключа (сам отказ уже есть).
    return '';
  }
}

/**
 * Отказ гейта — готовый результат тула.
 *
 * В метаданных — **машинный код** отказа (`keyCode`): по нему вызывающий
 * (UI/аудит) различает причины, не разбирая текст.
 */
export async function sshAccessFailureResult(
  err: SshAccessError,
  ctx: SshAccessErrorContext,
): Promise<ToolResult> {
  const key = sshAccessErrorKey(err.code);
  const params = await sshAccessErrorParams(err, ctx);
  return {
    content: sm(key, params),
    isError: true,
    metadata: {
      // Машинный код отказа — по нему вызывающий (UI/аудит) различает
      // причины, не разбирая текст.
      keyCode: err.code,
      i18n: i18nMeta(key, params),
    },
  };
}

/**
 * Отказ тула ключом i18n — без машинного кода.
 *
 * Случаи: стор ключей недоступен в этой сборке, ключ не расшифрован
 * (ошибка хранилища/мастер-ключа). Тексты — те же, что у `ssh_exec`.
 */
export function sshToolFailureResult(
  key: SystemMessageKey,
  params: Record<string, string>,
): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { i18n: i18nMeta(key, params) },
  };
}
