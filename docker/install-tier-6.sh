#!/bin/sh
# install-tier-6.sh — tier 6 toolchain'а: терминальный набор (zsh + tmux + OMZ).
#
# Назначение — рабочее место человека в терминале исполнителя (веб-терминал
# Synth): предсказуемый shell с Oh My Zsh, tmux для привычного workflow,
# терминалы ncurses, редактор и утилиты процесса.
#
# Ставится ТОЛЬКО в образ исполнителя (`docker/Dockerfile.executor`, стадии
# `core` и `full` — от `core` наследуются `dev`/`devops`). Образы
# all-in-one/backend не меняются: базовый состав других образов не трогаем.
#
# `browser` тир НЕ ставит: PTY в браузерном пуле нет (`SYNTH_EXECUTOR_PTY=0`),
# а терминал без PTY не нужен (zsh приходит в `full`, он наследует `browser`).
#
# Состав тира (PROP-082-стиль: логика одна, различаются только имена пакетов):
#
#   logical        | apk                    | apt
#   ---------------+------------------------+------------------
#   zsh            | zsh                    | zsh
#   tmux           | tmux                   | tmux
#   ncurses-term   | ncurses-terminfo       | ncurses-term
#   ncurses-base   | ncurses-terminfo-base  | ncurses-base
#   procps         | procps-ng              | procps
#   vim            | vim                    | vim-tiny
#
# Отличия имён:
#   * ncurses: в alpine терминалы разделены на `ncurses-terminfo-base`
#     (базовый набор) и `ncurses-terminfo` (расширенный) — в debian это
#     `ncurses-base` и `ncurses-term` соответственно;
#   * procps: в alpine пакет называется `procps-ng` (тот же состав, что
#     `procps` в debian: `ps`, `top`, `kill`, `free`);
#   * vim: в alpine отдельного `vim-tiny` нет — пакет `vim` (сборка без GUI);
#     в debian `vim-tiny` ставит бинарь `vim.tiny` (и `vi` через
#     alternatives), но НЕ `vim` — совместимый симлинк заводим ниже
#     (продуктовое окружение обещает `EDITOR=vim`).
#
# `tree` и `less` в этом тире НЕ повторяются: они уже стоят в tier 0
# (`docker/install-tier-0.sh`) — дублировать установку нельзя.
#
# Oh My Zsh: репозиторий `ohmyzsh/ohmyzsh` **не публикует git-тегов**
# (проверено: `git ls-remote --tags https://github.com/ohmyzsh/ohmyzsh` —
# пусто), поэтому версия закрепляется КОММИТОМ (`OMZ_REF`, 40 hex) —
# значение живёт в `ARG OMZ_REF` образа (docker/Dockerfile.executor).
# Тега для `git clone --branch` нет, а `--branch <sha>` git не принимает,
# поэтому ставим shallow-фетчем по SHA (`git fetch --depth 1 origin <sha>`)
# и проверяем, что HEAD совпал с пином (fail-closed).
#
# Сам OMZ в репозиторий НЕ вендорится (9.7 МБ) — качается на этапе сборки.
#
# Тема `synth` — наоборот, вендорится (`docker/executor/themes/synth.zsh-theme`,
# ~1.5 КБ, основана на `eof` из git.itphx.ru/eka/.dots): иначе сборка зависела
# бы от доступа к личному Gitea. Файл копируется в эту же директорию рядом со
# скриптом (см. COPY в `docker/Dockerfile.executor`).

set -eu

# CDPATH= — префиксное присваивание для одной команды, пробел обязателен.
# shellcheck disable=SC1007
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=install-lib.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/install-lib.sh"

# ---------------------------------------------------------------------------
# Состав тира
# ---------------------------------------------------------------------------
TIER_6='
zsh|zsh|zsh
tmux|tmux|tmux
ncurses-term|ncurses-terminfo|ncurses-term
ncurses-base|ncurses-terminfo-base|ncurses-base
procps|procps-ng|procps
vim|vim|vim-tiny
'

synth_install_tier "$TIER_6"

# ---------------------------------------------------------------------------
# Совместимость `vim` (debian)
# ---------------------------------------------------------------------------
#
# `vim-tiny` в debian даёт `/usr/bin/vim.tiny` и `vi` (через alternatives),
# но не `vim`. Продуктовое окружение и `/etc/synth/zshrc` обещают
# `EDITOR=vim` (например, `git commit` без `-m` зовёт редактор по `EDITOR`),
# поэтому в debian-ветке заводим совместимый симлинк. В alpine пакет `vim`
# кладёт `/usr/bin/vim` сам — там ничего не делаем.
case "$(synth_pkg_manager)" in
    apk)
        :
        ;;
    apt-get)
        if [ ! -e /usr/bin/vim ] && [ -e /usr/bin/vim.tiny ]; then
            ln -s /usr/bin/vim.tiny /usr/bin/vim
            echo "install-tier-6.sh: /usr/bin/vim → /usr/bin/vim.tiny (совместимость EDITOR=vim)"
        fi
        ;;
esac

# ---------------------------------------------------------------------------
# Oh My Zsh — установка по закреплённому коммиту
# ---------------------------------------------------------------------------
#
# `ca-certificates` (нужен для TLS-фетча) ставится в hard deps
# (`docker/install-hard-deps.sh`) — этот тир идёт ПОСЛЕ него.
OMZ_DIR=/opt/oh-my-zsh
OMZ_URL=https://github.com/ohmyzsh/ohmyzsh

