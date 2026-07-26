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
- Detect and expose provider GPU capacity through `api.openmodel.sh` with `api.walton.bot` fallback
- Launch isolated Box VMs with BuilderStudio `bs` as the primary agent and Claude Code or Codex as secondary options

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
| `om capacity detect` | Detect NVIDIA GPU model, count, VRAM, and driver |
| `om capacity expose --price-hour N` | Create a provider GPU listing |
| `om capacity list` | Browse public GPU capacity |
| `om capacity mine` | Show your provider listings |
| `om capacity publish [id]` | Publish a draft or paused listing |
| `om capacity pause [id]` | Pause a listing |
| `om capacity heartbeat [id]` | Update a legacy provider-handoff listing |
| `om provider enroll` | Register a GPU worker and store its one-time node token |
| `om provider agent [--once]` | Heartbeat and poll assignments with retry backoff |
| `om provider nodes` | Show registered worker status and effective capacity |
| `om provider assignments` | Show active assignments for the selected worker |
| `om provider accept|start|usage|complete|fail <id>` | Advance and meter an assignment |
| `om provider drain|disable|enable` | Manage worker maintenance state |
| `om provider earnings` | Show pending, available, held, and paid earnings |
| `om provider payout-profile` | Configure a tokenized payout destination |
| `om provider payout` | Request settlement of available earnings |
| `om box setup [--install]` | Install or authenticate the Box CLI |
| `om box create [prompt]` | Create an isolated Box VM, optionally upload a project, and run an agent |
| `om box prompt <box-id> <prompt>` | Continue work with BuilderStudio `bs`, Claude Code, or Codex in an existing Box |
| `om box stop|resume|fork|ssh|host ...` | Manage Box lifecycle and hosted previews |
| `om help` | Show CLI help |

Aliases are available for `om list` as `om ls` and `om remove` as `om rm`.

## Run coding agents in Box VMs

OpenModel uses [Box](https://box.ascii.dev) for isolated VM lifecycle and [BuilderStudio `bs`](https://www.npmjs.com/package/@wundercorp/bs) as the primary in-VM coding agent. Claude Code and Codex remain secondary options.

Install and authenticate:

```bash
npm install --global @wundercorp/openmodel
curl -fsSL https://box.ascii.dev/install | sh
export BOX_API_KEY=your_box_api_key
om box setup
```

Start the default BuilderStudio agent. A fresh no-env VM needs explicit OpenRouter model access:

```bash
export OPENROUTER_API_KEY=your_openrouter_api_key

om box create \
  "Inspect this repository, run its tests, and implement the next useful fix" \
  --project . \
  --env OPENROUTER_API_KEY
```

OpenModel installs `@wundercorp/bs` inside the VM, initializes the uploaded project, and runs `bs gain`. Choose another BuilderStudio workflow with `--bs-mode ask|plan|agent|swarm`.

Continue work:

```bash
om box prompt bx_your_box_id \
  "Implement the approved change" \
  --agent bs \
  --workdir /home/user/your-project
```

Use a secondary agent explicitly:

```bash
om box create "Review the repository" --project . --agent claude-code
om box create "Review the repository" --project . --agent codex
```

For an application preview, OpenModel can install a restartable systemd service and request a private Box HTTPS URL:

```bash
om box create \
  "Verify the application starts" \
  --project . \
  --env OPENROUTER_API_KEY \
  --setup-command "npm ci" \
  --start-command "npm run dev -- --host 0.0.0.0" \
  --port 3000
```

Use `--public` only when the preview is intentionally public. Build a prepared VM once, stop it, and use `--template bx_template_id` for fast forks. If upload, setup, agent installation, service installation, hosting, or the initial prompt fails, OpenModel attempts to stop the new Box automatically.

See [`../../docs/box-agent-vms.md`](../../docs/box-agent-vms.md) for the full command and security guide.

## Become a GPU provider

Authenticate and enroll the physical worker. `nvidia-smi` supplies model, count, VRAM, and driver when available:

```bash
om login
om provider enroll \
  --name worker-1 \
  --endpoint https://gpu-provider.example.com/v1 \
  --region eu-central
```

Start the safe pull agent:

```bash
om provider agent --interval-seconds 30
```

The agent heartbeats, reports provider-observed availability, and pulls assignments with a node-scoped token. It uses jitter and bounded exponential retry. It does not run arbitrary workload commands automatically. `--once` is suitable for cron, systemd timers, and tests.

Publish a listing linked to the enrolled worker:

```bash
om capacity expose \
  --node-id <node-id> \
  --price-hour 0.75 \
  --allocation EXCLUSIVE \
  --connection OPENMODEL_API \
  --location "Location shared after purchase"
```

Process a reservation explicitly:

```bash
om provider assignments
om provider accept <reservation-id> --session-reference local-session-123
om provider start <reservation-id>
om provider usage <reservation-id> --sequence 1 --billable-seconds 300
om provider complete <reservation-id> --sequence 2 --billable-seconds 3600
```

Use `om provider drain` before maintenance. A draining worker receives no new reservations but can finish existing work. The master rejects disable while active assignments exist.

Configure a processor-issued payout reference and request settlement after verification and the earnings hold:

```bash
om provider payout-profile \
  --method STRIPE_CONNECT \
  --destination-reference acct_123 \
  --destination-label "Business account"
om provider earnings
om provider payout --currency USD
```

Never pass raw bank credentials, card data, wallet private keys, passwords, or API secrets as a destination reference. Changing the destination resets verification.

`OPENMODEL_CLOUD_API_URL` defaults to `https://api.openmodel.sh`; `OPENMODEL_CLOUD_API_FALLBACK_URL` defaults to `https://api.walton.bot`. Both hostnames must route to the same identity and capacity deployment.

For the reservation, metering, earnings, payout, security, and failure-state contract, see `../../docs/gpu-provider-marketplace.md`.

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
OPENMODEL_CLOUD_API_FALLBACK_URL
```

OpenModel refreshes an expired access token automatically when the identity provider issued a refresh token. The API deployment must include the CLI app client ID in its comma-separated `AUTH_AUDIENCE` value; otherwise login succeeds but protected commands such as `om capacity expose` return HTTP 401.

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

## External usage telemetry

Run the guided setup flow:

```bash
om setup
```

Start the collector and connect a supported tool:

```bash
om serve --port 11435
om setup claude-code --launch
om setup codex
om setup openrouter
om setup bs
```

After running a cloud-model request, verify and optionally synchronize normalized usage metadata:

```bash
om telemetry summary
om telemetry sync
```

The dashboard displays these sessions under **Metrics → External Usage**. Prompt and response content are excluded from the local telemetry ledger.
