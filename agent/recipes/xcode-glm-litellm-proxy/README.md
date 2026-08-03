# Xcode through a local LiteLLM proxy

This recipe exposes a Z.AI coding model through LiteLLM's local
OpenAI-compatible endpoint so it can be configured as a locally hosted model
provider in Xcode.

The example currently names `glm-4.6`. Change both `model_name` and `model` in
`litellm-config.yaml` when using a different model. The container image is
pinned by tag and digest so an upstream update cannot silently change the
proxy.

## Requirements

- Xcode with support for locally hosted model providers
- Docker with Compose
- A Z.AI API key with access to the configured model

## Start

Export the key in the shell that starts Compose:

```bash
export ZAI_API_KEY='replace-with-your-key'
docker compose up -d
```

The proxy is bound to loopback only. Verify it locally:

```bash
curl --fail http://127.0.0.1:4000/v1/models
```

In Xcode, add a locally hosted model provider on port `4000`. Stop the proxy
with:

```bash
docker compose down
```

If the container reports that `/app/config.yaml` is a directory, make sure
`litellm-config.yaml` exists next to `docker-compose.yml` before starting it.

LiteLLM is maintained by [BerriAI](https://github.com/BerriAI/litellm); its
software and container image remain subject to the upstream license and terms.
