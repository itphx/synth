/**
 * Провайдер памяти плагина (`MemoryProvider-lite`) — слой доставки поверх
 * `facade.memory`.
 *
 * Ядро владеет данными памяти (порты `MemoryFactRepository`/
 * `MemoryIndexRepository`, ADR-096), плагин — логикой памяти (PROP-047 §3,
 * docs/MEMORY.md). Здесь — единственное место плагина, которое ходит в
 * хранилище: блоки промпта и тулы работают через провайдер, а не напрямую
 * (иначе появятся две реализации recall — в блоке и в туле, и они разойдутся).
 *
 * **Правила доступа к хранилищу.**
 * - Всё — только через `facade.memory` (факты и индексы); namespace навязывает
 *   хост (ADR-107), поэтому в запросах `namespace` **не передаётся**;
 * - `facade.memory === undefined` — фича-детект, а не ошибка: вызывающий
 *   проверяет `available` и деградирует (блок → `null`, тул → `isError`);
 * - скоуп хода: задан проект сессии → факты и индексы этого проекта **и**
 *   общие (без проекта); не задан → только **без** проекта (чужие проекты в
 *   выдачу не попадают). Правило одно для блоков промпта и тулов.
 *
 * **Индексы (М2).** Провайдер делегирует жизненный цикл корпуса движку
 * (`engine/index-manager.ts`), а поиск — `engine/search.ts`: блоки и тулы не
 * знают про поколения и фингерпринты (знание — в движке).
 */
import { randomUUID } from 'node:crypto';

import type {
  MemoryFactQuery,
  MemoryFactRecord,
  PluginFacade,
} from '@itphx/synth-core';

import { embedTexts } from './engine/embedder.js';
import { IndexManager, type IndexStatus } from './engine/index-manager.js';
import type { CreateIndexInput, RebuildIndexInput } from './engine/index-manager.js';
import { searchIndex, type SearchOutcome } from './engine/search.js';
import {
  FactNotFoundError,
  MemoryUnavailableError,
  SupersedeTextRequiredError,
} from './errors.js';
import {
  resolveMemorySettings,
  type MemoryPluginSettings,
} from './settings.js';
import { enumOf } from './schema.js';
import { keywordScore } from './scoring.js';

/** Порт фактов памяти — тот же тип, что у фасада (`facade.memory.facts`). */
export type FactsRepository = NonNullable<PluginFacade['memory']>['facts'];

/** Виды фактов памяти (модель данных — docs/MEMORY.md §5.2). */
export const FACT_KIND_VALUES = [
  'decision',
  'constraint',
  'reference',
  'preference',
  'observation',
] as const;
export type FactKind = (typeof FACT_KIND_VALUES)[number];
/** Перечень видов фактов (итерация, справка). */
export const FACT_KINDS: readonly FactKind[] = FACT_KIND_VALUES;
/** Схема вида факта — по ней хост валидирует аргумент `kind` тула `memory_write`. */
export const factKindSchema = enumOf(FACT_KIND_VALUES);

/**
 * Настройки плагина памяти и их дефолты — в `settings.ts` (единое место
 * чтения настроек для блоков, тулов и движка индекса).
 */
export {
  DEFAULT_FACTS_LIMIT,
  DEFAULT_MIN_SCORE,
  DEFAULT_RECALL_LIMIT,
  MAX_FACTS_LIMIT,
  MAX_RECALL_LIMIT,
  MIN_FACTS_LIMIT,
  MIN_RECALL_LIMIT,
} from './settings.js';

/**
 * Настройки М4a (консолидация) — порог слияния фактов.
 */
export {
  DEFAULT_CONSOLIDATE_THRESHOLD,
  MAX_CONSOLIDATE_THRESHOLD,
  MIN_CONSOLIDATE_THRESHOLD,
} from './settings.js';

/** Уверенность факта, записанного агентом без явного `confidence`. */
export const DEFAULT_FACT_CONFIDENCE = 0.7;
/**
 * Сколько активных фактов просматриваем за ход.
 *
 * Потолок выборки порта — 1000, дефолт — 100; здесь берём 200: этого хватает
 * и блоку фактов, и recall, а лишнее не тянем из хранилища.
 */
