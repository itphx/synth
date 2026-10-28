/**
 * PG-реализация порта **файлов контекста/промптов** (ADR-069/ADR-070, ADR-116,
 * ADR-097): пользовательская часть (`user`/`role` и override системных
 * промптов) — строки таблицы `context_files`, системная часть (промпты образа
 * `{packageRoot}/prompts`) остаётся ФС.
 *
 * Разделение:
 * - **системные промпты** (роли, `prompts/system/**`, `prompts/security/**`)
 *   читаются файловой реализацией core (`ContextConfig`) — те же ассеты, что и
 *   раньше; они не меняются в runtime и в БД не дублируются;
 * - **пользовательские override'ы** — строки `(category, filename)` в таблице
 *   (миграция `027_context_files`); категории — доменные
 *   (`user`/`role`/`system`), т. е. ровно те, что принимает порт. Это уточнение
 *   к наброску миграции (`'user' | 'roles'`): категория `system` — override
 *   системного промпта (`{context}/user/system/**` в файловой раскладке), без
 *   неё UI-переопределение промптов режимов/безопасности не переносится.
 *
 * ## Почему кэш, а не запрос на каждый геттер
 *
 * Порт **синхронный** (сборка промпта на горячем пути, ADR-070): геттеры не
 * могут ждать I/O. Поэтому строки держатся в процесс-локальном кэше
 * (`Map`), который:
 * - прогревается при сборке контекста (`initialize()` → `warm()`);
 * - обновляется после каждой записи (`saveFile`/`deleteFile` → `warm()`);
 * - инвалидируется по сигнатуре **максимума `updated_at`** таблицы: синхронный
 *   геттер не чаще `signatureTtlMs` запускает **фоновую** проверку
 *   (`SELECT max(updated_at)`); при расхождении строка перечитывается целиком.
 *   Так правка, сделанная другим процессом/репликой, становится видимой без
 *   рестарта (с задержкой до TTL), а горячий путь не блокируется.
 *
 * Ошибки фоновой проверки не влияют на чтение: остаётся последний удачный кэш
 * (деградация не превращается в пустой промпт).
 */

import type { ContextCategory, ContextFileContent, ContextFileInfo } from '@itphx/synth-shared';
import type { ContextFileRepository, StorageContext } from '@itphx/synth-core';
import type { PortDeps } from './deps.js';
import { toIso, toIsoRequired } from './events-core.js';

/** Часть `StorageContext`, которой владеет группа «contextFiles». */
export type ContextFilePorts = Pick<StorageContext, 'contextFiles'>;

/** Доменные категории override-файлов (значения колонки `category`). */
const OVERRIDE_CATEGORIES: readonly ContextCategory[] = ['user', 'role', 'system'];

/** Период фоновой проверки сигнатуры `updated_at` по умолчанию, мс. */
const DEFAULT_SIGNATURE_TTL_MS = 5_000;

/** Кэшированная запись пользовательского файла. */
interface CachedContextFile {
  category: ContextCategory;
  filename: string;
  content: string;
  /** Размер содержимого, байт (utf-8). */
  size: number;
  /** Время последней записи, мс (эпоха). */
  modifiedAt: number;
}

type ContextFileRow = {
  category: string;
  filename: string;
  content: string;
  updated_at: Date | string;
};

/**
 * Источник пользовательских override-файлов для файловой реализации
 * (`ContextConfig`): структурный контракт, чтобы драйвер не тянул core
 * рантаймом (тип живёт в `engine/context/config.ts` core).
 */
export interface ContextOverrideSourceLike {
  has(category: ContextCategory, filename: string): boolean;
  read(category: ContextCategory, filename: string): string | null;
  list(): Array<{ category: ContextCategory; filename: string; size: number; modifiedAt: number }>;
}

/** Опции сборки порта. */
export interface ContextFilePortOptions {
  /** Корень системных промптов (уже резолвленный файловой реализацией). */
  systemPromptsDir?: string;
  /**
   * Фабрика файловой реализации (`ContextConfig`) с инъекцией
   * пользовательского источника: кэш PG + те же системные промпты образа.
   */
  createConfig: (overrides: ContextOverrideSourceLike) => ContextFileRepository;
  /** Период фоновой проверки сигнатуры `updated_at`, мс (по умолчанию 5000). */
  signatureTtlMs?: number;
}

/**
 * ADR-116: файлы контекста — системные промпты ФС, пользовательская часть в SQL.
 */
export class PgContextFileRepository implements ContextFileRepository, ContextOverrideSourceLike {
  readonly systemPromptsDir: string;

