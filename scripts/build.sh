#!/usr/bin/env bash
#
# build.sh — сборка релизной версии Synth
#
# Собирает все пакеты монорепозитория в production-режиме:
#   1. @itphx/synth-shared            — типы, схемы, утилиты (фундамент)
#   2. @itphx/synth-core              — движок, провайдеры, HTTP API, CLI
#   3. @itphx/synth-executor          — исполнитель агентских команд (PROP-077)
#   4. @itphx/synth-storage-postgres  — опциональный БД-драйвер слоя хранения (ADR-097)
#   5. @itphx/synth-ui                — React SPA (Vite production build)
#   6. @itphx/synth-sdk               — типизированный клиент публичного API (ADR-052)
#   7. @itphx/synth                   — npm-пакет: бандл CLI + UI + промпты
#   8. Docker-образ                   — (опционально) сборка контейнера
#
# Результат: packages/synth/dist/cli.js (исполняемый бандл)
#            packages/synth/ui/            (статическая сборка UI)
#            packages/synth/prompts/       (системные промпты)
#
# Использование:
#   ./build.sh                  — полная сборка
#   ./build.sh --check          — сборка + проверка типов и тестов
#   ./build.sh --clean          — очистить dist перед сборкой
#   ./build.sh --docker         — сборка + Docker-образ (тег по умолчанию: dev)
#   ./build.sh --docker-tag=<tag> — Docker-образ с указанным тегом
#   ./build.sh --help           — показать справку и выйти
#
# Docker-тег `latest` не используется: квота GitVerse считает размер каждой
# версии без дедупликации, а `latest` — дубликат версионного тега. Релиз
# передаёт явный версионный тег (см. publish.sh), локальная сборка получает
# нейтральный тег `dev`.
#
# Требования: Node.js >= 22, pnpm >= 11, docker (для --docker)

set -o pipefail

die() { echo "ОШИБКА: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
build.sh — сборка релизной версии Synth

Использование:
  ./build.sh                              — полная сборка
  ./build.sh --check                      — сборка + проверка типов и тестов
  ./build.sh --clean                      — очистить dist перед сборкой
  ./build.sh --docker                     — сборка + Docker-образ (тег по умолчанию: dev)
  ./build.sh --docker-tag=<tag>           — Docker-образ с указанным тегом
                                            (релиз передаёт версию: --docker-tag=0.6.0)
  ./build.sh --docker-registry=<registry> — реестр Docker-образа (по умолчанию: gitverse.ru)
  ./build.sh --help                       — показать эту справку и выйти

Переменные окружения:
  DOCKER_TAG       — тег Docker-образа (по умолчанию: dev)
  DOCKER_REGISTRY  — реестр Docker-образа (по умолчанию: gitverse.ru)

Тег `latest` не используется: квота GitVerse считает размер каждой версии без
дедупликации, поэтому релиз публикует только версионный тег (см. publish.sh).

Требования: Node.js >= 22, pnpm >= 11, docker (для --docker)
EOF
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTH="$ROOT"

BUILD_DOCKER=false
# Тег `latest` не используем: релиз передаёт явный версионный тег (--docker-tag=<version>),
# локальная сборка идёт под нейтральным `dev`.
DOCKER_TAG="${DOCKER_TAG:-dev}"
DOCKER_REGISTRY="${DOCKER_REGISTRY:-gitverse.ru}"
CLEAN=false
DO_CHECK=false

for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=true ;;
        --check) DO_CHECK=true ;;
        --docker) BUILD_DOCKER=true ;;
        --docker-tag=*)
            BUILD_DOCKER=true
            DOCKER_TAG="${arg#*=}"
            ;;
        --docker-registry=*)
            DOCKER_REGISTRY="${arg#*=}"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "Неизвестная опция: $arg. Используйте --help для справки."
            ;;
    esac
done

echo "━━━ Synth: сборка ━━━"
echo ""

# Проверка окружения
echo "[1/9] Проверка окружения..."

if ! command -v node &>/dev/null; then
    die "Node.js не установлен. Требуется версия >= 22."
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ] 2>/dev/null; then
    die "Node.js $(node -v) слишком старый. Требуется >= 22."
fi
echo "  Node.js: $(node -v)"

if ! command -v pnpm &>/dev/null; then
    die "pnpm не установлен. Установите: npm i -g pnpm"
fi
echo "  pnpm:    $(pnpm -v)"

if $BUILD_DOCKER && ! command -v docker &>/dev/null; then
    die "Docker не установлен. Требуется для --docker."
fi

if [ ! -f "$SYNTH/pnpm-workspace.yaml" ]; then
    die "Не найден $SYNTH/pnpm-workspace.yaml. Запустите скрипт из корня проекта."
fi

echo ""

# Очистка (опционально)
if $CLEAN; then
    echo "[2/9] Очистка предыдущей сборки..."
    cd "$SYNTH" || die "Не удалось перейти в $SYNTH"
    pnpm clean 2>/dev/null || true
    echo "  готово"
    echo ""
