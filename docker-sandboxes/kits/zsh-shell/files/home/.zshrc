# Managed by the sbx-manager zsh-shell kit.
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME=""
zstyle ':omz:update' mode disabled

# Completion directories must be on fpath before Oh My Zsh initializes compinit.
fpath=(
  "$HOME/.config/sbx-manager/completions"
  /usr/local/share/zsh/site-functions
  "$ZSH/custom/plugins/zsh-completions/src"
  $fpath
)

plugins=(
  git
  sudo
  zsh-autosuggestions
  zsh-syntax-highlighting
)

source "$ZSH/oh-my-zsh.sh"

# Preserve UTF-8 filenames literally in completion lists. The kit also sets a
# UTF-8 locale before zsh starts so the line editor treats them as characters.
setopt print_eight_bit

# Docker sbx preserves the host's absolute workspace path inside the VM. This
# helper creates ~/workspace synchronously, then enters it as a logical path.
if [[ -r "$HOME/.config/sbx-manager/enter-workspace.zsh" ]]; then
  source "$HOME/.config/sbx-manager/enter-workspace.zsh"
fi

# Both the Bash and PowerShell managers install this shared entry banner.
if [[ -r "$HOME/.config/sbx-manager/show-motd.zsh" ]]; then
  source "$HOME/.config/sbx-manager/show-motd.zsh"
fi

# Persistent, shared command history.
HISTFILE="$HOME/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000
setopt append_history
setopt share_history
setopt hist_ignore_dups
setopt hist_find_no_dups
setopt hist_reduce_blanks

# Offer the explicit bypass command through zsh-autosuggestions without making
# it an alias or default. Claude's bypass mode is only appropriate here because
# the command runs inside an isolated sandbox.
_sbx_claude_bypass='claude --dangerously-skip-permissions'
if ! grep -Fqx -- "$_sbx_claude_bypass" "$HISTFILE" 2>/dev/null; then
  print -r -- "$_sbx_claude_bypass" >> "$HISTFILE"
  fc -R "$HISTFILE"
fi
unset _sbx_claude_bypass

# Selectable, case-insensitive completion menu.
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
zstyle ':completion:*' group-name ''

# Modern ls aliases. Use `command ls` when the POSIX implementation is needed.
if (( $+commands[eza] )); then
  alias ls='eza --group-directories-first --icons=auto'
  alias l='eza --group-directories-first --icons=auto'
  alias ll='eza --long --all --header --git --group-directories-first --icons=auto'
  alias la='eza --all --group-directories-first --icons=auto'
  alias lt='eza --tree --level=2 --group-directories-first --icons=auto'
fi

# fzf uses fd for fast hidden-file traversal and bat/eza for previews.
if (( $+commands[fzf] )); then
  export FZF_DEFAULT_OPTS='--height=45% --layout=reverse --border --info=inline'
  export FZF_CTRL_T_OPTS="--preview 'bat --color=always --style=numbers --line-range=:200 {} 2>/dev/null || eza --tree --level=2 --color=always {} 2>/dev/null'"
  export FZF_ALT_C_OPTS="--preview 'eza --tree --level=2 --color=always {} 2>/dev/null'"

  if (( $+commands[fd] )); then
    export FZF_DEFAULT_COMMAND='fd --type f --hidden --follow --exclude .git'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
    export FZF_ALT_C_COMMAND='fd --type d --hidden --follow --exclude .git'

    _fzf_compgen_path() {
      fd --hidden --follow --exclude .git . "$1"
    }
    _fzf_compgen_dir() {
      fd --type d --hidden --follow --exclude .git . "$1"
    }
  fi

  # Debian and Ubuntu package the upstream shell integration here.
  [[ -r /usr/share/doc/fzf/examples/completion.zsh ]] \
    && source /usr/share/doc/fzf/examples/completion.zsh
  [[ -r /usr/share/doc/fzf/examples/key-bindings.zsh ]] \
    && source /usr/share/doc/fzf/examples/key-bindings.zsh
fi

# Kaku-like Smart Tab: accept ghost text, then delegate to fzf/native completion.
_sbx_smart_tab() {
  if [[ -n "$POSTDISPLAY" ]]; then
    zle autosuggest-accept
  elif (( $+widgets[fzf-completion] )); then
    zle fzf-completion
  else
    zle expand-or-complete
  fi
}
zle -N _sbx_smart_tab
bindkey '^I' _sbx_smart_tab
bindkey '^[[Z' reverse-menu-complete

# `z keyword` jumps to a frequently used directory; `zi` opens fzf selection.
if (( $+commands[zoxide] )); then
  eval "$(zoxide init zsh)"
fi

# Initialize the prompt last so it can replace Oh My Zsh's basic prompt.
if (( $+commands[starship] )); then
  eval "$(starship init zsh)"
fi
