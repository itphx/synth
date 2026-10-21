#!/bin/sh
# install-hard-deps.sh — обязательный (hard) состав toolchain'а Synth-образов.
#
# PROP-082, раздел «Общий состав (hard deps)»: во ВСЕХ flavor'ах, кроме `slim`,
# обязаны присутствовать инструменты агентских тулов:
#
#   git            — git-тулы (git_status…git_stash), ADR-076
#   ripgrep        — grep_files
#   python3 + pip  — пользовательский код в execute_shell
#   venv           — изолированные окружения python
#   openssh-client — SSH к репозиториям (ADR-076)
#   ca-certificates— https-git и pip
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
#   logical         | apk            | apt
#   ----------------+----------------+-------------------
#   git             | git            | git
#   ripgrep         | ripgrep        | ripgrep
#   python3         | python3        | python3
#   pip             | py3-pip        | python3-pip
#   venv            | python3        | python3-venv
#   openssh-client  | openssh-client | openssh-client
#   ca-certificates | ca-certificates| ca-certificates
#
# Отличия имён:
#   * pip:  alpine `py3-pip`      ↔ debian `python3-pip`;
#   * venv: alpine — отдельного пакета нет, `python3 -m venv` работает из
#     коробки (в пакет python3 входит ensurepip), поэтому в alpine-колонке
#     стоит тот же `python3` (установка идемпотентна, лишнего пакета нет);
#     в debian venv вынесен в отдельный пакет `python3-venv` (там ensurepip
#     лежит в `python3-venv`, а не в `python3`);
#   * openssh-client в alpine — виртуальное имя, резолвится в
#     `openssh-client-default` (сам бинарь ssh).
TIER_HARD_DEPS='
git|git|git
ripgrep|ripgrep|ripgrep
python3|python3|python3
pip|py3-pip|python3-pip
venv|python3|python3-venv
openssh-client|openssh-client|openssh-client
ca-certificates|ca-certificates|ca-certificates
'

synth_install_tier "$TIER_HARD_DEPS"
