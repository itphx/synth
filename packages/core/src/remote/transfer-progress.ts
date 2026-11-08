// Прогресс переноса проекта (publish: локальный мир → сервер).
//
// Долгая операция публикации не даёт обратной связи: UI нужен прогресс в
// процентах, доступный **опросом** (новый канал событий не вводим — инвариант 6).
// Здесь живут три вещи:
//   1. тип снапшота `TransferProgress` (контракт HTTP-ответа);
//   2. чистая функция `computeTransferPercent` — правила весов и монотонности;
//   3. `TransferProgressRegistry` — in-memory снапшоты на процесс (ключ
//      `${userId}:${projectId}`, TTL ~10 минут).
//
// Снапшот не персистится: после рестарта процесса прогресс неизвестен (idle),
// а сама публикация всё равно оборвалась.

/** Фаза публикации: создание проекта → сессии → файлы → финал. */
export type TransferPhase = 'idle' | 'project' | 'sessions' | 'files' | 'done' | 'error';

/**
 * Снапшот прогресса переноса проекта (контракт `GET /projects/:id/publish/progress`).
 *
 * Только счётчики: путей, имён файлов и секретов здесь нет и быть не должно.
 */
export interface TransferProgress {
  active: boolean;
  phase: TransferPhase;
  /** Целое 0..100, монотонно не убывает (clamp к предыдущему максимуму). */
  percent: number;
  sessions: { done: number; total: number };
  files: { done: number; total: number; bytesDone: number; bytesTotal: number };
  startedAt: string | null;
  updatedAt: string | null;
  error: string | null;
}

/** Частичное обновление снапшота (счётчики сливаются по полям). */
export interface TransferProgressPatch {
  active?: boolean;
  phase?: TransferPhase;
  /** Явный процент: клампится в 0..100 и не опускается ниже текущего. */
  percent?: number;
  sessions?: Partial<TransferProgress['sessions']>;
  files?: Partial<TransferProgress['files']>;
  startedAt?: string | null;
  error?: string | null;
}

/** Вход чистого расчёта процента. */
export interface TransferPercentInput {
  sessions: { done: number; total: number };
  files: { done: number; total: number; bytesDone: number; bytesTotal: number };
  /** Предыдущий максимум — гарантия монотонности (по умолчанию 0). */
  percent?: number;
}

/** TTL снапшота: после завершения запись живёт ~10 минут, затем — idle. */
export const TRANSFER_PROGRESS_TTL_MS = 10 * 60 * 1000;

/** Максимальная длина текста ошибки в снапшоте (краткий текст, без стектрейса). */
const MAX_ERROR_CHARS = 300;

/** Значения по умолчанию (никогда не запускали / неизвестный проект). */
export function emptyTransferProgress(): TransferProgress {
  return {
    active: false,
    phase: 'idle',
    percent: 0,
    sessions: { done: 0, total: 0 },
    files: { done: 0, total: 0, bytesDone: 0, bytesTotal: 0 },
    startedAt: null,
    updatedAt: null,
    error: null,
  };
}

/** Ключ снапшота: чужой пользователь не должен видеть чужой прогресс. */
export function transferProgressKey(userId: string, projectId: string): string {
  return `${userId}:${projectId}`;
}

