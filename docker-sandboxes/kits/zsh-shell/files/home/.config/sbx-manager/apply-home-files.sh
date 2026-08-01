#!/bin/sh

# Install a staged zsh-shell home payload after sbx kit add recreates an
# existing sandbox. The current recreate flow does not apply static kit files.
set -eu

stage="${1:-}"
target_dir="${2:-/home/agent}"
agent_uid="${SBX_SHELL_KIT_AGENT_UID:-1000}"

case "$stage" in
  /tmp/sbx-manager-zsh-shell-refresh*) ;;
  *)
    echo "Refusing unsafe shell-kit staging path: $stage" >&2
    exit 1
    ;;
esac

source_dir="$stage/home"
[ -f "$source_dir/.zshrc" ]
[ -f "$source_dir/.config/sbx-manager/zsh-shell.version" ]
mkdir -p "$target_dir"
cp -R "$source_dir/." "$target_dir/"

current_uid="$(id -u)"
if [ "$current_uid" -eq "$agent_uid" ]; then
  agent_user="$(id -un)"
else
  agent_user="$(awk -F: -v target_uid="$agent_uid" '
    $3 == target_uid { print $1; exit }
  ' /etc/passwd)"
fi
if [ -z "$agent_user" ]; then
  echo "Could not find the shell-kit user at UID $agent_uid" >&2
  exit 1
fi
agent_group="$(id -gn "$agent_user")"
if [ "$current_uid" -ne 0 ] && [ "$current_uid" -ne "$agent_uid" ]; then
  echo "Shell-kit home files must be applied by root or UID $agent_uid" >&2
  exit 1
fi

for relative_path in \
  .zshrc \
  .config/starship.toml \
  .config/sbx-manager/apply-home-files.sh \
  .config/sbx-manager/completions/_claude \
  .config/sbx-manager/enter-workspace.zsh \
  .config/sbx-manager/show-motd.zsh \
  .config/sbx-manager/zsh-shell.version
do
  if [ "$current_uid" -eq 0 ]; then
    chown "$agent_user:$agent_group" "$target_dir/$relative_path"
  fi
  case "$relative_path" in
    *.sh) chmod 0755 "$target_dir/$relative_path" ;;
    *) chmod 0644 "$target_dir/$relative_path" ;;
  esac
done

rm -rf -- "$stage"
