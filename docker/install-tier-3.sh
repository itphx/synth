#!/bin/sh
# install-tier-3.sh — tier 3 toolchain'а: веб/браузер (Playwright + Chromium).
#
# PROP-082, раздел «Тиры инструментов», tier 3:
#
#   playwright + Chromium (+ системные зависимости), @playwright/mcp, libxml2-utils
#
# Зачем: UI-верификация и webapp-тестирование из сессии агента (Playwright +
#   Chromium), MCP-сервер Playwright (`@playwright/mcp`) и разбор XML/HTML
#   (`xmllint` из `libxml2-utils`).
#
# ТОЛЬКО DEBIAN. Playwright официально не поддерживает musl: готовых сборок
# браузеров под musl нет, а Chromium из deb-пакета в alpine-образе не
# запустится (несовместимая libc). Поэтому на alpine скрипт fail-closed:
# явное сообщение и ненулевой код выхода — сборка падает, а не молча
# остаётся без браузера (тот же принцип, что у docker CLI в debian-ветке
# до шага 5).
#
# Состав:
#   * npm-пакеты — пин версии + integrity тарбола (как в tier 4):
#       playwright      — CLI + браузеры;
#       @playwright/mcp — MCP-сервер Playwright (stdio).
#     Версии пинятся ПАРОЙ, и это не случайность: `@playwright/mcp` жёстко
#     зависит от конкретной alpha-сборки `playwright`, и у каждой сборки — своя
#     ревизия Chromium. Стабильная `playwright` 1.64.1 использует ревизию
#     Chromium 1248, а alpha `1.64.0-alpha-1790635538000` (зависимость
#     `@playwright/mcp` 0.0.83) — ревизию 1247. Смешивать их нельзя: в образе
#     было бы ДВА набора Chromium (+~300 МБ), причём CLI и MCP-сервер смотрели
#     бы в разные каталоги. Поэтому обе части пинятся на одну и ту же сборку —
#     ровно ту, что использует официальный MCP-сервер.
#   * Chromium печётся в образ (`playwright install --with-deps chromium`) —
#     детерминированно, без скачивания в рантайме (PROP-082, «Python-окружение
#     и кэши»: решение — печь в образ). Каталог — общий
#     `PLAYWRIGHT_BROWSERS_PATH` (дефолт `/opt/ms-playwright`), доступный
#     всем пользователям образа, в том числе uid 1000.
#   * системные зависимости Chromium (шрифты, libnss3, libgbm1, xvfb и пр.)
#     ставит сам Playwright (`install --with-deps`).
#   * `libxml2-utils` — apt-пакет с `xmllint`.
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

# Дистрибутив — до всего остального: на musl Playwright не поддерживается.
case "$(synth_pkg_manager)" in
    apk)
        echo "install-tier-3.sh: Playwright/Chromwright не поддерживает musl (alpine)." >&2
        echo "install-tier-3.sh: официальных сборок браузеров под musl нет." >&2
        echo "install-tier-3.sh: используйте debian-ветку образов (flavor'ы browser/full)." >&2
        exit 1
        ;;
    apt-get) ;;
esac

# Каталог браузеров. Задаётся ENV в стадии Dockerfile; дефолт — тот же путь,
# чтобы скрипт можно было прогнать и вручную.
PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}
export PLAYWRIGHT_BROWSERS_PATH
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# Системные пакеты
# ---------------------------------------------------------------------------
#
# Состав: logical|alpine (apk)|debian (apt)
#
#   logical         | apk             | apt
#   ----------------+-----------------+-------------------
#   libxml2-utils   | libxml2-utils   | libxml2-utils
#
# В alpine колонка указана для полноты таблицы: ветка alpine в этом скрипте
# fail-closed (см. выше), поэтому apk-колонка не используется.
TIER_3_DISTRO='
libxml2-utils|libxml2-utils|libxml2-utils
'

synth_install_tier "$TIER_3_DISTRO"

# ---------------------------------------------------------------------------
# npm-пакеты (пин версии + integrity)
# ---------------------------------------------------------------------------
#
# Состав: logical|версия|url_тарбола|sha512_base64
#
#   logical         | версия                        | bin в образе
#   ----------------+-------------------------------+-----------------------
#   playwright      | 1.64.0-alpha-1790635538000    | playwright
#   playwright-mcp  | 0.0.83                        | playwright-mcp
#
# Версии и integrity — из реестра npm; расхождение integrity = ошибка сборки
# (fail-closed, `docker/install-lib.sh`).
TIER_3_NPM='
playwright|1.64.0-alpha-1790635538000|https://registry.npmjs.org/playwright/-/playwright-1.64.0-alpha-1790635538000.tgz|/5XDUMxpOd/9AojJtWDFIRV3EJZNQ0AwvK69wgt3CPzy8wTgiBG9pX45VfxtqtvIRGwfWzMhrvawNKreG69Snw==
playwright-mcp|0.0.83|https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz|oNcl+Ae2/IAjhfPeP46BfIkSakfmprY+aOtkv5MjrQ4lPav4/yNtPhL0iq8SlIM90oApWgBDUxaNKvktazUKOg==
'

TIER_3_ROWS=$(printf '%s\n' "$TIER_3_NPM")

# Цикл читает из here-doc, а не из пайпа: пайп создаёт subshell, и `exit 1`
# внутри него прервал бы только subshell, а не сборку.
while IFS= read -r tier3_row; do
    [ -n "$tier3_row" ] || continue
    tier3_name=$(printf '%s' "$tier3_row" | cut -d'|' -f1)
    tier3_version=$(printf '%s' "$tier3_row" | cut -d'|' -f2)
    tier3_url=$(printf '%s' "$tier3_row" | cut -d'|' -f3)
    tier3_sha=$(printf '%s' "$tier3_row" | cut -d'|' -f4)
    synth_install_npm_pinned "$tier3_name" "$tier3_version" "$tier3_url" "$tier3_sha"
done <<EOF
$TIER_3_ROWS
EOF

# ---------------------------------------------------------------------------
# Браузеры — печатся в образ
# ---------------------------------------------------------------------------
#
# `playwright install --with-deps chromium`:
#   * ставит системные зависимости Chromium (через apt — отсюда нужен
#     DEBIAN_FRONTEND=noninteractive выше);
#   * скачивает Chromium и headless-shell нужной ревизии в
#     PLAYWRIGHT_BROWSERS_PATH.
#
# Только chromium: firefox/webkit в образ не нужны (tier 3 — веб/браузер для
# UI-верификации), а они стоили бы ещё ~200 МБ.
playwright install --with-deps chromium

# Fail-closed: браузер должен лежать в каталоге образа.
if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
    echo "install-tier-3.sh: браузеры Playwright не установлены в $PLAYWRIGHT_BROWSERS_PATH" >&2
    exit 1
fi

# Индекс apt после установки системных зависимостей Chromium не нужен —
# уменьшаем слой (иначе в образе остаётся ~40 МБ списков и deb-архивов).
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

echo "install-tier-3.sh: Playwright + Chromium готовы ($PLAYWRIGHT_BROWSERS_PATH)"
