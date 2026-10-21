#!/bin/sh
# install-lib.sh — общий код distro-aware установки пакетов для flavor-образов
# Synth (PROP-082, раздел «Multistage-сборка»).
#
# Скрипты-тиры (`install-hard-deps.sh`, `install-tier-0.sh`) передают сюда
# ТАБЛИЦУ состава тира — по строке на пакет в формате:
#
#     logical|имя_пакета_apk|имя_пакета_apt
#
# Список пакетов тира — ровно один: различаются только ИМЕНА пакетов под
# конкретный дистрибутив, и это отражено в колонках таблицы. Дублировать
# список для alpine и debian нельзя (расхождение неизбежно).
#
# Дистрибутив определяется по наличию пакетного менеджера:
#   apk     → alpine
#   apt-get → debian/ubuntu
# Неизвестная база → fail-closed (ошибка), а не «молча пропустить» пакеты.
#
# Идемпотентность: повторный запуск безопасен (apk/apt пропускают уже
# установленное). Неинтерактивность: без вопросов и подсказок
# (`apk --no-cache`, `apt-get -y`, `DEBIAN_FRONTEND=noninteractive`).
#
# POSIX sh (dash/ash). Разбор таблицы сделан через sed/tr, а не через
# `read` + `${var:+word}`: busybox ash (alpine, /bin/sh) некорректно разбирает
# `${var:+word}` с пробелом перед `}` и подставляет лишний `}` в результат —
# на debian (dash) тот же код работает, на alpine ломается. Конструкция
# `${var:+...}` здесь намеренно не используется.

set -eu

# Печатает имя пакетного менеджера базового образа: apk | apt-get.
synth_pkg_manager() {
    if command -v apk >/dev/null 2>&1; then
        printf 'apk\n'
    elif command -v apt-get >/dev/null 2>&1; then
        printf 'apt-get\n'
    else
        echo "install-lib.sh: неизвестная база — не найдено ни apk, ни apt-get" >&2
        return 1
    fi
}

# synth_install_tier <таблица_состава>
#
# Разбирает таблицу, выбирает менеджер по дистрибутиву и ставит пакеты.
# Пустые строки и строки без имени пакета игнорируются.
synth_install_tier() {
    synth_tier_table=$1
    synth_mgr=$(synth_pkg_manager)

    # Второе поле строки — имя пакета для apk, третье — для apt.
    synth_apk_list=$(printf '%s\n' "$synth_tier_table" | sed -n 's/^[^|]*|\([^|]*\)|.*$/\1/p' | tr '\n' ' ')
    synth_apt_list=$(printf '%s\n' "$synth_tier_table" | sed -n 's/^[^|]*|[^|]*|\(.*\)$/\1/p' | tr '\n' ' ')

    if [ -z "$synth_apk_list" ] && [ -z "$synth_apt_list" ]; then
        echo "install-lib.sh: пустой состав тира" >&2
        return 1
    fi

    echo "install-lib.sh: менеджер пакетов — $synth_mgr"
    case "$synth_mgr" in
        apk)
            echo "install-lib.sh: apk add --no-cache $synth_apk_list"
            set -f
            # Список пакетов намеренно без кавычек: нужно разбиение на слова.
            # shellcheck disable=SC2086
            apk add --no-cache $synth_apk_list
            set +f
            ;;
        apt-get)
            echo "install-lib.sh: apt-get install -y --no-install-recommends $synth_apt_list"
            export DEBIAN_FRONTEND=noninteractive
            apt-get update
            set -f
            # Список пакетов намеренно без кавычек: нужно разбиение на слова.
            # shellcheck disable=SC2086
            apt-get install -y --no-install-recommends $synth_apt_list
            set +f
            # индекс apt в образе не нужен — уменьшаем слой
            rm -rf /var/lib/apt/lists/*
            ;;
    esac
}
