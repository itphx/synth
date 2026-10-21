#!/bin/sh
# install-diag.sh — диагностические утилиты для flavor'а `devops`.
#
# PROP-082, раздел «Тиры инструментов», группа «Diag»:
#
#   bind-tools (dig), netcat, traceroute, lsof, iproute2 (ss)
#
# Зачем: разбор сетевых проблем (DNS, доступность портов, маршрут, кто держит
#   сокет) из шелла агента и из диагностики инстанса.
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
#   logical   | apk           | apt
#   ----------+---------------+---------------
#   dig       | bind-tools    | dnsutils
#   netcat    | netcat-openbsd| netcat-openbsd
#   traceroute| traceroute    | traceroute
#   lsof      | lsof          | lsof
#   ss        | iproute2      | iproute2
#
# Отличия имён:
#   * dig: в alpine пакет `bind-tools`, в debian — `dnsutils` (тот же dig);
#   * netcat: в alpine есть `netcat-openbsd` (busybox-nc не умеет -z/-w
#     как ожидается), в debian `netcat-openbsd` тоже есть; `netcat` в debian —
#     виртуальное имя, указываем конкретный пакет.
DIAG_TOOLS='
dig|bind-tools|dnsutils
netcat|netcat-openbsd|netcat-openbsd
traceroute|traceroute|traceroute
lsof|lsof|lsof
ss|iproute2|iproute2
'

synth_install_tier "$DIAG_TOOLS"
