#!/usr/bin/env bash
#
# ci-images.sh — сборка flavor-образов и smoke-тесты в CI (PROP-082, шаг 6).
#
# Скрипт НЕ публикует образы: публикация — по тегу релиза
# (`.gitverse/workflows/release.yaml`, джоба `publish-images-gitea`).
# Здесь только проверка: flavor'ы собираются, а toolchain внутри работает.
#
# Для каждой пары (образ × flavor):
#   1. `docker build --target <flavor>` (в локальный тег, без push);
#   2. `scripts/smoke-image.sh --image <локальный тег> --flavor <flavor>`.
#
# Требуется docker-демон. Если его нет — скрипт завершается с кодом 3
# («среда не готова»), и вызывающий шаг CI печатает предупреждение и
# продолжает (best-effort, как offline-архивы в release.yaml).
#
# Примеры:
#   bash scripts/ci-images.sh                          # все flavor'ы обоих образов
#   bash scripts/ci-images.sh --flavors core           # только core
#   bash scripts/ci-images.sh --images executor        # только исполнитель
#   bash scripts/ci-images.sh --no-smoke               # только сборка

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FLAVORS="core dev devops browser full"
IMAGES="backend executor"
DO_SMOKE=1

log()  { printf '[ci-images] %s\n' "$*"; }
loge() { printf '[ci-images] %s\n' "$*" >&2; }

usage() {
  sed -n '2,/^# Требования/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Флаги:
  --flavors <list>   Flavor'ы через запятую (по умолчанию: core dev devops browser full).
  --images <list>    Образы через запятую: backend | executor (по умолчанию: оба).
  --no-smoke         Только сборка (без smoke-тестов).
  -h, --help         Эта справка.

Коды возврата: 0 — всё собрано и (если включено) проверено; 1 — ошибка сборки
или провал smoke-теста; 3 — в среде нет docker-демона (best-effort в CI).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --flavors) FLAVORS="${2:-}"; shift 2 ;;
    --images)  IMAGES="${2:-}"; shift 2 ;;
    --no-smoke) DO_SMOKE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) loge "неизвестный аргумент: $1 (см. --help)"; exit 1 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1 || ! docker version >/dev/null 2>&1; then
  loge "docker-демон недоступен — сборка и smoke-тесты образов невозможны"
  exit 3
fi

dockerfile_for() {
  case "$1" in
    backend)  printf '%s\n' "$REPO_ROOT/docker/Dockerfile.backend" ;;
    executor) printf '%s\n' "$REPO_ROOT/docker/Dockerfile.executor" ;;
    *) loge "неизвестный образ: $1"; exit 1 ;;
  esac
}

FAILED=0

for image in ${IMAGES//,/ }; do
  dockerfile="$(dockerfile_for "$image")"
  for flavor in ${FLAVORS//,/ }; do
    tag="synth-ci/$image:$flavor"
    log "сборка $image ($flavor) → $tag"
    if ! docker build --file "$dockerfile" --target "$flavor" --tag "$tag" "$REPO_ROOT" >/dev/null; then
      loge "СБОРКА НЕ УДАЛАСЬ: $image ($flavor)"
      FAILED=1
      continue
    fi
    if [[ "$DO_SMOKE" == "1" ]]; then
      log "smoke-тест $image ($flavor)…"
      if ! bash "$SCRIPT_DIR/smoke-image.sh" --image "$tag" --flavor "$flavor"; then
        loge "SMOKE-ТЕСТ НЕ ПРОЙДЕН: $image ($flavor)"
        FAILED=1
      fi
    fi
    docker image rm "$tag" >/dev/null 2>&1 || true
  done
done

if [[ "$FAILED" != "0" ]]; then
  loge "есть неуспешные сборки/проверки"
  exit 1
fi
log "все flavor'ы собраны и проверены"
exit 0
