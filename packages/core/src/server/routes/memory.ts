/**
 * ADR-107 / PROP-047 §2.1: **портал памяти в ядре** — HTTP-контур чтения
 * поверх доменных портов памяти (`MemoryFactRepository`/`MemoryIndexRepository`,
 * ADR-096).
 *
 * Ядро владеет данными памяти, плагин — логикой (PROP-047 §3). Поэтому портал
 * (и операции провайдера) живут в ядре: `createMemoryRoutes` — единая фабрика
 * для standalone-core и managed-backend; backend добавляет только RBAC через
 * `opts.guard`.
 *
 * ## Контракт
 *
 * | Метод | Путь | Ответ |
 * |---|---|---|
 * | GET | `/status` | `{provider:{id,mode,active}, readiness, namespace, facts:{total,active}, indexes:{total,ready,stale,failed,building}}` |
 * | GET | `/facts` | `{items, total, limit, offset}` — записи `MemoryFactRecord` как есть |
 * | GET | `/facts/:id` | запись `MemoryFactRecord` либо 404 `MEMORY_FACT_NOT_FOUND` |
 * | GET | `/indexes` | `{items, total}` — записи `MemoryIndexRecord` (без чанков) |
 * | POST | `/indexes` | 202 `{index, message}` — индекс создан (запись из порта) |
 * | POST | `/indexes/:id/rebuild` | 202 `{index}` — пересборка запущена |
 * | DELETE | `/indexes/:id` | 204 — индекс удалён |
 * | POST | `/consolidate` | 200 `{report, message}` — отчёт консолидации фактов |
 *
 * ## Правила
 *
 * - **Namespace подставляет сервер**: `plugin:synth-plugin-memory` — клиент не
 *   может его подменить (параметр `namespace` в query игнорируется). Портал
 *   показывает память плагина памяти, а не чужих поставщиков;
 * - **счётчики — через порты**: `total`/`active` — `count` порта фактов, а не
 *   длина выборки (пагинация не должна ломать счётчик);
 * - **текстовый поиск — в памяти**: порт не умеет искать по тексту, поэтому
 *   `query` фильтрует подстроку по уже выбранной выборке (регистронезависимо).
 *   Полнотекстовый поиск — М2 (ADR/PROP-047), здесь его достаточно для портала;
 * - **портов нет — 503**: `MEMORY_UNAVAILABLE`, а не падение (деградация вместо
 *   500). `/status` при этом отвечает 200 с `readiness: 'unavailable'` — портал
 *   должен уметь показать «память недоступна».
 *
 * ## Мутации индексов: портал → админ-тул плагина
 *
 * Логика индекса принадлежит **плагину** (PROP-047 §3: ядро владеет данными,
 * плагин — логикой), поэтому портал не пишет в порт индексов напрямую:
 * он проверяет границы (проект, workspace, доступность провайдера) и вызывает
 * **админ-тул плагина** через реестр тулов (`opts.invokeTool` → `executeToolDef`,
 * ADR-090). Тул — единственный владелец логики индекса; портал отвечает за
 * HTTP-контракт и права.
 *
 * - **guard — тот же**, что у чтения (managed — ADMIN);
 * - **проект обязателен** для создания индекса: индекс файлов строится в
 *   проекте (`MEMORY_PROJECT_REQUIRED`), проект не найден — `PROJECT_NOT_FOUND`,
 *   у проекта нет `workspace` (источник `files`) — `MEMORY_WORKSPACE_REQUIRED`;
 * - **провайдер недоступен** (тул не зарегистрирован или плагин не активен) —
 *   `409 MEMORY_PROVIDER_UNAVAILABLE`; чтение при этом работает как раньше;
 * - **провал тула** (`isError`) — `422 MEMORY_INDEX_FAILED` с текстом из
 *   `content` (внутренние пути замаскированы).
 *
 * ## Консолидация фактов: портал → админ-тул плагина
 *
 * Консолидация (PROP-047 §2.1, ADR-107) — тоже **логика плагина**: кластеризация
 * фактов по косинусу, выбор канона в кластере и замена дубликатов. Портал
 * отвечает только за границы и HTTP-контракт, поэтому консолидация устроена
 * так же, как мутации индексов: вызов **админ-тула плагина**
 * `plugin_synth_plugin_memory_memory_consolidate` через `opts.invokeTool`.
 *
 * - **операция синхронная** — ответ 200 с отчётом (не 202: фоновая сборка
 *   индекса — другое дело);
 * - **проект опционален**: без `projectId` консолидируются факты инстанса;
 *   с `projectId` — факты проекта (нет проекта → 404 `PROJECT_NOT_FOUND`);
 * - **workspace не нужен**: консолидация работает по фактам, а не по файлам —
 *   рабочий каталог вызова = workspace проекта, если он есть, иначе каталог
 *   данных инстанса;
 * - **порог кластеризации** (`threshold`) — 0.5..0.99, вне диапазона →
 *   400 `VALIDATION_ERROR`;
 * - **провал тула** (`isError`) — 422 `MEMORY_CONSOLIDATION_FAILED` с текстом
 *   из `content` (пути замаскированы); код тула (`metadata.code`, напр.
 *   `plugin.embedding_not_configured`) пробрасывается в `error.details.code`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { ToolResult } from '@itphx/synth-shared';
import { pluginToolFullName } from '@itphx/synth-shared';
import type {
  MemoryFactQuery,
  MemoryFactRecord,
  MemoryFactRepository,
  MemoryFactStatus,
} from '../../storage/ports/memory-fact-repository.js';
import type {
  MemoryIndexQuery,
  MemoryIndexRecord,
  MemoryIndexRepository,
  MemoryIndexState,
} from '../../storage/ports/memory-index-repository.js';
import {
  MEMORY_NAMESPACE,
  MEMORY_PLUGIN_NAME,
} from '../../engine/plugins/memory-namespace.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на createMiddleware). */
type Middleware = ReturnType<typeof createMiddleware>;

