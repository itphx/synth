#!/usr/bin/env bash
#
# publish-images.sh — сборка и публикация flavor-образов Synth в реестр Gitea
# (`git.itphx.ru/itphx/…`) — PROP-082, шаг 6.
#
# Что публикуется (все flavor'ы, версионными тегами, БЕЗ `latest`):
#
#   synth-backend:<v>-<flavor>     all-in-one: control plane + toolchain
#   synth-backend:<v>              slim: control plane без toolchain'а
#   synth-executor:<v>-<flavor>    образы исполнителей (worker'ы)
#
#   flavor'ы: core | dev | devops | browser | full
#
# Теги версионные и **неизменяемые по смыслу**: pull в K3s идёт по конкретной
# версии (`<v>-<flavor>`), поэтому `latest` не публикуется — иначе развёртывание
# перестаёт быть воспроизводимым. Ограничение GitVerse/GHCR (~500 МБ на
# репозиторий) в Gitea-реестре не действует, но политика тегов — общая.
#
# Реестр и креды:
#
#   * реестр  — `git.itphx.ru` (по умолчанию), namespace `itphx`;
#   * токен   — `GV_GITEA_TOKEN` (секрет GitVerse CI) или `GITEA_TOKEN` (локально
#               и в `synth-deploy`); логин — `itphx` (или `GITEA_USER`);
#   * если токен не задан, а пуш требуется — **fail-closed** с понятным
#     сообщением (как для `GH_TOKEN` в `release.yaml`), а не молчаливый пропуск.
#
# Пуш — **последовательный**, с ретраями: DNS `git.itphx.ru` на nameserver
# `10.0.0.245` сбрасывает ПАРАЛЛЕЛЬНЫЕ запросы (`lookup … Temporary failure in
# name resolution`), а последовательные ходит стабильно (см. журнал задач).
# Поэтому: никакого параллельного пуша, между попытками — пауза с backoff.
#
# Примеры:
#   # всё (backend + executor, все flavor'ы) в реестр Gitea
#   ./scripts/publish-images.sh --tag-base 0.11.4
#
#   # только образ исполнителя, flavor core
#   ./scripts/publish-images.sh --tag-base 0.11.4 --only executor --flavor core
#
#   # локальная сборка без публикации (проверка Dockerfile'ов)
#   ./scripts/publish-images.sh --tag-base 0.11.4 --skip-push
#
#   # план действий (ничего не выполняется)
#   ./scripts/publish-images.sh --tag-base 0.11.4 --dry-run
#
# Требования: bash 4+, docker (с BuildKit), curl не нужен.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

REGISTRY="${SYNTH_IMAGE_REGISTRY:-git.itphx.ru}"
NAMESPACE="${SYNTH_IMAGE_NAMESPACE:-itphx}"
FLAVORS="core dev devops browser full"
IMAGES="backend executor"
TAG_BASE=""
ONLY=""
DRY_RUN=0
SKIP_PUSH=0
INCLUDE_SLIM=1
PUSH_RETRIES="${SYNTH_IMAGE_PUSH_RETRIES:-3}"
PUSH_RETRY_DELAY="${SYNTH_IMAGE_PUSH_RETRY_DELAY:-15}"

log()  { printf '[publish-images] %s\n' "$*"; }
loge() { printf '[publish-images] %s\n' "$*" >&2; }
warn() { printf '[publish-images] ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
die()  { printf '[publish-images] ОШИБКА: %s\n' "$*" >&2; exit 1; }

usage() {
  # Шапка скрипта — до строки «Требования:» (после неё идёт реализация).
  sed -n '2,/^# Требования/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Флаги:
  --tag-base <version>   Версия в тегах (по умолчанию — version из packages/synth/package.json).
  --registry <host>      Реестр (по умолчанию: git.itphx.ru).
  --namespace <ns>       Namespace в реестре (по умолчанию: itphx).
  --flavor <list|all>    Flavor'ы через запятую (по умолчанию: all).
  --only <backend|executor|both>  Только один образ (по умолчанию: оба).
  --skip-push            Только собрать локально (без публикации).
  --no-slim              Не собирать slim-базу synth-backend.
  --push-retries <n>     Попыток пуша (по умолчанию: 3).
  --push-retry-delay <s> Пауза между попытками, с (по умолчанию: 15).
  --dry-run              Показать команды, ничего не выполнять.
  -h, --help             Эта справка.

Переменные окружения:
  GV_GITEA_TOKEN / GITEA_TOKEN — токен Gitea (container registry).
  GITEA_USER                   — логин Gitea (по умолчанию: itphx).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag-base)           TAG_BASE="${2:-}"; shift 2 ;;
    --registry)           REGISTRY="${2:-}"; shift 2 ;;
    --namespace)          NAMESPACE="${2:-}"; shift 2 ;;
    --flavor)             FLAVORS="${2:-}"; shift 2 ;;
    --only)               ONLY="${2:-}"; shift 2 ;;
    --skip-push)          SKIP_PUSH=1; shift ;;
    --no-slim)            INCLUDE_SLIM=0; shift ;;
    --push-retries)       PUSH_RETRIES="${2:-}"; shift 2 ;;
    --push-retry-delay)   PUSH_RETRY_DELAY="${2:-}"; shift 2 ;;
    --dry-run)            DRY_RUN=1; shift ;;
    -h|--help)            usage; exit 0 ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

