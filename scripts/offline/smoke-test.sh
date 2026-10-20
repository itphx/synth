#!/usr/bin/env bash
#
# smoke-test.sh — проверка offline-бандла Synth без установки.
#
# Проверяет: SHA256SUMS рядом с архивом (обязательно), безопасность состава
# архива (нет абсолютных путей и «..»), manifest.json и sha256 КАЖДОГО файла
# бандла (обязательно), отсутствие симлинков, версии Node/rg/Synth, запуск
# `bin/synth serve` и ответы /health, /ready.
#
# Отсутствие SHA256SUMS или manifest.json — ошибка, а не предупреждение:
# проверка целостности обязательна.
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

# Имена файлов манифеста/сумм — те же, что у производителя (scripts/offline-bundle.mjs).
MANIFEST_NAME=manifest.json
INNER_SUMS_NAME=files.sha256

info() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE=${2:?--archive требует путь}; shift 2 ;;
    --dir) BUNDLE_DIR=${2:?--dir требует путь}; shift 2 ;;
    --port) PORT=${2:?--port требует значение}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
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

# --- проверка состава архива (входные данные извне) -------------------------
# Абсолютные пути и «..» в архиве — путь за пределы каталога распаковки.
check_entries() {
  local list=$1
  if LC_ALL=C grep -qE '(^/|(^|/)\.\.(/|$))' "$list"; then
    LC_ALL=C grep -E '(^/|(^|/)\.\.(/|$))' "$list" | head -10 >&2 || true
    fail "в архиве есть абсолютные пути или '..' — распаковка небезопасна"
  fi
}

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || fail "архив не найден: $ARCHIVE"
  NAME=$(basename "$ARCHIVE")
  SUMS="$(dirname "$ARCHIVE")/SHA256SUMS"
  # SHA256SUMS — обязателен: без него целостность архива не подтверждена.
  [ -f "$SUMS" ] || fail "SHA256SUMS рядом с архивом не найден ($SUMS) — проверка целостности обязательна"
  EXPECTED=$(awk -v n="$NAME" '$2 == n { print $1 }' "$SUMS")
  [ -n "$EXPECTED" ] || fail "в SHA256SUMS нет записи для $NAME"
  ACTUAL=$(sha256sum "$ARCHIVE" | awk '{ print $1 }')
  [ "$EXPECTED" = "$ACTUAL" ] || fail "SHA256 не совпал для $NAME (ожидался $EXPECTED, получен $ACTUAL)"
  info "SHA256 ok: $NAME"

  case "$ARCHIVE" in
    *.zip)
      unzip -Z1 "$ARCHIVE" >"$WORK/entries.txt" 2>/dev/null \
        || unzip -l "$ARCHIVE" | awk 'NR > 3 && NF == 4 { print $4 }' >"$WORK/entries.txt"
      check_entries "$WORK/entries.txt"
      unzip -X -q "$ARCHIVE" -d "$WORK"
      ;;
    *.tar.gz|*.tgz)
      tar -tzf "$ARCHIVE" >"$WORK/entries.txt"
      check_entries "$WORK/entries.txt"
      TAR_FLAGS=""
      if tar --version 2>/dev/null | LC_ALL=C grep -q 'GNU tar'; then
        TAR_FLAGS="--no-same-owner --no-same-permissions"
      fi
      # shellcheck disable=SC2086 # TAR_FLAGS — список флагов, разбивается намеренно
      tar $TAR_FLAGS -xzf "$ARCHIVE" -C "$WORK"
      ;;
    *) fail "неизвестный формат архива: $ARCHIVE" ;;
  esac
  BUNDLE_DIR=$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)
  [ -n "$BUNDLE_DIR" ] || fail "в архиве нет корневого каталога"
fi

[ -d "$BUNDLE_DIR" ] || fail "каталог бандла не найден: $BUNDLE_DIR"
[ -f "$BUNDLE_DIR/$MANIFEST_NAME" ] \
  || fail "нет $MANIFEST_NAME в $BUNDLE_DIR — проверка целостности обязательна"
BUNDLE_DIR=$(cd "$BUNDLE_DIR" && pwd)

# --- проверка целостности содержимого бандла --------------------------------
# Логика намеренно продублирована из install.sh: smoke-test не должен
# исполнять код проверяемого артефакта.

SHA_TOOL=""
SHA_TOOL_ARGS=""
STAT_SIZE=""

detect_hash_tools() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL=sha256sum
    SHA_TOOL_ARGS=""
  elif command -v shasum >/dev/null 2>&1; then
    SHA_TOOL=shasum
    SHA_TOOL_ARGS="-a 256"
  else
    fail "не найден sha256sum или shasum — невозможно проверить целостность бандла"
  fi
  if stat -c %s "$BUNDLE_DIR/$MANIFEST_NAME" >/dev/null 2>&1; then
    STAT_SIZE="-c %s"
  else
    STAT_SIZE="-f %z"
  fi
}

