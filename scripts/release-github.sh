#!/usr/bin/env bash
#
# release-github.sh — локальный backfill GitHub-зеркала (без сборки образов).
#
# GitHub — только ЗЕРКАЛО и релизы: контейнеры собираются исключительно в CI
# GitVerse (kaniko → gitverse.ru + ghcr.io), а сюда попадают уже собранные
# образы. Поэтому этот скрипт Docker-образы не собирает и не публикует: он
# синхронизирует refs и создаёт/обновляет GitHub Release с ассетами. Нужен для
# «догона» исторических тегов и повторного релиза, когда CI GitVerse недоступен.
#
# Что делает:
#   1. --push-refs — зеркалит `master:main` и все теги в git-remote GitHub;
#   2. --release   — создаёт/идемпотентно обновляет GitHub Release для тега
#                    v<version>: тело из scripts/changelog.sh + блок «Установка»,
#                    ассеты (Helm-чарт, CLI-бандл, SHA256SUMS) — best-effort.
#
# npm отсюда НЕ публикуется: единственный источник npm для Synth — CI GitVerse
# (.gitverse/workflows/release.yaml). Токен читается из окружения (GH_TOKEN)
# или `gh auth token`; в файле секретов нет.
#
# Использование:
#   scripts/release-github.sh --version 0.10.0 --dry-run
#   scripts/release-github.sh --version 0.10.0 --push-refs --yes
#   scripts/release-github.sh --version 0.10.0 --release --yes
#   scripts/release-github.sh --version 0.10.0 --push-refs --release --yes
#   scripts/release-github.sh --help
#
# Опции:
#   --version <X.Y.Z>   версия релиза (обязательна); локальный тег v<version> обязателен
#   --push-refs         зеркалить master:main и все теги в git-remote GitHub
#   --release           создать/обновить GitHub Release + ассеты (best-effort)
#   --remote <name>     имя git-remote GitHub (по умолчанию: github)
#   --yes, -y           подтверждение изменяющих операций (без него — отказ)
#   --dry-run           печатать команды, ничего не выполнять
#   -h, --help          показать справку
#
# Требования: git, node; helm — для ассета чарта; gh — опционально (токен).
# Секреты не пишутся в файл: используется GH_TOKEN из окружения или `gh auth token`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "ОШИБКА: $*" >&2; exit 1; }
warn() { echo "ПРЕДУПРЕЖДЕНИЕ: $*" >&2; }
info() { echo "  $*"; }

usage() {
    cat <<'EOF'
release-github.sh — локальный backfill GitHub-зеркала (без сборки образов)

Использование:
  scripts/release-github.sh --version <X.Y.Z> [--push-refs] [--release] [опции]

Опции:
  --version <X.Y.Z>   версия релиза (обязательна); локальный тег v<version> обязателен
  --push-refs         зеркалить master:main и все теги в git-remote GitHub
  --release           создать/обновить GitHub Release + ассеты (best-effort)
  --remote <name>     имя git-remote GitHub (по умолчанию: github)
  --yes, -y           подтверждение изменяющих операций (без него скрипт отказывается)
  --dry-run           напечатать команды, ничего не выполнять
  -h, --help          эта справка

Что делает:
  * --push-refs — git push <remote> master:main и git push <remote> --tags;
  * --release   — GitHub Release для тега v<version>: тело из scripts/changelog.sh
                  + блок «Установка», ассеты Helm-чарт/cli.js/SHA256SUMS (best-effort).

Что НЕ делает:
  * не собирает и не публикует Docker-образы (их собирает CI GitVerse → gitverse.ru + ghcr.io);
  * не публикует npm-пакеты (только CI GitVerse).

Примеры:
  scripts/release-github.sh --version 0.10.0 --dry-run
  scripts/release-github.sh --version 0.10.0 --push-refs --release --yes
EOF
}

VERSION=""
DO_PUSH_REFS=false
DO_RELEASE=false
DRY_RUN=false
ASSUME_YES=false
REMOTE="github"

while [ $# -gt 0 ]; do
    case "$1" in
        --version)   VERSION="${2:-}"; shift 2 ;;
        --version=*) VERSION="${1#*=}"; shift ;;
        --push-refs) DO_PUSH_REFS=true; shift ;;
        --release)   DO_RELEASE=true; shift ;;
        --remote)    REMOTE="${2:-}"; shift 2 ;;
        --remote=*)  REMOTE="${1#*=}"; shift ;;
        --yes|-y)    ASSUME_YES=true; shift ;;
        --dry-run)   DRY_RUN=true; shift ;;
        -h|--help)   usage; exit 0 ;;
        *)           die "Неизвестная опция: $1 (см. --help)" ;;
    esac
