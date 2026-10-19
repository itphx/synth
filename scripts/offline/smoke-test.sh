#!/usr/bin/env bash
#
# smoke-test.sh — проверка offline-бандла Synth без установки.
#
# Проверяет: SHA256SUMS (если архив), manifest.json, отсутствие симлинков,
# версии Node/rg/Synth, запуск `bin/synth serve` и ответы /health, /ready.
#
#   ./scripts/offline/smoke-test.sh --archive dist/offline/synth-0.11.1-linux-x64.tar.gz
#   ./scripts/offline/smoke-test.sh --dir /tmp/synth-0.11.1-linux-x64
#
set -euo pipefail

ARCHIVE=""
BUNDLE_DIR=""
PORT=4497
KEEP=0
WORK=""
SERVER_PID=""

info() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE=${2:?--archive требует путь}; shift 2 ;;
    --dir) BUNDLE_DIR=${2:?--dir требует путь}; shift 2 ;;
    --port) PORT=${2:?--port требует значение}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fail "неизвестная опция: $1" ;;
  esac
done

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" -eq 0 ] && [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  elif [ -n "$WORK" ]; then
    info "рабочий каталог сохранён: $WORK"
  fi
}
trap cleanup EXIT

[ -n "$ARCHIVE" ] || [ -n "$BUNDLE_DIR" ] || fail "укажите --archive <файл> или --dir <каталог>"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/synth-smoke.XXXXXX")

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || fail "архив не найден: $ARCHIVE"
  NAME=$(basename "$ARCHIVE")
  SUMS="$(dirname "$ARCHIVE")/SHA256SUMS"
  if [ -f "$SUMS" ]; then
    EXPECTED=$(awk -v n="$NAME" '$2 == n { print $1 }' "$SUMS")
    [ -n "$EXPECTED" ] || fail "в SHA256SUMS нет записи для $NAME"
    ACTUAL=$(sha256sum "$ARCHIVE" | awk '{ print $1 }')
    [ "$EXPECTED" = "$ACTUAL" ] || fail "SHA256 не совпал для $NAME (ожидался $EXPECTED, получен $ACTUAL)"
    info "SHA256 ok: $NAME"
  else
    info "SHA256SUMS рядом с архивом не найден — проверка хеша пропущена"
  fi

  case "$ARCHIVE" in
    *.zip) unzip -q "$ARCHIVE" -d "$WORK" ;;
    *.tar.gz|*.tgz) tar -xzf "$ARCHIVE" -C "$WORK" ;;
    *) fail "неизвестный формат архива: $ARCHIVE" ;;
  esac
  BUNDLE_DIR=$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)
  [ -n "$BUNDLE_DIR" ] || fail "в архиве нет корневого каталога"
fi

[ -d "$BUNDLE_DIR" ] || fail "каталог бандла не найден: $BUNDLE_DIR"
[ -f "$BUNDLE_DIR/manifest.json" ] || fail "нет manifest.json в $BUNDLE_DIR"
BUNDLE_DIR=$(cd "$BUNDLE_DIR" && pwd)

NODE="$BUNDLE_DIR/runtime/node/bin/node"
[ -x "$NODE" ] || fail "нет исполняемого runtime/node/bin/node"

info "== manifest"
eval "$("$NODE" -e '
const m = require(process.argv[1]);
process.stdout.write(
  `SV=${JSON.stringify(m.synthVersion)}; NV=${JSON.stringify(m.nodeVersion)}; RV=${JSON.stringify(m.ripgrepVersion)}; PL=${JSON.stringify(m.platform + "/" + m.arch)}\n`
);
' "$BUNDLE_DIR/manifest.json")"
info "  synth $SV, node $NV, rg $RV, $PL"

info "== симлинки"
LINKS=$(find "$BUNDLE_DIR" -type l | wc -l | tr -d ' ')
[ "$LINKS" = "0" ] || fail "в бандле $LINKS симлинк(ов): $(find "$BUNDLE_DIR" -type l | head -5 | tr '\n' ' ')"
info "  нет"

info "== версии бинарников"
NODE_V=$("$NODE" --version | tr -d 'v')
[ "$NODE_V" = "$NV" ] || fail "Node: ожидался $NV, получен $NODE_V"
info "  node $NODE_V"
RG_V=$("$BUNDLE_DIR/tools/rg" --version | head -1)
case "$RG_V" in
  *"$RV"*) info "  $RG_V" ;;
  *) fail "ripgrep: ожидался $RV, получен: $RG_V" ;;
esac
"$BUNDLE_DIR/tools/rg" --version >/dev/null || fail "tools/rg не запускается"

SYNTH_V=$("$BUNDLE_DIR/bin/synth" --version | tail -1)
[ "$SYNTH_V" = "$SV" ] || fail "synth --version: ожидался $SV, получен $SYNTH_V"
info "  synth $SYNTH_V"

info "== запуск serve (порт $PORT)"
HOME_DIR="$WORK/home"
LOG="$WORK/serve.log"
"$BUNDLE_DIR/bin/synth" serve --home "$HOME_DIR" --port "$PORT" --host 127.0.0.1 >"$LOG" 2>&1 &
SERVER_PID=$!

ok=0
for _ in $(seq 1 60); do
  sleep 0.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if curl -fsS "http://127.0.0.1:$PORT/health" >"$WORK/health.json" 2>/dev/null; then ok=1; break; fi
done
[ "$ok" = "1" ] || { tail -20 "$LOG" >&2 || true; fail "сервер не ответил на /health"; }

info "  /health: $(cat "$WORK/health.json")"
READY_CODE=$(curl -sS -o "$WORK/ready.json" -w '%{http_code}' "http://127.0.0.1:$PORT/ready")
[ "$READY_CODE" = "200" ] || fail "/ready вернул $READY_CODE"
info "  /ready:  $READY_CODE $(cat "$WORK/ready.json")"

API_KEY_FILE="$HOME_DIR/data/secrets/api-key"
[ -f "$API_KEY_FILE" ] || fail "не создан файл API-ключа: $API_KEY_FILE"
[ -s "$API_KEY_FILE" ] || fail "файл API-ключа пуст"
info "  api-key: создан ($API_KEY_FILE)"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

info ""
info "OK: бандл $SV ($PL) работоспособен"
