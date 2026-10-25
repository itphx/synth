/**
 * ADR-107 / PROP-047 §2.1: CLI `synth memory …` — **тонкий клиент HTTP API v2**
 * портала памяти (`/api/v2/memory/*`, `server/routes/memory.ts`).
 *
 * **Что делает модуль.** Никакой логики памяти: чанкер, эмбеддинги, индекс и
 * консолидация живут в плагине памяти (PROP-047 §3), ядро владеет данными
 * (порты `MemoryFactRepository`/`MemoryIndexRepository`, ADR-096). CLI только
 * ходит в HTTP-контур работающего инстанса — поэтому нужен **запущенный
 * инстанс** и **токен** (см. «Подключение» ниже).
 *
 * **Подключение (`deps.resolveConnection`).** Адрес и токен резолвит вызывающая
 * сторона (в `main.ts`): `--url` → `remote.backendUrl` (если `remote.enabled`) →
 * `http://127.0.0.1:<port>`; токен — `--token` → `SYNTH_API_KEY` →
 * `core.apiKey` → файл `{dataDir}/secrets/api-key`. Пустой токен — понятная
 * ошибка CLI («не задан API-ключ»), а не 401 от сервера: оператор должен знать,
 * что не задал ключ, а не что ключ неверный.
 *
 * **Асинхронность.** `POST /memory/indexes` и `POST /memory/indexes/:id/rebuild`
 * отвечают `202` — сборка идёт в фоне (PROP-047 §2.3). Поэтому у `index` и
 * `rebuild` есть `--wait`: опрос `GET /memory/indexes` до состояния
 * `ready`/`failed` (интервал 1 с, таймаут по умолчанию 300 с). Без `--wait`
 * команда возвращает id и состояние сразу после постановки задачи.
 *
 * **Коды выхода.** `0` — операция выполнена; `1` — отказ (ошибка HTTP с кодом
 * и текстом из тела `{error:{code,message}}`, сетевая ошибка, отсутствующий
 * токен, отказ без `--yes`, таймаут ожидания). Ошибки — в `stderr`, результат —
 * в `stdout`. Код выхода ставится через `process.exitCode` (не `process.exit`).
 *
 * **Область индекса (`--scope`).** У индекса есть область видимости
 * (`project`/`instance`, порт `MemoryIndexRepository`): `project` — индекс
 * виден только своему проекту, `instance` — общий корпус инстанса. Для
 * `instance` позиционный `projectId` — **источник корпуса** (чей workspace
 * сканировать при `--source files`); при `--source facts` он не нужен и в
 * тело не уходит. Значение флага проверяется локально (`VALIDATION_ERROR`),
 * чтобы не получать 400 от сервера.
 *
 * **Транспорт.** `deps.fetchImpl ?? fetch` — в CLI это `egressFetch`
 * (ADR-099: единое доверие TLS/CA и прокси для исходящих соединений); в
 * тестах — подмена без сети.
 */
import { Command } from 'commander';

import type { MemoryCliConnection } from './memory-connection.js';

/**
 * Подключение к инстансу (базовый URL + Bearer-токен).
 *
 * Тип — из общего резолвера `memory-connection.ts` (одна реализация правил
 * адреса/ключа для core-CLI и публикуемого `synth`); реэкспорт сохраняет
 * публичный API модуля команд.
 */
export type { MemoryCliConnection };

/** Зависимости группы команд (резолвер подключения + транспорт + вывод). */
export interface MemoryCliDeps {
  /**
   * Резолвинг подключения по опциям CLI.
   *
   * Вызывающая сторона (core `main.ts`) читает конфиг/файл ключа и применяет
   * доверие TLS/CA до первого запроса.
   */
  resolveConnection: (options: {
    url?: string;
    token?: string;
    config?: string;
    dataDir?: string;
  }) => Promise<MemoryCliConnection>;
  /** Транспорт (тесты — подмена; по умолчанию — `fetch`). */
  fetchImpl?: typeof fetch;
  /** Вывод в stdout (по умолчанию — `console.log`). */
  stdout?: (line: string) => void;
  /** Вывод в stderr (по умолчанию — `console.error`). */
  stderr?: (line: string) => void;
  /** Интервал опроса при `--wait`, мс (тесты — 0). */
  pollIntervalMs?: number;
  /** Пауза между опросами (инъекция для тестов). */
  sleep?: (ms: number) => Promise<void>;
  /** Текущее время в мс (инъекция для тестов: дедлайн `--wait`). */
  now?: () => number;
}

