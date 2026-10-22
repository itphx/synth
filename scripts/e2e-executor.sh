#!/usr/bin/env bash
#
# e2e-executor.sh — реальный сквозной тест «control plane ↔ исполнитель»
# (ADR-077, шаг 6; PROP-082, шаг 6).
#
# Тест НЕ мок: поднимаются настоящие процессы в настоящих контейнерах, обмен —
# по HTTP (протокол исполнителя), команды исполняются реальным `sh`.
#
# Что проверяется:
#
#   1. **Старт control plane в remote-режиме.** Backend поднимается с
#      `SYNTH_EXECUTION_MODE=remote`, `SYNTH_EXECUTION_REMOTE_URL` и
#      `SYNTH_EXECUTION_TOKEN=<путь к файлу>`. Порт исполнения и детект
#      зависимостей окружения создаются на старте — если пакет исполнителя или
#      токен недоступны, процесс обязан упасть (fail-closed). Здесь мы проверяем
#      ОБРАТНОЕ: с живым исполнителем backend поднимается и отвечает 200 на
#      `/health`.
#   2. **Маршрутизация.** Команда, отправленная портом исполнения control plane,
#      исполняется В ИСПОЛНИТЕЛЕ: доказываем hostname'ом контейнера
#      исполнителя и маркером env, который есть только у исполнителя. Если
#      команда выполнилась бы локально (в control plane), маркер был бы пустым,
#      а hostname — другим.
#   3. **Fail-closed при недоступном исполнителе.** Исполнитель остановлен →
#      команда НЕ выполняется нигде: вызов падает с `EUNREACHABLE`, а файл-
#      маркер, который создала бы локальная команда, в control plane не
#      появляется. Это ключевая гарантия режима (никакого «тихого» возврата к
#      локальному исполнению).
#   4. **Токен на уровне протокола.** Исполнитель без корректного
#      `Authorization: Bearer …` отвечает 401 (и на `/capabilities`, и на
#      `/exec`).
#   5. **Состав toolchain'а исполнителя** — из `/capabilities` (ADR-078).
#
# Примеры:
#   ./scripts/e2e-executor.sh                       # собрать образы и прогнать
#   ./scripts/e2e-executor.sh --no-build            # только прогон (образы есть)
#   ./scripts/e2e-executor.sh --keep --verbose      # оставить контейнеры
#
# Код возврата: 0 — все проверки прошли; 1 — есть провалы; 2 — ошибка
# использования/окружения.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG=""
BACKEND_IMAGE=""
EXECUTOR_IMAGE=""
KEEP=0
VERBOSE=0
DO_BUILD=1

EXEC_NAME="synth-e2e-executor"
BACK_NAME="synth-e2e-backend"
NET_NAME="synth-e2e-net"

log()  { printf '[e2e] %s\n' "$*"; }
loge() { printf '[e2e] %s\n' "$*" >&2; }
warn() { printf '[e2e] ПРЕДУПРЕЖДЕНИЕ: %s\n' "$*" >&2; }
die()  { printf '[e2e] ОШИБКА: %s\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,/^# Требования/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Флаги:
  --tag <version>        Версия для локальных образов (по умолчанию — из packages/synth/package.json).
  --backend-image <ref>  Образ control plane (по умолчанию: synth-backend:e2e-<tag>).
  --executor-image <ref> Образ исполнителя (по умолчанию: synth-executor:e2e-<tag>).
  --no-build             Не собирать образы локально (взять из --backend-image/--executor-image).
  --keep                 Оставить контейнеры/сеть/временные файлы.
  --verbose              Подробный вывод.
  -h, --help             Эта справка.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)            TAG="${2:-}"; shift 2 ;;
    --backend-image)  BACKEND_IMAGE="${2:-}"; shift 2 ;;
    --executor-image) EXECUTOR_IMAGE="${2:-}"; shift 2 ;;
    --no-build)       DO_BUILD=0; shift ;;
    --keep)           KEEP=1; shift ;;
    --verbose)        VERBOSE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker не найден"
command -v curl >/dev/null 2>&1 || die "curl не найден"

