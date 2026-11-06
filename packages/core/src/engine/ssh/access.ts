/**
 * PROP-124 §3: **единый гейт** доступа к SSH-ключам.
 *
 * ## Зачем
 *
 * Ключи инстанса используются в двух сценариях (PROP-124 §0–§2):
 *
 * - `purpose:'git'` — ключ подставляется в git-операции (`GIT_SSH_COMMAND`);
 * - `purpose:'ssh'` — ключ выдаётся адресным тулам (режим `tools`) или
 *   эфемерному `ssh-agent` (режим `agent`).
 *
 * Правила у сценариев разные, но **точка раскрытия секрета должна быть одна**:
 * `reveal()` вызывается только здесь. Иначе политика (`usages`/`agentIds`/
 * хосты/порты) разойдётся по подсистемам, а второй вызов `reveal()` станет
 * обходом гейта.
 *
 * ## Правила (PROP-124 §1, §3)
 *
 * | | `git` | `ssh` |
 * |---|---|---|
 * | `usages` | обязан содержать `git` | обязан содержать `ssh` |
 * | `agentIds` | **не проверяется** (решение владельца: обязательная привязка — только для ssh) | **обязателен**: роль агента должна быть в списке |
 * | хост/порт | не проверяются | проверяются **только** в режиме `tools` |
 *
 * Режим `agent` (PROP-124 §0): фильтрация по хостам **не применяется** —
 * ограничение живёт на стороне хоста (`authorized_keys`). Поэтому в режиме
 * `agent` хост и порт не нужны и могут отсутствовать.
 *
 * ## Fail-closed
 *
 * - пустой `allowHosts` → ни один хост не разрешён (`host_denied`);
 * - пустой `allowPorts` → разрешён только порт 22 (`port_denied` иначе);
 * - `*.suffix` матчит только поддомены, CIDR — только IP-литерал: матчер
 *   общий (`hostMatchesRule`, ADR-099) — второй не заводим;
 * - отказ происходит **до** `reveal()`: при отказе секрет не раскрывается
 *   никогда (в т.ч. при `usage_denied`/`host_denied`).
 *
 * ## Ошибки
 *
 * Отказ политики — `SshAccessError` с машинным кодом (`code`); в `message` —
 * имя ключа/хост, **без материала** (приватный ключ и passphrase в текст
 * ошибок не попадают). Ошибки **хранилища** (расшифровка, отсутствие
 * мастер-ключа) пробрасываются как `SSHKeyStoreError` — это не отказ
 * политики, у них свой i18n-контракт (`sshkey.decrypt_failed`).
 */
import type { SshMode, SSHKeyMeta, SSHKeyUsage } from '@itphx/synth-shared';
import {
  normalizeSshKeyAllowHosts,
  normalizeSshKeyAllowPorts,
  normalizeSshKeyUsages,
  normalizeTlsHost,
} from '@itphx/synth-shared';
import type { ExecSecret } from '../../execution/ports/index.js';
import { toSshSecret } from '../../git/ssh-env.js';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { hostMatchesRule } from '../mcp/network-policy.js';

/** Назначение раскрытия ключа. */
export type SshPurpose = 'git' | 'ssh';

/**
 * Машинные коды отказа гейта.
 *
 * - `key_not_found` — ключа нет (или нет подходящего);
 * - `usage_denied` — ключ не разрешён для этого назначения (`usages`);
 * - `agent_not_linked` — ключ не привязан к роли агента (`agentIds`);
 * - `host_denied` — хост не входит в `allowHosts` (режим `tools`);
 * - `port_denied` — порт не входит в `allowPorts` (режим `tools`);
 * - `policy_required` — запрос не несёт обязательного входа политики
 *   (в режиме `tools` — хост);
 * - `ambiguous` — подходящих ключей несколько, нужен конкретный.
 */
export type SshAccessErrorCode =
  | 'key_not_found'
  | 'usage_denied'
  | 'agent_not_linked'
  | 'host_denied'
  | 'port_denied'
  | 'policy_required'
  | 'ambiguous';