/** Таймаут ожидания индекса по умолчанию, с. */
const DEFAULT_WAIT_TIMEOUT_SEC = 300;

/** Интервал опроса индекса по умолчанию, мс. */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Виды источника корпуса индекса (как в портале памяти). */
const MEMORY_SOURCE_KINDS = ['files', 'facts'] as const;

/**
 * Области видимости индекса памяти (как в порте `MemoryIndexRepository`).
 *
 * `project` — индекс виден только своему проекту; `instance` — общий корпус
 * инстанса (например, индекс по фактам памяти или по workspace, не
 * привязанному к проекту).
 */
const MEMORY_INDEX_SCOPES = ['project', 'instance'] as const;

/** Область видимости индекса памяти. */
type MemoryIndexScope = (typeof MEMORY_INDEX_SCOPES)[number];

/**
 * Ошибка CLI: машинный код + текст.
 *
 * Для HTTP-ошибок код берётся из тела (`{error:{code,message}}`), для
 * остальных — локальный (`NO_API_KEY`, `NETWORK_ERROR`, …).
 */
class MemoryCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryCliError';
  }
}

/** Снимок статуса портала памяти (`GET /memory/status`). */
interface MemoryStatusView {
  provider?: { id?: string; mode?: string | null; active?: boolean };
  readiness?: string;
  namespace?: string;
  facts?: { total?: number; active?: number };
  indexes?: {
    total?: number;
    ready?: number;
    stale?: number;
    failed?: number;
    building?: number;
  };
}

/** Строка индекса памяти (`GET /memory/indexes` → `items[]`). */
interface MemoryIndexRow {
  id?: string;
  name?: string;
  projectId?: string;
  /** Область видимости индекса (`project`/`instance`). */
  scope?: string;
  source?: { kind?: string; filter?: string };
  state?: string;
  generation?: number;
  stats?: { chunks?: number; documents?: number; updatedAt?: string };
  updatedAt?: string;
  error?: string;
}

/** Клиент HTTP-контура портала памяти. */
interface MemoryApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  del(path: string): Promise<unknown>;
}

/** Базовый URL инстанса без хвостовых слэшей. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** URL эндпоинта портала памяти (`<base>/api/v2<path>`). */
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

