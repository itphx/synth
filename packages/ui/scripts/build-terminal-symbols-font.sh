#!/usr/bin/env bash
# Сборка встроенного символьного шрифта веб-терминала Synth.
#
# Источник: Nerd Fonts v3.5.1, «Symbols Only» (Mono) — MIT, ryanoasis/nerd-fonts.
# Результат: packages/ui/public/fonts/symbols-nerd-mono.woff2 (<= 400 КБ).
#
# Прогон:
#   packages/ui/scripts/build-terminal-symbols-font.sh
#
# Требуются: curl, tar, pyftsubset (fontTools), woff2_compress, python3.
# Временные файлы — в tmp/ репозитория (не в /tmp).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${UI_DIR}/../.." && pwd)"
WORK_DIR="${REPO_ROOT}/tmp/nerd-symbols-font"
OUT_DIR="${UI_DIR}/public/fonts"

NERD_VERSION="v3.5.1"
ARCHIVE="NerdFontsSymbolsOnly.tar.xz"
SRC_URL="https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_VERSION}/${ARCHIVE}"
SRC_TTF="SymbolsNerdFontMono-Regular.ttf"

# Диапазоны сабсета:
#   U+E000-E8FF  — PUA plane 0: powerline (E0A0-E0D4), Devicons (E700-E958),
#                  Font Awesome Extension (E200-E2A9), Seti, Font Logos, FA 4.x
#                  (ED00-EFCF), Pomicons (E000-E00A);
#   U+F000-F1FF  — Font Awesome 5/6 (промпты: code_fork F126, cog F013, home F015,
#                  folder F07B, terminal F120, info F129, clock F017, …);
#   U+F400-F533  — Octicons (git_branch F418, repo F401, repo_forked F402, …);
#   U+23FB-23FE  — символы управления медиа;
#   U+2B58       — «большой круг» (OMZ);
#   U+276C-2771  — стрелки/разделители (OMZ).
# Всё, что не попало в диапазоны (Material Design в plane 15 — ~6900 глифов,
# хвост Font Awesome F200-F385), сознательно исключено ради лимита 400 КБ.
UNICODES="U+E000-E8FF,U+F000-F1FF,U+F400-F533,U+23FB-23FE,U+2B58,U+276C-2771"

# Ширина ячейки терминала: 0.6 em при upem 2048 (IBM Plex Mono / JetBrains Mono /
# Fira Code / SFMono / Menlo — у всех advance 0.6 em).
TARGET_ADVANCE=1229

mkdir -p "${WORK_DIR}" "${OUT_DIR}"

echo "==> скачивание ${SRC_URL}"
curl -fL --retry 3 -o "${WORK_DIR}/${ARCHIVE}" "${SRC_URL}"

echo "==> распаковка"
tar -xJf "${WORK_DIR}/${ARCHIVE}" -C "${WORK_DIR}" "${SRC_TTF}"

echo "==> сабсет (${UNICODES})"
pyftsubset "${WORK_DIR}/${SRC_TTF}" \
  --unicodes="${UNICODES}" \
  --output-file="${WORK_DIR}/symbols-nerd-mono-subset.ttf" \
  --no-hinting \
  --desubroutinize

echo "==> нормализация advance width (${TARGET_ADVANCE} = 0.6 em)"
python3 "${SCRIPT_DIR}/normalize-nerd-symbols.py" \
  "${WORK_DIR}/symbols-nerd-mono-subset.ttf" \
  "${WORK_DIR}/symbols-nerd-mono-normalized.ttf" \
  "${TARGET_ADVANCE}"

echo "==> сжатие в woff2"
woff2_compress "${WORK_DIR}/symbols-nerd-mono-normalized.ttf" >/dev/null
cp "${WORK_DIR}/symbols-nerd-mono-normalized.woff2" "${OUT_DIR}/symbols-nerd-mono.woff2"

echo "==> готово: ${OUT_DIR}/symbols-nerd-mono.woff2 ($(stat -c %s "${OUT_DIR}/symbols-nerd-mono.woff2") байт)"
