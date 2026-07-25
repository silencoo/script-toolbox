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

run_config_tests() {
  local test_root fake_bin test_home system_path
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

  printf '%s\n' \
    'export ANTHROPIC_AUTH_TOKEN=stale-token' \
    'export KEEP_THIS_VALUE=yes' > "$test_home/.zshrc"
  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider deepseek --model deepseek-v4-pro --key test-claude \
      --skip-validate --clean-shell-env --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .env.ANTHROPIC_BASE_URL == "https://api.deepseek.com/anthropic"
    and .env.ANTHROPIC_API_KEY == "test-claude"
    and .env.ANTHROPIC_AUTH_TOKEN == null
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

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/claude-code/setup.sh" \
      --provider openrouter --model openrouter/auto --key test-claude-token \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  jq -e '
    .env.ANTHROPIC_AUTH_TOKEN == "test-claude-token"
    and .env.ANTHROPIC_API_KEY == null
    and .model == "openrouter/auto"
  ' "$test_home/.claude/settings.json" >/dev/null || { rm -rf "$test_root"; return 1; }

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" \
      --provider openrouter --model openai/gpt-5.6 --key test-codex \
      --skip-validate --force >/dev/null || { rm -rf "$test_root"; return 1; }
  grep -q 'wire_api = "responses"' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  grep -q '\[model_providers.script_toolbox_openrouter.auth\]' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  [ "$(cat "$test_home/.codex/provider-keys/script_toolbox_openrouter.key")" = "test-codex" ] || {
    rm -rf "$test_root"; return 1;
  }
  [ "$(stat -c '%a' "$test_home/.codex/provider-keys/script_toolbox_openrouter.key" 2>/dev/null || stat -f '%Lp' "$test_home/.codex/provider-keys/script_toolbox_openrouter.key")" = "600" ] || {
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

  HOME="$test_home" PATH="${fake_bin}:${system_path}" \
    "$SCRIPT_DIR/codex/setup.sh" --uninstall >/dev/null || { rm -rf "$test_root"; return 1; }
  ! grep -qF 'agent/codex/setup.sh' "$test_home/.codex/config.toml" || { rm -rf "$test_root"; return 1; }
  [ ! -e "$test_home/.codex/provider-keys/script_toolbox_openrouter.key" ] || {
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
run_config_tests || config_test_status=$?
if [ "$config_test_status" -eq 0 ]; then
  echo "ok  : isolated provider config + uninstall"
elif [ "$config_test_status" -eq 2 ]; then
  echo "skip: isolated provider config + uninstall (jq unavailable)"
else
  echo "FAIL: isolated provider config + uninstall" >&2
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "all ${checked} scripts parse cleanly; provider config tests passed."
else
  echo "one or more scripts failed to parse." >&2
fi
exit "$fail"