export const CANDIDATE_LIMIT = 200;

/** Скоуп фактов в ходе: проект сессии (не задан — только факты без проекта). */
export interface FactScope {
  /** Проект сессии (`ctx.projectId`); не задан — сессия без проекта. */
  projectId?: string;
}

/** Вход записи факта (тул `memory_write`). */
export interface WriteFactInput {
  /** Текст утверждения. */
  text: string;
  /** Вид факта (дефолт — `observation`). */
  kind?: FactKind;
  /** Проект-владелец утверждения (не задан — факт без проекта). */
  projectId?: string;
  /** Уверенность (0..1). */
  confidence?: number;
  /** Срок действия в днях (не задан — бессрочно). */
  ttlDays?: number;
  /** Идентификатор сессии — провенанс записи. */
  sessionId: string;
}

/** Результат записи факта. */
export interface WriteFactResult {
  /** id созданного факта. */
  factId: string;
  /** Версия факта. */
  version: number;
}

/** Вход отзыва факта (тул `memory_forget`). */
export interface ForgetFactInput {
  /** id факта, который отзывают. */
  factId: string;
  /** Режим отзыва: замена новой версией или полный отзыв. */
  mode: 'supersede' | 'retract';
  /** Новый текст факта (обязателен для `supersede`). */
  text?: string;
  /** Идентификатор сессии — провенанс новой версии. */
  sessionId: string;
}

/** Результат отзыва факта. */
export interface ForgetFactResult {
  /** id факта после операции (для `supersede` — id новой версии). */
  factId: string;
  /** Версия факта после операции. */
  version: number;
  /** id заменённого факта (для `supersede`). */
  supersededId?: string;
}

/** Настройки плагина памяти (`plugins[<имя>].settings`, ADR-107) — см. `settings.ts`. */
export type { MemoryPluginSettings } from './settings.js';

/** Ошибки памяти — общие для провайдера, движка и тулов. */
export {
  ConsolidationError,
  FactNotFoundError,
  IndexBusyError,
  IndexNotFoundError,
  MemoryUnavailableError,
  SupersedeTextRequiredError,
} from './errors.js';

/** ISO-момент → `YYYY-MM-DD` (для блоков промпта). */
export function formatFactDate(iso: string | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match?.[1] ?? '—';
}

/**
 * Строка факта для блоков промпта: утверждение + провенанс.
 *
 * Провенанс обязателен: содержимое памяти — недоверенный ввод, модель должна
 * видеть, откуда взялось утверждение (docs/MEMORY.md §10).
 */
export function formatFactLine(fact: MemoryFactRecord): string {
  const { sourceKind, sourceId } = fact.provenance;
  return `- ${fact.text} (src: ${sourceKind} ${sourceId}, ${formatFactDate(fact.provenance.capturedAt)})`;
}

/** Строка факта с id и уверенностью — формат выдачи тула `memory_search`. */
export function formatFactLineWithMeta(fact: MemoryFactRecord): string {
  return `${formatFactLine(fact)}; id: ${fact.id}, conf: ${fact.confidence}`;
}

/**
 * Факт в скоупе хода: проект сессии задан → его факты **и** факты без проекта
 * (общие утверждения видны всем проектам); не задан → только факты **без**
 * проекта (чужие проекты в выдачу не попадают).
 *
 * Единственное место правила скоупа: блоки промпта и тул `memory_search`
 * ходят в хранилище через провайдер — значит, правило одно (docs/MEMORY.md §3,
 * «одна реализация recall»).
 */
function inScope(fact: MemoryFactRecord, scope: FactScope): boolean {
  if (scope.projectId) return fact.projectId === undefined || fact.projectId === scope.projectId;
  return fact.projectId === undefined;
}

/**
 * Провайдер памяти плагина (М1 + М2).
 *
 * Обёртка над `facade.memory`: скоуп, порядок, скоринг, запись фактов и
 * жизненный цикл индексов. Блоки промпта и туны ходят в хранилище **только**
 * через него (docs/MEMORY.md §3: «блок не ходит в хранилище напрямую»).
 */
