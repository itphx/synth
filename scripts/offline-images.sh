#!/usr/bin/env bash
#
# offline-images.sh — сборка offline-образов Synth для закрытого контура.
#
# Собирает три базовых образа (synth, synth-backend, synth-ui) под несколько
# архитектур, проверяет, что контейнеры отвечают на health-эндпоинт, и (по флагу
# --save) складывает `docker save`-архивы + SHA256SUMS + manifest.json.
#
# Компрессия архивов по умолчанию — gzip (`*.tar.gz`): Docker 20.10 не всегда
# умеет `docker load` zstd-архивов. `--compression zstd` даёт меньший размер,
# `--compression none` — сырой tar. zstd при отсутствии бинаря откатывается на
# gzip с предупреждением.
#
# Multi-arch реализован через `docker buildx`: Dockerfile'ы устроены так, что
# стадия сборки идёт на `$BUILDPLATFORM`, а в целевой стадии нет RUN. Поэтому
# arm64 собирается на amd64-раннере БЕЗ QEMU/binfmt — эмулировать нечего.
# Для запуска arm64-контейнера (проверка health) QEMU всё же нужен: если binfmt
# не зарегистрирован, проверка для чужой архитектуры пропускается с пометкой
# `verified: "skipped"` (сборка и архивы от этого не страдают).
#
# Примеры:
#   # локальная сборка amd64+arm64 и offline-архивы
#   ./scripts/offline-images.sh --version 0.11.1 --platforms amd64,arm64 --save
#
#   # только amd64, без проверки запуска
#   ./scripts/offline-images.sh --version 0.11.1 --platforms amd64 --no-verify
#
#   # CI: собрать и запушить arm64 в два реестра, затем собрать manifest list
#   ./scripts/offline-images.sh --version 0.11.1 --platforms arm64 \
#       --push --registry-prefix gitverse.ru/itphx,ghcr.io/itphx
#   ./scripts/offline-images.sh --version 0.11.1 --platforms amd64,arm64 \
#       --manifests --registry-prefix gitverse.ru/itphx,ghcr.io/itphx
#
# Требования: bash 4+, docker (с BuildKit; buildx ставится флагом --ensure-buildx),
# curl, node (для manifest.json; есть в репозитории/CI); gzip — всегда,
# zstd — только для `--compression zstd`.
#
# Секретов скрипт не печатает: авторизация берётся из DOCKER_CONFIG/docker login.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=""
PLATFORMS="amd64,arm64"
OUT_DIR="dist/offline/images"
REGISTRY_PREFIX="local"
COMPRESSION="gzip"
DO_SAVE=0
DO_PUSH=0
DO_MANIFESTS=0
DO_VERIFY=1
DRY_RUN=0
ENSURE_BUILDX_ONLY=0
KEEP_CONTAINERS=0

# Версия плагина buildx для авто-установки (пин, не latest).
BUILDX_VERSION="${BUILDX_VERSION:-0.30.1}"
BUILDER_NAME="${BUILDX_BUILDER:-synth-offline}"

# name|dockerfile|build-arg|container-port|health-path(s)|extra docker run args
IMAGES=(
  "synth|docker/Dockerfile|SYNTH_VERSION|4300|/health|"
  "synth-backend|docker/Dockerfile.backend|SYNTH_BACKEND_VERSION|5000|/ready /health|"
  "synth-ui|docker/Dockerfile.ui|SYNTH_UI_VERSION|8080|/|--add-host synth-backend:127.0.0.1"
)

