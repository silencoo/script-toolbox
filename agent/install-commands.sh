#!/usr/bin/env bash
# Install a standalone runtime and reversible PATH links for the four controllers.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST_NAME=".script-toolbox-agent-commands"
RUNTIME_MARKER_NAME=".script-toolbox-agent-runtime"
VERSION="0.2.0"

# shellcheck source=ctl-lib.sh
. "${SCRIPT_DIR}/ctl-lib.sh"

PREFIX="${HOME}/.local/bin"
RUNTIME_DIR="${HOME}/.local/share/script-toolbox/agent"
INSTALL_MODE="standalone"
RELEASE_ID="${SCRIPT_TOOLBOX_RELEASE_ID:-}"
APPLY=0
DRY_RUN=0
UNINSTALL=0
FORCE=0

usage() {
  cat <<'EOF'
install-commands.sh — install the script-toolbox controller suite

Usage:
  ./agent/install-commands.sh [--standalone] [options]
  ./agent/install-commands.sh --link [options]
  ./agent/install-commands.sh --uninstall [options]

The default standalone mode copies only the required controller runtime to
~/.local/share/script-toolbox/agent and creates four links in ~/.local/bin.
The source repository can then be moved or deleted. The default run previews
the plan; pass --yes to apply it.

Options:
  --standalone          Install a self-contained runtime (default).
  --link                Create development links back to this repository.
  --prefix <directory>  Command-link directory (default: ~/.local/bin).
  --runtime <directory> Standalone runtime directory.
  --yes                 Apply the displayed install/uninstall plan.
  --dry-run             Force preview mode.
  --force               Preserve and replace unowned command/runtime conflicts.
  --uninstall           Remove managed links/runtime and restore tracked conflicts.
  -h, --help            Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --standalone)
      INSTALL_MODE="standalone"
      shift
      ;;
    --link)
      INSTALL_MODE="link"
      shift
      ;;
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
    --runtime)
      [ $# -ge 2 ] || die "--runtime requires a directory"
      RUNTIME_DIR="$2"
      shift 2
      ;;
    --runtime=*)
      RUNTIME_DIR="${1#*=}"
      [ -n "$RUNTIME_DIR" ] || die "--runtime requires a directory"
      shift
      ;;
    --release-id)
      [ $# -ge 2 ] || die "--release-id requires a value"
      RELEASE_ID="$2"
      shift 2
      ;;
    --release-id=*)
      RELEASE_ID="${1#*=}"
      [ -n "$RELEASE_ID" ] || die "--release-id requires a value"
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
[ -n "$RUNTIME_DIR" ] || die "runtime directory cannot be empty"
[ "$RUNTIME_DIR" != "/" ] || die "refusing to use / as the runtime directory"
case "${PREFIX}${RUNTIME_DIR}${RELEASE_ID}" in
  *$'\n'*|*$'\t'*) die "paths and release identifiers must not contain tabs or newlines" ;;
