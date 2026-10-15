#!/usr/bin/env bash
#
# hybrid.sh — запуск Synth локально в гибридном режиме
#
# Поднимает локальный core (CLI-обёртка @itphx/synth) с подключением
# к удалённому backend (боевой инстанс K3s): в одном локальном UI
# объединяются локальные и удалённые проекты/сессии, а LLM-запросы
# централизованы на сервере.
#
# Использование:
#   ./scripts/hybrid.sh [OPTIONS] [SERVER_URL]
#
#   SERVER_URL — адрес удалённого backend (env SYNTH_SERVER_URL). Если не задан —
#   сервер стартует без известного адреса, адрес вводится в форме входа UI.
#
# Опции:
#   --issuer <url>      OIDC issuer (default https://keycloak.itphx.loc/realms/synth)
#                       — fallback дискавери, если сервер не отдаёт /auth/oidc-meta
#   --client-id <id>    OIDC client_id (default synth-cli)
#   --token <key>       API-ключ для аутентификации на удалённом backend
#                       (иначе — вход в UI: адрес сервера + логин/пароль)
#   --api-key <key>     API-ключ локального core (default: авто-генерация).
#                       Защищает HTTP API локального core; в гибридном UI-входе
#                       не нужен. Для отладки/интеграций доступен через
#                       --print-api-key.
#   --print-api-key     показать полный локальный API-ключ в сводке запуска
#   --port <port>       порт локального core (default 4300; standalone — 4400)
#   --data-dir <path>   каталог данных локального мира (default ~/.local/share/synth)
#   --home <path>       локальный home-каталог (ADR-079). Если задан — config/data/
#                       profiles/credentials резолвятся от него (data-dir по
#                       умолчанию не подставляется, чтобы home им управлял).
#   --no-build          не пересобирать пакеты
#   --build             принудительная полная пересборка (shared+core+ui+synth)
#   --help              справка
#
# Внутренний CA: скрипт экспортирует NODE_EXTRA_CA_CERTS на файл
# CA боевого инстанса, иначе Node/undici не доверяет его сертификатам.
# Источник: env SYNTH_CA_CERT, иначе ../synth-deploy/certs/itphx-ca.crt
# относительно корня репозитория.
#
# Требования: Node.js >= 22, pnpm, curl, fuser, openssl (опционально).

set -o pipefail

# Неинтерактивный режим для pnpm (без TTY может упасть при удалении node_modules)
export CI=true