done

[ -n "$VERSION" ] || die "--version обязателен. См. --help."
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
    || die "Некорректная версия '$VERSION' (ожидается X.Y.Z или X.Y.Z-suffix)"

# Без флагов-действий: --dry-run показывает полный план (push-refs + release),
# реальный запуск требует явно указать хотя бы одно действие (безопасность).
PLAN_ALL=false
if ! $DO_PUSH_REFS && ! $DO_RELEASE; then
    if $DRY_RUN; then
        PLAN_ALL=true
        DO_PUSH_REFS=true
        DO_RELEASE=true
    else
        die "укажите хотя бы одно действие: --push-refs и/или --release (см. --help)"
    fi
fi

TAG="v$VERSION"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
    || die "Локальный тег $TAG не найден. Сначала получите теги: git fetch --tags"

# Предрелиз (суффикс после дефиса) => --prerelease.
PRERELEASE=false
case "$VERSION" in
    *-*) PRERELEASE=true ;;
esac

# GitHub-репозиторий определяем из URL git-remote — владельца не хардкодим.
REMOTE_URL="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
[ -n "$REMOTE_URL" ] || die "git-remote '$REMOTE' не найден. Укажите его через --remote."
case "$REMOTE_URL" in
    git@github.com:*)        REPO="${REMOTE_URL#git@github.com:}" ;;
    ssh://git@github.com/*)  REPO="${REMOTE_URL#ssh://git@github.com/}" ;;
    https://github.com/*)    REPO="${REMOTE_URL#https://github.com/}" ;;
    *) die "Не удалось определить GitHub-репозиторий из '$REMOTE_URL' (ожидается github.com)" ;;
esac
REPO="${REPO%.git}"

# Токен: GH_TOKEN из окружения либо `gh auth token` (в файле не хранится).
GH_TOKEN_RESOLVED="${GH_TOKEN:-}"
if [ -z "$GH_TOKEN_RESOLVED" ] && command -v gh >/dev/null 2>&1; then
    GH_TOKEN_RESOLVED="$(gh auth token 2>/dev/null || true)"
fi
if $DO_RELEASE && ! $DRY_RUN && [ -z "$GH_TOKEN_RESOLVED" ]; then
    die "не найден токен GitHub: задайте GH_TOKEN или выполните 'gh auth login'"
fi

WORKTREE="$ROOT/tmp/release-github-$TAG"
ASSETS="$ROOT/tmp/release-github-$TAG-assets"

# Изменяющие операции выполняются только с явным подтверждением.
if ! $DRY_RUN && ! $ASSUME_YES; then
    {
        echo "Скрипт выполняет изменяющие операции в GitHub-зеркале $REPO:"
        if $DO_PUSH_REFS; then echo "  * git push $REMOTE master:main и все теги"; fi
        if $DO_RELEASE; then echo "  * GitHub Release $TAG (+ ассеты)"; fi
        echo "Подтвердите запуск флагом --yes (или посмотрите план через --dry-run)."
    } >&2
    exit 1
fi

echo "━━━ release-github: $TAG ━━━"
echo ""
info "Репозиторий:  $REPO (remote: $REMOTE)"
info "Версия:       $VERSION (prerelease=$PRERELEASE)"
if $DO_PUSH_REFS; then info "Push refs:    да (master:main + теги)"; else info "Push refs:    нет"; fi
if $DO_RELEASE; then info "Release:      да (+ ассеты)"; else info "Release:      нет"; fi
if [ -n "$GH_TOKEN_RESOLVED" ]; then info "Токен:        найден"; else info "Токен:        нет (для --release обязателен)"; fi
if $DRY_RUN; then info "Режим:        dry-run (ничего не выполняется)"; else info "Режим:        реальная публикация"; fi
if $PLAN_ALL; then info "План:         флаги не заданы — для плана показаны оба действия"; fi
echo ""

run() {
    if $DRY_RUN; then
        printf '  [dry-run]'
        printf ' %q' "$@"
        printf '\n'
    else
        "$@"
    fi
}

