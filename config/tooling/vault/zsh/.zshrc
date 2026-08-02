export ZSH="${ZSH:-$HOME/.oh-my-zsh}"
export ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
export PATH="$HOME/.local/bin:$PATH"
export EDITOR="nvim"
export VISUAL="nvim"

plugins=(git python sudo zsh-autosuggestions zsh-syntax-highlighting)

ZSH_THEME=""
[[ -r "$ZSH/oh-my-zsh.sh" ]] && source "$ZSH/oh-my-zsh.sh"

if [[ -o interactive ]] && [[ -t 0 ]] && [[ -t 1 ]]; then
  bindkey '^F' autosuggest-accept
fi

alias vim='nvim'

if [[ -o interactive ]] && [[ -t 0 ]] && [[ -t 1 ]]; then
  PROMPT='%2~ %# '
  RPROMPT=''
fi
