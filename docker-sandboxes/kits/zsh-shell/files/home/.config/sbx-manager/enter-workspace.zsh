# Enter the primary sbx workspace through a short, stable logical path. The
# kit-add recreate flow cannot apply commands.startup or commands.initFiles, so
# discover and remember the restored workspace from the first shell entry.
_sbx_workspace_file="$HOME/.config/sbx-manager/workspace"
_sbx_workspace_link_ready=0
_sbx_workspace_target=''

if [[ -r "$_sbx_workspace_file" ]]; then
  IFS= read -r _sbx_workspace_target < "$_sbx_workspace_file"
  [[ -d "$_sbx_workspace_target" ]] || _sbx_workspace_target=''
fi

# Prefer an existing managed link when upgrading a sandbox whose marker is
# missing. Otherwise the shell entrypoint starts in sbx's restored workspace.
if [[ -z "$_sbx_workspace_target" && -L "$HOME/workspace" ]]; then
  _sbx_workspace_target="$HOME/workspace"
  _sbx_workspace_target="${_sbx_workspace_target:A}"
  [[ -d "$_sbx_workspace_target" ]] || _sbx_workspace_target=''
fi
if [[ -z "$_sbx_workspace_target" ]]; then
  _sbx_workspace_physical="${PWD:A}"
  _sbx_home_physical="${HOME:A}"
  if [[ "$_sbx_workspace_physical" != "$_sbx_home_physical" \
      && "$_sbx_workspace_physical" != "$_sbx_home_physical"/* ]]; then
    _sbx_workspace_target="$_sbx_workspace_physical"
  fi
fi

if [[ -n "$_sbx_workspace_target" ]]; then
  mkdir -p "${_sbx_workspace_file:h}"
  print -r -- "$_sbx_workspace_target" >| "$_sbx_workspace_file"

  if [[ -L "$HOME/workspace" ]]; then
    ln -sfn "$_sbx_workspace_target" "$HOME/workspace"
    _sbx_workspace_link_ready=1
  elif [[ -d "$HOME/workspace" ]] \
    && rmdir -- "$HOME/workspace" 2>/dev/null; then
    # The shell base image seeds an empty ~/workspace directory. Replace
    # only an empty directory; rmdir refuses to remove user content.
    ln -sfn "$_sbx_workspace_target" "$HOME/workspace"
    _sbx_workspace_link_ready=1
  elif [[ ! -e "$HOME/workspace" ]]; then
    ln -s "$_sbx_workspace_target" "$HOME/workspace"
    _sbx_workspace_link_ready=1
  fi

  _sbx_workspace_physical="${_sbx_workspace_target:A}"
  _sbx_pwd_physical="${PWD:A}"
  if (( _sbx_workspace_link_ready )) \
    && [[ "$_sbx_pwd_physical" == "$_sbx_workspace_physical" ]]; then
    builtin cd -L "$HOME/workspace"
  fi
fi

unset _sbx_workspace_file _sbx_workspace_link_ready \
  _sbx_workspace_target _sbx_workspace_physical _sbx_home_physical \
  _sbx_pwd_physical