/**
 * Отказ гейта: машинный код + человекочитаемый текст.
 *
 * Текст содержит только имя ключа/хост — **никогда** материал ключа.
 */
export class SshAccessError extends Error {
  constructor(
    readonly code: SshAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SshAccessError';
  }
}

/**
 * Запрос на раскрытие ключа для **git-операций**.
 *
 * Режим инстанса (`ssh.mode`) здесь **не применяется** (PROP-124 §3): для git
 * проверяются только `usages`/`agentIds` не проверяются вовсе. Поэтому поле
 * `mode` в запросе отсутствует — передавать константу было бы ловушкой
 * (режим выглядел бы применяемым, но не влиял на проверки).
 */
export interface SshAccessGitRequest {
  /** Порт хранилища ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  store: SSHKeyRepository;
  /** Назначение раскрытия. */
  purpose: 'git';
  /** Явный id ключа; не задан — ключ выбирается по правилам гейта. */
  keyId?: string;
  /** Роль агента (для git — не проверяется, оставлен для единого запроса). */
  agentRole?: string;
}

/**
 * Запрос на раскрытие ключа для **ssh-доступа**.
 *
 * Здесь режим инстанса обязателен: в режиме `tools` проверяются хосты/порты
 * (fail-closed), в режиме `agent` — не применяются (PROP-124 §0/§1).
 */
export interface SshAccessSshRequest {
  /** Порт хранилища ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  store: SSHKeyRepository;
  /** Режим инстанса, разрешённый на момент вызова (PROP-124 §0). */
  mode: SshMode;
  /** Назначение раскрытия. */
  purpose: 'ssh';
  /** Явный id ключа; не задан — ключ выбирается по правилам гейта. */
  keyId?: string;
  /** Роль агента (для `purpose:'ssh'` — обязательная привязка). */
  agentRole?: string;
  /** Хост подключения (для `purpose:'ssh'` в режиме `tools`). */
  host?: string;
  /** Порт подключения (по умолчанию 22). */
  port?: number;
}

/** Запрос на раскрытие ключа (union по назначению). */
export type SshAccessRequest = SshAccessGitRequest | SshAccessSshRequest;

/** Результат гейта: раскрытый секрет + метаданные ключа. */
export interface SshAccessResult {
  /** Материал ключа (приватный ключ + опциональная passphrase). */
  key: { privateKey: string; passphrase?: string };
  /** Метаданные ключа (без секретов) — для аудита и сообщений. */
  meta: SSHKeyMeta;
}

/** Порт SSH по умолчанию: пустой `allowPorts` = разрешён только 22. */
export const DEFAULT_SSH_PORT = 22;

/**
 * Предел числа секретов вызова в одном запросе (PROP-124 §7).
 *
 * Совпадает с лимитом протокола исполнителя (`EXEC_SECRET_LIMITS.maxEntries`):
 * больше ключей в один вызов не доставить — лишние молча отбрасывались бы,
 * и агент не знал бы, что часть ключей не применена.
 */
export const MAX_SSH_EXEC_SECRETS = 4;

/** Минимальный логгер (console-совместимый) — предупреждения без материала. */
export interface SshAccessLogger {
  warn?: (message: string) => void;
}

/** Запрос набора секретов вызова для режима `agent`. */
export interface SshSecretsForExecRequest {
  /** Порт хранилища ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  store: SSHKeyRepository;
  /** Режим инстанса, разрешённый на момент вызова (PROP-124 §0). */
  mode: SshMode;
  /** Роль агента: ключ выдаётся только привязанным к ней (`agentIds`). */
  agentRole?: string;
  /** Логгер предупреждений (по умолчанию — console). */
  logger?: SshAccessLogger;
}

