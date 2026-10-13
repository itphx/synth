#!/usr/bin/env bash
#
# publish.sh — публикация всех 7 npm-пакетов Synth в реестры
#
# 1. Выполняет сборку (build.sh) если не собрано
# 2. Проверяет авторизацию в npm
# 3. Публикует пакеты в строгом порядке зависимостей:
#    shared → core → ui → backend → runner → sdk → synth
#
# Использование:
#   ./publish.sh                          — сборка + публикация (оба реестра)
#   ./publish.sh --dry-run                — проверка без реальной публикации
#   ./publish.sh --no-build               — публикация без пересборки
#   ./publish.sh --registry=npmjs         — только npmjs.org
#   ./publish.sh --registry=gitverse      — только GitVerse Package Registry
#   ./publish.sh --registry=both          — оба реестра (по умолчанию)
#   ./publish.sh --docker                 — также опубликовать Docker-образ
#   ./publish.sh --docker-tag <tag>       — тег Docker-образа
#
# Переменные окружения:
#   NPM_TOKEN                       — токен для npmjs.org
#   NPM_REGISTRY                    — URL npm-реестра (по умолчанию: https://registry.npmjs.org)
#   GV_TOKEN                        — токен для GitVerse (npm registry, docker, API)

set -o pipefail

die() { echo "ОШИБКА: $*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTH="$ROOT"

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
GITVERSE_NPM_REGISTRY="${GITVERSE_NPM_REGISTRY:-https://gitverse.ru/api/packages/itphx/npm/}"
GITVERSE_DOCKER_REGISTRY="${GITVERSE_DOCKER_REGISTRY:-gitverse.ru}"

DRY_RUN=false
NO_BUILD=false
REGISTRY="both"
PUBLISH_DOCKER=false
DOCKER_TAG=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --no-build) NO_BUILD=true ;;
        --registry=*)
            REGISTRY="${arg#*=}"
            ;;
        --docker) PUBLISH_DOCKER=true ;;
        --docker-tag=*)
            PUBLISH_DOCKER=true
            DOCKER_TAG="${arg#*=}"
            ;;
    esac
done

# Порядок публикации строго по иерархии зависимостей:
# shared ← core ← backend/runner, ui ← shared, sdk ← shared, synth ← core+ui+shared
PACKAGES=(shared core ui backend runner sdk synth)

# Имя npm-пакета по каталогу
pkg_name() {
    node -e "console.log(require('$SYNTH/packages/$1/package.json').name)"
}

PKG_VERSION=$(node -e "console.log(require('$SYNTH/packages/synth/package.json').version)")

echo "━━━ Synth: публикация ━━━"
echo ""
echo "  Версия: $PKG_VERSION"
echo "  Реестр: $REGISTRY"
echo "  Пакеты (порядок публикации):"
for p in "${PACKAGES[@]}"; do
    echo "    $(pkg_name "$p")"
done
echo ""

# Шаг 1: Сборка
if $NO_BUILD; then
    echo "[1/4] Пропуск сборки (--no-build)"
else
    echo "[1/4] Сборка..."
    bash "$ROOT/scripts/build.sh" || die "Сборка не удалась"
fi
echo ""

# Шаг 2: Проверка авторизации (однократно на реестр)
echo "[2/4] Проверка авторизации..."

check_auth() {
    local registry_url="$1"
    local token="${2:-}"
    local label="$3"

    if [ -n "$token" ]; then
        npm config set "//${registry_url#https://}/:_authToken" "$token"
    fi

    if ! npm whoami --registry "$registry_url" &>/dev/null; then
        # GitVerse npm-реестр не поддерживает endpoint /-/whoami (404).
        # Это не признак отсутствия авторизации — токен проверяется реальной публикацией.
        if [ "$label" = "GitVerse Package Registry" ]; then
            echo "  ВНИМАНИЕ: $label не поддерживает whoami — авторизация проверится при публикации"
            return 0
        fi
        echo "  ПРЕДУПРЕЖДЕНИЕ: не удалось авторизоваться в $label"
        if $DRY_RUN; then
            echo "  Продолжаем --dry-run..."
            return 0
        fi
        echo "  Пропускаем $label (нет авторизации)"
        return 1
    fi

    echo "  Авторизован как: $(npm whoami --registry "$registry_url") ($label)"
    return 0
}

NPMJS_OK=false
GITVERSE_OK=false

case "$REGISTRY" in
    npmjs) NPMJS_OK=true ;;
    gitverse) GITVERSE_OK=true ;;
    both) NPMJS_OK=true; GITVERSE_OK=true ;;
    *) die "Неизвестный реестр: $REGISTRY (допустимо: npmjs, gitverse, both)" ;;
esac

if $NPMJS_OK; then
    if check_auth "$NPM_REGISTRY" "${NPM_TOKEN:-}" "npmjs.org"; then
        NPMJS_OK=true
    else
        NPMJS_OK=false
    fi
fi

if $GITVERSE_OK; then
    if check_auth "$GITVERSE_NPM_REGISTRY" "${GV_TOKEN:-}" "GitVerse Package Registry"; then
        GITVERSE_OK=true
    else
        GITVERSE_OK=false
    fi
fi

echo ""

