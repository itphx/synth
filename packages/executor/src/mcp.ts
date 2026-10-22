/**
 * MCP-хостинг исполнителя (ADR-077, шаг B1).
 *
 * Исполнитель умеет **поднимать у себя MCP-серверы** (stdio) и отдавать их
 * инструменты и вызовы по HTTP. Зачем: в split-топологии control plane тонкий
 * (образ `synth-backend` без toolchain'а), а браузерные и tier-4 инструменты
 * (Playwright MCP, MCP-серверы SCM-хостингов) живут в образе исполнителя —
 * значит и **хостить** их должен исполнитель, а не control plane.
 *
 * ## Клиент — тот же SDK и тот же паттерн, что в core
 *
 * Используется официальный `@modelcontextprotocol/sdk` (`Client` +
 * `StdioClientTransport`) — тот же, что в `packages/core/src/engine/mcp/client.ts`.
 * Свой MCP-клиент не пишется: иначе handshake и разбор результатов разойдутся
 * с core. Лимиты — **как в core**:
 *
 * | Лимит | Значение | Источник |
 * |---|---|---|
 * | connect | 60 c | `MCP_CONNECT_TIMEOUT_MS` |
 * | вызов инструмента | 120 c | `MCP_TOOL_TIMEOUT_MS` |
 * | усечение результата | 30 000 символов | `MCP_MAX_RESULT_CHARS` |
 * | circuit breaker | 5 ошибок → 60 c | `MCP_CIRCUIT_THRESHOLD`/`MCP_CIRCUIT_COOLDOWN_MS` |
 *
 * ## Жизненный цикл
 *
 * - **Ленивый старт.** Сервер поднимается при первом обращении
 *   (`GET /mcp/tools` — все серверы, `POST /mcp/call` — нужный). Обоснование:
 *   бинарей может не быть в образе конкретного flavor'а (`core`/`dev` — без
 *   Chromium), и неудачный старт **не должен** ломать исполнитель; тяжёлый
 *   Chromium не поднимается, пока агент не до него дошёл.
 * - **Упавший сервер** → статус `down` с причиной; следующее обращение
 *   **переподнимает** его (это и есть перезапуск): circuit breaker защищает от
 *   частых переподключений к заведомо сломанному серверу.
 * - **Остановка исполнителя** закрывает клиентов ⇒ дочерние процессы MCP
 *   (и Chromium) завершаются — зомби-процессов не остаётся.
 *
 * ## Секреты
 *
 * `env` сервера может содержать токены (приходят из Secret). Значения:
 * - **не пишутся** в логи и **не возвращаются** в ответах (`GET /mcp/servers`
 *   отдаёт только имя/статус/счётчик инструментов);
 * - **вычищаются** из текста ошибок (`sanitizeError`) — если сервер напечатал
 *   свой токен в stderr, текст ошибки не должен его выдать наружу;
 * - само значение `SYNTH_EXECUTOR_MCP_SERVERS` убирается из `process.env`
 *   после разбора конфигурации (`scrubExecutorMcpServers` в `config.ts`) —
 *   иначе токены утекли бы в окружение агентских команд.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SYNTH_VERSION } from '@itphx/synth-shared';

/** Таймаут подключения к MCP-серверу, мс (как в core — 60 c). */
export const MCP_CONNECT_TIMEOUT_MS = 60_000;

/** Таймаут вызова инструмента, мс (как в core — 120 c). */
export const MCP_TOOL_TIMEOUT_MS = 120_000;

/** Потолок длины текста результата, символов (как в core — 30 000). */
export const MCP_MAX_RESULT_CHARS = 30_000;

/** Порог circuit breaker'а: столько ошибок подряд — сервер не опрашивается. */
export const MCP_CIRCUIT_THRESHOLD = 5;

/** Cooldown circuit breaker'а, мс (как в core — 60 c). */
export const MCP_CIRCUIT_COOLDOWN_MS = 60_000;

/**
 * Переменные окружения исполнителя, наследуемые MCP-сервером.
 *
 * SDK (`StdioClientTransport`) наследует только whitelist
 * (`HOME`/`PATH`/`SHELL`/`TERM`/`USER`/`LOGNAME`) — этого **недостаточно**:
 * каталог браузеров Playwright (`PLAYWRIGHT_BROWSERS_PATH`) и параметры
 * локали/прокси до MCP-сервера не доедут. Список ниже — явный и закрытый:
 * `process.env` целиком **не** наследуется (там может быть конфигурация с
 * токенами других серверов и окружение исполнителя).
 */
