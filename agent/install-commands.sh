#!/usr/bin/env bash
# Install reversible command links for the four repository-backed controllers.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST_NAME=".script-toolbox-agent-commands"
VERSION="0.1.0"

# shellcheck source=ctl-lib.sh
. "${SCRIPT_DIR}/ctl-lib.sh"

PREFIX="${HOME}/.local/bin"
APPLY=0
DRY_RUN=0
UNINSTALL=0
FORCE=0

usage() {
  cat <<'EOF'
install-commands.sh — expose script-toolbox controllers on PATH

Usage:
  ./agent/install-commands.sh [--prefix <directory>] [--yes] [--force]
  ./agent/install-commands.sh --uninstall [--prefix <directory>] [--yes]

The default run is a preview. Pass --yes to create the agentctl, mcpctl,
promptctl, and skillsctl symlinks. Conflicts are preserved unless --force is supplied; forced
installs move each conflict to a tracked backup that uninstall restores.

Options:
  --prefix <directory>  Link directory (default: ~/.local/bin).
  --yes                 Apply the displayed install/uninstall plan.
  --dry-run             Force preview mode.
  --force               Back up and replace unowned command conflicts.
  --uninstall           Remove owned links and restore tracked conflicts.
  -h, --help            Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -ge 2 ] || die "--prefix requires a directory"
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      [ -n "$PREFIX" ] || die "--prefix requires a directory"
      shift
      ;;
    --yes|-y)
      APPLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -V|--version)
      printf 'install-commands.sh %s\n' "$VERSION"
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (use --help)"
      ;;
  esac
done

[ "$DRY_RUN" != 1 ] || APPLY=0
[ -n "$PREFIX" ] || die "install prefix cannot be empty"
[ "$PREFIX" != "/" ] || die "refusing to use / as the command prefix"
case "$PREFIX" in
  *$'\n'*|*$'\t'*) die "install prefix must not contain tabs or newlines" ;;