run_sh() {
    if $DRY_RUN; then
        printf '  [dry-run] %s\n' "$1"
    else
        bash -c "$1"
    fi
}

# Проверка наличия инструментов — только для реального запуска.
if ! $DRY_RUN; then
    command -v git >/dev/null || die "git не найден"
    command -v node >/dev/null || die "node не найден"
    if $DO_RELEASE; then
        command -v helm >/dev/null || warn "helm не найден — Helm-чарт не будет приложен к релизу"
    fi
fi

# --- Предполётная проверка: есть ли тег в GitHub-зеркале ---------------------
if ! $DRY_RUN && $DO_RELEASE && ! $DO_PUSH_REFS; then
    if REMOTE_TAGS="$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG" 2>/dev/null)"; then
        if [ -z "$REMOTE_TAGS" ]; then
            warn "тега $TAG нет в remote '$REMOTE' — GitHub создаст тег из target_commitish."
            warn "надёжнее сначала зеркалить refs: --push-refs"
        fi
    else
        warn "не удалось опросить remote '$REMOTE' (git ls-remote) — продолжаем"
    fi
fi

# --- [1/3] Push refs ---------------------------------------------------------
# Токен подставляется через GIT_CONFIG_* (не в URL), чтобы не светиться в логе git.
push_one() {
    # $1 — refspec либо --tags
    if $DRY_RUN; then
        printf '  [dry-run] git push %s %s\n' "$REMOTE" "$1"
        if [ -n "$GH_TOKEN_RESOLVED" ]; then printf '  [dry-run]   (+ Authorization: basic <token>)\n'; fi
        return 0
    fi
    if [ -n "$GH_TOKEN_RESOLVED" ]; then
        env GIT_CONFIG_COUNT=1 \
            GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' \
            GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN_RESOLVED" | base64 | tr -d '\n')" \
            git push "$REMOTE" "$1"
    else
        git push "$REMOTE" "$1"
    fi
}

echo "[1/3] Push refs ($REMOTE)..."
if $DO_PUSH_REFS; then
    push_one "master:main"
    push_one "--tags"
else
    info "пропуск (нет --push-refs)"
fi
echo ""

# --- [2/3] Тело релиза и ассеты ---------------------------------------------
# Рабочее дерево тега: тело, Chart.yaml и прочее читаем из дерева тега, чтобы
# backfill исторического релиза не зависел от текущей выгрузки.
if ! $DRY_RUN; then
    if [ -e "$WORKTREE" ]; then rm -rf "$WORKTREE"; fi
    git worktree prune
    rm -rf "$ASSETS"
    mkdir -p "$ASSETS"
fi
cleanup() {
    if ! $DRY_RUN; then
        git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
        rm -rf "$ASSETS"
    fi
}
trap cleanup EXIT INT TERM