die() { echo "ОШИБКА: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTH="$ROOT"
LOGDIR="$ROOT/tmp"
BUILD_LOG="$LOGDIR/hybrid-build.log"
CLI="$SYNTH/packages/synth/dist/cli.js"

# pnpm/node должны выполняться из корня воркспейса независимо от того,
# откуда вызван скрипт (иначе pnpm не найдёт package.json/pnpm-workspace.yaml)
cd "$SYNTH"

# ── Значения по умолчанию ────────────────────────────────────────────────
# Адрес сервера НЕ подставляется молча: если не задан аргументом или env
# SYNTH_SERVER_URL — сервер стартует без --connect, адрес вводится в UI.
SERVER_URL="${SYNTH_SERVER_URL:-}"
ISSUER="https://keycloak.itphx.loc/realms/synth"
CLIENT_ID="synth-cli"
TOKEN=""
API_KEY=""
PRINT_API_KEY=false   # показывать полный ключ в сводке запуска (--print-api-key)
PORT="4300"
HOME_DIR=""           # ADR-079: --home (пусто — текущее XDG-поведение)
DATA_DIR_SET=false    # задан ли data-dir явно (флагом или env)
if [ -n "${DATA_DIR:-}" ]; then
    DATA_DIR_SET=true
else
    DATA_DIR="$HOME/.local/share/synth"
fi
DO_BUILD="default"   # default | full | none

# ── Разбор аргументов ─────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
hybrid.sh — запуск Synth локально в гибридном режиме (подключение к удалённому backend)

Использование:
  ./scripts/hybrid.sh [OPTIONS] [SERVER_URL]

Аргументы:
  SERVER_URL   адрес удалённого backend (env SYNTH_SERVER_URL). Если не задан —
               сервер стартует без известного адреса, адрес вводится в форме входа UI.

Опции:
  --issuer <url>      OIDC issuer (default: https://keycloak.itphx.loc/realms/synth)
                      — fallback дискавери, если сервер не отдаёт /auth/oidc-meta
  --client-id <id>    OIDC client_id (default: synth-cli)
  --token <key>       API-ключ для аутентификации на удалённом backend
                      (иначе — вход в UI: адрес сервера + логин/пароль)
  --api-key <key>     API-ключ локального core (default: авто-генерация).
                      Защищает HTTP API локального core; в гибридном UI-входе
                      не нужен. Для отладки/интеграций доступен через
                      --print-api-key.
  --print-api-key     показать полный локальный API-ключ в сводке запуска
  --port <port>       порт локального core (default: 4300; standalone — 4400)
  --data-dir <path>   каталог данных локального мира (default: ~/.local/share/synth)
  --home <path>       локальный home-каталог (ADR-079: config/data/profiles/credentials).
                      Без флага сохраняется текущее поведение (XDG/~/.local/share/synth).
  --no-build          не пересобирать пакеты
  --build             принудительная полная пересборка (shared+core+ui+synth)
  --help              показать справку и выйти

Примеры:
  ./scripts/hybrid.sh
  ./scripts/hybrid.sh --token <api-key> --port 4400
  ./scripts/hybrid.sh https://synth.k3s.itphx.loc --no-build
  SYNTH_SERVER_URL=https://synth.k3s.itphx.loc ./scripts/hybrid.sh
EOF
}

SERVER_URL_GIVEN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --help)
            usage
            exit 0
            ;;
        --issuer)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            ISSUER="$2"; shift 2
            ;;
        --client-id)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            CLIENT_ID="$2"; shift 2
            ;;
        --token)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            TOKEN="$2"; shift 2
            ;;
        --api-key)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            API_KEY="$2"; shift 2
            ;;
        --print-api-key)
            PRINT_API_KEY=true; shift
            ;;
        --port)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            PORT="$2"; shift 2
            ;;
        --data-dir)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            DATA_DIR="$2"; DATA_DIR_SET=true; shift 2
            ;;
        --home)
            [ $# -ge 2 ] || die "Опция $1 требует значение (см. --help)"
            HOME_DIR="$2"; shift 2
            ;;
        --no-build)
            DO_BUILD="none"; shift
            ;;
        --build)
            DO_BUILD="full"; shift
            ;;
        -*)
            die "Неизвестная опция: $1. Используйте --help для справки."
            ;;
        *)
            # Позиционный аргумент — адрес удалённого backend
            if [ "$SERVER_URL_GIVEN" = true ]; then
                die "Лишний аргумент: $1. Укажите только один SERVER_URL."
            fi
            SERVER_URL="$1"; SERVER_URL_GIVEN=true; shift
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

if ! command -v pnpm &>/dev/null; then
    die "pnpm не установлен. Установите: npm i -g pnpm"
fi

if [ ! -f "$SYNTH/pnpm-workspace.yaml" ]; then
    die "Не найден $SYNTH/pnpm-workspace.yaml. Запустите скрипт из корня проекта."
fi

# ── Нормализация SERVER_URL (убираем завершающий /) ───────────────────────
SERVER_URL="${SERVER_URL%/}"

# ── Внутренний CA ─────────────────────────────────────────────────────────
CA_CERT="${SYNTH_CA_CERT:-$ROOT/../synth-deploy/certs/itphx-ca.crt}"
if [ -n "$CA_CERT" ] && [ -f "$CA_CERT" ]; then
    export NODE_EXTRA_CA_CERTS="$CA_CERT"
    echo "  CA: $CA_CERT"
else
    echo "ВНИМАНИЕ: внутренний CA не найден ($CA_CERT)."
    echo "  Подключение к боевому инстансу может не пройти"
    echo "  (SELF_SIGNED_CERT_IN_CHAIN). Укажите путь через SYNTH_CA_CERT."
fi

# ── Проверка доступности удалённого сервера (только если адрес задан) ─────
if [ -n "$SERVER_URL" ]; then
    echo -n "  сервер $SERVER_URL..."
    if ! curl -sk --max-time 8 "$SERVER_URL/health" >/dev/null 2>&1; then
        echo ""
        die "Сервер $SERVER_URL недоступен. Проверьте сеть/инстанс: curl -k $SERVER_URL/health"
    fi
    echo " ok"
else
    echo "  адрес сервера не задан — введите его в форме входа UI"
fi

# ── Проверка, что локальный порт свободен ─────────────────────────────────
if fuser "$PORT/tcp" >/dev/null 2>&1; then
    die "Порт $PORT занят. Остановите процесс или используйте --port <другой>."
fi

# ── Сборка ────────────────────────────────────────────────────────────────
mkdir -p "$LOGDIR"

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

