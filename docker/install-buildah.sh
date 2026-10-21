#!/bin/sh
# install-buildah.sh — сборка образов из сессии (flavor'ы `dev`/`devops`).
#
# PROP-082, раздел «Тиры инструментов», группа «Buildah»: `buildah` (rootless).
# `kaniko` в образ не идёт — это инструмент CI-билдера, а не утилита для
# вызова из шелла.
#
# ОГРАНИЧЕНИЯ (важно — образ НЕ обещает рабочий сценарий «из коробки»):
#
#   * buildah в контейнере требует либо rootless-режима с доступными
#     user namespaces, либо rootful-режима с `--isolation=chroot`
#     (по умолчанию buildah использует `runc` + mount-пространства, что внутри
#     контейнера без CAP_SYS_ADMIN не работает);
#   * для rootless нужны поддиапазоны uid/gid (`/etc/subuid`, `/etc/subgid`) и
#     бинари `newuidmap`/`newgidmap` (пакет `shadow-subids`), а также
#     разрешённые unprivileged user namespaces
#     (`kernel.unprivileged_userns_clone` / `user.max_user_namespaces`);
#   * драйвер хранилища: по умолчанию overlay — требует либо root, либо
#     `fuse-overlayfs` с доступным `/dev/fuse`; без них используется `vfs`
#     (медленно, но работает без привилегий);
#   * сетевой backend buildah — `netavark` (+ `aardvark-dns` для DNS);
#   * рабочий каталог buildah (`TMPDIR`) и каталог контекста сборки не должны
#     лежать на overlayfs: вложенный overlay-mount поверх overlayfs даёт
#     «invalid argument» (это свойство ФС хоста, а не образа).
#
# Проверенный рабочий рецепт (rootful, в контейнере):
#
#   docker run --rm \
#     --cap-add=SYS_ADMIN --cap-add=SYS_RESOURCE \
#     --device /dev/fuse \
#     -e TMPDIR=/dev/shm \
#     synth-backend:<v>-dev \
#     buildah bud --isolation=chroot -t demo:latest .
#
# Без `--cap-add=SYS_ADMIN` buildah падает на `unshare(CLONE_NEWUSER):
# Operation not permitted`; без `/dev/fuse` — на fuse-overlayfs; без
# SYS_RESOURCE — на RLIMIT_NOFILE; без TMPDIR на не-overlayfs — на монтировании
# контекста сборки («invalid argument»).
#
# Rootless (от uid 1000) — те же требования плюс writable `--root`/`--runroot`
# (каталог `/run/containers` по умолчанию непривилегированному пользователю
# недоступен) и диапазоны subuid/subgid (ниже):
#
#   buildah --root "$HOME/.local/share/containers/storage" \
#            --runroot /dev/shm/runroot \
#            bud --isolation=chroot -t demo:latest .
#
#
# Всё это — НЕЗАВИСИМО от состава образа: то, что ставит этот скрипт, —
# только необходимые бинарники. Работоспособность определяется правами
# рантайма (user namespaces, CAP_SYS_ADMIN/CAP_SYS_RESOURCE, /dev/fuse, seccomp,
# тип ФС под TMPDIR), а не образом. Поэтому в образе НЕТ ничего, что
# выдавало бы неработающий сценарий за рабочий (никаких обёрток, «готовых»
# конфигов или подсказок в PATH).
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

# Состав: logical|alpine (apk)|debian (apt)
#
#   logical        | apk            | apt
#   ---------------+----------------+------------------
#   buildah        | buildah        | buildah
#   crun           | crun           | crun
#   netavark       | netavark       | netavark
#   aardvark-dns   | aardvark-dns   | aardvark-dns
#   fuse-overlayfs | fuse-overlayfs | fuse-overlayfs
#   slirp4netns    | slirp4netns    | slirp4netns
#   shadow-subids  | shadow-subids  | uidmap
#
# Отличия имён:
#   * shadow-subids: в alpine пакет даёт бинарни `newuidmap`/`newgidmap` и
#     файлы `/etc/subuid`, `/etc/subgid`; в debian бинарни даёт `uidmap`
#     (файлы `/etc/subuid`/`/etc/subgid` — из пакета `passwd`).
#   * crun — OCI-runtime для buildah; в alpine buildah тянет виртуальное
#     `oci-runtime`, фиксируем конкретную реализацию.
#   * netavark/aardvark-dns — сетевой backend и DNS-helper buildah; без них
#     buildah не может создать build-контейнер («could not find netavark»).
BUILDAH_TOOLS='
buildah|buildah|buildah
crun|crun|crun
netavark|netavark|netavark
aardvark-dns|aardvark-dns|aardvark-dns
fuse-overlayfs|fuse-overlayfs|fuse-overlayfs
slirp4netns|slirp4netns|slirp4netns
shadow-subids|shadow-subids|uidmap
'

synth_install_tier "$BUILDAH_TOOLS"

# Диапазоны subuid/subgid для rootless-режима. Пакет `shadow-subids` создаёт
# файлы, но НЕ заводит диапазоны для уже существующих пользователей, поэтому
# без этой правки buildah ругается «no subuid ranges found for user "node"» и
# не может маппить uid/gid непривилегированного пользователя.
#
# Диапазон 100000:65536 — стандартный для rootless-инструментов; внутри
# контейнера он приватный (маппится в user namespace самого контейнера).
# Правка идемпотентна: строка для пользователя `node` (uid 1000 — он же
# владелец HOME/кэшей, см. стадию `core`) добавляется один раз.
for synth_sub_file in /etc/subuid /etc/subgid; do
    if ! grep -q '^node:' "$synth_sub_file" 2>/dev/null; then
        echo 'node:100000:65536' >>"$synth_sub_file"
    fi
done
