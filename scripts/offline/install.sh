#!/usr/bin/env bash
#
# install.sh — установка Synth из offline-бандла (Linux и macOS, per-user по умолчанию).
#
# Linux (user, без root):
#   приложение   ~/.local/lib/synth/<version>   (symlink current)
#   launcher     ~/.local/bin/synth
#   данные       ~/.local/share/synth           (--home; данные в <home>/data)
#   окружение    ~/.config/synth/synth.env
#   systemd      ~/.config/systemd/user/synth.service
#
# Linux (--system, нужен root):
#   приложение   /opt/synth/<version>           (symlink current)
#   launcher     /usr/local/bin/synth
#   данные       /var/lib/synth
#   окружение    /etc/synth/synth.env
#   systemd      /etc/systemd/system/synth.service (пользователь synth)
#
# macOS (per-user):
#   приложение   ~/Library/Application Support/Synth/<version>  (symlink current)
#   launcher     ~/bin/synth (или /usr/local/bin/synth, если writable)
#   данные       ~/Library/Application Support/Synth/data
#   конфиг       ~/Library/Application Support/Synth/config.yaml
#   LaunchAgent  ~/Library/LaunchAgents/ru.itphx.synth.plist (опционально)
#
# Примеры:
#   ./install.sh
#   ./install.sh --port 4400 --host 0.0.0.0
#   ./install.sh --no-autostart --dry-run
#   sudo ./install.sh --system
#
# ЦЕЛОСТНОСТЬ (fail closed). Бандл приходит из закрытого контура и часто
# устанавливается от root — до ЛЮБЫХ изменений в системе проверяется, что
# содержимое бандла совпадает с манифестом:
#   * верхнеуровневые файлы — sha256 из manifest.json (files[].sha256);
#   * верхнеуровневые каталоги — число файлов и суммарный размер (files[]/bytes);
#   * состав верхнего уровня — лишних/недостающих записей и симлинков быть не
#     должно; манифест/файл сумм отсутствовать не могут (это ошибка, а не
#     предупреждение);
#   * files.sha256 (если есть в бандле) — sha256 КАЖДОГО файла бандла и точное
#     совпадение состава файлов.
# Ничего из бандла не исполняется и не копируется до успешной проверки.
#
set -euo pipefail

PROG=install.sh
BUNDLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER_MARKER='# launcher Synth (создан install.sh offline-бандла)'
UNIT_MARKER='# Managed by Synth offline installer'

# Имена файлов манифеста/сумм — те же, что у производителя (scripts/offline-bundle.mjs).
MANIFEST_NAME=manifest.json
INNER_SUMS_NAME=files.sha256