if [[ -z "$TAG" ]]; then
  TAG=$(node -p "require('$REPO_ROOT/packages/synth/package.json').version" 2>/dev/null || echo "")
  [[ -n "$TAG" ]] || die "не задана версия: укажите --tag"
fi
[[ -n "$BACKEND_IMAGE" ]]  || BACKEND_IMAGE="synth-backend:e2e-$TAG"
[[ -n "$EXECUTOR_IMAGE" ]] || EXECUTOR_IMAGE="synth-executor:e2e-$TAG"

# Временный каталог — в /tmp/opencode (рекомендованный контур), при его
# отсутствии — обычный TMPDIR.
if [[ -d /tmp/opencode ]]; then
  WORK_DIR="$(mktemp -d /tmp/opencode/synth-e2e-XXXXXX)"
else
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synth-e2e-XXXXXX")"
fi
TOKEN_FILE="$WORK_DIR/token"
WORKSPACE_DIR="$WORK_DIR/workspace"
mkdir -p "$WORKSPACE_DIR"

PASSED=0
FAILED=0
FAILED_NAMES=()

cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    log "--keep: контейнеры и файлы оставлены ($WORK_DIR)"
    return 0
  fi
  docker rm -f "$EXEC_NAME" >/dev/null 2>&1 || true
  docker rm -f "$BACK_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
  # Файлы в каталоге данных/workspace принадлежат root (контейнеры работают от
  # root) — удалить их с хоста нельзя. Чистим контейнером с тем же образом.
  if [[ -d "$WORK_DIR" ]]; then
    docker run --rm -v "$WORK_DIR:/cleanup" --entrypoint /bin/sh "$EXECUTOR_IMAGE" \
      -c 'rm -rf /cleanup/data /cleanup/workspace /cleanup/token 2>/dev/null; true' >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

check_ok()   { PASSED=$((PASSED + 1)); printf '  ✓ %s\n' "$1"; }
check_fail() { FAILED=$((FAILED + 1)); FAILED_NAMES+=("$1"); printf '  ✗ %s — %s\n' "$1" "${2:-}"; }

dump_logs() {
  local name="$1"
  [[ "$VERBOSE" == "1" ]] || return 0
  log "логи контейнера $name:"
  docker logs "$name" 2>&1 | tail -n 40 | sed 's/^/    | /'
}

# --- сборка образов ----------------------------------------------------------

build_image() {
  local dockerfile="$1" target="$2" tag="$3"
  [[ -f "$dockerfile" ]] || die "Dockerfile не найден: $dockerfile"
  log "сборка $tag (--target $target)…"
  docker build --file "$dockerfile" --target "$target" --tag "$tag" "$REPO_ROOT" >/dev/null \
    || die "сборка не удалась: $tag"
}

if [[ "$DO_BUILD" == "1" ]]; then
  if ! docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1; then
    build_image "$REPO_ROOT/docker/Dockerfile.backend" slim "$BACKEND_IMAGE"
  else
    log "образ control plane уже собран: $BACKEND_IMAGE"
  fi
  if ! docker image inspect "$EXECUTOR_IMAGE" >/dev/null 2>&1; then
    build_image "$REPO_ROOT/docker/Dockerfile.executor" core "$EXECUTOR_IMAGE"
  else
    log "образ исполнителя уже собран: $EXECUTOR_IMAGE"
  fi
fi

docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1 || die "нет образа control plane: $BACKEND_IMAGE"
docker image inspect "$EXECUTOR_IMAGE" >/dev/null 2>&1 || die "нет образа исполнителя: $EXECUTOR_IMAGE"

# --- токен и сеть ------------------------------------------------------------

TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

# Маркер, который есть ТОЛЬКО в окружении исполнителя: если команда выполнится
# локально (в control plane), маркер окажется пустым.
HOST_MARKER="executor-$(head -c 8 /dev/urandom | base64 | tr -d '\n')"

docker rm -f "$EXEC_NAME" "$BACK_NAME" >/dev/null 2>&1 || true
docker network rm "$NET_NAME" >/dev/null 2>&1 || true
docker network create "$NET_NAME" >/dev/null || die "не удалось создать docker-сеть $NET_NAME"

