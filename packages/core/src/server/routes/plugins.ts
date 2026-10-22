/**
 * PROP-090 §«HTTP API», фаза Ф5б (часть 2): HTTP-контур управления плагинами —
 * `/api/v2/plugins*` (жизненный цикл) и `/api/v2/settings/plugins`
 * (runtime-настройки слоя).
 *
 * Фабрики общие для core (standalone) и backend (managed): RBAC и scope-гейты
 * задаются через `opts` (`readGuard`/`writeGuard`/`approveGuard`/
 * `uninstallGuard`), как у `/api/v2/packs` (`packs.ts`) — единый стиль
 * переиспользуемых роутов (ADR-017).
 *
 * ```text
 * GET    /plugins                — установленные + статус активации (runtime.list)
 * GET    /plugins/:name          — запись + манифест + PLUGIN_INTEGRITY.json
 * POST   /plugins/install        — установка из источника (dir/archive/npm/url)
 * POST   /plugins/:name/approve   — подтверждение карантина (202-установка)
 * POST   /plugins/:name/enable    — активация (гейты §10)
 * POST   /plugins/:name/disable   — деактивация (обратная прокрутка disposers)
 * POST   /plugins/:name/rollback  — откат на предыдущую версию (ступень lock)
 * POST   /plugins/update          — обновление из источника записи lock
 * DELETE /plugins/:name           — снятие по записи lock (идемпотентно)
 * ```
 *
 * **Обновление и откат (долги Д2).** `update` — явная операция: источник
 * берётся **из lock** (`npm`/`local`/`url`), «всегда latest» нет; совпадение
 * `content_hash` — `200 {outcome:'unchanged'}` (ничего не пишется). `rollback`
 * — возврат на сохранённую ступень `previous` (одна ступень, swap), без неё —
 * `409 plugin.rollback_unavailable`. Гейты у обновления те же, что у установки
 * (их выполняет `PluginInstaller`), доверие — из lock.
 *
 * **Источники установки (Д1).** `POST /install` принимает вид источника
 * (`source: 'dir'|'archive'|'npm'|'url'`) и соответствующую ссылку: `path`
 * (каталог/архив), `name`+`version` (npm), `url`+`sha256` (https-архив с
 * обязательным пином). Обратная совместимость: `{path}` без `source` — каталог,
 * `.tgz`/`.tar.gz` — архив. Метка источника в lock (`local`/`npm`/`url`)
 * **выводится** из резолвинга: клиент не может назвать источник произвольно.
 *
 * **Локальные и сетевые источники в managed.** В managed (`localInstall !== true`)
 * локальные (`dir`/`archive`) запрещены — `403 LOCAL_INSTALL_DISABLED`: иначе
 * ADMIN инстанса получил бы чтение произвольного каталога хоста через
 * установщик. Сетевые (`npm`/`url`) **разрешены** — это не локальный путь, а
 * доставка бандла из реестра/по URL с проверкой целостности (SRI/sha256).
 *
 * **Маппинг причин → HTTP** — единая таблица {@link PLUGIN_REASON_HTTP}. Причина
 * (`PluginAuditReason`) приходит из установщика/хоста и уже пишется в журнал
 * аудита плагинов; роут лишь переводит её в код ответа, чтобы клиент различал
 * «плохой запрос» (400), «политика/права» (403), «конфликт состояния» (409) и
 * «не найдено» (404).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import { catalogTrustLevelSchema, pluginsConfigSchema } from '@itphx/synth-shared';
import type { CatalogTrustLevel, PluginAuditReason, PluginsConfig } from '@itphx/synth-shared';

import { pluginInstalledDir } from '../../engine/plugins/layout.js';
import type { PluginRuntime } from '../../engine/plugins/runtime.js';
import {
  isPluginInstallSourceKind,
  isValidNpmPackageName,
} from '../../engine/plugins/sources.js';
import type {
  PluginInstallSourceKind,
  PluginSourceContext,
} from '../../engine/plugins/sources.js';
import type { PluginsRuntimeSettings } from '../../storage/runtime-settings.js';
import { mergePluginsConfig } from '../../storage/runtime-settings.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface PluginsRoutesAuth {
  requireAuth: Middleware;
}

/**
 * Порт runtime-настроек слоя плагинов (секция `RuntimeSettings.plugins`).
 *
 * Структурно совместим с `SettingsRepository` (ADR-096) — фабрике не нужен
 * весь порт, только три метода секции.
 */