/**
 * Секреты вызова для режима `agent` (PROP-124 §0/§2).
 *
 * ## Что делает
 *
 * - `mode !== 'agent'` → **пустой массив**: в режиме `tools` ключ в окружение
 *   команд не попадает никогда (адресные тулы подставляют его сами);
 * - режим `agent` → все ключи с `usages: 'ssh'`, привязанные к роли агента
 *   (`agentIds`), в режиме доставки `agent` (эфемерный `ssh-agent`).
 *
 * ## Правила
 *
 * - **Ключ без привязки не берётся** (у `agentIds` пусто — ключ не выдаётся
 *   ни одной роли): привязка — единственный ACL режима `agent` (PROP-124 §1);
 * - **не больше `MAX_SSH_EXEC_SECRETS`** (лимит протокола): лишние ключи
 *   отбрасываются по стабильному порядку (имя, затем id) с предупреждением в
 *   лог — **без материала** (в лог уходят только имена ключей);
 * - **ошибки не бросаются**: нет подходящих ключей — пустой массив; ключ,
 *   который не удалось раскрыть (ошибка хранилища), — пропускается с
 *   предупреждением. Отказ гейта по политике для выбранных ключей невозможен
 *   (они отобраны по `usages`/`agentIds` заранее), но и он не должен ронять
 *   вызов: команда уходит без ключа, а не падает.
 *
 * ## Раскрытие
 *
 * Материал берётся **только** через гейт (`resolveSshAccess`): второй точки
 * раскрытия секрета в ядре нет (ADR-076/PROP-124 §3).
 */
