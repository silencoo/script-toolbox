# Agent integration recipes

Recipes are optional examples that complement the agent controllers. They do
not participate in provider setup, credential storage, uninstall, or encrypted
Workspace recovery.

- [`xcode-glm-litellm-proxy/`](./xcode-glm-litellm-proxy/) runs a pinned
  LiteLLM container on loopback and reads the Z.AI key from the environment.