log()  { printf '[offline-images] %s\n' "$*"; }
loge() { printf '[offline-images] %s\n' "$*" >&2; }
warn() { printf '[offline-images] ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
die()  { printf '[offline-images] ОШИБКА: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Флаги:
  --version <ver>          Версия релиза (обязателен, кроме --ensure-buildx).
  --platforms <list>       Список архитектур через запятую (default: amd64,arm64).
  --out <dir>              Каталог архивов (default: dist/offline/images).
  --registry-prefix <p>    Префикс тегов/реестров через запятую (default: local).
  --compression <mode>     gzip (default) | zstd | none. gzip совместим с Docker 20.10.
  --zstd                   Алиас --compression zstd.
  --save                   Сохранить `docker save`-архивы + SHA256SUMS + manifest.json.
  --push                   Запушить собранные per-arch теги в реестры из --registry-prefix.
  --manifests              Собрать manifest list <ver> из <ver>-amd64/<ver>-arm64 (best-effort).
  --no-verify              Не проверять запуск контейнеров.
  --keep-containers        Не удалять контейнеры после проверки (для отладки).
  --ensure-buildx          Установить плагин buildx (если отсутствует) и выйти.
  --dry-run                Показать команды, ничего не делать.
  -h, --help               Эта справка.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)          VERSION="${2:-}"; shift 2 ;;
    --platforms)        PLATFORMS="${2:-}"; shift 2 ;;
    --out)              OUT_DIR="${2:-}"; shift 2 ;;
    --registry-prefix)  REGISTRY_PREFIX="${2:-}"; shift 2 ;;
    --compression)      COMPRESSION="${2:-}"; shift 2 ;;
    --zstd)             COMPRESSION="zstd"; shift ;;
    --save)             DO_SAVE=1; shift ;;
    --push)             DO_PUSH=1; shift ;;
    --manifests)        DO_MANIFESTS=1; shift ;;
    --no-verify)        DO_VERIFY=0; shift ;;
    --keep-containers)  KEEP_CONTAINERS=1; shift ;;
    --ensure-buildx)    ENSURE_BUILDX_ONLY=1; shift ;;
    --dry-run)          DRY_RUN=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

# ---------------------------------------------------------------- утилиты

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  + %s\n' "$*"
  else
    "$@"
  fi
}

# Разбор строки IMAGES → глобальные поля текущего образа.
load_image() {
  local spec="$1"
  IFS='|' read -r IMG_NAME IMG_DOCKERFILE IMG_BUILD_ARG IMG_PORT IMG_PATHS IMG_RUN_ARGS <<<"$spec"
}

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)  echo "arm64" ;;
    *)              uname -m ;;
  esac
}

# shellcheck disable=SC2317 # вызывается косвенно из trap
cleanup() {
  local cname
  if [[ "$KEEP_CONTAINERS" == "1" ]]; then return 0; fi
  for cname in ${VERIFY_CONTAINERS:-}; do
    docker rm -f "$cname" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------- buildx

ensure_buildx() {
  if docker buildx version >/dev/null 2>&1; then
    log "buildx: $(docker buildx version | head -1)"
    return 0
  fi
  [[ "$DRY_RUN" == "1" ]] && { log "[dry-run] установка buildx v$BUILDX_VERSION"; return 0; }

  local plugin_dir="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  mkdir -p "$plugin_dir"
  log "buildx не найден — устанавливаю v$BUILDX_VERSION в $plugin_dir"

  # Способ 1: официальный образ с бинарником (не требует GitHub API/токенов).
  if docker pull "docker.io/docker/buildx-bin:$BUILDX_VERSION" >/dev/null 2>&1 \
     && docker create --name "buildx-extract-$$" "docker.io/docker/buildx-bin:$BUILDX_VERSION" >/dev/null 2>&1; then
    docker cp "buildx-extract-$$:/buildx" "$plugin_dir/docker-buildx" >/dev/null 2>&1 || true
    docker rm -f "buildx-extract-$$" >/dev/null 2>&1 || true
  fi

  # Способ 2: релиз на GitHub.
  if [[ ! -s "$plugin_dir/docker-buildx" ]]; then
    local arch
    arch="$(host_arch)"
    if curl -fsSL -o "$tmp_dir/buildx" \
      "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${arch}" 2>/dev/null; then
      install -m 0755 "$tmp_dir/buildx" "$plugin_dir/docker-buildx"
    fi
  fi
  rm -rf "$tmp_dir"
  chmod +x "$plugin_dir/docker-buildx" 2>/dev/null || true
  docker buildx version >/dev/null 2>&1 || die "не удалось установить buildx v$BUILDX_VERSION"
  log "buildx установлен: $(docker buildx version | head -1)"
}

ensure_builder() {
  [[ "$DRY_RUN" == "1" ]] && return 0
  if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then return 0; fi
  log "создаю builder '$BUILDER_NAME' (docker driver)"
  if ! docker buildx create --name "$BUILDER_NAME" --driver docker >/dev/null 2>&1; then
    warn "docker driver недоступен — пробую docker-container"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container >/dev/null \
      || die "не удалось создать builder"
  fi
}

# ---------------------------------------------------------------- сборка

archive_ext() {
  case "$COMPRESSION" in
    zstd) echo "tar.zst" ;;
    none) echo "tar" ;;
    *)    echo "tar.gz" ;;
  esac
}

