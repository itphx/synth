/**
 * PROP-124 §4: адресный ssh-тул `ssh_exec` — выполнение команды на удалённом
 * хосте по SSH.
 *
 * ## Границы (режим `tools`)
 *
 * - **argv, а не shell.** Команда собирается тулом: `ssh -F /dev/null [-p
 *   <port>] -o BatchMode=yes -o StrictHostKeyChecking=accept-new <user@host> --
 *   <argv…>`. Локальной оболочки нет (`command.kind:'argv'`), поэтому значение
 *   аргумента не может стать инъекцией. `-F /dev/null` отключает чтение
 *   пользовательского `~/.ssh/config` (иначе конфиг хоста мог бы подсунуть
 *   `ProxyCommand`/`LocalCommand` и обойти политику хостов). Разделитель `--`
 *   стоит **после** адреса: ssh трактует всё, что за ним, как удалённую
 *   команду — поэтому `-o`/`-F`/`-J`/`-l`/`-i` в `argv` остаются аргументами
 *   удалённой команды и локальный ssh их не исполнит (адрес/пользователь/порт
 *   задаются только полями).
 * - **Ключ — секрет вызова, а не аргумент.** Путь к приватному ключу в argv
 *   утекал бы в `ps`; вместо этого на время вызова поднимается эфемерный
 *   `ssh-agent` (`ExecSecret.mode = 'agent'`, PROP-124 §2), а материал ключа
 *   готовит **точка исполнения** (ADR-077, протокол 4).
 * - **Политика хоста/порта — до запуска.** Единый гейт
 *   (`engine/ssh/access.ts`, PROP-124 §3) проверяет `usages`/`agentIds`/
 *   `allowHosts`/`allowPorts` и **не раскрывает** ключ при отказе. Отказ
 *   возвращается моделью как `ToolResult` с ключом `ssh.access.<code>`;
 *   список ключей в текст не попадает.
 * - **Режим инстанса.** В режиме `ssh.mode = 'agent'` адресные ssh-тулы
 *   недоступны (`unavailable(policy)`, `engine/permission/availability.ts`):
 *   ключ выдаётся командам через `execute_shell`, и двух толкований быть не
 *   должно. В plan-режиме тул блокирует permission-слой (`isPlanBlockedTool`).
 *
 * ## Фон
 *
 * `background: true` — команда уходит в реестр фоновых прогонов
 * (`ProcessService.spawn`) и ход не блокируется. Секреты вызова едут вместе с
 * ней (PROP-124 §7) и в реестр/лог не попадают.
 */
import { z } from 'zod';
import { ToolCapability, normalizeSshKeyUsages, normalizeTlsHost } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { toSshSecret } from '../../git/ssh-env.js';
import { DEFAULT_MAX_OUTPUT_BYTES, isExecutionError } from '../../execution/ports/index.js';
import type { ExecSecret } from '../../execution/ports/index.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { resolveSshAccess, SshAccessError } from '../ssh/access.js';
import type { SshAccessErrorCode } from '../ssh/access.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import type { SystemMessageKey } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isAborted, abortedResult } from './abort.js';
import { toolRuntimeRequires } from './runtime-deps.js';
import { MAX_OUTPUT_LENGTH } from './shell-detachable.js';
import { isSymlinkEscapeInRoots, pathEscapesWorkspaceResult, toolRoots } from './path-utils.js';
import type { ProcessService } from '../processes/service.js';
import { BackgroundLimitExceededError } from '../background/types.js';
import { BackgroundUnsupportedError } from '../processes/types.js';

/** Имя тула (используется в permission-группах, trust и authority). */
export const SSH_EXEC_TOOL = 'ssh_exec';

/**
 * Таймаут вызова по умолчанию, мс (как у `execute_shell`).
 *
 * В фоне таймаут по умолчанию **не задаётся** (процесс переживает ход агента).
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Верхняя граница таймаута, мс (как у `execute_shell`). */
const MAX_TIMEOUT_MS = 600_000;

/** Предел длины хоста, символов (RFC 1035 — длина DNS-имени). */
const MAX_HOST_LENGTH = 253;

/** Предел длины одного аргумента удалённой команды, символов. */
const MAX_ARGV_ITEM_LENGTH = 4096;

/** Предел числа аргументов удалённой команды. */
const MAX_ARGV_ITEMS = 256;

