#!/bin/sh
# install-media.sh — медиа-зависимость toolchain'а (ADR-115).
#
# Медиа-состав:
#
#   ffmpeg
#
# Зачем: обработка вложений (ADR-115) — `packages/core/src/engine/attachments/
#   derive.ts`: транскод аудио в wav 16 кГц mono (многие провайдеры не берут
#   исходный формат), извлечение кадров видео (до 5) и извлечение
#   аудиодорожки видео для aux-модели. Без `ffmpeg` обработки нет — деградация
#   `no_ffmpeg` (ADR-078): вложение не доставляется молча, а отбрасывается
#   с материализацией в workspace и блоком «[ATTACHMENTS NOT DELIVERED]».
#
# Размер: ~70 МБ (ffmpeg с кодеками) — поэтому ставится не во все flavor'ы,
#   а только в те, где агент работает с медиа (`dev`, `browser`, `full`).
#
# Скрипт distro-aware: сам выбирает `apk` (alpine) или `apt-get` (debian).
# Список — ОДИН на тир; различаются только имена пакетов (сопоставление в
# таблице ниже). Идемпотентен, неинтерактивен, без `local` (POSIX sh).

set -eu

# CDPATH= — префиксное присваивание для одной команды, пробел обязателен.
# shellcheck disable=SC1007
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=install-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/install-lib.sh"

# Состав: logical|alpine (apk)|debian (apt)
#
#   logical | apk    | apt
#   --------+--------+--------
#   ffmpeg  | ffmpeg | ffmpeg
#
# Отличий имён нет: пакет называется `ffmpeg` и в alpine, и в debian.
MEDIA_TOOLS='
ffmpeg|ffmpeg|ffmpeg
'

synth_install_tier "$MEDIA_TOOLS"
