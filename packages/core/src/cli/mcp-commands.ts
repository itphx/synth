/**
 * CLI `synth mcp …` — управление реестром MCP-серверов (ADR-071 §2.5).
 *
 * **Что делает модуль.** Тонкий клиент HTTP API v2 **локального** инстанса
 * (`/api/v2/mcp/*`): реестр, проверка подключения, добавление/удаление и
 * переподключение без рестарта. Логики MCP здесь нет — она в ядре, поэтому
 * нужен **запущенный инстанс** (`synth serve`) и его API-ключ.
 *
 * **Подключение.** Адрес — `http://127.0.0.1:<port>`, где порт резолвится как
 * у `serve`: `SYNTH_CORE_PORT` → `core.port`. Ключ: `--api-key` →
 * `SYNTH_API_KEY` → `core.apiKey` → файл `{dataDir}/secrets/api-key`. Значение
 * ключа нигде не печатается (инвариант 13). Пустой ключ — понятная ошибка CLI,
 * а не 401 от сервера.
 *
 * **Транспорт.** Обычный `fetch` (localhost, без прокси/egress-слоя — ADR-099
 * к локальным запросам не применяется); в тестах подменяется.
 *
 * **Ограничения.** `enable` здесь нет: включение сервера требует контекста
 * сессии/проекта, это делает инструмент `synth_mcp_enable`. Заголовки
 * (`headers`) не поддерживаются: секреты — только через UI/слой внешних
 * доступов (ADR-105), иначе plaintext-секрет попал бы в реестр.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Command } from 'commander';
import {
  loadConfig,
  resolveDataDir,
  resolveHome,
  resolvePort,
  type McpServerConfig,
  type SynthConfig,
} from '@itphx/synth-shared';

import { localApiKeyFilePath } from '../auth/local-key.js';

/** Подключение к локальному инстансу (базовый URL без `/api/v2` и токен). */
export interface McpCliConnection {
  baseUrl: string;
  token: string;
}

/** Параметры резолвинга подключения (общие для подкоманд). */
export interface McpCliConnectionOptions {
  /** Явный API-ключ (`--api-key`). */
  apiKey?: string;
  /** Путь к config.yaml (`--config`). */
  config?: string;
  /** Каталог данных (`--data-dir`). */
  dataDir?: string;
  /** Локальный home-каталог (`--home`). */
  home?: string;
}

/** Зависимости группы команд (в CLI — дефолты, в тестах — подмены). */
export interface McpCliDeps {
  /** Резолвер подключения; по умолчанию — локальный инстанс из конфига. */
  resolveConnection?: (options: McpCliConnectionOptions) => Promise<McpCliConnection>;
  /** Транспорт (тесты — подмена; по умолчанию — глобальный `fetch`). */
  fetchImpl?: typeof fetch;
  /** Вывод в stdout (по умолчанию — `console.log`). */
  stdout?: (line: string) => void;
  /** Вывод в stderr (по умолчанию — `console.error`). */
  stderr?: (line: string) => void;
}

/** Допустимые типы MCP-серверов. */
const MCP_TYPES = ['stdio', 'http', 'sse'] as const;

/** Тип MCP-сервера для CLI. */
type McpType = (typeof MCP_TYPES)[number];

/** Ошибка CLI: машинный код + текст. */
export class McpCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpCliError';
  }
}

/** Параметры сборки тела `POST /registry`. */
export interface McpAddInput {
  name: string;
  type: string;
  url?: string;
  command?: string;
  arg?: string[];
  env?: string[];
  description?: string;
  origin?: string;
  enabledByDefault?: boolean;
}

/** Тело добавления записи реестра (как ждёт `POST /api/v2/mcp/registry`). */
export interface McpAddPayload {
  name: string;
  config: McpServerConfig;
  origin: 'instance' | 'user';
  enabled: true;
  enabledByDefault: boolean;
}

