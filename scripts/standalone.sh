#!/usr/bin/env bash
#
# standalone.sh — запуск Synth в standalone-режиме «как у конечного пользователя»
#
# Собирает npm-пакеты монорепо (@itphx/synth-shared/-core/-ui/-synth),
# упаковывает их в tarball'ы, устанавливает в изолированный prefix и запускает
# `synth serve` (локальный HTTP API + UI, один API-ключ, FileStore в data-dir).
#
# Нужен для ручного/автоматического тестирования standalone-UI, в частности
# диалога выбора рабочего каталога (AD-075), где managed-режим показывает
# read-only, а standalone — `confirm`.
#
# Использование:
#   ./scripts/standalone.sh [OPTIONS]
#
# Опции:
#   --port <port>      порт standalone-сервера (default: env SYNTH_CORE_PORT или 4300)
#   --host <host>      адрес прослушивания (default: 127.0.0.1)
#   --data-dir <path>  каталог данных (default: tmp/standalone/data)
#   --api-key <key>    API-ключ local auth (default: авто-генерация; печатается)
#   --prefix <path>    каталог установки пакетов (default: tmp/standalone/install)
#   --no-build         не пересобирать пакеты (использовать уже собранные dist)
#   --rebuild-packs    принудительно пересобрать tarball'ы
#   --check            после запуска прогнать smoke-проверки и завершиться
#                      (сервер не оставлять; код выхода 0/1)
#   --keep-data        не очищать --data-dir (поведение по умолчанию)
#   --clean            очистить --data-dir перед запуском
#   --help             показать справку и выйти
#
# Логи: tmp/standalone-build.log — сборка/упаковка/установка,
#       tmp/standalone.log       — вывод standalone-сервера.
#
# Требования: Node.js >= 22, npm, pnpm, curl; fuser — желателен (страховка
# освобождения порта). Примечание: tarball'ы собираются через `pnpm pack`
# (а не `npm pack`): только pnpm резолвит `workspace:*` в реальную версию,
# иначе npm при установке не может разрешить локальные пакеты.

set -o pipefail

# Неинтерактивный режим для pnpm (без TTY может упасть при удалении node_modules)
export CI=true

die() { echo "ОШИБКА: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTH="$ROOT"
TMP="$ROOT/tmp"
STANDALONE_TMP="$TMP/standalone"
PACKS="$STANDALONE_TMP/packs"
BUILD_LOG="$TMP/standalone-build.log"
RUN_LOG="$TMP/standalone.log"
CHECK_BODY="$STANDALONE_TMP/.check-body.json"

# pnpm/node должны выполняться из корня воркспейса независимо от того,
# откуда вызван скрипт (иначе pnpm не найдёт package.json/pnpm-workspace.yaml)
cd "$SYNTH"

# ── Значения по умолчанию ────────────────────────────────────────────────
PORT="${SYNTH_CORE_PORT:-4300}"
HOST="127.0.0.1"
DATA_DIR="$STANDALONE_TMP/data"
API_KEY=""
PREFIX="$STANDALONE_TMP/install"
DO_BUILD=true
DO_REBUILD_PACKS=false
DO_CHECK=false
CLEAN_DATA=false

# ── Разбор аргументов ─────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
standalone.sh — запуск Synth в standalone-режиме из собранных npm-пакетов

Использование:
  ./scripts/standalone.sh [OPTIONS]

Опции:
  --port <port>      порт standalone-сервера (default: env SYNTH_CORE_PORT или 4300)
  --host <host>      адрес прослушивания (default: 127.0.0.1)
  --data-dir <path>  каталог данных (default: tmp/standalone/data)
  --api-key <key>    API-ключ local auth (default: авто-генерация; печатается)
  --prefix <path>    каталог установки пакетов (default: tmp/standalone/install)
  --no-build         не пересобирать пакеты (использовать уже собранные dist)
  --rebuild-packs    принудительно пересобрать tarball'ы
  --check            прогнать smoke-проверки и завершиться (код 0/1)
  --keep-data        не очищать --data-dir (по умолчанию)
  --clean            очистить --data-dir перед запуском
  --help             показать справку и выйти

Примеры:
  ./scripts/standalone.sh                 # собрать, установить, запустить (foreground)
  ./scripts/standalone.sh --no-build      # быстрый перезапуск на уже собранных пакетах
  ./scripts/standalone.sh --check         # полный smoke и выход (CI/автотест)
  ./scripts/standalone.sh --clean --port 4310
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --help)
            usage
            exit 0
            ;;
        --port)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            PORT="$2"; shift 2
            ;;
        --host)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            HOST="$2"; shift 2
            ;;
        --data-dir)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            DATA_DIR="$2"; shift 2
            ;;
        --api-key)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            API_KEY="$2"; shift 2
            ;;
        --prefix)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            PREFIX="$2"; shift 2
            ;;
        --no-build)
            DO_BUILD=false; shift
            ;;
        --rebuild-packs)
            DO_REBUILD_PACKS=true; shift
            ;;
        --check)
            DO_CHECK=true; shift
            ;;
        --keep-data)
            CLEAN_DATA=false; shift
            ;;
        --clean)
            CLEAN_DATA=true; shift
            ;;
        -*)
            die "Неизвестная опция: $1. Используйте --help для справки."
            ;;
        *)
            die "Лишний аргумент: $1. Используйте --help для справки."
            ;;
    esac