# --- версия ------------------------------------------------------------------

if [[ -z "$TAG_BASE" ]]; then
  PKG_VERSION=$(node -p "require('$REPO_ROOT/packages/synth/package.json').version" 2>/dev/null || echo "")
  [[ -n "$PKG_VERSION" ]] || die "не задана версия: укажите --tag-base <version>"
  TAG_BASE="$PKG_VERSION"
fi

[[ "$FLAVORS" == "all" ]] && FLAVORS="core dev devops browser full"
case "$ONLY" in
  ""|both) IMAGES="backend executor" ;;
  backend|executor) IMAGES="$ONLY" ;;
  *) die "--only: ожидается backend | executor | both (получено: $ONLY)" ;;
esac

# --- утилиты -----------------------------------------------------------------

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  + %s\n' "$*"
    return 0
  fi
  "$@"
}

# Список стадий Dockerfile'а (имена после `AS`), в нижнем регистре.
dockerfile_stages() {
  awk '
    /^[[:space:]]*FROM[[:space:]]/ {
      for (i = 1; i <= NF; i++) {
        if (toupper($i) == "AS") { print tolower($(i + 1)); break }
      }
    }
  ' "$1"
}

# Стадия для flavor'а: точное имя `<flavor>` → иначе `<...>-<flavor>`.
# Ничего подходящего → пустая строка (вызывающий решает, что делать).
resolve_stage() {
  local dockerfile="$1" flavor="$2" stages stage
  stages=$(dockerfile_stages "$dockerfile")
  if grep -qx -- "$flavor" <<< "$stages"; then
    printf '%s\n' "$flavor"
    return 0
  fi
  stage=$(grep -E -- "-${flavor}$" <<< "$stages" | head -n 1 || true)
  if [[ -n "$stage" ]]; then
    printf '%s\n' "$stage"
    return 0
  fi
  return 1
}

# Dockerfile по образу.
dockerfile_for() {
  case "$1" in
    backend)  printf '%s\n' "$REPO_ROOT/docker/Dockerfile.backend" ;;
    executor) printf '%s\n' "$REPO_ROOT/docker/Dockerfile.executor" ;;
    *) die "неизвестный образ: $1" ;;
  esac
}

# Имя репозитория в реестре.
repo_for() {
  printf '%s/%s/synth-%s\n' "$REGISTRY" "$NAMESPACE" "$1"
}

# --- авторизация ------------------------------------------------------------

TOKEN=""
TOKEN_SOURCE=""
resolve_token() {
  if [[ -n "${GV_GITEA_TOKEN:-}" ]]; then
    TOKEN="$GV_GITEA_TOKEN"; TOKEN_SOURCE="GV_GITEA_TOKEN"
  elif [[ -n "${GITEA_TOKEN:-}" ]]; then
    TOKEN="$GITEA_TOKEN"; TOKEN_SOURCE="GITEA_TOKEN"
  fi
}

resolve_token
GITEA_LOGIN="${GITEA_USER:-itphx}"

if [[ "$SKIP_PUSH" == "0" && "$DRY_RUN" == "0" && -z "$TOKEN" ]]; then
  die "токен Gitea не задан: задайте GV_GITEA_TOKEN (секрет CI) или GITEA_TOKEN (локально) — публикация без токена невозможна"
fi

if [[ "$SKIP_PUSH" == "0" && -n "$TOKEN" ]]; then
  log "авторизация в реестре $REGISTRY (пользователь $GITEA_LOGIN, токен из ${TOKEN_SOURCE})"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  + docker login %s --username %s --password-stdin\n' "$REGISTRY" "$GITEA_LOGIN"
  else
    printf '%s' "$TOKEN" | docker login "$REGISTRY" --username "$GITEA_LOGIN" --password-stdin >/dev/null \
      || die "docker login $REGISTRY не удался"
    log "вход выполнен"
  fi