export interface PluginSettingsStoreLike {
  getPlugins(): Promise<Partial<PluginsRuntimeSettings>>;
  setPlugins(config: Partial<PluginsRuntimeSettings>): Promise<void>;
  clearPlugins(): Promise<void>;
}

/** Зависимости фабрики жизненного цикла плагинов. */
export interface PluginsRoutesDeps {
  /** Рантайм плагинов (Ф5б-1): список, активация, установщик. */
  runtime: PluginRuntime;
  /**
   * Эффективный конфиг слоя плагинов (config.yaml + env) — `defaults` в
   * ответах настроек (см. {@link createPluginSettingsRoutes}).
   */
  config: PluginsConfig;
  /** Runtime-override настроек (`settings.json`/PG) — для `/settings/plugins`. */
  settings: PluginSettingsStoreLike;
  /** Текущий пользователь (actor) — для журнала аудита плагинов. */
  resolveUserId?: (c: Context) => string | undefined;
  /**
   * Разрешена ли установка из **локального** каталога/архива (`{path}`).
   * Standalone — `true`; managed — `false` (403 `LOCAL_INSTALL_DISABLED`).
   * Сетевые источники (`npm`/`url`) разрешены в обоих режимах.
   */
  localInstall?: boolean;
  /**
   * Инъекция контекста источников (сеть/лимиты скачивания) — тесты и
   * встраивание; по умолчанию источники используют `egressFetch` (ADR-099).
   */
  sourceContext?: PluginSourceContext;
}