done

# ── Проверка окружения ────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    die "Node.js не установлен. Требуется версия >= 22."
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ] 2>/dev/null; then
    die "Node.js $(node -v) слишком старый. Требуется >= 22."
fi

if ! command -v npm &>/dev/null; then
    die "npm не установлен. Требуется npm (идёт в комплекте с Node.js)."
fi

if ! command -v pnpm &>/dev/null; then
    die "pnpm не установлен. Установите: npm i -g pnpm"
fi

if ! command -v curl &>/dev/null; then
    die "curl не установлен. Требуется для ожидания /health и smoke-проверок."
fi

if [ ! -f "$SYNTH/pnpm-workspace.yaml" ]; then
    die "Не найден $SYNTH/pnpm-workspace.yaml. Запустите скрипт из корня проекта."
fi

mkdir -p "$TMP" "$STANDALONE_TMP"

# ── Локальный API-ключ (авто-генерация) ───────────────────────────────────
if [ -z "$API_KEY" ]; then
    if command -v openssl &>/dev/null; then
        API_KEY=$(openssl rand -hex 16)
    else
        API_KEY=$(date +%s | sha256sum | head -c 32)
    fi
fi

# ── Формирование путей к пакетам/tarball'ам ───────────────────────────────
# Список: <каталог в packages/>:<имя npm-пакета>:<label>
PACKAGE_SPECS=(
    "shared:@itphx/synth-shared:shared"
    "core:@itphx/synth-core:core"
    "ui:@itphx/synth-ui:ui"
    "synth:@itphx/synth:synth"
)

pkg_version() {
    node -e "console.log(require('$1/package.json').version)"
}

# Имя tarball'а, как его создаёт pnpm pack: @scope/name -> scope-name-version.tgz
tarball_path() {
    local pkgdir="$1" name="$2"
    local flat="${name#@}"
    flat="${flat//\//-}"
    echo "$PACKS/${flat}-$(pkg_version "$pkgdir").tgz"
}

packs_complete() {
    local spec pkgdir name
    for spec in "${PACKAGE_SPECS[@]}"; do
        pkgdir="$ROOT/packages/${spec%%:*}"
        name="${spec#*:}"; name="${name%%:*}"
        [ -f "$(tarball_path "$pkgdir" "$name")" ] || return 1
    done
    return 0
}

require_dist() {
    local missing=""
    [ -f "$ROOT/packages/shared/dist/index.js" ] || missing="$missing shared"
    [ -f "$ROOT/packages/core/dist/index.js" ]   || missing="$missing core"
    [ -f "$ROOT/packages/ui/dist/index.html" ]   || missing="$missing ui"
    [ -f "$ROOT/packages/synth/dist/cli.js" ]    || missing="$missing synth"
    if [ -n "$missing" ]; then
        die "Нет собранных dist для:$missing. Запустите без --no-build (или соберите пакеты)."
    fi
}

# ── Шаг 1: сборка ─────────────────────────────────────────────────────────
build_pkg() {
    local pkg="$1" label="$2"
    echo -n "  сборка $label..."
    if ! pnpm --filter "$pkg" build >>"$BUILD_LOG" 2>&1; then
        echo ""
        echo "  ОШИБКА: не удалось собрать $pkg. Лог:"
        tail -30 "$BUILD_LOG"
        exit 1
    fi
    echo " ok"
}

if [ "$DO_BUILD" = true ]; then
    echo "Сборка пакетов (лог: $BUILD_LOG):"
    : > "$BUILD_LOG"

    echo -n "  установка зависимостей..."
    if ! pnpm install --frozen-lockfile --reporter=append-only >>"$BUILD_LOG" 2>&1; then
        echo ""
        echo "  ОШИБКА: не удалось установить зависимости. Лог:"
        tail -30 "$BUILD_LOG"
        exit 1
    fi
    echo " ok"

    # Порядок важен: core нужен собранный shared, synth — собранный core/ui.
    build_pkg "@itphx/synth-shared" "shared"
    build_pkg "@itphx/synth-core"   "core"
    build_pkg "@itphx/synth-ui"     "ui"
    build_pkg "@itphx/synth"        "synth"

    [ -f "$ROOT/packages/synth/dist/cli.js" ] || die "Файл бандла не создан: packages/synth/dist/cli.js"
