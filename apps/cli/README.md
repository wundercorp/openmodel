# OpenModel (`om`)

[![npm version](https://img.shields.io/npm/v/%40wundercorp%2Fopenmodel.svg)](https://www.npmjs.com/package/@wundercorp/openmodel)
[![npm downloads](https://img.shields.io/npm/dm/%40wundercorp%2Fopenmodel.svg)](https://www.npmjs.com/package/@wundercorp/openmodel)
[![license](https://img.shields.io/npm/l/%40wundercorp%2Fopenmodel.svg)](https://github.com/wundercorp/openmodel/blob/main/LICENSE)

OpenModel is a gateway-first command-line runtime for downloading, running, and serving AI models locally.

It gives you one command, `om`, for working with GGUF artifacts, existing Ollama models, direct model URLs, Hugging Face repositories, and third-party model gateways.

## Features

- Download GGUF models from Hugging Face or any direct HTTPS URL
- Use models already supported by a local Ollama installation
- Run GGUF models through `llama.cpp`
- Start OpenAI-compatible and Ollama-compatible local HTTP endpoints
- Add third-party model gateways without changing the OpenModel core
- Keep downloaded models, manifests, aliases, plugins, and authentication data in an isolated OpenModel data directory
- Authenticate with the OpenModel cloud layer through OAuth device authorization

## Requirements

- Node.js 20.19 or newer
- One local runtime:
  - `llama-cli` from `llama.cpp` for GGUF files
  - `ollama` for Ollama model references

OpenModel does not bundle model weights or native inference engines.

On macOS, install the GGUF runtime with:

```bash
brew install llama.cpp
om doctor
```

A downloaded model can appear in `om list` before a compatible runtime is installed. The model is stored locally at that point, but chat requests will return a runtime-unavailable response until `llama-cli` or another compatible runtime is available.

## Install

```bash
npm install --global @wundercorp/openmodel
om doctor
```

Show all commands:

```bash
om help
```

## Quick start with a GGUF model

Install `llama.cpp` and ensure `llama-cli` is available on `PATH`.

Download a GGUF artifact from Hugging Face:

```bash
om pull \
  hf://TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf \
  --alias tinyllama
```

Run it:

```bash
om run tinyllama "Explain local inference in three sentences."
```

Limit generated tokens:

```bash
om run tinyllama "Write a short poem." --max-tokens 128
```

## Quick start with Ollama

Install and start Ollama, then register a model:

```bash
om pull ollama://qwen2.5:3b
om run qwen2.5:3b "Explain gateway interoperability."
```

## Commands

| Command | Purpose |
| --- | --- |
| `om pull <reference> [--alias name]` | Download or register a model |
| `om run <model> [prompt]` | Run an installed model |
| `om serve [model]` | Start the local HTTP API |
| `om list` | List installed models |
| `om remove <model>` | Remove an installed model |
| `om gateways` | List active model gateways |
| `om gateway add <package>` | Install and register a gateway package |
| `om gateway remove <package>` | Uninstall and unregister a gateway package |
| `om login` | Authenticate with the configured OpenModel cloud |
| `om whoami` | Show the authenticated cloud identity |
| `om logout` | Remove locally stored authentication tokens |
| `om doctor` | Check runtimes, storage, and gateways |
| `om help` | Show CLI help |

Aliases are available for `om list` as `om ls` and `om remove` as `om rm`.

## Model references

### Hugging Face

```text
hf://owner/repository/path/to/model.gguf?revision=main
```

Example:

```bash
om pull hf://bartowski/Llama-3.2-1B-Instruct-GGUF/Llama-3.2-1B-Instruct-Q4_K_M.gguf
```

### Direct artifact URL

```bash
om pull https://example.com/models/model.gguf --alias my-model
```

### Ollama

```text
ollama://model:tag
```

Example:

```bash
om pull ollama://llama3.2:3b
```

## Local API server

Start the server with a default model:

```bash
om serve tinyllama --host 127.0.0.1 --port 11435
```

Check health:

```bash
curl http://127.0.0.1:11435/health
```

List models through the OpenAI-compatible endpoint:

```bash
curl http://127.0.0.1:11435/v1/models
```

Create a chat completion:

```bash
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "tinyllama",
    "messages": [
      {
        "role": "user",
        "content": "What is local inference?"
      }
    ]
  }'
```

Inspect local inference metrics:

```bash
curl http://127.0.0.1:11435/v1/metrics
```

Metrics are kept in memory on the local machine. Prompt and response content are not stored. Token counts are estimated when the selected runtime does not report exact usage.

Generate through the Ollama-compatible endpoint:

```bash
curl http://127.0.0.1:11435/api/generate \
  -H 'content-type: application/json' \
  -d '{
    "model": "tinyllama",
    "prompt": "What is a model gateway?"
  }'
```

Available endpoints:

- `GET /health`
- `GET /v1/models`
- `GET /v1/runtime-status`
- `GET /v1/metrics`
- `POST /v1/metrics/reset`
- `POST /v1/chat/completions`
- `GET /api/tags`
- `POST /api/generate`

## Gateway plugins

Gateways translate provider-specific model references into a portable OpenModel descriptor. Runtime execution remains separate, so gateways can be added without putting provider-specific logic into the CLI core.

Install a gateway package explicitly:

```bash
om gateway add @acme/openmodel-gateway-modelhub
om gateways
```

Install a locally packed gateway during development:

```bash
om gateway add ./acme-openmodel-gateway-modelhub-0.1.0.tgz
```

Remove a gateway:

```bash
om gateway remove @acme/openmodel-gateway-modelhub
```

Gateway packages are installed with lifecycle scripts disabled. OpenModel only loads packages that the user explicitly registers.

Gateway authors can use `@wundercorp/openmodel-gateway-sdk`. See the gateway authoring guide in the OpenModel repository.

## Authentication

The CLI supports OAuth 2.0 device authorization:

```bash
om login
om whoami
om logout
```

Defaults:

```text
Issuer:   https://auth.wundercorp.co
Client:   openmodel-cli
Audience: https://api.openmodel.sh
API:      https://api.openmodel.sh
```

Override them with:

```text
OPENMODEL_AUTH_ISSUER
OPENMODEL_AUTH_CLIENT_ID
OPENMODEL_AUTH_AUDIENCE
OPENMODEL_CLOUD_API_URL
```

## Data directory

Set `OPENMODEL_HOME` to choose where OpenModel stores models, manifests, aliases, plugins, configuration, and authentication state:

```bash
export OPENMODEL_HOME="$HOME/.openmodel"
```

Platform defaults:

- macOS: `~/Library/Application Support/OpenModel`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/openmodel`
- Windows: `%LOCALAPPDATA%\OpenModel`

## Troubleshooting

Check the current installation:

```bash
om doctor
```

Enable stack traces:

```bash
OPENMODEL_DEBUG=1 om run tinyllama "Hello"
```

Common runtime errors:

- `llama.cpp was not found`: install `llama.cpp` and put `llama-cli` on `PATH`
- `Ollama is required`: install Ollama and ensure the `ollama` command works
- `Model is not installed`: run `om pull` before `om run`
- Authentication discovery errors: verify the configured issuer exposes an OpenID Connect discovery document and device authorization endpoint

## Security

Model files and third-party gateway packages are untrusted inputs. Verify their source before installing them. OpenModel disables npm lifecycle scripts when installing gateway plugins, but a registered gateway still executes JavaScript when loaded by the CLI.

Authentication tokens are stored in the OpenModel data directory. Protect that directory with normal user-only filesystem permissions.

## Links

- Website: https://openmodel.sh
- Source: https://github.com/wundercorp/openmodel
- Issues: https://github.com/wundercorp/openmodel/issues
- Gateway SDK: https://www.npmjs.com/package/@wundercorp/openmodel-gateway-sdk

## License

Apache-2.0