compress_tar() {
  local src="$1" dst="$2"
  case "$dst" in
    *.tar.zst) zstd -q -f -T0 -3 --rm -o "$dst" "$src" ;;
    *.tar.gz)  gzip -9 -c "$src" >"$dst" && rm -f "$src" ;;
    *)         mv -f "$src" "$dst" ;;
  esac
  chmod 0644 "$dst" 2>/dev/null || true
}

build_one() {
  local name="$1" arch="$2"
  local tag="$3"
  local platform="linux/$arch"
  local args=(
    buildx build
    --builder "$BUILDER_NAME"
    --platform "$platform"
    -f "$IMG_DOCKERFILE"
    -t "$tag"
    --build-arg "${IMG_BUILD_ARG}=${VERSION}"
    --provenance=false
    --sbom=false
    --load
    .
  )
  log "сборка $name ($platform) → $tag"
  ( cd "$REPO_ROOT" && run docker "${args[@]}" )
}

# ---------------------------------------------------------------- проверка

pick_port() {
  local p
  for p in $(seq 18080 18160); do
    if ! (echo >"/dev/tcp/127.0.0.1/$p") >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  echo $((20000 + RANDOM % 10000))
}

can_run_arch() {
  local arch="$1"
  [[ "$arch" == "$(host_arch)" ]] && return 0
  [[ -e "/proc/sys/fs/binfmt_misc/qemu-$arch" ]]
}

# verify_one <tag> <arch>; печатает "ok|skipped|failed" и причину через \t.
verify_one() {
  local tag="$1" arch="$2"
  local path code port cname i
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'skipped\tdry-run\n'
    return 0
  fi
  if ! can_run_arch "$arch"; then
    printf 'skipped\tbinfmt/qemu-%s не зарегистрирован\n' "$arch"
    return 0
  fi

  port="$(pick_port)"
  cname="synth-verify-$$-$RANDOM"
  VERIFY_CONTAINERS="${VERIFY_CONTAINERS:-} $cname"
  loge "проверка $tag: $IMG_NAME → http://127.0.0.1:$port${IMG_PATHS%% *}"
  # shellcheck disable=SC2086 # IMG_RUN_ARGS — намеренный список аргументов
  if ! docker run -d --rm --name "$cname" \
      -p "127.0.0.1:${port}:${IMG_PORT}" \
      -e SYNTH_DATA_DIR=/tmp/synth-verify-data \
      $IMG_RUN_ARGS \
      "$tag" >/dev/null 2>&1; then
    printf 'failed\tконтейнер не стартовал\n'
    return 0
  fi

  for i in $(seq 1 30); do
    for path in $IMG_PATHS; do
      code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${port}${path}" 2>/dev/null || true)"
      if [[ "$code" == "200" ]]; then
        [[ "$KEEP_CONTAINERS" == "1" ]] || docker rm -f "$cname" >/dev/null 2>&1 || true
        printf 'ok\t%s 200 (%ss)\n' "$path" "$((i * 2))"
        return 0
      fi
    done
    sleep 2
  done

  warn "проверка $tag не прошла (последний код: ${code:-нет ответа}); логи:"
  docker logs --tail 30 "$cname" >&2 2>&1 || true
  [[ "$KEEP_CONTAINERS" == "1" ]] || docker rm -f "$cname" >/dev/null 2>&1 || true
  printf 'failed\tнет 200 от %s\n' "$IMG_PATHS"
}

# ---------------------------------------------------------------- архивы

save_one() {
  local tag="$1" archive="$2"
  local ext tmp
  ext="$(archive_ext)"
  archive="${archive%.tar}.${ext}"
  loge "docker save $tag → $(basename "$archive")"
  if [[ "$DRY_RUN" == "1" ]]; then
    loge "[dry-run] docker save -o $archive $tag"
    echo "$archive"
    return 0
  fi
  tmp="$(mktemp "$OUT_DIR/.save-XXXXXX.tar")"
  docker save -o "$tmp" "$tag"
  compress_tar "$tmp" "$archive"
  echo "$archive"
}

