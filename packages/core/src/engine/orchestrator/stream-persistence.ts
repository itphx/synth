/**
 * Шаг 2б: персистентность **частичного** стрима.
 *
 * `StreamMessageDraft` — черновик assistant-сообщения текущей итерации:
 * - первое непустое содержимое сразу дозаписывается в историю
 *   (`SessionManager.appendMessage`) с `metadata.streaming = true`, поэтому
 *   падение/рестарт посреди хода не теряет уже показанный пользователю текст;
 * - последующие изменения пишутся с троттлингом (`intervalMs`/`minChars`),
 *   не блокируя стрим: запись сериализована (in-flight guard + dirty-флаг),
 *   ошибки хранилища только логируются;
 * - финал переиспользует ту же запись (`updateMessage`), а не добавляет
 *   вторую — в истории не появляется дубль assistant-сообщения;
 * - `abort` оставляет частичный текст с `interrupted/status='error'`.
 *
 * Модуль не зависит от оркестратора — юнит-тестируется с моком
 * `Pick<SessionManager,'appendMessage'|'updateMessage'>` и фейковыми таймерами.
 */
import type { Message, MessageStatus, Part, TokenUsage } from '@itphx/synth-shared';
import { generateId, makeTextPart, nowISO } from '@itphx/synth-shared';
import type { SessionManager } from '../../sessions/manager.js';
import { withDeterministicPartIds } from './turn-events.js';

/** Ссылка на запись черновика в истории (нужна финальному `updateMessage`). */
export interface StreamMessageRef {
  id: string;
  seq: number;
}

/** Поля сообщения, которые можно заменить в `finalize`. */
export type StreamMessagePatch = Partial<
  Pick<Message, 'content' | 'reasoning' | 'toolCalls' | 'metadata' | 'model' | 'parts' | 'status' | 'usage'>
>;

export interface StreamMessageDraftOptions {
  sessionManager: Pick<SessionManager, 'appendMessage' | 'updateMessage'>;
  sessionId: string;
  /** Базовые поля assistant-сообщения (без `id`/`seq`/`content`/`parts`/`createdAt`). */
  base: Omit<Message, 'id' | 'seq' | 'content' | 'parts' | 'createdAt'>;
  /**
   * ADR-118 §5: заранее выбранный идентификатор сообщения шага.
   *
   * Идентификатор должен быть известен **до** первого чанка — по нему
   * публикуются `step.started`/`part.delta`. Если не задан — выдаётся
   * сгенерированный (прежнее поведение).
   */
  id?: string;
  /** Минимальный интервал между записями (мс). По умолчанию 1000. */
  intervalMs?: number;
  /** Прирост контента (символы), при котором пишем не дожидаясь интервала. По умолчанию 4096. */
  minChars?: number;
  /** Куда сообщать об ошибках записи (по умолчанию — `console.warn`). */
  warn?: (msg: string) => void;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MIN_CHARS = 4096;

/**
 * Черновик частичного assistant-сообщения. Все методы, кроме `push`,
 * асинхронны; `push` намеренно синхронный и не бросает — он вызывается из
 * цикла чанков и не должен влиять на стрим.
 */
export class StreamMessageDraft {
  private readonly _sessionManager: Pick<SessionManager, 'appendMessage' | 'updateMessage'>;
  private readonly _sessionId: string;
  private readonly _base: Omit<Message, 'id' | 'seq' | 'content' | 'parts' | 'createdAt'>;
  private readonly _intervalMs: number;
  private readonly _minChars: number;
  private readonly _warn: (msg: string) => void;

  /** Предварительно сгенерированный id (используется при первом append). */
  private readonly _draftId: string;
  private _ref: StreamMessageRef | null = null;

  private _content = '';
  private _reasoning = '';
  /** Anthropic: подпись thinking-блока текущей итерации (может быть пустой). */
  private _reasoningSignature: string | undefined;
  /** Anthropic: opaque-данные `redacted_thinking` текущей итерации. */
  private _reasoningRedacted: string[] | undefined;
  private _model: string | undefined;

  private _appendPromise: Promise<void> | null = null;
  private _inflight: Promise<void> | null = null;
  private _dirty = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  private _persistedContent = '';
  private _persistedReasoning = '';
  private _lastPersistedAt: number;

  private _warned = false;
  private _closed = false;

  constructor(options: StreamMessageDraftOptions) {
    this._sessionManager = options.sessionManager;
    this._sessionId = options.sessionId;
    this._base = options.base;
    this._intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this._minChars = Math.max(1, options.minChars ?? DEFAULT_MIN_CHARS);
    this._warn = options.warn ?? ((msg) => console.warn(msg));
    this._model = options.base.model;
    this._lastPersistedAt = Date.now();
    this._draftId = options.id ?? generateId();
  }

