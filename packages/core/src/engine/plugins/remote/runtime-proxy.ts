/**
 * PROP-138 (Ф2, слайс 138b): host-side runtime-прокси для **out-of-process**
 * плагинов.
 *
 * ## Зачем
 *
 * Inline-плагин получает `ctx.runtime` прямо в процессе ядра
 * (`execution/plugin-runtime.ts` — узкая обёртка над портом исполнения
 * сессии). Плагин в отдельном процессе живого объекта не получает: по
 * проводу едут только сериализуемые DTO. Поэтому ход «плагин → команды и
 * файлы» нужно где-то развернуть: **хост поднимает loopback-прокси** и
 * отдаёт плагину его адрес и токен.
 *
 * ## Как
 *
 * - Прокси — обычный `node:http`-сервер на `127.0.0.1:0` (только loopback:
 *   наружу он не смотрит и в egress-политику не попадает).
 * - Аутентификация — **bearer-токен**, отдельный от инстансного
 *   `plugin-token`: у прокси свой токен на каждый процесс плагина (генерируется
 *   при старте процесса). Сравнение — постоянное по времени; значение токена
 *   не печатается в логах и не возвращается в ответах.
 * - **Привязка к invocation.** Прокси не выполняет команды «от имени плагина»
 *   вообще: у него есть реестр `invocation_id → поверхность исполнения`.
 *   Хост регистрирует привязку на время вызова точки `tools` и снимает её
 *   после. Запрос с незнакомым `invocation_id` → `404`: плагин не может
 *   выполнить команду «в чужом» вызове и не может остаться с привязкой
 *   после конца вызова.
 * - Операции идут **через тот же runtime**, что и в inline-контуре
 *   (`createPluginRuntime(port)`): маппинг «порт → exec/fs» дублировать не
 *  льзя — иначе inline и out-of-process поведут себя по-разному.
 *
 * ## Чего прокси НЕ делает
 *
 * - не обходит permission-слой: право на операцию решает хост по capability
 *   тула (ADR-029), а прокси только переносит уже разрешённое действие в
 *   контур исполнителя сессии;
 * - не даёт доступа к internals ядра: наружу уходят только DTO runtime'а;
 * - не выполняет команды от имени «процесса плагина» — только в рамках
 *   зарегистрированного invocation'а.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type { PluginRuntime } from '@itphx/synth-shared';
import { PLUGIN_RUNTIME_PATHS } from '@itphx/synth-shared';

import {
  createPluginRuntime,
  isPluginRuntimeError,
  PLUGIN_RUNTIME_DEFAULT_MAX_READ_BYTES,
} from '../../../execution/plugin-runtime.js';
import {
  isExecutionError,
  isExecutionFsUnavailableError,
  isExecutionPort,
  isFsPathError,
  type ExecutionPort,
} from '../../../execution/ports/index.js';

/**
 * Поверхность исполнения invocation'а.
 *
 * Либо сам порт сессии (`ExecutionPort` — тогда прокси строит runtime через
 * `createPluginRuntime`), либо уже готовый runtime-фасад (`PluginRuntime` —
 * его уже собрал хост в `narrowToolContext`). Оба пути дают **один и тот же**
 * набор операций, поэтому плагин не видит разницы.
 */
export type RuntimeInvocationTarget = ExecutionPort | PluginRuntime;

/**
 * Endpoint runtime'а, который хост отдаёт плагину и которым сам
 * пользуется для привязки invocation'ов.
 */
export interface PluginRuntimeEndpoint {
  /** Базовый адрес прокси (всегда `http://127.0.0.1:<port>`). */
  readonly url: string;
  /** Bearer-токен runtime (секрет: в логах и ответах не появляется). */
  readonly token: string;
  /** Привязать invocation к поверхности исполнения (идемпотентно). */
  registerInvocation(id: string, target: RuntimeInvocationTarget): void;
  /** Снять привязку (идемпотентно). */
  unregisterInvocation(id: string): void;
  /**
   * Остановить прокси (идемпотентно).
   *
   * Необязательное поле: у endpoint'а, который отдаётся наружу (плагину),
   * закрытия может не быть — закрывает владелец процесса.
   */
  close?(): Promise<void>;
}

/** Runtime-прокси хоста: endpoint + закрытие сервера. */
export interface RuntimeProxy extends PluginRuntimeEndpoint {
  /** Остановить сервер (идемпотентно). */
  close(): Promise<void>;
}

