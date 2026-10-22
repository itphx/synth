#!/usr/bin/env bash
#
# ci-postgres.sh — поднять PostgreSQL для контрактного suite драйвера хранения
# (ADR-097, волна 4) и прогнать тесты против живой БД.
#
# Зачем: контрактный suite портов (packages/core/src/storage/contract/postgres.test.ts)
# и smoke-тест драйвера (packages/storage-postgres/**) включаются только при заданном
# SYNTH_TEST_POSTGRES_DSN; без него весь набор — `describe.skip` (герметичный запуск).
# В CI нужен живой PostgreSQL, а на раннерах GitVerse нет ни service-контейнеров, ни
# гарантированных docker/apt — поэтому источник БД резолвится по цепочке (тот же приём,
# что у helm в scripts/ci-helm.sh):
#
#   1. внешний DSN — SYNTH_TEST_POSTGRES_DSN либо GV_TEST_POSTGRES_DSN (секрет CI);
#      адрес задаёт владелец, установка/подъём не нужны;
#   2. локальный PostgreSQL-бинарь (initdb/pg_ctl из PATH, pg_config --bindir,
#      /usr/lib/postgresql/*/bin) — временный кластер в SYNTH_PG_WORK_DIR;
#   3. установка пакета (apt-get/apk, best-effort, нужен root/sudo) — и снова вариант 2;
#   4. docker-образ postgres:<version>-alpine — если доступен docker daemon.
#
# Локальный кластер/контейнер поднимается с `trust`-аутентификацией на 127.0.0.1 и
# нестандартном порту: пароль нигде не задаётся и в лог не попадает (инвариант 13),
# DSN существует только внутри процесса скрипта (и не выводится в outputs шага).
#
# Поведение, если БД поднять нельзя:
#   * внешний DSN задан — он и используется; недоступная БД проявится падением тестов
#     (джоба не «зеленеет молча» — молчаливого пропуска в этой ветке нет вообще);
#   * внешнего DSN нет и локальный/докерный подъём не удался — печатается крупный
#     блок ПРОПУСК с предупреждением. По умолчанию (SYNTH_PG_REQUIRE=0) шаг завершается
#     успешно, чтобы красный CI не был следствием неподтверждённой инфраструктуры
#     раннера; SYNTH_PG_REQUIRE=1 превращает это в жёсткий fail.
#
# Использование:
#   scripts/ci-postgres.sh diagnose           # что доступно (read-only, код 0)
#   scripts/ci-postgres.sh run [cmd...]       # поднять БД + прогнать suite
#                                             # (без аргументов — контрактный suite core + драйвер)
#   scripts/ci-postgres.sh stop               # остановить/удалить локальную БД
#
# Переменные окружения:
#   SYNTH_TEST_POSTGRES_DSN  готовый DSN (высший приоритет; локально/dev)
#   GV_TEST_POSTGRES_DSN     DSN из секрета CI (префикс GV_ обязателен в GitVerse)
#   SYNTH_PG_REQUIRE         1 — недоступность локальной БД валит шаг (по умолчанию 0)
#   SYNTH_PG_VERSION         версия docker-образа (по умолчанию 17)
#   SYNTH_PG_PORT            порт локальной БД (по умолчанию 55432)
#   SYNTH_PG_DB              имя тестовой БД (по умолчанию synth_test)
#   SYNTH_PG_USER            супер-пользователь локальной БД (по умолчанию synth)
#   SYNTH_PG_WORK_DIR        каталог данных/логов (по умолчанию tmp/ci-postgres)
#   SYNTH_PG_DOCKER          0 — не использовать docker-фоллбэк
#   SYNTH_PG_INSTALL         0 — не пробовать apt-get/apk
#   SYNTH_PG_CONTAINER       имя контейнера (по умолчанию synth-ci-postgres)
#   SYNTH_PG_IMAGE           образ (по умолчанию postgres:${SYNTH_PG_VERSION}-alpine)
#   SYNTH_PG_WAIT_SEC        ожидание готовности контейнера, с (по умолчанию 60)

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
cd "$ROOT_DIR" || exit 1

