#!/usr/bin/env bash
#
# smoke-image.sh — smoke-проверка flavor-образа Synth (PROP-082, шаг 6).
#
# Запускает контейнер из образа и проверяет, что в нём есть и РАБОТАЕТ
# инструментарий, положенный в этот flavor' (состав — PROP-082, «Флавор-матрица»
# и «Тиры инструментов»). Проверки составные, а не «бинарник существует»:
# версии печатаются, venv создаётся, MCP-сервер отвечает по stdio, Chromium
# реально стартует headless.
#
# Flavor'ы:
#
#   core    — hard deps + tier 0 (control plane + toolchain); **без** pnpm/corepack,
#             без ffmpeg, без helm/shellcheck/hadolint
#   dev     — core + tier 1 + tier 4 (MCP) + БД-клиенты + buildah + tier 5
#             (helm/shellcheck/hadolint/yamllint) + media (ffmpeg) + pnpm/corepack
#   devops  — dev + tier 2 (kubectl/kustomize/tofu/ansible) + диаг + docker CLI
#   browser — hard deps + tier 0/1 + tier 3 (Playwright + Chromium) + диаг + media
#             (ffmpeg); **без** pnpm
#   full    — всё вышеперечисленное (+ pnpm/corepack, tier 5, media)
#   slim    — control plane БЕЗ toolchain'а: **негативная** проверка (бинарников
#             toolchain'а в нём быть не должно)
#
# Примеры:
#   ./scripts/smoke-image.sh --image synth-backend:core-check
#   ./scripts/smoke-image.sh --image git.itphx.ru/itphx/synth-backend:0.11.4-dev --flavor dev
#   ./scripts/smoke-image.sh --image synth-executor:e2e-local-core --flavor core --verbose
#
# Код возврата: 0 — все проверки прошли; 1 — есть провалившиеся; 2 — ошибка
# использования (неизвестный flavor, нет образа, нет docker).

set -uo pipefail

IMAGE=""
FLAVOR=""
VERBOSE=0
TIMEOUT="${SYNTH_SMOKE_TIMEOUT:-300}"

log()  { printf '[smoke-image] %s\n' "$*"; }
loge() { printf '[smoke-image] %s\n' "$*" >&2; }
die()  { printf '[smoke-image] ОШИБКА: %s\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,/^# Требования/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Флаги:
  --image <ref>      Образ для проверки (обязателен).
  --flavor <flavor>  core | dev | devops | browser | full | slim (по умолчанию — из тега).
  --timeout <sec>    Таймаут прогона контейнера, с (по умолчанию: 300).
  --verbose          Показать вывод контейнера.
  -h, --help         Эта справка.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)   IMAGE="${2:-}"; shift 2 ;;
    --flavor)  FLAVOR="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

[[ -n "$IMAGE" ]] || die "не задан --image"

command -v docker >/dev/null 2>&1 || die "docker не найден"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  die "образ '$IMAGE' не найден локально (соберите его заранее)"
fi

# --- flavor по тегу ----------------------------------------------------------

if [[ -z "$FLAVOR" ]]; then
  TAG="${IMAGE##*:}"
  # Flavor ищем по СЕГМЕНТАМ тега: `0.11.4-core` → core, `core-check` → core,
  # `devops-check` → devops (не dev). Если ни одного сегмента-flavor'а нет и
  # образ — synth-backend, то это slim (control plane без toolchain'а).
  FLAVOR=""
  IFS='-' read -r -a TAG_PARTS <<< "$TAG"
  for part in "${TAG_PARTS[@]}"; do
    case "$part" in
      core|dev|devops|browser|full|slim) FLAVOR="$part"; break ;;
    esac
  done
  if [[ -z "$FLAVOR" ]]; then
    if [[ "$IMAGE" == *synth-backend* ]]; then
      FLAVOR="slim"
    else
      die "не удалось определить flavor по тегу '$TAG' — укажите --flavor"
    fi
  fi
fi

case "$FLAVOR" in
  core|dev|devops|browser|full|slim) ;;
  *) die "неизвестный flavor: $FLAVOR (core | dev | devops | browser | full | slim)" ;;
esac

log "образ: $IMAGE"
log "flavor: $FLAVOR"

# --- проверочный сценарий (POSIX sh, выполняется внутри контейнера) ---------

CHECK_FILE="$(mktemp)"
trap 'rm -f "$CHECK_FILE"' EXIT

cat > "$CHECK_FILE" <<'CHECK_EOF'
# Проверочный сценарий smoke-теста (внутри контейнера). POSIX sh.
# Каждая проверка печатает строку CHECK|<имя>|ok|fail|<детали>.
set -u

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout 60"
else
  TIMEOUT_BIN=""
