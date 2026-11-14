# Встроенный символьный шрифт терминала (Nerd Fonts)

Каталог хранит шрифт, которым веб-терминал Synth рисует powerline-разделители,
глифы Nerd Fonts (PUA) и символы тем oh-my-zsh. Файл поставляется с приложением,
поэтому картинка одинакова у всех пользователей — независимо от того, какие
Nerd Fonts установлены в системе.

| Файл | Что это |
|---|---|
| `symbols-nerd-mono.woff2` | Сабсет Symbols Nerd Font Mono v3.5.1 (woff2, 371 724 Б) |
| `LICENSE-nerd-fonts.txt` | MIT-текст проекта Nerd Fonts + атрибуция сторонних наборов иконок |
| `README.md` | Этот файл: источник, версия, команды сборки, размер, дата |

Шрифт подключается **только** терминалом. Глобальная типографика интерфейса
(`--font-sans`, `--font-mono`) не затронута.

## Источник

| | |
|---|---|
| Проект | Nerd Fonts — https://github.com/ryanoasis/nerd-fonts |
| Версия | **v3.5.1** |
| Архив | `NerdFontsSymbolsOnly.tar.xz` (`releases/download/v3.5.1/`) |
| Файл в архиве | `SymbolsNerdFontMono-Regular.ttf` (2 610 012 Б) |
| Лицензия | MIT (+ лицензии сторонних наборов иконок, см. `LICENSE-nerd-fonts.txt`) |
| Дата сборки | **2026-11-14** |

## Итоговый файл

| | |
|---|---|
| Размер | **371 724 байта** (≈ 363 КиБ / 372 КБ) — лимит 400 КБ соблюдён |
| Формат | WOFF2 (`wOF2`), 1 987 глифов / 1 986 кодпоинтов |
| `unitsPerEm` | 2048 |
| Advance width | **1229 = 0.6 em** (у всех глифов) |
| Вертикальные метрики | ascent 0.8 em / descent 0.2 em (как в исходнике) |
| Имя внутри шрифта | `Symbols Nerd Font Mono` (`Version 001.000; Nerd Fonts 3.5.1`) |

## Команда сборки

Сборка воспроизводима одним скриптом:

```bash
packages/ui/scripts/build-terminal-symbols-font.sh
```

Он выполняет ровно четыре шага (те же, что ниже):

```bash
# 1. Источник
curl -fL -o tmp/nerd-symbols-font/NerdFontsSymbolsOnly.tar.xz \
  https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.tar.xz
tar -xJf tmp/nerd-symbols-font/NerdFontsSymbolsOnly.tar.xz -C tmp/nerd-symbols-font \
  SymbolsNerdFontMono-Regular.ttf

# 2. Сабсет (pyftsubset из fontTools; --flavor=woff2 недоступен без python-brotli,
#    поэтому сжатие отдельным шагом)
pyftsubset tmp/nerd-symbols-font/SymbolsNerdFontMono-Regular.ttf \
  --unicodes="U+E000-E8FF,U+F000-F1FF,U+F400-F533,U+23FB-23FE,U+2B58,U+276C-2771" \
  --output-file=tmp/nerd-symbols-font/symbols-nerd-mono-subset.ttf \
  --no-hinting \
  --desubroutinize

# 3. Нормализация advance width под ячейку терминала (0.6 em = 1229/2048)
python3 packages/ui/scripts/normalize-nerd-symbols.py \
  tmp/nerd-symbols-font/symbols-nerd-mono-subset.ttf \
  tmp/nerd-symbols-font/symbols-nerd-mono-normalized.ttf \
  1229

# 4. Сжатие
woff2_compress tmp/nerd-symbols-font/symbols-nerd-mono-normalized.ttf
cp tmp/nerd-symbols-font/symbols-nerd-mono-normalized.woff2 \
  packages/ui/public/fonts/symbols-nerd-mono.woff2
```

### Что попало в сабсет