export const MCP_INHERITED_ENV_VARS = [
  'HOME',
  'PATH',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'DISPLAY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/** Описание MCP-сервера, который хостит исполнитель. */
export interface McpServerSpec {
  /** Имя сервера (уникально в пределах исполнителя). */
  name: string;
  /** Команда запуска (stdio). */
  command: string;
  /** Аргументы команды. */
  args: string[];
  /** Переменные окружения сервера (могут содержать токены). */
  env: Record<string, string>;
}

/** Инструмент MCP-сервера. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Состояние сервера у исполнителя. */
export type McpServerState =
  /** Сервер настроен, но ещё не поднимался. */
  | 'idle'
  /** Сервер поднят и общается по MCP. */
  | 'up'
  /** Сервер не поднят (ошибка) — причина в `error`. */
  | 'down';

/** Статус MCP-сервера для `GET /mcp/servers`. */
export interface McpServerStatus {
  name: string;
  status: McpServerState;
  toolCount: number;
  /** Причина последней ошибки (без секретов). */
  error?: string;
}

/** Инструмент в плоском виде — для `GET /mcp/tools`. */
export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Результат вызова инструмента — для `POST /mcp/call`. */
export interface McpToolResult {
  content: string;
  isError: boolean;
}

/** Класс ошибки MCP-хоста (HTTP-слой превращает её в код ответа). */
export type ExecutorMcpErrorKind =
  /** Сервер не настроен у исполнителя. */
  | 'unknown_server'
  /** Инструмента нет в сервере. */
  | 'unknown_tool'
  /** Сервер не поднят (ошибка старта/краш). */
  | 'server_unavailable'
  /** Вызов инструмента провалился (транспорт/таймаут). */
  | 'call_failed';

/** Ошибка MCP-хоста. */
export class ExecutorMcpError extends Error {
  constructor(
    readonly kind: ExecutorMcpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutorMcpError';
  }
}

/** Внутренняя запись о сервере. */
interface McpServerEntry {
  spec: McpServerSpec;
  client: Client | null;
  tools: McpToolDef[];
  state: McpServerState;
  error: string | undefined;
  /** Ошибок подряд (circuit breaker). */
  errorCount: number;
  /** Момент последней ошибки, мс. */
  lastErrorAt: number;
  /** Промис текущего подключения (дедупликация параллельных попыток). */
  connecting: Promise<void> | undefined;
}

/** Параметры MCP-хоста. */
export interface ExecutorMcpHostOptions {
  /** Окружение, из которого наследуются переменные для серверов. */
  env?: NodeJS.ProcessEnv;
  /** Таймаут подключения, мс (по умолчанию — 60 c, как в core). */
  connectTimeoutMs?: number;
  /** Таймаут вызова инструмента, мс (по умолчанию — 120 c, как в core). */
  toolTimeoutMs?: number;
}

/**
 * Хост MCP-серверов исполнителя.
 *
 * Экземпляр на процесс: серверы — **общие** для всех агентских сессий,
 * которые работают через этот исполнитель (как пул процессов в образе).
 */
export class ExecutorMcpHost {
  private readonly _entries = new Map<string, McpServerEntry>();
  private readonly _env: NodeJS.ProcessEnv;
  private readonly _connectTimeoutMs: number;
  private readonly _toolTimeoutMs: number;

  constructor(servers: McpServerSpec[], opts: ExecutorMcpHostOptions = {}) {
    this._env = opts.env ?? process.env;
    this._connectTimeoutMs = opts.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    this._toolTimeoutMs = opts.toolTimeoutMs ?? MCP_TOOL_TIMEOUT_MS;
    for (const spec of servers) {
      this._entries.set(spec.name, {
        spec,
        client: null,
        tools: [],
        state: 'idle',
        error: undefined,
        errorCount: 0,
        lastErrorAt: 0,
        connecting: undefined,
      });
    }
  }

  /** Имена настроенных серверов. */
  get serverNames(): string[] {
    return [...this._entries.keys()];
  }

  /** Статусы серверов (без запуска — только текущее состояние). */
  listServers(): McpServerStatus[] {
    return [...this._entries.values()].map((entry) => ({
      name: entry.spec.name,
      status: entry.state,
      toolCount: entry.tools.length,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  /**
   * Инструменты всех **поднятых** серверов.
   *
   * Серверы, которые не удалось поднять, пропускаются (их причина — в
   * `listServers()`): отсутствие браузера в образе flavor'а `core` не должно
   * ломать раздачу инструментов остальных серверов.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const entries = [...this._entries.values()];
    await Promise.all(
      entries.map((entry) =>
        this._ensureConnected(entry).catch(() => undefined),
      ),
    );
    const tools: McpToolInfo[] = [];
    for (const entry of entries) {
      if (entry.state !== 'up') continue;
      for (const tool of entry.tools) {
        tools.push({
          server: entry.spec.name,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return tools;
  }

  /**
   * Вызов инструмента MCP-сервера.
   *
   * @throws ExecutorMcpError `unknown_server` | `unknown_tool` |
   *   `server_unavailable` | `call_failed`.
   */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const entry = this._entries.get(server);
    if (!entry) {
      throw new ExecutorMcpError(
        'unknown_server',
        `MCP-сервер "${server}" не настроен у исполнителя`,
      );
    }

    await this._ensureConnected(entry);

    const client = entry.client;
    if (!client) {
      throw new ExecutorMcpError(
        'server_unavailable',
        `MCP-сервер "${server}" недоступен: ${entry.error ?? 'сервер не поднят'}`,
      );
    }

    if (!entry.tools.some((item) => item.name === tool)) {
      throw new ExecutorMcpError(
        'unknown_tool',
        `Инструмент "${tool}" не найден в MCP-сервере "${server}"`,
      );
    }

    try {
      const result = await withTimeout(
        client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: this._toolTimeoutMs },
        ),
        this._toolTimeoutMs,
        `Таймаут вызова инструмента "${tool}" (${this._toolTimeoutMs} мс)`,
      );
      const textParts = extractText(result.content);
      if (result.isError) {
        // Текст ошибки инструмента — тоже «текст ошибки»: секреты из env
        // сервера вычищаются (сервер мог напечатать свой токен).
        return {
          content: redactSecrets(textParts.join('\n') || 'Инструмент вернул ошибку', entry.spec),
          isError: true,
        };
      }
      let content = textParts.join('\n') || 'Инструмент выполнен (пустой результат)';
      if (content.length > MCP_MAX_RESULT_CHARS) {
        content =
          content.slice(0, MCP_MAX_RESULT_CHARS) +
          `\n\n...(усечено, полный размер: ${content.length} символов)`;
      }
      return { content, isError: false };
    } catch (err) {
      if (err instanceof ExecutorMcpError) throw err;
      this._recordError(entry);
      entry.state = 'down';
      entry.client = null;
      entry.tools = [];
      // Таймаут SDK (-32001) переводим в наш текст — иначе в ответе будет
      // невнятное «MCP error -32001: Request timed out» без имени инструмента.
      const reason = isTimeoutError(err)
        ? `Таймаут вызова инструмента "${tool}" (${this._toolTimeoutMs} мс)`
        : sanitizeError(err, entry.spec);
      entry.error = reason;
      throw new ExecutorMcpError(
        'call_failed',
        `Ошибка вызова инструмента "${tool}" в MCP-сервере "${server}": ${reason}`,
      );
    }
  }

  /** Закрыть всех серверов (дочерние процессы завершаются). */
  async close(): Promise<void> {
    const entries = [...this._entries.values()];
    this._entries.clear();
    for (const entry of entries) {
      const client = entry.client;
      entry.client = null;
      entry.tools = [];
      entry.state = 'down';
      if (client) {
        try {
          await client.close();
        } catch {
          // ошибка закрытия не должна ломать остановку исполнителя
        }
      }
    }
  }

  // --- внутреннее ---------------------------------------------------------

  /** Поднять сервер (или убедиться, что он поднят). */
  private async _ensureConnected(entry: McpServerEntry): Promise<void> {
    if (entry.state === 'up' && entry.client) return;
    if (this._isCircuitOpen(entry)) {
      throw new ExecutorMcpError(
        'server_unavailable',
        `MCP-сервер "${entry.spec.name}" временно заблокирован ` +
          `(${entry.errorCount} ошибок подряд, повтор после cooldown)`,
      );
    }
    entry.connecting ??= this._connect(entry).finally(() => {
      entry.connecting = undefined;
    });
    await entry.connecting;
  }

  /** Подключение к серверу: spawn + handshake + список инструментов. */
  private async _connect(entry: McpServerEntry): Promise<void> {
    const { spec } = entry;
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: this._childEnv(spec),
    });
    const client = new Client(
      { name: 'synth-executor', version: SYNTH_VERSION },
      { capabilities: {} },
    );
    client.onerror = (error: Error): void => {
      // Транспорт сообщил об ошибке — сервер считаем упавшим.
      this._markDown(entry, sanitizeError(error, spec));
    };
    client.onclose = (): void => {
      this._markDown(entry, `MCP-сервер "${spec.name}" завершился`);
    };

    try {
      await withTimeout(
        (async (): Promise<void> => {
          await client.connect(transport, { timeout: this._connectTimeoutMs });
          const listed = await client.listTools();
          entry.tools = listed.tools.map((tool) => ({
            name: tool.name,
            description: tool.description || '',
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          }));
        })(),
        this._connectTimeoutMs,
        `Таймаут подключения к MCP-серверу "${spec.name}" (${this._connectTimeoutMs} мс)`,
      );
      entry.client = client;
      entry.state = 'up';
      entry.error = undefined;
      entry.errorCount = 0;
    } catch (err) {
      this._recordError(entry);
      entry.state = 'down';
      entry.error = isTimeoutError(err)
        ? `Таймаут подключения к MCP-серверу "${spec.name}" (${this._connectTimeoutMs} мс)`
        : sanitizeError(err, spec);
      entry.client = null;
      entry.tools = [];
      try {
        await client.close();
      } catch {
        // закрытие неудачного подключения — не критично
      }
      throw new ExecutorMcpError(
        'server_unavailable',
        `MCP-сервер "${spec.name}" недоступен: ${entry.error}`,
      );
    }
  }

  /** Окружение дочернего процесса: наследуемый whitelist + env сервера. */
  private _childEnv(spec: McpServerSpec): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const key of MCP_INHERITED_ENV_VARS) {
      const value = this._env[key];
      if (typeof value === 'string' && value.length > 0) inherited[key] = value;
    }
    return { ...inherited, ...spec.env };
  }

  /** Отметить сервер упавшим (транспорт сообщил о закрытии/ошибке). */
  private _markDown(entry: McpServerEntry, reason: string): void {
    // Состояние `idle` здесь тоже важно: спавн мог провалиться ДО того, как
    // `_connect` успел записать причину (транспорт сообщает об ошибке/закрытии
    // асинхронно). Если проигнорировать это событие, `GET /mcp/servers` отдаст
    // `idle` для сервера, который на самом деле не поднялся, — оператор не
    // увидит причину. `error` не перезаписывается: конкретная причина из
    // `_connect` точнее, чем «сервер завершился».
    if (entry.state === 'down') return;
    entry.state = 'down';
    entry.client = null;
    entry.tools = [];
    entry.error ??= reason;
  }

  /** Счётчик ошибок подряд (circuit breaker). */
  private _recordError(entry: McpServerEntry): void {
    entry.errorCount += 1;
    entry.lastErrorAt = Date.now();
  }

  /** Circuit breaker открыт? */
  private _isCircuitOpen(entry: McpServerEntry): boolean {
    if (entry.errorCount < MCP_CIRCUIT_THRESHOLD) return false;
    return Date.now() - entry.lastErrorAt < MCP_CIRCUIT_COOLDOWN_MS;
  }
}