fi

# --- сборка и публикация ----------------------------------------------------

SUMMARY=()

build_image() {
  local image="$1" flavor="$2" stage="$3" tag="$4" dockerfile="$5"
  local -a args=(build --file "$dockerfile" --tag "$tag")

  [[ -n "$stage" ]] && args+=(--target "$stage")
  [[ "$image" == "backend" ]] && args+=(--build-arg "SYNTH_BACKEND_VERSION=$TAG_BASE")
  args+=("$REPO_ROOT")

  log "сборка $image (flavor: ${flavor:-slim}) → $tag"
  run docker "${args[@]}" || die "сборка не удалась: $tag"
}

push_image() {
  local tag="$1" attempt=1
  if [[ "$SKIP_PUSH" == "1" ]]; then
    log "push пропущен (--skip-push): $tag"
    return 0
  fi
  while true; do
    log "push $tag (попытка $attempt/$PUSH_RETRIES)"
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '  + docker push %s\n' "$tag"
      return 0
    fi
    if docker push "$tag"; then
      return 0
    fi
    if [[ "$attempt" -ge "$PUSH_RETRIES" ]]; then
      die "push не удался после $PUSH_RETRIES попыток: $tag (проверьте DNS/реестр: git.itphx.ru сбрасывает параллельные запросы)"
    fi
    warn "push не удался ($tag) — повтор через ${PUSH_RETRY_DELAY}s"
    sleep "$PUSH_RETRY_DELAY"
    attempt=$((attempt + 1))
  done
}

image_size_mb() {
  local tag="$1" bytes
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'n/a'
    return 0
  fi
  bytes=$(docker image inspect "$tag" --format '{{.Size}}' 2>/dev/null || echo "")
  if [[ -z "$bytes" ]]; then
    printf 'n/a'
  else
    printf '%d' $(( bytes / 1024 / 1024 ))
  fi
}

image_digest() {
  local tag="$1" digest
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'n/a'
    return 0
  fi
  digest=$(docker image inspect "$tag" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' 2>/dev/null || echo "")
  printf '%s' "${digest:-n/a}"
}

for image in $IMAGES; do
  dockerfile=$(dockerfile_for "$image")
  if [[ ! -f "$dockerfile" ]]; then
    die "Dockerfile не найден: $dockerfile — образ '$image' собрать нечем (PROP-082, шаг 5)"
  fi

  for flavor in $FLAVORS; do
    repo=$(repo_for "$image")
    tag="${repo}:${TAG_BASE}-${flavor}"
    stage=$(resolve_stage "$dockerfile" "$flavor" || true)
    if [[ -z "$stage" ]]; then
      die "в $dockerfile нет стадии для flavor'а '$flavor' (доступные: $(dockerfile_stages "$dockerfile" | tr '\n' ' '))"
    fi
    build_image "$image" "$flavor" "$stage" "$tag" "$dockerfile"
    push_image "$tag"
    SUMMARY+=("$image|$flavor|$tag|$(image_size_mb "$tag")|$(image_digest "$tag")")
  done

  # Slim-база control plane: тег БЕЗ суффикса flavor'а.
  if [[ "$image" == "backend" && "$INCLUDE_SLIM" == "1" ]]; then
    repo=$(repo_for "$image")
    tag="${repo}:${TAG_BASE}"
    stage=$(resolve_stage "$dockerfile" "slim" || true)
    build_image "$image" "slim" "$stage" "$tag" "$dockerfile"
    push_image "$tag"
    SUMMARY+=("$image|slim|$tag|$(image_size_mb "$tag")|$(image_digest "$tag")")
  fi
done

# --- сводка ------------------------------------------------------------------

echo
log "сводка публикации:"
printf '%-10s %-8s %-52s %10s  %s\n' "ОБРАЗ" "FLAVOR" "ТЕГ" "РАЗМЕР,МБ" "DIGEST"
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r img flv tg sz dg <<< "$row"
  printf '%-10s %-8s %-52s %10s  %s\n' "$img" "$flv" "$tg" "$sz" "$dg"
done

if [[ "$SKIP_PUSH" == "1" ]]; then
  log "публикация пропущена (--skip-push)"
elif [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run: публикация не выполнялась"
else
  log "публикация завершена"
fi