| Диапазон | Содержимое |
|---|---|
| `U+E000-E8FF` | PUA plane 0: Pomicons (`E000–E00A`), **powerline** (`E0A0–E0A3`, `E0B0–E0D7`), Font Awesome Extension (`E200–E2A9`), Weather/Seti (`E300–E6BB`), Devicons (`E700–E958`), Codicons (`EA60–EC84`), Font Awesome 4.x (`ED00–EFCF`) |
| `U+F000-F1FF` | Font Awesome 5/6 — иконки промптов: `F013` cog, `F015` home, `F07B/F07C` folder, `F017` clock, `F126` code_fork (ветка git), `F120` terminal, `F129` info, `F128` question |
| `U+F400-F533` | Octicons — `F401` repo, `F402` repo_forked, `F418` git_branch |
| `U+23FB-23FE`, `U+2B58` | Power Symbols IEC (media/power) |
| `U+276C-2771` | Стрелки/разделители Unicode (OMZ) |

Осознанно **не** включено (лимит 400 КБ): Material Design Icons (plane 15,
`U+F0001–U+F1AF0` — ~6900 глифов, +500 КБ), хвост Font Awesome `F200–F2FF`
(брендовые иконки FA5) и Linux-дистрибутивы `F300–F385`.

### Нормализация advance width (важно)

Upstream «Symbols Nerd Font Mono» — самостоятельный символьный шрифт: ASCII в
нём нет, а **у всех** глифов advance width = 1.0 em. Он рассчитан на
использование как fallback к уже «пропатченным» моноширинным шрифтам, где
метрики задаёт основной шрифт.

В терминале Synth основной шрифт моноширинный (`--font-mono`: IBM Plex Mono /
JetBrains Mono / Fira Code / SFMono / Menlo — у всех advance 0.6 em). Поэтому
после сабсета метрики приведены к ширине ячейки:

* advance width всех глифов = **1229 (0.6 em)**;
* иконки сжаты по X в 0.6 раза, высота (1.0 em) сохранена — иконка занимает
  ширину ячейки и высоту em-бокса, как в «пропатченных» моноширинных Nerd Fonts;
* **разделители powerline** (`U+E0B0–U+E0D7`) вписаны в ячейку по X ровно
  (контур → `[0, 1229]`), чтобы соседние сегменты цветного бара смыкались без
  зазора; по Y не тронуты.

Если основной шрифт терминала сменится на моноширинный с другой шириной
(например, Consolas — 0.55 em, Iosevka — 0.5 em), сабсет надо пересобрать с
другим значением advance (третий аргумент `normalize-nerd-symbols.py`).

### Известное ограничение по вертикали

Высота глифов оставлена как в исходнике (1.0 em, ascent 0.8 / descent 0.2).
Вертикальная непрерывность powerline-бара зависит от line box основного
шрифта: у IBM Plex Mono / JetBrains Mono / Fira Code он 1.3 em, поэтому между
сегментами возможен вертикальный зазор ~0.3 em. Лечится либо `lineHeight: 1`
в настройках xterm.js, либо сборкой «пропатченного» основного шрифта.

## Подключение

`@font-face` — в `packages/ui/src/styles/index.css` (конец файла):

```css
@font-face {
  font-family: 'Synth Nerd Symbols';
  src: url('/fonts/symbols-nerd-mono.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  unicode-range: U+E000-E8FF, U+F000-F1FF, U+F400-F533, U+23FB-23FE, U+2B58,
    U+276C-2771;
}
```

`unicode-range` ограничен PUA и powerline-диапазоном, поэтому файл не
загружается на обычном тексте (загрузка — только когда в терминале встретился
нужный глиф).

CSS-переменная — `packages/ui/src/styles/design-system.css`:

```css
--font-terminal: var(--font-mono), 'Synth Nerd Symbols', monospace;
```

Модуль — `packages/ui/src/lib/terminalFonts.ts`:

```ts
import { TERMINAL_FONT_STACK, preloadTerminalFont } from '@/lib/terminalFonts';

const term = new Terminal({ fontFamily: TERMINAL_FONT_STACK, ... });
await preloadTerminalFont();   // до первой отрисовки — глифы PUA не «мигают»
```

`TERMINAL_FONT_STACK` — строка (xterm.js не понимает `var()`), а
`--font-terminal` остаётся для CSS-контекстов (например, `font-family:
var(--font-terminal)` у контейнера терминала).
