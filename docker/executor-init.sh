#!/bin/sh
# executor-init.sh — подготовка окружения исполнителя перед стартом процесса.
#
# Ставится в образ исполнителя как `synth-executor-init` и вызывается вместо
# `synth-init` в CMD (`docker/Dockerfile.executor`):
#
#   ["/bin/sh", "/usr/local/bin/synth-executor-init", "node", "dist/init.js"]
#
# Зачем: продуктовые конфиги терминала лежат в образе (`/etc/synth/zshrc`,
# `/etc/synth/tmux.conf`), а zsh и tmux читают конфигурацию ИЗ `$HOME`
# (`~/.zshrc`, `~/.tmux.conf`). В Kubernetes `$HOME` (`/home/synth`) — это
# `emptyDir` (`readOnlyRootFilesystem`, ADR-137 Ф2): примонтированный том
# СКРЫВАЕТ то, что было в образе по этому пути, поэтому симлинки, заведённые
# на этапе сборки, в рантайме не видны — их надо создать здесь.
#
# Что делает:
#   * `~/.zshrc`    → `/etc/synth/zshrc`    (если файла ещё нет);
#   * `~/.tmux.conf`→ `/etc/synth/tmux.conf` (если файла ещё нет);
#   * каталог кэша OMZ (`$ZSH_CACHE_DIR`) — в writable-`$HOME` его нет:
#     том пустой, а `readOnlyRootFilesystem` не даёт создать его в корне.
#
# Переопределение пользователем: если `~/.zshrc`/`~/.tmux.conf` уже есть
# (пользователь заменил симлинк своим файлом) — ничего не трогаем.
#
# Отказ НЕ фатален: терминальный набор — вспомогательный инструмент, а не
# условие работы исполнителя. Исполнитель стартует в любом случае.
#
# Дальше — `exec synth-init`: PID 1 остаётся reaper'ом (docker/init.sh):
# reaping осиротевших детей умеет только POSIX-оболочка, а не Node.

set -u

home=${HOME:-/home/synth}
cache_dir=${ZSH_CACHE_DIR:-$home/.cache/oh-my-zsh}

log() {
    echo "[executor-init] $*" >&2
}

# Создаёт симлинк, только если цели ещё нет: пользовательский файл важнее.
link_if_absent() {
    target=$1
    source=$2

    if [ -e "$target" ] || [ -L "$target" ]; then
        return 0
    fi
    if [ ! -e "$source" ]; then
        log "источник $source отсутствует — ссылка $target не создана"
        return 0
    fi
    if ln -s "$source" "$target" 2>/dev/null; then
        log "$target → $source"
    else
        log "не удалось создать ссылку $target → $source (каталог не writable?)"
    fi
}

if ! mkdir -p "$cache_dir" 2>/dev/null; then
    log "каталог кэша OMZ $cache_dir недоступен (нет writable \$HOME?)"
fi

link_if_absent "$home/.zshrc" /etc/synth/zshrc
link_if_absent "$home/.tmux.conf" /etc/synth/tmux.conf

exec /usr/local/bin/synth-init "$@"
