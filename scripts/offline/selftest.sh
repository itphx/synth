#!/usr/bin/env bash
#
# selftest.sh — самопроверка offline-установщиков Synth (install.sh, smoke-test.sh).
#
# Синтезирует бандл (manifest.json + files.sha256 + файлы) и проверяет:
#   * подменённый/удалённый/добавленный файл — установщик и smoke-test отказывают;
#   * отсутствующий или испорченный манифест — отказ (fail closed);
#   * недопустимый synthVersion — отказ ДО любых операций с файловой системой;
#   * env-файл создаётся с правами 0600, а пути в launcher/unit/plist экранированы.
#
# Запуск:  ./scripts/offline/selftest.sh
# Требуется: bash, coreutils (sha256sum) или perl (shasum), tar.
#
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_SH="$SCRIPT_DIR/install.sh"
SMOKE_SH="$SCRIPT_DIR/smoke-test.sh"

PASS=0
FAIL=0
TMP=""

cleanup() {
  [ -n "$TMP" ] && [ -d "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); printf '  ok   — %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL — %s\n' "$1"; }

# assert_ok <описание> <команда...> — команда должна завершиться успешно.
assert_ok() {
  local desc=$1; shift
  if "$@" >"$TMP/out" 2>&1; then
    ok "$desc"
  else
    bad "$desc (код выхода $?)"
    sed -n '1,10p' "$TMP/out" | sed 's/^/       /'
  fi
}

# assert_fail <описание> <ожидаемый фрагмент> <команда...> — команда должна
# завершиться с ошибкой и напечатать ожидаемый фрагмент.
assert_fail() {
  local desc=$1 expect=$2; shift 2
  if "$@" >"$TMP/out" 2>&1; then
    bad "$desc (ожидался отказ, но команда успешно завершилась)"
    return 0
  fi
  if grep -qF -- "$expect" "$TMP/out"; then
    ok "$desc"
  else
    bad "$desc (в выводе нет «$expect»)"
    sed -n '1,10p' "$TMP/out" | sed 's/^/       /'
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{ print $1 }'
  else
    shasum -a 256 -- "$1" | awk '{ print $1 }'
  fi
}

# make_manifest <каталог бандла> <версия> — manifest.json в формате
# производителя (scripts/offline-bundle.mjs): верхний уровень, для файлов —
# sha256, для каталогов — число файлов и суммарный размер.
make_manifest() {
  local dir=$1 version=$2
  local entry name
  {
    printf '{\n'
    printf '  "name": "synth",\n'
    printf '  "synthVersion": "%s",\n' "$version"
    printf '  "platform": "linux",\n'
    printf '  "arch": "x64",\n'
    printf '  "files": [\n'
    local first=1
    for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
      [ -e "$entry" ] || continue
      name=$(basename "$entry")
      [ "$name" = "manifest.json" ] && continue
      if [ "$first" -eq 0 ]; then printf ',\n'; fi
      first=0
      if [ -d "$entry" ]; then
        local count bytes
        count=$(find "$entry" -type f | wc -l | tr -d '[:space:]')
        bytes=$(find "$entry" -type f -exec wc -c {} + 2>/dev/null | awk 'NF >= 2 && $2 != "total" { s += $1 } END { printf "%d", s + 0 }')
        printf '    {\n      "path": "%s",\n      "type": "directory",\n      "files": %s,\n      "bytes": %s\n    }' \
          "$name" "$count" "$bytes"
      else
        printf '    {\n      "path": "%s",\n      "type": "file",\n      "size": %s,\n      "sha256": "%s"\n    }' \
          "$name" "$(wc -c <"$entry" | tr -d '[:space:]')" "$(sha256 "$entry")"
      fi
    done
    printf '\n  ]\n}\n'
  } >"$dir/manifest.json"
}

# make_inner_sums <каталог бандла> — files.sha256 (sha256 каждого файла).
make_inner_sums() {
  local dir=$1
  (
    cd "$dir" || exit 1
    find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
      case "$f" in
        manifest.json|files.sha256) continue ;;
      esac
      printf '%s  %s\n' "$(sha256 "$f")" "$f"
    done
  ) >"$dir/files.sha256"
}

# make_bundle <каталог> <версия> — синтетический бандл.
make_bundle() {
  local dir=$1 version=$2
  rm -rf "$dir"
  mkdir -p "$dir/app/dist" "$dir/bin" "$dir/runtime/node/bin"
  printf 'console.log("synth");\n' >"$dir/app/dist/cli.js"
  printf '#!/bin/sh\nexit 0\n' >"$dir/bin/synth"
  chmod 755 "$dir/bin/synth"
  printf '#!/bin/sh\nexit 0\n' >"$dir/runtime/node/bin/node"
  chmod 755 "$dir/runtime/node/bin/node"
  cp "$INSTALL_SH" "$dir/install.sh"
  # files.sha256 — до манифеста: манифест хранит sha256 самого files.sha256.
  make_inner_sums "$dir"
  make_manifest "$dir" "$version"
}

# install_env — окружение для установки в отдельный префикс.
install_env() {
  export HOME="$TMP/home"
  export XDG_CONFIG_HOME="$TMP/config"
  export XDG_DATA_HOME="$TMP/data"
  mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/synth-selftest.XXXXXX")
mkdir -p "$TMP/home" "$TMP/config" "$TMP/data"

printf '== синтетический бандл\n'
BUNDLE="$TMP/bundle"
make_bundle "$BUNDLE" 1.2.3

printf '== install.sh: счастливый путь\n'
assert_ok "установка (--dry-run) проходит на целом бандле" \
  bash "$BUNDLE/install.sh" --dry-run

printf '== install.sh: целостность (fail closed)\n'
cp -a "$BUNDLE" "$TMP/tampered"
printf 'X' >>"$TMP/tampered/app/dist/cli.js"
assert_fail "подменённый файл payload отвергнут (файл назван)" "app/dist/cli.js" \
  bash "$TMP/tampered/install.sh" --dry-run

cp -a "$BUNDLE" "$TMP/tampered2"
printf 'X' >>"$TMP/tampered2/install.sh"
assert_fail "подменённый верхнеуровневый файл отвергнут" "install.sh" \
  bash "$TMP/tampered2/install.sh" --dry-run

cp -a "$BUNDLE" "$TMP/missing"
rm -f "$TMP/missing/bin/synth"
assert_fail "удалённый файл отвергнут (файл назван)" "bin/synth" \
  bash "$TMP/missing/install.sh" --dry-run

cp -a "$BUNDLE" "$TMP/extra"
printf 'x\n' >"$TMP/extra/EXTRA"
assert_fail "лишний файл отвергнут" "не совпадает" \
  bash "$TMP/extra/install.sh" --dry-run

cp -a "$BUNDLE" "$TMP/nomanifest"
rm -f "$TMP/nomanifest/manifest.json"
assert_fail "отсутствующий манифест — отказ" "manifest.json не найден" \
  bash "$TMP/nomanifest/install.sh" --dry-run

cp -a "$BUNDLE" "$TMP/badmanifest"
printf '{ "synthVersion": "1.2.3", "files": [\n' >"$TMP/badmanifest/manifest.json"
assert_fail "испорченный манифест — отказ" "files[]" \
  bash "$TMP/badmanifest/install.sh" --dry-run

cp -a "$BUNDLE" "$TMP/nosums"
rm -f "$TMP/nosums/files.sha256"
assert_fail "отсутствующий files.sha256 (есть в манифесте) — отказ" "отсутствует в бандле" \
  bash "$TMP/nosums/install.sh" --dry-run

printf '== install.sh: synthVersion\n'
cp -a "$BUNDLE" "$TMP/badversion"
make_manifest "$TMP/badversion" "../../etc"
assert_fail "synthVersion=../../etc отвергнут" "synthVersion" \
  bash "$TMP/badversion/install.sh" --dry-run --prefix "$TMP/evil-prefix"

cp -a "$BUNDLE" "$TMP/shortversion"
make_manifest "$TMP/shortversion" "1.2"
assert_fail "synthVersion=1.2 отвергнут" "synthVersion" \
  bash "$TMP/shortversion/install.sh" --dry-run

# Ничего не должно быть создано/удалено до отказа.
if [ -e "$TMP/evil-prefix" ]; then
  bad "каталог установки не создан при отказе по synthVersion"
else
  ok "каталог установки не создан при отказе по synthVersion"
fi

printf '== install.sh: права и экранирование\n'
install_env
MARKER="$TMP/pwned"
WEIRD="$TMP/prefix with 'quote' \$(touch $MARKER)"
assert_ok "установка в префикс с пробелом/кавычкой/\$(...)" \
  bash "$BUNDLE/install.sh" --prefix "$WEIRD" --home "$TMP/home-data" --no-start --no-autostart

ENV_FILE="$XDG_CONFIG_HOME/synth/synth.env"
if [ -f "$ENV_FILE" ]; then
  MODE=$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")
  if [ "$MODE" = "600" ]; then
    ok "env-файл создан с правами 0600"
  else
    bad "env-файл создан с правами $MODE (ожидалось 600)"
  fi
else
  bad "env-файл не создан: $ENV_FILE"
fi

LAUNCHER="$WEIRD/bin/synth"
if [ -f "$LAUNCHER" ]; then
  # Поведенческая проверка: команда подстановки в пути не должна выполниться
  # при запуске launcher'а (его выполняют все пользователи).
  sh "$LAUNCHER" >/dev/null 2>&1 || true
  if [ -e "$MARKER" ]; then
    bad "в launcher путь не экранирован — подстановка выполнилась"
  else
    ok "в launcher путь экранирован (\\\$(...) не выполняется)"
  fi
  if sh -n "$LAUNCHER" 2>/dev/null; then
    ok "launcher — валидный sh"
  else
    bad "launcher не проходит sh -n"
  fi
else
  bad "launcher не создан: $LAUNCHER"
fi

UNIT="$XDG_CONFIG_HOME/systemd/user/synth.service"
if [ -f "$UNIT" ]; then
  if grep -qF '\x20' "$UNIT" && grep -qF "$TMP/home-data" "$UNIT"; then
    ok "systemd unit: пути экранированы (systemd_escape_path)"
  else
    bad "systemd unit: пути не экранированы"
    sed -n '1,20p' "$UNIT" | sed 's/^/       /'
  fi
else
  bad "systemd unit не создан: $UNIT"
fi

printf '== install.sh: ветка macOS (LaunchAgent)\n'
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
printf '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo Linux; fi\n' >"$FAKEBIN/uname"
chmod 755 "$FAKEBIN/uname"
MAC_HOME="$TMP/mac-home"
mkdir -p "$MAC_HOME"
MAC_PREFIX="$TMP/mac prefix & <x>"
if PATH="$FAKEBIN:$PATH" HOME="$MAC_HOME" bash "$BUNDLE/install.sh" \
    --prefix "$MAC_PREFIX" --home "$MAC_HOME/data" --no-start >"$TMP/out" 2>&1; then
  PLIST="$MAC_HOME/Library/LaunchAgents/ru.itphx.synth.plist"
  if [ -f "$PLIST" ] && grep -qF '&amp;' "$PLIST"; then
    ok "plist: пути экранированы (XML)"
  else
    bad "plist не создан или не экранирован: $PLIST"
    sed -n '1,20p' "$TMP/out" | sed 's/^/       /'
  fi
else
  bad "установка в режиме macOS не удалась"
  sed -n '1,20p' "$TMP/out" | sed 's/^/       /'
fi

printf '== smoke-test.sh\n'
ARCHDIR="$TMP/archive"
mkdir -p "$ARCHDIR"
tar -czf "$ARCHDIR/synth-1.2.3-linux-x64.tar.gz" -C "$TMP" bundle
( cd "$ARCHDIR" && sha256sum synth-1.2.3-linux-x64.tar.gz >SHA256SUMS )

cp -a "$ARCHDIR" "$TMP/archive-nosums"
rm -f "$TMP/archive-nosums/SHA256SUMS"
assert_fail "отсутствующий SHA256SUMS — жёсткая ошибка" "SHA256SUMS" \
  bash "$SMOKE_SH" --archive "$TMP/archive-nosums/synth-1.2.3-linux-x64.tar.gz"

cp -a "$ARCHDIR" "$TMP/archive-badsum"
printf '%s  synth-1.2.3-linux-x64.tar.gz\n' "0000000000000000000000000000000000000000000000000000000000000000" \
  >"$TMP/archive-badsum/SHA256SUMS"
assert_fail "неверный SHA256 архива — жёсткая ошибка" "SHA256 не совпал" \
  bash "$SMOKE_SH" --archive "$TMP/archive-badsum/synth-1.2.3-linux-x64.tar.gz"

# архив с «..» в пути
TRAV="$TMP/traversal"
mkdir -p "$TRAV/work"
printf 'x\n' >"$TRAV/work/payload.txt"
tar -czf "$TRAV/evil.tar.gz" -C "$TRAV/work" --transform 's|payload.txt|../escape.txt|' payload.txt 2>/dev/null \
  || tar -czf "$TRAV/evil.tar.gz" -C "$TRAV/work" payload.txt
( cd "$TRAV" && sha256sum evil.tar.gz >SHA256SUMS )
if tar -tzf "$TRAV/evil.tar.gz" 2>/dev/null | grep -q '\.\./'; then
  assert_fail "архив с '..' отвергнут" "распаковка небезопасна" \
    bash "$SMOKE_SH" --archive "$TRAV/evil.tar.gz"
else
  ok "архив с '..' (tar --transform недоступен — проверка пропущена)"
fi

# подменённый бандл (тот же архив, но файлы изменены после сборки)
TAMPERED_ARCHIVE="$TMP/archive-tampered"
mkdir -p "$TAMPERED_ARCHIVE"
cp -a "$TMP/bundle" "$TMP/bundle-t"
printf 'X' >>"$TMP/bundle-t/app/dist/cli.js"
tar -czf "$TAMPERED_ARCHIVE/synth-1.2.3-linux-x64.tar.gz" -C "$TMP" bundle-t
( cd "$TAMPERED_ARCHIVE" && sha256sum synth-1.2.3-linux-x64.tar.gz >SHA256SUMS )
assert_fail "подменённый бандл в архиве отвергнут" "НАРУШЕНА ЦЕЛОСТНОСТЬ" \
  bash "$SMOKE_SH" --archive "$TAMPERED_ARCHIVE/synth-1.2.3-linux-x64.tar.gz"

printf '\nИтог: %d ok, %d fail\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
