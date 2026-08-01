# Show a concise environment summary once for each interactive sandbox entry.
# Create ~/.hushlogin to suppress it.
if [[ ! -o interactive || -n ${SBX_MOTD_SHOWN:-} \
    || -e "$HOME/.hushlogin" ]]; then
  return 0
fi
export SBX_MOTD_SHOWN=1

typeset _sbx_motd_cyan='' _sbx_motd_blue='' _sbx_motd_bold=''
typeset _sbx_motd_dim='' _sbx_motd_reset=''
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  _sbx_motd_cyan=$'\e[36m'
  _sbx_motd_blue=$'\e[34m'
  _sbx_motd_bold=$'\e[1m'
  _sbx_motd_dim=$'\e[2m'
  _sbx_motd_reset=$'\e[0m'
fi

_sbx_motd_row() {
  printf '%s|%s %s%-10s%s %s\n' \
    "$_sbx_motd_cyan" "$_sbx_motd_reset" \
    "$_sbx_motd_blue" "$1" "$_sbx_motd_reset" "$2"
}

typeset _sbx_motd_time _sbx_motd_user _sbx_motd_host
typeset _sbx_motd_os _sbx_motd_kernel _sbx_motd_workspace
typeset _sbx_motd_terminal _sbx_motd_cpu _sbx_motd_memory
typeset _sbx_motd_disk _sbx_motd_resources
typeset -a _sbx_motd_resource_parts _sbx_motd_tools

_sbx_motd_time="$(date '+%Y-%m-%d %H:%M:%S %Z')"
_sbx_motd_user="${USER:-$(id -un 2>/dev/null || print -r -- unknown)}"
_sbx_motd_host="${HOST:-$(hostname 2>/dev/null || print -r -- sandbox)}"
_sbx_motd_os="$(
  if [[ -r /etc/os-release ]]; then
    . /etc/os-release
    print -r -- "${PRETTY_NAME:-Linux}"
  else
    uname -s
  fi
)"
_sbx_motd_kernel="$(uname -r 2>/dev/null || print -r -- unknown)"
_sbx_motd_kernel="${_sbx_motd_kernel} / $(
  uname -m 2>/dev/null || print -r -- unknown
)"
_sbx_motd_workspace="${PWD/#$HOME/~}"
_sbx_motd_terminal="${TERM:-unknown}"
if [[ -n ${COLORTERM:-} ]]; then
  _sbx_motd_terminal="${_sbx_motd_terminal} / ${COLORTERM}"
fi

_sbx_motd_cpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || :)"
if [[ -n "$_sbx_motd_cpu" ]]; then
  _sbx_motd_resource_parts+=("${_sbx_motd_cpu} CPU")
fi
if [[ -r /proc/meminfo ]]; then
  _sbx_motd_memory="$(
    awk '/^MemTotal:/ {
      gib = $2 / 1024 / 1024
      if (gib >= 10) printf "%.0f GiB", gib
      else printf "%.1f GiB", gib
      exit
    }' /proc/meminfo
  )"
  [[ -n "$_sbx_motd_memory" ]] \
    && _sbx_motd_resource_parts+=("${_sbx_motd_memory} RAM")
fi
_sbx_motd_disk="$(
  df -hP "$PWD" 2>/dev/null \
    | awk 'NR == 2 { print $4 " free of " $2; exit }'
)"
[[ -n "$_sbx_motd_disk" ]] \
  && _sbx_motd_resource_parts+=("${_sbx_motd_disk} disk")
_sbx_motd_resources="${(j: | :)_sbx_motd_resource_parts}"

for _sbx_motd_tool in nvim btop tmux agentctl mcpctl promptctl skillsctl; do
  (( $+commands[$_sbx_motd_tool] )) \
    && _sbx_motd_tools+=("$_sbx_motd_tool")
done

printf '\n%s+--%s %sDocker Sandbox%s %s----------------------------------------%s\n' \
  "$_sbx_motd_cyan" "$_sbx_motd_reset" \
  "$_sbx_motd_bold" "$_sbx_motd_reset" \
  "$_sbx_motd_dim" "$_sbx_motd_reset"
_sbx_motd_row 'Time' "$_sbx_motd_time"
_sbx_motd_row 'User' "${_sbx_motd_user}@${_sbx_motd_host}"
_sbx_motd_row 'System' "$_sbx_motd_os"
_sbx_motd_row 'Kernel' "$_sbx_motd_kernel"
[[ -n "$_sbx_motd_resources" ]] \
  && _sbx_motd_row 'Resources' "$_sbx_motd_resources"
_sbx_motd_row 'Shell' "zsh ${ZSH_VERSION}"
_sbx_motd_row 'Terminal' "$_sbx_motd_terminal"
_sbx_motd_row 'Workspace' "$_sbx_motd_workspace"
if (( ${#_sbx_motd_tools} > 0 )); then
  _sbx_motd_row 'Tools' "${(j: :)_sbx_motd_tools}"
fi
_sbx_motd_row 'Host font' 'Use a Nerd Font for eza file icons.'
_sbx_motd_row 'Fallback' 'eza --icons=never'
printf '%s+---------------------------------------------------------------%s\n\n' \
  "$_sbx_motd_cyan" "$_sbx_motd_reset"

unfunction _sbx_motd_row
unset _sbx_motd_cyan _sbx_motd_blue _sbx_motd_bold
unset _sbx_motd_dim _sbx_motd_reset _sbx_motd_time
unset _sbx_motd_user _sbx_motd_host _sbx_motd_os _sbx_motd_kernel
unset _sbx_motd_workspace _sbx_motd_terminal _sbx_motd_cpu
unset _sbx_motd_memory _sbx_motd_disk _sbx_motd_resources
unset _sbx_motd_resource_parts _sbx_motd_tools _sbx_motd_tool
