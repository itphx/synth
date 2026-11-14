import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_PRELOAD_SPEC,
  TERMINAL_FONT_PRELOAD_TIMEOUT_MS,
  TERMINAL_FONT_STACK,
  preloadTerminalFont,
} from './terminalFonts';

/**
 * Символьный шрифт терминала: контракт для будущего компонента xterm.js.
 *
 * Проверяем ровно то, на что может опираться код терминала: имя семейства
 * совпадает с `@font-face`, в стеке символьный шрифт идёт после
 * моноширинных и до общего `monospace`, а предзагрузка никогда не
 * пробрасывает ошибку и не висит дольше таймаута.
 */
describe('terminalFonts', () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'fonts');
  });

  it('имя семейства совпадает с @font-face в styles/index.css', () => {
    expect(TERMINAL_FONT_FAMILY).toBe("'Synth Nerd Symbols'");
    expect(TERMINAL_FONT_PRELOAD_SPEC).toContain('Synth Nerd Symbols');
  });

  it('стек — строка (xterm.js не понимает var()), символьный шрифт перед monospace', () => {
    expect(TERMINAL_FONT_STACK).not.toContain('var(');
    expect(TERMINAL_FONT_STACK).toContain('Synth Nerd Symbols');

    const symbols = TERMINAL_FONT_STACK.indexOf('Synth Nerd Symbols');
    const generic = TERMINAL_FONT_STACK.lastIndexOf('monospace');
    expect(symbols).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(symbols);
  });

  it('предзагрузка не падает, когда API шрифтов недоступен', async () => {
    await expect(preloadTerminalFont()).resolves.toBeUndefined();
  });

  it('предзагрузка не падает, когда загрузка шрифта отклонена', async () => {
    Object.defineProperty(document, 'fonts', {
      value: { load: () => Promise.reject(new Error('network')) },
      configurable: true,
    });
    await expect(preloadTerminalFont()).resolves.toBeUndefined();
  });

  it('предзагрузка не ждёт дольше таймаута', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'fonts', {
      value: { load: () => new Promise(() => {}) },
      configurable: true,
    });

    const pending = preloadTerminalFont();
    await vi.advanceTimersByTimeAsync(TERMINAL_FONT_PRELOAD_TIMEOUT_MS);
    await expect(pending).resolves.toBeUndefined();
  });
});
