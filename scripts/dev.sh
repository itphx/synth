#!/usr/bin/env bash
#
# dev.sh — быстрый запуск Synth (монорепо) для локальной разработки
#
# Использование:
#   ./dev.sh            — запустить backend + UI
#   ./dev.sh backend    — только бэкенд
#   ./dev.sh ui         — только UI
#   ./dev.sh core       — synth-core standalone (без UI)
#   ./dev.sh all        — backend + UI + core
#
# Логи пишутся в tmp/backend.log, tmp/ui.log, tmp/core.log.
# При Ctrl+C показываются пути к логам. При перезапуске логи очищаются.

set -o pipefail

# Неинтерактивный режим для pnpm (без TTY может упасть при удалении node_modules)
export CI=true

die() { echo "ОШИБКА: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTH="$ROOT"
LOGDIR="$ROOT/tmp"

# Каталог логов — чтобы backend/UI могли читать логи сервисов (эндпоинт /api/v2/logs)
export SYNTH_LOG_DIR="$LOGDIR"

# Режим разработки: debug-аутентификация с тестовыми пользователями
export SYNTH_AUTH_DEBUG=true

# Каталог данных — вне репозитория; по умолчанию <repo>/../data, переопределяется env
export SYNTH_DATA_DIR="${SYNTH_DATA_DIR:-$ROOT/../data}"

# Конфиг backend. dev.sh запускает backend с cwd=synth/, а findConfigPath()
# ищет config.yaml только в cwd (в dev-режиме → null), поэтому mcp.servers из
# packages/backend/config.yaml не читается. Указываем путь явно, только если
# файл существует (иначе не задаём — чтобы не сломать запуск).
if [ -f "$SYNTH/packages/backend/config.yaml" ]; then
    export SYNTH_CONFIG="$SYNTH/packages/backend/config.yaml"
fi

# Порты компонентов
export SYNTH_PORT="${SYNTH_PORT:-5000}"
export SYNTH_CORE_PORT="${SYNTH_CORE_PORT:-4300}"
export SYNTH_RUNNER_PORT="${SYNTH_RUNNER_PORT:-5200}"

# Хост для всех сервисов (0.0.0.0 — доступ с других машин, localhost — только локально)
export SYNTH_HOST="${SYNTH_HOST:-0.0.0.0}"
export VITE_HOST="${VITE_HOST:-$SYNTH_HOST}"

export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://${SYNTH_HOST}:5000}"
export VITE_PORT="${VITE_PORT:-5002}"

# Доступ с других ПК: разрешённые хосты Vite и CORS origin
export VITE_ALLOWED_HOSTS="${VITE_ALLOWED_HOSTS:-true}"
export SYNTH_CORS_ORIGIN="${SYNTH_CORS_ORIGIN:-}"

# CORS backend по умолчанию fail-closed (пустой белый список НЕ разрешает все
# origin). Для локальной разработки UI (другой порт) открываем CORS явно.
export SYNTH_CORS_ALLOW_ALL="${SYNTH_CORS_ALLOW_ALL:-true}"

# Cookie сессии — `Secure` по умолчанию; локальная разработка идёт по http,
# поэтому явно отключаем флаг только в dev.
export SYNTH_COOKIE_INSECURE="${SYNTH_COOKIE_INSECURE:-true}"

mkdir -p "$LOGDIR"

# Очистка занятых портов (если предыдущий запуск завершился некорректно)
for p in $SYNTH_PORT $SYNTH_CORE_PORT $VITE_PORT; do
    pid=$(fuser $p/tcp 2>/dev/null || true)
    [ -n "$pid" ] && kill $pid 2>/dev/null || true
done

_cleaned=false

cleanup() {
    if $_cleaned; then return; fi
    _cleaned=true
    echo ""
    echo "Остановка сервисов..."
    for pid in $BACKEND_PID $UI_PID $CORE_PID; do
        if [ -n "$pid" ] && kill -0 $pid 2>/dev/null; then
            local pgid=$(ps -o pgid= -p $pid 2>/dev/null | tr -d ' ')
            if [ -n "$pgid" ]; then
                kill -TERM -$pgid 2>/dev/null || true
            else
                kill -TERM $pid 2>/dev/null || true
            fi
        fi
    done
    sleep 3
    for pid in $BACKEND_PID $UI_PID $CORE_PID; do
        if [ -n "$pid" ] && kill -0 $pid 2>/dev/null; then
            local pgid=$(ps -o pgid= -p $pid 2>/dev/null | tr -d ' ')
            if [ -n "$pgid" ]; then
                kill -KILL -$pgid 2>/dev/null || true
            else
                kill -KILL $pid 2>/dev/null || true
            fi
        fi
    done
    for pid in $BACKEND_PID $UI_PID $CORE_PID; do
        wait $pid 2>/dev/null || true
    done
    echo ""
    echo "Логи сохранены:"
    [ -n "$BACKEND_PID" ] && echo "  backend: $LOGDIR/backend.log"
    [ -n "$UI_PID" ]      && echo "  ui:      $LOGDIR/ui.log"
    [ -n "$CORE_PID" ]    && echo "  core:    $LOGDIR/core.log"
    echo ""
    echo "Готово."
}

trap cleanup EXIT INT

start_backend() {
    echo "━━━ Synth Backend (Hono) ━━━"
    cd "$SYNTH"
    : > "$LOGDIR/backend.log"

    # Установка зависимостей (один раз, до запуска)
    echo -n "  проверка зависимостей..."
    pnpm install --silent >>"$LOGDIR/backend.log" 2>&1 || {
        echo ""
        echo "  ОШИБКА: не удалось установить зависимости. Лог:"
        tail -20 "$LOGDIR/backend.log"
        exit 1
    }
    echo " ok"

    # Backend импортирует @itphx/synth-core из dist — всегда пересобираем
    # core ПЕРЕД стартом, иначе фиксы в src не попадут в работающий бэкенд.
    echo -n "  сборка core..."
    pnpm --filter @itphx/synth-core build >>"$LOGDIR/backend.log" 2>&1 || {
        echo ""
        echo "  ОШИБКА: не удалось собрать @itphx/synth-core. Лог:"
        tail -20 "$LOGDIR/backend.log"
        exit 1
    }
    echo " ok"

    # Запускаем tsx напрямую — минуем pnpm, чтобы избежать повторной проверки deps
    "$SYNTH/node_modules/.bin/tsx" packages/backend/src/main.ts >>"$LOGDIR/backend.log" 2>&1 &
    BACKEND_PID=$!

    echo "  http://$SYNTH_HOST:$SYNTH_PORT  (pid $BACKEND_PID)"
    echo "  лог: $LOGDIR/backend.log"

    # Ждём пока бэкенд поднимется (до 30 секунд)
    echo -n "  ожидание запуска"
    for i in $(seq 1 60); do
        if curl -s http://$SYNTH_HOST:$SYNTH_PORT/health >/dev/null 2>&1; then
            echo " готово"
            return 0
        fi
        kill -0 $BACKEND_PID 2>/dev/null || {
            echo ""
            echo "  ОШИБКА: бэкенд не запустился. Лог:"
            tail -20 "$LOGDIR/backend.log"
            exit 1
        }
        echo -n "."
        sleep 0.5
    done
    echo ""
    echo "  ОШИБКА: таймаут запуска бэкенда. Лог:"
    tail -20 "$LOGDIR/backend.log"
    exit 1
}

start_ui() {
    echo "━━━ Synth UI (React) ━━━"
    cd "$SYNTH/packages/ui"
    : > "$LOGDIR/ui.log"

    # Запускаем vite напрямую — минуем pnpm
    ./node_modules/.bin/vite >>"$LOGDIR/ui.log" 2>&1 &
    UI_PID=$!

    echo "  http://$SYNTH_HOST:$VITE_PORT  (pid $UI_PID)"
    echo "  лог: $LOGDIR/ui.log"
}

start_core() {
    echo "━━━ Synth Core (standalone) ━━━"
    cd "$SYNTH"
    : > "$LOGDIR/core.log"

    pnpm --filter @itphx/synth-core build >"$LOGDIR/core.log" 2>&1
    node packages/core/dist/main.js serve --port "$SYNTH_CORE_PORT" --data-dir "$SYNTH_DATA_DIR" >>"$LOGDIR/core.log" 2>&1 &
    CORE_PID=$!

    echo "  http://$SYNTH_HOST:$SYNTH_CORE_PORT  (pid $CORE_PID)"
    echo "  лог: $LOGDIR/core.log"
}

case "${1:-all}" in
    backend)
        echo "Запуск backend..."
        start_backend
        ;;
    ui)
        echo "Запуск UI..."
        start_ui
        ;;
    core)
        echo "Запуск core..."
        start_core
        ;;
    all)
        echo "Запуск backend + UI + core..."
        echo ""
        start_backend
        start_ui
        start_core
        ;;
    *)
        echo "Запуск backend + UI..."
        echo ""
        start_backend
        start_ui
        ;;
esac

echo ""
echo "Нажми Ctrl+C для остановки."
echo "Логи: $LOGDIR/*.log"
wait
