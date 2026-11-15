/**
 * PROP-132: рендер **видимого экрана** терминала в текст (`terminal_snapshot`).
 *
 * ## Зачем экран, а не поток
 *
 * `terminal_read` отдаёт **поток** вывода — то, что PTY выплюнул по байтам. Для
 * обычных команд это то, что нужно, но для полноэкранных TUI-программ (`htop`,
 * `nvtop`, `tmux`, редакторы) поток бессмысленен: программа перерисовывает
 * экран управляющими последовательностями (курсор вверх, очистка строки,
 * альтернативный буфер), и «склеенный поток» — это километры мусора, в котором
 * не видно текущей картинки. Здесь считается то, что человек **видит**:
 * сетка `cols × rows` после применения всех escape-последовательностей — как
 * `tmux capture-pane -p`.
 *
 * ## Почему headless
 *
 * Эмуляцию VT100…VT5xx (парсер, буфер, wide-символы, перерисовка, скроллы)
 * повторять вручную нельзя — это библиотека на годы. `@xterm/headless` — тот же
 * движок xterm.js, что и в UI терминала, только без DOM: `write(text)` в память,
 * затем чтение буфера. Никакого I/O, портов и процессов: чистый функция-рендер,
 * поэтому её удобно тестировать (`screen.test.ts`).
 *
 * ## ANSI-цвета отбрасываются
 *
 * В текст попадает только **содержимое ячеек** (`translateToString`), без цвета,
 * атрибутов и позиционирования: модель читает текст, а не картинку. Границы
 * строк обрезаются по правому краю (`translateToString(true)`), то есть
 * хвостовые пробелы ячеек в текст не идут.
 *
 * ## Границы
 *
 * - **Пустые хвостовые строки не обрезаются** — решение об обрезке принимает
 *   вызывающий (тул): рендер обязан вернуть ровно `rows` строк. Факт наличия
 *   содержимого — `hasContent`.
 * - **`scrollback > 0`** — в буфере остаются строки выше экрана; для снимка
 *   берётся **видимая** часть (верх буфера прокрутки — `buffer.baseY`), иначе
 *   вместо экрана пришла бы история. При `scrollback = 0` история не хранится,
 *   и `baseY` всегда `0`.
 * - `allowProposedApi` включён: `term.buffer` — proposed API xterm.
 */
import headless from '@xterm/headless';

/**
 * Класс терминала из CJS-пакета.
 *
 * `@xterm/headless@6` — CommonJS (`module.exports.Terminal`), поэтому именованный
 * ESM-импорт в собранном `dist` не резолвится; берём default-импорт (Node отдаёт
 * `module.exports` как default) и достаём класс.
 */
const { Terminal } = headless;

/** Снимок видимого экрана терминала. */
export interface TerminalScreenSnapshot {
  /** Ширина экрана, колонки (как передан `cols`). */
  cols: number;
  /** Высота экрана, строки (как передан `rows`). */
  rows: number;
  /** Ровно `rows` строк экрана сверху вниз; пустые в конце допустимы. */
  lines: string[];
  /** Позиция курсора в координатах экрана (0-based). */
  cursor: { x: number; y: number };
  /** Есть ли на экране хотя бы одна непустая строка. */
  hasContent: boolean;
}

/** Параметры рендера экрана. */
export interface RenderTerminalScreenOptions {
  /** Ширина экрана, колонки (>= 1). */
  cols: number;
  /** Высота экрана, строки (>= 1). */
  rows: number;
  /**
   * Ёмкость буфера прокрутки, строки (по умолчанию `0` — history нет).
   *
   * Влияет только на память эмулятора: в снимок всегда попадает **видимая**
   * часть экрана (`rows` строк), а не история.
   */
  scrollback?: number;
}

/** Привести размер экрана к целому в допустимых границах. */
function normalizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  return integer >= 1 ? integer : fallback;
}

/**
 * Отрисовать видимый экран терминала из потока вывода.
 *
 * Поток прогоняется через headless-эмулятор xterm (все escape-последовательности:
 * перерисовка, очистка, скролл, альтернативный буфер), после чего читается сетка
 * `cols × rows`. Возвращается текст ячеек без цветов/атрибутов; хвостовые
 * пробелы строк обрезаны, пустые хвостовые строки — **нет** (ровно `rows` строк).
 *
 * Ошибок ввода-вывода нет: функция не трогает ни ФС, ни процессы.
 */
export async function renderTerminalScreen(
  text: string,
  options: RenderTerminalScreenOptions,
): Promise<TerminalScreenSnapshot> {
  const cols = normalizeDimension(options.cols, 80);
  const rows = normalizeDimension(options.rows, 24);
  const scrollback = normalizeScrollback(options.scrollback);

  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  try {
    if (text !== '') {
      // `write` асинхронен: колбэк вызывается, когда данные разобраны парсером
      // (до этого буфер может быть недописан — читать его нельзя).
      await new Promise<void>((resolve) => {
        terminal.write(text, () => resolve());
      });
    }

    const buffer = terminal.buffer.active;
    // Видимая часть экрана: при `scrollback > 0` строки выше экрана лежат в
    // буфере (0…baseY-1) — это история, а не экран.
    const top = scrollback > 0 ? buffer.baseY : 0;
    const lines: string[] = [];
    for (let i = 0; i < rows; i += 1) {
      lines.push(buffer.getLine(top + i)?.translateToString(true) ?? '');
    }

    return {
      cols,
      rows,
      lines,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      hasContent: lines.some((line) => line.trim() !== ''),
    };
  } finally {
    terminal.dispose();
  }
}

/** Неотрицательная ёмкость прокрутки (`undefined`/NaN/Infinity → `0`). */
function normalizeScrollback(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