MODE=user
PREFIX=""
SYNTH_HOME=""
PORT=4300
HOST=127.0.0.1
DO_START=1
DO_AUTOSTART=1
DRY_RUN=0

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
warn() { printf 'Предупреждение: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }

usage() {
  cat <<'USAGE'
Установка Synth из offline-бандла.

Использование: ./install.sh [OPTIONS]

  --user              установка для текущего пользователя (по умолчанию)
  --system            системная установка (только Linux; требуется root)
  --prefix <dir>      базовый каталог установки
  --home <dir>        home-каталог Synth (config/data/profiles; ADR-079)
  --port <port>       порт сервера (по умолчанию 4300)
  --host <host>       адрес прослушивания (по умолчанию 127.0.0.1)
  --no-start          не запускать сервис после установки
  --no-autostart      не включать автозапуск при входе/загрузке
  --dry-run           показать действия, ничего не менять
  -h, --help          эта справка
USAGE
}

need_value() { [ $# -ge 2 ] && [ -n "${2:-}" ] || die "опция $1 требует значение"; }

# --- экранирование -----------------------------------------------------------
#
# Значения --prefix/--home попадают в launcher (исполняется позже и всеми),
# в systemd-unit и в LaunchAgent-plist. Подстановка без экранирования — это
# command injection в файл, который запускают другие пользователи.

# POSIX-кавычки для sh: значение замыкается в одинарные кавычки, внутренние
# одинарные кавычки экранируются как '\'' (POSIX 2.2.2).
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

# systemd-путь: пробелы, обратные слэши, кавычки и «%» экранируются
# C-style (systemd.syntax); «%» — спецификатор systemd, литерал — «%%».
systemd_escape_path() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/ /\\x20/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

# XML-экранирование для LaunchAgent (plist).
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

# Каталог из аргумента: только абсолютный путь без управляющих символов
# (перевод строки/таб ломают unit, plist и launcher).
validate_dir_arg() {
  local name=$1 value=$2
  [ -n "$value" ] || die "$name требует непустое значение"
  case "$value" in
    /*) ;;
    *) die "$name должен быть абсолютным путём: '$value'" ;;
  esac
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    die "$name содержит управляющие символы (перевод строки/таб) — недопустимо"
  fi
}

# Каталог версии должен канонически лежать внутри каталога установки —
# иначе «rm -rf» версии сможет уйти за его пределы.
assert_inside_prefix() {
  local child=$1 prefix=$2 what=$3
  case "$child" in
    "$prefix"/*) ;;
    *) die "$what ($child) находится вне каталога установки ($prefix)" ;;
  esac
  if [ -d "$prefix" ]; then
    local prefix_real child_real child_parent
    prefix_real=$(cd "$prefix" && pwd -P) || prefix_real=$prefix
    child_parent=$(dirname "$child")
    if [ -d "$child_parent" ]; then
      child_real="$(cd "$child_parent" && pwd -P)/$(basename "$child")"
      case "$child_real" in
        "$prefix_real"/*) ;;
        *) die "$what ($child_real) находится вне каталога установки ($prefix_real)" ;;
      esac
    fi
  fi
}

# --- проверка целостности бандла --------------------------------------------
#
# Проверка обязательна и выполняется ДО любых изменений в системе и до
# исполнения чего-либо из бандла. Используются только инструменты, которые
# гарантированно есть в целевой среде: sha256sum (GNU/Linux) либо shasum
# (macOS/BSD) и POSIX-утилиты.

VERIFY_TMP=""
cleanup_verify() {
  if [ -n "$VERIFY_TMP" ] && [ -d "$VERIFY_TMP" ]; then
    rm -rf "$VERIFY_TMP"
  fi
}
trap cleanup_verify EXIT

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
    die "не найден sha256sum или shasum — невозможно проверить целостность бандла (нужен coreutils или perl)"
  fi
  if stat -c %s "$BUNDLE_DIR/$MANIFEST_NAME" >/dev/null 2>&1; then
    STAT_SIZE="-c %s"
  else
    STAT_SIZE="-f %z"
  fi
}

# sha256 файла. Поддерживаются оба формата вывода: «<hash>  <file>» (GNU,
# Perl shasum) и «SHA256 (file) = <hash>».
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

# Разбор manifest.json: synthVersion и список files[].
# Формат манифеста — pretty-print JSON (JSON.stringify(..., null, 2)),
# как его пишет scripts/offline-bundle.mjs. Любая нераспознанная структура —
# ошибка (fail closed), а не «мягкий» разбор.
#
# Программа awk хранится в переменной, а не во временном файле: разбор
# манифеста должен выполняться ДО любых операций с файловой системой
# (в т.ч. до создания временного каталога).
AWK_MANIFEST='
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
'

# Верхний уровень бандла: список имён (без manifest.json).
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

# Разбор манифеста (только чтение). Результат — в MANIFEST_VERSION,
# MANIFEST_RECORDS и MANIFEST_ENTRIES (строки FILE\037...).
MANIFEST_VERSION=""
MANIFEST_RECORDS=""
MANIFEST_ENTRIES=""

parse_manifest() {
  local manifest=$1 parsed
  parsed=$(awk -f <(printf '%s' "$AWK_MANIFEST") "$manifest" 2>/dev/null) || return 1
  MANIFEST_VERSION=$(printf '%s\n' "$parsed" | awk -F'\037' '$1 == "VERSION" { print $2; exit }')
  MANIFEST_RECORDS=$(printf '%s\n' "$parsed" | awk -F'\037' '$1 == "RECORDS" { print $2; exit }')
  MANIFEST_ENTRIES=$(printf '%s\n' "$parsed" | LC_ALL=C grep '^FILE' || true)
  return 0
}

# Проверка бандла по уже разобранному манифесту. При любом нарушении — die.
verify_bundle() {
  local manifest="$BUNDLE_DIR/$MANIFEST_NAME"
  local inner="$BUNDLE_DIR/$INNER_SUMS_NAME"
  local version=$MANIFEST_VERSION records=$MANIFEST_RECORDS entries=$MANIFEST_ENTRIES

  [ -f "$manifest" ] || die "$MANIFEST_NAME не найден — целостность бандла не может быть проверена (установка прервана)"
  detect_hash_tools
  VERIFY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/synth-verify.XXXXXX")

  [ -n "$version" ] \
    || die "в $MANIFEST_NAME нет synthVersion — бандл повреждён или не является offline-бандлом Synth"
  case "$records" in
    ''|*[!0-9]*) die "в $MANIFEST_NAME нет списка files[] — целостность бандла не может быть проверена" ;;
  esac
  [ "$records" -gt 0 ] \
    || die "в $MANIFEST_NAME пустой список files[] — целостность бандла не может быть проверена"

  # 1) Каждая запись манифеста: верхнеуровневые файлы — по sha256,
  #    верхнеуровневые каталоги — по числу файлов и суммарному размеру.
  local seen="$VERIFY_TMP/seen"
  : >"$seen"
  local kind type path size sha fcount bytes target actual cnt sum
  while IFS=$'\037' read -r kind type path size sha fcount bytes; do
    [ "$kind" = "FILE" ] || continue
    case "$path" in
      ''|'.'|'..') die "некорректная запись в $MANIFEST_NAME: путь '$path'" ;;
      */*|*\\*) die "некорректная запись в $MANIFEST_NAME: '$path' (ожидаются верхнеуровневые имена)" ;;
    esac
    if LC_ALL=C grep -qxF -- "$path" "$seen"; then
      die "дублирующаяся запись в $MANIFEST_NAME: '$path'"
    fi
    printf '%s\n' "$path" >>"$seen"
    target="$BUNDLE_DIR/$path"
    case "$type" in
      file)
        [ -f "$target" ] && [ ! -L "$target" ] \
          || die "файл '$path' отсутствует в бандле (ожидался по манифесту)"
        [ -n "$sha" ] \
          || die "в $MANIFEST_NAME нет sha256 для '$path' — целостность не может быть проверена"
        actual=$(sha256_of "$target") || die "не удалось вычислить sha256 для '$path'"
        [ "$actual" = "$sha" ] \
          || die "НАРУШЕНА ЦЕЛОСТНОСТЬ: sha256 файла '$path' не совпадает с манифестом (ожидался $sha, получен $actual)"
        ;;
      directory)
        [ -d "$target" ] && [ ! -L "$target" ] \
          || die "каталог '$path' отсутствует в бандле (ожидался по манифесту)"
        [ -n "$fcount" ] && [ -n "$bytes" ] \
          || die "в $MANIFEST_NAME нет счётчиков (files/bytes) для каталога '$path'"
        ;;
      *)
        die "неизвестный тип '$type' для '$path' в $MANIFEST_NAME"
        ;;
    esac
  done < <(printf '%s\n' "$entries")

  # 2) files.sha256 — sha256 КАЖДОГО файла бандла (в т.ч. payload приложения) и
  #    точное совпадение состава файлов. Проверяется раньше счётчиков каталогов,
  #    чтобы в ошибке назывался конкретный изменённый файл.
  if [ -f "$inner" ]; then
    local rc=0
    # LC_ALL=C — чтобы вывод sha256sum был на английском («FAILED») и разбирался однозначно.
    ( cd "$BUNDLE_DIR" && LC_ALL=C $SHA_TOOL $SHA_TOOL_ARGS -c "$INNER_SUMS_NAME" ) \
      >"$VERIFY_TMP/sums.out" 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
      LC_ALL=C grep -E ': FAILED|No such file|could not be read|improperly formatted' "$VERIFY_TMP/sums.out" \
        | head -10 >&2 || true
      die "НАРУШЕНА ЦЕЛОСТНОСТЬ: $INNER_SUMS_NAME — проверка sha256 не пройдена (см. список выше)"
    fi
    ( cd "$BUNDLE_DIR" && find . -type f ) | sed 's|^\./||' \
      | LC_ALL=C grep -v -x -e "$MANIFEST_NAME" -e "$INNER_SUMS_NAME" | LC_ALL=C sort >"$VERIFY_TMP/actual_files"
    cut -c67- "$inner" | LC_ALL=C sort >"$VERIFY_TMP/expected_files"
    if ! diff -u "$VERIFY_TMP/expected_files" "$VERIFY_TMP/actual_files" >"$VERIFY_TMP/files.diff" 2>/dev/null; then
      sed -n '1,40p' "$VERIFY_TMP/files.diff" >&2 || true
      die "НАРУШЕНА ЦЕЛОСТНОСТЬ: состав файлов бандла не совпадает с $INNER_SUMS_NAME (лишние или недостающие файлы)"
    fi
  fi

  # 3) Счётчики каталогов из манифеста (число файлов и суммарный размер) —
  #    грубая, но независимая от files.sha256 проверка payload.
  while IFS=$'\037' read -r kind type path size sha fcount bytes; do
    [ "$kind" = "FILE" ] || continue
    [ "$type" = "directory" ] || continue
    target="$BUNDLE_DIR/$path"
    cnt=$(find "$target" -type f | wc -l | tr -d '[:space:]')
    sum=$(find "$target" -type f -exec stat $STAT_SIZE {} + 2>/dev/null | awk '{ s += $1 } END { printf "%d", s + 0 }')
    [ "$cnt" = "$fcount" ] \
      || die "НАРУШЕНА ЦЕЛОСТНОСТЬ: в каталоге '$path' $cnt файл(ов), по манифесту $fcount"
    [ "$sum" = "$bytes" ] \
      || die "НАРУШЕНА ЦЕЛОСТНОСТЬ: каталог '$path' — $sum байт, по манифесту $bytes"
  done < <(printf '%s\n' "$entries")

  # 4) Состав верхнего уровня: лишних и недостающих записей быть не должно,
  #    симлинков — тоже (иначе содержимое может указывать наружу).
  bundle_top_entries | LC_ALL=C sort >"$VERIFY_TMP/actual"
  LC_ALL=C sort "$seen" >"$VERIFY_TMP/expected"
  if ! diff -u "$VERIFY_TMP/expected" "$VERIFY_TMP/actual" >"$VERIFY_TMP/diff" 2>/dev/null; then
    sed -n '1,40p' "$VERIFY_TMP/diff" >&2 || true
    die "состав бандла не совпадает с манифестом (лишние или недостающие записи верхнего уровня)"
  fi
  local link
  link=$(cd "$BUNDLE_DIR" && for f in * .[!.]* ..?*; do
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi
    if [ "$f" = "$MANIFEST_NAME" ]; then continue; fi
    if [ -L "$f" ]; then printf '%s\n' "$f"; fi
  done | LC_ALL=C sort | head -5)
  [ -z "$link" ] || die "в бандле есть симлинки: $link"

  info "целостность бандла: проверено $records записей манифеста$([ -f "$inner" ] && echo " + $INNER_SUMS_NAME")"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE=user; shift ;;
    --system) MODE=system; shift ;;
    --prefix) need_value "$@"; PREFIX=$2; shift 2 ;;
    --home) need_value "$@"; SYNTH_HOME=$2; shift 2 ;;
    --port) need_value "$@"; PORT=$2; shift 2 ;;
    --host) need_value "$@"; HOST=$2; shift 2 ;;
    --no-start) DO_START=0; shift ;;
    --no-autostart) DO_AUTOSTART=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "неизвестная опция: $1 (см. --help)" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) die "--port должен быть числом" ;;
