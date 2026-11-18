#!/usr/bin/env bash
#
# ci-helm.sh — устойчивое получение Helm и работа с чартом в CI (GitVerse).
#
# Зачем: на раннерах GitVerse хост get.helm.sh недоступен (curl: (28) connect
# timeout), из-за чего шаг «Установка Helm» валил джобу Helm-чарта. GitVerse при
# падении джобы пропускает последующие джобы (в т.ч. create-release — проверено
# на v0.8.8), поэтому ставить и публиковать helm теперь умеет этот скрипт:
#
#   * helm резолвится по цепочке: HELM_BIN → helm в PATH → кэш в рабочей копии →
#     зеркала (get.helm.sh, huaweicloud, github) с проверкой sha256 →
#     docker-образ alpine/helm:<version>;
#   * в лог всегда пишется, какой источник сработал;
#   * CI_HELM_SOFT=1 смягчает ТОЛЬКО предпосылки, не зависящие от реестра: helm
#     не получен, lint/package не удались, не задан токен — печатается
#     предупреждение и код возврата 0 (это инфраструктура раннера);
#   * отказ реестра при публикации (HTTP != 2xx) — ВСЕГДА ошибка с кодом 1,
#     независимо от CI_HELM_SOFT: чарт — поставляемый артефакт, молчаливый
#     пропуск недопустим (зелёный релиз без чарта в реестре — ложный сигнал);
#   * после успешного POST версия сверяется с index.yaml реестра (идемпотентно,
#     анонимно): версии нет в доступном индексе — ошибка; индекс недоступен
#     (сеть/реестр) — предупреждение, проверка не превращается в хрупкую.
#
# Использование:
#   scripts/ci-helm.sh sources                       # диагностика: что доступно
#   scripts/ci-helm.sh install                       # получить helm (без команд)
#   scripts/ci-helm.sh lint [chart_dir]              # helm lint
#   scripts/ci-helm.sh template <release> [chart_dir] # helm template
#   scripts/ci-helm.sh package [chart_dir] <version>  # helm package → dist/helm
#   scripts/ci-helm.sh publish [chart_dir] <version>  # lint + package + upload
#
# Переменные окружения:
#   HELM_VERSION         версия helm (по умолчанию 3.20.1)
#   HELM_BIN             явный путь к бинарю helm (переопределяет поиск/скачивание)
#   HELM_INSTALL_DIR     каталог установки (по умолчанию tmp/ci-helm)
#   HELM_SOURCES         свой список зеркал, URL через пробел
#                        (плейсхолдеры {version}, {platform}, {arch})
#   HELM_PLATFORM        linux|darwin (по умолчанию — uname -s)
#   HELM_ARCH            amd64|arm64|arm|386|s390x|ppc64le|riscv64
#   CI_HELM_SOFT         1 — не валить шаг при недоступности helm/сбое
#                        lint|package/отсутствии токена (инфраструктура
#                        раннера). Отказ реестра при публикации валит всегда.
#   CI_HELM_DOCKER       0 — не использовать docker-образ как фоллбэк
#   CI_HELM_DOCKER_IMAGE образ helm (по умолчанию alpine/helm:$HELM_VERSION)
#   CHART_DIR            каталог чарта (по умолчанию charts/synth)
#   CHART_REGISTRY_URL   эндпоинт Helm-реестра Gitea (нативный API `/api/charts`)
#   CHART_REGISTRY_INDEX_URL  index.yaml того же реестра — проверка после
#                        публикации (по умолчанию …/helm/index.yaml)
#   CHART_REGISTRY_USER  пользователь реестра (по умолчанию itphx)
#   GITEA_TOKEN          пароль реестра (секрет GT_TOKEN; в лог не пишется).
#                        Для обратной совместимости читается и GV_TOKEN.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
cd "$ROOT_DIR" || exit 1

