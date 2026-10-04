#!/usr/bin/env bash
# Configure the current user's Homebrew-backed Zsh terminal environment.
# Package installation belongs to setup.sh; this helper only manages .zshrc.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$script_dir/zshrc.zsh"
target="${ZDOTDIR:-$HOME}/.zshrc"
begin='# >>> script-toolbox macOS terminal >>>'
end='# <<< script-toolbox macOS terminal <<<'
candidate=''
dry_run=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
  if [[ -n "$candidate" && -f "$candidate" ]]; then rm -f -- "$candidate"; fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --help|-h)
      printf 'Usage: %s [--dry-run]\n' "${0##*/}"
      printf 'Configure Starship, Zsh plugins, navigation, completion, and aliases in %s.\n' "$target"
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ -r "$template" ]] || die "Zsh template not found: $template"
command -v zsh >/dev/null 2>&1 || die 'Zsh is required to validate shell configuration.'
if [[ "$dry_run" -eq 1 ]]; then
  printf 'Would update a managed terminal block in %s, preserving other settings and backing up changes.\n' "$target"
  exit 0
fi

# Resolve file symlinks so dotfile-managed .zshrc links stay intact.
link_count=0
while [[ -L "$target" ]]; do
  link_count=$((link_count + 1))
  [[ "$link_count" -le 40 ]] || die 'Too many links while resolving .zshrc.'
  link="$(readlink "$target")"
  case "$link" in
    /*) target="$link" ;;
    *) target="$(dirname "$target")/$link" ;;
  esac
done
if [[ -e "$target" && ! -f "$target" ]]; then die "Not a regular shell configuration: $target"; fi
mkdir -p "$(dirname "$target")"
candidate="$(mktemp "$(dirname "$target")/.zshrc.toolbox.XXXXXX")"
source_file=/dev/null
if [[ -f "$target" ]]; then
  source_file="$target"
  cp -p "$target" "$candidate"
fi

# Replace only our block, keeping user content and avoiding accumulating blanks.
if ! awk -v begin="$begin" -v end="$end" '
  $0 == begin {
    if (inside || starts++) { bad = 1; exit 1 }
    inside = 1
    next
  }
  $0 == end {
    if (!inside) { bad = 1; exit 1 }
    inside = 0
    next
  }
  inside { next }
  /^[[:space:]]*$/ { blanks[++count] = $0; next }
  {
    for (i = 1; i <= count; i++) print blanks[i]
    count = 0
    print
  }
  END { if (inside || bad) exit 1 }
' "$source_file" > "$candidate"; then
  die 'The existing terminal block has unmatched or duplicate markers; .zshrc was preserved.'
fi
if [[ -s "$candidate" ]]; then printf '\n' >> "$candidate"; fi
printf '%s\n' "$begin" >> "$candidate"
cat "$template" >> "$candidate"
printf '%s\n' "$end" >> "$candidate"

if ! zsh -n "$candidate"; then
  die 'Zsh rejected the configuration; .zshrc was preserved.'
fi
if [[ -f "$target" ]] && cmp -s "$target" "$candidate"; then
  printf 'OK   Zsh terminal configuration is already current\n'
  exit 0
fi
if [[ -f "$target" ]]; then
  backup="$target.bak.$(date +%Y%m%d%H%M%S).$$"
  cp -p "$target" "$backup"
  printf 'Backup: %s\n' "$backup"
fi
mv "$candidate" "$target"
candidate=''
printf 'OK   Configured Zsh terminal tools in %s\n' "$target"
printf 'Open a new Ghostty window or run: exec zsh -l\n'
