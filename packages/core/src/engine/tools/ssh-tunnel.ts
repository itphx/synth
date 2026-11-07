/**
 * PROP-124 §4c: адресный ssh-тул `ssh_tunnel` — проброс порта через SSH
 * (`-L`/`-R`).
 *
 * ## Границы (режим `tools`)
 *
 * - **Гейт — до запуска.** Единый гейт (`engine/ssh/access.ts`, PROP-124 §3)
 *   проверяет `usages`/`agentIds`/`allowHosts`/`allowPorts` и **не раскрывает**
 *   ключ при отказе. Отказ возвращается моделью как `ToolResult` с ключом
 *   `ssh.access.<code>` — тем же контрактом, что у `ssh_exec`/`ssh_copy`
 *   (`engine/ssh/result.ts`).
 * - **Порт, который проверяет гейт, — целевой.** Туннель расширяет доступ к
 *   `<target_host>:<target_port>`, поэтому именно целевой порт обязан входить
 *   в `allowPorts` ключа (пустой список = только 22). Порт подключения к
 *   ssh-хосту — отдельное поле (`port`), он к политике цели не относится.
 * - **Ключ — секрет вызова, а не аргумент.** Путь к приватному ключу в argv
 *   утекал бы в `ps`; на время жизни туннеля поднимается эфемерный
 *   `ssh-agent` (`ExecSecret.mode = 'agent'`, PROP-124 §2), материал готовит
 *   **точка исполнения** (ADR-077, протокол 4).
 * - **Слушающий сокет — только `127.0.0.1`.** Жёстко, без параметра:
 *   `0.0.0.0` открыл бы проброс наружу (на все интерфейсы), а политика
 *   ключей про такой доступ ничего не знает.
 * - **`-D` (SOCKS) не поддерживается.** У SOCKS-проброса нет целевого
 *   порта, а значит, нечего проверять политикой `allowPorts`: такой доступ
 *   был бы непроверяемым. Параметра в схеме нет вовсе; попытка его задать
 *   разбирается отдельно (см. `isSocksRequest`) и даёт внятный отказ.
 * - **Режим инстанса.** В режиме `ssh.mode = 'agent'` адресные ssh-тулы
 *   недоступны (`unavailable(policy)`, `engine/permission/availability.ts`);
 *   в plan-режиме тул блокирует permission-слой (`isPlanBlockedTool`).
 *
 * ## Туннель — всегда фоновый процесс
 *
 * Проброс порта живёт, пока живёт `ssh`: держать его в ходе агента нельзя,
 * а «успех» синхронного вызова означал бы, что туннель уже мёртв. Поэтому
 * тул **всегда** поднимает фоновый процесс (`ProcessService.spawn`) и
 * возвращает `process_id` + путь журнала; останавливается он существующим
 * инструментом `process_stop` (реестр фоновых прогонов, ADR-111/ADR-113).
 *
 * Таймаут по умолчанию — **0** (без таймаута): туннель живёт до
 * `process_stop`. Явный `timeout_ms` ограничивает его lifetime.
 */
import { z } from 'zod';
import { ToolCapability, normalizeTlsHost } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { toSshSecret } from '../../git/ssh-env.js';
import type { ExecSecret } from '../../execution/ports/index.js';
import { resolveSshAccess, SshAccessError } from '../ssh/access.js';
import { sshAccessFailureResult, sshToolFailureResult } from '../ssh/result.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isAborted, abortedResult } from './abort.js';
import { toolRuntimeRequires } from './runtime-deps.js';
import type { ProcessService } from '../processes/service.js';
import { BackgroundLimitExceededError } from '../background/types.js';
import { BackgroundUnsupportedError } from '../processes/types.js';

/** Имя тула (используется в permission-группах, trust и authority). */
export const SSH_TUNNEL_TOOL = 'ssh_tunnel';

/**
 * Верхняя граница таймаута жизни туннеля, мс (как у `ssh_exec`).
 *
 * `0` — без таймаута (по умолчанию): туннель живёт до `process_stop`.
 */
const MAX_TIMEOUT_MS = 600_000;

/** Предел длины хоста, символов (RFC 1035 — длина DNS-имени). */
const MAX_HOST_LENGTH = 253;

/** Допустимые символы хоста (те же правила, что у `ssh_exec`). */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;

/** Допустимые символы пользователя (POSIX-имя). */
const USER_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Адрес слушающего сокета — **всегда** `127.0.0.1`.
 *
 * Жёсткая константа, а не параметр: `0.0.0.0` открыл бы проброс наружу, а
 * политика ключей (`allowHosts`/`allowPorts`) такого доступа не описывает.
 */
const LISTEN_ADDRESS = '127.0.0.1';