# ---------------------------------------------------------------- main

if [[ "$ENSURE_BUILDX_ONLY" == "1" ]]; then
  ensure_buildx
  exit 0
fi

[[ -n "$VERSION" ]] || die "--version обязателен"
[[ "$VERSION" =~ ^[0-9A-Za-z._-]+$ ]] || die "недопустимая версия: $VERSION"

case "$COMPRESSION" in
  gzip|zstd|none) ;;
  *) die "недопустимая компрессия: $COMPRESSION (gzip|zstd|none)" ;;
esac
if [[ "$COMPRESSION" == "zstd" ]] && ! command -v zstd >/dev/null 2>&1; then
  warn "zstd не найден в PATH — откатываюсь на gzip"
  COMPRESSION="gzip"
fi
if [[ "$COMPRESSION" == "gzip" ]] && ! command -v gzip >/dev/null 2>&1; then
  die "gzip не найден в PATH (используйте --compression zstd или none)"
fi

cd "$REPO_ROOT"
[[ "$OUT_DIR" = /* ]] || OUT_DIR="$REPO_ROOT/$OUT_DIR"

ensure_buildx
ensure_builder

# --manifests — отдельный режим: только manifest list по уже опубликованным тегам.
if [[ "$DO_MANIFESTS" == "1" ]]; then
  log "сборка manifest list для версии $VERSION (best-effort)"
  rc=0
  IFS=',' read -r -a prefixes <<<"$REGISTRY_PREFIX"
  for prefix in "${prefixes[@]}"; do
    [[ "$prefix" == "local" ]] && { warn "manifest list для local-префикса не нужен — пропуск"; continue; }
    for spec in "${IMAGES[@]}"; do
      load_image "$spec"
      base="$prefix/$IMG_NAME"

      # Идемпотентность: :<ver> уже multi-arch с arm64 — ничего не делаем.
      if [[ "$DRY_RUN" != "1" ]] && docker buildx imagetools inspect --raw "$base:$VERSION" 2>/dev/null | grep -q '"arm64"'; then
        log "$IMG_NAME: $base:$VERSION уже содержит arm64 — пропуск"
        continue
      fi

      # Собираем per-arch теги; amd64-алиас при необходимости создаём с :<ver>
      # (его туда положил kaniko).
      arch_tags=()
      for arch in ${PLATFORMS//,/ }; do
        arch_tag="$base:$VERSION-$arch"
        if [[ "$DRY_RUN" != "1" ]] && ! docker buildx imagetools inspect "$arch_tag" >/dev/null 2>&1; then
          if [[ "$arch" == "amd64" ]] && docker buildx imagetools inspect "$base:$VERSION" >/dev/null 2>&1; then
            log "$IMG_NAME: создаю алиас $arch_tag ← $base:$VERSION"
            if ! docker buildx imagetools create -t "$arch_tag" "$base:$VERSION" >/dev/null 2>&1; then
              warn "$IMG_NAME: не удалось создать $VERSION-amd64 — manifest пропущен"
              rc=1
              continue 2
            fi
          else
            warn "$arch_tag отсутствует — $IMG_NAME пропущен"
            rc=1
            continue 2
          fi
        fi
        arch_tags+=("$arch_tag")
      done

      log "$IMG_NAME: manifest list $base:$VERSION ← ${arch_tags[*]}"
      if [[ "$DRY_RUN" == "1" ]]; then continue; fi
      if ! docker buildx imagetools create -t "$base:$VERSION" "${arch_tags[@]}" >/dev/null 2>&1; then
        warn "$IMG_NAME: реестр $prefix не принял manifest list — остаются теги -amd64/-arm64"
        rc=1
      fi
    done
  done
  if [[ "$rc" != "0" ]]; then
    warn "manifest list собран не полностью (per-arch теги сохранены) — это не блокер"
  fi
  exit 0
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/.save-*.tar
ENTRIES_FILE="$(mktemp)"
trap 'rm -f "$ENTRIES_FILE"; cleanup' EXIT

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

IFS=',' read -r -a prefixes <<<"$REGISTRY_PREFIX"

for arch in ${PLATFORMS//,/ }; do
  case "$arch" in
    amd64|arm64) ;;
    *) die "неподдерживаемая архитектура: $arch (ожидается amd64/arm64)" ;;
  esac

  for spec in "${IMAGES[@]}"; do
    load_image "$spec"
    main_tag="${prefixes[0]}/$IMG_NAME:$VERSION-$arch"

    build_one "$IMG_NAME" "$arch" "$main_tag"

    if [[ "$DRY_RUN" != "1" ]]; then
      digest="$(docker image inspect -f '{{.Id}}' "$main_tag")"
      size="$(docker image inspect -f '{{.Size}}' "$main_tag")"
    else
      digest="sha256:dry-run"; size="0"
    fi

    # push per-arch тегов во все указанные реестры (первый уже собран локально).
    if [[ "$DO_PUSH" == "1" ]]; then
      for prefix in "${prefixes[@]}"; do
        [[ "$prefix" == "local" ]] && { warn "push в 'local' пропущен"; continue; }
        push_tag="$prefix/$IMG_NAME:$VERSION-$arch"
        if [[ "$prefix" != "${prefixes[0]}" ]]; then
          run docker tag "$main_tag" "$push_tag"
        fi
        log "push $push_tag"
        run docker push "$push_tag"
      done
    fi

    # проверка запуска: локальный тег, под которым образ реально загружен.
    verified="skipped"; verify_note="--no-verify"
    if [[ "$DO_VERIFY" == "1" ]]; then
      result="$(verify_one "$main_tag" "$arch")"
      verified="${result%%$'\t'*}"
      verify_note="${result#*$'\t'}"
    fi

    archive=""; sha=""
    if [[ "$DO_SAVE" == "1" ]]; then
      archive="$(save_one "$main_tag" "$OUT_DIR/${IMG_NAME}-${VERSION}-${arch}.tar")"
      if [[ "$DRY_RUN" != "1" && -f "$archive" ]]; then
        sha="$(sha256sum "$archive" | awk '{print $1}')"
      fi
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$IMG_NAME" "$main_tag" "linux/$arch" "$arch" "$digest" "$size" \
      "$(basename "${archive:-}")" "$sha" "$verified" "$verify_note" >>"$ENTRIES_FILE"
  done
done

if [[ "$DO_SAVE" == "1" ]]; then
  # SHA256SUMS — по всем архивам каталога (включая оставшиеся от прошлых прогонов).
  if [[ "$DRY_RUN" != "1" ]]; then
    ( cd "$OUT_DIR" && find . -maxdepth 1 -type f \( -name '*.tar' -o -name '*.tar.gz' -o -name '*.tar.zst' \) ! -name '.*' -printf '%f\n' \
        | sort | while read -r f; do sha256sum "$f"; done > SHA256SUMS )
    log "SHA256SUMS: $OUT_DIR/SHA256SUMS"

    manifest_path="$OUT_DIR/manifest.json"
    MANIFEST_PATH="$manifest_path" ENTRIES_FILE="$ENTRIES_FILE" \
    VERSION="$VERSION" PLATFORMS="$PLATFORMS" GENERATED_AT="$started_at" \
    COMPRESSION="$COMPRESSION" \
    node <<'NODE'
const fs = require('node:fs');

const read = (p) => fs.readFileSync(p, 'utf8');
const out = process.env.MANIFEST_PATH;
const rows = read(process.env.ENTRIES_FILE)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [name, tag, platform, arch, digest, sizeBytes, archive, sha256, verified, note] = line.split('\t');
    return {
      name,
      tag,
      platform,
      arch,
      digest,
      sizeBytes: Number(sizeBytes || 0),
      archive: archive || null,
      sha256: sha256 || null,
      verified: verified === 'ok' ? true : verified,
      verifyNote: note || null,
    };
  });

const manifest = {
  generator: 'scripts/offline-images.sh',
  version: process.env.VERSION,
  generatedAt: process.env.GENERATED_AT,
  compression: process.env.COMPRESSION,
  platforms: process.env.PLATFORMS.split(',').map((a) => `linux/${a}`),
  images: rows,
};
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[offline-images] manifest.json: ${out} (${rows.length} записей)`);
NODE
  fi
fi

log "готово. Архивы: $OUT_DIR"