/** Непустая строка из опции CLI. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `--env KEY=VALUE` → запись `env` (ключ непустой; значение может быть пустым). */
function parseEnvPairs(pairs: unknown): Record<string, string> | undefined {
  if (!Array.isArray(pairs) || pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const raw of pairs) {
    const pair = str(raw);
    const eq = pair.indexOf('=');
    const key = eq > 0 ? pair.slice(0, eq).trim() : '';
    if (!key) {
      throw new McpCliError(
        'VALIDATION_ERROR',
        `--env: ожидается KEY=VALUE с непустым KEY, получено «${pair}»`,
      );
    }
    env[key] = pair.slice(eq + 1);
  }
  return env;
}

/**
 * Собрать тело `POST /api/v2/mcp/registry` из флагов CLI.
 *
 * Тип определяет обязательные поля: `stdio` — `--command` (+`--arg`/`--env`),
 * `http`/`sse` — `--url`. Заголовки не поддерживаются (секреты — только через
 * UI/слой внешних доступов).
 */
export function buildMcpAddPayload(input: McpAddInput): McpAddPayload {
  const name = str(input.name);
  if (!name) {
    throw new McpCliError('VALIDATION_ERROR', '--name: имя сервера не может быть пустым');
  }

  const typeRaw = str(input.type);
  if (!MCP_TYPES.includes(typeRaw as McpType)) {
    throw new McpCliError(
      'VALIDATION_ERROR',
      `--type: ожидается ${MCP_TYPES.join(' | ')}, получено «${typeRaw}»`,
    );
  }
  const type = typeRaw as McpType;
  const description = str(input.description) || undefined;

  const origin = str(input.origin) || 'user';
  if (origin !== 'instance' && origin !== 'user') {
    throw new McpCliError(
      'VALIDATION_ERROR',
      `--origin: ожидается instance | user, получено «${origin}»`,
    );
  }

  let config: McpServerConfig;
  if (type === 'stdio') {
    const command = str(input.command);
    if (!command) {
      throw new McpCliError('VALIDATION_ERROR', '--type stdio: требуется --command <cmd>');
    }
    if (str(input.url)) {
      throw new McpCliError('VALIDATION_ERROR', '--url не применим к серверу типа stdio');
    }
    const args = Array.isArray(input.arg)
      ? input.arg.map((arg) => String(arg)).filter((arg) => arg.length > 0)
      : [];
    const env = parseEnvPairs(input.env);
    config = {
      type,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(description ? { description } : {}),
    };
  } else {
    const url = str(input.url);
    if (!url) {
      throw new McpCliError('VALIDATION_ERROR', `--type ${type}: требуется --url <url>`);
    }
    if (str(input.command)) {
      throw new McpCliError('VALIDATION_ERROR', '--command не применим к HTTP/SSE-серверу');
    }
    if ((Array.isArray(input.arg) && input.arg.length > 0) || (Array.isArray(input.env) && input.env.length > 0)) {
      throw new McpCliError('VALIDATION_ERROR', '--arg/--env применимы только к серверу типа stdio');
    }
    config = { type, url, ...(description ? { description } : {}) };
  }

  return {
    name,
    config,
    origin,
    enabled: true,
    enabledByDefault: input.enabledByDefault === true,
  };
}

/** Параметры `resolveMcpApiKey`. */
export interface ResolveMcpApiKeyOptions {
  /** Явный ключ (`--api-key`). */
  apiKey?: string;
  /** Окружение (по умолчанию — `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Загруженный конфиг (для `core.apiKey`). */
  config?: SynthConfig;
  /** Каталог данных (для файла `{dataDir}/secrets/api-key`). */
  dataDir: string;
  /** Чтение файла ключа (тесты — подмена). */
  readFileImpl?: (path: string) => Promise<string>;
}

/**
 * Резолвинг API-ключа локального инстанса:
 * `--api-key` → `SYNTH_API_KEY` → `core.apiKey` → файл `{dataDir}/secrets/api-key`.
 *
 * Ничего не печатает (инвариант 13). Файл только читается — создаёт его сервер
 * при старте (`resolveOrCreateLocalApiKey`).
 */
export async function resolveMcpApiKey(options: ResolveMcpApiKeyOptions): Promise<string> {
  let key = str(options.apiKey);
  if (!key) key = str((options.env ?? process.env).SYNTH_API_KEY);
  if (!key) key = str(options.config?.core.apiKey);
  if (!key) {
    const read = options.readFileImpl ?? ((path: string) => readFile(path, 'utf-8'));
    key = (await read(localApiKeyFilePath(options.dataDir)).catch(() => '')).trim();
  }
  return key;
}

