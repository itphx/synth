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
set -euo pipefail

PROG=install.sh
BUNDLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER_MARKER='# launcher Synth (создан install.sh offline-бандла)'
UNIT_MARKER='# Managed by Synth offline installer'

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

# systemd-путь: пробелы и обратные слэши экранируются C-style (systemd.syntax).
systemd_escape_path() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/ /\\x20/g'
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

# write_file <path> — содержимое из stdin
write_file() {
  local file=$1
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] записать %s\n' "$file"
    cat >/dev/null
  else
    mkdir -p "$(dirname "$file")"
    cat >"$file"
  fi
}

[ -f "$BUNDLE_DIR/manifest.json" ] || die "manifest.json не найден — install.sh должен лежать в корне бандла"
[ -x "$BUNDLE_DIR/runtime/node/bin/node" ] || die "runtime/node/bin/node не найден или не исполняемый"

OS=$(uname -s)
case "$OS" in
  Linux|Darwin) ;;
  *) die "неподдерживаемая ОС: $OS (offline-бандлы выпускаются для Linux и macOS)" ;;
esac

if [ "$MODE" = system ] && [ "$OS" != Linux ]; then
  die "--system поддерживается только на Linux (на macOS установка per-user)"
fi

VERSION=$("$BUNDLE_DIR/runtime/node/bin/node" -e 'process.stdout.write(require(process.argv[1]).synthVersion)' "$BUNDLE_DIR/manifest.json")
[ -n "$VERSION" ] || die "не удалось прочитать synthVersion из manifest.json"

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

if [ -e "$LAUNCHER" ] && ! grep -qF "$LAUNCHER_MARKER" "$LAUNCHER" 2>/dev/null; then
  die "уже существует $LAUNCHER (не launcher Synth offline-бандла). Удалите/переименуйте его или используйте --prefix."
fi

run mkdir -p "$(dirname "$LAUNCHER")"
write_file "$LAUNCHER" <<EOF
#!/bin/sh
$LAUNCHER_MARKER
exec "$CURRENT/bin/synth" "\$@"
EOF
run chmod 755 "$LAUNCHER"

run mkdir -p "$SYNTH_HOME"
if [ "$MODE" = system ]; then
  run chown -R "$SERVICE_USER:$SERVICE_USER" "$SYNTH_HOME"
fi

# --- файл окружения ---------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  run mkdir -p "$(dirname "$ENV_FILE")"
  write_file "$ENV_FILE" <<EOF
# Synth — переменные окружения (создано install.sh)
# Порт/хост/данные задаются аргументами ExecStart/ProgramArguments;
# переменные ниже — для дополнительных настроек.
# SYNTH_LOG_LEVEL=info
EOF
else
  info "env-файл уже существует, не перезаписываю: $ENV_FILE"
fi

# --- systemd (Linux) --------------------------------------------------------
if [ -n "$UNIT" ]; then
  if [ -f "$UNIT" ] && ! grep -qF "$UNIT_MARKER" "$UNIT" 2>/dev/null; then
    die "уже существует $UNIT и он создан не offline-установщиком Synth. Удалите/переименуйте его вручную."
  fi

  SERVICE_USER_LINES=""
  if [ -n "$SERVICE_USER" ]; then
    SERVICE_USER_LINES="User=$SERVICE_USER
Group=$SERVICE_USER
"
  fi

  APP_DIR_ESCAPED=$(systemd_escape_path "$APP_DIR")
  ENV_FILE_ESCAPED=$(systemd_escape_path "$ENV_FILE")

  write_file "$UNIT" <<EOF
$UNIT_MARKER
[Unit]
Description=Synth — AI-платформа
Documentation=https://docs.synth.itphx.ru/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${SERVICE_USER_LINES}WorkingDirectory=$APP_DIR_ESCAPED
Environment="HOME=$SERVICE_HOME"
Environment=NODE_ENV=production
EnvironmentFile=-$ENV_FILE_ESCAPED
ExecStart="$CURRENT/bin/synth" serve --home "$SYNTH_HOME" --port "$PORT" --host "$HOST"
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
    write_file "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ru.itphx.synth</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CURRENT/bin/synth</string>
    <string>serve</string>
    <string>--home</string>
    <string>$SYNTH_HOME</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--host</string>
    <string>$HOST</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOGS_DIR/synth.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS_DIR/synth.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
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