  /** Текущая ссылка на запись черновика (`null` — черновик ещё не создан). */
  ref(): StreamMessageRef | null {
    return this._ref ? { ...this._ref } : null;
  }

  /**
   * ADR-118 §5: идентификатор сообщения шага.
   *
   * Известен до первой записи — по нему публикуются `step.started` и
   * `part.delta` (клиент адресует части по `{messageId, partId}`).
   */
  messageId(): string {
    return this._ref?.id ?? this._draftId;
  }

  /**
   * Актуализирует содержимое и (при необходимости) планирует запись.
   * Не блокирует стрим и не бросает исключений.
   */
  push(
    content: string,
    reasoning: string,
    model?: string,
    /**
     * Anthropic: подпись thinking-блока и opaque-данные `redacted_thinking`
     * текущей итерации. Приходят из чанков; без возврата в историю провайдер
     * отвергает следующий запрос tool-loop.
     */
    reasoningMeta?: { signature?: string; redacted?: string[] },
  ): void {
    if (this._closed) return;
    this._content = content;
    this._reasoning = reasoning;
    this._reasoningSignature = reasoningMeta?.signature;
    this._reasoningRedacted = reasoningMeta?.redacted;
    if (model) this._model = model;

    if (!this._ref) {
      // Первое непустое содержимое — сразу создаём запись.
      if (!this._appendPromise) {
        if (!content && !reasoning) return;
        this._appendPromise = this._append();
        void this._appendPromise.then(() => this._afterAppend());
      }
      return;
    }

    this._dirty = true;
    this._schedule();
  }

  /**
   * Записать актуальное содержимое (сериализовано: пока идёт запись, новые
   * вызовы лишь помечают черновик «грязным» и дописываются после).
   */
  async flush(): Promise<void> {
    // После `finalize`/`abort`/`dispose` поздняя троттлинг-запись не должна
    // «воскрешать» шаг: `status: 'streaming'` вернул бы закрытый шаг в живое
    // состояние и затёр бы терминальную запись (metadata, content, parts).
    if (this._closed) return;
    if (!this._ref) {
      if (this._appendPromise) await this._appendPromise;
      if (!this._ref || this._closed) return;
    }
    if (this._inflight) {
      this._dirty = true;
      await this._inflight;
      if (this._dirty && !this._closed) await this.flush();
      return;
    }
    if (!this._dirty) return;

    this._dirty = false;
    const write = this._write({ streaming: true });
    this._inflight = write;
    try {
      await write;
    } finally {
      if (this._inflight === write) this._inflight = null;
    }
    // Пока шла запись, могли прийти новые чанки — дописываем.
    if (this._dirty && !this._closed) await this.flush();
  }

  /**
   * Финализация: дождаться текущей записи, остановить таймер и заменить
   * сообщение патчем (metadata — целиком, без `streaming`).
   */
  async finalize(patch: StreamMessagePatch): Promise<StreamMessageRef | null> {
    this._stopTimer();
    this._closed = true;

    if (!this._ref && this._appendPromise) await this._appendPromise;
    if (this._inflight) {
      try {
        await this._inflight;
      } catch {
        // ошибка уже обработана в `_write`; финализация не должна падать
      }
    }

    if (!this._ref) {
      // Итерация без текста/рассуждений, но с tool_calls (типичный ответ
      // модели «только вызовы»): черновик не создавался — создаём запись
      // сразу финальной. Для пустого финального ответа (без tool_calls)
      // возвращаем `null` — вызывающая сторона добавит сообщение сама.
      if (!patch.toolCalls || patch.toolCalls.length === 0) return null;
      const appended = await this._appendFinal(patch);
      return appended;
    }

    const content = patch.content ?? this._content;
    const metadata = patch.metadata ?? { ...(this._base.metadata ?? {}) };
    const message = this._buildMessage({
      content,
      parts: patch.parts ?? [makeTextPart(content)],
      reasoning: patch.reasoning ?? this._reasoning,
      toolCalls: patch.toolCalls,
      model: patch.model ?? this._model,
      // ADR-102/ADR-118: usage сообщения шага — расход **своего** вызова
      // провайдера (сумма usage сообщений хода = расход хода).
      usage: patch.usage,
      metadata,
      // ADR-118 §5: «финал» = смена статуса сообщения. Черновик жил со
      // статусом `streaming`, финал — терминальный (`completed` по умолчанию).
      status: patch.status ?? 'completed',
    });

    try {
      const saved = await this._sessionManager.updateMessage(this._sessionId, message);
      // `null` — сообщение не найдено (битый/удалённый файл, гонка): шаг
      // останется `streaming`, поэтому это не тишина, а диагностика.
      if (!saved) {
        this._warnOnce(
          `StreamMessageDraft: финальная запись шага не применена (сообщение не найдено): ${this.messageId()}`,
        );
      }
    } catch (e) {
      this._warnOnce(`StreamMessageDraft: не удалось финализировать сообщение: ${errorText(e)}`);
    }
    return this.ref();
  }