fi

detail() {
  printf '%s' "$1" | tr '\n' ' ' | cut -c1-200
}

# run_cmd <имя> <команда...> — команда должна завершиться кодом 0.
run_cmd() {
  name="$1"; shift
  out=$($TIMEOUT_BIN "$@" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'CHECK|%s|ok|%s\n' "$name" "$(detail "$(printf '%s' "$out" | head -n 1)")"
  else
    printf 'CHECK|%s|fail|rc=%s %s\n' "$name" "$rc" "$(detail "$out")"
  fi
}

# run_cmd_eq <имя> <ожидаемое значение> <команда...> — команда должна завершиться
# кодом 0 И в её выводе должна быть **строка** с ожидаемым значением (сравнение
# точное; лишние строки вокруг — допустимы).
run_cmd_eq() {
  name="$1"; expected="$2"; shift 2
  out=$($TIMEOUT_BIN "$@" 2>&1)
  rc=$?
  actual=$(printf '%s' "$out" | tr -d '\015' | grep -Fx "$expected" | head -n 1)
  if [ "$rc" -eq 0 ] && [ -n "$actual" ]; then
    printf 'CHECK|%s|ok|%s\n' "$name" "$actual"
  else
    printf 'CHECK|%s|fail|ожидалось %s, получено %s (rc=%s)\n' "$name" "$expected" "$(detail "$(printf '%s' "$out" | head -n 1)")" "$rc"
  fi
}

# run_cmd_min_major <имя> <мин. мажор> <команда...> — мажорная версия в выводе
# команды (vNN.NN.NN) не меньше указанной.
run_cmd_min_major() {
  name="$1"; min="$2"; shift 2
  out=$($TIMEOUT_BIN "$@" 2>&1)
  rc=$?
  actual=$(printf '%s' "$out" | head -n 1 | tr -d '\015')
  major=$(printf '%s' "$actual" | sed 's/^[^0-9]*//' | cut -d. -f1)
  case "$major" in
    ''|*[!0-9]*)
      printf 'CHECK|%s|fail|не разобрана версия: %s (rc=%s)\n' "$name" "$(detail "$actual")" "$rc"
      return
      ;;
  esac
  if [ "$rc" -eq 0 ] && [ "$major" -ge "$min" ]; then
    printf 'CHECK|%s|ok|%s\n' "$name" "$actual"
  else
    printf 'CHECK|%s|fail|ожидалась версия >= %s, получено %s (rc=%s)\n' "$name" "$min" "$(detail "$actual")" "$rc"
  fi
}

# run_sh <имя> <shell-скрипт> — скрипт должен завершиться кодом 0.
run_sh() {
  name="$1"; script="$2"
  out=$($TIMEOUT_BIN sh -c "$script" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'CHECK|%s|ok|%s\n' "$name" "$(detail "$(printf '%s' "$out" | head -n 1)")"
  else
    printf 'CHECK|%s|fail|rc=%s %s\n' "$name" "$rc" "$(detail "$out")"
  fi
}

# has_bin <имя> <бинарник> — бинарник обязан быть в PATH.
has_bin() {
  name="$1"; bin="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    printf 'CHECK|%s|ok|%s\n' "$name" "$(command -v "$bin")"
  else
    printf 'CHECK|%s|fail|бинарник %s не найден в PATH\n' "$name" "$bin"
  fi
}

# no_bin <имя> <бинарник> — бинарника быть НЕ должно (негативная проверка).
no_bin() {
  name="$1"; bin="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    printf 'CHECK|%s|fail|бинарник %s найден (%s), а его быть не должно\n' "$name" "$bin" "$(command -v "$bin")"
  else
    printf 'CHECK|%s|ok|отсутствует, как и задумано\n' "$name"
  fi
}

# no_corepack_pnpm <имя> — corepack-шим pnpm работать НЕ должен: ни `pnpm` в PATH,
# ни `corepack pnpm` (шим corepack подставляет бинарь pnpm сам). Сеть у corepack
# отключена (`COREPACK_ENABLE_NETWORK=0`): проверка не тянет pnpm из интернета —
# уже скачанный бинарь corepack отдаёт, нескачанный — нет.
no_corepack_pnpm() {
  name="$1"
  if command -v pnpm >/dev/null 2>&1; then
    printf 'CHECK|%s|fail|бинарник pnpm найден (%s), а его быть не должно\n' "$name" "$(command -v pnpm)"
    return
  fi
  if command -v corepack >/dev/null 2>&1 && COREPACK_ENABLE_NETWORK=0 corepack pnpm --version >/dev/null 2>&1; then
    printf 'CHECK|%s|fail|corepack-шим pnpm отвечает, а его быть не должно\n' "$name"
    return
  fi
  printf 'CHECK|%s|ok|отсутствует, как и задумано\n' "$name"
}

# has_file <имя> <путь>
has_file() {
  name="$1"; path="$2"
  if [ -e "$path" ]; then
    printf 'CHECK|%s|ok|%s\n' "$name" "$path"
  else
    printf 'CHECK|%s|fail|нет файла %s\n' "$name" "$path"
  fi
}

# mcp_init <имя> <команда> [ПЕРЕМЕННАЯ=значение ...] — MCP-сервер отвечает на
# initialize по stdio. Некоторые серверы требуют env (например, токен GitLab
# или GITEA_TOKEN) — такие переменные передаются перед командой.
#
# Проверка честная: требуется реальный JSON-RPC-ответ с "result". Молчаливый
# выход процесса (код 0 без ответа) считается провалом.
mcp_init() {
  name="$1"; shift
  cmd=""
  envs=""
  for arg in "$@"; do
    case "$arg" in
      *=*) envs="$envs $arg" ;;
      *)   cmd="$arg" ;;
    esac
  done
  req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
  out=$(printf '%s\n' "$req" | $TIMEOUT_BIN env $envs "$cmd" 2>/dev/null | head -c 400)
  case "$out" in
    *'"result"'*) printf 'CHECK|%s|ok|%s\n' "$name" "$(detail "$(printf '%s' "$out" | head -c 120)")" ;;
    *) printf 'CHECK|%s|fail|нет ответа initialize по stdio: %s\n' "$name" "$(detail "$out")" ;;
  esac
}
CHECK_EOF