EXEC_PORT="$(docker run -d --name "$EXEC_NAME" --network "$NET_NAME" --network-alias "$EXEC_NAME" \
  -e SYNTH_EXECUTOR_TOKEN="$TOKEN" \
  -e SYNTH_EXECUTOR_WORKSPACE=/var/synth/data/workspaces \
  -e SYNTH_EXECUTOR_HOST=0.0.0.0 \
  -e SYNTH_EXECUTOR_PORT=5100 \
  -e SYNTH_E2E_HOST_MARKER="$HOST_MARKER" \
  -v "$WORKSPACE_DIR:/var/synth/data/workspaces" \
  -p 127.0.0.1::5100 \
  "$EXECUTOR_IMAGE" >/dev/null && docker port "$EXEC_NAME" 5100/tcp | head -n 1 | sed 's/.*://')"

[[ -n "$EXEC_PORT" ]] || { dump_logs "$EXEC_NAME"; die "не удалось определить порт исполнителя"; }
EXEC_URL="http://127.0.0.1:$EXEC_PORT"
log "исполнитель: $EXECUTOR_IMAGE (контейнер $EXEC_NAME, порт $EXEC_PORT)"

# --- 1. исполнитель жив ------------------------------------------------------

log "ждём готовности исполнителя…"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 "$EXEC_URL/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [[ "$READY" == "1" ]]; then
  check_ok "исполнитель отвечает на /health"
else
  dump_logs "$EXEC_NAME"
  check_fail "исполнитель отвечает на /health" "контейнер не поднялся за 60 c"
fi

# --- 2. протокол: токен -------------------------------------------------------

CODE_NO_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$EXEC_URL/capabilities")"
if [[ "$CODE_NO_TOKEN" == "401" ]]; then
  check_ok "/capabilities без токена → 401"
else
  check_fail "/capabilities без токена → 401" "получено $CODE_NO_TOKEN"
fi

CODE_BAD_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "Authorization: Bearer wrong-token" "$EXEC_URL/capabilities")"
if [[ "$CODE_BAD_TOKEN" == "401" ]]; then
  check_ok "/capabilities с неверным токеном → 401"
else
  check_fail "/capabilities с неверным токеном → 401" "получено $CODE_BAD_TOKEN"
fi

CODE_EXEC_NO_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -X POST -H 'content-type: application/json' \
  -d '{"command":{"kind":"shell","command":"echo x"}}' "$EXEC_URL/exec")"
if [[ "$CODE_EXEC_NO_TOKEN" == "401" ]]; then
  check_ok "/exec без токена → 401"
else
  check_fail "/exec без токена → 401" "получено $CODE_EXEC_NO_TOKEN"
fi

CAPS="$(curl -fsS --max-time 5 -H "Authorization: Bearer $TOKEN" "$EXEC_URL/capabilities" 2>/dev/null || echo '')"
if grep -q '"protocol"' <<< "$CAPS"; then
  PROTO="$(printf '%s' "$CAPS" | sed -n 's/.*"protocol":\(["]\?\)\([0-9][0-9.]*\)\1.*/\2/p')"
  check_ok "/capabilities с токеном → 200 (протокол ${PROTO:-?})"
else
  check_fail "/capabilities с токеном → 200" "ответ: ${CAPS:0:120}"
fi

if grep -q '"toolchain"' <<< "$CAPS"; then
  check_ok "/capabilities содержит состав toolchain'а"
else
  check_fail "/capabilities содержит состав toolchain'а" "ответ: ${CAPS:0:120}"
fi

# hard deps есть в ЛЮБОМ flavor'е с toolchain'ом (PROP-082) — исполнитель
# обязан их видеть (иначе часть тулов агента в split-режиме не работает).
TC_MISSING=""
for bin in git rg python3; do
  grep -q "\"$bin\":" <<< "$CAPS" || TC_MISSING="$TC_MISSING $bin"
done
if [[ -z "$TC_MISSING" ]]; then
  check_ok "состав toolchain'а исполнителя: git, rg, python3"