/** Список индексов из ответа `GET /memory/indexes`. */
function extractIndexRows(body: unknown): MemoryIndexRow[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (item): item is MemoryIndexRow => !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

/**
 * Клиент HTTP-контура портала памяти.
 *
 * Ошибка HTTP → `MemoryCliError` с кодом и текстом из тела; сетевая ошибка →
 * `MemoryCliError` с кодом `NETWORK_ERROR` (иначе оператор увидит «401» там,
 * где нет даже ответа сервера).
 */
function createApiClient(deps: MemoryCliDeps, conn: MemoryCliConnection): MemoryApiClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> => {
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
    } catch (err) {
      throw new MemoryCliError(
        'NETWORK_ERROR',
        `не удалось обратиться к ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      throw new MemoryCliError(
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

/** Число из ответа (не число/отрицательное — 0). */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Строка из ответа (не строка — пустая). */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Значение `state` индекса для вывода. */
function indexState(row: MemoryIndexRow): string {
  return str(row.state) || '—';
}

/** Число чанков индекса (из `stats.chunks`). */
function indexChunks(row: MemoryIndexRow): number {
  return num(row.stats?.chunks);
}

/**
 * Область видимости индекса из флага `--scope` (валидация локальная).
 *
 * Пустое значение — `fallback` (для `index` — `project`, для `list` — фильтр
 * не задан). Недопустимое значение — `VALIDATION_ERROR`: локальная ошибка
 * понятнее, чем 400 от сервера.
 */
function parseIndexScope(
  raw: unknown,
  fallback: MemoryIndexScope | undefined,
): MemoryIndexScope | undefined {
  const value = str(raw).trim();
  if (!value) return fallback;
  if (!MEMORY_INDEX_SCOPES.includes(value as MemoryIndexScope)) {
    throw new MemoryCliError(
      'VALIDATION_ERROR',
      `--scope: ожидается ${MEMORY_INDEX_SCOPES.join(' | ')}, получено «${value}»`,
    );
  }
  return value as MemoryIndexScope;
}

/** Человекочитаемая строка таблицы индексов. */
function formatIndexRow(row: MemoryIndexRow): string {
  const source = str(row.source?.kind) || '—';
  const filter = str(row.source?.filter);
  return [
    str(row.id).padEnd(38),
    str(row.name).padEnd(20),
    (str(row.scope) || '—').padEnd(8),
    str(row.projectId).padEnd(20),
    (filter ? `${source}:${filter}` : source).padEnd(24),
    indexState(row).padEnd(10),
    String(row.generation ?? 0).padStart(5),
    String(indexChunks(row)).padStart(7),
    (str(row.updatedAt) || str(row.stats?.updatedAt) || '—').substring(0, 19).padEnd(20),
  ].join(' ');
}

/** Опции `--wait`/`--timeout` → таймаут в мс. */
function parseTimeoutSec(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WAIT_TIMEOUT_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MemoryCliError('VALIDATION_ERROR', `--timeout: ожидается неотрицательное число секунд, получено «${String(raw)}»`);
  }
  return parsed;
}

/**
 * Ожидание готовности индекса: опрос `GET /memory/indexes` до состояния
 * `ready`/`failed`.
 *
 * Индекс не найден в списке — состояние неизвестно, ждём дальше (запись могла
 * ещё не появиться). Таймаут — по дедлайну (`now()`), интервал — `sleep()`;
 * и то и другое инъектируется, поэтому тест не ждёт реального времени.
 */
async function waitForIndex(
  deps: MemoryCliDeps,
  client: MemoryApiClient,
  indexId: string,
  timeoutSec: number,
): Promise<{ done: boolean; failed: boolean; timedOut: boolean; row?: MemoryIndexRow }> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const started = now();
  const timeoutMs = timeoutSec * 1000;

  for (;;) {
    const body = await client.get('/memory/indexes');
    const row = extractIndexRows(body).find((item) => str(item.id) === indexId);
    if (row) {
      const state = str(row.state);
      if (state === 'ready') return { done: true, failed: false, timedOut: false, row };
      if (state === 'failed') return { done: true, failed: true, timedOut: false, row };
    }
    if (now() - started >= timeoutMs) {
      return { done: false, failed: false, timedOut: true, row };
    }
    await sleep(interval);
  }
}

/**
 * Общие опции подкоманд (`--url`/`--token`/`--config`/`--data-dir`).
 *
 * Те же пути, что у остальных групп CLI (`session`, `doctor`, `backup`).
 */
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option(
      '--url <base>',
      'базовый URL инстанса (например https://synth.example или http://127.0.0.1:5000)',
    )
    .option('--token <key>', 'API-ключ инстанса (Bearer)')
    .option('--config <path>', 'путь к config.yaml')
    .option('--data-dir <path>', 'каталог данных инстанса');
}

/** Опции подкоманды → параметры резолвера подключения. */
function connectionOptions(options: Record<string, unknown>): {
  url?: string;
  token?: string;
  config?: string;
  dataDir?: string;
} {
  return {
    ...(typeof options.url === 'string' ? { url: options.url } : {}),
    ...(typeof options.token === 'string' ? { token: options.token } : {}),
    ...(typeof options.config === 'string' ? { config: options.config } : {}),
    ...(typeof options.dataDir === 'string' ? { dataDir: options.dataDir } : {}),
  };
}

/**
 * Общая обвязка команды: подключение → выполнение → код выхода.
 *
 * Ошибки (HTTP, сеть, пустой токен) печатаются в `stderr` с кодом и текстом,
 * код выхода — 1.
 */
async function run(
  deps: MemoryCliDeps,
  options: Record<string, unknown>,
  fn: (client: MemoryApiClient) => Promise<number>,
): Promise<void> {
  const err = deps.stderr ?? ((line: string) => console.error(line));
  try {
    const conn = await deps.resolveConnection(connectionOptions(options));
    const baseUrl = str(conn?.baseUrl).trim();
    const token = str(conn?.token).trim();
    if (!baseUrl) {
      throw new MemoryCliError('NO_URL', 'не задан адрес инстанса — укажите --url <base>');
    }
    if (!token) {
      throw new MemoryCliError(
        'NO_API_KEY',
        'не задан API-ключ инстанца — укажите --token <key>, задайте SYNTH_API_KEY или ' +
          'core.apiKey в config.yaml (либо файл {dataDir}/secrets/api-key)',
      );
    }
    const client = createApiClient(deps, { baseUrl, token });
    process.exitCode = await fn(client);
  } catch (error) {
    if (error instanceof MemoryCliError) {
      err(`Ошибка: ${error.code}: ${error.message}`);
    } else {
      err(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}

/** `synth memory status [--json]` — готовность, провайдер, счётчики. */
function createStatusCommand(deps: MemoryCliDeps): Command {
  const cmd = new Command('status').description(
    'Статус портала памяти: готовность, провайдер, факты и индексы',
  );
  addCommonOptions(cmd.option('--json', 'машиночитаемый вывод (JSON)'));
  return cmd.action(async (options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const body = await client.get('/memory/status');
      if (options.json === true) {
        out(JSON.stringify(body ?? null, null, 2));
        return 0;
      }
      const view = (body ?? {}) as MemoryStatusView;
      const provider = view.provider ?? {};
      const facts = view.facts ?? {};
      const indexes = view.indexes ?? {};
      out(`Готовность: ${str(view.readiness) || '—'}`);
      out(
        `Провайдер: ${str(provider.id) || '—'}` +
          ` (${provider.active ? 'активен' : 'не активен'}` +
          `${str(provider.mode) ? `, режим ${str(provider.mode)}` : ''})`,
      );
      if (str(view.namespace)) out(`Namespace: ${str(view.namespace)}`);
      out(`Факты: всего ${num(facts.total)}, активных ${num(facts.active)}`);
      out(
        `Индексы: всего ${num(indexes.total)} ` +
          `(ready ${num(indexes.ready)}, stale ${num(indexes.stale)}, ` +
          `failed ${num(indexes.failed)}, building ${num(indexes.building)})`,
      );
      if (str(view.readiness) === 'degraded') {
        out('Внимание: есть индексы stale/failed — нужна пересборка (synth memory rebuild <id>)');
      }
      if (str(view.readiness) === 'unavailable') {
        out('Внимание: порты памяти недоступны — портал отвечает деградацией (MEMORY_UNAVAILABLE)');
      }
      return 0;
    });
  });
}

/** `synth memory list [--project <id>] [--state <state>] [--scope <scope>] [--json]` — индексы. */
function createListCommand(deps: MemoryCliDeps): Command {
  const cmd = new Command('list').description('Список индексов памяти');
  addCommonOptions(
    cmd
      .option('--project <id>', 'только индексы проекта')
      .option('--state <state>', 'фильтр по состоянию: building | ready | stale | failed | all')
      .option(
        '--scope <scope>',
        `фильтр по области индекса: ${MEMORY_INDEX_SCOPES.join(' | ')}`,
      )
      .option('--json', 'машиночитаемый вывод (JSON)'),
  );
  return cmd.action(async (options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const query = new URLSearchParams();
      const projectId = str(options.project).trim();
      const state = str(options.state).trim();
      const scope = parseIndexScope(options.scope, undefined);
      if (projectId) query.set('projectId', projectId);
      // `all` — не состояние индекса, а «без фильтра»: сервер отверг бы его 400.
      if (state && state !== 'all') query.set('state', state);
      if (scope) query.set('scope', scope);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      const body = await client.get(`/memory/indexes${suffix}`);
      if (options.json === true) {
        out(JSON.stringify(body ?? null, null, 2));
        return 0;
      }
      const rows = extractIndexRows(body);
      if (rows.length === 0) {
        out('Индексов нет.');
        return 0;
      }
      out(
        [
          'ID'.padEnd(38),
          'ИМЯ'.padEnd(20),
          'SCOPE'.padEnd(8),
          'ПРОЕКТ'.padEnd(20),
          'ИСТОЧНИК'.padEnd(24),
          'СОСТОЯНИЕ'.padEnd(10),
          'ПОК'.padStart(5),
          'ЧАНКИ'.padStart(7),
          'ОБНОВЛЁН'.padEnd(20),
        ].join(' '),
      );
      for (const row of rows) out(formatIndexRow(row));
      const total = num((body as { total?: unknown })?.total) || rows.length;
      out(`Всего: ${total}`);
      return 0;
    });
  });
}

/** `synth memory index [projectId] …` — поставить сборку индекса (202). */
function createIndexCommand(deps: MemoryCliDeps): Command {
  const cmd = new Command('index').description(
    'Создать индекс памяти (--scope project — индекс проекта, instance — общий индекс инстанса; ' +
      'сборка идёт в фоне; --wait — дождаться готовности)',
  );
  cmd.argument(
    '[projectId]',
    'ID проекта (обязателен, кроме --scope instance --source facts)',
  );
  addCommonOptions(
    cmd
      .option('--name <name>', 'имя индекса')
      .option('--source <kind>', `источник корпуса: ${MEMORY_SOURCE_KINDS.join(' | ')} (по умолчанию — files)`)
      .option(
        '--scope <scope>',
        `область индекса: ${MEMORY_INDEX_SCOPES.join(' | ')} (по умолчанию — project)`,
      )
      .option('--filter <glob>', 'фильтр источника (glob для файлов)')
      .option('--wait', 'дождаться готовности индекса (опрос состояния)')
      .option('--timeout <sec>', `таймаут ожидания, с (по умолчанию — ${DEFAULT_WAIT_TIMEOUT_SEC})`)
      .option('--json', 'машиночитаемый вывод (JSON)'),
  );
  return cmd.action(async (projectId: string | undefined, options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const kind = str(options.source).trim() || 'files';
      if (!MEMORY_SOURCE_KINDS.includes(kind as (typeof MEMORY_SOURCE_KINDS)[number])) {
        throw new MemoryCliError(
          'VALIDATION_ERROR',
          `--source: ожидается ${MEMORY_SOURCE_KINDS.join(' | ')}, получено «${kind}»`,
        );
      }
      const scope = parseIndexScope(options.scope, 'project') ?? 'project';
      const project = str(projectId).trim();
      // `instance` + `facts` — общий индекс по фактам памяти: проект не нужен,
      // и в тело он не уходит (сервер для facts его игнорирует).
      const instanceFacts = scope === 'instance' && kind === 'facts';
      if (!instanceFacts && !project) {
        throw new MemoryCliError(
          'VALIDATION_ERROR',
          scope === 'instance'
            ? `--scope instance --source ${kind}: требуется projectId — он источник корпуса ` +
              '(workspace проекта)'
            : '--scope project: требуется projectId — индекс виден только своему проекту',
        );
      }
      const filter = str(options.filter).trim();
      const name = str(options.name).trim();
      const body = {
        ...(name ? { name } : {}),
        source: { kind, ...(filter ? { filter } : {}) },
        scope,
        ...(project && !instanceFacts ? { projectId: project } : {}),
      };
      const created = (await client.post('/memory/indexes', body)) as {
        index?: MemoryIndexRow;
        message?: string;
      };
      const index = created?.index ?? {};
      const indexId = str(index.id);
      if (options.json === true) {
        out(JSON.stringify(created ?? null, null, 2));
      } else {
        out(`Индекс создан: ${indexId || '—'} (состояние: ${indexState(index)})`);
        if (str(created?.message)) out(str(created.message));
      }
      if (options.wait !== true) return 0;
      if (!indexId) {
        throw new MemoryCliError('NO_INDEX_ID', 'инстанс не вернул id индекса — ждать нечего');
      }
      const waited = await waitForIndex(deps, client, indexId, parseTimeoutSec(options.timeout));
      if (waited.failed) {
        const reason = str(waited.row?.error) || 'неизвестная ошибка сборки';
        throw new MemoryCliError('MEMORY_INDEX_FAILED', `индекс ${indexId} не собран: ${reason}`);
      }
      if (waited.timedOut) {
        throw new MemoryCliError(
          'TIMEOUT',
          `таймаут ожидания индекса ${indexId} (${parseTimeoutSec(options.timeout)} с)`,
        );
      }
      if (options.json !== true) {
        out(`Индекс готов: ${indexId} (поколение ${num(waited.row?.generation)}, чанков ${indexChunks(waited.row ?? {})})`);
      }
      return 0;
    });
  });
}

/** `synth memory rebuild <indexId> [--wait]` — пересборка индекса (202). */
function createRebuildCommand(deps: MemoryCliDeps): Command {
  const cmd = new Command('rebuild').description(
    'Пересобрать индекс памяти (сборка идёт в фоне; --wait — дождаться готовности)',
  );
  cmd.argument('<indexId>', 'ID индекса');
  addCommonOptions(
    cmd
      .option('--wait', 'дождаться готовности индекса (опрос состояния)')
      .option('--timeout <sec>', `таймаут ожидания, с (по умолчанию — ${DEFAULT_WAIT_TIMEOUT_SEC})`)
      .option('--json', 'машиночитаемый вывод (JSON)'),
  );
  return cmd.action(async (indexId: string, options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    await run(deps, options, async (client) => {
      const body = (await client.post(`/memory/indexes/${encodeURIComponent(indexId)}/rebuild`)) as {
        index?: MemoryIndexRow;
      };
      const index = body?.index ?? {};
      if (options.json === true) {
        out(JSON.stringify(body ?? null, null, 2));
      } else {
        out(`Пересборка запущена: ${indexId} (состояние: ${indexState(index)})`);
      }
      if (options.wait !== true) return 0;
      const waited = await waitForIndex(deps, client, indexId, parseTimeoutSec(options.timeout));
      if (waited.failed) {
        const reason = str(waited.row?.error) || 'неизвестная ошибка сборки';
        throw new MemoryCliError('MEMORY_INDEX_FAILED', `индекс ${indexId} не собран: ${reason}`);
      }
      if (waited.timedOut) {
        throw new MemoryCliError(
          'TIMEOUT',
          `таймаут ожидания индекса ${indexId} (${parseTimeoutSec(options.timeout)} с)`,
        );
      }
      if (options.json !== true) {
        out(`Индекс готов: ${indexId} (поколение ${num(waited.row?.generation)}, чанков ${indexChunks(waited.row ?? {})})`);
      }
      return 0;
    });
  });
}

/** `synth memory drop <indexId> [--yes]` — удалить индекс (204). */
function createDropCommand(deps: MemoryCliDeps): Command {
  const cmd = new Command('drop').description('Удалить индекс памяти (деструктивно — требует --yes)');
  cmd.argument('<indexId>', 'ID индекса');
  addCommonOptions(
    cmd.option('--yes', 'подтвердить удаление индекса').option('--json', 'машиночитаемый вывод (JSON)'),
  );
  return cmd.action(async (indexId: string, options: Record<string, unknown>) => {
    const out = deps.stdout ?? ((line: string) => console.log(line));
    const err = deps.stderr ?? ((line: string) => console.error(line));
    if (options.yes !== true) {
      err(
        `Ошибка: удаление индекса необратимо (удаляются и его чанки) — ` +
          `повторите с --yes: synth memory drop ${indexId} --yes`,
      );
      process.exitCode = 1;
      return;
    }
    await run(deps, options, async (client) => {
      await client.del(`/memory/indexes/${encodeURIComponent(indexId)}`);
      if (options.json === true) {
        out(JSON.stringify({ id: indexId, deleted: true }));
      } else {
        out(`Индекс удалён: ${indexId}`);
      }
      return 0;
    });
  });
}

/**
 * Собрать группу команд `synth memory …`.
 *
 * `deps.resolveConnection` — фабрика подключения (в CLI — резолвер из
 * `main.ts`, в тестах — подмена); `deps.fetchImpl` — транспорт.
 */
export function createMemoryCommand(deps: MemoryCliDeps): Command {
  return new Command('memory')
    .description('Память (ADR-107): статус, индексы, пересборка, удаление — клиент HTTP API v2')
    .addCommand(createStatusCommand(deps))
    .addCommand(createListCommand(deps))
    .addCommand(createIndexCommand(deps))
    .addCommand(createRebuildCommand(deps))
    .addCommand(createDropCommand(deps));
}
