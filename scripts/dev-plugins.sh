#!/usr/bin/env bash
#
# dev: установка in-tree плагинов в инстанс (идемпотентно).
#
# Зачем: исполнение кода плагинов включается политикой
# (`plugins.executionEnabled`), но сам плагин должен быть **установлен**
# (lock `{dataDir}/plugin/plugins.lock.json`) и, при вердикте скана
# `caution`, **подтверждён** владельцем — иначе старт-активация (ADR-090)
# его не поднимет. Скрипт приводит инстанс в это состояние перед стартом
# backend: сборка бандла → install/update → approve.
#
# Идемпотентность: install только если записи нет; update — из источника
# lock (тем же путём, что указывали при установке); approve — только если
# бандл ждёт подтверждения. Ошибки не валят dev-запуск: плагин — надстройка,
# память деградирует без него, а не блокирует приложение.
#
# Использование: scripts/dev-plugins.sh [<log-файл>]
#   окружение: SYNTH_DATA_DIR / SYNTH_CONFIG (как у dev.sh)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${1:-/dev/null}"
PLUGIN="synth-plugin-memory"
BUNDLE="$ROOT/packages/plugin-memory"
CLI="$ROOT/packages/synth/dist/cli.js"

log() {
    printf '[plugins] %s\n' "$*"
    printf '[plugins] %s\n' "$*" >>"$LOG" 2>/dev/null || true
}

# Backend запускается с SYNTH_CONFIG (Postgres + прочие настройки), CLI —
# тоже: иначе запись lock уйдёт в файловый backend, а backend будет читать
# пустой PG-lock и «не увидит» плагин.
[ -n "${SYNTH_CONFIG:-}" ] && export SYNTH_CONFIG
export SYNTH_PLUGINS_EXECUTION_ENABLED="${SYNTH_PLUGINS_EXECUTION_ENABLED:-true}"

[ -d "$BUNDLE" ] || {
    log "нет каталога плагина ($BUNDLE) — пропуск"
    exit 0
}

log "сборка $PLUGIN"
if ! pnpm --filter "@itphx/synth-plugin-memory" build >>"$LOG" 2>&1; then
    log "сборка не удалась — плагин останется неактивным"
    exit 0
fi

if [ ! -f "$CLI" ]; then
    log "сборка CLI (@itphx/synth)"
    pnpm --filter "@itphx/synth" build >>"$LOG" 2>&1 || {
        log "CLI не собрался — пропуск"
        exit 0
    }
fi

installed="$(node "$CLI" plugin list --json 2>/dev/null | grep -c "\"$PLUGIN\"" || true)"
if [ "${installed:-0}" = "0" ]; then
    log "установка $PLUGIN"
    node "$CLI" plugin install "$BUNDLE" --trust trusted --yes >>"$LOG" 2>&1 ||
        log "установка не удалась (см. лог)"
else
    log "обновление $PLUGIN из источника lock"
    node "$CLI" plugin update "$PLUGIN" --yes >>"$LOG" 2>&1 ||
        log "обновление не потребовалось/не удалось (см. лог)"
fi

# Подтверждение (ADR-090 п. 9): бандл с вердиктом «caution» лежит в карантине,
# пока владелец не подтвердит content-hash. В dev подтверждаем автоматически —
# это наш собственный in-tree код.
node "$CLI" plugin approve "$PLUGIN" --yes >>"$LOG" 2>&1 ||
    log "подтверждение не требуется (нет ожидающих) — ок"

log "состояние:"
node "$CLI" plugin list 2>/dev/null | tail -n +1 | while IFS= read -r line; do log "  $line"; done