HELM_VERSION="${HELM_VERSION:-3.20.1}"
HELM_INSTALL_DIR="${HELM_INSTALL_DIR:-tmp/ci-helm}"
HELM_BIN_DIR="$HELM_INSTALL_DIR/bin"
HELM_CACHED="$HELM_BIN_DIR/helm"

CI_HELM_SOFT="${CI_HELM_SOFT:-0}"
CI_HELM_DOCKER="${CI_HELM_DOCKER:-1}"
CI_HELM_DOCKER_IMAGE="${CI_HELM_DOCKER_IMAGE:-alpine/helm:$HELM_VERSION}"

CHART_DIR_DEFAULT="${CHART_DIR:-charts/synth}"
CHART_REGISTRY_URL="${CHART_REGISTRY_URL:-https://git.itphx.ru/api/packages/itphx/helm/api/charts}"
# Индекс того же реестра: после успешного POST проверяем, что версия в нём видна
# (идемпотентно, анонимно — реестр публичный).
CHART_REGISTRY_INDEX_URL="${CHART_REGISTRY_INDEX_URL:-https://git.itphx.ru/api/packages/itphx/helm/index.yaml}"
CHART_REGISTRY_USER="${CHART_REGISTRY_USER:-itphx}"
# Пароль реестра: GITEA_TOKEN (секрет GT_TOKEN). GV_TOKEN — обратная совместимость
# для вызовов, оставшихся с прежнего (GitVerse) реестра.
CHART_REGISTRY_TOKEN="${GITEA_TOKEN:-${GV_TOKEN:-}}"

# Соединение ограничиваем по времени: у «мёртвого» хоста не должно уходить
# 2+ минуты, как уходит при дефолтном connect timeout curl.
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-8}"
CURL_MAX_TIME="${CURL_MAX_TIME:-300}"

# Состояние резолвинга helm.
HELM_MODE="binary"        # binary | docker
HELM_BIN_RESOLVED=""      # путь к бинарю (HELM_MODE=binary)
HELM_SOURCE=""            # человекочитаемый источник, которым получен helm

log() { printf '[ci-helm] %s\n' "$*"; }
warn() { printf '[ci-helm] ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
err() { printf '[ci-helm] ОШИБКА: %s\n' "$*" >&2; }

usage() {
  # Шапка — до `set -uo pipefail` включительно: диапазон не «съезжает» при
  # добавлении переменных окружения.
  sed -n '2,/^set -uo pipefail$/p' "$0" | sed 's/^# \{0,1\}//'
}

soft_skip_or_fail() {
  # $1 — причина; $2 = 1 — напечатать диагностику источников.
  # Только для ПРЕДПОСЫЛОК (helm/токен/lint/package): в мягком режиме шаг не
  # валится. Отказ реестра при публикации сюда не идёт — он валит всегда
  # (см. cmd_publish).
  local reason="$1" with_diagnostics="${2:-0}"
  if [ "$CI_HELM_SOFT" = "1" ]; then
    warn "ПРОПУСК (CI_HELM_SOFT=1): $reason"
  else
    err "$reason"
  fi
  [ "$with_diagnostics" = "1" ] && diagnose_sources
  if [ "$CI_HELM_SOFT" = "1" ]; then
    warn "джоба завершается успешно: GitVerse Release и остальные джобы не блокируются"
    warn "чарт можно опубликовать вручную; доступный источник Helm задаётся через HELM_SOURCES"
    exit 0
  fi
  exit 1
}

detect_platform() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) echo linux ;;
  esac
}

detect_arch() {
  case "$(uname -m 2>/dev/null)" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    armv7l | armv6l | arm) echo arm ;;
    i386 | i686) echo 386 ;;
    s390x) echo s390x ;;
    ppc64le) echo ppc64le ;;
    riscv64) echo riscv64 ;;
    *) echo amd64 ;;
  esac
}

HELM_PLATFORM="${HELM_PLATFORM:-$(detect_platform)}"
HELM_ARCH="${HELM_ARCH:-$(detect_arch)}"