export class MemoryProviderLite {
  private readonly _facade: PluginFacade;
  /** Менеджер индексов (движок М2) — единственный владелец корпуса. */
  private readonly _indexes: IndexManager;

  constructor(facade: PluginFacade) {
    this._facade = facade;
    this._indexes = new IndexManager({
      facade,
      listFacts: (opts) => this.listFacts(opts),
      settings: () => this.settings(),
    });
  }

  /** Доступен ли сервис памяти в этом инстансе (фича-детект). */
  get available(): boolean {
    return this._facade.memory !== undefined;
  }

  /** Настройки плагина — нормализованные (вне диапазона → дефолт). */
  settings(): MemoryPluginSettings {
    return resolveMemorySettings(this._facade.getSettings());
  }

  /** Менеджер индексов памяти (движок М2). */
  get indexManager(): IndexManager {
    return this._indexes;
  }

  /** Порт фактов (бросает, если сервис памяти недоступен). */
  private _facts(): FactsRepository {
    const memory = this._facade.memory;
    if (!memory) throw new MemoryUnavailableError();
    return memory.facts;
  }

  /**
   * Активные факты в скоупе хода.
   *
   * `namespace` в запрос не передаётся: его навязывает хост (ADR-107).
   */
  async candidates(scope: FactScope): Promise<MemoryFactRecord[]> {
    return this.listFacts({ status: 'active', projectId: scope.projectId });
  }

  /**
   * Факты по фильтру статуса/вида в скоупе хода — для тула `memory_search`.
   *
   * Скоуп применяется **тем же** правилом, что и в блоках промпта
   * ({@link inScope}): проект сессии задан → его факты и факты без проекта;
   * не задан → только факты без проекта. Одна реализация recall — блок и тул
   * не должны разойтись (docs/MEMORY.md §3).
   *
   * `limit` — потолок выборки (по умолчанию {@link CANDIDATE_LIMIT}; для
   * консолидации — 1000, потолок порта). Больше порт не отдаёт в любом случае.
   */
  async listFacts(opts: {
    status?: 'active' | 'candidate' | 'all';
    kind?: string;
    /** Проект сессии (`ctx.projectId`); не задан — только факты без проекта. */
    projectId?: string;
    /** Потолок выборки (по умолчанию {@link CANDIDATE_LIMIT}). */
    limit?: number;
  }): Promise<MemoryFactRecord[]> {
    const query: MemoryFactQuery = { limit: opts.limit ?? CANDIDATE_LIMIT };
    if (opts.status && opts.status !== 'all') query.status = opts.status;
    if (opts.kind) query.kind = opts.kind;
    const facts = await this._facts().list(query);
    return facts.filter((fact) => inScope(fact, { projectId: opts.projectId }));
  }