  /** Остановить таймер и дождаться текущей записи, ничего не записывая. */
  async dispose(): Promise<void> {
    this._stopTimer();
    this._closed = true;
    if (this._appendPromise) {
      try {
        await this._appendPromise;
      } catch {
        // уже обработано
      }
    }
    if (this._inflight) {
      try {
        await this._inflight;
      } catch {
        // уже обработано
      }
    }
  }

  /**
   * Прервать черновик: сохранить частичный текст с
   * `streaming:false`, `interrupted:true`, `status:'error'`.
   *
   * ADR-118 §5: статус сообщения — терминальный (`cancelled` — генерация
   * прервана, `error` — сбой провайдера); вызывающая сторона решает, какой.
   */
  async abort(reason?: string, status: MessageStatus = 'cancelled'): Promise<void> {
    this._stopTimer();
    this._closed = true;

    if (this._appendPromise) {
      try {
        await this._appendPromise;
      } catch {
        // уже обработано
      }
    }
    if (this._inflight) {
      try {
        await this._inflight;
      } catch {
        // уже обработано
      }
    }
    if (!this._ref) return;

    const message = this._buildMessage({
      content: this._content,
      parts: [makeTextPart(this._content)],
      reasoning: this._reasoning,
      model: this._model,
      metadata: {
        ...(this._base.metadata ?? {}),
        streaming: false,
        interrupted: true,
        status: 'error',
        ...(reason ? { interrupted_reason: reason } : {}),
      },
      status,
    });

    try {
      const saved = await this._sessionManager.updateMessage(this._sessionId, message);
      // `null` — сообщение не найдено: частичный текст не сохранён, запись
      // осталась в промежуточном состоянии — предупреждаем.
      if (!saved) {
        this._warnOnce(
          `StreamMessageDraft: прерванный стрим не сохранён (сообщение не найдено): ${this.messageId()}`,
        );
      }
    } catch (e) {
      this._warnOnce(`StreamMessageDraft: не удалось сохранить прерванный стрим: ${errorText(e)}`);
    }
  }

  // --- внутреннее -------------------------------------------------------

  /** Создать сразу финальную запись (итерация без чанков, но с tool_calls). */
  private async _appendFinal(patch: StreamMessagePatch): Promise<StreamMessageRef | null> {
    const content = patch.content ?? this._content;
    const message = this._buildMessage({
      content,
      parts: patch.parts ?? [makeTextPart(content)],
      reasoning: patch.reasoning ?? this._reasoning,
      toolCalls: patch.toolCalls,
      model: patch.model ?? this._model,
      usage: patch.usage,
      metadata: patch.metadata ?? { ...(this._base.metadata ?? {}) },
      status: patch.status ?? 'completed',
    });
    try {
      const saved = await this._sessionManager.appendMessage(this._sessionId, message);
      if (!saved) {
        this._warnOnce('StreamMessageDraft: сессия не найдена, сообщение не сохранено');
        return null;
      }
      this._ref = { id: saved.id, seq: saved.seq };
      return this.ref();
    } catch (e) {
      this._warnOnce(`StreamMessageDraft: не удалось сохранить сообщение: ${errorText(e)}`);
      return null;
    }
  }

  private async _append(): Promise<void> {    // Фиксируем записываемое содержимое: пока идёт запись, `push` мог уже
    // обновить `_content` — сравнивать нужно именно с тем, что записано.
    const content = this._content;
    const reasoning = this._reasoning;
    const message = this._buildMessage({
      content,
      parts: [makeTextPart(content)],
      reasoning,
      model: this._model,
      metadata: { ...(this._base.metadata ?? {}), streaming: true },
      // ADR-118 §5: черновик живёт со статусом `streaming` — «финал» это
      // смена статуса, а не замена объекта.
      status: 'streaming',
    });
    try {
      const saved = await this._sessionManager.appendMessage(this._sessionId, message);
      if (!saved) {
        this._warnOnce('StreamMessageDraft: сессия не найдена, частичный стрим не сохранён');
        return;
      }
      this._ref = { id: saved.id, seq: saved.seq };
      this._persistedContent = content;
      this._persistedReasoning = reasoning;
      this._lastPersistedAt = Date.now();
    } catch (e) {
      this._warnOnce(`StreamMessageDraft: не удалось сохранить частичный стрим: ${errorText(e)}`);
    }
  }

