/**
 * М2: ошибки плагина памяти.
 *
 * Вынесены отдельным модулем, чтобы «движок» (менеджер индексов, поиск) и
 * «доставка» (провайдер, блоки, тулы) не зависели друг от друга циклически:
 * и те и другие бросают одни и те же ошибки.
 */

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

/** Индекс памяти не найден (нет такого id или он чужого namespace'а). */
export class IndexNotFoundError extends Error {
  constructor() {
    super('Индекс памяти не найден');
    this.name = 'IndexNotFoundError';
  }
}

/** Сборка индекса уже идёт (повторный запуск без `force`). */
export class IndexBusyError extends Error {
  constructor() {
    super('Сборка индекса уже выполняется — дождитесь окончания или повторите с force');
    this.name = 'IndexBusyError';
  }
}

/**
 * Консолидация не выполнена (М4a).
 *
 * Ошибка **внутри** плагина: несоответствие эмбеддингов порту или отказ записи
 * в порт. Ошибки сервисов фасада (`facade.embed`) пробрасываются как есть —
 * их различает вызывающий (у них есть машиночитаемый код).
 */
export class ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsolidationError';
  }
}