# Источники по умолчанию, в порядке проверки. get.helm.sh — официальный, но с
# раннеров GitVerse недоступен; huaweicloud — рабочее зеркало с sha256-суммами;
# github — на случай, если релизы снова начнут публиковать бинари в assets.
DEFAULT_SOURCES="
https://get.helm.sh/helm-v{version}-{platform}-{arch}.tar.gz
https://repo.huaweicloud.com/helm/v{version}/helm-v{version}-{platform}-{arch}.tar.gz
https://mirrors.huaweicloud.com/helm/v{version}/helm-v{version}-{platform}-{arch}.tar.gz
https://github.com/helm/helm/releases/download/v{version}/helm-v{version}-{platform}-{arch}.tar.gz
"
HELM_SOURCES="${HELM_SOURCES:-$DEFAULT_SOURCES}"

render_source() {
  # $1 — шаблон URL; подставляет версию/платформу/архитектуру.
  local url="$1"
  url="${url//\{version\}/$HELM_VERSION}"
  url="${url//\{platform\}/$HELM_PLATFORM}"
  url="${url//\{arch\}/$HELM_ARCH}"
  printf '%s' "$url"
}

list_sources() {
  local template
  for template in $HELM_SOURCES; do
    render_source "$template"
    printf '\n'
  done
}

# --- Резолвинг helm ---------------------------------------------------------

check_tool() { command -v "$1" >/dev/null 2>&1; }

probe_url() {
  # $1 — URL. Печатает HTTP-код (000 — недоступен) и время в секундах.
  local url="$1" result
  result=$(curl -sS -o /dev/null -L -I \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time 30 \
    -w '%{http_code} %{time_total}' "$url" 2>/dev/null) || result="000 -"
  printf '%s' "$result"
}

verify_download() {
  # $1 — файл, $2 — URL архива. Проверяет sha256, если сумма доступна рядом.
  local file="$1" url="$2" suffix out expected actual
  if ! check_tool sha256sum; then
    warn "sha256sum недоступен — контрольная сумма $file не проверена"
    return 0
  fi
  expected=""
  for suffix in ".sha256sum" ".sha256"; do
    out=$(curl -fsSL --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time 30 "$url$suffix" 2>/dev/null) || continue
    expected=$(printf '%s' "$out" | grep -oE '[0-9a-f]{64}' | head -1)
    [ -n "$expected" ] && break
  done
  if [ -z "$expected" ]; then
    warn "контрольная сумма недоступна для $url — проверка пропущена"
    return 0
  fi
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  if [ "$expected" != "$actual" ]; then
    err "sha256 не совпала: ожидалось $expected, получено $actual"
    return 1
  fi
  log "sha256 совпала ($actual)"
  return 0
}

install_from_archive() {
  # $1 — URL архива. Качает, проверяет сумму, распаковывает бинарь в HELM_BIN_DIR.
  local url="$1" tmp_dir tarball extract_dir
  tmp_dir=$(mktemp -d 2>/dev/null) || tmp_dir="$HELM_INSTALL_DIR/tmp.$$"
  mkdir -p "$tmp_dir"
  tarball="$tmp_dir/helm.tar.gz"

  if ! curl -fsSL --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    --retry 2 --retry-delay 2 -o "$tarball" "$url"; then
    err "не удалось скачать $url"
    rm -rf "$tmp_dir"
    return 1
  fi
  verify_download "$tarball" "$url" || { rm -rf "$tmp_dir"; return 1; }

  extract_dir="$tmp_dir/extract"
  mkdir -p "$extract_dir"
  if ! tar -xzf "$tarball" -C "$extract_dir" 2>/dev/null; then
    err "не удалось распаковать архив из $url"
    rm -rf "$tmp_dir"
    return 1
  fi
  if [ ! -f "$extract_dir/$HELM_PLATFORM-$HELM_ARCH/helm" ]; then
    err "в архиве нет $HELM_PLATFORM-$HELM_ARCH/helm ($url)"
    find "$extract_dir" -maxdepth 2 -type f 2>/dev/null | head -5 >&2
    rm -rf "$tmp_dir"
    return 1
  fi
  mkdir -p "$HELM_BIN_DIR"
  cp "$extract_dir/$HELM_PLATFORM-$HELM_ARCH/helm" "$HELM_CACHED"
  chmod +x "$HELM_CACHED"
  rm -rf "$tmp_dir"
  log "helm распакован: $HELM_CACHED"
  return 0
}