if [ -z "${OMZ_REF:-}" ]; then
    echo "install-tier-6.sh: OMZ_REF обязателен — версия Oh My Zsh закрепляется коммитом (репозиторий не публикует git-тегов)" >&2
    exit 1
fi

# Пин — ровно 40 hex-символов (идентификатор коммита git).
if [ "${#OMZ_REF}" -ne 40 ]; then
    echo "install-tier-6.sh: OMZ_REF должен быть 40-hex коммитом (тегов у ohmyzsh нет): $OMZ_REF" >&2
    exit 1
fi
case "$OMZ_REF" in
    *[!0-9a-f]*)
        echo "install-tier-6.sh: OMZ_REF должен быть 40-hex коммитом (тегов у ohmyzsh нет): $OMZ_REF" >&2
        exit 1
        ;;
esac

echo "install-tier-6.sh: Oh My Zsh — коммит $OMZ_REF"
rm -rf "$OMZ_DIR"
mkdir -p "$OMZ_DIR"
# `git clone --branch` здесь не годится: тегов нет, а `--branch <sha>` git не
# принимает (это имя ветки/тега). Поэтому — инициализация + shallow-фетч по
# SHA: содержимое проверяется самим git'ом по идентификатору объекта.
git init -q "$OMZ_DIR"
git -C "$OMZ_DIR" remote add origin "$OMZ_URL"
git -C "$OMZ_DIR" fetch --depth 1 origin "$OMZ_REF"
git -C "$OMZ_DIR" checkout --detach FETCH_HEAD

omz_actual=$(git -C "$OMZ_DIR" rev-parse HEAD)
if [ "$omz_actual" != "$OMZ_REF" ]; then
    echo "install-tier-6.sh: НЕСОВПАДЕНИЕ коммита Oh My Zsh" >&2
    echo "  ожидалось: $OMZ_REF" >&2
    echo "  получено : $omz_actual" >&2
    exit 1
fi

# `.git` в образе не нужен: обновления OMZ выключены
# (`zstyle ':omz:update' mode disabled` + `DISABLE_AUTO_UPDATE=true`),
# а история только раздувает образ.
rm -rf "$OMZ_DIR/.git"
chmod -R a+rX "$OMZ_DIR"
echo "install-tier-6.sh: Oh My Zsh установлен в $OMZ_DIR ($omz_actual)"

# Тема `synth` вендорится в репозиторий (docker/executor/themes/synth.zsh-theme)
# и копируется в этой же директории рядом со скриптом. Нет файла — ошибка
# сборки (образ без темы не годен: zshrc ссылается на неё).
THEME_SRC="$SCRIPT_DIR/synth.zsh-theme"
if [ ! -f "$THEME_SRC" ]; then
    echo "install-tier-6.sh: не найден synth.zsh-theme рядом со скриптом ($THEME_SRC)" >&2
    exit 1
fi
mkdir -p "$OMZ_DIR/custom/themes"
cp "$THEME_SRC" "$OMZ_DIR/custom/themes/synth.zsh-theme"
chmod 0644 "$OMZ_DIR/custom/themes/synth.zsh-theme"

# ---------------------------------------------------------------------------
# Проверки состава (fail-closed: образ без этого не годен)
# ---------------------------------------------------------------------------

# tmux ≥ 3.3 — «tmux-256color» и `terminal-features` появились в 3.2/3.3.
tmux_version=$(tmux -V | awk '{print $2}')
tmux_major=$(printf '%s' "$tmux_version" | sed -n 's/^\([0-9][0-9]*\)\..*/\1/p')
tmux_minor=$(printf '%s' "$tmux_version" | sed -n 's/^[0-9][0-9]*\.\([0-9][0-9]*\).*/\1/p')
if [ -z "$tmux_major" ] || [ -z "$tmux_minor" ]; then
    echo "install-tier-6.sh: не удалось разобрать версию tmux: '$tmux_version'" >&2
    exit 1
fi
if [ "$tmux_major" -lt 3 ] || { [ "$tmux_major" -eq 3 ] && [ "$tmux_minor" -lt 3 ]; }; then
    echo "install-tier-6.sh: нужен tmux ≥ 3.3, в образе $tmux_version" >&2
    exit 1
fi
echo "install-tier-6.sh: tmux $tmux_version (≥ 3.3)"

# zsh и редактор — обязательны для терминала.
if ! command -v zsh >/dev/null 2>&1; then
    echo "install-tier-6.sh: zsh не установлен" >&2
    exit 1
fi
if ! command -v vim >/dev/null 2>&1; then
    echo "install-tier-6.sh: редактор vim не найден (нужен EDITOR=vim)" >&2
    exit 1
fi
if ! command -v ps >/dev/null 2>&1; then
    echo "install-tier-6.sh: ps не найден (нужен procps)" >&2
    exit 1
fi

# Терминал `tmux-256color`: начиная с tmux 3.2 он встроен в сам tmux, но
# проверяем наличие terminfo — если `infocmp` есть в образе.
if command -v infocmp >/dev/null 2>&1; then
    if ! infocmp tmux-256color >/dev/null 2>&1; then
        echo "install-tier-6.sh: terminfo tmux-256color не найден" >&2
        exit 1
    fi
    echo "install-tier-6.sh: terminfo tmux-256color — OK"
fi

if [ ! -f "$OMZ_DIR/custom/themes/synth.zsh-theme" ]; then
    echo "install-tier-6.sh: тема synth не установлена" >&2
    exit 1
fi

echo "install-tier-6.sh: терминальный тир установлен"
