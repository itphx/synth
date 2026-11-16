# Тема Oh My Zsh `synth` — основана на `eof` (без имени хоста/пользователя).

# Colors: black red green yellow blue magenta cyan white
# Symbols: ✔ ✖ ☀ ↓ ↑ ? ⚒ ♻

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

# Путь в промпте: короткий (`%c` — последний каталог) по умолчанию, полный
# (`%~`) — при `ZSH_THEME_SYNTH_PATH=full`. Хоста и пользователя нет.
if [[ "${ZSH_THEME_SYNTH_PATH:-short}" == "full" ]]; then
  PROMPT='%{$fg[green]%}[%B%{$fg[cyan]%}%~%b%{$fg[green]%}]%(?.%{$fg[green]%}.%{$fg[red]%})%B%#%b '
else
  PROMPT='%{$fg[green]%}[%B%{$fg[cyan]%}%c%b%{$fg[green]%}]%(?.%{$fg[green]%}.%{$fg[red]%})%B%#%b '
fi

# Git-статус справа — плагин `git-prompt` (`git_super_status`); подстановка
# команды в промпте требует `prompt_subst`.
setopt prompt_subst
RPROMPT='$(git_super_status)'