/** Опции runtime-прокси. */
export interface RuntimeProxyOptions {
  /** Bearer-токен runtime (генерируется на процесс плагина; не логируется). */
  token: string;
  /**
   * Резолвер поверхности исполнения по id invocation'а.
   *
   * Используется, когда привязка **не** зарегистрирована явно
   * ({@link RuntimeProxy.registerInvocation}) — например, если хост знает
   * порт по сессии и хочет решать привязку сам.
   */
  resolvePort?: (invocationId: string) => RuntimeInvocationTarget | undefined;
}

/**
 * Потолок тела запроса runtime-контура (байт).
 *
 * Чтение файла отдаётся в base64: файл в 16 МиБ (дефолт runtime'а) — это
 * ~21 МиБ base64 плюс JSON-обвязка. Потолок оставлен с запасом; файл
 * больше — отказ `413` (тело не читается целиком).
 */
export const PLUGIN_RUNTIME_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Жёсткий потолок чтения файла runtime-контуром (байт).
 *
 * Явный `max_bytes` из запроса не может превысить его: иначе плагин увёл бы
 * в control plane произвольный объём байт.
 */
export const PLUGIN_RUNTIME_MAX_READ_BYTES = 64 * 1024 * 1024;

/** Коды ошибок runtime-контура (машиночитаемые). */
export const PLUGIN_RUNTIME_ERROR_CODES = [
  /** Нет/неверный bearer-токен. */
  'unauthorized',
  /** Тело запроса невалидно (нет JSON, нет обязательных полей). */
  'invalid_request',
  /** Invocation не зарегистрирован (или уже снят). */
  'unknown_invocation',
  /** Внутренняя ошибка прокси. */
  'internal_error',
  /** Операция не поддерживается (например, `if_exists: 'fail'`). */
  'unsupported_option',
] as const;

/**
 * Создать runtime-прокси хоста.
 *
 * @param options — токен и (необязательно) резолвер поверхности исполнения.
 * @returns endpoint прокси (`url`/`token`/привязки) и `close()`.
 */
export async function createRuntimeProxy(options: RuntimeProxyOptions): Promise<RuntimeProxy> {
  const token = typeof options.token === 'string' ? options.token : '';
  if (token.trim().length === 0) {
    throw new Error('runtime-прокси плагина: токен не задан — сервер не поднимается (fail-closed).');
  }

  /** Реестр привязок: id invocation'а → поверхность исполнения. */
  const invocations = new Map<string, PluginRuntime>();

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, { token, invocations, resolvePort: options.resolvePort }).catch(
      () => {
        if (!res.writableEnded) {
          sendError(res, 500, 'internal_error', 'внутренняя ошибка runtime-прокси.');
        }
      },
    );
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => {
      rejectPromise(err);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolvePromise();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? 0;
  // Сервер не держит цикл событий: его останавливает владелец процесса.
  server.unref();

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      });
      invocations.clear();
    }
    return closePromise;
  };

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    registerInvocation(id: string, target: RuntimeInvocationTarget): void {
      const key = normalizeInvocationId(id);
      if (!key) return;
      invocations.set(key, toRuntime(target));
    },
    unregisterInvocation(id: string): void {
      const key = normalizeInvocationId(id);
      if (!key) return;
      invocations.delete(key);
    },
    close,
  };
}

// ── Обработка запроса ────────────────────────────────────────────────────

/** Контекст обработчика запроса. */
interface RequestContext {
  /** Токен runtime (сравнение — постоянное по времени). */
  token: string;
  /** Реестр привязок invocation'ов. */
  invocations: Map<string, PluginRuntime>;
  /** Резолвер поверхности исполнения (fallback). */
  resolvePort?: (invocationId: string) => RuntimeInvocationTarget | undefined;
}

/** Обработка одного запроса runtime-контура. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? '';

  if (req.method !== 'POST') {
    sendError(res, 405, 'invalid_request', 'runtime-контур принимает только POST.');
    return;
  }

  if (!hasValidToken(req, ctx.token)) {
    sendError(res, 401, 'unauthorized', 'нет или неверный токен runtime.');
    return;
  }

  const route = resolveRoute(path);
  if (!route) {
    sendError(res, 404, 'unknown_invocation', 'неизвестный путь runtime-контура.');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', describeError(err));
    return;
  }
  if (!isRecord(body)) {
    sendError(res, 400, 'invalid_request', 'тело запроса — не JSON-объект.');
    return;
  }

  const invocationId = typeof body.invocation_id === 'string' ? body.invocation_id.trim() : '';
  if (!invocationId) {
    sendError(res, 400, 'invalid_request', 'поле invocation_id обязательно.');
    return;
  }

  const runtime = ctx.invocations.get(invocationId) ?? resolveRuntime(ctx, invocationId);
  if (!runtime) {
    sendError(res, 404, 'unknown_invocation', 'invocation не зарегистрирован.');
    return;
  }

  try {
    const payload = await route(runtime, body);
    sendJson(res, 200, payload);
  } catch (err) {
    sendPortError(res, err, ctx.token);
  }
}

/** Обработчик пути runtime-контура. */
type RuntimeRoute = (
  runtime: PluginRuntime,
  body: Record<string, unknown>,
) => Promise<unknown>;