  /** После создания записи: если содержимое уже изменилось — планируем запись. */
  private _afterAppend(): void {
    if (!this._ref || this._closed) return;
    if (this._content !== this._persistedContent || this._reasoning !== this._persistedReasoning) {
      this._dirty = true;
      this._schedule();
    }
  }

  private _schedule(): void {
    if (this._closed || !this._ref || this._timer) return;

    const elapsed = Date.now() - this._lastPersistedAt;
    const growth = this._content.length - this._persistedContent.length;
    if (elapsed >= this._intervalMs || growth >= this._minChars) {
      void this.flush();
      return;
    }

    const delay = Math.max(0, this._intervalMs - elapsed);
    const timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, delay);
    // Не держим процесс живым из-за таймера персистентности.
    (timer as unknown as { unref?: () => void }).unref?.();
    this._timer = timer;
  }

  private _stopTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private async _write(flags: { streaming: boolean }): Promise<void> {
    // Defense in depth: между `await`-ами вызывающего `_closed` мог стать true
    // (`finalize`/`abort`/`dispose` уже записали терминальное состояние).
    if (this._closed) return;
    if (!this._ref) return;

    const content = this._content;
    const reasoning = this._reasoning;
    const message = this._buildMessage({
      content,
      parts: [makeTextPart(content)],
      reasoning,
      model: this._model,
      metadata: {
        ...(this._base.metadata ?? {}),
        streaming: flags.streaming,
      },
      // ADR-118 §5: инкрементальная запись черновика — статус `streaming`.
      status: 'streaming',
    });

    try {
      const saved = await this._sessionManager.updateMessage(this._sessionId, message);
      if (!saved) {
        // `null` — сообщение не найдено: инкрементальная запись не применилась.
        // `_warnOnce` дедуплицирует по черновику, поэтому спама нет.
        this._warnOnce(
          `StreamMessageDraft: частичный стрим не обновлён (сообщение не найдено): ${this.messageId()}`,
        );
        return;
      }
      this._persistedContent = content;
      this._persistedReasoning = reasoning;
      this._lastPersistedAt = Date.now();
    } catch (e) {
      this._warnOnce(`StreamMessageDraft: не удалось обновить частичный стрим: ${errorText(e)}`);
    }
  }

  private _buildMessage(overrides: {
    content: string;
    parts: Part[];
    reasoning?: string;
    toolCalls?: Record<string, unknown>[];
    model?: string;
    /** ADR-102: расход своего шага (передаётся только при финализации). */
    usage?: TokenUsage;
    metadata: Record<string, unknown>;
    /** ADR-118 §5: статус сообщения (`streaming` → терминальный). */
    status?: MessageStatus;
  }): Message {
    return {
      ...this._base,
      id: this._ref?.id ?? this._draftId,
      seq: this._ref?.seq ?? 0,
      // ADR-118 §1: части черновика — с теми же детерминированными id, что и
      // в стриме (`msg:text:N`) и в финальном сообщении шага: финализация
      // заменяет набор частей, и id остаются стабильными (клиент мержит части
      // по id — иначе текст ответа дублируется).
      parts: withDeterministicPartIds(overrides.parts),
      content: overrides.content,
      createdAt: nowISO(),
      ...(overrides.reasoning !== undefined ? { reasoning: overrides.reasoning } : {}),
      ...(this._reasoningSignature !== undefined ? { reasoningSignature: this._reasoningSignature } : {}),
      ...(this._reasoningRedacted?.length ? { reasoningRedacted: this._reasoningRedacted } : {}),
      ...(overrides.toolCalls !== undefined ? { toolCalls: overrides.toolCalls } : {}),
      ...(overrides.model !== undefined ? { model: overrides.model } : {}),
      ...(overrides.usage !== undefined ? { usage: overrides.usage } : {}),
      ...(overrides.status !== undefined ? { status: overrides.status } : {}),
      metadata: overrides.metadata,
    };
  }

  private _warnOnce(message: string): void {
    if (this._warned) return;
    this._warned = true;
    try {
      this._warn(message);
    } catch {
      // логгер не должен ломать персистентность
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
