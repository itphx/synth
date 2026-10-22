#!/bin/sh
# install-lib.sh — общий код distro-aware установки пакетов для flavor-образов
# Synth (PROP-082, раздел «Multistage-сборка»).
#
# Скрипты-тиры (`install-hard-deps.sh`, `install-tier-0.sh`, `install-tier-1.sh`,
# `install-tier-2.sh`, `install-db-clients.sh`, `install-diag.sh`,
# `install-buildah.sh`, `install-docker-cli.sh`) передают сюда
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
#
# Кроме дистрибутивных пакетов здесь есть помощники для инструментов,
# которых НЕТ в репозиториях дистрибутивов:
#   * synth_install_upstream_binaries — бинарные релизы upstream (tier 2:
#     kubectl/helm/kustomize/opentofu/hadolint): пин версии + проверка sha256;
#   * synth_install_npm_pinned — npm-пакеты MCP-серверов (tier 4): пин версии
#     + проверка integrity (sha512) тарбола до установки;
#   * synth_npm_direct_launcher — launcher для npm-пакетов с guard'ом
#     «запускайся только по собственному пути» (tier 4): вызывает реальный
#     файл пакета, минуя расхождение argv[1] / import.meta.url.
# Первые два — fail-closed: расхождение контрольной суммы = ошибка сборки.

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
            # индекс apt и кэш deb-архивов в образе не нужны — уменьшаем слой
            rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Бинарные релизы upstream (tier 2)
# ---------------------------------------------------------------------------
#
# Часть инструментов инфра-тира (kubectl, helm, kustomize, terraform/opentofu,
# hadolint) НЕ публикуется в репозиториях alpine/debian — они распространяются
# как готовые бинарные релизы. Ставим их из upstream-релиза с зафиксированной
# версией и проверкой sha256 (supply-chain — референс PROP-068).
#
# Таблица (одна строка на инструмент):
#
#     logical|url_amd64|sha256_amd64|url_arm64|sha256_arm64|файл_в_архиве
#
# Поле «файл_в_архиве»:
#   * `-`   — скачанный файл сам является бинарём (kubectl, hadolint);
#   * иное  — имя файла внутри архива (ищем рекурсивно после распаковки):
#              helm → `helm`, kustomize → `kustomize`, opentofu → `tofu`.

# Нормализованная архитектура образа: amd64 | arm64.
synth_arch() {
    case "$(uname -m)" in
        x86_64|amd64) printf 'amd64\n' ;;
        aarch64|arm64) printf 'arm64\n' ;;
        *)
            echo "install-lib.sh: неподдерживаемая архитектура: $(uname -m)" >&2
            return 1
            ;;
    esac
}

# sha256 файла в hex.
synth_sha256() {
    sha256sum "$1" | cut -d' ' -f1
}

# synth_install_upstream_binaries <таблица>
#
# Для каждой строки: скачать → проверить sha256 → распаковать (если архив) →
# положить бинарь в /usr/local/bin. Несовпадение контрольной суммы = ошибка
# (fail-closed, образ не собирается).
synth_install_upstream_binaries() {
    synth_tbl=$1
    synth_a=$(synth_arch)
    synth_rows=$(printf '%s\n' "$synth_tbl")

    # Цикл читает из here-doc, а не из пайпа: пайп создаёт subshell, и `exit 1`
    # внутри него прервал бы только subshell, а не сборку.
    while IFS= read -r synth_row; do
        [ -n "$synth_row" ] || continue

        synth_name=$(printf '%s' "$synth_row" | cut -d'|' -f1)
        if [ "$synth_a" = "amd64" ]; then
            synth_url=$(printf '%s' "$synth_row" | cut -d'|' -f2)
            synth_sha=$(printf '%s' "$synth_row" | cut -d'|' -f3)
        else
            synth_url=$(printf '%s' "$synth_row" | cut -d'|' -f4)
            synth_sha=$(printf '%s' "$synth_row" | cut -d'|' -f5)
        fi
        synth_member=$(printf '%s' "$synth_row" | cut -d'|' -f6)

        echo "install-lib.sh: $synth_name — загрузка $synth_url"
        synth_tmp=$(mktemp -d)
        synth_file="$synth_tmp/download"
        # --retry-all-errors: повторять и сетевые сбои вроде «DNS server refused
        # query», а не только таймауты/5xx (иначе сборка падает на минутном
        # сбое DNS). Контрольная сумма проверяется ПОСЛЕ скачивания, поэтому
        # повторы на безопасность не влияют.
        curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
            -o "$synth_file" "$synth_url"

        synth_actual=$(synth_sha256 "$synth_file")
        if [ "$synth_actual" != "$synth_sha" ]; then
            echo "install-lib.sh: НЕСОВПАДЕНИЕ sha256 для $synth_name" >&2
            echo "  ожидалось: $synth_sha" >&2
            echo "  получено : $synth_actual" >&2
            exit 1
        fi

        if [ "$synth_member" = "-" ]; then
            synth_src="$synth_file"
        else
            synth_extract="$synth_tmp/x"
            mkdir -p "$synth_extract"
            case "$synth_url" in
                *.tar.gz|*.tgz) tar -xzf "$synth_file" -C "$synth_extract" ;;
                *.zip) unzip -q -o "$synth_file" -d "$synth_extract" ;;
                *)
                    echo "install-lib.sh: неизвестный формат архива для $synth_name: $synth_url" >&2
                    exit 1
                    ;;
            esac
            synth_found=$(find "$synth_extract" -type f -name "$synth_member" | head -n 1)
            if [ -z "$synth_found" ]; then
                echo "install-lib.sh: в архиве $synth_name нет файла '$synth_member'" >&2
                exit 1
            fi
            synth_src="$synth_found"
        fi

        cp "$synth_src" "/usr/local/bin/$synth_name"
        chmod 0755 "/usr/local/bin/$synth_name"
        rm -rf "$synth_tmp"
        echo "install-lib.sh: $synth_name установлен (/usr/local/bin/$synth_name)"
    done <<EOF