/** Целое 0..100; NaN/мусор → 0. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Доля выполнения 0..1; знаменатель ≤ 0 → 0. */
function safeRatio(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/**
 * Процент публикации (чистая функция).
 *
 * Правила:
 * - обе фазы непусты — сессии 50 %, файлы 50 % (файлы считаются **по байтам**);
 * - сессий нет — файлы 100 %;
 * - файлов нет — сессии 100 %;
 * - обе фазы пусты — 0 % (на финише `complete`/`finish` ставит 100 %);
 * - результат — целое 0..100 и **не убывает**: клампится к `percent` (прежний
 *   максимум), иначе округление/скачки счётчиков давали бы откат полосы назад.
 *
 * Файлы без байтов (пустые файлы → `bytesTotal === 0`) считаются по количеству:
 * иначе фаза «файлы» навсегда осталась бы на 0 %.
 */
export function computeTransferPercent(input: TransferPercentInput): number {
  const previous = clampPercent(input.percent ?? 0);

  const sessionsTotal = Number.isFinite(input.sessions.total) ? Math.max(0, input.sessions.total) : 0;
  const filesTotal = Number.isFinite(input.files.total) ? Math.max(0, input.files.total) : 0;
  const bytesTotal = Number.isFinite(input.files.bytesTotal) ? Math.max(0, input.files.bytesTotal) : 0;

  const sessionsRatio = safeRatio(input.sessions.done, sessionsTotal);
  const filesRatio = bytesTotal > 0
    ? safeRatio(input.files.bytesDone, bytesTotal)
    : safeRatio(input.files.done, filesTotal);

  const sessionsPresent = sessionsTotal > 0;
  const filesPresent = filesTotal > 0;

  let raw: number;
  if (sessionsPresent && filesPresent) raw = sessionsRatio * 50 + filesRatio * 50;
  else if (sessionsPresent) raw = sessionsRatio * 100;
  else if (filesPresent) raw = filesRatio * 100;
  else raw = 0;

  return Math.max(previous, clampPercent(raw));
}

/** Копия снапшота (наружу не отдаём внутренние объекты). */
function cloneProgress(progress: TransferProgress): TransferProgress {
  return {
    ...progress,
    sessions: { ...progress.sessions },
    files: { ...progress.files },
  };
}

/**
 * Краткий текст ошибки для снапшота: первая строка, без стектрейса и лишнего.
 * Полный текст ошибки уходит в HTTP-ответ POST; здесь — только подпись для UI.
 */
export function sanitizeTransferError(message: unknown): string {
  const text = message instanceof Error
    ? message.message
    : typeof message === 'string'
      ? message
      : message === null || message === undefined
        ? ''
        : String(message);
  const firstLine = text.split(/\r?\n/u)[0]?.trim() ?? '';
  return firstLine.slice(0, MAX_ERROR_CHARS) || 'Ошибка публикации';
}

export interface TransferProgressRegistryOptions {
  /** TTL снапшота, мс (по умолчанию 10 минут). */
  ttlMs?: number;
  /** Источник времени (тесты); по умолчанию `Date.now`. */
  now?: () => number;
}

interface ProgressEntry {
  progress: TransferProgress;
  expiresAt: number;
}

/**
 * In-memory реестр снапшотов прогресса переноса (один на процесс).
 *
 * Записи не персистятся: прогресс живёт, пока идёт публикация, и ещё `ttlMs`
 * после неё (снапшот `done`/`error` полезен UI, если он опоздал с опросом).
 * Очистка ленивая (на каждом обращении) + фоновый таймер `unref`, чтобы TTL
 * работал и без запросов; таймер не держит процесс.
 */
export class TransferProgressRegistry {
  private readonly entries = new Map<string, ProgressEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TransferProgressRegistryOptions = {}) {
    this.ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0
      ? options.ttlMs
      : TRANSFER_PROGRESS_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Начать публикацию: активный снапшот с фазы `project`. */
  begin(key: string): TransferProgress {
    this._prune();
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const progress: TransferProgress = {
      ...emptyTransferProgress(),
      active: true,
      phase: 'project',
      startedAt: nowIso,
      updatedAt: nowIso,
    };
    this._set(key, progress, nowMs);
    return cloneProgress(progress);
  }

  /** Обновить снапшот: счётчики сливаются, процент пересчитывается (монотонно). */
  update(key: string, patch: TransferProgressPatch = {}): TransferProgress {
    const nowMs = this.now();
    const current = this.entries.get(key)?.progress ?? emptyTransferProgress();
    const nowIso = new Date(nowMs).toISOString();

    const sessions = { ...current.sessions, ...(patch.sessions ?? {}) };
    const files = { ...current.files, ...(patch.files ?? {}) };
    const percent = patch.percent !== undefined
      ? Math.max(current.percent, clampPercent(patch.percent))
      : computeTransferPercent({ sessions, files, percent: current.percent });

    const progress: TransferProgress = {
      active: patch.active ?? current.active,
      phase: patch.phase ?? current.phase,
      percent,
      sessions,
      files,
      startedAt: patch.startedAt !== undefined
        ? patch.startedAt
        : (current.startedAt ?? nowIso),
      updatedAt: nowIso,
      error: patch.error !== undefined ? patch.error : current.error,
    };
    this._set(key, progress, nowMs);
    return cloneProgress(progress);
  }

  /** Успешное завершение: снапшот `done`, 100 %, счётчики доведены до totals. */
  complete(key: string): TransferProgress {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const current = this.entries.get(key)?.progress ?? emptyTransferProgress();
    const progress: TransferProgress = {
      ...current,
      active: false,
      phase: 'done',
      percent: 100,
      sessions: { done: current.sessions.total, total: current.sessions.total },
      files: {
        done: current.files.total,
        total: current.files.total,
        bytesDone: current.files.bytesTotal,
        bytesTotal: current.files.bytesTotal,
      },
      startedAt: current.startedAt ?? nowIso,
      updatedAt: nowIso,
      error: null,
    };
    this._set(key, progress, nowMs);
    return cloneProgress(progress);
  }

  /** Ошибка публикации: снапшот `error` с кратким текстом (без секретов/стектрейсов). */
  fail(key: string, message: unknown): TransferProgress {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const current = this.entries.get(key)?.progress ?? emptyTransferProgress();
    const progress: TransferProgress = {
      ...current,
      active: false,
      phase: 'error',
      startedAt: current.startedAt ?? nowIso,
      updatedAt: nowIso,
      error: sanitizeTransferError(message),
    };
    this._set(key, progress, nowMs);
    return cloneProgress(progress);
  }

  /** Текущий снапшот; неизвестный/истёкший ключ — значения по умолчанию (idle). */
  get(key: string): TransferProgress {
    this._prune();
    const entry = this.entries.get(key);
    return entry ? cloneProgress(entry.progress) : emptyTransferProgress();
  }

  /** Число живых записей (диагностика/тесты). */
  size(): number {
    return this.entries.size;
  }

  /** Полная очистка (тесты/остановка процесса). */
  clear(): void {
    this.entries.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Идемпотентный алиас `clear` для симметрии с другими сервисами. */
  dispose(): void {
    this.clear();
  }

  private _set(key: string, progress: TransferProgress, nowMs: number): void {
    this.entries.set(key, { progress, expiresAt: nowMs + this.ttlMs });
    this._scheduleTimer();
  }

  private _prune(): void {
    const nowMs = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private _scheduleTimer(): void {
    if (this.timer) return;
    const interval = Math.min(60_000, Math.max(1_000, Math.floor(this.ttlMs / 2)));
    this.timer = setInterval(() => {
      this._prune();
    }, interval);
    // Фоновая уборка не должна держать процесс живым.
    this.timer.unref?.();
  }
}