esac
# host попадает в systemd unit/LaunchAgent: не допускаем пробелы, кавычки,
# переводы строк и shell-метасимволы (IPv4/IPv6/hostname — разрешены).
case "$HOST" in
  ''|*[!A-Za-z0-9.:_\[\]-]*) die "--host содержит недопустимые символы: $HOST" ;;
esac

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run]'
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

# write_file <path> [mode] — содержимое из stdin.
# Файл создаётся с umask 077 (0600), затем выставляется запрошенный mode.
write_file() {
  local file=$1 mode=${2:-}
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$mode" ]; then
      printf '[dry-run] записать %s (mode %s)\n' "$file" "$mode"
    else
      printf '[dry-run] записать %s\n' "$file"
    fi
    cat >/dev/null
  else
    mkdir -p "$(dirname "$file")"
    ( umask 077; cat >"$file" )
    if [ -n "$mode" ]; then
      chmod "$mode" "$file"
    fi
  fi
}

# --prefix/--home попадают в пути, которые удаляются и записываются в
# launcher/unit/plist — проверяем их до любых операций с файловой системой.
if [ -n "$PREFIX" ]; then
  validate_dir_arg "--prefix" "$PREFIX"
fi
if [ -n "$SYNTH_HOME" ]; then
  validate_dir_arg "--home" "$SYNTH_HOME"