$synth_rows
EOF
}

# ---------------------------------------------------------------------------
# npm-пакеты с пином версии (tier 4 — MCP-серверы)
# ---------------------------------------------------------------------------

# synth_install_npm_pinned <имя> <версия> <url_тарбола> <sha512_base64>
#
# Тарбол скачивается напрямую, его integrity (sha512) сверяется с зафиксированным
# значением, и только потом ставится глобально. Токены хостингов в образ НЕ
# запекаются (ADR-076/ADR-036) — MCP-сервер читает их из окружения в рантайме.
synth_install_npm_pinned() {
    synth_name=$1
    synth_version=$2
    synth_url=$3
    synth_integrity=$4

    echo "install-lib.sh: npm $synth_name@$synth_version — загрузка $synth_url"
    synth_tmp=$(mktemp -d)
    synth_tgz="$synth_tmp/package.tgz"
    # --retry-all-errors — см. пояснение в synth_install_upstream_binaries.
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
        -o "$synth_tgz" "$synth_url"

    synth_actual="sha512-$(openssl dgst -sha512 -binary "$synth_tgz" | openssl base64 -A)"
    if [ "$synth_actual" != "sha512-$synth_integrity" ]; then
        echo "install-lib.sh: НЕСОВПАДЕНИЕ integrity (sha512) для $synth_name@$synth_version" >&2
        echo "  ожидалось: sha512-$synth_integrity" >&2
        echo "  получено : $synth_actual" >&2
        exit 1
    fi

    npm install -g --no-audit --no-fund "$synth_tgz"
    rm -rf "$synth_tmp"
    echo "install-lib.sh: $synth_name@$synth_version установлен глобально"
}

# synth_npm_direct_launcher <имя_бина>
#
# Заменяет npm-бин (симлинк) на launcher-скрипт, который запускает РЕАЛЬНЫЙ
# файл пакета по его собственному пути. Нужна для ESM-пакетов, которые
# поднимают сервер только под guard'ом вида
#
#     if (process.argv[1] === fileURLToPath(import.meta.url)) { ... }
#
# npm кладёт bin СИМЛИНКОМ (`/usr/local/bin/gitea-mcp` →
# `../lib/node_modules/<pkg>/index.js`). При этом node в `process.argv[1]`
# оставляет путь СИМЛИНКА, а ESM-лоадер в `import.meta.url` — РЕАЛЬНЫЙ путь
# (симлинки резолвятся). Пути не совпадают → guard не срабатывает → процесс
# молча завершается с кодом 0, stdio-транспорт не поднимается (дефект пакета
# @boringstudio_org/gitea-mcp@2.0.0).
#
# Запуск РЕАЛЬНОГО файла по его собственному пути возвращает совпадение
# (`process.argv[1] === fileURLToPath(import.meta.url)`) и включает guard.
#
# Файл пакета НЕ копируется и остаётся на месте: иначе ломаются относительные
# require'ы внутри пакета (`require("./package.json")` из index.js).
#
# Пином версии и проверкой integrity это НЕ подменяется: launcher создаётся
# ПОСЛЕ успешной установки уже проверенного тарбола.
synth_npm_direct_launcher() {
    synth_bin_name=$1

    synth_prefix=$(npm prefix -g)
    synth_bin_path="$synth_prefix/bin/$synth_bin_name"
    if [ ! -e "$synth_bin_path" ]; then
        echo "install-lib.sh: npm-бин $synth_bin_name не найден ($synth_bin_path)" >&2
        exit 1
    fi

    synth_real=$(readlink -f "$synth_bin_path")
    if [ ! -f "$synth_real" ]; then
        echo "install-lib.sh: реальный файл пакета $synth_bin_name не найден ($synth_real)" >&2
        exit 1
    fi

    synth_node=$(command -v node || true)
    if [ -z "$synth_node" ]; then
        echo "install-lib.sh: node не найден в PATH — launcher для $synth_bin_name не создать" >&2
        exit 1
    fi

    # Симлинк удаляется ДО записи launcher'а: иначе запись ушла бы по симлинку
    # внутрь файла пакета и испортила бы его.
    rm -f "$synth_bin_path"
    cat > "$synth_bin_path" <<EOF
#!/bin/sh
# $synth_bin_name — launcher (PROP-082, tier 4).
#
# npm-бин пакета — симлинк, из-за чего guard пакета
# (process.argv[1] === fileURLToPath(import.meta.url)) не срабатывает: процесс
# молча завершается с кодом 0, stdio-транспорт не поднимается. Launcher
# запускает РЕАЛЬНЫЙ файл пакета по его собственному пути — тогда
# process.argv[1] совпадает с import.meta.url, и guard срабатывает.
exec $synth_node $synth_real "\$@"
EOF
    chmod 0755 "$synth_bin_path"
    echo "install-lib.sh: launcher $synth_bin_name → $synth_real"
}