else
  check_fail "состав toolchain'а исполнителя: git, rg, python3" "не найдены:$TC_MISSING"
fi

# --- 3. control plane в remote-режиме ----------------------------------------

API_KEY="e2e-$(head -c 8 /dev/urandom | base64 | tr -d '\n')"

docker run -d --name "$BACK_NAME" --network "$NET_NAME" \
  -e SYNTH_API_KEY="$API_KEY" \
  -e SYNTH_PORT=5000 \
  -e SYNTH_DATA_DIR=/var/synth/data \
  -e SYNTH_EXECUTION_MODE=remote \
  -e SYNTH_EXECUTION_REMOTE_URL="http://$EXEC_NAME:5100" \
  -e SYNTH_EXECUTION_TOKEN=/etc/synth/executor/token \
  -e SYNTH_EXECUTION_FAIL_MODE=fail \
  -v "$WORK_DIR/data:/var/synth/data" \
  -v "$WORKSPACE_DIR:/var/synth/data/workspaces" \
  -v "$TOKEN_FILE:/etc/synth/executor/token:ro" \
  "$BACKEND_IMAGE" >/dev/null || { dump_logs "$BACK_NAME"; die "не удалось запустить control plane"; }

log "ждём готовности control plane (remote-режим)…"
BACK_READY=0
for _ in $(seq 1 90); do
  STATE="$(docker inspect -f '{{.State.Status}}' "$BACK_NAME" 2>/dev/null || echo missing)"
  if [[ "$STATE" == "exited" || "$STATE" == "dead" ]]; then
    break
  fi
  if docker exec "$BACK_NAME" node -e "fetch('http://127.0.0.1:5000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    BACK_READY=1
    break
  fi
  sleep 1
done

if [[ "$BACK_READY" == "1" ]]; then
  check_ok "control plane поднялся в remote-режиме (/health → 200)"
else
  dump_logs "$BACK_NAME"
  check_fail "control plane поднялся в remote-режиме (/health → 200)" "процесс не отвечает (см. логи выше)"
fi

# --- 4. маршрутизация: команда уходит в исполнитель --------------------------

EXEC_HOST_SHORT="$(docker inspect -f '{{.Id}}' "$EXEC_NAME" 2>/dev/null | cut -c1-12)"
BACK_HOST_SHORT="$(docker inspect -f '{{.Id}}' "$BACK_NAME" 2>/dev/null | cut -c1-12)"

# Драйвер выполняется ВНУТРИ control plane и использует его собственный
# резолвер конфигурации и фабрику порта исполнения — тот же код, что и в
# packages/backend/src/app/deps.ts.
DRIVER_OUT="$(docker exec -i -w /app "$BACK_NAME" node --input-type=module - 2>&1 <<'DRIVER'
import { resolveExecutionConfig } from '@itphx/synth-shared';
import { createExecutionPortForConfig } from '@itphx/synth-core';

const cfg = resolveExecutionConfig({}, process.env);
const port = await createExecutionPortForConfig(cfg);
try {
  const res = await port.execute({
    command: { kind: 'shell', command: 'printf "%s|%s" "$(hostname)" "$SYNTH_E2E_HOST_MARKER"' },
  });
  console.log(JSON.stringify({ ok: true, stdout: res.stdout, exitCode: res.exitCode }));
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    code: err && err.code ? String(err.code) : null,
    message: err && err.message ? String(err.message) : String(err),
  }));
}
DRIVER
)"

if [[ "$VERBOSE" == "1" ]]; then
  log "ответ драйвера: $DRIVER_OUT"
fi