/** Промис с таймаутом (таймер не держит процесс живым). */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Текстовые части результата MCP-вызова. */
function extractText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts;
}

/** Код ошибки MCP «таймаут запроса» (`ErrorCode.RequestTimeout`). */
const MCP_ERROR_REQUEST_TIMEOUT = -32001;

/**
 * Таймаут ли это (SDK сам прерывает запрос по своему таймауту)?
 *
 * Текст SDK («MCP error -32001: Request timed out») без имени инструмента
 * нечитаем для модели — переводим в наш.
 */
function isTimeoutError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (code === MCP_ERROR_REQUEST_TIMEOUT) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Request timed out');
}

/**
 * Текст ошибки без секретов: значения `env` сервера вычищаются.
 *
 * MCP-сервер может напечатать свой токен в stderr/сообщение об ошибке —
 * наружу такое выходить не должно.
 */
export function sanitizeError(err: unknown, spec: McpServerSpec): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, spec);
}

/** Вычистить значения `env` сервера из произвольного текста. */
export function redactSecrets(text: string, spec: McpServerSpec): string {
  let message = text;
  for (const value of Object.values(spec.env)) {
    if (typeof value !== 'string' || value.length < 4) continue;
    if (message.includes(value)) message = message.split(value).join('***');
  }
  return message;
}