/**
 * Допустимые символы хоста.
 *
 * Только буквы/цифры/точка/двоеточие/дефис/подчёркивание: пробел и оболочка
 * исключены, ведущий дефис — тоже (иначе ssh примет хост за опцию).
 */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;

/** Допустимые символы пользователя (POSIX-имя). */
const USER_RE = /^[A-Za-z0-9._-]+$/;

/** Зависимости тула из `ToolContext.extra` (упаковка — оркестратор). */
export interface SshExecExtra {
  /** Порт хранилища SSH-ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  sshKeyStore?: SSHKeyRepository;
  /** Сервис фоновых процессов (PROP-097) — нужен для `background: true`. */
  processService?: ProcessService;
  /** Фоновые прогоны разрешены инстансом (`background.enabled`). */
  backgroundEnabled?: boolean;
}

const sshExecSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(MAX_HOST_LENGTH)
      .regex(HOST_RE, 'host may contain only letters, digits, dots, colons, dashes and underscores')
      .refine((value) => !value.startsWith('-'), 'host must not start with a dash')
      .describe('Target host (hostname or IP literal); the port and user are separate fields'),
    user: z
      .string()
      .min(1)
      .max(64)
      .regex(USER_RE, 'user may contain only letters, digits, dots, dashes and underscores')
      .refine((value) => !value.startsWith('-'), 'user must not start with a dash')
      .optional()
      .describe('Remote user account (omitted — the ssh client default is used)'),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe('SSH port (default: 22; must be allowed by the key policy)'),
    key_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('Id of the SSH key to use (see ssh_keys_list; omitted — the only suitable key is used)'),
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_ARGV_ITEM_LENGTH)
          .refine((value) => !value.includes('\0'), 'argument must not contain NUL characters'),
      )
      .min(1)
      .max(MAX_ARGV_ITEMS)
      .describe('Remote command as an argument list (no shell on the local side)'),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS})`),
    background: z
      .boolean()
      .optional()
      .describe('Run the command in the background and return immediately (a notification arrives later)'),
  })
  .strict();

/** Параметры тула после валидации схемой. */
interface SshExecParams {
  host: string;
  user?: string;
  port?: number;
  key_id?: string;
  argv: string[];
  timeout_ms?: number;
  background?: boolean;
}

/**
 * Ключ i18n отказа гейта (ADR-041).
 *
 * У каждого машинного кода гейта (`SshAccessErrorCode`) свой ключ
 * `ssh.access.<code>` — текст отказа единый для всех потребителей гейта
 * (адресные ssh-тулы, HTTP-роуты), а не только для `ssh_exec`.
 */
function sshAccessErrorKey(code: SshAccessErrorCode): SystemMessageKey {
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
async function sshAccessErrorParams(
  err: SshAccessError,
  ctx: { store: SSHKeyRepository; keyId?: string; agentRole?: string; host: string; port?: number },
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
 * Сборка argv-команды `ssh`.
 *
 * Порядок: `-F /dev/null` → `-p <port>` (только при заданном порте) →
 * `-o BatchMode=yes` → `-o StrictHostKeyChecking=accept-new` → адрес → `--` →
 * аргументы команды.
 *
 * - `-F /dev/null` — **пользовательский `~/.ssh/config` не читается**: иначе
 *   конфиг хоста мог бы подсунуть `ProxyCommand`/`LocalCommand`/`IdentityFile`
 *   и обойти политику хостов (PROP-124 §4: локального shell нет — значит, нет
 *   и опций из окружения пользователя);
 * - `-o BatchMode=yes` — без интерактивного пароля (вызов не должен висеть на
 *   prompt'е);
 * - `-o StrictHostKeyChecking=accept-new` — новый хост принимается, known_hosts
 *   обновляется (режим `accept-new` PROP-124 §6).
 */
export function buildSshCommand(params: {
  host: string;
  user?: string;
  port?: number;
  argv: string[];
}): { file: string; args: string[] } {
  const args: string[] = [];
  // Конфиг пользователя игнорируется — иначе `ProxyCommand` из `~/.ssh/config`
  // выполнился бы локально.
  args.push('-F', '/dev/null');
  if (params.port !== undefined) args.push('-p', String(params.port));
  args.push('-o', 'BatchMode=yes');
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push(params.user ? `${params.user}@${params.host}` : params.host);
  // Разделитель: всё, что после него, — удалённая команда (опции ssh здесь
  // не действуют).
  args.push('--');
  args.push(...params.argv);
  return { file: 'ssh', args };
}

/** Отображение команды для текста результата и реестра фоновых прогонов. */
function formatCommandDisplay(command: { file: string; args: string[] }): string {
  return [command.file, ...command.args].join(' ');
}

export const sshExecTool: ToolDefinition = {
  name: SSH_EXEC_TOOL,
  description:
    'Run a command on a remote host over SSH (addressed access, instance mode "tools"). '
    + 'The command is passed as an argument list — no local shell is involved, so values cannot be '
    + 'injected. The host, port and user are separate fields; the SSH key is chosen by id '
    + '(see ssh_keys_list) or automatically, and the host/port must be allowed by the key policy. '
    + 'The key is delivered through a temporary ssh-agent for the duration of the call — it never '
    + 'appears in the command line. Timeout: 120000 ms by default (max 600000 ms). '
    + 'Set background=true to run the command in the background: it returns immediately and a '
    + 'notification with the result arrives automatically — do not poll for the status.',
  parameters: sshExecSchema,
  capabilities: [ToolCapability.SSH],
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — команду не начинаем (см. tools/abort.ts).
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args ?? {});
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as SshExecParams;

    const host = normalizeTlsHost(params.host);
    if (!host) {
      return argErrorResult(this.name, `host: ${params.host}`);
    }

    const extra = (ctx.extra ?? {}) as SshExecExtra;
    const store = extra.sshKeyStore;
    if (!store) {
      return failureResult('sshkeys.tool.deps_unavailable', {});
    }

    // Единый гейт (PROP-124 §3): режим `tools` — политика хостов/портов
    // обязательна; отказ происходит **до** раскрытия ключа и до запуска
    // команды.
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
        ...(params.port !== undefined ? { port: params.port } : {}),
      });
      // Доставка ключа — эфемерный ssh-agent (PROP-124 §2): путь к приватному
      // ключу в argv утекал бы в `ps`.
      secret = toSshSecret(access.key, 'agent');
    } catch (err) {
      if (err instanceof SshAccessError) {
        const key = sshAccessErrorKey(err.code);
        const paramsMap = await sshAccessErrorParams(err, {
          store,
          ...(params.key_id ? { keyId: params.key_id } : {}),
          ...(ctx.agentRole ? { agentRole: ctx.agentRole } : {}),
          host,
          ...(params.port !== undefined ? { port: params.port } : {}),
        });
        return {
          content: sm(key, paramsMap),
          isError: true,
          metadata: {
            // Машинный код отказа — по нему вызывающий (UI/аудит) различает
            // причины, не разбирая текст.
            keyCode: err.code,
            i18n: i18nMeta(key, paramsMap),
          },
        };
      }
      // Ошибка хранилища (расшифровка/мастер-ключ) — тот же контракт, что у
      // остальных ssh-тулов.
      return failureResult('sshkey.decrypt_failed', {
        id: params.key_id ?? '',
      });
    }

    const secrets = [secret];
    const command = buildSshCommand({
      host,
      ...(params.user ? { user: params.user } : {}),
      ...(params.port !== undefined ? { port: params.port } : {}),
      argv: params.argv,
    });
    const displayCommand = formatCommandDisplay(command);
    const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // Рабочий каталог — рабочий каталог сессии (containment как у
    // `execute_shell`): команда исполняется в периметре сессии.
    const cwd = ctx.workingDir;
    if (isSymlinkEscapeInRoots(toolRoots(ctx), cwd)) return pathEscapesWorkspaceResult(cwd);

    if (params.background === true) {
      return await startBackgroundProcess(params, command, displayCommand, cwd, timeout, secrets, ctx);
    }

    try {
      const { stdout, stderr } = await resolveExecutionPort(ctx).execute({
        command: { kind: 'argv', file: command.file, args: command.args },
        // Бинарное требование тула (`ssh`) — в remote-режиме команда уходит в
        // адрес пула, где есть клиент SSH.
        requires: toolRuntimeRequires(SSH_EXEC_TOOL),
        cwd,
        timeoutMs: timeout,
        // «Стоп» (POST /sessions/:id/abort) убивает процесс SIGTERM.
        signal: ctx.abortSignal,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        env: { HOME: process.env.HOME || '/root' },
        // Секрет вызова (PROP-124 §2): ключ — в эфемерном ssh-agent у точки
        // исполнения; в control plane файла с ключом не остаётся.
        secrets,
      });

      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;

      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + sm('tool.output_truncated');
      }

      return {
        content: output || sm('tool.empty_output'),
        metadata: {
          command: displayCommand,
          host,
          ...(params.port !== undefined ? { port: params.port } : {}),
          exitCode: 0,
          truncated: output.length > MAX_OUTPUT_LENGTH,
        },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены + частичный вывод.
      if (isAborted(ctx)) {
        const execError = err as { stdout?: string; stderr?: string };
        const partial = [execError.stdout, execError.stderr].filter(Boolean).join('\n');
        return abortedResult(this.name, partial || undefined);
      }

      // Нет клиента SSH в окружении исполнения.
      if (isExecutionError(err) && err.code === 'ENOENT') {
        return {
          content: sm('tool.binary_missing', { tool: this.name, binary: 'ssh' }),
          isError: true,
          metadata: {
            command: displayCommand,
            i18n: i18nMeta('tool.binary_missing', { tool: this.name, binary: 'ssh' }),
          },
        };
      }

      // Таймаут — actionable-текст (величина лимита + следующий шаг).
      if (isExecutionError(err) && err.reason === 'timeout') {
        return {
          content: sm('tool.shell_timeout', { timeout: String(timeout) }),
          isError: true,
          metadata: {
            command: displayCommand,
            reason: 'timeout',
            timeoutMs: timeout,
            i18n: i18nMeta('tool.shell_timeout', { timeout: String(timeout) }),
          },
        };
      }

      let output = '';
      if (isExecutionError(err)) {
        if (err.stdout) output += err.stdout;
        if (err.stderr) output += (output ? '\n--- stderr ---\n' : '') + err.stderr;
      }
      const message = isExecutionError(err)
        ? err.message || sm('tool.command_failed_default')
        : err instanceof Error
          ? err.message
          : String(err);
      output += (output ? '\n' : '') + sm('tool.shell_error', { message });

      return {
        content: output.slice(0, MAX_OUTPUT_LENGTH),
        isError: true,
        metadata: { command: displayCommand, exitCode: -1 },
      };
    }
  },
};

/** Отказ с ключом i18n (без параметров). */
function failureResult(key: SystemMessageKey, params: Record<string, string>): ToolResult {
  return {
    content: sm(key, params),
    isError: true,
    metadata: { i18n: i18nMeta(key, params) },
  };
}

/**
 * Фоновый запуск (PROP-097): ход не блокируется, результат придёт
 * уведомлением.
 *
 * Команда уходит в порт **argv-формой** (без локальной оболочки) и несёт те же
 * секреты вызова, что и синхронный путь (PROP-124 §7).
 */
async function startBackgroundProcess(
  params: SshExecParams,
  command: { file: string; args: string[] },
  displayCommand: string,
  cwd: string,
  timeout: number,
  secrets: ExecSecret[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const extra = (ctx.extra ?? {}) as SshExecExtra;
  // Мастер-выключатель фоновой работы (`background.enabled`).
  if (extra.backgroundEnabled === false) {
    return failureResult('process.background_disabled', {});
  }
  const service = extra.processService;
  if (!service || !ctx.sessionId) {
    return failureResult('process.deps_unavailable', {});
  }

  try {
    const started = await service.spawn({
      sessionId: ctx.sessionId,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      // Строка команды — только для показа в UI/реестре; исполняется argv.
      command: displayCommand,
      argv: { file: command.file, args: command.args },
      requires: toolRuntimeRequires(SSH_EXEC_TOOL),
      cwd,
      ...(params.timeout_ms !== undefined ? { timeoutMs: params.timeout_ms } : {}),
      env: { HOME: process.env.HOME || '/root' },
      // Секреты вызова — на время жизни фонового процесса; в запись реестра
      // и в лог они не попадают.
      secrets,
    });
    const paramsMap = { id: started.processId, log: started.logPath };
    return {
      content: sm('process.background_started', paramsMap),
      metadata: {
        process_id: started.processId,
        background_run_id: started.runId,
        status: 'running',
        log_path: started.logPath,
        command: displayCommand,
        i18n: i18nMeta('process.background_started', paramsMap),
      },
    };
  } catch (err) {
    if (err instanceof BackgroundLimitExceededError) {
      return failureResult('process.background_limit', { limit: String(err.limit) });
    }
    if (err instanceof BackgroundUnsupportedError) {
      return failureResult('process.background_unsupported', {});
    }
    throw err;
  }
}