if [ "$DO_BUILD" != "none" ]; then
    echo "Сборка пакетов (лог: $BUILD_LOG):"
    : > "$BUILD_LOG"

    if [ "$DO_BUILD" = "full" ] || [ ! -f "$SYNTH/packages/ui/dist/index.html" ]; then
        NEED_UI=true
    else
        NEED_UI=false
    fi

    echo -n "  установка зависимостей..."
    if ! pnpm install --reporter=append-only >>"$BUILD_LOG" 2>&1; then
        echo ""
        echo "  ОШИБКА: не удалось установить зависимости. Лог:"
        tail -30 "$BUILD_LOG"
        exit 1
    fi
    echo " ok"

    build_pkg "@itphx/synth-shared" "shared"
    build_pkg "@itphx/synth-core"   "core"
    if $NEED_UI; then
        build_pkg "@itphx/synth-ui" "ui"
    fi
    build_pkg "@itphx/synth"        "synth"

    if [ ! -f "$CLI" ]; then
        die "Файл бандла не создан: $CLI"
    fi
fi

# ── Локальный API-ключ (авто-генерация) ───────────────────────────────────
if [ -z "$API_KEY" ]; then
    if command -v openssl &>/dev/null; then
        API_KEY=$(openssl rand -hex 16)
    else
        API_KEY=$(date +%s | sha256sum | head -c 32)
    fi
fi

# ── План запуска ──────────────────────────────────────────────────────────
echo ""
echo "━━━ Synth: гибридный режим ━━━"
if [ -n "$SERVER_URL" ]; then
    echo "  Удалённый backend: $SERVER_URL"
else
    echo "  Удалённый backend: (не задан — адрес вводится в форме входа UI)"
fi
echo "  OIDC issuer:       $ISSUER (fallback дискавери)"
echo "  OIDC client_id:    $CLIENT_ID"
if [ -n "$TOKEN" ]; then
    echo "  Удалённый ключ:    (задан --token, вход автоматический)"
else
    echo "  Вход в UI:         адрес сервера + логин/пароль"
fi
echo "  Локальный порт:    $PORT"
if [ -n "$HOME_DIR" ] && [ "$DATA_DIR_SET" != true ]; then
    echo "  Локальный home:    $HOME_DIR"
    echo "  Локальный data:    $HOME_DIR/data"
else
    echo "  Локальный data:    $DATA_DIR"
fi
if [ "$PRINT_API_KEY" = true ]; then
    echo "  Локальный API-key: $API_KEY"
else
    echo "  Локальный API:    авто-ключ (скрыт; показать: --print-api-key)"
fi
echo ""
echo "  UI: http://localhost:$PORT"
if [ -n "$TOKEN" ]; then
    echo "  Подключение к backend произойдёт автоматически (--token)."
else
    echo "  Откройте http://localhost:$PORT и войдите — адрес сервера + логин/пароль."
fi
echo "  Остановка: Ctrl+C"
echo ""

# ── Запуск (foreground) ───────────────────────────────────────────────────
# CLI сам обрабатывает SIGINT/SIGTERM (graceful shutdown) — здесь просто
# транслируем сигналы дочернему процессу и дожидаемся его завершения.
# Вход всегда лёгкий (runtime): переключение сервера происходит в UI без
# перезапуска процесса, поэтому никакого цикла рестарта не нужно.
CLI_PID=""
forward_signal() {
    if [ -n "$CLI_PID" ] && kill -0 "$CLI_PID" 2>/dev/null; then
        kill -"$1" "$CLI_PID" 2>/dev/null || true
    fi
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM

CLI_ARGS=(serve
    --oidc-issuer "$ISSUER"
    --oidc-client-id "$CLIENT_ID"
    --port "$PORT"
    --api-key "$API_KEY"
)
# ADR-079: при заданном --home дефолтный --data-dir не подставляем — home сам
# задаёт <home>/data (явный --data-dir/env по-прежнему приоритетнее).
if [ -n "$HOME_DIR" ]; then
    CLI_ARGS+=(--home "$HOME_DIR")
fi
if [ "$DATA_DIR_SET" = true ] || [ -z "$HOME_DIR" ]; then
    CLI_ARGS+=(--data-dir "$DATA_DIR")
fi
if [ -n "$SERVER_URL" ]; then
    CLI_ARGS+=(--connect "$SERVER_URL")
fi
if [ -n "$TOKEN" ]; then
    CLI_ARGS+=(--token "$TOKEN")
fi

node "$CLI" "${CLI_ARGS[@]}" &
CLI_PID=$!
wait "$CLI_PID"
rc=$?
CLI_PID=""
trap - INT TERM

echo ""
echo "Готово. Локальный core остановлен."
if [ -n "$HOME_DIR" ]; then
    echo "  Кэш credentials: $HOME_DIR/credentials.json"
else
    echo "  Кэш credentials: ~/.config/synth/credentials.json"
fi
if [ -n "$SERVER_URL" ]; then
    echo "  Отключиться от backend: node \"$CLI\" disconnect --backend \"$SERVER_URL\""
fi
echo ""
exit $rc
