#!/usr/bin/env python3
"""Нормализация ширины ячейки символьного сабсета Nerd Fonts.

Зачем это нужно
---------------
Upstream «Symbols Nerd Font Mono» — самостоятельный символьный шрифт: у него
нет ASCII, и у **всех** глифов advance width = 1.0 em (2048/2048). Он рассчитан
на использование как fontconfig-fallback к уже «пропатченным» моноширинным
шрифтам, где метрики задаёт основной шрифт.

В веб-терминале Synth основной шрифт моноширинный (см. `--font-mono` в
`design-system.css`: IBM Plex Mono / JetBrains Mono / Fira Code / SFMono /
Menlo — у всех advance = 0.6 em). Если fallback остаётся с advance 1.0 em, то:

* в DOM-рендерере xterm.js соседние ячейки «разъезжаются» (ширина символа
  ≠ ширине ячейки);
* в canvas-рендерере глиф рисуется шириной 1.67 ячейки и наезжает на соседний
  столбец — powerline-разделители рассыпаются.

Поэтому после сабсета метрики приводятся к ширине ячейки терминала:

* advance width всех глифов = 0.6 em (1229 при upem 2048);
* иконки (всё, кроме разделителей) сжимаются по X в 0.6 раза и остаются
  высотой 1.0 em — как в «пропатченных» моноширинных Nerd Fonts (иконка
  занимает ширину ячейки, высоту — em-бокса);
* powerline-разделители (`pl-*`, `ple-*`) вписываются в ячейку по X ровно
  (контур → [0, 1229]), чтобы соседние сегменты powerline-бара смыкались без
  зазора; по Y не трогаются (высота em-бокса сохраняется).

Использование
-------------
    python3 normalize-nerd-symbols.py <вход.ttf> <выход.ttf> [advance]

Требуется fontTools (`pip install fonttools`).
"""

from __future__ import annotations

import sys

from fontTools.ttLib import TTFont

# Разделители powerline: их контур обязан заполнять ячейку по X, иначе между
# сегментами цветного бара появляется вертикальный зазор.
#
# Диапазон задан кодпоинтами, а не именами глифов: `pyftsubset` выбрасывает
# имена (post table 3.0), и в сабсете глиф называется `uniE0B0`.
#   E0B0-E0B3 — классические разделители (hard/soft, left/right);
#   E0B4-E0D7 — расширенный набор powerline (полуокружности, треугольники,
#               «flame», «pixelated squares», «honeycomb», «lego», «trapezoid»).
#   Вне диапазона: E0A0-E0A3 — иконки (ветка, номер строки, read-only).
DIVIDER_RANGE = range(0xE0B0, 0xE0D8)


def is_divider(codepoint: int | None) -> bool:
    """True для глифов-разделителей powerline (не для иконок `pl-branch` и т. п.)."""
    return codepoint is not None and codepoint in DIVIDER_RANGE


def normalize(src: str, dst: str, advance: int) -> None:
    font = TTFont(src)
    upem = font["head"].unitsPerEm
    scale = advance / upem
    glyf = font["glyf"]
    hmtx = font["hmtx"]

    lsbs: list[int] = []
    rsbs: list[int] = []
    extents: list[int] = []

    # Кодпоинт каждого глифа: в сабсете имена глифов выброшены, а разделители
    # отличаются именно диапазоном кодпоинтов.
    codepoint_of: dict[str, int] = {}
    for codepoint, glyph_name in font.getBestCmap().items():
        codepoint_of.setdefault(glyph_name, codepoint)

    for name in font.getGlyphOrder():
        glyph = glyf[name]
        if glyph.numberOfContours == 0:
            hmtx.metrics[name] = (advance, 0)
            lsbs.append(0)
            rsbs.append(advance)
            extents.append(advance)
            continue

        if is_divider(codepoint_of.get(name)):
            # Контур разделителя → ровно в ячейку [0, advance].
            ink = glyph.xMax - glyph.xMin
            sx = advance / ink if ink else scale
            dx = -glyph.xMin * sx
        else:
            # Иконка: сжатие по X в долю advance/em, высота без изменений.
            sx, dx = scale, 0.0

        glyph.coordinates.scale((sx, 1.0))
        if dx:
            glyph.coordinates.translate((dx, 0))

        x_min = round(glyph.xMin * sx + dx)
        x_max = round(glyph.xMax * sx + dx)
        lsb = x_min
        hmtx.metrics[name] = (advance, lsb)
        lsbs.append(lsb)
        rsbs.append(advance - lsb - (x_max - x_min))
        extents.append(advance + lsb)

    hhea = font["hhea"]
    hhea.advanceWidthMax = advance
    hhea.minLeftSideBearing = min(lsbs)
    hhea.minRightSideBearing = min(rsbs)
    hhea.xMaxExtent = max(extents)

    os2 = font["OS/2"]
    os2.xAvgCharWidth = advance

    # Метрики пересчитываются при сохранении (recalcBBoxes): границы глифов,
    # head.xMin/xMax/yMin/yMax, usWinAscent/Descent.
    font.save(dst)


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__)
        return 2
    src, dst = argv[1], argv[2]
    advance = int(argv[3]) if len(argv) > 3 else 1229
    normalize(src, dst, advance)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
