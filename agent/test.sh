#!/usr/bin/env bash
# agent/test.sh — syntax and isolated config-generation tests for agent scripts.
#
# Uses a temporary HOME and fake agent binaries; it never installs a package,
# calls a model API, or touches the user's real configuration.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

fail=0
checked=0
# -print0 / read -d '' handle paths with spaces or unusual characters.
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  [ "$base" = "test.sh" ] && continue
  checked=$((checked + 1))
  if bash -n "$f"; then
    printf '%s %s\n' "ok  :" "${f#"${SCRIPT_DIR}/"}"
  else
    printf '%s %s\n' "FAIL:" "${f#"${SCRIPT_DIR}/"}" >&2
    fail=1
  fi
done < <(find "$SCRIPT_DIR" -type f -name '*.sh' -print0)

run_dependency_tests() {
  bash -c '
    set -euo pipefail
    # shellcheck source=setup-lib.sh
    . "$1"
    installed=0
    command() {
      if [ "${1:-}" = "-v" ] && [ "${2:-}" = "jq" ]; then
        [ "$installed" = 1 ]
      else
        builtin command "$@"
      fi
    }
    install_jq() { installed=1; }
    jq() { printf "jq-test\n"; }
    ensure_jq >/dev/null
    [ "$installed" = 1 ]
  ' bash "$SCRIPT_DIR/setup-lib.sh"
}