sha256_of() {
  local f=$1 out hash
  # shellcheck disable=SC2086
  out=$($SHA_TOOL $SHA_TOOL_ARGS -- "$f") || return 1
  hash=${out%% *}
  if printf '%s' "$hash" | LC_ALL=C grep -qE '^[0-9a-fA-F]{64}$'; then
    printf '%s' "$hash"
  else
    printf '%s' "${out##*= }"
  fi
}

write_manifest_parser() {
  cat >"$WORK/manifest.awk" <<'AWK'
function extract(line, key,   re, tmp) {
  re = "\"" key "\"[ \t]*:[ \t]*"
  if (!match(line, re)) return ""
  tmp = substr(line, RSTART + RLENGTH)
  sub(/^[ \t\r]+/, "", tmp)
  if (substr(tmp, 1, 1) == "\"") {
    sub(/^"/, "", tmp)
    if (match(tmp, /\"/)) return substr(tmp, 1, RSTART - 1)
    return tmp
  }
  if (match(tmp, /^[^,}\r\n \t]+/)) return substr(tmp, 1, RLENGTH)
  return ""
}
BEGIN { in_files = 0; version = ""; records = 0 }
{
  if (version == "") {
    v = extract($0, "synthVersion")
    if (v != "") version = v
  }
  if (!in_files) {
    if (match($0, /"files"[ \t]*:[ \t]*\[/)) in_files = 1
    next
  }
  if ($0 ~ /^[ \t]*\]/) { in_files = 0; next }
  p  = extract($0, "path");   if (p  != "") path = p
  t  = extract($0, "type");   if (t  != "") type = t
  s  = extract($0, "size");   if (s  != "") size = s
  h  = extract($0, "sha256"); if (h  != "") sha = h
  fc = extract($0, "files");  if (fc != "") fcount = fc
  bc = extract($0, "bytes");  if (bc != "") bytes = bc
  if ($0 ~ /^[ \t]*\}[ \t]*,?[ \t]*$/) {
    printf "FILE\037%s\037%s\037%s\037%s\037%s\037%s\n", type, path, size, sha, fcount, bytes
    records++
    path = ""; type = ""; size = ""; sha = ""; fcount = ""; bytes = ""
  }
}
END {
  printf "VERSION\037%s\n", version
  printf "RECORDS\037%d\n", records
}
AWK
}

bundle_top_entries() {
  (
    cd "$BUNDLE_DIR" || exit 1
    for f in * .[!.]* ..?*; do
      if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi
      if [ "$f" = "$MANIFEST_NAME" ]; then continue; fi
      printf '%s\n' "$f"
    done
  )
}

verify_bundle() {
  local manifest="$BUNDLE_DIR/$MANIFEST_NAME"
  local inner="$BUNDLE_DIR/$INNER_SUMS_NAME"

  [ -f "$manifest" ] || fail "$MANIFEST_NAME не найден — целостность бандла не может быть проверена"
  detect_hash_tools
  write_manifest_parser

  local parsed version records
  parsed=$(awk -f "$WORK/manifest.awk" "$manifest" 2>/dev/null) || fail "не удалось прочитать $MANIFEST_NAME"
  version=$(printf '%s\n' "$parsed" | awk -F'\037' '$1 == "VERSION" { print $2; exit }')
  records=$(printf '%s\n' "$parsed" | awk -F'\037' '$1 == "RECORDS" { print $2; exit }')
  [ -n "$version" ] || fail "в $MANIFEST_NAME нет synthVersion"
  case "$records" in
    ''|*[!0-9]*) fail "в $MANIFEST_NAME нет списка files[] — целостность бандла не может быть проверена" ;;
  esac
  [ "$records" -gt 0 ] || fail "в $MANIFEST_NAME пустой список files[] — целостность бандла не может быть проверена"

  local seen="$WORK/seen"
  : >"$seen"
  local kind type path size sha fcount bytes target actual cnt sum
  while IFS=$'\037' read -r kind type path size sha fcount bytes; do
    [ "$kind" = "FILE" ] || continue
    case "$path" in
      ''|'.'|'..') fail "некорректная запись в $MANIFEST_NAME: путь '$path'" ;;
      */*|*\\*) fail "некорректная запись в $MANIFEST_NAME: '$path' (ожидаются верхнеуровневые имена)" ;;
    esac
    if LC_ALL=C grep -qxF -- "$path" "$seen"; then
      fail "дублирующаяся запись в $MANIFEST_NAME: '$path'"
    fi
    printf '%s\n' "$path" >>"$seen"
    target="$BUNDLE_DIR/$path"
    case "$type" in
      file)
        [ -f "$target" ] && [ ! -L "$target" ] \
          || fail "файл '$path' отсутствует в бандле (ожидался по манифесту)"
        [ -n "$sha" ] || fail "в $MANIFEST_NAME нет sha256 для '$path' — целостность не может быть проверена"
        actual=$(sha256_of "$target") || fail "не удалось вычислить sha256 для '$path'"
        [ "$actual" = "$sha" ] \
          || fail "НАРУШЕНА ЦЕЛОСТНОСТЬ: sha256 файла '$path' не совпадает с манифестом (ожидался $sha, получен $actual)"
        ;;
      directory)
        [ -d "$target" ] && [ ! -L "$target" ] \
          || fail "каталог '$path' отсутствует в бандле (ожидался по манифесту)"
        [ -n "$fcount" ] && [ -n "$bytes" ] \
          || fail "в $MANIFEST_NAME нет счётчиков (files/bytes) для каталога '$path'"
        ;;
      *)
        fail "неизвестный тип '$type' для '$path' в $MANIFEST_NAME"
        ;;
    esac
  done < <(printf '%s\n' "$parsed" | LC_ALL=C grep '^FILE' || true)

  # files.sha256 — sha256 каждого файла бандла + точное совпадение состава.
  if [ -f "$inner" ]; then
    local rc=0
    ( cd "$BUNDLE_DIR" && LC_ALL=C $SHA_TOOL $SHA_TOOL_ARGS -c "$INNER_SUMS_NAME" ) \
      >"$WORK/sums.out" 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
      LC_ALL=C grep -E ': FAILED|No such file|could not be read|improperly formatted' "$WORK/sums.out" \
        | head -10 >&2 || true
      fail "НАРУШЕНА ЦЕЛОСТНОСТЬ: $INNER_SUMS_NAME — проверка sha256 не пройдена (см. список выше)"
    fi
    ( cd "$BUNDLE_DIR" && find . -type f ) | sed 's|^\./||' \
      | LC_ALL=C grep -v -x -e "$MANIFEST_NAME" -e "$INNER_SUMS_NAME" | LC_ALL=C sort >"$WORK/actual_files"
    cut -c67- "$inner" | LC_ALL=C sort >"$WORK/expected_files"
    if ! diff -u "$WORK/expected_files" "$WORK/actual_files" >"$WORK/files.diff" 2>/dev/null; then
      sed -n '1,40p' "$WORK/files.diff" >&2 || true
      fail "НАРУШЕНА ЦЕЛОСТНОСТЬ: состав файлов бандла не совпадает с $INNER_SUMS_NAME (лишние или недостающие файлы)"
    fi
  fi

  # Счётчики каталогов из манифеста.
  while IFS=$'\037' read -r kind type path size sha fcount bytes; do
    [ "$kind" = "FILE" ] || continue
    [ "$type" = "directory" ] || continue
    target="$BUNDLE_DIR/$path"
    cnt=$(find "$target" -type f | wc -l | tr -d '[:space:]')
    sum=$(find "$target" -type f -exec stat $STAT_SIZE {} + 2>/dev/null | awk '{ s += $1 } END { printf "%d", s + 0 }')
    [ "$cnt" = "$fcount" ] \
      || fail "НАРУШЕНА ЦЕЛОСТНОСТЬ: в каталоге '$path' $cnt файл(ов), по манифесту $fcount"
    [ "$sum" = "$bytes" ] \
      || fail "НАРУШЕНА ЦЕЛОСТНОСТЬ: каталог '$path' — $sum байт, по манифесту $bytes"
  done < <(printf '%s\n' "$parsed" | LC_ALL=C grep '^FILE' || true)

  # Состав верхнего уровня: лишних/недостающих записей и симлинков быть не должно.
  bundle_top_entries | LC_ALL=C sort >"$WORK/actual"
  LC_ALL=C sort "$seen" >"$WORK/expected"
  if ! diff -u "$WORK/expected" "$WORK/actual" >"$WORK/diff" 2>/dev/null; then
    sed -n '1,40p' "$WORK/diff" >&2 || true
    fail "состав бандла не совпадает с манифестом (лишние или недостающие записи верхнего уровня)"
  fi
  local link
  link=$(cd "$BUNDLE_DIR" && for f in * .[!.]* ..?*; do
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi
    if [ "$f" = "$MANIFEST_NAME" ]; then continue; fi
    if [ -L "$f" ]; then printf '%s\n' "$f"; fi
  done | LC_ALL=C sort | head -5)
  [ -z "$link" ] || fail "в бандле есть симлинки: $link"

  info "  целостность: $records записей манифеста$([ -f "$inner" ] && echo " + $INNER_SUMS_NAME")"
}

verify_bundle

NODE="$BUNDLE_DIR/runtime/node/bin/node"
[ -x "$NODE" ] || fail "нет исполняемого runtime/node/bin/node"

info "== manifest"
eval "$("$NODE" -e '
const m = require(process.argv[1]);
process.stdout.write(
  `SV=${JSON.stringify(m.synthVersion)}; NV=${JSON.stringify(m.nodeVersion)}; RV=${JSON.stringify(m.ripgrepVersion)}; PL=${JSON.stringify(m.platform + "/" + m.arch)}\n`
);
' "$BUNDLE_DIR/$MANIFEST_NAME")"
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