  private readonly _config: ContextFileRepository;
  private readonly _cache = new Map<string, CachedContextFile>();
  private readonly _signatureTtlMs: number;
  /** Сигнатура последнего успешного чтения (`max(updated_at)` в мс, `'0'` — пусто). */
  private _signature = '';
  /** Момент последней фоновой проверки сигнатуры, мс. */
  private _lastCheckAt = 0;
  /** Текущая фоновая проверка (одна на процесс). */
  private _refreshing: Promise<void> | null = null;

  constructor(
    private readonly _deps: PortDeps,
    opts: ContextFilePortOptions,
  ) {
    this.systemPromptsDir = opts.systemPromptsDir ?? '';
    this._signatureTtlMs = Math.max(0, opts.signatureTtlMs ?? DEFAULT_SIGNATURE_TTL_MS);
    // `this` как источник override: `ContextConfig` читает пользовательские
    // файлы из кэша, системные — из ФС.
    this._config = opts.createConfig(this);
  }

  // ── Контракт `ContextOverrideSourceLike` (то, что читает `ContextConfig`) ──

  has(category: ContextCategory, filename: string): boolean {
    this._scheduleRefresh();
    return this._cache.has(this._key(category, filename));
  }

  read(category: ContextCategory, filename: string): string | null {
    this._scheduleRefresh();
    return this._cache.get(this._key(category, filename))?.content ?? null;
  }

  list(): Array<{ category: ContextCategory; filename: string; size: number; modifiedAt: number }> {
    this._scheduleRefresh();
    return [...this._cache.values()].map((entry) => ({
      category: entry.category,
      filename: entry.filename,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
    }));
  }

  // ── Синхронные геттеры порта (делегируются файловой реализации) ───────────

  listAllFiles(): ContextFileInfo[] {
    return this._config.listAllFiles();
  }

  getFile(filename: string, category: ContextCategory): ContextFileContent | null {
    return this._config.getFile(filename, category);
  }

  getEnabledFiles(): string[] {
    return this._config.getEnabledFiles();
  }

  setEnabledFiles(files: string[]): void {
    this._config.setEnabledFiles(files);
  }

  getRolePrompt(agentId: string, contextFileOverride?: string, language?: string): string | null {
    return this._config.getRolePrompt(agentId, contextFileOverride, language);
  }

  getRolesDescription(language?: string): string {
    return this._config.getRolesDescription(language);
  }

  getInterviewTemplate(language?: string): string {
    return this._config.getInterviewTemplate(language);
  }

  getParticipantsNotice(language?: string): string {
    return this._config.getParticipantsNotice(language);
  }

  getSchedulerNotice(language?: string): string {
    return this._config.getSchedulerNotice(language);
  }

  getSchedulerTurnNotice(language?: string): string {
    return this._config.getSchedulerTurnNotice(language);
  }

  getMaxStepsPrompt(language?: string): string {
    return this._config.getMaxStepsPrompt(language);
  }

  getSummarizerPrompt(language?: string): string {
    return this._config.getSummarizerPrompt(language);
  }

  getUserContextTemplate(language?: string): string {
    return this._config.getUserContextTemplate(language);
  }

  getCompressedDialogTemplate(language?: string): string {
    return this._config.getCompressedDialogTemplate(language);
  }

  getAttachmentsDroppedTemplate(language?: string): string {
    return this._config.getAttachmentsDroppedTemplate(language);
  }

  getAudioAsVideoNote(language?: string): string {
    return this._config.getAudioAsVideoNote(language);
  }

  getMediaDeriveTemplate(language?: string): string {
    return this._config.getMediaDeriveTemplate(language);
  }

  getStickyNotesTemplate(language?: string): string {
    return this._config.getStickyNotesTemplate(language);
  }

  getRoutingInstructions(language?: string): string {
    return this._config.getRoutingInstructions(language);
  }

  getRules(language?: string): string {
    return this._config.getRules(language);
  }

  getGatewayInstructions(language?: string): string {
    return this._config.getGatewayInstructions(language);
  }

  getMemoryInstructions(language?: string): string {
    return this._config.getMemoryInstructions(language);
  }

  getSecurityMessage(
    messageId: string,
    language?: string,
    params?: Record<string, string>,
  ): string | null {
    return this._config.getSecurityMessage(messageId, language, params);
  }

  getModePrompt(mode: string, language?: string): string | null {
    return this._config.getModePrompt(mode, language);
  }

  getPlanModePrompt(
    planMode: 'auto' | 'strict' | 'off',
    planApproved: boolean,
    language?: string,
  ): string | null {
    return this._config.getPlanModePrompt(planMode, planApproved, language);
  }

  getPlanGuide(language?: string): string | null {
    return this._config.getPlanGuide(language);
  }

  getModePolicy(language?: string): string | null {
    return this._config.getModePolicy(language);
  }