run_config_tests() {
  local test_root fake_bin test_home bad_home minimax_home system_path
  local dry_home key_input insecure_key multiline_key
  command -v jq >/dev/null 2>&1 || {
    echo "skip: isolated provider config tests require jq" >&2
    return 2
  }
  test_root="$(mktemp -d)"
  fake_bin="${test_root}/bin"
  test_home="${test_root}/home"
  system_path="$PATH"
  mkdir -p "$fake_bin" "$test_home"

  # All setup scripts only need these commands to report a version. Validation
  # is disabled below, so no API or installer process is reached.
  for cmd in node npm claude codex opencode pi; do
    {
      printf '%s\n' '#!/usr/bin/env sh'
      if [ "$cmd" = "node" ]; then
        printf '%s\n' 'case "$1" in -p) printf "24.0.0\n" ;; *) printf "v24.0.0\n" ;; esac'
      else
        printf '%s\n' 'printf "test-version\n"'
      fi
    } > "${fake_bin}/${cmd}"
    chmod +x "${fake_bin}/${cmd}"
  done

  # Dry-run resolves every backend without requiring a credential and exits
  # before API probes, dependency installation, or HOME mutations.
  dry_home="${test_root}/dry-claude"
  HOME="$dry_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider anthropic --model claude-sonnet-4-6 --dry-run \
      >"$test_root/dry-claude.out" || { rm -rf "$test_root"; return 1; }
  [ ! -e "$dry_home" ] || { rm -rf "$test_root"; return 1; }

  dry_home="${test_root}/dry-codex"
  HOME="$dry_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" \
      --provider openai --model gpt-5.6 --dry-run \
      >"$test_root/dry-codex.out" || { rm -rf "$test_root"; return 1; }
  [ ! -e "$dry_home" ] || { rm -rf "$test_root"; return 1; }

  dry_home="${test_root}/dry-opencode"
  HOME="$dry_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/setup.sh" \
      --provider openai --model gpt-5.6 --dry-run \
      >"$test_root/dry-opencode.out" || { rm -rf "$test_root"; return 1; }
  [ ! -e "$dry_home" ] || { rm -rf "$test_root"; return 1; }

  dry_home="${test_root}/dry-pi"
  HOME="$dry_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/pi/setup.sh" \
      --provider openai --model gpt-5.6 --dry-run \
      >"$test_root/dry-pi.out" || { rm -rf "$test_root"; return 1; }
  [ ! -e "$dry_home" ] || { rm -rf "$test_root"; return 1; }
  for dry_output in "$test_root"/dry-*.out; do
    grep -q 'not supplied (apply mode will prompt)' "$dry_output" ||
      { rm -rf "$test_root"; return 1; }
    grep -q 'no validation request, package installation, or file change' \
      "$dry_output" || { rm -rf "$test_root"; return 1; }
  done

  # Every provider backend accepts one private, single-line key file and never
  # echoes its contents. The source file remains user-owned and unchanged.
  key_input="${test_root}/provider-api-key"
  printf '%s\n' 'KEY-FILE-SECRET' > "$key_input"
  chmod 600 "$key_input"

  HOME="$test_root/key-claude-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider anthropic --model claude-sonnet-4-6 \
      --key-file "$key_input" --skip-validate \
      >"$test_root/key-claude.out" || { rm -rf "$test_root"; return 1; }
  jq -e '.env.ANTHROPIC_API_KEY == "KEY-FILE-SECRET"' \
    "$test_root/key-claude-home/.claude/settings.json" >/dev/null ||
    { rm -rf "$test_root"; return 1; }

  HOME="$test_root/key-codex-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" \
      --provider openai --model gpt-5.6 \
      --key-file "$key_input" --skip-validate \
      >"$test_root/key-codex.out" || { rm -rf "$test_root"; return 1; }
  [ "$(sed -n '1p' "$test_root/key-codex-home/.codex/provider-keys/script_toolbox_openai.key")" = \
    "KEY-FILE-SECRET" ] || { rm -rf "$test_root"; return 1; }

  HOME="$test_root/key-opencode-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/setup.sh" \
      --provider openai --model gpt-5.6 \
      --key-file "$key_input" --skip-validate \
      >"$test_root/key-opencode.out" || { rm -rf "$test_root"; return 1; }
  [ "$(sed -n '1p' "$test_root/key-opencode-home/.config/opencode/provider-keys/script-toolbox-openai.key")" = \
    "KEY-FILE-SECRET" ] || { rm -rf "$test_root"; return 1; }

  HOME="$test_root/key-pi-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/pi/setup.sh" \
      --provider openai --model gpt-5.6 \
      --key-file "$key_input" --skip-validate \
      >"$test_root/key-pi.out" || { rm -rf "$test_root"; return 1; }
  [ "$(sed -n '1p' "$test_root/key-pi-home/.pi/agent/provider-keys/script-toolbox-openai.key")" = \
    "KEY-FILE-SECRET" ] || { rm -rf "$test_root"; return 1; }

  for key_output in "$test_root"/key-*.out; do
    ! grep -q 'KEY-FILE-SECRET' "$key_output" ||
      { rm -rf "$test_root"; return 1; }
  done
  [ "$(sed -n '1p' "$key_input")" = "KEY-FILE-SECRET" ] ||
    { rm -rf "$test_root"; return 1; }

  insecure_key="${test_root}/insecure-api-key"
  printf '%s\n' 'insecure-secret' > "$insecure_key"
  chmod 644 "$insecure_key"
  if HOME="$test_root/insecure-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" \
      --provider openai --model gpt-5.6 \
      --key-file "$insecure_key" --dry-run >/dev/null 2>&1; then
    rm -rf "$test_root"; return 1
  fi

  multiline_key="${test_root}/multiline-api-key"
  printf '%s\n%s\n' 'first-line' 'second-line' > "$multiline_key"
  chmod 600 "$multiline_key"
  if HOME="$test_root/multiline-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" \
      --provider openai --model gpt-5.6 \
      --key-file "$multiline_key" --dry-run >/dev/null 2>&1; then
    rm -rf "$test_root"; return 1
  fi
  if HOME="$test_root/conflicting-key-home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" \
      --provider openai --model gpt-5.6 --key direct-secret \
      --key-file "$key_input" --dry-run >/dev/null 2>&1; then
    rm -rf "$test_root"; return 1
  fi

  # MiniMax presets must follow the current official model ID when --model is
  # omitted. Exercise each client that exposes a MiniMax provider.
  minimax_home="${test_root}/minimax-claude"
  HOME="$minimax_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider minimax-global --key test-minimax \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '.model == "MiniMax-M3" and .env.ANTHROPIC_MODEL == "MiniMax-M3"' \
    "$minimax_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }

  minimax_home="${test_root}/minimax-opencode"
  HOME="$minimax_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/setup.sh" \
      --provider minimax-global --key test-minimax \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e --arg executable "${fake_bin}/node" '
    .model == "script-toolbox-minimax-global/MiniMax-M3"
    and .provider["script-toolbox-minimax-global"].models["MiniMax-M3"].name == "MiniMax-M3"
  ' "$minimax_home/.config/opencode/opencode.json" >/dev/null || {
    rm -rf "$test_root"; return 1;
  }

  minimax_home="${test_root}/minimax-pi"
  HOME="$minimax_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/pi/setup.sh" \
      --provider minimax-global --key test-minimax \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .defaultProvider == "script-toolbox-minimax-global"
    and .defaultModel == "MiniMax-M3"
  ' "$minimax_home/.pi/agent/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .providers["script-toolbox-minimax-global"].models[0].id == "MiniMax-M3"
  ' "$minimax_home/.pi/agent/models.json" >/dev/null || { rm -rf "$test_root"; return 1; }

  printf '%s\n' \
    'export ANTHROPIC_AUTH_TOKEN=stale-token' \
    'export KEEP_THIS_VALUE=yes' > "$test_home/.zshrc"
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider deepseek --model deepseek-v4-pro --key test-claude \
      --skip-validate --clean-shell-env --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .env.ANTHROPIC_BASE_URL == "https://api.deepseek.com/anthropic"
    and .env.ANTHROPIC_AUTH_TOKEN == "test-claude"
    and .env.ANTHROPIC_API_KEY == null
    and .model == "deepseek-v4-pro"
  ' "$test_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  ! grep -q 'ANTHROPIC_AUTH_TOKEN' "$test_home/.zshrc" || { rm -rf "$test_root"; return 1; }
  grep -q 'KEEP_THIS_VALUE=yes' "$test_home/.zshrc" || { rm -rf "$test_root"; return 1; }
  find "$test_home" -maxdepth 1 -name '.zshrc.bak.*' -type f | grep -q . || {
    rm -rf "$test_root"; return 1;
  }
  [ "$(stat -c '%a' "$test_home/.claude/settings.json" 2>/dev/null || stat -f '%Lp' "$test_home/.claude/settings.json")" = "600" ] || {
    rm -rf "$test_root"; return 1;
  }

  # Invalid JSON must fail closed: --force never authorizes replacing a broken
  # settings file, and the original bytes must remain untouched.
  bad_home="${test_root}/bad-home"
  mkdir -p "$bad_home/.claude"
  printf '%s\n' '{invalid-json' > "$bad_home/.claude/settings.json"
  cp "$bad_home/.claude/settings.json" "$bad_home/settings.before"
  if HOME="$bad_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider anthropic --model claude-sonnet-4-6 --key test-invalid \
      --skip-validate --force >/dev/null 2>&1; then
    rm -rf "$test_root"; return 1
  fi
  cmp -s "$bad_home/settings.before" "$bad_home/.claude/settings.json" || {
    rm -rf "$test_root"; return 1;
  }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider openrouter --model openrouter/auto --key test-claude-token \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .env.ANTHROPIC_AUTH_TOKEN == "test-claude-token"
    and .env.ANTHROPIC_API_KEY == null
    and .model == "openrouter/auto"
  ' "$test_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  jq '
    .mcpServers.context7 = {
      "type": "http",
      "url": "https://mcp.context7.com/mcp",
      "_managed_by": "agent/claude-code/mcp.sh"
    }
  ' "$test_home/.claude/settings.json" > "$test_home/legacy-claude-mcp.json"
  mv "$test_home/legacy-claude-mcp.json" "$test_home/.claude/settings.json"
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/mcp.sh" \
      --provider chrome-devtools --stock-chrome --skip-validate >/dev/null || {
        rm -rf "$test_root"; return 1;
      }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    BRAVE_API_KEY='test-"brave\key' \
    EXA_API_KEY='test-exa' \
    GITHUB_PERSONAL_ACCESS_TOKEN='test-github' \
    "$SCRIPT_DIR/claude-code/mcp.sh" \
      --all --skip-validate \
      --cloakbrowser-executable "${fake_bin}/node" >/dev/null || {
        rm -rf "$test_root"; return 1;
      }
  jq -e --arg executable "${fake_bin}/node" '
    .mcpServers.brave._managed_by == "agent/claude-code/mcp.sh"
    and .mcpServers.brave.headers["X-Subscription-Token"] == "test-\"brave\\key"
    and .mcpServers.exa.headers.Authorization == "Bearer test-exa"
    and .mcpServers.context7._managed_by == "agent/claude-code/mcp.sh"
    and .mcpServers.context7.headers == null
    and .mcpServers.github.url == "https://api.githubcopilot.com/mcp/"
    and .mcpServers.github.headers.Authorization == "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"
    and .mcpServers.github._managed_by == "agent/claude-code/mcp.sh"
    and .mcpServers["chrome-devtools"].command == "npx"
    and .mcpServers["chrome-devtools"].args ==
      ["-y", "chrome-devtools-mcp@latest", "--executablePath", $executable]
    and .mcpServers["chrome-devtools"]._managed_by == "agent/claude-code/mcp.sh"
  ' "$test_home/.claude.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  ! grep -q 'test-github' "$test_home/.claude.json" || {
    rm -rf "$test_root"; return 1;
  }
  jq -e '
    .mcpServers == null
    and .env.ANTHROPIC_AUTH_TOKEN == "test-claude-token"
    and .model == "openrouter/auto"
  ' "$test_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/mcp.sh" --uninstall >/dev/null || {
      rm -rf "$test_root"; return 1;
    }
  jq -e '
    .mcpServers == null
  ' "$test_home/.claude.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .mcpServers == null
    and .env.ANTHROPIC_AUTH_TOKEN == "test-claude-token"
    and .model == "openrouter/auto"
  ' "$test_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }

  # Codex setup makes the selected model/provider the defaults used by a plain
  # `codex` invocation. Existing user defaults are preserved for uninstall.
  mkdir -p "$test_home/.codex"
  cat > "$test_home/.codex/config.toml" <<'EOF'
