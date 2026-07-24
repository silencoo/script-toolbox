# Enter the primary sbx workspace through a short, stable logical path.
#
# Kit startup commands may still be running when the shell entrypoint starts,
# so create the link here synchronously instead of relying on startup ordering.
_sbx_workspace_file="$HOME/.config/sbx-manager/workspace"
_sbx_workspace_link_ready=0

if [[ -r "$_sbx_workspace_file" ]]; then
  IFS= read -r _sbx_workspace_target < "$_sbx_workspace_file"

  if [[ -n "$_sbx_workspace_target" && -d "$_sbx_workspace_target" ]]; then
    if [[ -L "$HOME/workspace" ]]; then
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
fi

unset _sbx_workspace_file _sbx_workspace_link_ready \
  _sbx_workspace_target _sbx_workspace_physical _sbx_pwd_physical
