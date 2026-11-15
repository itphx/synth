/**
 * PROP-132: тесты рендера видимого экрана терминала (`engine/terminal/screen.ts`).
 *
 * Проверяется поведение эмулятора, а не тула: очистка экрана и курсор,
 * переводы строк на границе экрана, соблюдение `cols × rows`, wide-символы
 * (им нельзя «разорвать» строку), `hasContent` и режим `scrollback` (в снимок
 * попадает экран, а не история).
 */
import { describe, it, expect } from 'vitest';
import { renderTerminalScreen } from './screen.js';

/** Отрисовать с параметрами по умолчанию (как у тула: 80×24). */
async function render(text: string, cols = 10, rows = 4, scrollback?: number) {
  return renderTerminalScreen(text, {
    cols,
    rows,
    ...(scrollback !== undefined ? { scrollback } : {}),
  });
}

describe('renderTerminalScreen', () => {
  it('рендерит пустой ввод как пустой экран: ровно rows строк, hasContent=false', async () => {
    const screen = await render('', 10, 3);
    expect(screen.lines).toEqual(['', '', '']);
    expect(screen.hasContent).toBe(false);
    expect(screen.cursor).toEqual({ x: 0, y: 0 });
    expect(screen.cols).toBe(10);
    expect(screen.rows).toBe(3);
  });

  it('очистка экрана (ESC[2J ESC[H) и позиция курсора', async () => {
    const screen = await render('старое\x1b[2J\x1b[Hновое', 20, 3);
    expect(screen.lines[0]).toBe('новое');
    expect(screen.lines.slice(1)).toEqual(['', '']);
    expect(screen.hasContent).toBe(true);
    expect(screen.cursor).toEqual({ x: 5, y: 0 });
  });

  it('перевод строки на границе экрана: полная строка + CRLF не съедает строку', async () => {
    // Ровно `cols` символов заполняют строку (курсор ждёт переноса), но `\r\n`
    // — явный перевод строки: содержимое остаётся на своей строке.
    const screen = await render('aaaaa\r\nb', 5, 3);
    expect(screen.lines).toEqual(['aaaaa', 'b', '']);
    expect(screen.cursor).toEqual({ x: 1, y: 1 });
  });

  it('соблюдает cols × rows: строки не шире cols, лишние строки прокручены', async () => {
    const screen = await render('0123456789ABCDEF\r\n2\r\n3\r\n4\r\n5', 10, 3);
    expect(screen.lines).toHaveLength(3);
    // Длинная строка переносится (как в терминале), а не вылезает за экран.
    expect(screen.lines.every((line) => line.length <= 10)).toBe(true);
    // Старые строки ушли за пределы экрана — видны только последние.
    expect(screen.lines).toEqual(['3', '4', '5']);
  });

  it('wide-символы не ломают строку: символ целиком на одной строке', async () => {
    const screen = await render('wide: 日本語 ok\r\nsecond', 10, 4);
    // Символ, не влезший в остаток строки, переносится целиком (не разрывается).
    expect(screen.lines[0]).toBe('wide: 日本');
    expect(screen.lines[1]).toBe('語 ok');
    expect(screen.lines[2]).toBe('second');
    expect(screen.lines.slice(0, 3).join('')).toBe('wide: 日本語 oksecond');
  });

  it('hasContent=false, если экран забит пробелами', async () => {
    const screen = await render('     \r\n   ', 10, 2);
    expect(screen.hasContent).toBe(false);
    expect(screen.lines.every((line) => line.trim() === '')).toBe(true);
  });

  it('scrollback: снимок — видимый экран, а не история буфера', async () => {
    const text = '1\r\n2\r\n3\r\n4\r\n5\r\n';
    const live = await render(text, 5, 3);
    const withScrollback = await render(text, 5, 3, 10);
    // Без истории и с историей экран один и тот же: последние строки, а не
    // начало буфера ('1', '2' — история, в снимок не попадает).
    expect(live.lines).toEqual(['4', '5', '']);
    expect(withScrollback.lines).toEqual(['4', '5', '']);
    expect(withScrollback.rows).toBe(3);
  });

  it('scrollback: содержимое, не заполнившее экран, читается с начала', async () => {
    const screen = await render('a\r\nb', 10, 4, 10);
    expect(screen.lines).toEqual(['a', 'b', '', '']);
    expect(screen.cursor).toEqual({ x: 1, y: 1 });
  });

  it('альтернативный буфер (перерисовка TUI): виден последний кадр', async () => {
    const frame = '\x1b[?1049h\x1b[H\x1b[2JCPU: 10%\x1b[HCPU: 90%';
    const screen = await render(frame, 20, 3);
    expect(screen.lines[0]).toBe('CPU: 90%');
    expect(screen.hasContent).toBe(true);
  });
});