/** Локализуемые сообщения (backend передаёт `t()`; core — русские литералы). */
export interface PluginsRouteMessages {
  notFound: (c: Context) => string;
  notActive: (c: Context) => string;
  invalidBody: (c: Context) => string;
  localInstallDisabled: (c: Context) => string;
  rollbackUnavailable: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface PluginsRoutesOptions {
  /** Guard чтения (список/деталь); по умолчанию `auth.requireAuth`. */
  readGuard?: Middleware;
  /** Guard установки/активации/деактивации; по умолчанию `auth.requireAuth`. */
  writeGuard?: Middleware;
  /** Guard подтверждения карантина (managed — только ADMIN). */
  approveGuard?: Middleware;
  /** Guard снятия (managed — только ADMIN). */
  uninstallGuard?: Middleware;
  messages?: Partial<PluginsRouteMessages>;
}

const DEFAULT_MESSAGES: PluginsRouteMessages = {
  notFound: () => 'Плагин не установлен',
  notActive: () => 'Плагин не активен',
  invalidBody: () => 'Некорректное тело запроса',
  localInstallDisabled: () =>
    'Установка из локального каталога или архива недоступна в этом режиме инстанса ' +
    '(managed: локальный путь с ФС хоста не принимается; сетевые источники npm/url разрешены)',
  rollbackUnavailable: () => 'Нет предыдущей версии для отката',
};

/** Имя файла манифеста (`synth.pack`, ADR-086 §5). */
const MANIFEST_FILE = 'synth.pack';

/** Служебный файл раскладки с хешем/провенансом (PROP-090 §5). */
const INTEGRITY_FILE = 'PLUGIN_INTEGRITY.json';

/**
 * Причина отказа установки/активации → HTTP-код (единая таблица).
 *
 * Таблица **исчерпывающая** (`Record<PluginAuditReason, number>`): новый код
 * причины в `PLUGIN_AUDIT_REASONS` не скомпилируется без осознанного выбора
 * кода ответа — иначе клиент получил бы «немой» 500.
 *
 * Семантика кодов:
 * - `400` — клиент прислал/привёз невалидный бандл (манифест, контракт, модуль);
 * - `403` — запрет политикой инстанса (trust-floor, allow/deny-списки,
 *   `runtimeInstall=deny`, выключенный слой/исполнение, fail-closed скан);
 * - `404` — нет записи lock (активировать/подтверждать нечего);
 * - `409` — конфликт состояния/содержимого: скан отклонил контент (это не
 *   «плохой запрос» — запрос корректен, опасен бандл), несовпадение хеша,
 *   гейт активации не пройден;
 * - `202` — требуется подтверждение владельца (install-policy `ask`);
 * - `200` — состояние уже достигнуто (повторная активация активного плагина);
 * - `500` — инфраструктурный отказ (загрузчик недоступен, сбой disposer'а).
 */
export const PLUGIN_REASON_HTTP: Record<PluginAuditReason, number> = {
  'plugin.not_found': 404,
  // Источник установки (Д1): по умолчанию «плохой запрос»; роут поднимает код
  // до **502** для сетевых источников (`npm`/`url`) — registry/сеть не отвечают.
  'plugin.source_unavailable': 400,
  // Откат (Д2): ступени `previous` нет или каталог предыдущей версии пропал —
  // состояние не изменилось, клиенту нужна установка, а не конфликт ввода.
  'plugin.rollback_unavailable': 409,
  'plugin.manifest_invalid': 400,
  'plugin.integrity_mismatch': 409,
  'plugin.integrity_unverifiable': 409,
  'plugin.contract_mismatch': 400,
  'plugin.host_mismatch': 400,
  'plugin.trust_below_floor': 403,
  'plugin.scan_rejected': 409,
  'plugin.approval_required': 202,
  'plugin.disabled': 403,
  'plugin.not_allowlisted': 403,
  'plugin.denylisted': 403,
  'plugin.runtime_install_denied': 403,
  'plugin.scan_disabled_with_execution': 403,
  'plugin.execution_disabled': 409,
  'plugin.loader_unavailable': 500,
  'plugin.module_invalid': 400,
  'plugin.already_active': 200,
  'plugin.not_active': 404,
  'plugin.disposer_failed': 500,
  'plugin.provides_mismatch': 400,
  // Причины журнала фильтров LLM-вызовов: к установке/активации не относятся
  // (пишутся из Gateway в журнал плагинов) — «плохой запрос» как безопасный дефолт.
  'plugin_filter.denied': 400,
  'plugin_filter.deny_downgraded': 400,
  'plugin_filter.unavailable': 400,
};

/**
 * Отказы активации, которые API отдаёт как **409** (PROP-090 §«HTTP API»):
 * гейт не пройден — состояние плагина не изменилось, клиенту нужно действие
 * владельца (включить исполнение, поднять доверие, подтвердить бандл).
 */
const ACTIVATION_GATE_REASONS: ReadonlySet<PluginAuditReason> = new Set<PluginAuditReason>([
  'plugin.execution_disabled',
  'plugin.trust_below_floor',
  'plugin.scan_rejected',
  'plugin.approval_required',
]);

/** HTTP-код причины отказа установки/подтверждения (не 2xx даже для `202`-кодов). */
export function httpStatusForRejection(reason: PluginAuditReason): number {
  const status = PLUGIN_REASON_HTTP[reason];
  // `plugin.approval_required` — не отказ установки, а её исход `202`; если
  // установщик всё же вернул его отказом, отдаём «плохой запрос».
  return status >= 400 ? status : 400;
}

/** Прочитать JSON-объект из каталога установки (`null` — нет/битый/не объект). */
async function readJsonObject(dir: string, file: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(join(dir, file), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Тело установки (сырое).
 *
 * `source` — **вид источника** (`dir`/`archive`/`npm`/`url`); при его
 * отсутствии вид выводится из заполненного поля (`path`/`name`/`url`).
 * Обратная совместимость: `{path}` без `source` — установка из каталога,
 * `{path}` с `.tgz`/`.tar.gz` — из архива. Метка источника в lock
 * (`local`/`npm`/`url`) теперь **выводится** из резолвинга, а не из тела:
 * клиент не может «назвать» чужой источник.
 */
interface PluginInstallBody {
  source?: unknown;
  path?: unknown;
  name?: unknown;
  version?: unknown;
  url?: unknown;
  sha256?: unknown;
  trustLevel?: unknown;
}

/** Разобранный запрос установки (вид источника + ссылка + pin). */
interface ParsedInstallRequest {
  kind: PluginInstallSourceKind;
  ref: string;
  version?: string;
  sha256?: string;
}

/** Разбор тела `/install`: успех либо текст ошибки валидации. */
type InstallBodyParseResult =
  | { ok: true; request: ParsedInstallRequest }
  | { ok: false; message: string };

/** Локальные источники (в managed запрещены: путь с ФС хоста). */
const LOCAL_SOURCE_KINDS: ReadonlySet<PluginInstallSourceKind> = new Set<PluginInstallSourceKind>([
  'dir',
  'archive',
]);

/** Расширение архива (`.tgz`/`.tar.gz`) — вывод вида источника из пути. */
const ARCHIVE_EXTENSION_REGEX = /\.(tgz|tar\.gz)$/i;

/** Непустая строка из поля тела (иначе `undefined`). */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Разобрать тело `POST /plugins/install` (fail-closed: неизвестный вид,
 * отсутствующее обязательное поле, не-npm имя, не-https URL, URL без pin —
 * отказ до любого сетевого вызова).
 */
function parseInstallBody(body: PluginInstallBody): InstallBodyParseResult {
  const rawSource = body.source;
  const explicitKind = isPluginInstallSourceKind(rawSource) ? rawSource : undefined;
  if (typeof rawSource === 'string' && rawSource.trim() && !explicitKind) {
    return {
      ok: false,
      message:
        `неизвестный вид источника «${rawSource}»: ожидается ` +
        'dir|archive|npm|url (метка источника в lock выводится автоматически)',
    };
  }

  const path = optionalString(body.path);
  const name = optionalString(body.name);
  const url = optionalString(body.url);
  const version = optionalString(body.version);
  const sha256 = optionalString(body.sha256)?.toLowerCase();

  let kind: PluginInstallSourceKind | undefined = explicitKind;
  if (!kind) {
    if (path) kind = ARCHIVE_EXTENSION_REGEX.test(path) ? 'archive' : 'dir';
    else if (name) kind = 'npm';
    else if (url) kind = 'url';
  }
  if (!kind) {
    return {
      ok: false,
      message: 'нужно указать "path" (каталог/архив), "name" (npm) или "url", либо "source"',
    };
  }

  switch (kind) {
    case 'dir':
    case 'archive': {
      if (!path) return { ok: false, message: `для source="${kind}" поле "path" обязательно` };
      return { ok: true, request: { kind, ref: path } };
    }
    case 'npm': {
      if (!name) return { ok: false, message: 'для source="npm" поле "name" обязательно' };
      if (!isValidNpmPackageName(name)) {
        return {
          ok: false,
          message: `"name" — npm-имя пакета (name или @scope/name), получено «${name}»`,
        };
      }
      return { ok: true, request: { kind, ref: name, ...(version ? { version } : {}) } };
    }
    case 'url': {
      if (!url) return { ok: false, message: 'для source="url" поле "url" обязательно' };
      if (!/^https:\/\//i.test(url)) {
        return { ok: false, message: '"url" — только https-адрес архива' };
      }
      if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
        return {
          ok: false,
          message: 'для source="url" обязателен pin "sha256" (64 hex-символа)',
        };
      }
      return { ok: true, request: { kind, ref: url, sha256 } };
    }
  }
}

/**
 * Фабрика роутов жизненного цикла плагинов (`/api/v2/plugins*`).
 *
 * Ошибки — `{ error: { code, message } }`: `code` — машиночитаемая причина
 * (`plugin.*` из журнала аудита) либо общий код (`VALIDATION_ERROR`,
 * `NOT_FOUND`, `CONFLICT`, `NOT_IMPLEMENTED`, `LOCAL_INSTALL_DISABLED`).
 */
export function createPluginsRoutes(
  auth: PluginsRoutesAuth,
  deps: PluginsRoutesDeps,
  opts: PluginsRoutesOptions = {},
): Hono {
  const app = new Hono();
  const messages: PluginsRouteMessages = { ...DEFAULT_MESSAGES, ...opts.messages };
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const approveGuard: Middleware = opts.approveGuard ?? auth.requireAuth;
  const uninstallGuard: Middleware = opts.uninstallGuard ?? auth.requireAuth;

  /** Актор операции для журнала аудита (`userId` API/UI, иначе `api`). */
  const actorOf = (c: Context): string => deps.resolveUserId?.(c) ?? 'api';

  /** Запись реестра по имени (`undefined` — нет в lock). */
  const findEntry = async (name: string) => {
    const entries = await deps.runtime.list();
    return entries.find((entry) => entry.name === name);
  };

  // GET /api/v2/plugins — установленные плагины и статус активации.
  app.get('/', readGuard, async (c) => {
    const plugins = await deps.runtime.list();
    return c.json({ plugins });
  });

  // POST /api/v2/plugins/install — установка из источника (dir/archive/npm/url).
  // Объявлен до `/:name`-маршрутов: `/install` — статический сегмент.
  app.post('/install', writeGuard, async (c) => {
    const rawBody = (await c.req.json().catch(() => ({}))) as unknown;
    // Тело — только объект: `null`/массив/скаляр не должны ронять обработчик.
    const body: PluginInstallBody =
      typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)
        ? (rawBody as PluginInstallBody)
        : {};

    const parsed = parseInstallBody(body);
    if (!parsed.ok) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `${messages.invalidBody(c)}: ${parsed.message}` } },
        400,
      );
    }
    const install = parsed.request;

    // Локальные источники (`dir`/`archive`) в managed запрещены: путь с ФС
    // хоста через установщик — чтение произвольного каталога. Сетевые
    // (`npm`/`url`) разрешены: это не локальный путь (PROP-090 §«Источники»).
    if (LOCAL_SOURCE_KINDS.has(install.kind) && deps.localInstall !== true) {
      return c.json(
        { error: { code: 'LOCAL_INSTALL_DISABLED', message: messages.localInstallDisabled(c) } },
        403,
      );
    }

    // Уровень доверия: дефолт `community` (fail-closed — ниже любого trust-floor,
    // устанавливается только если инстанс явно снизил порог).
    const trustParsed = catalogTrustLevelSchema.safeParse(body.trustLevel ?? 'community');
    if (!trustParsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `${messages.invalidBody(c)}: "trustLevel" — одно из ${catalogTrustLevelSchema.options.join('|')}`,
          },
        },
        400,
      );
    }
    const trustLevel: CatalogTrustLevel = trustParsed.data;

    const outcome = await deps.runtime.installer.installFromSource({
      ...install,
      trustLevel,
      actor: actorOf(c),
      ...(deps.sourceContext ? { sourceContext: deps.sourceContext } : {}),
    });

    if (outcome.outcome === 'installed') return c.json(outcome, 201);
    if (outcome.outcome === 'approval_required') {
      return c.json(
        {
          outcome: outcome.outcome,
          name: outcome.name,
          version: outcome.version,
          reason: outcome.reason,
        },
        202,
      );
    }
    // Сетевой источник недоступен — 502 (сбой upstream), локальный — 400
    // (неверный путь/архив). Остальные причины — по общей таблице.
    const status =
      outcome.reason === 'plugin.source_unavailable' && !LOCAL_SOURCE_KINDS.has(install.kind)
        ? 502
        : httpStatusForRejection(outcome.reason);
    return c.json(
      { error: { code: outcome.reason, message: outcome.message } },
      status as 400,
    );
  });

  // POST /api/v2/plugins/update — обновление из источника записи lock (Д2).
  // Тело: `{name, version?, sha256?, activate?}`. Источник клиентом не
  // выбирается (провенанс берётся из lock); `sha256` обязателен для `url`.
  app.post('/update', writeGuard, async (c) => {
    const rawBody = (await c.req.json().catch(() => ({}))) as unknown;
    const body: Record<string, unknown> =
      typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>)
        : {};

    const name = optionalString(body.name);
    if (!name) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `${messages.invalidBody(c)}: поле "name" обязательно` } },
        400,
      );
    }
    const sha256 = optionalString(body.sha256)?.toLowerCase();
    if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `${messages.invalidBody(c)}: "sha256" — 64 hex-символа`,
          },
        },
        400,
      );
    }
    const version = optionalString(body.version);
    const activate = typeof body.activate === 'boolean' ? body.activate : undefined;

    // Managed: обновление плагина, установленного с локального пути, невозможно
    // (локальные файлы инстанса не являются источником для control plane) —
    // тот же отказ, что у `install` (`localInstall: false`), а не «источник
    // недоступен»: причина — политика, а не сбой источника.
    if (deps.localInstall === false) {
      const existing = await findEntry(name);
      if (existing?.source === 'local') {
        return c.json(
          { error: { code: 'LOCAL_INSTALL_DISABLED', message: messages.localInstallDisabled(c) } },
          403,
        );
      }
    }

    const outcome = await deps.runtime.installer.update(name, {
      ...(version ? { version } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(activate !== undefined ? { activate } : {}),
      actor: actorOf(c),
      ...(deps.sourceContext ? { sourceContext: deps.sourceContext } : {}),
    });

    if (outcome.outcome === 'unchanged' || outcome.outcome === 'updated') {
      return c.json(outcome);
    }

    // Сетевой источник недоступен — 502 (сбой upstream), локальный — 400.
    // Запись lock остаётся прежней, поэтому источник известен по ней.
    const current = await findEntry(name);
    const status =
      outcome.reason === 'plugin.source_unavailable'
        ? current?.source === 'local'
          ? 400
          : 502
        : // `approval_required` — не отказ ввода: бандл ушёл в карантин,
          // состояние требует подтверждения владельца (как у активации).
          outcome.reason === 'plugin.approval_required'
          ? 409
          : httpStatusForRejection(outcome.reason);
    return c.json({ error: { code: outcome.reason, message: outcome.message } }, status as 400);
  });

  // GET /api/v2/plugins/:name — деталь: запись lock + манифест + целостность.
  app.get('/:name', readGuard, async (c) => {
    const name = c.req.param('name');
    const entry = await findEntry(name);
    if (!entry) {
      return c.json({ error: { code: 'plugin.not_found', message: messages.notFound(c) } }, 404);
    }

    // Каталог установки: `installed/<name>@<version>/`. Манифест/целостность
    // читаются best-effort: их отсутствие или порча — не 500 (запись lock
    // остаётся валидной, деталь просто без этих полей).
    const dir = pluginInstalledDir(deps.runtime.layout, entry.name, entry.version);
    const manifest = await readJsonObject(dir, MANIFEST_FILE);
    const integrity = await readJsonObject(dir, INTEGRITY_FILE);

    return c.json({
      plugin: entry,
      ...(manifest ? { manifest } : {}),
      ...(integrity ? { integrity } : {}),
    });
  });

  // POST /api/v2/plugins/:name/approve — подтверждение бандла из карантина.
  app.post('/:name/approve', approveGuard, async (c) => {
    const name = c.req.param('name');
    const outcome = await deps.runtime.installer.approve(name, { actor: actorOf(c) });

    if (outcome.outcome === 'installed') return c.json(outcome);
    if (outcome.outcome === 'approval_required') {
      return c.json(
        {
          outcome: outcome.outcome,
          name: outcome.name,
          version: outcome.version,
          reason: outcome.reason,
        },
        202,
      );
    }
    return c.json(
      { error: { code: outcome.reason, message: outcome.message } },
      httpStatusForRejection(outcome.reason) as 400,
    );
  });

  // POST /api/v2/plugins/:name/enable — активация установленного плагина.
  app.post('/:name/enable', writeGuard, async (c) => {
    const name = c.req.param('name');
    const activation = await deps.runtime.activate(name, { actor: actorOf(c) });

    if (activation.outcome === 'rejected' && activation.reason) {
      // Нет записи lock — «активировать нечего» (404), а не конфликт.
      if (activation.reason === 'plugin.not_found') {
        return c.json(
          { error: { code: activation.reason, message: activation.message ?? messages.notFound(c) } },
          404,
        );
      }
      // Отказ по гейту — 409 с причиной (клиенту нужно действие владельца).
      if (ACTIVATION_GATE_REASONS.has(activation.reason)) {
        return c.json(
          {
            error: {
              code: activation.reason,
              message: activation.message ?? messages.invalidBody(c),
            },
            activation,
          },
          409,
        );
      }
    }
    // Прочие отказы (`plugin.already_active`, `plugin.module_invalid`, …) —
    // 200 с результатом активации: состояние плагина известно клиенту из тела.
    return c.json({ activation });
  });

  // POST /api/v2/plugins/:name/rollback — откат на предыдущую версию (Д2).
  // Ступень `previous` — одна; откат обратим (повторный откат вернёт обратно).
  app.post('/:name/rollback', writeGuard, async (c) => {
    const name = c.req.param('name');
    const outcome = await deps.runtime.installer.rollback(name, { actor: actorOf(c) });
    if (outcome.outcome === 'rolled_back') return c.json(outcome);

    const status =
      outcome.reason === 'plugin.rollback_unavailable'
        ? 409
        : httpStatusForRejection(outcome.reason);
    const message =
      outcome.reason === 'plugin.rollback_unavailable' &&
      !outcome.message.trim()
        ? messages.rollbackUnavailable(c)
        : outcome.message;
    return c.json({ error: { code: outcome.reason, message } }, status as 400);
  });

  // POST /api/v2/plugins/:name/disable — деактивация (идемпотентности нет:
  // повторный disable неактивного — 404 `plugin.not_active`, так в спеке).
  app.post('/:name/disable', writeGuard, async (c) => {
    const name = c.req.param('name');
    const deactivation = await deps.runtime.deactivate(name, { actor: actorOf(c) });
    if (deactivation.outcome === 'rejected') {
      return c.json(
        { error: { code: 'plugin.not_active', message: deactivation.message ?? messages.notActive(c) } },
        404,
      );
    }
    return c.json({ deactivation });
  });

  // DELETE /api/v2/plugins/:name — снятие по записи lock. Идемпотентно:
  // нет записи — тоже 204 (снимать нечего).
  app.delete('/:name', uninstallGuard, async (c) => {
    await deps.runtime.installer.uninstall(c.req.param('name'), { actor: actorOf(c) });
    return c.body(null, 204);
  });

  return app;
}