# --- проверки по flavor'ам ---------------------------------------------------

# hard deps + tier 0 — ядро любого flavor'а с toolchain'ом.
if [[ "$FLAVOR" != "slim" ]]; then
  cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- hard deps (PROP-082, «Общий состав») ---
has_bin hard-deps/git git
run_cmd hard-deps/git-version git --version
has_bin hard-deps/ripgrep rg
run_cmd hard-deps/ripgrep-version rg --version
has_bin hard-deps/python3 python3
run_cmd hard-deps/python3-version python3 --version
run_cmd hard-deps/pip python3 -m pip --version
run_sh hard-deps/venv 'rm -rf /tmp/smoke-venv && python3 -m venv /tmp/smoke-venv && /tmp/smoke-venv/bin/python --version && rm -rf /tmp/smoke-venv'
has_bin hard-deps/openssh-client ssh
has_bin hard-deps/openssh-client-scp scp
has_bin hard-deps/openssh-client-sftp sftp
has_bin hard-deps/rsync rsync
has_file hard-deps/ca-certificates /etc/ssl/certs/ca-certificates.crt

# --- tier 0 ---
has_bin tier0/bash bash
run_cmd tier0/bash-version bash --version
has_bin tier0/jq jq
run_cmd tier0/jq-version jq --version
has_bin tier0/yq yq
run_cmd tier0/yq-version yq --version
has_bin tier0/curl curl
run_cmd tier0/curl-version curl --version
has_bin tier0/openssl openssl
has_bin tier0/tree tree
CHECK_EOF
fi

# --- рантайм node/npm (все flavor'ы, кроме slim) ------------------------------
if [[ "$FLAVOR" != "slim" ]]; then
  cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- рантайм node/npm ---
run_cmd_min_major runtime/node-version 22 node --version
run_cmd runtime/npm-version npm --version
CHECK_EOF
fi

# tier 1 + tier 4 + БД + buildah — flavor'ы dev/devops/full.
case "$FLAVOR" in
  dev|devops|full)
    cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- tier 1 (сборка) ---
has_bin tier1/make make
run_cmd tier1/make-version make --version
has_bin tier1/gcc gcc
run_cmd tier1/gcc-version gcc --version
has_bin tier1/g++ g++
has_bin tier1/rsync rsync
has_bin tier1/patch patch