esac
case "$PREFIX" in
  /*) ;;
  *) PREFIX="$(pwd)/$PREFIX" ;;
esac
case "$RUNTIME_DIR" in
  /*) ;;
  *) RUNTIME_DIR="$(pwd)/$RUNTIME_DIR" ;;
esac

validate_runtime_path() {
  local path="$1" prefix="$2"
  case "${path}/" in
    *'/../'*|*'/./'*|*'//'*) die "runtime directory must use a normalized absolute path: $path" ;;
  esac
  case "$path" in
    /|/bin|/etc|/home|/Library|/opt|/private|/root|/sbin|/System|/tmp|/Users|/usr|/var|/Volumes)
      die "runtime directory is too broad: $path"
      ;;
  esac
  [ "$path" != "$HOME" ] || die "runtime directory must not be HOME"
  case "${prefix}/" in "${path}/"*) die "runtime directory must not contain the command prefix" ;; esac
  case "${path}/" in "${prefix}/"*) die "runtime directory must not be inside the command prefix" ;; esac
}

validate_runtime_path "$RUNTIME_DIR" "$PREFIX"
if [ "$INSTALL_MODE" = "standalone" ]; then
  case "${SCRIPT_DIR}/" in
    "${RUNTIME_DIR}/"*) die "runtime directory must not contain the source checkout" ;;
  esac
fi

MANIFEST="${PREFIX}/${MANIFEST_NAME}"
COMMAND_NAMES=(agentctl mcpctl promptctl skillsctl)
SOURCE_COMMAND_TARGETS=(
  "${SCRIPT_DIR}/agentctl/agentctl"
  "${SCRIPT_DIR}/mcpctl/mcpctl"
  "${SCRIPT_DIR}/promptctl/promptctl"
  "${SCRIPT_DIR}/skillsctl/skillsctl"
)
if [ "$INSTALL_MODE" = "standalone" ]; then
  COMMAND_TARGETS=(
    "${RUNTIME_DIR}/agentctl/agentctl"
    "${RUNTIME_DIR}/mcpctl/mcpctl"
    "${RUNTIME_DIR}/promptctl/promptctl"
    "${RUNTIME_DIR}/skillsctl/skillsctl"
  )
else
  COMMAND_TARGETS=("${SOURCE_COMMAND_TARGETS[@]}")
fi

MANIFEST_VERSION=""
MANIFEST_MODE=""
MANIFEST_RUNTIME=""
MANIFEST_RUNTIME_BACKUP=""

validate_manifest() {
  local line_number=0 name="" target="" backup="" extra="" seen="|"
  MANIFEST_VERSION=""
  MANIFEST_MODE=""
  MANIFEST_RUNTIME=""
  MANIFEST_RUNTIME_BACKUP=""
  [ -f "$MANIFEST" ] || return 0
  [ ! -L "$MANIFEST" ] || die "refusing symlinked command manifest: $MANIFEST"

  while IFS=$'\t' read -r name target backup extra ||
        [ -n "${name}${target}${backup}${extra}" ]; do
    line_number=$((line_number + 1))
    if [ "$line_number" -eq 1 ]; then
      case "$name" in
        "# script-toolbox-agent-commands v1")
          [ -z "${target}${backup}${extra}" ] ||
            die "malformed command manifest header: $MANIFEST"
          MANIFEST_VERSION="1"
          MANIFEST_MODE="link"
          ;;
        "# script-toolbox-agent-commands v2")
          case "$target" in
            link)
              [ -z "${backup}${extra}" ] ||
                die "malformed link-mode manifest header: $MANIFEST"
              ;;
            standalone)
              case "$backup" in /*) ;; *) die "invalid runtime in $MANIFEST" ;; esac
              validate_runtime_path "$backup" "$PREFIX"
              if [ -n "$extra" ]; then
                case "$extra" in "${backup}.backup."*) ;; *) die "invalid runtime backup in $MANIFEST" ;; esac
              fi
              ;;
            *) die "invalid install mode in $MANIFEST" ;;
          esac
          MANIFEST_VERSION="2"
          MANIFEST_MODE="$target"
          MANIFEST_RUNTIME="$backup"
          MANIFEST_RUNTIME_BACKUP="$extra"
          ;;
        *) die "unrecognized command manifest: $MANIFEST" ;;
      esac
      continue
    fi
    case "$name" in
      agentctl|mcpctl|promptctl|skillsctl) ;;
      *) die "unexpected command '$name' in $MANIFEST" ;;
    esac
    case "$seen" in *"|${name}|"*) die "duplicate command '$name' in $MANIFEST" ;; esac
    seen="${seen}${name}|"
    case "$target" in /*) ;; *) die "non-absolute target for '$name' in $MANIFEST" ;; esac
    if [ -n "$backup" ]; then
      case "$backup" in "${PREFIX}/${name}.backup."*) ;; *) die "unexpected backup path for '$name' in $MANIFEST" ;; esac
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

runtime_marker_value() {
  local marker="$1" wanted="$2"
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 0
  awk -F '=' -v wanted="$wanted" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$marker"
}

runtime_marker_matches() {
  local runtime="$1" prefix="$2" marker="${1}/${RUNTIME_MARKER_NAME}"
  [ "$(runtime_marker_value "$marker" schema)" = "1" ] &&
    [ "$(runtime_marker_value "$marker" runtime)" = "$runtime" ] &&
    [ "$(runtime_marker_value "$marker" prefix)" = "$prefix" ]
}

copy_runtime_file() {
  local relative="$1" source="${SCRIPT_DIR}/${1}" destination="${RUNTIME_STAGE}/${1}"
  [ -f "$source" ] && [ ! -L "$source" ] || die "runtime source file is missing: $source"
  mkdir -p "$(dirname "$destination")"
  cp -p "$source" "$destination"
}

copy_runtime_tree() {
  local relative="$1" source="${SCRIPT_DIR}/${1}" destination="${RUNTIME_STAGE}/${1}"
  [ -d "$source" ] && [ ! -L "$source" ] || die "runtime source directory is missing: $source"
  mkdir -p "$(dirname "$destination")"
  cp -R "$source" "$destination"
}

resolve_release_id() {
  local git_release=""
  [ -z "$RELEASE_ID" ] || return 0
  git_release="$(git -C "${SCRIPT_DIR}/.." rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$git_release" ]; then
    if ! git -C "${SCRIPT_DIR}/.." diff --quiet -- agent 2>/dev/null; then
      git_release="${git_release}-dirty"
    fi
    RELEASE_ID="$git_release"
  else
    RELEASE_ID="local"
  fi
}

RUNTIME_STAGE=""
RUNTIME_ROLLBACK=""
RUNTIME_ROLLBACK_KEEP=0
RUNTIME_INSTALLED=0
NEXT_RUNTIME_BACKUP=""

stage_runtime() {
  local runtime_parent marker_temp
  resolve_release_id
  runtime_parent="$(dirname "$RUNTIME_DIR")"
  mkdir -p "$runtime_parent"
  RUNTIME_STAGE="$(mktemp -d "${runtime_parent}/.script-toolbox-agent.tmp.XXXXXX")"

  copy_runtime_file ctl-lib.sh
  copy_runtime_file setup-lib.sh
  copy_runtime_file remote-store.mjs
  copy_runtime_file install-commands.sh
  copy_runtime_file update-commands.sh

  copy_runtime_file agentctl/agentctl
  copy_runtime_file agentctl/orchestrator-client.mjs
  copy_runtime_file agentctl/provider-client.mjs
  copy_runtime_file agentctl/provider-renderer.mjs
  copy_runtime_file agentctl/provider-schema.mjs
  copy_runtime_file agentctl/failover-client.mjs
  copy_runtime_file agentctl/failover-schema.mjs
  copy_runtime_file agentctl/pricing-client.mjs
  copy_runtime_file agentctl/proxy-client.mjs
  copy_runtime_file agentctl/workspace-client.mjs
  copy_runtime_file agentctl/workspace-schema.mjs

  copy_runtime_file mcpctl/mcpctl
  copy_runtime_file mcpctl/host-manager
  copy_runtime_file mcpctl/import-client.mjs
  copy_runtime_file mcpctl/remote-client.mjs
  copy_runtime_tree mcpctl/adapters
  copy_runtime_tree mcpctl/template-store

  copy_runtime_file promptctl/promptctl
  copy_runtime_file promptctl/promptctl.py
  copy_runtime_file promptctl/prompt-remote.mjs
  copy_runtime_tree promptctl/templates

  copy_runtime_file skillsctl/skillsctl
  copy_runtime_file skillsctl/skillsctl.mjs

  copy_runtime_file claude-code/setup.sh
  copy_runtime_file claude-code/statusline-setup.sh
  copy_runtime_file claude-code/statusline.py
  copy_runtime_file codex/setup.sh
  copy_runtime_file opencode/setup.sh
  copy_runtime_file pi/setup.sh
  copy_runtime_file pricing/pricing.mjs
  copy_runtime_file proxy/agentproxyd.mjs
  copy_runtime_file proxy/circuit-breaker.mjs
  copy_runtime_file proxy/model-mapper.mjs
  copy_runtime_file proxy/usage.mjs

  copy_runtime_file tui/package.json
  copy_runtime_file tui/dist/toolbox-tui.mjs

  marker_temp="${RUNTIME_STAGE}/${RUNTIME_MARKER_NAME}"
  {
    printf 'schema=1\n'
    printf 'release_id=%s\n' "$RELEASE_ID"
    printf 'prefix=%s\n' "$PREFIX"
    printf 'runtime=%s\n' "$RUNTIME_DIR"
    printf 'repository=%s\n' 'silencoo/script-toolbox'
  } > "$marker_temp"
  chmod 600 "$marker_temp"

  for executable in \
    agentctl/agentctl mcpctl/mcpctl promptctl/promptctl skillsctl/skillsctl \
    install-commands.sh update-commands.sh; do
    [ -x "${RUNTIME_STAGE}/${executable}" ] ||
      die "staged runtime executable is missing: $executable"
  done
}

install_staged_runtime() {
  local timestamp marker="${RUNTIME_DIR}/${RUNTIME_MARKER_NAME}" marker_prefix marker_runtime
  NEXT_RUNTIME_BACKUP=""
  if [ -e "$RUNTIME_DIR" ] || [ -L "$RUNTIME_DIR" ]; then
    [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ] ||
      die "runtime path is not a real directory: $RUNTIME_DIR"
    timestamp="$(date +%Y%m%d%H%M%S)"
    marker_prefix="$(runtime_marker_value "$marker" prefix)"
    marker_runtime="$(runtime_marker_value "$marker" runtime)"
    if runtime_marker_matches "$RUNTIME_DIR" "$PREFIX"; then
      RUNTIME_ROLLBACK="${RUNTIME_DIR}.rollback.${timestamp}.$$"
      RUNTIME_ROLLBACK_KEEP=0
      if [ "$MANIFEST_MODE" = "standalone" ] && [ "$MANIFEST_RUNTIME" = "$RUNTIME_DIR" ]; then
        NEXT_RUNTIME_BACKUP="$MANIFEST_RUNTIME_BACKUP"
      fi
    elif [ -n "$marker_prefix" ] && [ -n "$marker_runtime" ]; then
      die "runtime is managed by a different installation: $RUNTIME_DIR"
    else
      [ "$FORCE" = 1 ] ||
        die "unowned runtime exists at $RUNTIME_DIR (use --force to preserve and replace it)"
      RUNTIME_ROLLBACK="${RUNTIME_DIR}.backup.${timestamp}.$$"
      RUNTIME_ROLLBACK_KEEP=1
      NEXT_RUNTIME_BACKUP="$RUNTIME_ROLLBACK"
      log "  backup   $RUNTIME_DIR -> $RUNTIME_ROLLBACK"
    fi
    [ ! -e "$RUNTIME_ROLLBACK" ] && [ ! -L "$RUNTIME_ROLLBACK" ] ||
      die "runtime backup path already exists: $RUNTIME_ROLLBACK"
    mv "$RUNTIME_DIR" "$RUNTIME_ROLLBACK"
  fi
  if ! mv "$RUNTIME_STAGE" "$RUNTIME_DIR"; then
    [ -z "$RUNTIME_ROLLBACK" ] || mv "$RUNTIME_ROLLBACK" "$RUNTIME_DIR"
    die "could not install standalone runtime"
  fi
  RUNTIME_STAGE=""
  RUNTIME_INSTALLED=1
}

finish_runtime_install() {
  if [ -n "$RUNTIME_ROLLBACK" ] && [ "$RUNTIME_ROLLBACK_KEEP" != 1 ]; then
    rm -rf "$RUNTIME_ROLLBACK"
  fi
  RUNTIME_ROLLBACK=""
  RUNTIME_INSTALLED=0
}

rollback_runtime_install() {
  [ "$RUNTIME_INSTALLED" = 1 ] || return 0
  if [ -d "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ]; then
    rm -rf "$RUNTIME_DIR"
  fi
  [ -z "$RUNTIME_ROLLBACK" ] || mv "$RUNTIME_ROLLBACK" "$RUNTIME_DIR"
  RUNTIME_ROLLBACK=""
  RUNTIME_INSTALLED=0
}

cleanup_install() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    rollback_runtime_install || true
    [ -z "$RUNTIME_STAGE" ] || rm -rf "$RUNTIME_STAGE"
  fi
  exit "$status"
}
trap cleanup_install EXIT

install_commands() {
  local index name target source_target link current_target action backup timestamp
  local conflict_count=0 temp_link manifest_temp
  local -a plan_actions plan_backups

  validate_manifest
  if [ "$INSTALL_MODE" = "standalone" ]; then
    log "  runtime  ${SCRIPT_DIR} -> ${RUNTIME_DIR}"
  fi
  index=0
  while [ "$index" -lt "${#COMMAND_NAMES[@]}" ]; do
    name="${COMMAND_NAMES[$index]}"
    target="${COMMAND_TARGETS[$index]}"
    source_target="${SOURCE_COMMAND_TARGETS[$index]}"
    link="${PREFIX}/${name}"
    [ -x "$source_target" ] || die "controller is missing or not executable: $source_target"
    manifest_row "$name"
    action="create"
    backup="$MANIFEST_BACKUP"

    if [ -L "$link" ]; then
      current_target="$(readlink "$link")"
      if [ "$current_target" = "$target" ]; then
        action="keep"
      elif [ -n "$MANIFEST_TARGET" ] && [ "$current_target" = "$MANIFEST_TARGET" ]; then
        action="refresh"
      elif [ "$FORCE" = 1 ] && [ -z "$MANIFEST_BACKUP" ]; then
        action="backup"
      else
        action="conflict"
      fi
    elif [ -e "$link" ]; then
      if [ "$FORCE" = 1 ] && [ -z "$MANIFEST_BACKUP" ]; then action="backup"; else action="conflict"; fi
    fi

    if [ "$action" = "backup" ]; then
      timestamp="$(date +%Y%m%d%H%M%S)"
      backup="${link}.backup.${timestamp}.$$"
      [ ! -e "$backup" ] && [ ! -L "$backup" ] || die "backup path already exists: $backup"
    elif [ "$action" = "conflict" ]; then
      conflict_count=$((conflict_count + 1))
    fi

    plan_actions[$index]="$action"
    plan_backups[$index]="$backup"
    case "$action" in
      keep) log "  keep     $link -> $target" ;;
      create) log "  create   $link -> $target" ;;
      refresh) log "  refresh  $link -> $target" ;;
      backup) log "  backup   $link -> $backup"; log "  create   $link -> $target" ;;
      conflict) warn "conflict at $link (use --force to preserve it as a tracked backup)" ;;
    esac
    index=$((index + 1))
  done

  [ "$conflict_count" -eq 0 ] || die "command installation has $conflict_count unresolved conflict(s)"
  if [ "$APPLY" != 1 ]; then
    log "[preview] no files or links were changed; re-run with --yes to apply"
    return 0
  fi

  if [ "$INSTALL_MODE" = "standalone" ]; then
    stage_runtime
    install_staged_runtime
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
      refresh) rm -f "$link" ;;
      backup) mv "$link" "$backup" ;;
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
    if [ "$INSTALL_MODE" = "standalone" ]; then
      printf '%s\t%s\t%s\t%s\n' \
        "# script-toolbox-agent-commands v2" standalone "$RUNTIME_DIR" "$NEXT_RUNTIME_BACKUP"
    else
      printf '%s\t%s\t\t\n' "# script-toolbox-agent-commands v2" link
    fi
    index=0
    while [ "$index" -lt "${#COMMAND_NAMES[@]}" ]; do
      printf '%s\t%s\t%s\n' \
        "${COMMAND_NAMES[$index]}" "${COMMAND_TARGETS[$index]}" "${plan_backups[$index]}"
      index=$((index + 1))
    done
  } > "$manifest_temp"
  chmod 600 "$manifest_temp"
  mv "$manifest_temp" "$MANIFEST"
  finish_runtime_install
  ok "installed agentctl, mcpctl, promptctl, and skillsctl in $PREFIX"
  [ "$INSTALL_MODE" != "standalone" ] || ok "standalone runtime: $RUNTIME_DIR"
  case ":${PATH}:" in *":${PREFIX}:"*) ;; *) warn "$PREFIX is not currently on PATH; add it in your shell startup file" ;; esac
}

uninstall_commands() {
  local name="" target="" backup="" extra="" link current_target marker
  local line_number=0 incomplete=0

  [ "$FORCE" != 1 ] || die "--force is only valid when installing commands"
  if [ ! -f "$MANIFEST" ]; then
    log "no managed controller installation found at $PREFIX"
    return 0
  fi
  validate_manifest

  while IFS=$'\t' read -r name target backup extra || [ -n "${name}${target}${backup}${extra}" ]; do
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

  if [ "$MANIFEST_MODE" = "standalone" ]; then
    marker="${MANIFEST_RUNTIME}/${RUNTIME_MARKER_NAME}"
    if [ -d "$MANIFEST_RUNTIME" ] && [ ! -L "$MANIFEST_RUNTIME" ] &&
       runtime_marker_matches "$MANIFEST_RUNTIME" "$PREFIX"; then
      log "  remove   standalone runtime $MANIFEST_RUNTIME"
    elif [ ! -e "$MANIFEST_RUNTIME" ] && [ ! -L "$MANIFEST_RUNTIME" ]; then
      log "  absent   standalone runtime $MANIFEST_RUNTIME"
    else
      warn "preserve changed/unowned runtime: $MANIFEST_RUNTIME"
      incomplete=1
    fi
    [ -z "$MANIFEST_RUNTIME_BACKUP" ] ||
      log "  restore  $MANIFEST_RUNTIME_BACKUP -> $MANIFEST_RUNTIME"
  fi

  if [ "$APPLY" != 1 ]; then
    log "[preview] no files or links were changed; re-run with --uninstall --yes to apply"
    return 0
  fi
  [ "$incomplete" -eq 0 ] || die "uninstall stopped because managed paths changed; nothing was removed"

  line_number=0
  while IFS=$'\t' read -r name target backup extra || [ -n "${name}${target}${backup}${extra}" ]; do
    line_number=$((line_number + 1))
    [ "$line_number" -ne 1 ] || continue
    link="${PREFIX}/${name}"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
      rm -f "$link"
      if [ -n "$backup" ] && { [ -e "$backup" ] || [ -L "$backup" ]; }; then mv "$backup" "$link"; fi
    elif [ ! -e "$link" ] && [ ! -L "$link" ] && [ -n "$backup" ]; then
      if [ -e "$backup" ] || [ -L "$backup" ]; then mv "$backup" "$link"; fi
    fi
  done < "$MANIFEST"
  rm -f "$MANIFEST"

  if [ "$MANIFEST_MODE" = "standalone" ]; then
    if [ -d "$MANIFEST_RUNTIME" ] && [ ! -L "$MANIFEST_RUNTIME" ]; then rm -rf "$MANIFEST_RUNTIME"; fi
    if [ -n "$MANIFEST_RUNTIME_BACKUP" ] &&
       { [ -e "$MANIFEST_RUNTIME_BACKUP" ] || [ -L "$MANIFEST_RUNTIME_BACKUP" ]; }; then
      mv "$MANIFEST_RUNTIME_BACKUP" "$MANIFEST_RUNTIME"
    fi
  fi
  ok "removed the managed controller installation from $PREFIX"
}

if [ "$UNINSTALL" = 1 ]; then uninstall_commands; else install_commands; fi
