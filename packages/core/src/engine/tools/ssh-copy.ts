/**
 * PROP-124 §4b: адресный ssh-тул `ssh_copy` — передача файлов на удалённый
 * хост (загрузка/скачивание).
 *
 * ## Границы (режим `tools`)
 *
 * - **Гейт — до запуска.** Единый гейт (`engine/ssh/access.ts`, PROP-124 §3)
 *   проверяет `usages`/`agentIds`/`allowHosts`/`allowPorts` и **не раскрывает**
 *   ключ при отказе. Отказ возвращается моделью как `ToolResult` с ключом
 *   `ssh.access.<code>` — тем же контрактом, что у `ssh_exec`
 *   (`engine/ssh/result.ts`).
 * - **Ключ — секрет вызова, а не аргумент.** Путь к приватному ключу в argv
 *   утекал бы в `ps`; на время вызова поднимается эфемерный `ssh-agent`
 *   (`ExecSecret.mode = 'agent'`, PROP-124 §2), материал готовит **точка
 *   исполнения** (ADR-077, протокол 4).
 * - **Локальный путь — внутри периметра сессии.** `local` — относительный путь
 *   внутри рабочего каталога сессии; проверка — общая с файловыми тулами
 *   (`toolRoots`/`isInsideAnyRoot`, `engine/tools/path-utils.ts`), отказ —
 *   существующей ошибкой доступа (`pathEscapesWorkspaceResult`), а не своей.
 * - **Batch — только из проверенных значений.** Команда sftp собирается из
 *   валидированных полей (`host`/`user`/`port`/`local`/`remote`); свободного
 *   текста в batch нет, символы `\n`/`\r`/NUL запрещены (batch — построчный
 *   протокол, иначе инъекция команды), `remote` не начинается с `-` (иначе
 *   это опция sftp).
 * - **Режим инстанса.** В режиме `ssh.mode = 'agent'` адресные ssh-тулы
 *   недоступны (`unavailable(policy)`, `engine/permission/availability.ts`); в
 *   plan-режиме тул блокирует permission-слой (`isPlanBlockedTool`).
 *
 * ## Транспорт: batch по stdin клиента `sftp`
 *
 * Клиент sftp умеет читать batch-команды из stdin (`sftp -b -`, `sftp(1)`), и
 * в batch-режиме **обрывается на первой неудачной команде** (`get`/`put` в
 * списке прерывающих) — то есть ошибка передачи видна по коду возврата, а не
 * теряется.
 *
 * Почему batch доставляется не «процессу, а sftp»:
 *
 * - **в порту нет `stdin`.** `ExecRequest` (`execution/ports/execution-port.ts`)
 *   передаёт команду, окружение, таймаут и секреты — потока ввода у него нет;
 * - **на проводе его нет и не появится без правки пакета исполнителя.**
 *   Исполнитель (`packages/executor`, wire-протокол 6) принимает
 *   `{command, cwd, env, timeoutMs, maxOutputBytes, secrets}` — поле `stdin`
 *   в протоколе отсутствует, а клиент удалённого порта собирает тело запроса
 *   по списку полей. Если бы batch отдавался «процессу», то в split-режиме
 *   (адресный ssh — это как раз split-режим: клиент ssh/sftp живёт в
 *   toolchain'е исполнителя) sftp получил бы **пустой** stdin, исполнил бы
 *   ноль команд и вышел бы с кодом `0` — **тихий no-op**: тул отчитался бы об
 *   успехе, хотя ничего не передал. Такой отказ недопустим.
 *
 * Поэтому batch идёт **argv-каналом**, который протокол переносит как есть:
 * команда — это фиксированный скрипт-обёртка (`bash -c`), который подставляет
 * batch в stdin клиента `sftp` пайпом. Скрипт — **константа**, пользовательских
 * данных в нём нет; batch и адрес приходят позиционными параметрами и
 * подставляются в кавычках, поэтому строка пользователя не может стать
 * синтаксисом shell.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ToolCapability, normalizeTlsHost } from '@itphx/synth-shared';
import type { ToolContext, ToolDefinition, ToolResult } from '@itphx/synth-shared';
import type { SSHKeyRepository } from '../../storage/ports/ssh-key-repository.js';
import { toSshSecret } from '../../git/ssh-env.js';
import { DEFAULT_MAX_OUTPUT_BYTES, isExecutionError } from '../../execution/ports/index.js';
import type { ExecSecret } from '../../execution/ports/index.js';
import { resolveExecutionPort } from '../../execution/tool-port.js';
import { DEFAULT_SSH_PORT, resolveSshAccess, SshAccessError } from '../ssh/access.js';
import { sshAccessFailureResult, sshToolFailureResult } from '../ssh/result.js';
import { t as sm, i18n as i18nMeta } from '../system-messages.js';
import { argErrorResult } from './arg-error.js';
import { isAborted, abortedResult } from './abort.js';
import { runtimeRequires, toolRuntimeRequires } from './runtime-deps.js';
import { MAX_OUTPUT_LENGTH } from './shell-detachable.js';
import { isInsideAnyRoot, pathEscapesWorkspaceResult, resolvePath, toolRoots } from './path-utils.js';

/** Имя тула (используется в permission-группах, trust и authority). */
export const SSH_COPY_TOOL = 'ssh_copy';