echo "[2/3] Тело релиза и ассеты..."
if $DO_RELEASE; then
    run git worktree add --detach "$WORKTREE" "refs/tags/$TAG"

    if git cat-file -e "refs/tags/$TAG:docs/releases/$VERSION.md" 2>/dev/null; then
        CHANGELOG_MODE="docs/releases/$VERSION.md"
    else
        CHANGELOG_MODE="авто из коммитов"
    fi
    CHART_VERSION="$(git show "refs/tags/$TAG:charts/synth/Chart.yaml" | awk '/^version:/{print $2; exit}')"
    info "Тело релиза:  $CHANGELOG_MODE"
    info "Версия чарта: ${CHART_VERSION:-не определена}"

    run_sh "(cd '$WORKTREE' && bash scripts/changelog.sh)"
    run_sh "cp '$WORKTREE/changelog-partial.md' '$ASSETS/release-body.md'"
    if ! $DRY_RUN; then
        {
            printf '\n## Установка\n\n'
            printf 'CLI (npm — из npmjs.org или GitVerse Package Registry):\n\n'
            printf '```bash\n'
            printf 'npm install -g @itphx/synth@%s\n' "$VERSION"
            printf '```\n\n'
            printf 'Docker-образ (базовый) из GitHub Container Registry:\n\n'
            printf '```bash\n'
            printf 'docker pull ghcr.io/itphx/synth:%s\n' "$VERSION"
            printf 'docker run -p 4300:4300 ghcr.io/itphx/synth:%s\n' "$VERSION"
            printf '```\n\n'
            printf 'Основной реестр образов — `gitverse.ru/itphx/synth:%s`;\n' "$VERSION"
            printf 'образы `synth-backend`/`synth-ui` публикуются только в gitverse.ru.\n'
        } >> "$ASSETS/release-body.md"
    fi

    # Helm-чарт (версия из Chart.yaml) — best-effort.
    if command -v helm >/dev/null 2>&1; then
        run helm package "$WORKTREE/charts/synth" --destination "$ASSETS"
    elif $DRY_RUN; then
        printf '  [dry-run] helm package %q --destination %q\n' "$WORKTREE/charts/synth" "$ASSETS"
    else
        warn "helm не найден — Helm-чарт не будет приложен"
    fi

    # cli.js — только из бандла, собранного на этом же теге (сборку не выдумываем).
    BUNDLE="$ROOT/packages/synth/dist/cli.js"
    TREE_VERSION="$(node -e "console.log(require('$ROOT/packages/synth/package.json').version)")"
    if [ -f "$BUNDLE" ] && [ "$TREE_VERSION" = "$VERSION" ]; then
        run cp "$BUNDLE" "$ASSETS/cli.js"
    else
        warn "cli.js не приложен: нет бандла версии $VERSION (текущее дерево — $TREE_VERSION)."
        warn "собрать на теге: git checkout $TAG && pnpm install --frozen-lockfile && pnpm run build:release"
    fi

    # SHA256SUMS по всем подготовленным ассетам (best-effort).
    if ! $DRY_RUN; then
        (
            cd "$ASSETS"
            shopt -s nullglob
            files=( ./* )
            # release-body.md в контрольные суммы не включаем (это тело, не артефакт).
            sums=""
            for f in "${files[@]}"; do
                if [ "$f" = "./release-body.md" ]; then continue; fi
                sums="$sums $f"
            done
            if [ -n "$sums" ]; then
                sha256sum $sums > SHA256SUMS
                cat SHA256SUMS
            else
                warn "ассетов нет — SHA256SUMS не создаётся"
            fi
        )
    fi
else
    info "пропуск (нет --release)"
fi
echo ""

# --- [3/3] GitHub Release ----------------------------------------------------
echo "[3/3] GitHub Release..."
if $DO_RELEASE; then
    if $DRY_RUN; then
        printf '  [dry-run] GH_REPO=%q RELEASE_TAG=%q RELEASE_BODY_FILE=%q RELEASE_ASSETS=%q RELEASE_PRERELEASE=%q \\\n' \
            "$REPO" "$TAG" "$ASSETS/release-body.md" "$ASSETS/*" "$PRERELEASE"
        printf '  [dry-run]   node scripts/publish-release.mjs --platform github --dry-run\n'
    else
        [ -n "$(ls -A "$ASSETS" 2>/dev/null)" ] || die "каталог ассетов пуст — релиз не создаём"
        # release-body.md — тело, не ассет; передаём только файлы-артефакты.
        ASSET_FILES=""
        for f in "$ASSETS"/*; do
            if [ "$(basename "$f")" = "release-body.md" ]; then continue; fi
            ASSET_FILES="$ASSET_FILES $f"
        done
        export GH_TOKEN="$GH_TOKEN_RESOLVED"
        GH_REPO="$REPO" \
        RELEASE_TAG="$TAG" \
        RELEASE_BODY_FILE="$ASSETS/release-body.md" \
        RELEASE_ASSETS="$ASSET_FILES" \
        RELEASE_PRERELEASE="$PRERELEASE" \
            node scripts/publish-release.mjs --platform github
    fi
else
    info "пропуск (нет --release)"
fi
echo ""

echo "━━━ Готово ━━━"
echo ""
if $DRY_RUN; then
    HINT="scripts/release-github.sh --version $VERSION"
    if $DO_PUSH_REFS; then HINT="$HINT --push-refs"; fi
    if $DO_RELEASE; then HINT="$HINT --release"; fi
    echo "Это был --dry-run. Реальная публикация:"
    echo "  $HINT --yes"
else
    echo "Зеркало:  https://github.com/$REPO"
    if $DO_RELEASE; then echo "Релиз:    https://github.com/$REPO/releases/tag/$TAG"; fi
    echo "Образ:    ghcr.io/itphx/synth:$VERSION (собирает CI GitVerse)"
fi