/** Дефолтный резолвер подключения: локальный инстанс (`127.0.0.1`). */
async function resolveLocalConnection(options: McpCliConnectionOptions): Promise<McpCliConnection> {
  const home = resolveHome(options.home ?? null);
  const synth = await loadConfig({ configPath: options.config, home: home ?? undefined });
  const dataDir = resolve(options.dataDir || resolveDataDir(synth, undefined, home));
  const port = resolvePort(synth, 'SYNTH_CORE_PORT', synth.core.port);
  const token = await resolveMcpApiKey({ apiKey: options.apiKey, config: synth, dataDir });
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

/** Базовый URL без хвостовых слэшей. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** URL эндпоинта API v2 (`<base>/api/v2<path>`). */
function buildUrl(baseUrl: string, path: string): string {
  return `${trimBaseUrl(baseUrl)}/api/v2${path}`;
}

/** Код ошибки из тела API (`{error:{code}}`) — иначе код по HTTP-статусу. */
function extractErrorCode(body: unknown, status: number): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) return code.trim();
    }
  }
  return `HTTP_${status}`;
}

/** Текст ошибки из тела API (`{error:{message}}`) — иначе тело/статус. */
function extractErrorMessage(body: unknown, status: number, raw: string): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
  }
  const text = raw.trim();
  return text || `HTTP ${status}`;
}

/** Сообщение о недоступном локальном инстансе. */
function unreachableMessage(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `сервер не отвечает на ${url.hostname}:${port}; запустите synth serve`;
  } catch {
    return `сервер не отвечает (${baseUrl}); запустите synth serve`;
  }
}

/** Клиент HTTP-контура MCP. */
interface McpApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  del(path: string): Promise<unknown>;
}

/**
 * HTTP-клиент: ошибка HTTP → `McpCliError` с кодом/текстом из тела, сетевая
 * ошибка → `SERVER_UNREACHABLE` с подсказкой про `synth serve`.
 */
function createApiClient(deps: McpCliDeps, conn: McpCliConnection): McpApiClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const call = async (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const url = buildUrl(conn.baseUrl, path);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${conn.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new McpCliError('SERVER_UNREACHABLE', unreachableMessage(conn.baseUrl));
    }

    const raw = await response.text().catch(() => '');
    let parsed: unknown;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      throw new McpCliError(
        extractErrorCode(parsed, response.status),
        extractErrorMessage(parsed, response.status, raw),
      );
    }
    return parsed;
  };

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    del: (path) => call('DELETE', path),
  };
}

/** Запись реестра для вывода (поля, которые есть в ответе `GET /registry`). */
interface McpRegistryRow {
  name?: string;
  origin?: string;
  trust?: string;
  enabled?: boolean;
  config?: { type?: string; url?: string; command?: string; description?: string };
}

/** Записи из ответа `GET /registry` (`{entries}` или массив). */
function extractEntries(body: unknown): McpRegistryRow[] {
  const items = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? (body as { entries?: unknown }).entries
      : undefined;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is McpRegistryRow => !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

/** Строка таблицы реестра: имя/тип/origin/trust/enabled. */
function formatRegistryRow(row: McpRegistryRow): string {
  const type = str(row.config?.type) || '—';
  return [
    str(row.name).padEnd(28),
    type.padEnd(7),
    (str(row.origin) || '—').padEnd(9),
    (str(row.trust) || '—').padEnd(10),
    (row.enabled === false ? 'нет' : 'да').padEnd(4),
  ].join(' ');
}

/** Общие опции подкоманд (`--api-key`/`--config`/`--data-dir`/`--home`). */
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--api-key <key>', 'API-ключ локального инстанса (не печатается)')
    .option('--config <path>', 'путь к config.yaml')
    .option('--data-dir <path>', 'каталог данных инстанса')
    .option('--home <path>', 'локальный home-каталог');
}

