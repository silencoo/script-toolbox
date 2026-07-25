# Changelog — Pi

## 2026-07-25 — transactional setup

- Missing `jq` is installed automatically on supported package managers.
- Both Pi JSON updates are generated successfully before either file is
  replaced, and the previous credential is retained until the new config is
  ready.

## 2026-07-25

- Added the current `@earendil-works/pi-coding-agent` installer.
- Added interactive Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter,
  MiniMax China/global, and custom-provider selection.
- Added Pi-native Chat Completions, Responses, Anthropic Messages, and Google
  Generative AI protocol choices.
- Stores credentials in a separate mode-`0600` file and references it through
  Pi's command-backed `apiKey` setting.
- Requires Node.js 22.19 or newer, matching the current upstream package.