model = "user-model"
model_provider = "user_provider"
approval_policy = "on-request"

[model_providers.user_provider]
name = "User provider"
base_url = "http://localhost:1234/v1"
EOF

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/agentctl/agentctl" setup codex \
      --provider openrouter --model openai/gpt-5.6 --key test-codex \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  grep -q 'wire_api = "responses"' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  grep -q '\[model_providers.script_toolbox_openrouter.auth\]' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  awk '
    /^\[[^]]+\]/ { exit }
    $0 == "model = \"openai/gpt-5.6\"" { model = 1 }
    $0 == "model_provider = \"script_toolbox_openrouter\"" { provider = 1 }
    END { exit !(model && provider) }
  ' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  ! grep -q '\[profiles.script_toolbox\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -q '\[model_providers.user_provider\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  ! grep -q 'requires_openai_auth' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  [ "$(cat "$test_home/.codex/provider-keys/script_toolbox_openrouter.key")" = "test-codex" ] || {
    rm -rf "$test_root"; return 1;
  }
  [ "$(stat -c '%a' "$test_home/.codex/provider-keys/script_toolbox_openrouter.key" 2>/dev/null || stat -f '%Lp' "$test_home/.codex/provider-keys/script_toolbox_openrouter.key")" = "600" ] || {
    rm -rf "$test_root"; return 1;
  }

  # Codex MCP refresh/uninstall must preserve user-owned MCP tables and the
  # provider/default configuration written by setup.sh.
  printf '%s\n' \
    '' \
    '[mcp_servers.user_owned]' \
    'url = "https://user.example/mcp"' \
    >> "$test_home/.codex/config.toml"
  HOME="$test_home" PATH="${fake_bin}:${system_path}" BRAVE_API_KEY=test-brave \
    "$SCRIPT_DIR/codex/mcp.sh" \
      --provider brave --provider chrome-devtools \
      --stock-chrome --skip-validate >/dev/null || {
        rm -rf "$test_root"; return 1;
      }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    GITHUB_PERSONAL_ACCESS_TOKEN='test-github' \
    "$SCRIPT_DIR/codex/mcp.sh" \
      --provider exa --provider github --provider chrome-devtools \
      --key 'exa=test-"exa\key' --skip-validate \
      --cloakbrowser-executable "${fake_bin}/node" >/dev/null || {
        rm -rf "$test_root"; return 1;
      }
  grep -q '\[mcp_servers.user_owned\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  ! grep -q '\[mcp_servers.brave\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -q '\[mcp_servers.exa\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -qF '"Authorization" = "Bearer test-\"exa\\key"' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -q '\[mcp_servers.chrome-devtools\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -q '\[mcp_servers.github\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -qF 'bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"' \
    "$test_home/.codex/config.toml" || {
      rm -rf "$test_root"; return 1;
    }
  ! grep -q 'test-github' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -q 'command = "npx"' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -qF "args = [\"-y\", \"chrome-devtools-mcp@latest\", \"--executablePath\", \"${fake_bin}/node\"]" \
    "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  grep -q '\[model_providers.script_toolbox_openrouter\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/mcp.sh" --uninstall >/dev/null || {
      rm -rf "$test_root"; return 1;
    }
  grep -q '\[mcp_servers.user_owned\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  ! grep -q '\[mcp_servers.exa\]' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/setup.sh" \
      --provider google --model gemini-3.6-flash --key test-google \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .model == "script-toolbox-google/gemini-3.6-flash"
    and .provider["script-toolbox-google"].npm == "@ai-sdk/google"
    and (.provider["script-toolbox-google"].options.apiKey | startswith("{file:"))
  ' "$test_home/.config/opencode/opencode.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  [ "$(cat "$test_home/.config/opencode/provider-keys/script-toolbox-google.key")" = "test-google" ] || {
    rm -rf "$test_root"; return 1;
  }
  [ "$(stat -c '%a' "$test_home/.config/opencode/provider-keys/script-toolbox-google.key" 2>/dev/null || stat -f '%Lp' "$test_home/.config/opencode/provider-keys/script-toolbox-google.key")" = "600" ] || {
    rm -rf "$test_root"; return 1;
  }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/mcp.sh" \
      --provider chrome-devtools --stock-chrome --skip-validate >/dev/null || {
        rm -rf "$test_root"; return 1;
      }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    EXA_API_KEY='test-"exa\key' \
    GITHUB_PERSONAL_ACCESS_TOKEN='test-github' \
    "$SCRIPT_DIR/opencode/mcp.sh" \
      --provider exa --provider github --provider chrome-devtools \
      --skip-validate --cloakbrowser-executable "${fake_bin}/node" >/dev/null || {
        rm -rf "$test_root"; return 1;
      }
  jq -e --arg executable "${fake_bin}/node" '
    .mcp.exa._managed_by == "agent/opencode/mcp.sh"
    and .mcp.exa.type == "remote"
    and .mcp.exa.headers.Authorization == "Bearer test-\"exa\\key"
    and .mcp.github.type == "remote"
    and .mcp.github.url == "https://api.githubcopilot.com/mcp/"
    and .mcp.github.oauth == false
    and .mcp.github.headers.Authorization == "Bearer {env:GITHUB_PERSONAL_ACCESS_TOKEN}"
    and .mcp.github._managed_by == "agent/opencode/mcp.sh"
    and .mcp["chrome-devtools"].type == "local"
    and .mcp["chrome-devtools"].command ==
      ["npx", "-y", "chrome-devtools-mcp@latest", "--executablePath", $executable]
    and .mcp["chrome-devtools"]._managed_by == "agent/opencode/mcp.sh"
    and .provider["script-toolbox-google"].npm == "@ai-sdk/google"
    and .model == "script-toolbox-google/gemini-3.6-flash"
  ' "$test_home/.config/opencode/opencode.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  ! grep -q 'test-github' "$test_home/.config/opencode/opencode.json" || {
    rm -rf "$test_root"; return 1;
  }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/mcp.sh" --uninstall >/dev/null || {
      rm -rf "$test_root"; return 1;
    }
  jq -e '
    .mcp == null
    and .provider["script-toolbox-google"].npm == "@ai-sdk/google"
    and .model == "script-toolbox-google/gemini-3.6-flash"
  ' "$test_home/.config/opencode/opencode.json" >/dev/null || { rm -rf "$test_root"; return 1; }

  mkdir -p "$test_home/.pi/agent"
  printf '%s\n' \
    '{"providers":{"user-provider":{"baseUrl":"http://localhost:1234/v1","api":"openai-completions","apiKey":"local","models":[{"id":"user-model"}]}}}' \
    > "$test_home/.pi/agent/models.json"
  printf '%s\n' \
    '{"theme":"light","defaultProvider":"user-provider","defaultModel":"user-model"}' \
    > "$test_home/.pi/agent/settings.json"
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/pi/setup.sh" \
      --provider openai --model gpt-5.6 --key test-pi \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .providers["script-toolbox-openai"].api == "openai-responses"
    and .providers["script-toolbox-openai"].authHeader == true
    and .providers["script-toolbox-openai"].models[0].id == "gpt-5.6"
    and (.providers["script-toolbox-openai"].apiKey | startswith("!cat "))
    and .providers["user-provider"].models[0].id == "user-model"
  ' "$test_home/.pi/agent/models.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .defaultProvider == "script-toolbox-openai"
    and .defaultModel == "gpt-5.6"
    and .theme == "light"
  ' "$test_home/.pi/agent/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  [ "$(cat "$test_home/.pi/agent/provider-keys/script-toolbox-openai.key")" = "test-pi" ] || {
    rm -rf "$test_root"; return 1;
  }
  [ "$(stat -c '%a' "$test_home/.pi/agent/provider-keys/script-toolbox-openai.key" 2>/dev/null || stat -f '%Lp' "$test_home/.pi/agent/provider-keys/script-toolbox-openai.key")" = "600" ] || {
    rm -rf "$test_root"; return 1;
  }

  # Promptctl must coexist with provider/MCP TOML and keep an independent
  # uninstall lifecycle.
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/promptctl/promptctl" \
      install codex --yes >/dev/null || { rm -rf "$test_root"; return 1; }
  grep -qF '# script-toolbox-promptctl:start profile=personal' \
    "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  [ -f "$test_home/.codex/instructions/personal.md" ] || {
    rm -rf "$test_root"; return 1;
  }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/agentctl/agentctl" \
      uninstall codex --yes >/dev/null || { rm -rf "$test_root"; return 1; }
  ! grep -qF 'agent/codex/setup.sh' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  awk '
    /^\[[^]]+\]/ { exit }
    $0 == "model = \"user-model\"" { model = 1 }
    $0 == "model_provider = \"user_provider\"" { provider = 1 }
    $0 == "approval_policy = \"on-request\"" { approval = 1 }
    END { exit !(model && provider && approval) }
  ' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  [ ! -e "$test_home/.codex/.script-toolbox-defaults-backup.toml" ] || {
    rm -rf "$test_root"; return 1;
  }
  grep -qF '# script-toolbox-promptctl:start profile=personal' \
    "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  [ -f "$test_home/.codex/instructions/personal.md" ] || {
    rm -rf "$test_root"; return 1;
  }
  [ ! -e "$test_home/.codex/provider-keys/script_toolbox_openrouter.key" ] || {
    rm -rf "$test_root"; return 1;
  }
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/promptctl/promptctl" \
      uninstall codex --yes >/dev/null || { rm -rf "$test_root"; return 1; }
  ! grep -qF 'script-toolbox-promptctl' "$test_home/.codex/config.toml" || {
    rm -rf "$test_root"; return 1;
  }
  [ -f "$test_home/.codex/instructions/personal.md" ] || {
    rm -rf "$test_root"; return 1;
  }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/opencode/setup.sh" --uninstall >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '.provider["script-toolbox-google"] == null' \
    "$test_home/.config/opencode/opencode.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  [ ! -e "$test_home/.config/opencode/provider-keys/script-toolbox-google.key" ] || {
    rm -rf "$test_root"; return 1;
  }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/pi/setup.sh" --uninstall >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '.providers["script-toolbox-openai"] == null' \
    "$test_home/.pi/agent/models.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .defaultProvider == "user-provider"
    and .defaultModel == "user-model"
    and .theme == "light"
  ' \
    "$test_home/.pi/agent/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }
  [ ! -e "$test_home/.pi/agent/provider-keys/script-toolbox-openai.key" ] || {
    rm -rf "$test_root"; return 1;
  }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" --uninstall >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .env.ANTHROPIC_AUTH_TOKEN == null
    and .env.ANTHROPIC_API_KEY == null
    and .model == null
  ' "$test_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }

  rm -rf "$test_root"
}