/** Целевой хост по умолчанию для `direction: 'remote'` — локальная машина. */
const DEFAULT_REMOTE_TARGET_HOST = '127.0.0.1';

/**
 * Значения, которыми модель может попросить SOCKS-проброс (`-D`).
 *
 * Отдельный разбор нужен потому, что схема параметров SOCKS не содержит
 * (его нельзя проверить политикой портов) и strict-схема отвергла бы такой
 * вызов общим текстом «неизвестный параметр» — модель не поняла бы причину.
 */
const SOCKS_TOKENS: ReadonlySet<string> = new Set([
  'socks',
  'socks4',
  'socks5',
  'dynamic',
  '-d',
]);

/**
 * Поля, в которых модель может указать вид проброса.
 *
 * Перечисляются явно: разбор «любого значения, похожего на socks» по всему
 * объекту дал бы ложные срабатывания (например, на имени хоста).
 */
const SOCKS_FIELD_NAMES: readonly string[] = [
  'direction',
  'type',
  'mode',
  'kind',
  'protocol',
  'forward',
  'forward_type',
  'tunnel_type',
];

/**
 * Зависимости тула из `ToolContext.extra` (упаковка — оркестратор).
 */
export interface SshTunnelExtra {
  /** Порт хранилища SSH-ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  sshKeyStore?: SSHKeyRepository;
  /** Сервис фоновых процессов (ADR-113) — туннель всегда фоновый. */
  processService?: ProcessService;
  /** Фоновые прогоны разрешены инстансом (`background.enabled`). */
  backgroundEnabled?: boolean;
}

const sshTunnelSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(MAX_HOST_LENGTH)
      .regex(HOST_RE, 'host may contain only letters, digits, dots, colons, dashes and underscores')
      .refine((value) => !value.startsWith('-'), 'host must not start with a dash')
      .describe('SSH host to connect to (hostname or IP literal); the port and user are separate fields'),
    user: z
      .string()
      .min(1)
      .max(64)
      .regex(USER_RE, 'user may contain only letters, digits, dots, dashes and underscores')
      .refine((value) => !value.startsWith('-'), 'user must not start with a dash')
      .describe(
        'Remote user account (required — the ssh client config is not read, so there is no default '
        + 'user to fall back to; without it ssh would connect as the local user of the executor)',
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe('SSH port (default: 22)'),
    key_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('Id of the SSH key to use (see ssh_keys_list; omitted — the only suitable key is used)'),
    direction: z
      .enum(['local', 'remote'])
      .describe(
        'local — listen on this machine and forward to the target through the SSH host (-L); '
        + 'remote — ask the SSH host to listen and forward back to the target (-R)',
      ),
    listen_port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .describe('Port to listen on (127.0.0.1 only — the socket is never exposed outside this machine)'),
    target_host: z
      .string()
      .min(1)
      .max(MAX_HOST_LENGTH)
      .regex(HOST_RE, 'target host may contain only letters, digits, dots, colons, dashes and underscores')
      .refine((value) => !value.startsWith('-'), 'target host must not start with a dash')
      .optional()
      .describe(
        'Target host of the forwarded port (hostname or IP literal). Required for direction "local"; '
        + 'for direction "remote" it defaults to 127.0.0.1 (the target is reached from this machine)',
      ),
    target_port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .describe('Target port of the forwarded port (must be allowed by the key port policy)'),
    timeout_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Lifetime limit in milliseconds (0 / omitted — the tunnel runs until it is stopped with process_stop; max ${MAX_TIMEOUT_MS})`,
      ),
  })
  .strict();

/** Параметры тула после валидации схемой. */
interface SshTunnelParams {
  host: string;
  user: string;
  port?: number;
  key_id?: string;
  direction: 'local' | 'remote';
  listen_port: number;
  target_host?: string;
  target_port: number;
  timeout_ms?: number;
}

/**
 * Просит ли вызов SOCKS-проброс (`-D`).
 *
 * Отдельный разбор (а не «строгий» отказ схемы): у SOCKS нет целевого
 * порта, поэтому политику `allowPorts` применить не к чему — отказ должен
 * объяснять это прямо, иначе модель продолжит просить `-D`.
 */
export function isSocksRequest(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const record = args as Record<string, unknown>;
  if (record.socks === true || record.socks4 === true || record.socks5 === true) return true;
  for (const field of SOCKS_FIELD_NAMES) {
    const value = record[field];
    if (typeof value === 'string' && SOCKS_TOKENS.has(value.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * Сборка argv-команды `ssh` для туннеля.
 *
 * Порядок: `-F /dev/null` → `-p <port>` (только при заданном порте) →
 * `-o BatchMode=yes` → `-o StrictHostKeyChecking=accept-new` →
 * `-o ExitOnForwardFailure=yes` → `-N` → `-L`/`-R` со спецификацией
 * проброса → **адрес последним**.
 *
 * - `-F /dev/null` — пользовательский `~/.ssh/config` не читается: иначе
 *   конфиг хоста мог бы подсунуть `ProxyCommand`/`LocalCommand` и обойти
 *   политику хостов (как у `ssh_exec`);
 * - `-o BatchMode=yes` — без интерактивного пароля;
 * - `-o StrictHostKeyChecking=accept-new` — режим `accept-new` (PROP-124 §6);
 * - `-o ExitOnForwardFailure=yes` — туннель, которому не удалось занять
 *   порт, **падает**, а не висит мёртвым: иначе тул отчитался бы об успехе;
 * - `-N` — удалённая команда не выполняется: туннель живёт, пока живёт `ssh`;
 * - **адрес — после всех опций**: `ssh` перестаёт разбирать опции после
 *   адреса, поэтому `-L`/`-R` за адресом ушли бы в удалённую команду и
 *   проброс не создался бы.
 *
 * Спецификация проброса: `127.0.0.1:<listen_port>:<target_host>:<target_port>`
 * — слушающий адрес всегда `127.0.0.1` (жёстко, без параметра).
 *
 * Адрес — всегда `user@host`: конфиг ssh не читается (`-F /dev/null`),
 * поэтому «умолчательного» пользователя не существует — без явного `user`
 * клиент подставил бы локального пользователя исполнителя (`node`) и получил
 * бы `Permission denied (publickey,password)`.
 */
export function buildSshTunnelCommand(params: {
  host: string;
  user: string;
  port?: number;
  direction: 'local' | 'remote';
  listenPort: number;
  targetHost: string;
  targetPort: number;
}): { file: string; args: string[] } {
  const args: string[] = [];
  // Конфиг пользователя игнорируется — иначе `ProxyCommand` из `~/.ssh/config`
  // выполнился бы локально.
  args.push('-F', '/dev/null');
  if (params.port !== undefined) args.push('-p', String(params.port));
  args.push('-o', 'BatchMode=yes');
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  // Проброс, которому не удалось занять порт, должен упасть, а не висеть.
  args.push('-o', 'ExitOnForwardFailure=yes');
  // Удалённая команда не нужна — только проброс порта.
  args.push('-N');
  args.push(params.direction === 'remote' ? '-R' : '-L');
  args.push(
    `${LISTEN_ADDRESS}:${params.listenPort}:${params.targetHost}:${params.targetPort}`,
  );
  // Адрес — последним: после него опции ssh не разбираются.
  args.push(`${params.user}@${params.host}`);
  return { file: 'ssh', args };
}

/** Отображение команды для текста результата и реестра фоновых прогонов. */
function formatCommandDisplay(command: { file: string; args: string[] }): string {
  return [command.file, ...command.args].join(' ');
}

export const sshTunnelTool: ToolDefinition = {
  name: SSH_TUNNEL_TOOL,
  description:
    'Open an SSH port tunnel (addressed access, instance mode "tools"). '
    + 'Direction "local" listens on 127.0.0.1:<listen_port> on this machine and forwards to '
    + '<target_host>:<target_port> through the SSH host (-L); direction "remote" asks the SSH host to '
    + 'listen and forward back to the target (-R). The listening socket is always 127.0.0.1. '
    + 'The target port must be allowed by the key port policy; the key is chosen by id (see ssh_keys_list) '
    + 'or automatically, and the host must be allowed by the key host policy. The user is required, because '
    + 'the ssh client config is not read (-F /dev/null) and there is no default user to fall back to — '
    + 'without it ssh would connect as the local user of the executor. SOCKS forwarding (-D) is not '
    + 'supported. The tunnel always runs as a background process: it returns a process id and a log path '
    + 'immediately and stays up until it is stopped with process_stop.',
  parameters: sshTunnelSchema,
  capabilities: [ToolCapability.SSH],
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — туннель не начинаем (см. tools/abort.ts).
    if (isAborted(ctx)) return abortedResult(this.name);
    // SOCKS-проброс не поддерживается: параметра в схеме нет, поэтому заявку
    // разбираем отдельно — с внятной причиной.
    if (isSocksRequest(args)) {
      return sshToolFailureResult('ssh.tunnel.socks_unsupported', {});
    }
    const parsed = this.parameters.safeParse(args ?? {});
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as SshTunnelParams;

    const host = normalizeTlsHost(params.host);
    if (!host) {
      return argErrorResult(this.name, `host: ${params.host}`);
    }

    // Целевой хост: для `local` — обязателен (куда пробрасываем порт через
    // ssh-хост), для `remote` — по умолчанию локальная машина.
    const rawTargetHost = params.target_host ?? (
      params.direction === 'remote' ? DEFAULT_REMOTE_TARGET_HOST : undefined
    );
    if (!rawTargetHost) {
      return argErrorResult(this.name, 'target_host: is required for direction "local"');
    }
    const targetHost = normalizeTlsHost(rawTargetHost);
    if (!targetHost) {
      return argErrorResult(this.name, `target_host: ${rawTargetHost}`);
    }

    const extra = (ctx.extra ?? {}) as SshTunnelExtra;
    const store = extra.sshKeyStore;
    if (!store) {
      return sshToolFailureResult('sshkeys.tool.deps_unavailable', {});
    }

    // Единый гейт (PROP-124 §3): режим `tools` — политика хостов/портов
    // обязательна; отказ происходит **до** раскрытия ключа и до запуска
    // туннеля. Проверяется **целевой** порт: туннель расширяет доступ именно
    // к нему.
    let secret: ExecSecret;
    try {
      const access = await resolveSshAccess({
        store,
        // Адресные тулы — семантика режима `tools`: политика хостов/портов
        // применяется. В режиме `agent` тул недоступен (см. availability.ts).
        mode: 'tools',
        purpose: 'ssh',
        ...(params.key_id ? { keyId: params.key_id } : {}),
        ...(ctx.agentRole ? { agentRole: ctx.agentRole } : {}),
        host,
        port: params.target_port,
      });
      // Доставка ключа — эфемерный ssh-agent (PROP-124 §2): путь к приватному
      // ключу в argv утекал бы в `ps`.
      secret = toSshSecret(access.key, 'agent');
    } catch (err) {
      if (err instanceof SshAccessError) {
        // Отказ гейта — общий контракт (engine/ssh/result.ts): тот же текст и
        // тот же машинный код, что у остальных адресных ssh-тулов.
        return await sshAccessFailureResult(err, {
          store,
          ...(params.key_id ? { keyId: params.key_id } : {}),
          ...(ctx.agentRole ? { agentRole: ctx.agentRole } : {}),
          host,
          port: params.target_port,
        });
      }
      // Ошибка хранилища (расшифровка/мастер-ключ) — тот же контракт, что у
      // остальных ssh-тулов.
      return sshToolFailureResult('sshkey.decrypt_failed', {
        id: params.key_id ?? '',
      });
    }

    // Туннель — всегда фоновый процесс: без сервиса фоновых процессов его
    // запустить нечем.
    if (extra.backgroundEnabled === false) {
      return sshToolFailureResult('process.background_disabled', {});
    }
    const service = extra.processService;
    if (!service || !ctx.sessionId) {
      return sshToolFailureResult('process.deps_unavailable', {});
    }

    const command = buildSshTunnelCommand({
      host,
      user: params.user,
      ...(params.port !== undefined ? { port: params.port } : {}),
      direction: params.direction,
      listenPort: params.listen_port,
      targetHost,
      targetPort: params.target_port,
    });
    const displayCommand = formatCommandDisplay(command);

    try {
      const started = await service.spawn({
        sessionId: ctx.sessionId,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        // Строка команды — только для показа в UI/реестре; исполняется argv.
        command: displayCommand,
        argv: { file: command.file, args: command.args },
        // Бинарное требование тула (`ssh`) — в remote-режиме туннель живёт у
        // адреса пула, где есть клиент SSH.
        requires: toolRuntimeRequires(SSH_TUNNEL_TOOL),
        cwd: ctx.workingDir,
        // Таймаут не задан — туннель живёт до `process_stop`.
        ...(params.timeout_ms !== undefined ? { timeoutMs: params.timeout_ms } : {}),
        env: { HOME: process.env.HOME || '/root' },
        // Секреты вызова — на время жизни фонового процесса; в запись реестра
        // и в лог они не попадают.
        secrets: [secret],
      });
      const messageParams = {
        direction: params.direction,
        listen_port: String(params.listen_port),
        target: `${targetHost}:${params.target_port}`,
        host,
        id: started.processId,
        log: started.logPath,
      };
      return {
        content: sm('ssh.tunnel.started', messageParams),
        metadata: {
          process_id: started.processId,
          background_run_id: started.runId,
          status: 'running',
          log_path: started.logPath,
          command: displayCommand,
          host,
          ...(params.port !== undefined ? { port: params.port } : {}),
          direction: params.direction,
          listen_port: params.listen_port,
          target_host: targetHost,
          target_port: params.target_port,
          i18n: i18nMeta('ssh.tunnel.started', messageParams),
        },
      };
    } catch (err) {
      if (err instanceof BackgroundLimitExceededError) {
        return sshToolFailureResult('process.background_limit', { limit: String(err.limit) });
      }
      if (err instanceof BackgroundUnsupportedError) {
        return sshToolFailureResult('process.background_unsupported', {});
      }
      throw err;
    }
  },
};