# --- tier 4 (MCP-серверы): handshake по stdio ---
# У всех четырёх — реальный `initialize` с ответом (не «старт без падения»):
# `gitea-mcp` поднимает сервер только под guard'ом пакета
# `process.argv[1] === fileURLToPath(import.meta.url)`, поэтому проверка через
# npm-бин (симлинк) молча выходила с кодом 0 — такой случай считается провалом.
has_bin tier4/mcp-server-github mcp-server-github
mcp_init tier4/mcp-server-github-initialize mcp-server-github
has_bin tier4/mcp-server-gitlab mcp-server-gitlab
mcp_init tier4/mcp-server-gitlab-initialize mcp-server-gitlab GITLAB_PERSONAL_ACCESS_TOKEN=smoke-dummy-token
has_bin tier4/gitea-mcp gitea-mcp
mcp_init tier4/gitea-mcp-initialize gitea-mcp GITEA_TOKEN=smoke-dummy-token
has_bin tier4/gitverse-mcp gitverse-mcp
mcp_init tier4/gitverse-mcp-initialize gitverse-mcp

# --- клиенты БД ---
has_bin db/sqlite3 sqlite3
run_cmd db/sqlite3-version sqlite3 --version
has_bin db/psql psql
run_cmd db/psql-version psql --version
has_bin db/redis-cli redis-cli
has_bin db/mysql mysql

# --- buildah ---
has_bin buildah/buildah buildah
run_cmd buildah/version buildah --version
CHECK_EOF
    ;;
esac

# tier 2 + диаг + docker CLI — flavor'ы devops/full.
case "$FLAVOR" in
  devops|full)
    cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- tier 2 (инфраструктура): helm/shellcheck/hadolint/yamllint уехали в tier 5 ---
run_cmd tier2/kubectl kubectl version --client
run_cmd tier2/kustomize kustomize version
run_cmd tier2/tofu tofu version
has_bin tier2/terraform terraform
run_cmd tier2/ansible ansible --version

# --- диагностические утилиты ---
run_cmd diag/dig dig -v
has_bin diag/nc nc
has_bin diag/lsof lsof
has_bin diag/ss ss
has_bin diag/traceroute traceroute

# --- docker CLI (только клиент: демона в образе нет) ---
run_cmd docker/version docker --version
run_sh docker/no-daemon '! docker info >/dev/null 2>&1'
CHECK_EOF
    ;;
esac

# tier 5 (проверка репозитория) + pnpm/corepack — flavor'ы dev/devops/full.
# devops наследует dev, поэтому состав tier 5 и pnpm у него тот же.
case "$FLAVOR" in
  dev|devops|full)
    cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- tier 5 (проверка репозитория) ---
run_cmd tier5/helm helm version --short
run_cmd tier5/shellcheck shellcheck --version
run_cmd tier5/hadolint hadolint --version
run_cmd tier5/yamllint yamllint --version

# --- pnpm/corepack (сборка монорепо) ---
run_cmd_eq pnpm/version 12.14.0 pnpm --version
run_cmd pnpm/corepack-version corepack --version
run_cmd pnpm/store-path pnpm store path
CHECK_EOF
    ;;
esac

# git: безопасные каталоги и идентификация агента — стадии `dev` и `browser`
# и их наследники (`dev`, `devops`, `browser`, `full`).
case "$FLAVOR" in
  dev|devops|browser|full)
    cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- git: безопасные каталоги и идентификация агента ---
run_sh git/safe-directory-workspace 'git config --system --get-all safe.directory | grep -F "/var/synth/data/workspaces/*" >/dev/null'
run_sh git/user-email 'test -n "$(git config --system user.email)"'
CHECK_EOF
    ;;
esac

# media-тир (ffmpeg) — flavor'ы dev/devops/browser/full (devops наследует dev);
# в core ffmpeg нет.
case "$FLAVOR" in
  dev|devops|browser|full)
    cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- media (ffmpeg) ---
run_sh media/ffmpeg-version 'ffmpeg -version | head -n 1'
CHECK_EOF
    ;;
esac

# tier 3 (Playwright + Chromium) — flavor'ы browser/full.
case "$FLAVOR" in
  browser|full)
    cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- tier 3 (веб/браузер) ---