/** Соответствие пути и операции. */
function resolveRoute(path: string): RuntimeRoute | undefined {
  switch (path) {
    case PLUGIN_RUNTIME_PATHS.exec:
      return execRoute;
    case PLUGIN_RUNTIME_PATHS.fsRead:
      return fsReadRoute;
    case PLUGIN_RUNTIME_PATHS.fsWrite:
      return fsWriteRoute;
    case PLUGIN_RUNTIME_PATHS.fsStat:
      return fsStatRoute;
    case PLUGIN_RUNTIME_PATHS.fsReaddir:
      return fsReaddirRoute;
    case PLUGIN_RUNTIME_PATHS.fsRealpath:
      return fsRealpathRoute;
    default:
      return undefined;
  }
}

/** `POST /runtime/exec` — команда в контуре исполнителя сессии. */
async function execRoute(
  runtime: PluginRuntime,
  body: Record<string, unknown>,
): Promise<unknown> {
  const argv = body.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === 'string')) {
    throw new InvalidRuntimeRequest('argv должен быть непустым массивом строк.');
  }
  const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : undefined;
  const timeoutMs =
    typeof body.timeout_ms === 'number' && Number.isInteger(body.timeout_ms) && body.timeout_ms > 0
      ? body.timeout_ms
      : undefined;

  const result = await runtime.exec(argv as string[], {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode };
}

/** `POST /runtime/fs/read` — прочитать файл (base64). */
async function fsReadRoute(
  runtime: PluginRuntime,
  body: Record<string, unknown>,
): Promise<unknown> {
  const path = requirePath(body);
  const maxBytes = resolveMaxBytes(body.max_bytes);
  const data = await runtime.fs.readFile(path, maxBytes);
  return { data_base64: data.toString('base64') };
}

/** `POST /runtime/fs/write` — записать файл (base64). */
async function fsWriteRoute(
  runtime: PluginRuntime,
  body: Record<string, unknown>,
): Promise<unknown> {
  const path = requirePath(body);
  if (typeof body.data_base64 !== 'string') {
    throw new InvalidRuntimeRequest('поле data_base64 обязательно.');
  }
  const ifExists = body.if_exists;
  if (ifExists !== undefined && ifExists !== 'fail' && ifExists !== 'overwrite') {
    throw new InvalidRuntimeRequest(
      'поле if_exists: допустимы только fail|overwrite.',
    );
  }
  if (ifExists === 'fail') {
    // Inline-контур перезаписывает всегда (контракт `PluginRuntime.fs.writeFile`);
    // режима «не перезаписывать» в нём нет — придумывать другой semantics
    // для out-of-process нельзя, иначе плагин увидит разное поведение.
    throw new UnsupportedRuntimeOption(
      'if_exists=fail не поддерживается: runtime перезаписывает файл всегда (как в inline-контуре).',
    );
  }
  await runtime.fs.writeFile(path, Buffer.from(body.data_base64, 'base64'));
  return {};
}

/** `POST /runtime/fs/stat` — сведения о файле/каталоге. */
async function fsStatRoute(
  runtime: PluginRuntime,
  body: Record<string, unknown>,
): Promise<unknown> {
  const stat = await runtime.fs.stat(requirePath(body));
  return { kind: stat.kind, size: stat.size, mtime_ms: stat.mtimeMs };
}

/** `POST /runtime/fs/readdir` — записи каталога. */
async function fsReaddirRoute(
  runtime: PluginRuntime,
  body: Record<string, unknown>,
): Promise<unknown> {
  const entries = await runtime.fs.readdir(requirePath(body));
  return {
    entries: entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
    })),
  };
}

/** `POST /runtime/fs/realpath` — канонический путь. */
async function fsRealpathRoute(
  runtime: PluginRuntime,
  body: Record<string, unknown>,
): Promise<unknown> {
  return { path: await runtime.fs.realpath(requirePath(body)) };
}

// ── Вспомогательное ─────────────────────────────────────────────────────

/** Ошибка запроса (400). */
class InvalidRuntimeRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRuntimeRequest';
  }
}

/** Недопустимый режим операции (400). */
class UnsupportedRuntimeOption extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedRuntimeOption';
  }
}