/** Таймаут вызова по умолчанию, мс (как у `ssh_exec`). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Верхняя граница таймаута, мс (как у `ssh_exec`). */
const MAX_TIMEOUT_MS = 600_000;

/** Предел длины хоста, символов (RFC 1035 — длина DNS-имени). */
const MAX_HOST_LENGTH = 253;

/** Предел длины пути, символов (как предел аргумента у `ssh_exec`). */
const MAX_PATH_LENGTH = 4096;

/** Допустимые символы хоста (те же правила, что у `ssh_exec`). */
const HOST_RE = /^[A-Za-z0-9._:-]+$/;

/** Допустимые символы пользователя (POSIX-имя). */
const USER_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Есть ли в строке управляющие символы (в т.ч. `\n`, `\r`, NUL).
 *
 * Проверка по кодам символов, а не регуляркой: класс управляющих символов в
 * регулярке запрещён правилом линтера (`no-control-regex`), а смысл проверки —
 * именно в этих символах.
 */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Допустимость пути в batch-протоколе sftp.
 *
 * - **управляющие символы** (в т.ч. `\n`, `\r`, NUL): batch — построчный
 *   протокол, строка с переводом строки была бы новой командой; NUL в
 *   аргументе недопустим вообще;
 * - **`"` и `\`**: specials токенизатора sftp (кавычки и экранирование);
 * - **`*`, `?`, `[`, `]`**: glob-метасимволы — копия это **один** путь, а не
 *   набор файлов (sftp развернул бы шаблон в несколько объектов);
 * - **ведущий `-`**: иначе путь был бы опцией sftp.
 */
function isValidBatchPath(value: string): boolean {
  if (hasControlChars(value)) return false;
  if (value.includes('"') || value.includes('\\')) return false;
  if (/[*?[\]]/.test(value)) return false;
  if (value.startsWith('-')) return false;
  return true;
}

const sshCopySchema = z
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
      .describe('SSH port (default: 22; must be allowed by the key policy)'),
    key_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('Id of the SSH key to use (see ssh_keys_list; omitted — the only suitable key is used)'),
    direction: z
      .enum(['upload', 'download'])
      .describe('upload — send the local file to the host; download — fetch the remote file locally'),
    local: z
      .string()
      .min(1)
      .max(MAX_PATH_LENGTH)
      .refine(
        isValidBatchPath,
        'local path must not contain control characters, quotes, backslashes, glob characters or a leading dash',
      )
      .refine(
        (value) => !isAbsolute(value),
        'local path must be relative to the session working directory',
      )
      .describe('Local path, relative to the session working directory'),
    remote: z
      .string()
      .min(1)
      .max(MAX_PATH_LENGTH)
      .refine(
        isValidBatchPath,
        'remote path must not contain control characters, quotes, backslashes, glob characters or a leading dash',
      )
      .describe('Path on the remote host (absolute or relative to the remote home directory)'),
    recursive: z
      .boolean()
      .optional()
      .describe('Copy directories recursively (sftp -R)'),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS})`),
  })
  .strict();

/** Параметры тула после валидации схемой. */
interface SshCopyParams {
  host: string;
  user: string;
  port?: number;
  key_id?: string;
  direction: 'upload' | 'download';
  local: string;
  remote: string;
  recursive?: boolean;
  timeout_ms?: number;
}

/** Зависимости тула из `ToolContext.extra` (упаковка — оркестратор). */
export interface SshCopyExtra {
  /** Порт хранилища SSH-ключей (`StorageContext.sshKeys`, ADR-096/ADR-076). */
  sshKeyStore?: SSHKeyRepository;
}