/** Опции подкоманды → параметры резолвера подключения. */
function connectionOptions(options: Record<string, unknown>): McpCliConnectionOptions {
  return {
    ...(typeof options.apiKey === 'string' ? { apiKey: options.apiKey } : {}),
    ...(typeof options.config === 'string' ? { config: options.config } : {}),
    ...(typeof options.dataDir === 'string' ? { dataDir: options.dataDir } : {}),
    ...(typeof options.home === 'string' ? { home: options.home } : {}),
  };
}

/**
 * Общая обвязка: подключение → выполнение → код выхода.
 *
 * Ошибки (HTTP, сеть, пустой ключ) печатаются в `stderr` как `<КОД>: <текст>`,
 * код выхода — 1.
 */
async function run(
  deps: McpCliDeps,
  options: Record<string, unknown>,
  fn: (client: McpApiClient) => Promise<number>,
): Promise<void> {
  const err = deps.stderr ?? ((line: string) => console.error(line));
  try {
    const resolveConnection = deps.resolveConnection ?? resolveLocalConnection;
    const conn = await resolveConnection(connectionOptions(options));
    if (!str(conn.baseUrl)) {
      throw new McpCliError('NO_URL', 'не задан адрес инстанса');
    }
    if (!str(conn.token)) {
      throw new McpCliError(
        'NO_API_KEY',
        'инстанс не запущен или не найден API-ключ; запустите synth serve или укажите --api-key',
      );
    }
    const client = createApiClient(deps, conn);
    process.exitCode = await fn(client);
  } catch (error) {
    if (error instanceof McpCliError) {
      err(`Ошибка: ${error.code}: ${error.message}`);
    } else {
      err(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

/** `synth mcp list [--json]` — записи реестра. */
function createListCommand(deps: McpCliDeps): Command {
  const cmd = new Command('list').description('Список MCP-серверов в реестре');
  addCommonOptions(cmd.option('--json', 'машиночитаемый вывод (JSON)'));
  return cmd.action(async (options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const body = await client.get('/mcp/registry');
      if (options.json === true) {
        out(JSON.stringify(body ?? null, null, 2));
        return 0;
      }
      const entries = extractEntries(body);
      if (entries.length === 0) {
        out('MCP-серверов нет.');
        return 0;
      }
      out(
        ['ИМЯ'.padEnd(28), 'ТИП'.padEnd(7), 'ORIGIN'.padEnd(9), 'TRUST'.padEnd(10), 'ВКЛ'].join(' '),
      );
      for (const entry of entries) out(formatRegistryRow(entry));
      out(`Всего: ${entries.length}`);
      return 0;
    });
  });
}

/** `synth mcp add …` — добавить запись реестра. */
function createAddCommand(deps: McpCliDeps): Command {
  const cmd = new Command('add').description(
    'Добавить MCP-сервер в реестр (stdio — --command/--arg/--env; http/sse — --url)',
  );
  addCommonOptions(
    cmd
      .requiredOption('--name <name>', 'имя сервера')
      .requiredOption('--type <type>', `тип: ${MCP_TYPES.join(' | ')}`)
      .option('--url <url>', 'URL сервера (http/sse)')
      .option('--command <cmd>', 'команда запуска (stdio)')
      .option('--arg <arg...>', 'аргумент команды (stdio; можно повторять)')
      .option('--env <pair...>', 'переменная окружения KEY=VALUE (stdio; можно повторять)')
      .option('--description <text>', 'описание сервера')
      .option('--origin <origin>', 'origin записи: instance | user (по умолчанию user; instance — только для доверенных/локальных сервисов, ADMIN)')
      .option('--enabled-by-default', 'включать сервер в новых проектах по умолчанию')
      .option('--json', 'машиночитаемый вывод (JSON)'),
  );
  return cmd.action(async (options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const payload = buildMcpAddPayload({
        name: str(options.name),
        type: str(options.type),
        ...(typeof options.url === 'string' ? { url: options.url } : {}),
        ...(typeof options.command === 'string' ? { command: options.command } : {}),
        ...(Array.isArray(options.arg) ? { arg: options.arg as string[] } : {}),
        ...(Array.isArray(options.env) ? { env: options.env as string[] } : {}),
        ...(typeof options.description === 'string' ? { description: options.description } : {}),
        ...(typeof options.origin === 'string' ? { origin: options.origin } : {}),
        enabledByDefault: options.enabledByDefault === true,
      });
      const body = await client.post('/mcp/registry', payload);
      if (options.json === true) {
        out(JSON.stringify(body ?? null, null, 2));
        return 0;
      }
      out(
        `Сервер "${payload.name}" добавлен ` +
          `(тип ${payload.config.type}, origin ${payload.origin}` +
          `${payload.enabledByDefault ? ', включён по умолчанию' : ''})`,
      );
      return 0;
    });
  });
}