fi

[ -f "$BUNDLE_DIR/$MANIFEST_NAME" ] || die "$MANIFEST_NAME не найден — install.sh должен лежать в корне бандла"
[ -x "$BUNDLE_DIR/runtime/node/bin/node" ] || die "runtime/node/bin/node не найден или не исполняемый"

OS=$(uname -s)
case "$OS" in
  Linux|Darwin) ;;
  *) die "неподдерживаемая ОС: $OS (offline-бандлы выпускаются для Linux и macOS)" ;;
esac

if [ "$MODE" = system ] && [ "$OS" != Linux ]; then
  die "--system поддерживается только на Linux (на macOS установка per-user)"
fi

# 1) Разбор манифеста и проверка версии — ТОЛЬКО чтение, до любых операций
#    с файловой системой (до создания каталогов, до env-файла/launcher/unit).
#    Версия из манифеста попадает в путь каталога (rm -rf) и в unit/plist —
#    строгий шаблон, иначе «../../etc» удалит не то.
[ -f "$BUNDLE_DIR/$MANIFEST_NAME" ] \
  || die "$MANIFEST_NAME не найден — целостность бандла не может быть проверена (установка прервана)"
parse_manifest "$BUNDLE_DIR/$MANIFEST_NAME" || die "не удалось прочитать $MANIFEST_NAME"
VERSION=$MANIFEST_VERSION
[ -n "$VERSION" ] \
  || die "в $MANIFEST_NAME нет synthVersion — бандл повреждён или не является offline-бандлом Synth"