# Шаг 3: Публикация пакетов
publish_to_npmjs() {
    local dir="packages/$1"
    local name
    name=$(pkg_name "$1")

    if $DRY_RUN; then
        echo "  --dry-run: $name"
        (cd "$SYNTH/$dir" && pnpm publish --dry-run --access public --registry "$NPM_REGISTRY" --no-git-checks) \
            || die "dry-run $name не удался"
    else
        echo "  Публикация $name..."
        (cd "$SYNTH/$dir" && pnpm publish --access public --registry "$NPM_REGISTRY" --no-git-checks) \
            || die "Публикация $name в npmjs.org не удалась"
        echo "  Опубликовано: $name@$PKG_VERSION → npmjs.org"
    fi
}

publish_to_gitverse() {
    local dir="packages/$1"
    local name
    name=$(pkg_name "$1")

    if $DRY_RUN; then
        echo "  --dry-run: $name"
        (cd "$SYNTH/$dir" && pnpm publish --dry-run --access public --registry "$GITVERSE_NPM_REGISTRY" --no-git-checks) \
            || die "dry-run $name не удался"
    else
        echo "  Публикация $name..."
        (cd "$SYNTH/$dir" && pnpm publish --access public --registry "$GITVERSE_NPM_REGISTRY" --no-git-checks) \
            || die "Публикация $name в GitVerse не удалась"
        echo "  Опубликовано: $name@$PKG_VERSION → GitVerse"
    fi
}

echo "[3/4] Публикация пакетов..."

# Лицензии для пакетов: LICENSE/LICENSE.ru.md хранятся в корне репозитория
# (единственный источник). npm/pnpm не упаковывают файлы-симлинки, поэтому на
# время публикации материализуем копии в каждом пакете. Пути — в .gitignore.
LICENSE_FILES=(LICENSE LICENSE.ru.md)

materialize_licenses() {
    local p f
    for p in "${PACKAGES[@]}"; do
        for f in "${LICENSE_FILES[@]}"; do
            cp "$SYNTH/$f" "$SYNTH/packages/$p/$f"
        done
    done
}

cleanup_licenses() {
    local p f
    for p in "${PACKAGES[@]}"; do
        for f in "${LICENSE_FILES[@]}"; do
            rm -f "$SYNTH/packages/$p/$f"
        done
    done
}

trap cleanup_licenses EXIT INT TERM
materialize_licenses

for pkg in "${PACKAGES[@]}"; do
    if $NPMJS_OK; then
        publish_to_npmjs "$pkg"
    fi
    if $GITVERSE_OK; then
        publish_to_gitverse "$pkg"
    fi
done

echo ""

# Шаг 4: Docker
publish_docker() {
    echo "[4/4] Docker ($GITVERSE_DOCKER_REGISTRY)..."

    TAG="${DOCKER_TAG:-$PKG_VERSION}"

    # Набор образов: (имя-образа, Dockerfile). Три сервиса: synth (standalone core),
    # synth-backend (API Hub), synth-ui (SPA).
    IMAGES=(
        "$GITVERSE_DOCKER_REGISTRY/itphx/synth:$TAG|$SYNTH/docker/Dockerfile"
        "$GITVERSE_DOCKER_REGISTRY/itphx/synth-backend:$TAG|$SYNTH/docker/Dockerfile.backend"
        "$GITVERSE_DOCKER_REGISTRY/itphx/synth-ui:$TAG|$SYNTH/docker/Dockerfile.ui"
    )

    if $DRY_RUN; then
        for img in "${IMAGES[@]}"; do
            name="${img%%|*}"; df="${img#*|}"
            [ -f "$df" ] || die "Dockerfile не найден: $df"
            echo "  --dry-run: $name (из $df) собран, публикация пропущена"
        done
        return 0
    fi

    if [ -n "${GV_TOKEN:-}" ]; then
        echo "  Вход в $GITVERSE_DOCKER_REGISTRY..."
        echo "$GV_TOKEN" | docker login "$GITVERSE_DOCKER_REGISTRY" --username itphx --password-stdin || \
            die "Не удалось войти в Docker-реестр"
    else
        echo "  ПРЕДУПРЕЖДЕНИЕ: GV_TOKEN не задан — пропускаем публикацию Docker"
        return 1
    fi

    for img in "${IMAGES[@]}"; do
        name="${img%%|*}"; df="${img#*|}"
        [ -f "$df" ] || die "Dockerfile не найден: $df"
        echo "  Сборка $name (из $df)..."
        docker build -t "$name" -f "$df" "$SYNTH" || die "Сборка Docker-образа не удалась: $name"
        echo "  Публикация $name..."
        docker push "$name" || die "Публикация Docker-образа не удалась: $name"
        if [ "$TAG" != "latest" ]; then
            latest="${name%:*}:latest"
            echo "  Публикация latest ($latest)..."
            docker tag "$name" "$latest"
            docker push "$latest" || true
        fi
        echo "  Опубликовано: $name"
    done

    echo ""
    return 0
}

if $PUBLISH_DOCKER; then
    publish_docker || true
fi

echo "━━━ Готово ━━━"
echo ""

if $DRY_RUN; then
    echo "Это был --dry-run. Реальная публикация:"
    echo "  ./publish.sh"
else
    echo "Установка:"
    echo "  npm i -g @itphx/synth@$PKG_VERSION"
    echo ""
    echo "Docker:"
    echo "  docker pull $GITVERSE_DOCKER_REGISTRY/itphx/synth:$PKG_VERSION"
    echo "  docker pull $GITVERSE_DOCKER_REGISTRY/itphx/synth-backend:$PKG_VERSION"
    echo "  docker pull $GITVERSE_DOCKER_REGISTRY/itphx/synth-ui:$PKG_VERSION"
    echo "  docker run -p 4300:4300 $GITVERSE_DOCKER_REGISTRY/itphx/synth:$PKG_VERSION"
fi