// ── Runtime-настройки слоя плагинов ─────────────────────────────────────────

/** Зависимости фабрики настроек (подмножество {@link PluginsRoutesDeps}). */
export type PluginSettingsRoutesDeps = Pick<PluginsRoutesDeps, 'config' | 'settings'> & {
  /**
   * Конфиг, с которым **стартовал** процесс (эффективные значения на момент
   * сборки рантайма плагинов) — поле `running` в ответе. Не задан — считается
   * равным `config` (runtime-переопределений нет).
   */
  running?: PluginsConfig;
  /**
   * Колбэк применения **живых** ключей после успешной записи/сброса
   * (PROP-090, долги Д3): `promptBlockMaxChars` и `llmFilterTimeoutMs`
   * применяются без рестарта (эффективные значения — после слияния config +
   * runtime). Остальные ключи (`executionEnabled`, `trustFloor`, `scan`, …)
   * действуют только после перезапуска (инвариант 24) — см. `restartRequired`.
   */
  onPluginsChange?: (effective: PluginsConfig) => void;
};

/** Опции фабрики настроек. */
export interface PluginSettingsRoutesOptions {
  /** Guard чтения; по умолчанию `auth.requireAuth`. */
  readGuard?: Middleware;
  /** Guard мутаций; по умолчанию `auth.requireAuth`. */
  writeGuard?: Middleware;
  messages?: {
    invalidSettings?: (c: Context) => string;
  };
}