case "$VERSION" in
  ''|*[!0-9A-Za-z.-]*)
    die "synthVersion из $MANIFEST_NAME содержит недопустимые символы: '$VERSION'" ;;
esac
printf '%s' "$VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
  || die "synthVersion из $MANIFEST_NAME недопустим: '$VERSION' (ожидается X.Y.Z[-prerelease])"

# 2) Целостность бандла — до любых изменений в системе и до исполнения
#    чего-либо из бандла (в т.ч. до запуска bundled node).
verify_bundle

if [ "$OS" = Linux ]; then
  if [ "$MODE" = system ]; then
    if [ "$DRY_RUN" -eq 0 ]; then
      [ "$(id -u)" -eq 0 ] || die "--system требует root (sudo ./install.sh --system)"
    fi
    PREFIX=${PREFIX:-/opt/synth}
    APP_DIR="$PREFIX/$VERSION"
    CURRENT="$PREFIX/current"
    LAUNCHER=/usr/local/bin/synth
    SYNTH_HOME=${SYNTH_HOME:-/var/lib/synth}
    ENV_FILE=/etc/synth/synth.env
    UNIT=/etc/systemd/system/synth.service
    SERVICE_USER=synth
    WANTED_BY=multi-user.target
    SERVICE_HOME="$SYNTH_HOME"
  else
    PREFIX=${PREFIX:-$HOME/.local}
    APP_DIR="$PREFIX/lib/synth/$VERSION"
    CURRENT="$PREFIX/lib/synth/current"
    LAUNCHER="$PREFIX/bin/synth"
    SYNTH_HOME=${SYNTH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/synth}
    ENV_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/synth/synth.env
    UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/synth.service
    SERVICE_USER=""
    WANTED_BY=default.target
    SERVICE_HOME="$HOME"
  fi
  LOGS_DIR=""
