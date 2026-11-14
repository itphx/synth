/**
 * Символьный шрифт терминала (Nerd Fonts) и стек шрифтов для xterm.js.
 *
 * Зачем: powerline-разделители (U+E0A0…U+E0B3), глифы Nerd Fonts (PUA) и
 * символы тем oh-my-zsh должны рисоваться одинаково у всех пользователей,
 * независимо от локально установленных шрифтов. Поэтому символьный шрифт
 * поставляется с приложением (`public/fonts/symbols-nerd-mono.woff2`) и
 * объявлен как `@font-face` с ограниченным `unicode-range` — файл грузится
 * только когда в терминале встретился нужный глиф.
 *
 * Глобальная типографика интерфейса не затронута: `--font-mono` и
 * `--font-sans` не меняются, терминальный стек — отдельный.
 *
 * Подробности сборки шрифта (сабсет, метрики, лицензия) —
 * `public/fonts/README.md`.
 */

/** Имя семейства из `@font-face` (`src/styles/index.css`). */
export const TERMINAL_FONT_FAMILY = "'Synth Nerd Symbols'";

/**
 * Спецификация шрифта для `document.fonts.load` — с размером, иначе браузер
 * шрифт не запросит.
 */
export const TERMINAL_FONT_PRELOAD_SPEC = '12px "Synth Nerd Symbols"';

/**
 * Стек шрифтов терминала — **строка**, а не `var(--font-mono)`: xterm.js
 * передаёт её в CSS-свойство `font-family` и не понимает CSS-переменные.
 *
 * Порядок важен: моноширинные шрифты интерфейса идут первыми (ASCII), встроенный
 * символьный шрифт — следом (PUA/powerline), общий `monospace` — последним
 * (запасной вариант).
 *
 * Дублирует `--font-terminal` из `styles/design-system.css` — там переменная
 * нужна для CSS-контекстов (например, `font-family: var(--font-terminal)` у
 * контейнера терминала).
 */
export const TERMINAL_FONT_STACK =
  '"IBM Plex Mono", "JetBrains Mono", "Fira Code", SFMono-Regular, Menlo, "Synth Nerd Symbols", monospace';

/** Таймаут предзагрузки шрифта, мс — терминал не должен ждать сеть. */
export const TERMINAL_FONT_PRELOAD_TIMEOUT_MS = 2000;

/** Глиф-разделитель powerline: им проверяем доступность символьного шрифта. */
const PRELOAD_PROBE = '\ue0b0';

/**
 * Предзагрузка символьного шрифта — вызывать до первой отрисовки терминала,
 * иначе первые кадры рисуют PUA-глифы «заглушкой» (tofu), и картинка
 * «дёргается» после загрузки.
 *
 * Ошибки и таймаут не пробрасываются: шрифт не критичен — без него терминал
 * работает, недоступные глифы заменяются символом-заглушкой.
 */
export async function preloadTerminalFont(): Promise<void> {
  if (typeof document === 'undefined') return;
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(TERMINAL_FONT_PRELOAD_SPEC, PRELOAD_PROBE),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TERMINAL_FONT_PRELOAD_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Шрифт не загрузился — терминал остаётся рабочим.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