/**
 * Скрипт-обёртка: batch → stdin клиента `sftp`.
 *
 * Скрипт — **константа**: пользовательских данных в нём нет. Batch (`$1`),
 * порт (`$2`) и адрес (`$3`) приходят позиционными параметрами и
 * подставляются в кавычках, поэтому значение пользователя не может стать
 * синтаксисом shell (в batch — тоже: он уходит в `printf %s "$1"` как данные).
 *
 * Ключи sftp/ssh повторяют `ssh_exec`: `-F /dev/null` (пользовательский
 * `~/.ssh/config` не читается — иначе конфиг хоста мог бы подсунуть
 * `ProxyCommand` и обойти политику хостов), `-o BatchMode=yes`
 * (неинтерактивно: пароль не спрашивается), `-o
 * StrictHostKeyChecking=accept-new` (режим `accept-new`, PROP-124 §6).
 */
const SFTP_BATCH_SCRIPT =
  'printf %s "$1" | sftp -F /dev/null -b - -P "$2" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$3"';

/**
 * Batch-команда sftp для одной операции.
 *
 * Значения — **только проверенные** (схема тула): никакого свободного текста
 * в batch не попадает. Кавычки — только когда путь содержит пробел (правило
 * `sftp(1)`: «Pathnames that contain spaces must be enclosed in quotes»).
 *
 * Флаг рекурсии — `-R` (заглавная): именно он включает рекурсивное копирование
 * каталогов в `put`/`get` (`sftp(1)`, «If the -R flag is specified then
 * directories will be copied recursively»).
 */
export function buildSftpBatch(params: {
  direction: 'upload' | 'download';
  local: string;
  remote: string;
  recursive?: boolean;
}): string {
  const quote = (path: string): string => (path.includes(' ') ? `"${path}"` : path);
  const flag = params.recursive === true ? '-R ' : '';
  const line =
    params.direction === 'upload'
      ? `put ${flag}${quote(params.local)} ${quote(params.remote)}`
      : `get ${flag}${quote(params.remote)} ${quote(params.local)}`;
  // Последняя строка batch обязана завершаться переводом строки — иначе sftp
  // может не прочитать её.
  return `${line}\n`;
}

/**
 * Сборка команды вызова.
 *
 * Команда — argv-форма (без локальной оболочки пользователя): файл `bash` с
 * фиксированным скриптом и позиционными параметрами. Batch идёт в скрипт
 * аргументом и оттуда — в stdin клиента `sftp` (`sftp -b -`).
 *
 * Адрес — всегда `user@host`: конфиг ssh не читается (`-F /dev/null`), поэтому
 * «умолчательного» пользователя не существует — без явного `user` клиент
 * подставил бы локального пользователя исполнителя (`node`) и получил бы
 * `Permission denied (publickey,password)`.
 */
export function buildSftpCommand(params: {
  host: string;
  user: string;
  port?: number;
  batch: string;
}): { file: string; args: string[] } {
  const target = `${params.user}@${params.host}`;
  return {
    file: 'bash',
    args: [
      '-c',
      SFTP_BATCH_SCRIPT,
      // `$0` оболочки — имя скрипта (в текст ошибок попадает как есть).
      'synth-ssh-copy',
      params.batch,
      String(params.port ?? DEFAULT_SSH_PORT),
      target,
    ],
  };
}

/** Отображение команды для текста результата и метаданных. */
function formatCommandDisplay(params: { host: string; user: string; port?: number }): string {
  const target = `${params.user}@${params.host}`;
  return `sftp -F /dev/null -b - -P ${params.port ?? DEFAULT_SSH_PORT} ${target}`;
}