/**
 * Имя плагина памяти и namespace его памяти.
 *
 * Объявлены в нейтральном модуле `engine/plugins/memory-namespace.ts`
 * (ими пользуется и коллектор метрик — HTTP-слой от него не зависит), но
 * реэкспортируются здесь: публичный API ядра (`src/index.ts`) и потребители
 * (`mount-routes.ts`) продолжают брать их отсюда.
 */
export { MEMORY_NAMESPACE, MEMORY_PLUGIN_NAME };

/**
 * Полное имя админ-тула плагина памяти в реестре тулов (ADR-090).
 *
 * Имя составляет **хост** (`plugin_<ns>_<tool>`) — тот же хелпер, что и у
 * регистрации плагинных тулов (`shared/types/plugin-tools.ts`).
 */
export const MEMORY_INDEX_TOOL_NAME = pluginToolFullName(MEMORY_PLUGIN_NAME, 'memory_index');

/**
 * Полное имя админ-тула плагина памяти для консолидации фактов (ADR-090).
 *
 * Консолидация — тоже логика плагина (PROP-047 §2.1): кластеры по косинусу,
 * канон в кластере, замена дубликатов. Хост составляет имя тем же
 * хелпером, что и у `memory_index`.
 */
export const MEMORY_CONSOLIDATE_TOOL_NAME = pluginToolFullName(
  MEMORY_PLUGIN_NAME,
  'memory_consolidate',
);

/** Вид источника корпуса индекса, который принимает портал. */
export type MemoryIndexSourceKind = 'files' | 'facts';

/**
 * Проект — как его видит портал памяти (минимум для мутаций индексов).
 *
 * `workspace` — **абсолютный** путь рабочего каталога (относительный путь
 * резолвит вызывающая сторона, ADR-075); не задан — у проекта нет workspace.
 */
export interface MemoryPortalProject {
  /** Id проекта. */
  id: string;
  /** Абсолютный рабочий каталог проекта (если задан). */
  workspace?: string;
}

/** Вход вызова админ-тула плагина памяти. */
export interface MemoryToolInvokeInput {
  /** Полное имя тула в реестре (`plugin_synth_plugin_memory_memory_index`). */
  tool: string;
  /**
   * Параметры тула.
   *
   * - `memory_index`: `action`/`indexId`/`name`/`source`/`projectId`/`force`;
   * - `memory_consolidate`: `projectId?`/`threshold?`/`dryRun?`.
   */
  params: Record<string, unknown>;
  /** Проект-владелец индекса или консолидации (если есть). */
  projectId?: string;
  /** Рабочий каталог вызова (workspace проекта либо каталог данных). */
  workingDir: string;
}

/**
 * Вызов админ-тула плагина памяти (реализует вызывающая сторона — mount-routes).
 *
 * Результат — `ToolResult`: `content` — текст, `isError` — ошибка тула,
 * `metadata` — `{indexId?, state?, generation?, stats?}` (индекс) или
 * `{clusters?, superseded?, kept?, items?}` (консолидация).
 */
export type MemoryToolInvoker = (input: MemoryToolInvokeInput) => Promise<ToolResult>;

/**
 * Провайдер памяти недоступен: тул плагина не зарегистрирован в реестре.
 *
 * Вызывающая сторона бросает его, когда тула нет в `ToolRegistry`; портал
 * отвечает 409 `MEMORY_PROVIDER_UNAVAILABLE`, а не 500.
 */
export class MemoryProviderUnavailableError extends Error {
  constructor(tool?: string) {
    super(tool ? `Тул памяти не зарегистрирован: ${tool}` : 'Провайдер памяти недоступен');
    this.name = 'MemoryProviderUnavailableError';
  }
}

/**
 * Маскирование внутренних путей в тексте ошибки тула.
 *
 * Наружу отдаются только плейсхолдеры: каталог данных инстанса → `<data>`,
 * рабочий каталог → `<workspace>`. Внутренние пути хоста не должны утекать
 * через портал.
 */
function redactInternalPaths(text: string, workingDir: string, dataDir?: string): string {
  if (!text) return '';
  let out = text;
  const mask = (value: string | undefined, placeholder: string): void => {
    if (!value) return;
    const trimmed = value.replace(/[/\\]+$/, '');
    if (!trimmed || trimmed === '/' || trimmed === '\\') return;
    out = out.split(trimmed).join(placeholder);
  };
  // Сначала — каталог данных (он шире рабочего каталога), затем — workspace.
  mask(dataDir, '<data>');
  if (workingDir !== dataDir) mask(workingDir, '<workspace>');
  return out;
}

