/**
 * ADR-098 (W5): runtime-состояние деградированного хранилища для оси
 * доступности тулов (`engine/permission/availability.ts`).
 *
 * При недоступности выбранного backend'а (PostgreSQL) сервис поднимается на
 * файловом фоллбеке в строгом read-only (ADR-096). Orchestrator
 * вычисляет доступность тулов через `computeToolAvailability`, но не имеет
 * аргумента «состояние хранилища» в пробрасываемой цепочке — поэтому состояние
 * публикуется здесь (единственная точка записи — `createStorageContextAsync`
 * при сборке **основного** контекста, диагностические `schemaMode: 'skip'`
 * контексты его не трогают).
 *
 * Состояние — не модульный синглтон хранилища (ADR-096 запрещает синглтоны
 * портов), а рантайм-флаг окружения: одна сборка приложения — одно состояние.
 */

/** Состояние доступности хранилища (для оси доступности тулов). */
export interface StorageAvailabilityState {
  /** Хранилище недоступно, сервис на файловом фоллбеке (read-only). */
  degraded: boolean;
  /** Каталог файлового фоллбека (для подсказки модели/диагностики). */
  fallbackDir?: string;
  /** Человекочитаемая причина недоступности backend'а. */
  reason?: string;
}

const HEALTHY: StorageAvailabilityState = { degraded: false };

let state: StorageAvailabilityState = HEALTHY;

/**
 * Опубликовать состояние деградации (или `null` — хранилище в норме).
 * Вызывается из `createStorageContextAsync` при сборке основного контекста.
 */
export function setStorageDegradedState(
  next: { degraded: boolean; fallbackDir?: string; reason?: string } | null,
): void {
  state = next && next.degraded
    ? { degraded: true, fallbackDir: next.fallbackDir, reason: next.reason }
    : HEALTHY;
}

/** Хранилище сейчас в деградированном (read-only) режиме? */
export function isStorageDegraded(): boolean {
  return state.degraded;
}

/** Текущее состояние (снимок для диагностики/тестов). */
export function getStorageDegradedState(): StorageAvailabilityState {
  return state;
}
