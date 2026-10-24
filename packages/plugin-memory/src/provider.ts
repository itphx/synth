/**
 * М1: `MemoryProvider-lite` — слой доставки памяти поверх `facade.memory`.
 *
 * Ядро владеет данными памяти (порты `MemoryFactRepository`/
 * `MemoryIndexRepository`, ADR-096), плагин — логикой памяти (PROP-047 §3,
 * docs/MEMORY.md). Здесь — единственное место плагина, которое ходит в
 * хранилище: блоки промпта и туны работают через провайдер, а не напрямую
 * (иначе появятся две реализации recall — в блоке и в туле, и они разойдутся).
 *
 * **Правила доступа к хранилищу.**
 * - Всё — только через `facade.memory.facts`; namespace навязывает хост
 *   (ADR-107), поэтому в запросах `namespace` **не передаётся**;
 * - `facade.memory === undefined` — фича-детект, а не ошибка: вызывающий
 *   проверяет `available` и деградирует (блок → `null`, тул → `isError`);
 * - скоуп хода: задан проект сессии → факты этого проекта **и** общие (без
 *   проекта); не задан → только факты **без** проекта (чужие проекты в выдачу
 *   не попадают). Правило одно для блоков промпта и тула `memory_search`.
 */
import { randomUUID } from 'node:crypto';

import type { MemoryFactQuery, MemoryFactRecord, PluginFacade } from '@itphx/synth-core';
import { z } from 'zod';

import { keywordScore } from './scoring.js';

/** Порт фактов памяти — тот же тип, что у фасада (`facade.memory.facts`). */
export type FactsRepository = NonNullable<PluginFacade['memory']>['facts'];

/** Виды фактов памяти (модель данных — docs/MEMORY.md §5.2). */
export const factKindSchema = z.enum([
  'decision',
  'constraint',
  'reference',
  'preference',
  'observation',
]);
export type FactKind = z.infer<typeof factKindSchema>;
/** Перечень видов фактов (итерация, справка). */
export const FACT_KINDS: readonly FactKind[] = factKindSchema.options;

/** Настройки плагина памяти (`plugins[<имя>].settings`, ADR-107). */
export interface MemoryPluginSettings {
  /** Сколько фактов показывать в блоке «project facts». */
  factsLimit: number;
  /** Сколько фактов показывать в блоке recall. */
  recallLimit: number;
  /** Порог keyword-скоринга для recall (0..1). */
  minScore: number;
}

/** Дефолт лимита фактов в блоке «project facts». */
export const DEFAULT_FACTS_LIMIT = 6;
/** Допустимый диапазон лимита фактов. */
export const MIN_FACTS_LIMIT = 1;
export const MAX_FACTS_LIMIT = 20;
/** Дефолт лимита recall. */
export const DEFAULT_RECALL_LIMIT = 5;
/** Допустимый диапазон лимита recall. */
export const MIN_RECALL_LIMIT = 1;
export const MAX_RECALL_LIMIT = 20;
/** Дефолт порога keyword-скоринга (recall). */
export const DEFAULT_MIN_SCORE = 0.34;
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

/**
 * Сервис памяти недоступен в этом инстансе (`facade.memory === undefined`).
 *
 * Это **не** ошибка активации: плагин деградирует (блок пуст, тул отвечает
 * понятным текстом), ход продолжается.
 */
export class MemoryUnavailableError extends Error {
  constructor() {
    super('Хранилище памяти недоступно в этом инстансе');
    this.name = 'MemoryUnavailableError';
  }
}

/** Факт не найден (нет такого id или он принадлежит чужому namespace'у). */
export class FactNotFoundError extends Error {
  constructor() {
    super('Факт не найден');
    this.name = 'FactNotFoundError';
  }
}

/** Для режима `supersede` не передан новый текст факта. */
export class SupersedeTextRequiredError extends Error {
  constructor() {
    super('Для замены факта (supersede) нужен новый текст факта');
    this.name = 'SupersedeTextRequiredError';
  }
}

/** Привести число к диапазону; нечисловое значение — дефолт. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

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
 * Провайдер памяти плагина (М1).
 *
 * Обёртка над `facade.memory.facts`: скоуп, порядок, скоринг и запись.
 * Блоки промпта и туны ходят в хранилище **только** через него.
 */
export class MemoryProviderLite {
  private readonly _facade: PluginFacade;

  constructor(facade: PluginFacade) {
    this._facade = facade;
  }

  /** Доступен ли сервис памяти в этом инстансе (фича-детект). */
  get available(): boolean {
    return this._facade.memory !== undefined;
  }

  /** Настройки плагина — нормализованные (вне диапазона → дефолт). */
  settings(): MemoryPluginSettings {
    const raw = this._facade.getSettings();
    return {
      factsLimit: clampNumber(
        raw.factsLimit,
        MIN_FACTS_LIMIT,
        MAX_FACTS_LIMIT,
        DEFAULT_FACTS_LIMIT,
      ),
      recallLimit: clampNumber(
        raw.recallLimit,
        MIN_RECALL_LIMIT,
        MAX_RECALL_LIMIT,
        DEFAULT_RECALL_LIMIT,
      ),
      minScore: clampNumber(raw.minScore, 0, 1, DEFAULT_MIN_SCORE),
    };
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
   */
  async listFacts(opts: {
    status?: 'active' | 'candidate' | 'all';
    kind?: string;
    /** Проект сессии (`ctx.projectId`); не задан — только факты без проекта. */
    projectId?: string;
  }): Promise<MemoryFactRecord[]> {
    const query: MemoryFactQuery = { limit: CANDIDATE_LIMIT };
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
}