try_docker_fallback() {
  [ "$CI_HELM_DOCKER" = "1" ] || return 1
  check_tool docker || return 1
  if ! docker info >/dev/null 2>&1; then
    log "docker-фоллбэк недоступен: нет доступа к docker daemon"
    return 1
  fi
  log "пробую docker-фоллбэк: $CI_HELM_DOCKER_IMAGE"
  if check_tool timeout; then
    timeout "$CURL_MAX_TIME" docker run --rm "$CI_HELM_DOCKER_IMAGE" version >/dev/null 2>&1 || {
      err "образ $CI_HELM_DOCKER_IMAGE недоступен"
      return 1
    }
  else
    docker run --rm "$CI_HELM_DOCKER_IMAGE" version >/dev/null 2>&1 || {
      err "образ $CI_HELM_DOCKER_IMAGE недоступен"
      return 1
    }
  fi
  HELM_MODE="docker"
  HELM_SOURCE="docker-образ $CI_HELM_DOCKER_IMAGE"
  log "источник: $HELM_SOURCE"
  return 0
}

resolve_helm() {
  [ -n "$HELM_BIN_RESOLVED" ] && return 0
  [ "$HELM_MODE" = "docker" ] && return 0

  if [ -n "${HELM_BIN:-}" ]; then
    if [ -x "$HELM_BIN" ]; then
      HELM_BIN_RESOLVED="$HELM_BIN"
      HELM_SOURCE="HELM_BIN=$HELM_BIN"
      log "источник: $HELM_SOURCE"
      return 0
    fi
    warn "HELM_BIN=$HELM_BIN не исполняется — продолжаю поиск"
  fi

  if check_tool helm; then
    HELM_BIN_RESOLVED="$(command -v helm)"
    HELM_SOURCE="helm в PATH ($HELM_BIN_RESOLVED)"
    log "источник: $HELM_SOURCE"
    return 0
  fi

  if [ -x "$HELM_CACHED" ]; then
    HELM_BIN_RESOLVED="$HELM_CACHED"
    HELM_SOURCE="кэш $HELM_CACHED"
    log "источник: $HELM_SOURCE"
    return 0
  fi

  local url
  for url in $(list_sources); do
    log "пробую зеркало: $url"
    if install_from_archive "$url"; then
      HELM_BIN_RESOLVED="$HELM_CACHED"
      HELM_SOURCE="зеркало $url"
      log "источник: $HELM_SOURCE"
      return 0
    fi
    warn "источник не сработал: $url"
  done

  try_docker_fallback && return 0
  return 1
}

helm_bin() {
  # Выполняет helm ($@) — напрямую бинарём или через docker-образ.
  if [ "$HELM_MODE" = "docker" ]; then
    docker run --rm -v "$ROOT_DIR:/work" -w /work "$CI_HELM_DOCKER_IMAGE" "$@"
  else
    "$HELM_BIN_RESOLVED" "$@"
  fi
}

run_helm() {
  # $1 — описание шага, дальше — аргументы helm. Учитывает мягкий режим.
  local what="$1"
  shift
  if [ "$HELM_MODE" = "docker" ]; then
    log "($HELM_SOURCE) helm $*"
  else
    log "($HELM_SOURCE) $HELM_BIN_RESOLVED $*"
  fi
  if ! helm_bin "$@"; then
    soft_skip_or_fail "$what: helm завершился с ошибкой"
  fi
}

