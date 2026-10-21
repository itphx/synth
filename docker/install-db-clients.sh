#!/bin/sh
# install-db-clients.sh — клиенты БД для flavor'ов `dev`/`devops`.
#
# PROP-082, раздел «Тиры инструментов», группа «БД»:
#
#   sqlite3, psql (postgresql-client), redis-cli, mysql-client
#
# Зачем: агент работает с данными инстанса и внешними БД (проверка схемы,
# выгрузка, разбор логов) из шелла. Только клиенты — СУБД в образе нет.
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
#   logical      | apk                 | apt
#   -------------+---------------------+-----------------------
#   sqlite3      | sqlite              | sqlite3
#   psql         | postgresql17-client | postgresql-client
#   redis-cli    | redis               | redis-tools
#   mysql-client | mysql-client        | mariadb-client
#
# Отличия имён:
#   * sqlite3: в alpine пакет называется `sqlite` (бинарь /usr/bin/sqlite3),
#     в debian — `sqlite3`;
#   * psql: в alpine виртуальное имя `postgresql-client` резолвится в
#     postgresql-BDR-клиент (9.4!) — это не то, что нужно, поэтому версия
#     клиента зафиксирована явно: `postgresql17-client`. Клиент PG17
#     совместим с серверами 9.2+. В debian мета-пакет `postgresql-client`
#     указывает на версию дистрибутива;
#   * redis-cli: в alpine отдельного пакета `redis-cli` нет — бинарь входит в
#     пакет `redis` (вместе с сервером; сам сервер в образе не запускается),
#     в debian бинарь вынесен в `redis-tools` (без сервера);
#   * mysql-client: в alpine пакет `mysql-client` (это MariaDB-клиент 11.x),
#     в debian `mysql-client` — виртуальное имя, поэтому указан явный
#     `mariadb-client`.
DB_CLIENTS='
sqlite3|sqlite|sqlite3
psql|postgresql17-client|postgresql-client
redis-cli|redis|redis-tools
mysql-client|mysql-client|mariadb-client
'

synth_install_tier "$DB_CLIENTS"