/** Статусы факта, допустимые в фильтре `status` (плюс `all` — без фильтра). */
export const MEMORY_FACT_STATUSES: readonly MemoryFactStatus[] = [
  'candidate',
  'active',
  'superseded',
  'retracted',
];

/** Состояния индекса, допустимые в фильтре `state` (плюс `all` — без фильтра). */
export const MEMORY_INDEX_STATES: readonly MemoryIndexState[] = [
  'building',
  'ready',
  'stale',
  'failed',
];

/** Фильтр статуса факта: конкретный статус или `all` (без фильтра). */
export type MemoryFactStatusFilter = MemoryFactStatus | 'all';

/** Фильтр состояния индекса: конкретное состояние или `all` (без фильтра). */
export type MemoryIndexStateFilter = MemoryIndexState | 'all';

/**
 * Готовность сервиса памяти для портала.
 *
 * `ready` — сервис доступен и нет проблемных индексов; `degraded` — есть
 * индексы `failed`/`stale` (нужна пересборка); `unavailable` — порт памяти не
 * сконфигурирован.
 */
export type MemoryPortalReadiness = 'ready' | 'degraded' | 'unavailable';

/** Минимальный auth-контракт фабрики: в core и backend общий (структурно). */
export interface MemoryRoutesAuth {
  requireAuth: Middleware;
}

/** Локализуемые сообщения: backend передаёт `t()`, core — русские литералы. */
export interface MemoryRouteMessages {
  invalidStatus: (c: Context) => string;
  invalidState: (c: Context) => string;
  invalidLimit: (c: Context) => string;
  invalidOffset: (c: Context) => string;
  factNotFound: (c: Context) => string;
  unavailable: (c: Context) => string;
  /** Некорректное тело запроса мутации. */
  invalidBody: (c: Context) => string;
  /** Некорректный вид источника индекса. */
  invalidSource: (c: Context) => string;
  /** Не указан проект (индекс файлов строится в проекте). */
  projectRequired: (c: Context) => string;
  /** Проект не найден. */
  projectNotFound: (c: Context) => string;
  /** У проекта нет рабочего каталога. */
  workspaceRequired: (c: Context) => string;
  /** Плагин памяти не активен либо его тул не зарегистрирован. */
  providerUnavailable: (c: Context) => string;
  /** Индекс памяти не найден. */
  indexNotFound: (c: Context) => string;
  /** Операция с индексом не удалась (текст — из ответа тула). */
  indexFailed: (c: Context) => string;
  /** Сообщение об успешном создании индекса. */
  indexCreated: (c: Context) => string;
  /** Некорректный порог консолидации (вне 0.5..0.99). */
  invalidThreshold: (c: Context) => string;
  /** Консолидация памяти не удалась (текст — из ответа тула). */
  consolidationFailed: (c: Context) => string;
  /** Сообщение об успешной консолидации. */
  consolidated: (c: Context) => string;
}

/** Порты памяти инстанса (ADR-096) — источник истины для портала. */
export interface MemoryRoutesPorts {
  /** Порт фактов памяти. */
  facts?: MemoryFactRepository;
  /** Порт индексов памяти. */
  indexes?: MemoryIndexRepository;
}

/** Опции фабрики: порты, guard'ы и сообщения. */
export interface MemoryRoutesOptions {
  /**
   * Порты памяти инстанса. Не заданы — контур отвечает 503
   * `MEMORY_UNAVAILABLE` (деградация, а не падение).
   */
  memory?: MemoryRoutesPorts;
  /**
   * Guard чтения (все эндпоинты — только чтение). По умолчанию —
   * `auth.requireAuth` (core, standalone). Managed backend передаёт
   * `requirePermission('ADMIN')` — портал админский.
   */
  guard?: Middleware;
  /** Переопределение сообщений (backend — i18n). */
  messages?: Partial<MemoryRouteMessages>;
  /**
   * Активен ли плагин памяти в текущем процессе.
   *
   * Источник — реестр активаций хоста плагинов (`PluginHost.isActive`).
   * Не задан — `active: false`, `mode: null` (портал работает и без плагина:
   * данные могли остаться от прошлой установки).
   */
  isPluginActive?: () => boolean;
  /**
   * Вызов админ-тула плагина памяти через реестр тулов (ADR-090).
   *
   * Реализует вызывающая сторона (`mount-routes`): находит определение тула в
   * `ToolRegistry` и зовёт `executeToolDef`. Не задан — мутации индексов
   * отвечают `409 MEMORY_PROVIDER_UNAVAILABLE` (чтение работает как раньше).
   */
  invokeTool?: MemoryToolInvoker;
  /**
   * Резолвер проекта (порт `ProjectRepository.load`) — для мутаций индексов.
   *
   * `workspace` — **абсолютный** путь рабочего каталога (относительный путь
   * резолвит вызывающая сторона, ADR-075); не задан — у проекта нет workspace.
   * Резолвер не задан — проект не найден (fail-closed).
   */
  resolveProject?: (projectId: string) => Promise<MemoryPortalProject | null>;
  /**
   * Каталог данных инстанса — рабочий каталог для источника `facts`
   * (у проекта нет workspace) и маскировка путей в текстах ошибок.
   */
  dataDir?: string;
}

/** Сводка по фактам памяти (namespace портала). */
export interface MemoryFactsSummary {
  /** Всего фактов в namespace. */
  total: number;
  /** Активных фактов (статус `active`). */
  active: number;
}