/** `synth mcp test <name>` — временное подключение и список инструментов. */
function createTestCommand(deps: McpCliDeps): Command {
  const cmd = new Command('test').description('Проверить подключение к MCP-серверу');
  cmd.argument('<name>', 'имя сервера');
  addCommonOptions(cmd.option('--json', 'машиночитаемый вывод (JSON)'));
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const body = (await client.post(
        `/mcp/servers/${encodeURIComponent(name)}/test`,
        {},
      )) as {
        success?: boolean;
        toolCount?: number;
        tools?: Array<{ name?: string; description?: string }>;
        error?: string;
      };
      if (options.json === true) out(JSON.stringify(body ?? null, null, 2));
      if (body?.success === false) {
        throw new McpCliError('MCP_TEST_FAILED', str(body.error) || 'подключение не удалось');
      }
      if (options.json !== true) {
        const tools = Array.isArray(body?.tools) ? body.tools : [];
        out(`Подключение успешно: ${name} (инструментов: ${body?.toolCount ?? tools.length})`);
        for (const tool of tools) {
          out(`  ${str(tool.name)}${str(tool.description) ? ` — ${str(tool.description)}` : ''}`);
        }
      }
      return 0;
    });
  });
}

/** `synth mcp remove <name>` — удалить запись реестра. */
function createRemoveCommand(deps: McpCliDeps): Command {
  const cmd = new Command('remove').description('Удалить MCP-сервер из реестра');
  cmd.argument('<name>', 'имя сервера');
  addCommonOptions(cmd.option('--json', 'машиночитаемый вывод (JSON)'));
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const body = await client.del(`/mcp/servers/${encodeURIComponent(name)}`);
      if (options.json === true) {
        out(JSON.stringify(body ?? null, null, 2));
        return 0;
      }
      out(`Сервер "${name}" удалён`);
      return 0;
    });
  });
}

/** `synth mcp reconnect <name>` — переподключить без рестарта инстанса. */
function createReconnectCommand(deps: McpCliDeps): Command {
  const cmd = new Command('reconnect').description(
    'Переподключить MCP-сервер без рестарта инстанса (снять и заново загрузить инструменты)',
  );
  cmd.argument('<name>', 'имя сервера');
  addCommonOptions(cmd.option('--json', 'машиночитаемый вывод (JSON)'));
  return cmd.action(async (name: string, options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const body = (await client.post(
        `/mcp/servers/${encodeURIComponent(name)}/reconnect`,
      )) as {
        success?: boolean;
        status?: string;
        connected?: boolean;
        toolCount?: number;
        error?: string;
      };
      if (options.json === true) out(JSON.stringify(body ?? null, null, 2));
      if (body?.success === false || body?.connected === false) {
        throw new McpCliError(
          'MCP_RECONNECT_FAILED',
          str(body?.error) || `сервер не подключён (статус ${str(body?.status) || '—'})`,
        );
      }
      if (options.json !== true) {
        out(
          `Сервер "${name}" переподключён ` +
            `(статус ${str(body?.status) || 'connected'}, инструментов: ${body?.toolCount ?? 0})`,
        );
      }
      return 0;
    });
  });
}

/**
 * Собрать группу команд `synth mcp …`.
 *
 * `enable` намеренно нет — включение сервера в сессию/проект требует контекста
 * (инструмент `synth_mcp_enable`).
 */
export function createMcpCommand(deps: McpCliDeps = {}): Command {
  return new Command('mcp')
    .description('MCP-серверы (ADR-071): реестр, проверка, добавление, удаление, переподключение')
    .addCommand(createListCommand(deps))
    .addCommand(createAddCommand(deps))
    .addCommand(createTestCommand(deps))
    .addCommand(createRemoveCommand(deps))
    .addCommand(createReconnectCommand(deps));
}
