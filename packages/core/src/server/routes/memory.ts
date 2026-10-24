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
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
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

const DEFAULT_MESSAGES: MemoryRouteMessages = {
  invalidStatus: () => 'Недопустимый статус факта памяти',
  invalidState: () => 'Недопустимое состояние индекса памяти',
  invalidLimit: () => 'limit памяти: ожидается целое число от 1 до 200',
  invalidOffset: () => 'offset памяти: ожидается целое число не меньше 0',
  factNotFound: () => 'Факт памяти не найден',
  unavailable: () => 'Хранилище памяти недоступно',
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

/** Разбор неотрицательного целого query-параметра (`null` — не задан). */
function parseIntegerParam(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^-?\d+$/.test(raw.trim())) return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
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

  return app;
}