fi

# ── Шаг 2: упаковка tarball'ов ────────────────────────────────────────────
# Пересобираем, если: была сборка, запрошен --rebuild-packs или набор tarball'ов
# неполный. Иначе (--no-build) переиспользуем уже упакованное.
NEED_PACKS=false
if [ "$DO_BUILD" = true ] || [ "$DO_REBUILD_PACKS" = true ]; then
    NEED_PACKS=true
elif ! packs_complete; then
    echo "Набор tarball'ов неполный — упаковываю из уже собранных dist."
    NEED_PACKS=true
fi

if [ "$NEED_PACKS" = true ]; then
    require_dist
    echo "Упаковка пакетов (pnpm pack):"
    rm -rf "$PACKS"
    mkdir -p "$PACKS"
    for spec in "${PACKAGE_SPECS[@]}"; do
        pkgdir="$ROOT/packages/${spec%%:*}"
        name="${spec#*:}"; name="${name%%:*}"
        label="${spec##*:}"
        echo -n "  $label..."
        if ! (cd "$pkgdir" && pnpm pack --pack-destination "$PACKS") >>"$BUILD_LOG" 2>&1; then
            echo ""
            echo "  ОШИБКА: не удалось упаковать $name. Лог:"
            tail -30 "$BUILD_LOG"
            exit 1
        fi
        echo " ok"
    done
    packs_complete || die "Не все tarball'ы созданы в $PACKS. Лог: $BUILD_LOG"
else
    echo "Упаковка: используются готовые tarball'ы из $PACKS (--no-build)."
fi

# ── Шаг 3: установка в изолированный prefix ───────────────────────────────
echo "Установка в $PREFIX (лог: $BUILD_LOG):"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
(cd "$PREFIX" && npm init -y >/dev/null 2>&1) || die "npm init -y не удался в $PREFIX"

