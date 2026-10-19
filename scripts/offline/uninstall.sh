#!/usr/bin/env bash
#
# uninstall.sh — удаление Synth, установленного из offline-бандла (Linux/macOS).
#
# По умолчанию данные СОХРАНЯЮТСЯ. Полное удаление данных — --purge.
#
#   ./uninstall.sh                 # удалить приложение/launcher/unit, данные оставить
#   ./uninstall.sh --purge         # вместе с данными и конфигом
#   sudo ./uninstall.sh --system --purge
#
set -euo pipefail

MODE=user
PREFIX=""
SYNTH_HOME=""
PURGE=0
DRY_RUN=0
KEEP_RUNNING=0
LAUNCHER_MARKER='# launcher Synth (создан install.sh offline-бандла)'
UNIT_MARKER='# Managed by Synth offline installer'

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
warn() { printf 'Предупреждение: %s\n' "$*" >&2; }
info() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run]'
    for arg in "$@"; do printf ' %q' "$arg"; done
    printf '\n'
  else
    "$@"
  fi
}

need_value() { [ $# -ge 2 ] && [ -n "${2:-}" ] || die "опция $1 требует значение"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE=user; shift ;;
    --system) MODE=system; shift ;;
    --prefix) need_value "$@"; PREFIX=$2; shift 2 ;;
    --home) need_value "$@"; SYNTH_HOME=$2; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --keep-running) KEEP_RUNNING=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<'USAGE'
Удаление Synth.

  --user            удалить пользовательскую установку (по умолчанию)
  --system          удалить системную установку (Linux; root)
  --prefix <dir>    базовый каталог установки (как при install)
  --home <dir>      home-каталог Synth (как при install)
  --purge           удалить данные и конфиг (по умолчанию сохраняются)
  --keep-running    не останавливать работающий процесс/сервис
  --dry-run         показать действия, ничего не менять
USAGE
      exit 0 ;;
    *) die "неизвестная опция: $1" ;;
  esac
done

OS=$(uname -s)
[ "$OS" = Linux ] || [ "$OS" = Darwin ] || die "неподдерживаемая ОС: $OS"
if [ "$MODE" = system ] && [ "$OS" != Linux ]; then
  die "--system поддерживается только на Linux"
fi

if [ "$OS" = Linux ]; then
  if [ "$MODE" = system ]; then
    [ "$(id -u)" -eq 0 ] || die "--system требует root"
    PREFIX=${PREFIX:-/opt/synth}
    APP_DIR="$PREFIX/current"
    CURRENT="$PREFIX/current"
    LAUNCHER=/usr/local/bin/synth
    SYNTH_HOME=${SYNTH_HOME:-/var/lib/synth}
    ENV_FILE=/etc/synth/synth.env
    UNIT=/etc/systemd/system/synth.service
    SERVICE_USER=synth
  else
    PREFIX=${PREFIX:-$HOME/.local}
    APP_DIR="$PREFIX/lib/synth/current"
    CURRENT="$PREFIX/lib/synth/current"
    LAUNCHER="$PREFIX/bin/synth"
    SYNTH_HOME=${SYNTH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/synth}
    ENV_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/synth/synth.env
    UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/synth.service
    SERVICE_USER=""
  fi
  PLIST=""
  LOGS_DIR=""
else
  PREFIX=${PREFIX:-$HOME/Library/Application Support/Synth}
  APP_DIR="$PREFIX/current"
  CURRENT="$PREFIX/current"
  SYNTH_HOME=${SYNTH_HOME:-$PREFIX}
  ENV_FILE="$PREFIX/synth.env"
  UNIT=""
  SERVICE_USER=""
  PLIST="$HOME/Library/LaunchAgents/ru.itphx.synth.plist"
  LOGS_DIR="$HOME/Library/Logs/Synth"
  if [ -d "$HOME/bin" ] && [ -w "$HOME/bin" ]; then
    LAUNCHER="$HOME/bin/synth"
  elif [ -w /usr/local/bin ]; then
    LAUNCHER=/usr/local/bin/synth
  else
    LAUNCHER="$HOME/bin/synth"
  fi
fi

info "Удаление Synth ($MODE)"
info "  приложение: $APP_DIR (symlink current)"
info "  launcher:   $LAUNCHER"
info "  данные:     $SYNTH_HOME ($([ "$PURGE" -eq 1 ] && echo 'будут удалены' || echo 'сохраняются'))"