/** Обязательный абсолютный путь из тела запроса. */
function requirePath(body: Record<string, unknown>): string {
  const path = body.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new InvalidRuntimeRequest('поле path обязательно.');
  }
  return path;
}

/** Потолок чтения: явный — в пределах жёсткого потолка, иначе дефолт runtime'а. */
function resolveMaxBytes(value: unknown): number {
  if (value === undefined) return PLUGIN_RUNTIME_DEFAULT_MAX_READ_BYTES;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new InvalidRuntimeRequest('поле max_bytes должно быть целым > 0.');
  }
  if ((value as number) > PLUGIN_RUNTIME_MAX_READ_BYTES) {
    throw new InvalidRuntimeRequest(
      `поле max_bytes превышает потолок ${PLUGIN_RUNTIME_MAX_READ_BYTES} байт.`,
    );
  }
  return value as number;
}

/** Поверхность исполнения → runtime-фасад (единая точка маппинга). */
function toRuntime(target: RuntimeInvocationTarget): PluginRuntime {
  if (isExecutionPort(target)) return createPluginRuntime(target);
  return target;
}

/** Поверхность исполнения по id invocation'а (явная привязка → резолвер). */
function resolveRuntime(ctx: RequestContext, invocationId: string): PluginRuntime | undefined {
  const explicit = ctx.invocations.get(invocationId);
  if (explicit) return explicit;
  const resolved = ctx.resolvePort?.(invocationId);
  return resolved ? toRuntime(resolved) : undefined;
}

/** Нормализованный id invocation'а (пустой — невалиден). */
function normalizeInvocationId(id: string): string {
  return typeof id === 'string' ? id.trim() : '';
}

/** Проверка bearer-токена (сравнение — постоянное по времени). */
function hasValidToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), token);
}

/** Сравнение строк за постоянное время ( unequal длины → false). */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf-8');
  const right = Buffer.from(b, 'utf-8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Тело запроса как JSON (с потолком размера). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > PLUGIN_RUNTIME_MAX_BODY_BYTES) {
      throw new InvalidRuntimeRequest('тело запроса слишком велико.');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.trim().length === 0) throw new InvalidRuntimeRequest('тело запроса пустое.');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidRuntimeRequest('тело запроса — не JSON.');
  }
}

/** Ответ JSON. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Ошибка прокси: `{ error: { code, message } }`. */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/**
 * Ошибка порта/рантайма → HTTP-статус и код.
 *
 * Коды FS-порта сохраняются как есть (`not_found`/`permission`/`too_large`/
 * `exists`/`invalid`/`unresolvable`), причины исполнения — как есть
 * (`nonzero_exit`/`timeout`/`spawn_failed`/`policy_denied`). Токен из текста
 * вырезается: значение секрета в ответе не появляется.
 */
function sendPortError(res: ServerResponse, err: unknown, token: string): void {
  if (err instanceof InvalidRuntimeRequest) {
    sendError(res, 400, 'invalid_request', redact(err.message, token));
    return;
  }
  if (err instanceof UnsupportedRuntimeOption) {
    sendError(res, 400, 'unsupported_option', redact(err.message, token));
    return;
  }
  if (isPluginRuntimeError(err)) {
    sendError(res, 400, err.code, redact(err.message, token));
    return;
  }
  if (isFsPathError(err)) {
    sendError(res, fsErrorStatus(err.code), err.code, redact(err.message, token));
    return;
  }
  if (isExecutionFsUnavailableError(err)) {
    sendError(res, 501, 'fs_unavailable', redact(err.message, token));
    return;
  }
  if (isExecutionError(err)) {
    const status = executionErrorStatus(err.reason);
    sendJson(res, status, {
      error: {
        code: err.reason,
        message: redact(err.message, token),
        stdout: err.stdout,
        stderr: err.stderr,
        exit_code: typeof err.code === 'number' ? err.code : undefined,
      },
    });
    return;
  }
  sendError(res, 500, 'internal_error', redact(describeError(err), token));
}

/** HTTP-статус по машинному коду FS-ошибки. */
function fsErrorStatus(code: string): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'permission':
      return 403;
    case 'exists':
      return 409;
    case 'too_large':
      return 413;
    default:
      return 400;
  }
}

/** HTTP-статус по причине неудачи исполнения. */
function executionErrorStatus(reason: string): number {
  switch (reason) {
    case 'timeout':
      return 504;
    case 'policy_denied':
      return 403;
    case 'dependency_missing':
      return 400;
    default:
      return 500;
  }
}

/** Текст ошибки (без стека). */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Вырезать значение токена из текста (секрет в ответе не появляется). */
function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('***') : text;
}

/** JSON-объект? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