SYNTH_PG_REQUIRE="${SYNTH_PG_REQUIRE:-0}"
SYNTH_PG_VERSION="${SYNTH_PG_VERSION:-17}"
SYNTH_PG_PORT="${SYNTH_PG_PORT:-55432}"
SYNTH_PG_DB="${SYNTH_PG_DB:-synth_test}"
SYNTH_PG_USER="${SYNTH_PG_USER:-synth}"
SYNTH_PG_WORK_DIR="${SYNTH_PG_WORK_DIR:-tmp/ci-postgres}"
SYNTH_PG_DOCKER="${SYNTH_PG_DOCKER:-1}"
SYNTH_PG_INSTALL="${SYNTH_PG_INSTALL:-1}"
SYNTH_PG_CONTAINER="${SYNTH_PG_CONTAINER:-synth-ci-postgres}"
SYNTH_PG_IMAGE="${SYNTH_PG_IMAGE:-postgres:${SYNTH_PG_VERSION}-alpine}"
SYNTH_PG_WAIT_SEC="${SYNTH_PG_WAIT_SEC:-60}"

PGDATA="$SYNTH_PG_WORK_DIR/pgdata"
PG_MODE="" # external | local | docker
PG_DSN=""
PG_BINDIR=""

log() { printf '[ci-postgres] %s\n' "$*"; }
warn() { printf '[ci-postgres] ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
err() { printf '[ci-postgres] ОШИБКА: %s\n' "$*" >&2; }

usage() {
  sed -n '2,47p' "$0" | sed 's/^# \{0,1\}//'
}

check_tool() { command -v "$1" >/dev/null 2>&1; }

# Маскирует пароль в DSN для логов/диагностики (креды не печатаем — инвариант 13).
mask_dsn() {
  printf '%s' "$1" | sed -E 's#(//[^:/@]*):[^@/]*@#\1:***@#'
}

# --- Резолвинг PostgreSQL ---------------------------------------------------

find_pg_bindir() {
  local candidate
  if check_tool initdb && check_tool pg_ctl; then
    dirname "$(command -v initdb)"
    return 0
  fi
  if check_tool pg_config; then
    candidate="$(pg_config --bindir 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate/initdb" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  fi
  for candidate in /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /usr/local/pgsql/bin; do
    if [ -x "$candidate/initdb" ] && [ -x "$candidate/pg_ctl" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

install_postgres() {
  [ "$SYNTH_PG_INSTALL" = "1" ] || {
    log "установка пакета отключена (SYNTH_PG_INSTALL=0)"
    return 1
  }
  local sudo_cmd=""
  if [ "$(id -u)" != "0" ]; then
    if check_tool sudo && sudo -n true 2>/dev/null; then
      sudo_cmd="sudo"
    else
      log "нет root/sudo — установка пакета невозможна"
      return 1
    fi
  fi
  if check_tool apt-get; then
    log "устанавливаю postgresql через apt-get (может занять минуту)"
    $sudo_cmd apt-get update -qq >/dev/null 2>&1 || true
    if $sudo_cmd env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null 2>&1; then
      return 0
    fi
    warn "apt-get install postgresql не удался"
  elif check_tool apk; then
    log "устанавливаю postgresql/postgresql-contrib через apk"
    if $sudo_cmd apk add --no-cache postgresql postgresql-contrib >/dev/null 2>&1; then
      return 0
    fi
    warn "apk add postgresql не удался"
  else
    log "менеджер пакетов (apt-get/apk) не найден"
  fi
  return 1
}

create_test_db_local() {
  local psql="$PG_BINDIR/psql" createdb="$PG_BINDIR/createdb" exists=""
  exists="$("$psql" -h 127.0.0.1 -p "$SYNTH_PG_PORT" -U "$SYNTH_PG_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$SYNTH_PG_DB'" 2>/dev/null || true)"
  if [ "$exists" != "1" ]; then
    "$createdb" -h 127.0.0.1 -p "$SYNTH_PG_PORT" -U "$SYNTH_PG_USER" "$SYNTH_PG_DB" || return 1
  fi
  # pg_trgm нужен GIN-индексу messages.content; миграция создаёт его сама,
  # здесь — на случай прав/DBA-режима (идемпотентно).
  "$psql" -h 127.0.0.1 -p "$SYNTH_PG_PORT" -U "$SYNTH_PG_USER" -d "$SYNTH_PG_DB" \
    -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null 2>&1 || true
  return 0
}

local_up() {
  if [ "$(id -u)" = "0" ]; then
    # initdb/pg_ctl отказываются работать от root; локальный бинарь-путь для root не поддержан
    # (нужен су-переход на системного postgres и согласование владения каталогом) — идём в docker.
    log "скрипт запущен от root — локальный initdb недоступен, оставляю docker/внешний DSN"
    return 1
  fi
  PG_BINDIR="$(find_pg_bindir || true)"
  if [ -z "$PG_BINDIR" ]; then
    install_postgres || return 1
    PG_BINDIR="$(find_pg_bindir || true)"
    if [ -z "$PG_BINDIR" ]; then
      warn "бинарники PostgreSQL не найдены после установки"
      return 1
    fi
  fi
  log "бинарники PostgreSQL: $PG_BINDIR"
  mkdir -p "$SYNTH_PG_WORK_DIR"

  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "initdb: $PGDATA (trust-аутентификация, супер-пользователь $SYNTH_PG_USER)"
    rm -rf "$PGDATA"
    if ! "$PG_BINDIR/initdb" -D "$PGDATA" -U "$SYNTH_PG_USER" -A trust -E UTF8 --no-sync \
      >"$SYNTH_PG_WORK_DIR/initdb.log" 2>&1; then
      warn "initdb не удался — последние строки $SYNTH_PG_WORK_DIR/initdb.log:"
      tail -n 15 "$SYNTH_PG_WORK_DIR/initdb.log" >&2 2>/dev/null || true
      return 1
    fi
  fi

  if ! "$PG_BINDIR/pg_isready" -h 127.0.0.1 -p "$SYNTH_PG_PORT" >/dev/null 2>&1; then
    log "pg_ctl start (порт $SYNTH_PG_PORT)"
    if ! "$PG_BINDIR/pg_ctl" -D "$PGDATA" -w -t 60 \
      -l "$SYNTH_PG_WORK_DIR/postgres.log" \
      -o "-p $SYNTH_PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SYNTH_PG_WORK_DIR" \
      start >/dev/null 2>&1; then
      warn "pg_ctl start не удался — последние строки $SYNTH_PG_WORK_DIR/postgres.log:"
      tail -n 20 "$SYNTH_PG_WORK_DIR/postgres.log" >&2 2>/dev/null || true
      return 1
    fi
  else
    log "PostgreSQL уже слушает 127.0.0.1:$SYNTH_PG_PORT — переиспользую"
  fi

  create_test_db_local || {
    warn "не удалось создать тестовую БД $SYNTH_PG_DB"
    return 1
  }
  PG_MODE="local"
  PG_DSN="postgres://$SYNTH_PG_USER@127.0.0.1:$SYNTH_PG_PORT/$SYNTH_PG_DB"
  return 0
}

docker_up() {
  [ "$SYNTH_PG_DOCKER" = "1" ] || {
    log "docker-фоллбэк отключён (SYNTH_PG_DOCKER=0)"
    return 1
  }
  if ! check_tool docker; then
    log "docker не найден"
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    log "docker daemon недоступен (нет доступа к сокету?)"
    return 1
  fi

  if [ "$(docker inspect -f '{{.State.Running}}' "$SYNTH_PG_CONTAINER" 2>/dev/null)" = "true" ]; then
    log "контейнер $SYNTH_PG_CONTAINER уже запущен — переиспользую"
  else
    docker rm -f "$SYNTH_PG_CONTAINER" >/dev/null 2>&1 || true
    log "запускаю $SYNTH_PG_IMAGE (trust, 127.0.0.1:$SYNTH_PG_PORT)"
    if ! docker run -d --name "$SYNTH_PG_CONTAINER" \
      -e POSTGRES_HOST_AUTH_METHOD=trust \
      -e POSTGRES_USER="$SYNTH_PG_USER" \
      -e POSTGRES_DB="$SYNTH_PG_DB" \
      -p "127.0.0.1:$SYNTH_PG_PORT:5432" "$SYNTH_PG_IMAGE" >/dev/null; then
      warn "docker run не удался"
      return 1
    fi
  fi

  local waited=0 ready=0
  while [ "$waited" -lt "$SYNTH_PG_WAIT_SEC" ]; do
    if docker exec "$SYNTH_PG_CONTAINER" pg_isready -U "$SYNTH_PG_USER" -d "$SYNTH_PG_DB" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  if [ "$ready" != "1" ]; then
    warn "контейнер не стал готов за ${SYNTH_PG_WAIT_SEC} c"
    docker logs --tail 20 "$SYNTH_PG_CONTAINER" >&2 2>/dev/null || true
    return 1
  fi

  docker exec "$SYNTH_PG_CONTAINER" psql -U "$SYNTH_PG_USER" -d "$SYNTH_PG_DB" \
    -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null 2>&1 || true
  PG_MODE="docker"
  PG_DSN="postgres://$SYNTH_PG_USER@127.0.0.1:$SYNTH_PG_PORT/$SYNTH_PG_DB"
  return 0
}

resolve_pg() {
  [ -n "$PG_DSN" ] && return 0
  if [ -n "${SYNTH_TEST_POSTGRES_DSN:-}" ]; then
    PG_MODE="external"
    PG_DSN="$SYNTH_TEST_POSTGRES_DSN"
    log "источник БД: SYNTH_TEST_POSTGRES_DSN ($(mask_dsn "$PG_DSN"))"
    return 0
  fi
  if [ -n "${GV_TEST_POSTGRES_DSN:-}" ]; then
    PG_MODE="external"
    PG_DSN="$GV_TEST_POSTGRES_DSN"
    log "источник БД: секрет GV_TEST_POSTGRES_DSN ($(mask_dsn "$PG_DSN"))"
    return 0
  fi
  log "внешний DSN не задан — поднимаю локальный PostgreSQL"
  local_up && return 0
  warn "локальный PostgreSQL поднять не удалось"
  docker_up && return 0
  warn "docker-фоллбэк не сработал"
  return 1
}

# --- Пропуск / отказ --------------------------------------------------------

soft_skip_or_fail() {
  local reason="$1"
  if [ "$SYNTH_PG_REQUIRE" = "1" ]; then
    err "$reason"
    err "SYNTH_PG_REQUIRE=1 — шаг падает: контрактный suite PostgreSQL без БД не выполнен"
    exit 1
  fi
  printf '\n' >&2
  warn "======================================================================"
  warn " ПРОПУСК: контрактный suite PostgreSQL НЕ ВЫПОЛНЕН (живой БД нет)"
  warn " причина: $reason"
  warn " без SYNTH_TEST_POSTGRES_DSN набор тестов уходит в describe.skip, поэтому"
  warn " «зелёный» прогон этой джобы НЕ означает проверку контракта драйвера."
  warn " как сделать гейт жёстким:"
  warn "   * задать секрет GV_TEST_POSTGRES_DSN (внешняя тестовая БД), либо"
  warn "   * SYNTH_PG_REQUIRE=1 (после подтверждения подъёма БД на раннере)."
  warn " диагностика доступных источников: bash scripts/ci-postgres.sh diagnose"
  warn "======================================================================"
  printf 'SYNTH_PG_SKIPPED=1\n'
  exit 0
}

# --- Прогон тестов ----------------------------------------------------------

run_tests() {
  export SYNTH_TEST_POSTGRES_DSN="$PG_DSN"
  local rc=0
  if [ "$#" -gt 0 ]; then
    log "прогон переданной команды: $*"
    "$@" || rc=$?
    return "$rc"
  fi
  log "1/2 core → контрактный suite портов (src/storage/contract/postgres.test.ts)"
  pnpm --filter @itphx/synth-core exec vitest run src/storage/contract/postgres.test.ts || rc=1
  log "2/2 storage-postgres → smoke-тесты драйвера (миграции, fail-closed, контекст)"
  pnpm --filter @itphx/synth-storage-postgres test || rc=1
  return "$rc"
}

# --- Команды ----------------------------------------------------------------

cmd_diagnose() {
  log "диагностика источников PostgreSQL (ничего не меняет):"
  if [ -n "${SYNTH_TEST_POSTGRES_DSN:-}" ]; then
    log "  SYNTH_TEST_POSTGRES_DSN: задан ($(mask_dsn "$SYNTH_TEST_POSTGRES_DSN"))"
  else
    log "  SYNTH_TEST_POSTGRES_DSN: нет"
  fi
  if [ -n "${GV_TEST_POSTGRES_DSN:-}" ]; then
    log "  GV_TEST_POSTGRES_DSN (секрет CI): задан ($(mask_dsn "$GV_TEST_POSTGRES_DSN"))"
  else
    log "  GV_TEST_POSTGRES_DSN (секрет CI): нет"
  fi
  local bindir
  bindir="$(find_pg_bindir || true)"
  if [ -n "$bindir" ]; then
    log "  PostgreSQL в PATH/системе: $bindir ($("$bindir/postgres" --version 2>/dev/null || echo 'версию не определить'))"
  else
    log "  PostgreSQL в PATH/системе: нет"
  fi
  log "  uid=$(id -u) (локальный initdb требует не-root)"
  if check_tool apt-get || check_tool apk; then
    log "  менеджер пакетов: $([ "$(id -u)" = "0" ] && echo 'root' || (check_tool sudo && sudo -n true 2>/dev/null && echo 'sudo без пароля' || echo 'есть, но нет root/sudo'))"
  else
    log "  менеджер пакетов: нет"
  fi
  if check_tool docker; then
    log "  docker: $(docker info >/dev/null 2>&1 && echo 'daemon доступен' || echo 'daemon недоступен')"
  else
    log "  docker: нет"
  fi
  log "  режим при пропуске: $([ "$SYNTH_PG_REQUIRE" = "1" ] && echo 'fail (SYNTH_PG_REQUIRE=1)' || echo 'мягкий пропуск с предупреждением')"
  exit 0
}

cmd_run() {
  if ! resolve_pg; then
    soft_skip_or_fail "нет внешнего DSN, локальный initdb/apt не сработали, docker недоступен"
  fi
  log "БД готова: режим $PG_MODE, DSN $(mask_dsn "$PG_DSN")"
  local rc=0
  run_tests "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then
    log "контрактный suite PostgreSQL: УСПЕХ"
  else
    err "контрактный suite PostgreSQL: ПРОВАЛ (код $rc)"
  fi
  exit "$rc"
}

cmd_stop() {
  local bindir stopped=0
  bindir="$(find_pg_bindir || true)"
  if [ -n "$bindir" ] && [ -s "$PGDATA/PG_VERSION" ]; then
    log "pg_ctl stop: $PGDATA"
    "$bindir/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
    stopped=1
  fi
  if check_tool docker && [ "$(docker inspect -f '{{.State.Running}}' "$SYNTH_PG_CONTAINER" 2>/dev/null)" = "true" ]; then
    log "docker rm -f: $SYNTH_PG_CONTAINER"
    docker rm -f "$SYNTH_PG_CONTAINER" >/dev/null 2>&1 || true
    stopped=1
  fi
  [ "$stopped" = "1" ] || log "нечего останавливать (локальная БД не поднималась)"
  exit 0
}

COMMAND="${1:-}"
shift 2>/dev/null || true

case "$COMMAND" in
  diagnose | sources) cmd_diagnose ;;
  run | up) cmd_run "$@" ;;
  stop | down) cmd_stop ;;
  '' | -h | --help | help) usage; exit 0 ;;
  *)
    err "неизвестная команда: $COMMAND"
    usage
    exit 2
    ;;
esac
