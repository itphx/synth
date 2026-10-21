#!/bin/sh
# install-docker-cli.sh — docker CLI (без демона и без сокета) для `devops`.
#
# PROP-082, раздел «Тиры инструментов», группа «Docker»: docker — **только
# CLI**. В образе нет:
#   * демона (`dockerd`/`containerd`) — docker в образе только клиент;
#   * `docker.sock` — сокет наружу не пробрасывается ни в одном flavor'е
#     (PROP-082, «Две топологии развёртывания»).
# Клиент без демона бессмысленен локально, но нужен для работы с УДАЛЁННЫМ
# builder'ом (DOCKER_HOST/DOCKER_CONTEXT), поэтому он есть.
#
# Скрипт distro-aware: сам выбирает `apk` (alpine) или `apt-get` (debian).
# Идемпотентен, неинтерактивен, без `local` (POSIX sh).

set -eu

# CDPATH= — префиксное присваивание для одной команды, пробел обязателен.
# shellcheck disable=SC1007
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=install-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/install-lib.sh"

case "$(synth_pkg_manager)" in
    apk)
        # В alpine есть отдельный пакет `docker-cli` — только клиент
        # (зависит лишь от ca-certificates), демон в него не входит.
        apk add --no-cache docker-cli
        ;;
    apt-get)
        # В debian отдельного пакета `docker-cli` нет, а `docker.io` тянет
        # демон (dockerd + containerd) — а он в образе не нужен (см. шапку).
        # Для debian-ветки (flavor'ы `browser`/`full`, шаг 5) CLI ставится из
        # статического bundle download.docker.com (распаковать только
        # `docker`). До тех пор — fail-closed, а не молчаливый dockerd.
        echo "install-docker-cli.sh: в debian нет пакета docker-CLI без демона;" >&2
        echo "install-docker-cli.sh: используйте статический bundle download.docker.com (шаг 5)." >&2
        exit 1
        ;;
esac