const DEFAULT_INVALID_SETTINGS = 'plugins: некорректные runtime-настройки слоя плагинов';

/**
 * Схема тела `PUT /api/v2/settings/plugins`: частичный патч секции `plugins`.
 *
 * Строится из `pluginsConfigSchema` (shared) через `.partial()` — набор ключей
 * и правила значений не дублируются; `.strict()` — неизвестный ключ это 400
 * (опечатка в имени политики не должна «тихо» игнорироваться: админ решил бы,
 * что ограничение включено).
 */
export const pluginsSettingsPatchSchema = pluginsConfigSchema.partial().strict();

/** Снимок настроек слоя плагинов (ответ GET/PUT/DELETE). */
interface PluginsSettingsView {
  plugins: Partial<PluginsRuntimeSettings>;
  defaults: PluginsConfig;
  isOverridden: boolean;
  /** Всегда `true`: рантайм плагинов и хост собираются при старте (инвариант 24). */
  restartRequired: boolean;
  running: PluginsConfig;
}

/**
 * Фабрика роутов `/api/v2/settings/plugins` — runtime-настройки слоя плагинов
 * (PROP-090 §10).
 *
 * **`restartRequired` — всегда `true`** (важное отличие от прочих настроек):
 * `PluginRuntime`/`PluginHost` и политика install-policy собираются при старте
 * процесса, а переинициализация процесс-глобальных singleton'ов «на лету»
 * запрещена (инвариант 24, ADR-092 п. 7) — изменения применяются после
 * перезапуска инстанса. Ответ поэтому не сравнивает `saved` с `running`
 * (как `metrics`), а честно сообщает: применяется рестартом.
 */