config_test_status=0
if run_dependency_tests; then
  echo "ok  : missing jq triggers automatic installation"
else
  echo "FAIL: missing jq did not trigger automatic installation" >&2
  fail=1
fi

run_config_tests || config_test_status=$?
if [ "$config_test_status" -eq 0 ]; then
  echo "ok  : isolated provider config + uninstall"
elif [ "$config_test_status" -eq 2 ]; then
  echo "skip: isolated provider config + uninstall (jq unavailable)"
else
  echo "FAIL: isolated provider config + uninstall" >&2
  fail=1
fi

if "$SCRIPT_DIR/agentctl/test.sh"; then
  :
else
  echo "FAIL: agentctl frontend tests" >&2
  fail=1
fi

if "$SCRIPT_DIR/mcpctl/test.sh"; then
  :
else
  echo "FAIL: mcpctl profile manager tests" >&2
  fail=1
fi

if "$SCRIPT_DIR/promptctl/test.sh"; then
  :
else
  echo "FAIL: promptctl Shell frontend tests" >&2
  fail=1
fi

if node --test "$SCRIPT_DIR/promptctl/prompt-remote.test.mjs"; then
  :
else
  echo "FAIL: promptctl remote snapshot tests" >&2
  fail=1
fi

if node "$SCRIPT_DIR/skillsctl/test.mjs"; then
  :