has_bin tier3/playwright playwright
run_cmd tier3/playwright-version playwright --version
has_bin tier3/xmllint xmllint
run_cmd tier3/xmllint-version xmllint --version
run_sh tier3/chromium-headless 'export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"; export NODE_PATH="$(npm root -g 2>/dev/null)"; node -e "
const { chromium } = require(\"playwright\");
(async () => {
  const browser = await chromium.launch({ args: [\"--no-sandbox\", \"--disable-dev-shm-usage\"] });
  const page = await browser.newPage();
  await page.setContent(\"<h1>smoke</h1>\");
  const text = await page.textContent(\"h1\");
  await browser.close();
  if (text !== \"smoke\") { console.error(\"неожиданный текст: \" + text); process.exit(2); }
  console.log(\"chromium headless OK\");
})().catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
"'
CHECK_EOF
    ;;
esac

# --- core: негативные проверки (лёгкий образ — без pnpm и без проверки репозитория)
if [[ "$FLAVOR" == "core" ]]; then
  cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- core: лёгкий образ — pnpm, ffmpeg и tier 5 в нём быть НЕ должно ---
no_bin core/no-pnpm pnpm
no_corepack_pnpm core/no-corepack-pnpm
no_bin core/no-ffmpeg ffmpeg
no_bin core/no-helm helm
no_bin core/no-shellcheck shellcheck
no_bin core/no-hadolint hadolint
CHECK_EOF
fi

# --- slim: негативная проверка (toolchain'а быть не должно) ------------------
if [[ "$FLAVOR" == "slim" ]]; then
  cat >> "$CHECK_FILE" <<'CHECK_EOF'

# --- slim: toolchain'а в образе быть НЕ должно ---
# ВНИМАНИЕ: busybox-апплеты базового образа (unzip/less/tree/nc/lsof/traceroute)
# в slim ЕСТЬ — это не toolchain, поэтому они в список не входят.
no_bin slim/no-git git
no_bin slim/no-rg rg
no_bin slim/no-python3 python3
no_bin slim/no-python python
no_bin slim/no-pip pip
no_bin slim/no-pip3 pip3
no_bin slim/no-jq jq
no_bin slim/no-yq yq
no_bin slim/no-bash bash
no_bin slim/no-curl curl
no_bin slim/no-xz xz
no_bin slim/no-zstd zstd
no_bin slim/no-openssl openssl
no_bin slim/no-make make
no_bin slim/no-gcc gcc
no_bin slim/no-g++ g++
no_bin slim/no-patch patch
no_bin slim/no-rsync rsync
no_bin slim/no-git-lfs git-lfs
no_bin slim/no-sqlite3 sqlite3
no_bin slim/no-psql psql
no_bin slim/no-redis-cli redis-cli
no_bin slim/no-mysql mysql
no_bin slim/no-buildah buildah
no_bin slim/no-crun crun
no_bin slim/no-docker docker
no_bin slim/no-kubectl kubectl
no_bin slim/no-helm helm
no_bin slim/no-kustomize kustomize
no_bin slim/no-tofu tofu
no_bin slim/no-terraform terraform
no_bin slim/no-ansible ansible
no_bin slim/no-shellcheck shellcheck
no_bin slim/no-yamllint yamllint
no_bin slim/no-hadolint hadolint
no_bin slim/no-dig dig
no_bin slim/no-ss ss
no_bin slim/no-mcp-github mcp-server-github
no_bin slim/no-mcp-gitlab mcp-server-gitlab
no_bin slim/no-gitea-mcp gitea-mcp
no_bin slim/no-gitverse-mcp gitverse-mcp
no_bin slim/no-playwright playwright
no_bin slim/no-xmllint xmllint
CHECK_EOF
fi

# --- прогон ------------------------------------------------------------------

log "прогон контейнера…"
if command -v timeout >/dev/null 2>&1; then
  OUTPUT="$(timeout "$TIMEOUT" docker run --rm -i --entrypoint /bin/sh "$IMAGE" -s < "$CHECK_FILE" 2>&1)"
else
  OUTPUT="$(docker run --rm -i --entrypoint /bin/sh "$IMAGE" -s < "$CHECK_FILE" 2>&1)"
fi
RC=$?

if [[ "$VERBOSE" == "1" ]]; then
  printf '%s\n' "$OUTPUT"
fi

TOTAL=0
FAILED=0
FAILED_NAMES=()

while IFS='|' read -r _ name status detail; do
  [[ "$name" == "CHECK" ]] && continue
  [[ -z "${name:-}" ]] && continue
  TOTAL=$((TOTAL + 1))
  if [[ "$status" == "ok" ]]; then
    printf '  ✓ %-42s %s\n' "$name" "$detail"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
    printf '  ✗ %-42s %s\n' "$name" "$detail"
  fi
done <<< "$OUTPUT"

if [[ "$RC" != "0" && "$TOTAL" == "0" ]]; then
  loge "контейнер завершился с кодом $RC и не выдал ни одной проверки"
  loge "вывод контейнера:"
  printf '%s\n' "$OUTPUT" >&2
  exit 1
fi

echo
log "проверок: $TOTAL, провалено: $FAILED"
if [[ "$FAILED" -gt 0 ]]; then
  loge "НЕ ПРОЙДЕНО: ${FAILED_NAMES[*]}"
  exit 1
fi
log "OK: $IMAGE (flavor $FLAVOR) — все проверки прошли"
exit 0