export function createPluginSettingsRoutes(
  auth: PluginsRoutesAuth,
  deps: PluginSettingsRoutesDeps,
  opts: PluginSettingsRoutesOptions = {},
): Hono {
  const app = new Hono();
  const readGuard: Middleware = opts.readGuard ?? auth.requireAuth;
  const writeGuard: Middleware = opts.writeGuard ?? auth.requireAuth;
  const invalidSettings = opts.messages?.invalidSettings ?? (() => DEFAULT_INVALID_SETTINGS);

  /** Снимок: runtime-override, дефолты из config, признак override, running. */
  const buildView = async (): Promise<PluginsSettingsView> => {
    const runtime = await deps.settings.getPlugins();
    return {
      plugins: runtime,
      defaults: deps.config,
      isOverridden: Object.keys(runtime).length > 0,
      // Инвариант 24: рантайм плагинов собирается при старте — только рестарт.
      restartRequired: true,
      running: deps.running ?? deps.config,
    };
  };

  app.get('/plugins', readGuard, async (c) => c.json(await buildView()));

  app.put('/plugins', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = pluginsSettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') ?? '';
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `${invalidSettings(c)}${path ? ` (${path})` : ''}: ${first?.message ?? 'ошибка валидации'}`,
          },
        },
        400,
      );
    }
    await deps.settings.setPlugins(parsed.data as Partial<PluginsRuntimeSettings>);
    // Долги Д3: живые ключи (бюджеты) применяются сразу — остальные ждут рестарта.
    deps.onPluginsChange?.(
      mergePluginsConfig(deps.config, parsed.data as Partial<PluginsRuntimeSettings>),
    );
    return c.json(await buildView());
  });

  app.delete('/plugins', writeGuard, async (c) => {
    await deps.settings.clearPlugins();
    deps.onPluginsChange?.(deps.config);
    return c.json(await buildView());
  });

  return app;
}
