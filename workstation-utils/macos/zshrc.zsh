# Homebrew paths work in login shells and standalone interactive Zsh sessions.
typeset -U path fpath
path=("$HOME/.local/bin" "$HOME/.cargo/bin" $path)
_toolbox_brew_prefix="${HOMEBREW_PREFIX:-}"
if [[ -z "$_toolbox_brew_prefix" ]]; then
  if (( $+commands[brew] )); then
    _toolbox_brew_prefix="$(brew --prefix)"
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    _toolbox_brew_prefix=/opt/homebrew
  elif [[ -x /usr/local/bin/brew ]]; then
    _toolbox_brew_prefix=/usr/local
  fi
fi
if [[ -n "$_toolbox_brew_prefix" ]]; then
  path+=("$_toolbox_brew_prefix/bin" "$_toolbox_brew_prefix/sbin")
  for _toolbox_completion_dir in \
      "$_toolbox_brew_prefix/share/zsh/site-functions" \
      "$_toolbox_brew_prefix/share/zsh-completions"; do
    [[ -d "$_toolbox_completion_dir" ]] && fpath=("$_toolbox_completion_dir" $fpath)
  done
fi

# Retain larger history limits and an existing history file choice.
HISTFILE="${HISTFILE:-${ZDOTDIR:-$HOME}/.zsh_history}"
(( HISTSIZE < 10000 )) && HISTSIZE=10000
(( SAVEHIST < 10000 )) && SAVEHIST=10000
setopt APPEND_HISTORY SHARE_HISTORY HIST_IGNORE_ALL_DUPS HIST_REDUCE_BLANKS
setopt INTERACTIVE_COMMENTS AUTO_CD

autoload -Uz compinit
compinit -i

if (( $+commands[fzf] )) && (( ! $+functions[fzf-history-widget] )); then
  source <(fzf --zsh)
fi
if (( $+commands[zoxide] )) && (( ! $+functions[__zoxide_z] )); then
  eval "$(zoxide init zsh)"
fi
if (( $+commands[starship] )); then
  eval "$(starship init zsh)"
fi
if (( $+commands[uv] )); then
  eval "$(uv generate-shell-completion zsh)"
fi

# Preserve user-defined aliases/functions and any explicit editor setting.
if (( $+commands[nvim] )); then
  export EDITOR="${EDITOR:-nvim}"
  (( $+aliases[vim] || $+functions[vim] )) || alias vim='nvim'
fi
if (( $+commands[eza] )); then
  (( $+aliases[ls] || $+functions[ls] )) || alias ls='eza --icons'
  (( $+aliases[ll] || $+functions[ll] )) || alias ll='eza --icons --long --all --group-directories-first'
  (( $+aliases[la] || $+functions[la] )) || alias la='eza --icons --long --all'
  (( $+aliases[tree] || $+functions[tree] )) || alias tree='eza --icons --tree'
fi
if (( $+commands[bat] )); then
  (( $+aliases[cat] || $+functions[cat] )) || alias cat='bat --paging=never'
fi

if [[ -r "$_toolbox_brew_prefix/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ]] && \
    (( ! $+functions[_zsh_autosuggest_start] )); then
  source "$_toolbox_brew_prefix/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
fi

# Load highlighting after completion, widgets, aliases, and other plugins.
if [[ -r "$_toolbox_brew_prefix/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" ]] && \
    (( ! $+functions[_zsh_highlight] )); then
  source "$_toolbox_brew_prefix/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
fi
unset _toolbox_brew_prefix _toolbox_completion_dir