else
  # macOS
  PREFIX=${PREFIX:-$HOME/Library/Application Support/Synth}
  APP_DIR="$PREFIX/$VERSION"
  CURRENT="$PREFIX/current"
  SYNTH_HOME=${SYNTH_HOME:-$PREFIX}
  ENV_FILE="$PREFIX/synth.env"
  UNIT=""
  SERVICE_USER=""
  WANTED_BY=""
  SERVICE_HOME="$HOME"
  LOGS_DIR="$HOME/Library/Logs/Synth"
  PLIST="$HOME/Library/LaunchAgents/ru.itphx.synth.plist"
  if [ -d "$HOME/bin" ] && [ -w "$HOME/bin" ]; then
    LAUNCHER="$HOME/bin/synth"
  elif [ -w /usr/local/bin ]; then
    LAUNCHER=/usr/local/bin/synth
  else
    LAUNCHER="$HOME/bin/synth"
  fi
fi

# Каталог версии обязан канонически лежать внутри каталога установки —
# «rm -rf» ниже удаляет его перед переустановкой.
assert_inside_prefix "$APP_DIR" "$PREFIX" "каталог версии"
assert_inside_prefix "$CURRENT" "$PREFIX" "каталог current"

info "Synth v$VERSION"
info "  режим:        $MODE"
info "  приложение:   $APP_DIR"
info "  текущая:      $CURRENT"
info "  launcher:     $LAUNCHER"
info "  home (данные):$SYNTH_HOME"
[ -n "$ENV_FILE" ] && info "  env-файл:     $ENV_FILE"
[ -n "$UNIT" ] && info "  unit:         $UNIT"
[ -n "${PLIST:-}" ] && info "  LaunchAgent:  $PLIST"
info "  сервер:       http://$HOST:$PORT"

if [ "$DRY_RUN" -eq 1 ]; then
  info ""
  info "Режим --dry-run: изменения не вносятся."
fi

# Проверяем конфликты ДО любых изменений, чтобы не оставить полуустановку.
if [ -e "$LAUNCHER" ] && ! grep -qF "$LAUNCHER_MARKER" "$LAUNCHER" 2>/dev/null; then
  die "уже существует $LAUNCHER (не launcher Synth offline-бандла). Удалите/переименуйте его или используйте --prefix."
fi
if [ -n "$UNIT" ] && [ -f "$UNIT" ] && ! grep -qF "$UNIT_MARKER" "$UNIT" 2>/dev/null; then
  die "уже существует $UNIT и он создан не offline-установщиком Synth. Удалите/переименуйте его вручную."
