# Тема Oh My Zsh `eof`.
#
# Источник: git.itphx.ru/eka/.dots (`zsh/custom/themes/eof.zsh-theme`, MIT —
# каталог `zsh/` этого репозитория является форком ohmyzsh/ohmyzsh).
# Зависит от плагина `git-prompt` (включён в `/etc/synth/zshrc`).

# Colors: black red green yellow blue magenta cyan white
# Symbols: … ● ✔ ✖ ↓ ↑ ➜ ☀ ♻ ⚒

ZSH_THEME_GIT_PROMPT_PREFIX="%{$reset_color%}%{$fg[green]%}["
ZSH_THEME_GIT_PROMPT_SUFFIX="%{$fg[green]%}]%{$reset_color%}"
ZSH_THEME_GIT_PROMPT_SEPARATOR=" "
ZSH_THEME_GIT_PROMPT_BRANCH="%{$fg_bold[green]%}"
ZSH_THEME_GIT_PROMPT_STAGED="%{$fg[white]%}%{⚒%G%}"
ZSH_THEME_GIT_PROMPT_CONFLICTS="%{$fg[red]%}%{✖%G%}"
ZSH_THEME_GIT_PROMPT_CHANGED="%{$fg[yellow]%}%{☀%G%}"
ZSH_THEME_GIT_PROMPT_BEHIND="%{$fg[white]%}%{↓%G%}"
ZSH_THEME_GIT_PROMPT_AHEAD="%{$fg[white]%}%{↑%G%}"
ZSH_THEME_GIT_PROMPT_UNTRACKED="%{$fg[blue]%}%{?%G%}"
ZSH_THEME_GIT_PROMPT_CLEAN="%{$fg[green]%}%{✔%G%}"
ZSH_THEME_GIT_PROMPT_DELETED="%{$fg[red]%}♻"

case $ZSH_THEME_EOF_MODE in
  mega)
    ZSH_THEME_EOF_NAMES="%n@%M "
    ;;
  big)
    ZSH_THEME_EOF_NAMES="%n@%m "
    ;;
  small)
    ZSH_THEME_EOF_NAMES="${USER%%@*}@%m "
    ;;
  tiny|*)
    ZSH_THEME_EOF_NAMES=""
    ;;
esac

PROMPT='%{$fg[green]%}[%B%{$fg[green]%}$ZSH_THEME_EOF_NAMES%b%{$fg[cyan]%}%~% %{$fg[green]%}]%(?.%{$fg[green]%}.%{$fg[red]%})%B%#%b '