/** Сводка по индексам памяти (namespace портала). */
export interface MemoryIndexesSummary {
  /** Всего индексов в namespace. */
  total: number;
  /** Индексов в состоянии `ready`. */
  ready: number;
  /** Индексов в состоянии `stale` (нужна пересборка). */
  stale: number;
  /** Индексов в состоянии `failed`. */
  failed: number;
  /** Индексов в состоянии `building`. */
  building: number;
}

/** Снимок состояния портала памяти (`GET /status`). */
export interface MemoryStatusView {
  /** Провайдер памяти (плагин) и его режим исполнения. */
  provider: { id: string; mode: 'inline' | null; active: boolean };
  /** Готовность сервиса памяти. */
  readiness: MemoryPortalReadiness;
  /** Namespace, который читает портал. */
  namespace: string;
  /** Сводка по фактам. */
  facts: MemoryFactsSummary;
  /** Сводка по индексам. */
  indexes: MemoryIndexesSummary;
}

/** Страница списка фактов (`GET /facts`). */
export interface MemoryFactsPage {
  /** Записи фактов (как в порте). */
  items: MemoryFactRecord[];
  /** Всего записей под фильтрами (не длина страницы). */
  total: number;
  /** Применённый потолок выборки. */
  limit: number;
  /** Применённое смещение. */
  offset: number;
}

/** Страница списка индексов (`GET /indexes`). */
export interface MemoryIndexesPage {
  /** Записи индексов (без чанков — чанки отдельным портом). */
  items: MemoryIndexRecord[];
  /** Всего индексов под фильтрами. */
  total: number;
}

/**
 * Один кластер консолидации: канон и вытесненные им факты.
 *
 * `keptId` — факт-канон кластера (он остаётся активным), `supersededIds` —
 * факты, которые он заменил (становятся `superseded`), `similarity` — косинус
 * сходства канона с заменёнными фактами.
 */
export interface MemoryConsolidationItem {
  /** Id факта-канона кластера. */
  keptId: string;
  /** Id фактов, вытесненных каноном. */
  supersededIds: string[];
  /** Косинус сходства канона с вытесненными фактами. */
  similarity: number;
}

/** Отчёт консолидации фактов (`POST /consolidate`). */
export interface MemoryConsolidationReport {
  /** Число кластеров, найденных по порогу сходства. */
  clusters: number;
  /** Число фактов, вытесненных канонами кластеров. */
  superseded: number;
  /** Число фактов-канонов, оставшихся активными. */
  kept: number;
  /** Состав кластеров (по кластеру — канон и заменённые им факты). */
  items: MemoryConsolidationItem[];
}

const DEFAULT_MESSAGES: MemoryRouteMessages = {
  invalidStatus: () => 'Недопустимый статус факта памяти',
  invalidState: () => 'Недопустимое состояние индекса памяти',
  invalidLimit: () => 'limit памяти: ожидается целое число от 1 до 200',
  invalidOffset: () => 'offset памяти: ожидается целое число не меньше 0',
  factNotFound: () => 'Факт памяти не найден',
  unavailable: () => 'Хранилище памяти недоступно',
  invalidBody: () => 'Некорректное тело запроса памяти',
  invalidSource: () => 'Недопустимый источник индекса памяти',
  projectRequired: () => 'Индекс памяти строится в проекте: укажите projectId',
  projectNotFound: () => 'Проект не найден',
  workspaceRequired: () => 'У проекта нет рабочего каталога: индекс файлов строить негде',
  providerUnavailable: () => 'Провайдер памяти недоступен: плагин памяти не активен',
  indexNotFound: () => 'Индекс памяти не найден',
  indexFailed: () => 'Не удалось выполнить операцию с индексом памяти',
  indexCreated: () => 'Индекс памяти создан',
  invalidThreshold: () => 'Порог консолидации памяти: ожидается число от 0.5 до 0.99',
  consolidationFailed: () => 'Не удалось выполнить консолидацию памяти',
  consolidated: () => 'Консолидация памяти выполнена',
};

/** Дефолтный потолок выборки фактов. */
const DEFAULT_FACTS_LIMIT = 50;

/** Максимальный потолок выборки фактов (больше — обрезается). */
const MAX_FACTS_LIMIT = 200;

/**
 * Потолок выборки для текстового поиска: порт не умеет искать по тексту,
 * поэтому поиск идёт по выборке в памяти (полнотекстовый поиск — М2).
 */
const SEARCH_SAMPLE_LIMIT = 1000;

/** Нижняя граница порога кластеризации (косинус сходства). */
const MIN_CONSOLIDATION_THRESHOLD = 0.5;

/** Верхняя граница порога кластеризации (косинус сходства). */
const MAX_CONSOLIDATION_THRESHOLD = 0.99;

/** Разбор неотрицательного целого query-параметра (`null` — не задан). */
function parseIntegerParam(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^-?\d+$/.test(raw.trim())) return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

/**
 * Нормализация счётчика из метаданных тула (не число/отрицательное — 0).
 *
 * Метаданные тула — недоверенный ввод: портал приводит их к форме отчёта,
 * чтобы ответ API не зависел от того, что вернул плагин.
 */
function normalizeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Нормализация состава кластеров из метаданных тула.
 *
 * Кластер без канона (`keptId`) в отчёт не попадает — иначе клиент получил бы
 * «замену неизвестно на что».
 */
function normalizeConsolidationItems(value: unknown): MemoryConsolidationItem[] {
  if (!Array.isArray(value)) return [];
  const items: MemoryConsolidationItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const keptId = typeof item.keptId === 'string' ? item.keptId.trim() : '';
    if (!keptId) continue;
    const supersededIds = Array.isArray(item.supersededIds)
      ? item.supersededIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : [];
    const similarity =
      typeof item.similarity === 'number' && Number.isFinite(item.similarity) ? item.similarity : 0;
    items.push({ keptId, supersededIds, similarity });
  }
  return items;
}

/** Отчёт консолидации — из метаданных тула (пустое → нули). */
function normalizeConsolidationReport(metadata?: Record<string, unknown>): MemoryConsolidationReport {
  return {
    clusters: normalizeCount(metadata?.clusters),
    superseded: normalizeCount(metadata?.superseded),
    kept: normalizeCount(metadata?.kept),
    items: normalizeConsolidationItems(metadata?.items),
  };
}

/**
 * Код ошибки тула (`metadata.code`) — для `error.details.code`.
 *
 * Плагин отдаёт машинный код (напр. `plugin.embedding_not_configured`),
 * клиенту он полезнее текста; нестрока/пустой код — код не пробрасывается.
 */
function toolErrorDetails(metadata?: Record<string, unknown>): { code: string } | undefined {
  const code = metadata?.code;
  if (typeof code !== 'string' || !code.trim()) return undefined;
  return { code: code.trim() };
}

/**
 * Фабрика роутов портала памяти (ADR-107, PROP-047 §2.1).
 *
 * `auth.requireAuth` — обязательный guard чтения по умолчанию; managed
 * backend передаёт `opts.guard` (ADMIN).
 */