TGZ_FILES=("$PACKS"/*.tgz)
[ -f "${TGZ_FILES[0]}" ] || die "В $PACKS нет tarball'ов."
# Один вызов npm install со всеми tarball'ами — так npm разрешает
# @itphx/synth-* из переданных файлов, а не из реестра.
echo -n "  npm install (${#TGZ_FILES[@]} tgz)..."
if ! (cd "$PREFIX" && npm install --no-audit --no-fund "${TGZ_FILES[@]}") >>"$BUILD_LOG" 2>&1; then
    echo ""
    echo "  ОШИБКА: npm install не удался. Лог:"
    tail -40 "$BUILD_LOG"
    exit 1
fi
echo " ok"

SYNTH_BIN="$PREFIX/node_modules/.bin/synth"
[ -e "$SYNTH_BIN" ] || die "Не найден $SYNTH_BIN после установки. Лог: $BUILD_LOG"
INSTALLED_VERSION=$("$SYNTH_BIN" --version 2>/dev/null || echo "?")
echo "  установлено: @itphx/synth $INSTALLED_VERSION"

# ── Шаг 4: подготовка data-dir и запуск ───────────────────────────────────
if [ "$CLEAN_DATA" = true ]; then
    case "$DATA_DIR" in
        ""|"/"|"$HOME")
            die "Отказ от очистки небезопасного --data-dir: '$DATA_DIR'"
            ;;
    esac
    echo "Очистка data-dir: $DATA_DIR"
    rm -rf "$DATA_DIR"
fi
mkdir -p "$DATA_DIR"

if command -v fuser &>/dev/null && fuser "$PORT/tcp" >/dev/null 2>&1; then
    die "Порт $PORT занят. Остановите процесс или используйте --port <другой>."
fi

# Хост подключения для curl: 0.0.0.0 не маршрутизируется как адрес назначения.
CONNECT_HOST="$HOST"
[ "$CONNECT_HOST" = "0.0.0.0" ] && CONNECT_HOST="127.0.0.1"
ROOT_URL="http://$CONNECT_HOST:$PORT"
BASE_URL="$ROOT_URL/api/v2"

SERVER_PID=""
SERVER_STARTED=false
_cleaned=false

cleanup() {
    if [ "$_cleaned" = true ]; then return; fi
    _cleaned=true
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        for _ in $(seq 1 25); do
            kill -0 "$SERVER_PID" 2>/dev/null || break
            sleep 0.2
        done
        if kill -0 "$SERVER_PID" 2>/dev/null; then
            kill -KILL "$SERVER_PID" 2>/dev/null || true
        fi
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    # Страховка: освободить порт, если остался процесс-слушатель (например, дочерний).
    if [ "$SERVER_STARTED" = true ] && command -v fuser &>/dev/null; then
        fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo ""
echo "━━━ Synth: standalone ━━━"
echo "  Запуск: node_modules/.bin/synth serve"
echo "  Лог:    $RUN_LOG"
: > "$RUN_LOG"

SYNTH_DATA_DIR="$DATA_DIR" "$SYNTH_BIN" serve \
    --host "$HOST" \
    --port "$PORT" \
    --api-key "$API_KEY" \
    --no-auto-profile \
    >>"$RUN_LOG" 2>&1 &
SERVER_PID=$!
SERVER_STARTED=true

echo -n "  ожидание /health"
READY=false
for _ in $(seq 1 60); do
    if curl -sf "$ROOT_URL/health" >/dev/null 2>&1; then
        READY=true
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo ""
        echo "  ОШИБКА: standalone-сервер завершился при старте. Лог:"
        tail -30 "$RUN_LOG"
        exit 1
    fi
    echo -n "."
    sleep 0.5
done
echo ""

if [ "$READY" != true ]; then
    echo "  ОШИБКА: таймаут ожидания $ROOT_URL/health. Лог:"
    tail -30 "$RUN_LOG"
    exit 1
fi

echo ""
echo "  URL:        $ROOT_URL"
echo "  API:        $BASE_URL"
echo "  API-key:    $API_KEY"
echo "  data-dir:   $DATA_DIR"
echo "  prefix:     $PREFIX"
echo ""

# ── Шаг 5: smoke-проверки (--check) ───────────────────────────────────────
CHECK_FAILED=false
check_ok()   { echo "  [OK]   $1"; }
check_fail() { echo "  [FAIL] $1" >&2; CHECK_FAILED=true; }

# http <METHOD> <URL> [JSON] — печатает HTTP-код, тело складывает в CHECK_BODY.
http() {
    local method="$1" url="$2" data="${3:-}"
    local args=(-sS -o "$CHECK_BODY" -w '%{http_code}' --max-time 20
        -X "$method" "$url" -H "Authorization: Bearer $API_KEY")
    if [ -n "$data" ]; then
        args+=(-H 'Content-Type: application/json' -d "$data")
    fi
    curl "${args[@]}"
}

run_checks() {
    local code policy

    echo "Smoke-проверки (base: $BASE_URL):"

    # 1. /health → 200
    code=$(http GET "$ROOT_URL/health")
    if [ "$code" = "200" ]; then
        check_ok "GET /health → 200"
    else
        check_fail "GET /health → $code (ожидалось 200)"
    fi

    # 2. POST /projects → 201 + создан каталог workspace
    code=$(http POST "$BASE_URL/projects" '{"name":"Standalone Check","workspace":"standalone-check"}')
    if [ "$code" = "201" ]; then
        check_ok "POST /projects → 201"
    else
        check_fail "POST /projects → $code (ожидалось 201): $(cat "$CHECK_BODY" 2>/dev/null)"
    fi
    local ws_dir="$DATA_DIR/workspaces/standalone-check"
    if [ -d "$ws_dir" ]; then
        check_ok "каталог workspace создан: $ws_dir"
    else
        check_fail "каталог workspace не создан: $ws_dir"
    fi

    # 3. GET /fs/workspace-root → 200
    code=$(http GET "$BASE_URL/fs/workspace-root")
    if [ "$code" = "200" ]; then
        check_ok "GET /fs/workspace-root → 200"
    else
        check_fail "GET /fs/workspace-root → $code (ожидалось 200): $(cat "$CHECK_BODY" 2>/dev/null)"
    fi

    # 4. GET /settings/workspace-policy → 200, outsideRoot=confirm (standalone)
    code=$(http GET "$BASE_URL/settings/workspace-policy")
    if [ "$code" = "200" ]; then
        policy=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).outsideRoot))}catch{process.stdout.write("parse-error")}})' < "$CHECK_BODY" 2>/dev/null)
        if [ "$policy" = "confirm" ]; then
            check_ok "GET /settings/workspace-policy → 200, outsideRoot=confirm"
        else
            check_fail "GET /settings/workspace-policy → 200, outsideRoot=$policy (ожидалось confirm)"
        fi
    else
        check_fail "GET /settings/workspace-policy → $code (ожидалось 200): $(cat "$CHECK_BODY" 2>/dev/null)"
    fi
}

if [ "$DO_CHECK" = true ]; then
    run_checks
    echo ""
    if [ "$CHECK_FAILED" = true ]; then
        echo "Результат: FAIL"
        exit 1
    fi
    echo "Результат: OK"
    exit 0
fi

# ── Шаг 6: foreground (без --check) ───────────────────────────────────────
echo "  Остановка: Ctrl+C"
echo ""
wait "$SERVER_PID"
rc=$?
SERVER_PID=""
echo ""
echo "Standalone-сервер остановлен (код $rc)."
exit $rc