fi

# --- системный пользователь (только Linux --system) -------------------------
if [ "$MODE" = system ] && ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "создаю системного пользователя $SERVICE_USER"
  run useradd --system --home-dir "$SYNTH_HOME" --shell /usr/sbin/nologin --user-group "$SERVICE_USER" \
    || warn "не удалось создать пользователя $SERVICE_USER — создайте вручную"
fi

# --- копирование приложения -------------------------------------------------
run mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR" ] && [ "$DRY_RUN" -eq 0 ]; then
  info "переустановка версии $VERSION (каталог уже существует)"
  rm -rf "$APP_DIR"
fi
run mkdir -p "$APP_DIR"
run cp -a "$BUNDLE_DIR/." "$APP_DIR/"
run ln -sfn "$APP_DIR" "$CURRENT"

run mkdir -p "$(dirname "$LAUNCHER")"
# Путь в launcher экранируется: файл живёт в /usr/local/bin и исполняется
# всеми пользователями (в т.ч. от root) — «$(id)» в пути не должен выполняться.
write_file "$LAUNCHER" <<EOF
#!/bin/sh
$LAUNCHER_MARKER
exec $(shell_quote "$CURRENT/bin/synth") "\$@"
EOF
run chmod 755 "$LAUNCHER"

run mkdir -p "$SYNTH_HOME"
if [ "$MODE" = system ]; then
  run chown -R "$SERVICE_USER:$SERVICE_USER" "$SYNTH_HOME"
fi

# --- файл окружения ---------------------------------------------------------
# Файл окружения — естественное место для секретов (SYNTH_PROXY_PASSWORD,
# SYNTH_SECRET_KEY), поэтому права 0600, а не umask по умолчанию.
if [ ! -f "$ENV_FILE" ]; then
  run mkdir -p "$(dirname "$ENV_FILE")"
  write_file "$ENV_FILE" 600 <<EOF
# Synth — переменные окружения (создано install.sh)
# Порт/хост/данные задаются аргументами ExecStart/ProgramArguments;
# переменные ниже — для дополнительных настроек.
# ВАЖНО: файл содержит секреты (например SYNTH_PROXY_PASSWORD) — права 0600.
# SYNTH_LOG_LEVEL=info
EOF
else
  info "env-файл уже существует, не перезаписываю: $ENV_FILE"
fi

# --- systemd (Linux) --------------------------------------------------------
if [ -n "$UNIT" ]; then
  SERVICE_USER_LINES=""
  if [ -n "$SERVICE_USER" ]; then
    SERVICE_USER_LINES="User=$SERVICE_USER
Group=$SERVICE_USER
"
  fi

  APP_DIR_ESCAPED=$(systemd_escape_path "$APP_DIR")
  ENV_FILE_ESCAPED=$(systemd_escape_path "$ENV_FILE")
  CURRENT_ESCAPED=$(systemd_escape_path "$CURRENT")
  SYNTH_HOME_ESCAPED=$(systemd_escape_path "$SYNTH_HOME")
  SERVICE_HOME_ESCAPED=$(systemd_escape_path "$SERVICE_HOME")

  write_file "$UNIT" 644 <<EOF
$UNIT_MARKER
[Unit]
Description=Synth — AI-платформа
Documentation=https://docs.synth.itphx.ru/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${SERVICE_USER_LINES}WorkingDirectory=$APP_DIR_ESCAPED
Environment="HOME=$SERVICE_HOME_ESCAPED"
Environment=NODE_ENV=production
EnvironmentFile=-$ENV_FILE_ESCAPED
ExecStart="$CURRENT_ESCAPED/bin/synth" serve --home "$SYNTH_HOME_ESCAPED" --port "$PORT" --host "$HOST"
Restart=on-failure
RestartSec=3
# Код 75 — graceful-перезапрос рестарта (ADR-092) — трактуем как сбой,
# чтобы systemd поднял процесс заново.
LimitNOFILE=65536

