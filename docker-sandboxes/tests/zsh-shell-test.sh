#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v zsh >/dev/null 2>&1; then
  printf '%s\n' 'SKIP: zsh shell runtime tests (zsh unavailable)'
  exit 0
fi
ZSH_BIN="$(command -v zsh)"
TEST_DIR="$(mktemp -d /tmp/sbx-zsh-test.XXXXXX)"
trap 'rm -rf -- "$TEST_DIR"' EXIT

# Use the full managed rc with a stub Oh My Zsh, no downloads or user dotfiles.
# Omit ~/.local/bin initially and create it only after the shell has started.
mkdir -p "$TEST_DIR/home with spaces/.oh-my-zsh"
: > "$TEST_DIR/home with spaces/.oh-my-zsh/oh-my-zsh.sh"
HOME="$TEST_DIR/home with spaces" PATH=/usr/bin:/bin \
  "$ZSH_BIN" -f -s "$ROOT_DIR/kits/zsh-shell/files/home/.zshrc" <<'ZSH'
    fail() { print -u2 -- "FAIL: $*"; exit 1; }
    source "$1"
    source "$1"
    local_bin="$HOME/.local/bin"
    [[ ${path[1]} == "$local_bin" ]] || fail "user-local bin is not on PATH"
    count=0
    for entry in $path; do
      [[ "$entry" == "$local_bin" ]] && (( count += 1 ))
    done
    (( count == 1 )) || fail "reloading duplicated the user-local PATH entry"
    /bin/sh -c 'test "${PATH%%:*}" = "$HOME/.local/bin"' \
      || fail "PATH was not exported to installers"

    # Prime the command cache before installation, as an existing shell does.
    hash -r
    hash -f
    [[ -z ${commands[claude]:-} ]] || fail "fixture unexpectedly found Claude"
    claude 2> "$HOME/missing-error"
    [[ $? == 127 ]] || fail "missing Claude did not return 127"
    grep -Fxq "claude: command not found" "$HOME/missing-error" \
      || fail "missing Claude did not report a useful error"

    mkdir -p "$local_bin"
    print -rl -- '#!/bin/sh' 'printf "arg=<%s>\n" "$@"' \
      'exit 23' > "$local_bin/claude"
    chmod +x "$local_bin/claude"
    claude "argument with spaces" --version > "$HOME/claude-output"
    [[ $? == 23 ]] || fail "late-installed Claude was not run or lost its exit code"
    grep -Fxq "arg=<argument with spaces>" "$HOME/claude-output" \
      || fail "Claude argument boundaries were lost"
    grep -Fxq "arg=<--version>" "$HOME/claude-output" \
      || fail "Claude flags were lost"

    # Removing or replacing the command must not leave a stale cached launch.
    hash -f
    rm "$local_bin/claude"
    claude 2> "$HOME/missing-error"
    [[ $? == 127 ]] || fail "removed Claude did not return 127"
    print -rl -- "#!/bin/sh" "exit 24" > "$local_bin/claude"
    chmod +x "$local_bin/claude"
    claude
    [[ $? == 24 ]] || fail "reinstalled Claude was not discovered"
ZSH

printf '%s\n' 'PASS: zsh user-local PATH and late-installed Claude launcher'