else
    echo "[2/9] Установка зависимостей..."
    cd "$SYNTH" || die "Не удалось перейти в $SYNTH"
    pnpm install --frozen-lockfile 2>&1 | tail -1
    echo "  готово"
    echo ""
fi

# Сборка @itphx/synth-shared
echo "[3/9] Сборка @itphx/synth-shared..."
pnpm --filter @itphx/synth-shared build || die "Сборка @itphx/synth-shared не удалась"
echo "  готово"
echo ""

# Сборка @itphx/synth-core
echo "[4/9] Сборка @itphx/synth-core..."
pnpm --filter @itphx/synth-core build || die "Сборка @itphx/synth-core не удалась"
echo "  готово"
echo ""

# Сборка @itphx/synth-executor (исполнитель агентских команд; зависит от типов core)
echo "[5/9] Сборка @itphx/synth-executor..."
pnpm --filter @itphx/synth-executor build || die "Сборка @itphx/synth-executor не удалась"
echo "  готово"
echo ""

# Сборка @itphx/synth-storage-postgres (опциональный БД-драйвер; зависит от типов core)
echo "[6/9] Сборка @itphx/synth-storage-postgres..."
pnpm --filter @itphx/synth-storage-postgres build || die "Сборка @itphx/synth-storage-postgres не удалась"
echo "  готово"
echo ""

# Сборка @itphx/synth-ui
echo "[7/9] Сборка @itphx/synth-ui..."
pnpm --filter @itphx/synth-ui build || die "Сборка @itphx/synth-ui не удалась"
echo "  готово"
echo ""

# Сборка @itphx/synth-sdk
echo "[8/9] Сборка @itphx/synth-sdk..."
pnpm --filter @itphx/synth-sdk build || die "Сборка @itphx/synth-sdk не удалась"
echo "  готово"
echo ""

# Сборка @itphx/synth
echo "[9/9] Сборка @itphx/synth..."
pnpm --filter @itphx/synth build || die "Сборка @itphx/synth не удалась"

SYNTH_DIST="$SYNTH/packages/synth/dist/cli.js"
if [ ! -f "$SYNTH_DIST" ]; then
    die "Файл бандла не создан: $SYNTH_DIST"
fi

BUNDLE_SIZE=$(du -h "$SYNTH_DIST" | cut -f1)
PKG_VERSION=$(node -e "console.log(require('$SYNTH/packages/synth/package.json').version)")
echo ""
echo "  Версия:  $PKG_VERSION"
echo "  Бандл:   $SYNTH_DIST ($BUNDLE_SIZE)"
echo "  UI:      $SYNTH/packages/synth/ui/"
echo "  Промпты: $SYNTH/packages/synth/prompts/"
echo ""

# Docker-образ (опционально)
if $BUILD_DOCKER; then
    echo "━━━ Docker ━━━"
    echo ""

    DOCKER_IMAGE="$DOCKER_REGISTRY/itphx/synth:$DOCKER_TAG"
    echo "  Образ: $DOCKER_IMAGE"

    docker build -t "$DOCKER_IMAGE" -f "$SYNTH/docker/Dockerfile" "$SYNTH" || die "Сборка Docker-образа не удалась"

    echo "  готово"
    echo ""

    # Проверяем, есть ли доступ к реестру
    if [ -n "${GV_TOKEN:-}" ]; then
        echo "  Вход в $DOCKER_REGISTRY..."
        echo "$GV_TOKEN" | docker login "$DOCKER_REGISTRY" --username itphx --password-stdin 2>/dev/null || \
            echo "  (вход не выполнен — публикация отдельно через publish.sh)"
    fi
fi

# Проверка типов и тесты (опционально)
if $DO_CHECK; then
    echo "━━━ Проверки ━━━"
    echo ""

    echo "TypeScript (typecheck)..."
    cd "$SYNTH" || die "Не удалось перейти в $SYNTH"
    pnpm typecheck || die "Typecheck не прошёл"
    echo "  готово"
    echo ""

    echo "Тесты..."
    pnpm test || die "Тесты не прошли"
    echo "  готово"
    echo ""
fi

echo "━━━ Сборка завершена ━━━"
echo ""
echo "Для публикации:   ./publish.sh"
echo "Для теста локально: cd $SYNTH/packages/synth && npm link"

if $BUILD_DOCKER; then
    echo ""
    echo "Docker-образ: $DOCKER_REGISTRY/itphx/synth:$DOCKER_TAG"
    echo "  Запуск: docker run -p 4300:4300 $DOCKER_REGISTRY/itphx/synth:$DOCKER_TAG"
    if [ -n "${GV_TOKEN:-}" ]; then
        echo "  Публикация: docker push $DOCKER_REGISTRY/itphx/synth:$DOCKER_TAG"
    fi
fi