else
  echo "FAIL: skillsctl pack manager tests" >&2
  fail=1
fi

if node "$SCRIPT_DIR/remote-store.test.mjs"; then
  :
else
  echo "FAIL: shared remote-store compatibility tests" >&2
  fail=1
fi

if node --test "$SCRIPT_DIR/agentctl/workspace-client.test.mjs"; then
  :
else
  echo "FAIL: unified Workspace integration tests" >&2
  fail=1
fi

if node "$SCRIPT_DIR/agentctl/orchestrator-client.test.mjs"; then
  :
else
  echo "FAIL: development preset and unified doctor tests" >&2
  fail=1
fi

if node --test "$SCRIPT_DIR"/tui/test/*.test.mjs &&
   node "$SCRIPT_DIR/tui/dist/toolbox-tui.mjs" --help >/dev/null; then
  echo "ok  : shared Ink TUI model and committed bundle"
else
  echo "FAIL: shared Ink TUI model or committed bundle" >&2
  fail=1
fi

if "$SCRIPT_DIR/tests/install-commands-test.sh"; then
  :
else
  echo "FAIL: reversible command installer tests" >&2
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "all ${checked} backend scripts parse cleanly; controllers, command installer, and provider tests passed."
else
  echo "one or more scripts failed to parse." >&2
fi
exit "$fail"