export function createMemoryRoutes(
  auth: MemoryRoutesAuth,
  opts: MemoryRoutesOptions = {},
): Hono {
  const app = new Hono();
  const guard = opts.guard ?? auth.requireAuth;
  const messages: MemoryRouteMessages = { ...DEFAULT_MESSAGES, ...(opts.messages ?? {}) };
  const namespace = MEMORY_NAMESPACE;

  /** Порты памяти (могут быть не сконфигурированы — тогда 503). */
  const factsPort = (): MemoryFactRepository | undefined => opts.memory?.facts;
  const indexesPort = (): MemoryIndexRepository | undefined => opts.memory?.indexes;

  /** Ответ 503: порты памяти не сконфигурированы. */
  const unavailable = (c: Context) =>
    c.json({ error: { code: 'MEMORY_UNAVAILABLE', message: messages.unavailable(c) } }, 503);

  /**
   * Ошибка API в общем формате `{ error: { code, message } }`.
   *
   * `details` — аддитивное поле (напр. машинный код тула в `error.details.code`).
   */
  const apiError = (
    c: Context,
    code: string,
    message: string,
    status: 400 | 404 | 409 | 422,
    details?: Record<string, unknown>,
  ) => c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);

  /** 409: плагин памяти не активен либо его тул не зарегистрирован. */
  const providerUnavailable = (c: Context) =>
    apiError(c, 'MEMORY_PROVIDER_UNAVAILABLE', messages.providerUnavailable(c), 409);

  /** 404: индекса нет (или он чужого namespace — как «не найдено»). */
  const indexNotFound = (c: Context) =>
    apiError(c, 'MEMORY_INDEX_NOT_FOUND', messages.indexNotFound(c), 404);

  /**
   * Провайдер памяти доступен: инвокер задан **и** плагин активен.
   *
   * Без инвокера или без активного плагина мутации невозможны — портал
   * отвечает 409, а не падает.
   */
  const providerAvailable = (): boolean =>
    typeof opts.invokeTool === 'function' && (opts.isPluginActive?.() ?? false);

  /** Тело запроса как объект (`null` — нечитаемый JSON или не объект). */
  const readBody = async (c: Context): Promise<Record<string, unknown> | null> => {
    try {
      const raw = await c.req.text();
      if (!raw.trim()) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  /**
   * Резолв проекта для мутации индекса (fail-closed: нет проекта — `null`).
   */
  const resolvePortalProject = async (
    projectId: string,
  ): Promise<MemoryPortalProject | null> => {
    if (!opts.resolveProject) return null;
    try {
      return await opts.resolveProject(projectId);
    } catch {
      return null;
    }
  };

  /** Рабочий каталог вызова: workspace проекта, иначе каталог данных инстанса. */
  const workingDirOf = (project: MemoryPortalProject | null): string =>
    project?.workspace ?? opts.dataDir ?? process.cwd();

  /**
   * Вызов админ-тула плагина памяти.
   *
   * Провал тула (`isError`) — 422 с кодом операции и текстом из `content`
   * (внутренние пути замаскированы). Отсутствие тула в реестре
   * (`MemoryProviderUnavailableError`) — 409. Прочие броски — 422.
   *
   * `withDetails` — пробросить машинный код тула (`metadata.code`) в
   * `error.details.code` (для консолидации: `plugin.embedding_not_configured`).
   */
  const invokeMemoryTool = async (
    c: Context,
    input: MemoryToolInvokeInput,
    failure: { code: string; message: string; withDetails?: boolean },
  ): Promise<{ ok: true; result: ToolResult } | { ok: false; response: Response }> => {
    const invoke = opts.invokeTool;
    if (!invoke) return { ok: false, response: providerUnavailable(c) };
    let result: ToolResult;
    try {
      result = await invoke(input);
    } catch (error) {
      if (error instanceof MemoryProviderUnavailableError) {
        return { ok: false, response: providerUnavailable(c) };
      }
      return {
        ok: false,
        response: apiError(c, failure.code, failure.message, 422),
      };
    }
    if (result?.isError) {
      const text = redactInternalPaths(result.content ?? '', input.workingDir, opts.dataDir);
      const details = failure.withDetails ? toolErrorDetails(result.metadata) : undefined;
      return {
        ok: false,
        response: apiError(
          c,
          failure.code,
          text.trim() ? text : failure.message,
          422,
          details,
        ),
      };
    }
    return { ok: true, result };
  };

  /** Вызов админ-тула индекса памяти (`MEMORY_INDEX_FAILED`). */
  const invokeIndexTool = (c: Context, input: MemoryToolInvokeInput) =>
    invokeMemoryTool(c, input, {
      code: 'MEMORY_INDEX_FAILED',
      message: messages.indexFailed(c),
    });

  /**
   * Статус портала памяти: провайдер, готовность и сводные счётчики.
   *
   * Счётчики — через порты (`count` фактов, выборка индексов), а не по
   * выборке: пагинация не должна ломать счётчик.
   */
  app.get('/status', guard, async (c) => {
    const active = opts.isPluginActive?.() ?? false;
    const provider: MemoryStatusView['provider'] = {
      id: namespace,
      // Плагин памяти по дизайну `inline` (ADR-107 §2.2); не активен — режим
      // неизвестен (`null`).
      mode: active ? 'inline' : null,
      active,
    };

    const facts = factsPort();
    const indexes = indexesPort();
    if (!facts || !indexes) {
      const empty: MemoryStatusView = {
        provider,
        readiness: 'unavailable',
        namespace,
        facts: { total: 0, active: 0 },
        indexes: { total: 0, ready: 0, stale: 0, failed: 0, building: 0 },
      };
      return c.json(empty);
    }

    const [factsTotal, factsActive, indexList] = await Promise.all([
      facts.count({ namespace }),
      facts.count({ namespace, status: 'active' }),
      indexes.listIndexes({ namespace }),
    ]);

    const indexesSummary: MemoryIndexesSummary = {
      total: indexList.length,
      ready: 0,
      stale: 0,
      failed: 0,
      building: 0,
    };
    for (const index of indexList) {
      if (index.state === 'ready') indexesSummary.ready += 1;
      else if (index.state === 'stale') indexesSummary.stale += 1;
      else if (index.state === 'failed') indexesSummary.failed += 1;
      else if (index.state === 'building') indexesSummary.building += 1;
    }

    // `degraded` — есть индексы, требующие вмешательства (`failed`/`stale`).
    const readiness: MemoryPortalReadiness =
      indexesSummary.failed > 0 || indexesSummary.stale > 0 ? 'degraded' : 'ready';

    const view: MemoryStatusView = {
      provider,
      readiness,
      namespace,
      facts: { total: factsTotal, active: factsActive },
      indexes: indexesSummary,
    };
    return c.json(view);
  });

  /**
   * Список фактов памяти. Фильтры — по «И», `namespace` подставляет сервер.
   */
  app.get('/facts', guard, async (c) => {
    const facts = factsPort();
    if (!facts) return unavailable(c);

    const rawStatus = c.req.query('status');
    let statusFilter: MemoryFactStatusFilter = 'active';
    if (rawStatus !== undefined && rawStatus !== '') {
      if (rawStatus === 'all') {
        statusFilter = 'all';
      } else if (!MEMORY_FACT_STATUSES.includes(rawStatus as MemoryFactStatus)) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.invalidStatus(c) } },
          400,
        );
      } else {
        statusFilter = rawStatus as MemoryFactStatus;
      }
    }

    const rawLimit = c.req.query('limit');
    const parsedLimit = parseIntegerParam(rawLimit);
    if (parsedLimit !== null && (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_FACTS_LIMIT)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.invalidLimit(c) } },
        400,
      );
    }
    const limit = parsedLimit ?? DEFAULT_FACTS_LIMIT;

    const rawOffset = c.req.query('offset');
    const parsedOffset = parseIntegerParam(rawOffset);
    if (parsedOffset !== null && (!Number.isFinite(parsedOffset) || parsedOffset < 0)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: messages.invalidOffset(c) } },
        400,
      );
    }
    const offset = parsedOffset ?? 0;

    const kind = c.req.query('kind')?.trim() || undefined;
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const query = c.req.query('query')?.trim() || undefined;

    // Namespace подставляет сервер: клиент его не задаёт.
    const base: MemoryFactQuery = {
      namespace,
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      ...(kind ? { kind } : {}),
      ...(projectId ? { projectId } : {}),
    };

    let page: MemoryFactsPage;
    if (query) {
      // Порт не умеет текстовый поиск — фильтруем подстроку по выборке
      // (регистронезависимо). Полнотекстовый поиск — М2.
      const sampled = await facts.list({ ...base, limit: SEARCH_SAMPLE_LIMIT });
      const needle = query.toLowerCase();
      const matched = sampled.filter((fact) => fact.text.toLowerCase().includes(needle));
      page = {
        items: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
      };
    } else {
      const [items, total] = await Promise.all([
        facts.list({ ...base, limit, offset }),
        facts.count(base),
      ]);
      page = { items, total, limit, offset };
    }
    return c.json(page);
  });

  /** Факт памяти по id (только в namespace портала). */
  app.get('/facts/:id', guard, async (c) => {
    const facts = factsPort();
    if (!facts) return unavailable(c);

    const id = c.req.param('id');
    const fact = await facts.get(id);
    // Чужой namespace выглядит как «не найдено» — иначе по коду ответа можно
    // было бы отличить существующий чужой id от несуществующего.
    if (!fact || fact.namespace !== namespace) {
      return c.json(
        { error: { code: 'MEMORY_FACT_NOT_FOUND', message: messages.factNotFound(c) } },
        404,
      );
    }
    return c.json(fact);
  });

  /** Список индексов памяти (без чанков — чанки отдельным портом). */
  app.get('/indexes', guard, async (c) => {
    const indexes = indexesPort();
    if (!indexes) return unavailable(c);

    const rawState = c.req.query('state');
    let stateFilter: MemoryIndexState | undefined;
    if (rawState !== undefined && rawState !== '' && rawState !== 'all') {
      if (!MEMORY_INDEX_STATES.includes(rawState as MemoryIndexState)) {
        return c.json(
          { error: { code: 'VALIDATION_ERROR', message: messages.invalidState(c) } },
          400,
        );
      }
      stateFilter = rawState as MemoryIndexState;
    }

    const projectId = c.req.query('projectId')?.trim() || undefined;
    const query: MemoryIndexQuery = {
      namespace,
      ...(stateFilter ? { state: stateFilter } : {}),
      ...(projectId ? { projectId } : {}),
    };
    const items = await indexes.listIndexes(query);
    const page: MemoryIndexesPage = { items, total: items.length };
    return c.json(page);
  });

  /**
   * Создание индекса памяти — через админ-тул плагина (ADR-090).
   *
   * Границы проверяет портал, логику индекса — плагин: индекс файлов строится
   * в проекте (ADR-075), поэтому проект обязателен, а у проекта с источником
   * `files` должен быть рабочий каталог.
   */
  app.post('/indexes', guard, async (c) => {
    const body = await readBody(c);
    if (!body) return apiError(c, 'VALIDATION_ERROR', messages.invalidBody(c), 400);

    // Источник корпуса: `files` (по умолчанию) или `facts`.
    let sourceKind: MemoryIndexSourceKind = 'files';
    let sourceFilter: string | undefined;
    const rawSource = body.source;
    if (rawSource !== undefined && rawSource !== null) {
      if (typeof rawSource !== 'object' || Array.isArray(rawSource)) {
        return apiError(c, 'VALIDATION_ERROR', messages.invalidSource(c), 400);
      }
      const source = rawSource as Record<string, unknown>;
      const kind = source.kind;
      if (kind !== undefined && kind !== null && kind !== 'files' && kind !== 'facts') {
        return apiError(c, 'VALIDATION_ERROR', messages.invalidSource(c), 400);
      }
      sourceKind = kind === 'facts' ? 'facts' : 'files';
      if (typeof source.filter === 'string' && source.filter.trim()) {
        sourceFilter = source.filter.trim();
      }
    }

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;
    const force = body.force === true ? true : undefined;

    if (!projectId) {
      return apiError(c, 'MEMORY_PROJECT_REQUIRED', messages.projectRequired(c), 400);
    }
    const project = await resolvePortalProject(projectId);
    if (!project) {
      return apiError(c, 'PROJECT_NOT_FOUND', messages.projectNotFound(c), 404);
    }
    if (sourceKind === 'files' && !project.workspace) {
      return apiError(c, 'MEMORY_WORKSPACE_REQUIRED', messages.workspaceRequired(c), 400);
    }
    if (!providerAvailable()) return providerUnavailable(c);

    const workingDir = workingDirOf(project);
    const params: Record<string, unknown> = {
      action: 'create',
      ...(name ? { name } : {}),
      source: { kind: sourceKind, ...(sourceFilter ? { filter: sourceFilter } : {}) },
      projectId,
      ...(force ? { force } : {}),
    };
    const call = await invokeIndexTool(c, {
      tool: MEMORY_INDEX_TOOL_NAME,
      params,
      projectId,
      workingDir,
    });
    if (!call.ok) return call.response;

    // Тело индекса — из порта (источник истины); если записи ещё нет — метаданные тула.
    const indexId = typeof call.result.metadata?.indexId === 'string'
      ? call.result.metadata.indexId
      : undefined;
    const indexes = indexesPort();
    const record = indexId && indexes ? await indexes.getIndex(indexId) : null;
    const index = record ?? call.result.metadata ?? {};
    return c.json({ index, message: messages.indexCreated(c) }, 202);
  });

  /**
   * Пересборка индекса памяти — через админ-тул плагина (ADR-090).
   *
   * Индекс и его проект — из порта; клиент подменять их не может.
   */
  app.post('/indexes/:id/rebuild', guard, async (c) => {
    const indexes = indexesPort();
    if (!indexes) return unavailable(c);

    const id = c.req.param('id');
    const index = await indexes.getIndex(id);
    // Чужой namespace выглядит как «не найдено» — как и у фактов.
    if (!index || index.namespace !== namespace) return indexNotFound(c);

    const body = await readBody(c);
    if (!body) return apiError(c, 'VALIDATION_ERROR', messages.invalidBody(c), 400);
    const force = body.force === true;

    let project: MemoryPortalProject | null = null;
    if (index.projectId) {
      project = await resolvePortalProject(index.projectId);
      if (!project) {
        return apiError(c, 'PROJECT_NOT_FOUND', messages.projectNotFound(c), 404);
      }
      if (index.source.kind === 'files' && !project.workspace) {
        return apiError(c, 'MEMORY_WORKSPACE_REQUIRED', messages.workspaceRequired(c), 400);
      }
    }
    if (!providerAvailable()) return providerUnavailable(c);

    const workingDir = workingDirOf(project);
    const call = await invokeIndexTool(c, {
      tool: MEMORY_INDEX_TOOL_NAME,
      params: { action: 'rebuild', indexId: id, force },
      ...(index.projectId ? { projectId: index.projectId } : {}),
      workingDir,
    });
    if (!call.ok) return call.response;

    const record = await indexes.getIndex(id);
    return c.json({ index: record ?? call.result.metadata ?? {} }, 202);
  });

  /**
   * Удаление индекса памяти — через админ-тул плагина (ADR-090).
   *
   * Запись индекса удаляет **тул** (владелец логики), портал лишь проверяет
   * границы и отвечает 204.
   */
  app.delete('/indexes/:id', guard, async (c) => {
    const indexes = indexesPort();
    if (!indexes) return unavailable(c);

    const id = c.req.param('id');
    const index = await indexes.getIndex(id);
    if (!index || index.namespace !== namespace) return indexNotFound(c);

    let project: MemoryPortalProject | null = null;
    if (index.projectId) {
      project = await resolvePortalProject(index.projectId);
      if (!project) {
        return apiError(c, 'PROJECT_NOT_FOUND', messages.projectNotFound(c), 404);
      }
    }
    if (!providerAvailable()) return providerUnavailable(c);

    const workingDir = workingDirOf(project);
    const call = await invokeIndexTool(c, {
      tool: MEMORY_INDEX_TOOL_NAME,
      params: { action: 'delete', indexId: id },
      ...(index.projectId ? { projectId: index.projectId } : {}),
      workingDir,
    });
    if (!call.ok) return call.response;

    return c.body(null, 204);
  });

  /**
   * Консолидация фактов памяти — через админ-тул плагина (ADR-090).
   *
   * Логика консолидации принадлежит **плагину** (PROP-047 §2.1): кластеры по
   * косинусу сходства, канон в кластере, замена дубликатов. Портал проверяет
   * границы (проект, порог, доступность провайдера) и отвечает за контракт.
   *
   * Отличие от мутаций индексов: операция **синхронная** (200, не 202) и
   * **workspace не нужен** — консолидация работает по фактам, а не по файлам.
   */
  app.post('/consolidate', guard, async (c) => {
    const body = await readBody(c);
    if (!body) return apiError(c, 'VALIDATION_ERROR', messages.invalidBody(c), 400);

    // Порог кластеризации: число 0.5..0.99 (вне диапазона — 400).
    let threshold: number | undefined;
    if (body.threshold !== undefined && body.threshold !== null) {
      const raw = body.threshold;
      if (
        typeof raw !== 'number' ||
        !Number.isFinite(raw) ||
        raw < MIN_CONSOLIDATION_THRESHOLD ||
        raw > MAX_CONSOLIDATION_THRESHOLD
      ) {
        return apiError(c, 'VALIDATION_ERROR', messages.invalidThreshold(c), 400);
      }
      threshold = raw;
    }

    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim()
        : undefined;
    const dryRun = body.dryRun === true ? true : undefined;

    // Проект (если задан) должен существовать: консолидация по фактам
    // конкретного проекта. Нет проекта — 404 (fail-closed).
    let project: MemoryPortalProject | null = null;
    if (projectId) {
      project = await resolvePortalProject(projectId);
      if (!project) {
        return apiError(c, 'PROJECT_NOT_FOUND', messages.projectNotFound(c), 404);
      }
    }
    if (!providerAvailable()) return providerUnavailable(c);

    // Workspace у проекта может не быть — это не ошибка консолидации:
    // рабочий каталог вызова = workspace, иначе каталог данных инстанса.
    const workingDir = workingDirOf(project);
    const params: Record<string, unknown> = {
      ...(projectId ? { projectId } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
    };
    const call = await invokeMemoryTool(
      c,
      {
        tool: MEMORY_CONSOLIDATE_TOOL_NAME,
        params,
        ...(projectId ? { projectId } : {}),
        workingDir,
      },
      {
        code: 'MEMORY_CONSOLIDATION_FAILED',
        message: messages.consolidationFailed(c),
        withDetails: true,
      },
    );
    if (!call.ok) return call.response;

    const report = normalizeConsolidationReport(call.result.metadata);
    return c.json({ report, message: messages.consolidated(c) }, 200);
  });

  return app;
}