export async function resolveSshSecretsForExec(
  req: SshSecretsForExecRequest,
): Promise<ExecSecret[]> {
  // Режим `tools` — ключ в shell не попадает никогда (PROP-124 §0).
  if (req.mode !== 'agent') return [];

  const agentRole = req.agentRole?.trim();
  // Без роли привязку не проверить — fail-closed (ключ не выдаётся).
  if (!agentRole) return [];

  const warn = req.logger?.warn ?? ((message: string) => console.warn(message));

  let metas: SSHKeyMeta[];
  try {
    metas = await req.store.list();
  } catch (err) {
    warn(
      `[ssh] не удалось получить список SSH-ключей: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const candidates = metas
    .filter((meta) => normalizeSshKeyUsages(meta.usages).includes('ssh'))
    .filter((meta) => meta.agentIds.includes(agentRole))
    // Стабильный порядок: одинаковый набор ключей всегда даёт один и тот же
    // результат (иначе усечение зависело бы от порядка стора).
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  if (candidates.length > MAX_SSH_EXEC_SECRETS) {
    const dropped = candidates.slice(MAX_SSH_EXEC_SECRETS).map((meta) => meta.name);
    warn(
      `[ssh] SSH-ключей для роли «${agentRole}» больше лимита вызова (${MAX_SSH_EXEC_SECRETS}) — `
      + `часть ключей не выдана: ${dropped.join(', ')}`,
    );
  }

  const secrets: ExecSecret[] = [];
  for (const meta of candidates.slice(0, MAX_SSH_EXEC_SECRETS)) {
    try {
      // Единый гейт: `usages`/`agentIds` проверяются, `reveal()` — внутри.
      const access = await resolveSshAccess({
        store: req.store,
        mode: 'agent',
        purpose: 'ssh',
        keyId: meta.id,
        agentRole,
      });
      secrets.push(toSshSecret(access.key, 'agent'));
    } catch (err) {
      // Ключ не раскрылся (ошибка хранилища/мастер-ключа) — пропускаем его:
      // остальные ключи роли ещё пригодны. Материал в лог не попадает.
      warn(
        `[ssh] SSH-ключ «${meta.name}» не выдан: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return secrets;
}

/** Параметры сборки резолвера секретов вызова (см. `createSshSecretsResolver`). */
export interface SshSecretsResolverParams {
  /** Порт хранилища ключей (нет — секреты не выдаются). */
  store?: SSHKeyRepository;
  /** Текущий режим инстанса (live — смена режима применяется без рестарта). */
  getMode: () => SshMode;
  /**
   * Роль агента — **геттер**: роль читается **в момент вызова**, а не при
   * создании резолвера.
   *
   * Причина — ACL ключа (`agentIds`, PROP-124 §1): ключ выдаётся той роли,
   * которая исполняет вызов. Роль может отличаться от роли, создавшей
   * резолвер: у сабагента она своя (см. `engine/tools/task/run-cycle.ts` —
   * там резолвер собирается для роли **ребёнка**), а у основной сессии роль
   * может смениться между вызовами.
   */
  agentRole?: () => string | undefined;
  /**
   * Признак «ход в режиме планирования» (ADR-025).
   *
   * В plan-режиме ключ **не выдаётся**: план ничего не выполняет, а ключ в
   * окружении планирования утекал бы в текст плана/лог.
   */
  isPlan?: () => boolean;
  /** Логгер предупреждений (по умолчанию — console). */
  logger?: SshAccessLogger;
}

/**
 * Резолвер секретов вызова для тула `execute_shell` (PROP-124 §2).
 *
 * Собирается оркестратором **один раз** (там, где собирается `extra` тула)
 * и кладётся в контекст как `sshSecrets`. Тулу остаётся только спросить:
 * «какие ключи положены в этот вызов» — политику (режим инстанса, роль
 * агента, plan-режим) решает оркестратор, а не тул.
 *
 * Фабрика существует, чтобы правило «в plan — ключ не выдаётся» и правило
 * «ключ выдаётся по роли **исполняющего** вызова» проверялись тестом без
 * оркестратора.
 */
export function createSshSecretsResolver(
  params: SshSecretsResolverParams,
): () => Promise<ExecSecret[]> {
  return async () => {
    const store = params.store;
    if (!store) return [];
    // Plan-режим — ключ не выдаётся (инвариант: ключ в plan не попадает).
    if (params.isPlan?.() === true) return [];
    // Роль — в момент вызова (геттер): у сабагента своя, у основной сессии
    // роль может смениться.
    const agentRole = params.agentRole?.()?.trim();
    if (!agentRole) return [];
    return resolveSshSecretsForExec({
      store,
      mode: params.getMode(),
      agentRole,
      ...(params.logger !== undefined ? { logger: params.logger } : {}),
    });
  };
}

/**
 * Единый шов раскрытия SSH-ключа (PROP-124 §3).
 *
 * Порядок проверок (каждый шаг — fail-closed):
 * 1. выбор ключа (явный `keyId` либо единственный подходящий);
 * 2. тип использования (`usages`);
 * 3. привязка к агенту (`agentIds`) — только для `purpose:'ssh'`;
 * 4. хост/порт (`allowHosts`/`allowPorts`) — только для `purpose:'ssh'`
 *    в режиме `tools`;
 * 5. раскрытие секрета (`reveal`) — **последним**.
 */
export async function resolveSshAccess(req: SshAccessRequest): Promise<SshAccessResult> {
  const usage: SSHKeyUsage = req.purpose === 'git' ? 'git' : 'ssh';
  const meta = await selectKey(req, usage);

  // 1) Тип использования: ключ без нужного `usage` не раскрывается.
  const usages = normalizeSshKeyUsages(meta.usages);
  if (!usages.includes(usage)) {
    throw new SshAccessError(
      'usage_denied',
      `SSH-ключ «${meta.name}» не разрешён для ${usage === 'git' ? 'git-операций' : 'ssh-доступа'}`,
    );
  }

  // 2) Привязка к агенту — обязательна только для ssh (решение владельца).
  if (req.purpose === 'ssh') {
    const agentRole = req.agentRole?.trim();
    if (!agentRole || !meta.agentIds.includes(agentRole)) {
      throw new SshAccessError(
        'agent_not_linked',
        `SSH-ключ «${meta.name}» не привязан к роли «${agentRole || '—'}»`,
      );
    }

    // 3) Политика хостов/портов — только в режиме `tools`. В режиме `agent`
    //    фильтрация по хостам не применяется (PROP-124 §0/§1).
    if (req.mode === 'tools') {
      assertHostAllowed(meta, req.host);
      assertPortAllowed(meta, req.port);
    }
  }

  // 4) Раскрытие — последним: до этого момента все проверки пройдены,
  //    при отказе `reveal()` не вызывается вовсе.
  const key = await req.store.reveal(meta.id);
  if (!key) {
    throw new SshAccessError('key_not_found', `SSH-ключ «${meta.name}» не найден`);
  }
  return { key, meta };
}

/**
 * Выбор ключа: явный `keyId` либо единственный подходящий.
 *
 * Без `keyId` подходят ключи с нужным `usage`; для `purpose:'ssh'` — ещё и
 * привязанные к роли агента. Ноль → `key_not_found`, несколько →
 * `ambiguous` (в тексте — имена ключей, чтобы выбор был однозначен).
 */
async function selectKey(req: SshAccessRequest, usage: SSHKeyUsage): Promise<SSHKeyMeta> {
  if (req.keyId) {
    const meta = await req.store.get(req.keyId);
    if (!meta) {
      throw new SshAccessError('key_not_found', `SSH-ключ «${req.keyId}» не найден`);
    }
    return meta;
  }

  const agentRole = req.agentRole?.trim();
  const candidates = (await req.store.list()).filter((meta) => {
    if (!normalizeSshKeyUsages(meta.usages).includes(usage)) return false;
    // Для git привязка к агенту не проверяется (решение владельца).
    if (req.purpose === 'git') return true;
    return Boolean(agentRole) && meta.agentIds.includes(agentRole as string);
  });

  if (candidates.length === 0) {
    throw new SshAccessError('key_not_found', `Подходящих SSH-ключей (${usage}) в инстансе нет`);
  }
  if (candidates.length > 1) {
    throw new SshAccessError(
      'ambiguous',
      `Подходящих SSH-ключей несколько: ${candidates.map((meta) => meta.name).join(', ')} — нужен конкретный`,
    );
  }
  return candidates[0] as SSHKeyMeta;
}

/**
 * Хост должен входить в `allowHosts` (режим `tools`).
 *
 * Пустой список — **ничего не разрешено** (fail-closed), а не «разрешено
 * всё». Правила хостов — общие с ADR-099: точный hostname, `*.suffix`
 * (только поддомены), IP-литерал/CIDR (только по IP-литералу).
 */
function assertHostAllowed(meta: SSHKeyMeta, rawHost: string | undefined): void {
  const host = normalizeTlsHost(rawHost);
  if (!host) {
    throw new SshAccessError(
      'policy_required',
      `Для SSH-ключа «${meta.name}» нужен хост: политика хостов обязательна`,
    );
  }
  const allowHosts = normalizeSshKeyAllowHosts(meta.allowHosts);
  if (allowHosts.length === 0) {
    throw new SshAccessError(
      'host_denied',
      `У SSH-ключа «${meta.name}» не задан список разрешённых хостов`,
    );
  }
  if (!allowHosts.some((rule) => hostMatchesRule(host, rule))) {
    throw new SshAccessError(
      'host_denied',
      `Хост «${host}» не разрешён для SSH-ключа «${meta.name}»`,
    );
  }
}

/** Порт должен входить в `allowPorts`; пустой список — только 22. */
function assertPortAllowed(meta: SSHKeyMeta, rawPort: number | undefined): void {
  const port = rawPort ?? DEFAULT_SSH_PORT;
  const allowPorts = normalizeSshKeyAllowPorts(meta.allowPorts);
  const allowed = allowPorts.length > 0 ? allowPorts : [DEFAULT_SSH_PORT];
  if (!allowed.includes(port)) {
    throw new SshAccessError(
      'port_denied',
      `Порт ${port} не разрешён для SSH-ключа «${meta.name}»`,
    );
  }
}
