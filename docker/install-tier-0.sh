#!/bin/sh
# install-tier-0.sh — tier 0 toolchain'а: предсказуемый shell вместо busybox.
#
# PROP-082, раздел «Тиры инструментов», tier 0:
#
#   bash, curl, jq, yq, unzip/zip, xz, zstd, GNU coreutils/findutils/grep/sed/
#   gawk, less, tree, openssl
#
# Зачем: busybox в alpine неполон — нет `grep -P`, нет GNU-флагов у sed/find,
#   свой `awk` (busybox awk) без gawk-расширений. Tier 0 даёт предсказуемый
#   shell-контракт для агентских тулов и пользовательского кода.
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
#   logical  | apk      | apt        | примечание
#   ---------+----------+------------+-------------------------------------
#   bash     | bash     | bash       |
#   curl     | curl     | curl       |
#   jq       | jq       | jq         |
#   unzip    | unzip    | unzip      |
#   zip      | zip      | zip        |
#   xz       | xz       | xz-utils   | имя пакета в debian — xz-utils
#   zstd     | zstd     | zstd       |
#   coreutils| coreutils| coreutils  | GNU-варианты busybox
#   findutils| findutils| findutils  | GNU find вместо busybox find
#   grep     | grep     | grep       | GNU grep (есть -P) вместо busybox
#   sed      | sed      | sed        | GNU sed вместо busybox sed
#   gawk     | gawk     | gawk       | GNU awk (POSIX-строгий) вместо busybox awk
#   less     | less     | less       |
#   tree     | tree     | tree       |
#   openssl  | openssl  | openssl    |
#
# Отличия имён:
#   * xz: alpine `xz` ↔ debian `xz-utils` (бинарь /usr/bin/xz одинаковый);
#   * yq — ВНЕ таблицы (см. ниже): реализации в alpine и debian РАЗНЫЕ, и в
#     debian дистрибутивный пакет — python-реализация с несовместимым CLI.
TIER_0='
bash|bash|bash
curl|curl|curl
jq|jq|jq
unzip|unzip|unzip
zip|zip|zip
xz|xz|xz-utils
zstd|zstd|zstd
coreutils|coreutils|coreutils
findutils|findutils|findutils
grep|grep|grep
sed|sed|sed
gawk|gawk|gawk
less|less|less
tree|tree|tree
openssl|openssl|openssl
'

synth_install_tier "$TIER_0"

# ---------------------------------------------------------------------------
# yq — отдельно от таблицы: реализации несовместимы
# ---------------------------------------------------------------------------
#
# В alpine пакет `yq` — это Go-реализация mikefarah/yq (v4, синтаксис
# `yq eval`), и она там единственная.
#
# В debian apt-пакет `yq` — это python-реализация kislyuk/yq (синтаксис
# `yq r`): CLI НЕсовместим с Go-вариантом. Агентский код и пользовательские
# скрипты рассчитывают на Go-вариант (тот же, что в alpine-ветке), поэтому в
# debian ставится Go-вариант из upstream-релиза — с пином версии и проверкой
# sha256 (supply-chain — референс PROP-068), как kubectl/helm в tier 2.
#
#   logical | url_amd64                                              | sha256_amd64 | url_arm64                                              | sha256_arm64 | файл
#   --------+---------------------------------------------------------+--------------+--------------------------------------------------------+--------------+------
#   yq      | github.com/.../yq/releases/download/v4.54.1/yq_linux_amd64 | 8e34fc29... | github.com/.../yq/releases/download/v4.54.1/yq_linux_arm64 | 189088da... | -
#
# Контрольная сумма — из файла `checksums` релиза mikefarah/yq (поле SHA-256;
# порядок хешей — в `checksums_hashes_order`, официальный скрипт
# `extract-checksum.sh`).
YQ_UPSTREAM='
yq|https://github.com/mikefarah/yq/releases/download/v4.54.1/yq_linux_amd64|8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f|https://github.com/mikefarah/yq/releases/download/v4.54.1/yq_linux_arm64|189088da0c6429ec5178dfaab1a114805f6cab0b61b165ab236efedf1d57a71b|-
'

case "$(synth_pkg_manager)" in
    apk)
        # В alpine дистрибутивный `yq` — уже Go-реализация mikefarah/yq.
        apk add --no-cache yq
        ;;
    apt-get)
        # В debian apt-`yq` — python-реализация: ставим Go-вариант из upstream.
        synth_install_upstream_binaries "$YQ_UPSTREAM"
        ;;
esac