diagnose_sources() {
  log "диагностика источников helm (версия $HELM_VERSION, $HELM_PLATFORM-$HELM_ARCH):"
  if check_tool curl; then
    log "  curl: $(curl --version | head -1)"
  else
    log "  curl: нет — скачать helm из зеркал не получится"
  fi
  if [ -n "${HELM_BIN:-}" ]; then
    log "  HELM_BIN=$HELM_BIN (исполняется: $([ -x "$HELM_BIN" ] && echo да || echo нет))"
  fi
  if check_tool helm; then
    log "  helm в PATH: $(command -v helm)"
  else
    log "  helm в PATH: нет"
  fi
  if [ -x "$HELM_CACHED" ]; then
    log "  кэш: $HELM_CACHED"
  fi
  if check_tool docker; then
    log "  docker: да ($(docker info >/dev/null 2>&1 && echo 'daemon доступен' || echo 'daemon недоступен'))"
  else
    log "  docker: нет"
  fi
  local url probe code
  for url in $(list_sources); do
    probe=$(probe_url "$url")
    code="${probe%% *}"
    log "  $(printf '%-6s' "$code") $url  (${probe#* } c)"
  done
}

# --- Команды ----------------------------------------------------------------

cmd_sources() {
  diagnose_sources
  log "готово (диагностика ничего не меняет)"
  exit 0
}

cmd_install() {
  if ! resolve_helm; then
    soft_skip_or_fail "helm не удалось получить ни из одного источника" 1
  fi
  if [ "$HELM_MODE" = "binary" ]; then
    if ! helm_bin version --short 2>/dev/null; then
      soft_skip_or_fail "полученный helm не запускается ($HELM_BIN_RESOLVED)" 1
    fi
  fi
  log "Helm готов, источник: $HELM_SOURCE"
  exit 0
}

cmd_lint() {
  local chart="${1:-$CHART_DIR_DEFAULT}"
  resolve_helm || soft_skip_or_fail "helm недоступен — lint чарта не выполнен" 1
  run_helm "lint $chart" lint "$chart"
  exit 0
}

cmd_template() {
  local release="${1:?укажите имя релиза}" chart="${2:-$CHART_DIR_DEFAULT}"
  resolve_helm || soft_skip_or_fail "helm недоступен — рендер шаблонов не выполнен" 1
  run_helm "template $release $chart" template "$release" "$chart"
  exit 0
}

cmd_package() {
  local chart="${1:-$CHART_DIR_DEFAULT}" version="${2:?укажите версию}"
  resolve_helm || soft_skip_or_fail "helm недоступен — упаковка чарта не выполнена" 1
  mkdir -p dist/helm
  run_helm "package $chart" package "$chart" \
    --version "$version" --app-version "$version" --destination dist/helm
  if [ ! -f "dist/helm/synth-$version.tgz" ]; then
    soft_skip_or_fail "упакованный чарт dist/helm/synth-$version.tgz не найден"
  fi
  log "чарт упакован: dist/helm/synth-$version.tgz"
  exit 0
}