esac
case "$PREFIX" in
  /*) ;;
  *) PREFIX="$(pwd)/$PREFIX" ;;
esac
MANIFEST="${PREFIX}/${MANIFEST_NAME}"

COMMAND_NAMES=(agentctl mcpctl promptctl skillsctl)
COMMAND_TARGETS=(
  "${SCRIPT_DIR}/agentctl/agentctl"
  "${SCRIPT_DIR}/mcpctl/mcpctl"
  "${SCRIPT_DIR}/promptctl/promptctl"
  "${SCRIPT_DIR}/skillsctl/skillsctl"
)

validate_manifest() {
  local line_number=0 name="" target="" backup="" extra="" seen="|"
  [ -f "$MANIFEST" ] || return 0
  [ ! -L "$MANIFEST" ] || die "refusing symlinked command manifest: $MANIFEST"

  while IFS=$'\t' read -r name target backup extra ||
        [ -n "${name}${target}${backup}${extra}" ]; do
    line_number=$((line_number + 1))
    if [ "$line_number" -eq 1 ]; then
      [ "$name" = "# script-toolbox-agent-commands v1" ] ||
        die "unrecognized command manifest: $MANIFEST"
      [ -z "${target}${backup}${extra}" ] ||
        die "malformed command manifest header: $MANIFEST"
      continue
    fi
    case "$name" in
      agentctl|mcpctl|promptctl|skillsctl) ;;
      *) die "unexpected command '$name' in $MANIFEST" ;;
    esac
    case "$seen" in
      *"|${name}|"*) die "duplicate command '$name' in $MANIFEST" ;;
    esac
    seen="${seen}${name}|"
    case "$target" in
      /*) ;;
      *) die "non-absolute target for '$name' in $MANIFEST" ;;
    esac
    if [ -n "$backup" ]; then
      case "$backup" in
        "${PREFIX}/${name}.backup."*) ;;
        *) die "unexpected backup path for '$name' in $MANIFEST" ;;
      esac
    fi
    [ -z "$extra" ] || die "malformed row for '$name' in $MANIFEST"
  done < "$MANIFEST"

  [ "$line_number" -ge 1 ] || die "empty command manifest: $MANIFEST"
}

manifest_row() {
  local wanted="$1"
  MANIFEST_TARGET=""
  MANIFEST_BACKUP=""
  [ -f "$MANIFEST" ] || return 0
  MANIFEST_TARGET="$(awk -F '\t' -v wanted="$wanted" '$1 == wanted { print $2; exit }' "$MANIFEST")"
  MANIFEST_BACKUP="$(awk -F '\t' -v wanted="$wanted" '$1 == wanted { print $3; exit }' "$MANIFEST")"
}

install_commands() {
  local index name target link current_target action backup timestamp
  local conflict_count=0 temp_link manifest_temp
  local -a plan_actions plan_backups

  validate_manifest
  index=0
  while [ "$index" -lt "${#COMMAND_NAMES[@]}" ]; do
    name="${COMMAND_NAMES[$index]}"
    target="${COMMAND_TARGETS[$index]}"
    link="${PREFIX}/${name}"
    [ -x "$target" ] || die "controller is missing or not executable: $target"
    manifest_row "$name"
    action="create"
    backup="$MANIFEST_BACKUP"

    if [ -L "$link" ]; then
      current_target="$(readlink "$link")"
      if [ "$current_target" = "$target" ]; then
        action="keep"
      elif [ -n "$MANIFEST_TARGET" ] &&
           [ "$current_target" = "$MANIFEST_TARGET" ]; then
        action="refresh"
      elif [ "$FORCE" = 1 ] && [ -z "$MANIFEST_BACKUP" ]; then
        action="backup"
      else
        action="conflict"
      fi
    elif [ -e "$link" ]; then
      if [ "$FORCE" = 1 ] && [ -z "$MANIFEST_BACKUP" ]; then
        action="backup"
      else
        action="conflict"
      fi
    fi

    if [ "$action" = "backup" ]; then
      timestamp="$(date +%Y%m%d%H%M%S)"
      backup="${link}.backup.${timestamp}.$$"
      [ ! -e "$backup" ] && [ ! -L "$backup" ] ||
        die "backup path already exists: $backup"
    elif [ "$action" = "conflict" ]; then
      conflict_count=$((conflict_count + 1))
    fi

    plan_actions[$index]="$action"
    plan_backups[$index]="$backup"
    case "$action" in
      keep)     log "  keep     $link -> $target" ;;
      create)   log "  create   $link -> $target" ;;
      refresh)  log "  refresh  $link -> $target" ;;
      backup)   log "  backup   $link -> $backup"; log "  create   $link -> $target" ;;
      conflict) warn "conflict at $link (use --force to preserve it as a tracked backup)" ;;
    esac
    index=$((index + 1))
  done

  [ "$conflict_count" -eq 0 ] ||
    die "command installation has $conflict_count unresolved conflict(s)"
  if [ "$APPLY" != 1 ]; then
    log "[preview] no links were changed; re-run with --yes to apply"
    return 0
  fi

  mkdir -p "$PREFIX"
  index=0
  while [ "$index" -lt "${#COMMAND_NAMES[@]}" ]; do
    name="${COMMAND_NAMES[$index]}"
    target="${COMMAND_TARGETS[$index]}"
    link="${PREFIX}/${name}"
    action="${plan_actions[$index]}"
    backup="${plan_backups[$index]}"
    case "$action" in
      keep) ;;
      refresh)
        rm -f "$link"
        ;;
      backup)
        mv "$link" "$backup"
        ;;
      create) ;;
    esac
    if [ "$action" != "keep" ]; then
      temp_link="$(mktemp "${PREFIX}/.${name}.tmp.XXXXXX")"
      rm -f "$temp_link"
      ln -s "$target" "$temp_link"
      mv "$temp_link" "$link"
    fi
    index=$((index + 1))
  done

  manifest_temp="$(mktemp "${PREFIX}/.${MANIFEST_NAME}.tmp.XXXXXX")"
  {
    printf '%s\n' "# script-toolbox-agent-commands v1"
    index=0
    while [ "$index" -lt "${#COMMAND_NAMES[@]}" ]; do
      printf '%s\t%s\t%s\n' \
        "${COMMAND_NAMES[$index]}" \
        "${COMMAND_TARGETS[$index]}" \
        "${plan_backups[$index]}"
      index=$((index + 1))
    done
  } > "$manifest_temp"
  chmod 600 "$manifest_temp"
  mv "$manifest_temp" "$MANIFEST"
  ok "installed agentctl, mcpctl, promptctl, and skillsctl in $PREFIX"
  case ":${PATH}:" in
    *":${PREFIX}:"*) ;;
    *) warn "$PREFIX is not currently on PATH; add it in your shell startup file" ;;
  esac
}

uninstall_commands() {
  local name="" target="" backup="" extra="" link current_target
  local line_number=0 incomplete=0

  [ "$FORCE" != 1 ] || die "--force is only valid when installing commands"
  if [ ! -f "$MANIFEST" ]; then
    log "no managed command links found at $PREFIX"
    return 0
  fi
  validate_manifest

  while IFS=$'\t' read -r name target backup extra ||
        [ -n "${name}${target}${backup}${extra}" ]; do
    line_number=$((line_number + 1))
    [ "$line_number" -ne 1 ] || continue
    link="${PREFIX}/${name}"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
      log "  remove   $link"
      [ -z "$backup" ] || log "  restore  $backup -> $link"
    elif [ ! -e "$link" ] && [ ! -L "$link" ]; then
      log "  absent   $link"
      [ -z "$backup" ] || log "  restore  $backup -> $link"
    else
      warn "preserve changed/unowned command: $link"
      incomplete=1
    fi
  done < "$MANIFEST"

  if [ "$APPLY" != 1 ]; then
    log "[preview] no links were changed; re-run with --uninstall --yes to apply"
    return 0
  fi
  [ "$incomplete" -eq 0 ] ||
    die "uninstall stopped because a managed command changed; no links were removed"

  line_number=0
  while IFS=$'\t' read -r name target backup extra ||
        [ -n "${name}${target}${backup}${extra}" ]; do
    line_number=$((line_number + 1))
    [ "$line_number" -ne 1 ] || continue
    link="${PREFIX}/${name}"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
      rm -f "$link"
      if [ -n "$backup" ]; then
        if [ -e "$backup" ] || [ -L "$backup" ]; then
          mv "$backup" "$link"
        else
          warn "tracked backup is missing: $backup"
        fi
      fi
    elif [ ! -e "$link" ] && [ ! -L "$link" ] && [ -n "$backup" ]; then
      if [ -e "$backup" ] || [ -L "$backup" ]; then
        mv "$backup" "$link"
      else
        warn "tracked backup is missing: $backup"
      fi
    fi
  done < "$MANIFEST"

  rm -f "$MANIFEST"
  ok "removed managed command links from $PREFIX"
}

if [ "$UNINSTALL" = 1 ]; then
  uninstall_commands
else
  install_commands
fi