EXEC_HOSTNAME="$(printf '%s' "$DRIVER_OUT" | sed -n 's/.*"stdout":"\([^|]*\)|.*/\1/p')"
OUT_MARKER="$(printf '%s' "$DRIVER_OUT" | sed -n 's/.*"stdout":"[^|]*|\([^"]*\)".*/\1/p')"

if grep -q '"ok":true' <<< "$DRIVER_OUT"; then
  check_ok "команда через порт исполнения отработала (ответ получен)"
else
  check_fail "команда через порт исполнения отработала" "ответ: ${DRIVER_OUT:0:200}"
fi

if [[ -n "$EXEC_HOSTNAME" && "$EXEC_HOSTNAME" == "$EXEC_HOST_SHORT"* ]]; then
  check_ok "команда выполнена В исполнителе (hostname $EXEC_HOSTNAME = контейнер $EXEC_NAME)"
else
  check_fail "команда выполнена В исполнителе" "hostname из ответа: '${EXEC_HOSTNAME}' (ожидался ${EXEC_HOST_SHORT}*)"
fi

if [[ "$OUT_MARKER" == "$HOST_MARKER" ]]; then
  check_ok "окружение исполнителя (env-маркер) подтверждено"
else
  check_fail "окружение исполнителя (env-маркер) подтверждено" "маркер: '${OUT_MARKER}' (ожидался '${HOST_MARKER}')"
fi

if [[ -n "$BACK_HOST_SHORT" && "$EXEC_HOST_SHORT" != "$BACK_HOST_SHORT" ]]; then
  check_ok "control plane и исполнитель — разные процессы ($BACK_HOST_SHORT ≠ $EXEC_HOST_SHORT)"
else
  check_fail "control plane и исполнитель — разные процессы" "оба: $BACK_HOST_SHORT"
fi

# --- 5. fail-closed: исполнитель недоступен -----------------------------------

log "останавливаем исполнителя (проверка fail-closed)…"
docker stop "$EXEC_NAME" >/dev/null 2>&1 || true

# Команда, которая создала бы файл — ЛОКАЛЬНО в control plane, если бы
# сработал inline-fallback. В исполнителе она выполниться уже не может.
LOCAL_MARKER="/tmp/synth-e2e-local-exec-marker"
docker exec "$BACK_NAME" rm -f "$LOCAL_MARKER" >/dev/null 2>&1 || true

FAIL_OUT="$(docker exec -i -w /app "$BACK_NAME" node --input-type=module - 2>&1 <<DRIVER
import { resolveExecutionConfig } from '@itphx/synth-shared';
import { createExecutionPortForConfig } from '@itphx/synth-core';

const cfg = resolveExecutionConfig({}, process.env);
const port = await createExecutionPortForConfig(cfg);
try {
  const res = await port.execute({
    command: { kind: 'shell', command: 'echo local-exec > ${LOCAL_MARKER}; printf "%s" "\$(hostname)"' },
  });
  console.log(JSON.stringify({ ok: true, stdout: res.stdout, exitCode: res.exitCode }));
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    code: err && err.code ? String(err.code) : null,
    message: err && err.message ? String(err.message) : String(err),
  }));
}
DRIVER
)"

if [[ "$VERBOSE" == "1" ]]; then
  log "ответ драйвера (fail-closed): $FAIL_OUT"
fi

if grep -q '"ok":false' <<< "$FAIL_OUT"; then
  check_ok "при недоступном исполнителе команда НЕ выполнена (вызов завершился ошибкой)"
else
  check_fail "при недоступном исполнителе команда НЕ выполнена" "ответ: ${FAIL_OUT:0:200}"
fi

if grep -q 'EUNREACHABLE' <<< "$FAIL_OUT"; then
  check_ok "код ошибки EUNREACHABLE (failMode=fail, без inline-fallback)"
else
  check_fail "код ошибки EUNREACHABLE" "ответ: ${FAIL_OUT:0:200}"
fi

if docker exec "$BACK_NAME" test -f "$LOCAL_MARKER" >/dev/null 2>&1; then
  check_fail "локального исполнения не было (файл-маркер в control plane)" "файл $LOCAL_MARKER создан — команда выполнилась локально!"
else
  check_ok "локального исполнения не было (файл-маркер в control plane не создан)"
fi

# --- итог ---------------------------------------------------------------------

echo
log "проверок пройдено: $PASSED, провалено: $FAILED"
if [[ "$FAILED" -gt 0 ]]; then
  loge "НЕ ПРОЙДЕНО: ${FAILED_NAMES[*]}"
  exit 1
fi
log "OK: control plane ↔ исполнитель — сквозной тест пройден"
exit 0
