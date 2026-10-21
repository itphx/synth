#!/bin/sh
# install-tier-1.sh — tier 1 toolchain'а: сборка (нативные модули, проекты).
#
# PROP-082, раздел «Тиры инструментов», tier 1:
#
#   make, gcc/g++, musl-dev (alpine) / build-essential (debian),
#   python3-dev, pkgconf, patch, diffutils, git-lfs, rsync
#
# Зачем: сборка C/C++-расширений (pip wheels, нативные npm-модули), сборка
#   проектов из исходников, `git lfs` для LFS-объектов, rsync для синхронизации
#   workspace'а, patch/diffutils — для применения диффов агентом.
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

# Состав тира: logical|alpine (apk)|debian (apt)
#
#   logical      | apk         | apt             | примечание
#   -------------+-------------+-----------------+-------------------------------------
#   make         | make        | make            |
#   gcc          | gcc         | gcc             |
#   g++          | g++         | g++             |
#   musl-dev     | musl-dev    | build-essential | заголовки libc: musl-dev ↔ libc6-dev
#   python3-dev  | python3-dev | python3-dev     | заголовки/расширения для сборки pip-пакетов
#   pkgconf      | pkgconf     | pkg-config      | pkg-config в debian — виртуальное имя на pkgconf
#   patch        | patch       | patch           |
#   diffutils    | diffutils   | diffutils       | GNU diff/diff3 вместо busybox
#   git-lfs      | git-lfs     | git-lfs         |
#   rsync        | rsync       | rsync           |
#
# Отличия имён:
#   * musl-dev: в alpine это отдельный пакет с заголовками musl-libc, в debian
#     аналог — libc6-dev, который входит в мета-пакет `build-essential`
#     (gcc/g++/make/libc6-dev уже покрыты) — поэтому в apt-колонке стоит
#     `build-essential`, а не отдельный `libc6-dev`;
#   * pkgconf: дистрибутивный `pkg-config` в debian — виртуальное имя,
#     резолвится в pkgconf (тот же бинарь `/usr/bin/pkg-config`).
TIER_1='
make|make|make
gcc|gcc|gcc
g++|g++|g++
musl-dev|musl-dev|build-essential
python3-dev|python3-dev|python3-dev
pkgconf|pkgconf|pkg-config
patch|patch|patch
diffutils|diffutils|diffutils
git-lfs|git-lfs|git-lfs
rsync|rsync|rsync
'

synth_install_tier "$TIER_1"