  /**
   * Факты блока «project facts»: уверенность ↓ → свежесть ↓ → id ↑.
   *
   * Порядок **детерминирован** (одинаковый вход → одинаковый текст блока).
   */
  selectFacts(candidates: readonly MemoryFactRecord[]): MemoryFactRecord[] {
    const { factsLimit } = this.settings();
    return [...candidates]
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
        return a.id.localeCompare(b.id);
      })
      .slice(0, factsLimit);
  }

  /**
   * Recall по вопросу хода: keyword-скоринг, порог `minScore`, top `recallLimit`.
   *
   * `excludeIds` — факты, уже попавшие в блок «project facts»: в промпте не
   * должно быть двух одинаковых утверждений.
   *
   * Кандидаты передаются снаружи ({@link candidates}), чтобы блок не ходил в
   * хранилище дважды за ход.
   */
  async recall(
    candidates: readonly MemoryFactRecord[],
    query: string,
    excludeIds: ReadonlySet<string> = new Set<string>(),
  ): Promise<MemoryFactRecord[]> {
    const { recallLimit, minScore } = this.settings();
    const scored = candidates
      .filter((fact) => !excludeIds.has(fact.id))
      .map((fact) => ({ fact, score: keywordScore(query, fact.text) }))
      .filter((entry) => entry.score >= minScore);
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.fact.confidence !== a.fact.confidence) return b.fact.confidence - a.fact.confidence;
      const byUpdated = Date.parse(b.fact.updatedAt) - Date.parse(a.fact.updatedAt);
      if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
      return a.fact.id.localeCompare(b.fact.id);
    });
    return scored.slice(0, recallLimit).map((entry) => entry.fact);
  }

  /**
   * Записать факт (тул `memory_write`).
   *
   * Факт получает `status: 'active'`, `version: 1` и провенанс
   * `{sourceKind: 'agent', sourceId: <сессия>}`. `namespace` перезаписывает
   * хост (scoped-обёртка, ADR-107) — значение отсюда не имеет значения.
   */
  async write(input: WriteFactInput): Promise<WriteFactResult> {
    const facts = this._facts();
    const now = new Date();
    const iso = now.toISOString();
    const record: MemoryFactRecord = {
      id: `mem_${randomUUID()}`,
      // Namespace навязывает хост — значение игнорируется (ADR-107).
      namespace: '',
      version: 1,
      text: input.text,
      kind: input.kind ?? 'observation',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      provenance: { sourceKind: 'agent', sourceId: input.sessionId, capturedAt: iso },
      confidence: input.confidence ?? DEFAULT_FACT_CONFIDENCE,
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
      ...(input.ttlDays !== undefined
        ? { validUntil: new Date(now.getTime() + input.ttlDays * 86_400_000).toISOString() }
        : {}),
    };
    await facts.save(record);
    return { factId: record.id, version: record.version };
  }

  /**
   * Отозвать факт (тул `memory_forget`).
   *
   * - `supersede` — новая версия утверждения (version + 1), старый факт
   *   помечается `superseded` и получает `supersededBy`;
   * - `retract` — факт переводится в статус `retracted` (запись та же, id
   *   прежний: upsert по `id`).
   *
   * Факта нет (или он чужого namespace'а — порт отдаёт `null`/`false`) →
   * {@link FactNotFoundError}.
   */
  async forget(input: ForgetFactInput): Promise<ForgetFactResult> {
    const facts = this._facts();
    const old = await facts.get(input.factId);
    if (!old) throw new FactNotFoundError();

    const now = new Date();
    const iso = now.toISOString();

    if (input.mode === 'supersede') {
      const text = input.text?.trim();
      if (!text) throw new SupersedeTextRequiredError();
      const record: MemoryFactRecord = {
        id: `mem_${randomUUID()}`,
        namespace: '',
        version: old.version + 1,
        text,
        kind: old.kind,
        ...(old.projectId ? { projectId: old.projectId } : {}),
        provenance: { sourceKind: 'agent', sourceId: input.sessionId, capturedAt: iso },
        confidence: old.confidence,
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
        ...(old.validUntil ? { validUntil: old.validUntil } : {}),
      };
      await facts.save(record);
      // `supersede` проверяет **оба** id (scoped-обёртка) — чужая запись
      // недостижима: порт вернёт `false`.
      const ok = await facts.supersede(old.id, record.id);
      if (!ok) throw new FactNotFoundError();
      return { factId: record.id, version: record.version, supersededId: old.id };
    }

    await facts.save({ ...old, status: 'retracted', updatedAt: iso });
    return { factId: old.id, version: old.version };
  }

  // ── Запись по порту (М4a — консолидация) ───────────────────────────────
  //
  // Движок консолидации ходит в порты **через провайдера** — иначе у плагина
  // было бы две реализации доступа к памяти (как с recall, docs/MEMORY.md §3).

  /**
   * Сохранить факт (upsert по `id`) — для движка консолидации.
   *
   * Namespace навязывает хост (scoped-обёртка, ADR-107); версию и текст
   * вызывающий не меняет без нужды — «версия канона не меняется, если текст
   * не менялся».
   */
  async save(fact: MemoryFactRecord): Promise<void> {
    await this._facts().save(fact);
  }

  /**
   * Пометить факт заменённым новой версией (`supersede`) — для консолидации.
   *
   * Идемпотентно (порт): повторный вызов с тем же `nextId` — `true`.
   * Чужой факт (чужой namespace) недостижим: порт вернёт `false`.
   */
  async supersede(id: string, nextId: string): Promise<boolean> {
    return this._facts().supersede(id, nextId);
  }

  /**
   * Факт по id (`null` — если нет или он чужого namespace'а).
   *
   * Нужен консолидации: перед записью метаданных канона факт перечитывается,
   * чтобы не затереть параллельное изменение (правку текста или отзыв).
   */
  async getFact(id: string): Promise<MemoryFactRecord | null> {
    return this._facts().get(id);
  }

  /**
   * Эмбеддинги текстов через `facade.embed` (ADR-107) — **только** через
   * шлюз хоста (ADR-036, инвариант 3). Ошибки фасада пробрасываются как есть.
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    const outcome = await embedTexts(this._facade, texts);
    return outcome.vectors;
  }

  // ── Индексы (М2) ──────────────────────────────────────────────────────
  //
  // Скоуп — тот же, что у фактов: проект сессии задан → его индексы;
  // не задан → только индексы **без** проекта (чужие проекты в выдачу не
  // попадают).

  /** Индексы в скоупе хода (с эффективным состоянием). */
  async listIndexes(opts: { projectId?: string } = {}): Promise<IndexStatus[]> {
    const statuses = await this._indexes.statuses();
    return statuses.filter((status) => inIndexScope(status.index, opts.projectId));
  }

  /** Статус индекса по id (или `null`). */
  async getIndex(id: string): Promise<IndexStatus | null> {
    return this._indexes.getStatus(id);
  }

  /** Создать индекс (фоновая сборка корпуса). */
  async createIndex(input: CreateIndexInput): Promise<IndexStatus> {
    return this._indexes.createIndex(input);
  }

  /** Пересобрать индекс (фоновая сборка нового поколения). */
  async rebuildIndex(id: string, input: RebuildIndexInput = {}): Promise<IndexStatus> {
    return this._indexes.rebuildIndex(id, input);
  }

  /** Удалить индекс (каскад чанков — порт). */
  async deleteIndex(id: string): Promise<boolean> {
    return this._indexes.deleteIndex(id);
  }

  /**
   * Индекс проекта для recall: готовый или устаревший (`stale`).
   *
   * Индекс в состоянии `building`/`failed` не используется — recall деградирует
   * на keyword по фактам (иначе в промпт попали бы полузагруженные данные).
   */
  async projectIndex(projectId?: string): Promise<IndexStatus | null> {
    const statuses = await this.listIndexes({ ...(projectId ? { projectId } : {}) });
    const usable = statuses.filter(
      (status) => status.state === 'ready' || status.state === 'stale',
    );
    if (usable.length === 0) return null;
    // Свежий — первый; при равенстве — по id (детерминированно).
    usable.sort((a, b) => {
      const byUpdated = Date.parse(b.index.updatedAt) - Date.parse(a.index.updatedAt);
      if (!Number.isNaN(byUpdated) && byUpdated !== 0) return byUpdated;
      return a.index.id.localeCompare(b.index.id);
    });
    return usable[0] ?? null;
  }

  /** Гибридный поиск по индексу (keyword + вектор + RRF). */
  async searchIndex(
    indexId: string,
    query: string,
    options: { topK?: number; maxChunks?: number } = {},
  ): Promise<SearchOutcome> {
    const status = await this._indexes.getStatus(indexId);
    return searchIndex(this._facade, indexId, query, {
      ...(options.topK !== undefined ? { topK: options.topK } : {}),
      ...(options.maxChunks !== undefined ? { maxChunks: options.maxChunks } : {}),
      ...(status ? { index: status.index, stale: status.stale } : {}),
    });
  }
}

/**
 * Индекс в скоупе хода: проект сессии задан → индексы этого проекта;
 * не задан → только индексы **без** проекта (то же правило, что у фактов).
 */
function inIndexScope(index: { projectId?: string }, projectId: string | undefined): boolean {
  if (projectId) return index.projectId === projectId;
  return index.projectId === undefined;
}