export const sshCopyTool: ToolDefinition = {
  name: SSH_COPY_TOOL,
  description:
    'Copy a file to or from a remote host over SSH (addressed access, instance mode "tools"). '
    + 'Direction "upload" sends the local file to the host, "download" fetches the remote file. '
    + 'The local path is relative to the session working directory; the remote path is absolute or '
    + 'relative to the remote home directory. The host, port and user are separate fields; the user '
    + 'is required, because the ssh client config is not read (-F /dev/null) and there is no default '
    + 'user to fall back to — without it ssh would connect as the local user of the executor. The SSH key '
    + 'is chosen by id (see ssh_keys_list) or automatically, and the host/port must be allowed by the key '
    + 'policy. The key is delivered through a temporary ssh-agent for the duration of the call — it never '
    + 'appears in the command line. Set recursive=true to copy directories. Timeout: 120000 ms by default '
    + '(max 600000 ms).',
  parameters: sshCopySchema,
  capabilities: [ToolCapability.SSH],
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // «Стоп» пришёл до запуска — команду не начинаем (см. tools/abort.ts).
    if (isAborted(ctx)) return abortedResult(this.name);
    const parsed = this.parameters.safeParse(args ?? {});
    if (!parsed.success) {
      return argErrorResult(this.name, parsed.error.issues);
    }
    const params = parsed.data as SshCopyParams;

    const host = normalizeTlsHost(params.host);
    if (!host) {
      return argErrorResult(this.name, `host: ${params.host}`);
    }

    const extra = (ctx.extra ?? {}) as SshCopyExtra;
    const store = extra.sshKeyStore;
    if (!store) {
      return sshToolFailureResult('sshkeys.tool.deps_unavailable', {});
    }

    // Единый гейт (PROP-124 §3): режим `tools` — политика хостов/портов
    // обязательна; отказ происходит **до** раскрытия ключа и до запуска.
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
        return await sshAccessFailureResult(err, {
          store,
          ...(params.key_id ? { keyId: params.key_id } : {}),
          ...(ctx.agentRole ? { agentRole: ctx.agentRole } : {}),
          host,
          ...(params.port !== undefined ? { port: params.port } : {}),
        });
      }
      // Ошибка хранилища (расшифровка/мастер-ключ) — тот же контракт, что у
      // остальных ssh-тулов.
      return sshToolFailureResult('sshkey.decrypt_failed', {
        id: params.key_id ?? '',
      });
    }

    // Локальный путь — внутри периметра сессии (рабочий каталог + корни
    // проекта). Проверка — общая с файловыми тулами; отказ — существующей
    // ошибкой доступа.
    const cwd = ctx.workingDir;
    const resolvedLocal = resolvePath(params.local, cwd);
    if (!isInsideAnyRoot(resolvedLocal, toolRoots(ctx))) {
      return pathEscapesWorkspaceResult(resolvedLocal);
    }
    // Целью копирования не может быть сам рабочий каталог: для загрузки это
    // каталог вместо файла, для скачивания — неоднозначная цель.
    if (resolvedLocal === resolve(cwd)) {
      return argErrorResult(this.name, 'local: must point to a file or a directory inside the working directory');
    }

    const batch = buildSftpBatch({
      direction: params.direction,
      local: params.local,
      remote: params.remote,
      ...(params.recursive !== undefined ? { recursive: params.recursive } : {}),
    });
    const command = buildSftpCommand({
      host,
      user: params.user,
      ...(params.port !== undefined ? { port: params.port } : {}),
      batch,
    });
    const displayCommand = formatCommandDisplay({
      host,
      user: params.user,
      ...(params.port !== undefined ? { port: params.port } : {}),
    });
    const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    try {
      const { stdout, stderr } = await resolveExecutionPort(ctx).execute({
        command: { kind: 'argv', file: command.file, args: command.args },
        // Бинарные требования тула: клиент sftp + оболочка обёртки (batch
        // доставляется в sftp пайпом). В remote-режиме команда уходит в адрес
        // пула, где есть toolchain с sftp.
        requires: [...toolRuntimeRequires(SSH_COPY_TOOL), ...runtimeRequires('bash')],
        cwd,
        timeoutMs: timeout,
        // «Стоп» (POST /sessions/:id/abort) убивает процесс SIGTERM.
        signal: ctx.abortSignal,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        env: { HOME: process.env.HOME || '/root' },
        // Секрет вызова (PROP-124 §2): ключ — в эфемерном ssh-agent у точки
        // исполнения; в control plane файла с ключом не остаётся.
        secrets: [secret],
      });

      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n' : '') + stderr;
      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + sm('tool.output_truncated');
      }

      const messageKey = params.direction === 'upload' ? 'ssh.copy.uploaded' : 'ssh.copy.downloaded';
      const messageParams = {
        local: params.local,
        remote: params.remote,
        host,
      };
      return {
        content: output ? `${sm(messageKey, messageParams)}\n${output}` : sm(messageKey, messageParams),
        metadata: {
          command: displayCommand,
          host,
          ...(params.port !== undefined ? { port: params.port } : {}),
          direction: params.direction,
          local: params.local,
          remote: params.remote,
          exitCode: 0,
          i18n: i18nMeta(messageKey, messageParams),
        },
      };
    } catch (err: unknown) {
      // Прерывание по «Стоп» — единый маркер отмены + частичный вывод.
      if (isAborted(ctx)) {
        const execError = err as { stdout?: string; stderr?: string };
        const partial = [execError.stdout, execError.stderr].filter(Boolean).join('\n');
        return abortedResult(this.name, partial || undefined);
      }

      // Нет клиента SFTP в окружении исполнения.
      if (isExecutionError(err) && err.code === 'ENOENT') {
        return {
          content: sm('tool.binary_missing', { tool: this.name, binary: 'sftp' }),
          isError: true,
          metadata: {
            command: displayCommand,
            i18n: i18nMeta('tool.binary_missing', { tool: this.name, binary: 'sftp' }),
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
        if (err.stderr) output += (output ? '\n' : '') + err.stderr;
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