  getClassificationInstructions(language?: string): string {
    return this._config.getClassificationInstructions(language);
  }

  // ── Запись (пользовательская часть — SQL) ─────────────────────────────────

  async saveFile(filename: string, content: string, category: ContextCategory): Promise<boolean> {
    try {
      await this._deps.connection.query(
        `INSERT INTO context_files (category, filename, content, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (category, filename) DO UPDATE SET
           content = EXCLUDED.content,
           updated_at = now()`,
        [category, filename, content],
      );
      // Кэш и сигнатура — сразу после записи: следующий синхронный геттер видит
      // новое содержимое без ожидания TTL.
      await this.warm();
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(filename: string, category: ContextCategory): Promise<boolean> {
    try {
      const rows = await this._deps.connection.query<{ filename: string }>(
        'DELETE FROM context_files WHERE category = $1 AND filename = $2 RETURNING filename',
        [category, filename],
      );
      if (rows.length === 0) return false;
      await this.warm();
      return true;
    } catch {
      return false;
    }
  }

  /** «Восстановить системный файл» = снять пользовательский override. */
  async restoreFile(filename: string, category: ContextCategory): Promise<boolean> {
    return this.deleteFile(filename, category);
  }

  // ── Кэш и инвалидация ────────────────────────────────────────────────────

  /**
   * Прогрев кэша: чтение всех пользовательских файлов + фиксация сигнатуры.
   * Вызывается при сборке контекста (`initialize`) и после каждой записи.
   */
  async warm(): Promise<void> {
    const rows = await this._deps.connection.query<ContextFileRow>(
      'SELECT category, filename, content, updated_at FROM context_files',
    );
    this._cache.clear();
    let maxUpdatedAt = 0;
    for (const row of rows) {
      const category = row.category as ContextCategory;
      if (!OVERRIDE_CATEGORIES.includes(category)) continue;
      const updatedAt = Date.parse(toIsoRequired(row.updated_at));
      const modifiedAt = Number.isFinite(updatedAt) ? updatedAt : 0;
      maxUpdatedAt = Math.max(maxUpdatedAt, modifiedAt);
      this._cache.set(this._key(category, row.filename), {
        category,
        filename: row.filename,
        content: row.content,
        size: Buffer.byteLength(row.content, 'utf-8'),
        modifiedAt,
      });
    }
    this._signature = String(maxUpdatedAt);
  }

  /** Стартовый прогрев без падения старта: ошибка БД — пустой кэш + предупреждение. */
  async initialize(): Promise<void> {
    try {
      await this.warm();
    } catch (err) {
      console.warn(
        `[context-files] прогрев кэша не удался: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Дождаться текущей фоновой проверки сигнатуры (graceful shutdown/тесты). */
  async pendingRefresh(): Promise<void> {
    await this._refreshing;
  }

  private _key(category: ContextCategory, filename: string): string {
    return `${category}\0${filename}`;
  }

  /**
   * Запустить фоновую проверку сигнатуры, если с прошлой прошло `signatureTtlMs`
   * (и другая ещё не идёт). Синхронный геттер не блокируется.
   */
  private _scheduleRefresh(): void {
    if (this._refreshing) return;
    const now = Date.now();
    if (now - this._lastCheckAt < this._signatureTtlMs) return;
    this._lastCheckAt = now;
    const task = this._refreshIfStale().catch(() => undefined);
    this._refreshing = task;
    // `close()` контекста дожидается фоновых задач до закрытия пула.
    this._deps.trackBackground?.(task);
    void task.finally(() => {
      if (this._refreshing === task) this._refreshing = null;
    });
  }

  /** Перечитать строки, если `max(updated_at)` разошёлся с кэшем. */
  private async _refreshIfStale(): Promise<void> {
    const signature = await this._readSignature();
    if (signature === this._signature) return;
    await this.warm();
  }

  /** Сигнатура таблицы: `max(updated_at)` в миллисекундах (`0` — пусто). */
  private async _readSignature(): Promise<string> {
    const rows = await this._deps.connection.query<{ max: Date | string | null }>(
      'SELECT max(updated_at) AS max FROM context_files',
    );
    const iso = toIso(rows[0]?.max ?? null);
    return iso ? String(Date.parse(iso)) : '0';
  }
}

/**
 * Собрать порт файлов контекста (ADR-116): системные промпты — ФС, пользовательская
 * часть — SQL. Кэш прогревается в фоне при сборке контекста.
 */
export function buildContextFilePorts(
  deps: PortDeps,
  opts: ContextFilePortOptions,
): ContextFilePorts {
  const port = new PgContextFileRepository(deps, opts);
  deps.trackBackground?.(port.initialize());
  return { contextFiles: port };
}
