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
#   yq       | yq       | yq         | ⚠ реализации разные, см. ниже
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
#   * yq: ⚠ в alpine `yq` — это Go-реализация mikefarah/yq (v4, синтаксис
#     `yq eval`), в debian `yq` — python-реализация kislyuk/yq (синтаксис
#     `yq r`). CLI у них НЕсовместимы. Flavor `core` собирается на alpine,
#     поэтому там yq — Go-вариант. Для debian-ветки (flavor'ы browser/full,
#     шаги 4–5) нужен отдельный пин Go-варианта (PROP-068: pin + checksum) —
#     до того момента оставляем дистрибутивный пакет и фиксируем расхождение.
TIER_0='
bash|bash|bash
curl|curl|curl
jq|jq|jq
yq|yq|yq
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