# Остановка сервиса.
if [ "$KEEP_RUNNING" -eq 0 ]; then
  if [ -n "$UNIT" ] && command -v systemctl >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
    if [ "$MODE" = system ]; then
      systemctl disable --now synth.service >/dev/null 2>&1 || true
    else
      systemctl --user disable --now synth.service >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "${PLIST:-}" ] && [ "$DRY_RUN" -eq 0 ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload -w "$PLIST" >/dev/null 2>&1 || true
  fi
fi

# Unit / LaunchAgent.
if [ -n "$UNIT" ]; then
  if [ -f "$UNIT" ]; then
    if grep -qF "$UNIT_MARKER" "$UNIT" 2>/dev/null; then
      run rm -f "$UNIT"
      if command -v systemctl >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
        if [ "$MODE" = system ]; then systemctl daemon-reload >/dev/null 2>&1 || true; else systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
      fi
    else
      warn "unit $UNIT создан не offline-установщиком — не удаляю"
    fi
  fi
fi
if [ -n "${PLIST:-}" ] && [ -f "$PLIST" ]; then
  run rm -f "$PLIST"
fi

# Launcher — только если он наш.
if [ -f "$LAUNCHER" ]; then
  if grep -qF "$LAUNCHER_MARKER" "$LAUNCHER" 2>/dev/null; then
    run rm -f "$LAUNCHER"
  else
    warn "launcher $LAUNCHER создан не offline-установщиком — не удаляю"
  fi
fi

# Приложение: удаляем текущую версию и symlink current.
if [ -L "$CURRENT" ] || [ -d "$CURRENT" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -L "$CURRENT" ]; then
      VERSION_DIR=$(readlink "$CURRENT" || true)
      [ -n "$VERSION_DIR" ] && printf '[dry-run] rm -rf %s\n' "$VERSION_DIR"
    fi
    run rm -f "$CURRENT"
  else
    if [ -L "$CURRENT" ]; then
      VERSION_DIR=$(readlink "$CURRENT" || true)
      rm -f "$CURRENT"
      if [ -n "$VERSION_DIR" ] && [ -d "$VERSION_DIR" ]; then
        case "$(cd "$VERSION_DIR" && pwd)" in
          "$(cd "$(dirname "$CURRENT")" && pwd)"/*) rm -rf "$VERSION_DIR" ;;
          *) warn "symlink current указывает вне каталога установки ($VERSION_DIR) — не удаляю" ;;
        esac
      fi
    else
      rm -rf "$CURRENT"
    fi
  fi
fi

# Пустой каталог установки (Linux user: lib/synth; system: /opt/synth).
if [ "$MODE" = system ]; then
  if [ -d "$PREFIX" ] && [ -z "$(ls -A "$PREFIX" 2>/dev/null)" ]; then
    run rmdir "$PREFIX" || true
  fi
else
  if [ "$DRY_RUN" -eq 0 ]; then
    rmdir "$(dirname "$CURRENT")" 2>/dev/null || true
  fi
fi

# Данные/конфиг — только с --purge.
if [ "$PURGE" -eq 1 ]; then
  case "$SYNTH_HOME" in
    ''|/|"$HOME"|"${HOME%/}")
      die "отказ удалять данные: недопустимый home '$SYNTH_HOME' (укажите конкретный --home)" ;;
  esac
  info "удаляю данные: $SYNTH_HOME"
  run rm -rf "$SYNTH_HOME"
  if [ -n "$ENV_FILE" ]; then
    run rm -f "$ENV_FILE"
    run rmdir "$(dirname "$ENV_FILE")" 2>/dev/null || true
  fi
  if [ -n "${LOGS_DIR:-}" ]; then run rm -rf "$LOGS_DIR"; fi
  if [ -n "$SERVICE_USER" ] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
    info "системный пользователь $SERVICE_USER оставлен (удалите вручную при необходимости)"
  fi
else
  info "данные сохранены: $SYNTH_HOME"
  info "env-файл сохранён: $ENV_FILE"
  [ -n "${LOGS_DIR:-}" ] && info "логи сохранены: $LOGS_DIR"
  info "для полного удаления повторите с --purge"
fi

info "Готово."