verify_chart_in_index() {
  # $1 — версия чарта. Идемпотентная сверка после успешного POST: версия должна
  # быть видна в index.yaml реестра (запрос анонимный — реестр публичный).
  # Индекс недоступен (сеть раннера/реестр) — предупреждение, чтобы проверка не
  # стала хрупкой; индекс доступен, а версии в нём нет — ошибка (артефакт не
  # доставлен).
  local version="$1" body http_code
  body="$(mktemp 2>/dev/null)" || body="$HELM_INSTALL_DIR/publish-index.yaml"
  log "проверяю synth-$version в $CHART_REGISTRY_INDEX_URL"
  http_code=$(curl -sS -o "$body" -w '%{http_code}' \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    "$CHART_REGISTRY_INDEX_URL") || http_code="000"
  case "$http_code" in
    2*)
      # Ответ должен быть действительно индексом helm (а не HTML-страницей
      # прокси/ошибки): иначе сверка бессмысленна — предупреждаем, не падаем.
      if ! grep -q '^entries:' "$body"; then
        warn "ответ $CHART_REGISTRY_INDEX_URL не похож на index.yaml — наличие synth-$version не проверено"
        rm -f "$body"
        return 0
      fi
      # Строка индекса вида `    version: 0.13.10`; сравнение — литеральное.
      if awk -v v="$version" '
        { line = $0; sub(/^[[:space:]]*version:[[:space:]]*/, "", line);
          gsub(/["\047[:space:]]/, "", line); if (line == v) found = 1 }
        END { exit(found ? 0 : 1) }' "$body"; then
        log "версия synth-$version подтверждена индексом реестра"
        rm -f "$body"
        return 0
      fi
      err "чарта synth-$version нет в index.yaml реестра ($CHART_REGISTRY_INDEX_URL) — публикация не подтверждена"
      rm -f "$body"
      exit 1
      ;;
    *)
      warn "index.yaml реестра недоступен (HTTP $http_code) — наличие synth-$version не проверено"
      rm -f "$body"
      return 0
      ;;
  esac
}

cmd_publish() {
  local chart="${1:-$CHART_DIR_DEFAULT}" version="${2:?укажите версию}"
  if [ -z "${CHART_REGISTRY_TOKEN:-}" ]; then
    soft_skip_or_fail "не задан GITEA_TOKEN (секрет GT_TOKEN) — публикация чарта невозможна"
  fi
  resolve_helm || soft_skip_or_fail "helm недоступен — публикация чарта не выполнена" 1

  run_helm "lint $chart" lint "$chart"
  mkdir -p dist/helm
  run_helm "package $chart" package "$chart" \
    --version "$version" --app-version "$version" --destination dist/helm
  local tgz="dist/helm/synth-$version.tgz"
  if [ ! -f "$tgz" ]; then
    soft_skip_or_fail "упакованный чарт $tgz не найден"
  fi

  local response http_code
  response=$(mktemp 2>/dev/null) || response="$HELM_INSTALL_DIR/publish-response.txt"
  log "публикую $tgz → $CHART_REGISTRY_URL (пользователь $CHART_REGISTRY_USER)"
  # Content-Type как в документации Gitea: тело запроса — сам .tgz (не multipart),
  # Basic-авторизация `itphx:<token>`.
  http_code=$(curl -sS -o "$response" -w '%{http_code}' \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    --user "$CHART_REGISTRY_USER:$CHART_REGISTRY_TOKEN" \
    -H "Content-Type: application/x-tar" \
    -X POST --upload-file "$tgz" "$CHART_REGISTRY_URL") || http_code="000"
  case "$http_code" in
    2*)
      log "чарт опубликован: synth-$version (HTTP $http_code)"
      rm -f "$response"
      verify_chart_in_index "$version"
      exit 0
      ;;
    *)
      head -c 500 "$response" >&2 2>/dev/null
      echo >&2
      rm -f "$response"
      # Отказ реестра — ЖЁСТКАЯ ошибка, независимо от CI_HELM_SOFT: чарт —
      # поставляемый артефакт, молчаливый пропуск недопустим (зелёная джоба без
      # чарта в реестре — ложный сигнал: разворачивать нечего).
      err "публикация чарта в реестр не удалась (HTTP $http_code): $CHART_REGISTRY_URL"
      exit 1
      ;;
  esac
}

# --- Диспетчер --------------------------------------------------------------

COMMAND="${1:-}"
shift 2>/dev/null || true

case "$COMMAND" in
  sources | diagnose) cmd_sources "$@" ;;
  install) cmd_install "$@" ;;
  lint) cmd_lint "$@" ;;
  template) cmd_template "$@" ;;
  package) cmd_package "$@" ;;
  publish) cmd_publish "$@" ;;
  '' | -h | --help | help) usage; exit 0 ;;
  *)
    err "неизвестная команда: $COMMAND"
    usage
    exit 2
    ;;
esac