[Install]
WantedBy=$WANTED_BY
EOF

  if command -v systemctl >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    if [ "$MODE" = system ]; then
      systemctl daemon-reload || warn "systemctl daemon-reload завершился с ошибкой"
      if [ "$DO_AUTOSTART" -eq 1 ]; then
        systemctl enable synth.service || warn "systemctl enable завершился с ошибкой"
      fi
      if [ "$DO_START" -eq 1 ]; then
        systemctl restart synth.service || warn "не удалось запустить synth.service (см. journalctl -u synth)"
      fi
    else
      systemctl --user daemon-reload || warn "systemctl --user daemon-reload недоступен"
      if [ "$DO_AUTOSTART" -eq 1 ]; then
        systemctl --user enable synth.service || warn "systemctl --user enable завершился с ошибкой"
      fi
      if [ "$DO_START" -eq 1 ]; then
        systemctl --user restart synth.service || warn "не удалось запустить synth.service (см. journalctl --user -u synth)"
      fi
    fi
  elif [ "$DRY_RUN" -eq 0 ]; then
    warn "systemctl не найден — unit создан, но не включён и не запущен"
  fi
fi

# --- LaunchAgent (macOS) ----------------------------------------------------
if [ -n "${PLIST:-}" ]; then
  run mkdir -p "$LOGS_DIR"
  if [ "$DO_AUTOSTART" -eq 1 ]; then
    # Пути попадают в XML — экранируем (&, <, >, ", '), иначе значение из
    # --home/--prefix ломает plist (и может подсунуть свой XML).
    PLIST_CURRENT=$(xml_escape "$CURRENT/bin/synth")
    PLIST_HOME=$(xml_escape "$SYNTH_HOME")
    PLIST_LOGS=$(xml_escape "$LOGS_DIR")
    PLIST_USER_HOME=$(xml_escape "$HOME")
    write_file "$PLIST" 644 <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ru.itphx.synth</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PLIST_CURRENT</string>
    <string>serve</string>
    <string>--home</string>
    <string>$PLIST_HOME</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--host</string>
    <string>$HOST</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$PLIST_LOGS/synth.out.log</string>
  <key>StandardErrorPath</key><string>$PLIST_LOGS/synth.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$PLIST_USER_HOME</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
</dict>
</plist>
EOF

    if [ "$DO_START" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || \
        launchctl load -w "$PLIST" 2>/dev/null || \
        warn "не удалось загрузить LaunchAgent (загрузите вручную: launchctl bootstrap gui/$(id -u) '$PLIST')"
    fi
  else
    info "--no-autostart: LaunchAgent не создаётся"
    if [ "$DO_START" -eq 1 ] && [ "$DRY_RUN" -eq 1 ]; then
      run nohup "$CURRENT/bin/synth" serve --home "$SYNTH_HOME" --port "$PORT" --host "$HOST"
    elif [ "$DO_START" -eq 1 ]; then
      nohup "$CURRENT/bin/synth" serve --home "$SYNTH_HOME" --port "$PORT" --host "$HOST" \
        >>"$LOGS_DIR/synth.out.log" 2>>"$LOGS_DIR/synth.err.log" &
      info "запуск в фоне (PID $!); логи: $LOGS_DIR"
    fi
  fi
fi

# --- итог -------------------------------------------------------------------
info ""
info "Готово."
info "  URL:        http://$HOST:$PORT"
info "  API-ключ:   $SYNTH_HOME/data/secrets/api-key"
info "              (создаётся при первом запуске; значение не выводится)"
[ -n "$UNIT" ] && [ "$DO_START" -eq 0 ] && info "  запуск:     systemctl $([ "$MODE" = system ] || echo --user) start synth"
[ -n "${PLIST:-}" ] && info "  логи:       $LOGS_DIR"
info "  удаление:   $BUNDLE_DIR/uninstall.sh$( [ "$MODE" = system ] && echo ' --system')"
