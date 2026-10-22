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

# Статический бандл docker для debian-ветки (используется только в apt-ветке).
#
#   logical | url_amd64                                         | sha256_amd64 | url_arm64                                         | sha256_arm64 | файл
#   --------+-----------------------------------------------------+--------------+----------------------------------------------------+--------------+------
#   docker  | download.docker.com/.../x86_64/docker-29.9.2.tgz | 9ac22599... | download.docker.com/.../aarch64/docker-29.9.2.tgz | 873b3e02... | docker
#
# Поле «файл» — `docker`: из архива берётся ТОЛЬКО клиент; демон (`dockerd`),
# `containerd`, `runc` и `containerd-shim` в образ не попадают.
DOCKER_CLI_UPSTREAM='
docker|https://download.docker.com/linux/static/stable/x86_64/docker-29.9.2.tgz|9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb|https://download.docker.com/linux/static/stable/aarch64/docker-29.9.2.tgz|873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73|docker
'

case "$(synth_pkg_manager)" in
    apk)
        # В alpine есть отдельный пакет `docker-cli` — только клиент
        # (зависит лишь от ca-certificates), демон в него не входит.
        apk add --no-cache docker-cli
        ;;
    apt-get)
        # В debian отдельного пакета `docker-cli` нет, а `docker.io` тянет
        # демон (dockerd + containerd) — а он в образе не нужен (см. шапку).
        # Поэтому CLI собирается из СТАТИЧЕСКОГО бандла docker (upstream-релиз
        # `download.docker.com/linux/static/stable/<arch>/docker-<ver>.tgz`):
        # это статический бинарь без зависимостей, из архива берётся ТОЛЬКО
        # `docker` (CLI). Пин версии + проверка sha256 (fail-closed), как у
        # kubectl/helm в tier 2.
        #
        # Оговорка по контрольной сумме: docker НЕ публикует файл checksum'ов
        # для статического бандла (в `download.docker.com/linux/static/stable/`
        # лежат только `.tgz`), поэтому sha256 зафиксирован в репозитории по
        # скачанному артефакту. fail-closed при этом сохраняется: любое
        # изменение бандла ломает сборку. Альтернатива — apt-репозиторий
        # docker (`docker-ce-cli`, у которого sha256 опубликованы в `Packages`),
        # но он требует добавления чужого GPG-ключа в образ (PROP-082,
        # «Открытые вопросы»: вариант (б)).
        synth_install_upstream_binaries "$DOCKER_CLI_UPSTREAM"
        ;;
esac
