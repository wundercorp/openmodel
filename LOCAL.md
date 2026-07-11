# Run OpenModel locally

This guide runs the CLI, website, and cloud API from one checkout before any npm, container, Cloudflare, or Kubernetes deployment.

## 1. Prerequisites

Required:

- Node.js 20.19 or newer
- npm 10 or newer
- Git

Optional, depending on what you want to test:

- Docker Engine with Docker Compose v2 for the containerized website and cloud API
- Ollama for `ollama://` model references and Ollama-backed inference
- llama.cpp with `llama-cli` on `PATH` for local GGUF inference
- A Hugging Face token for gated or private repositories

Confirm the required tools:

```bash
node --version
npm --version
git --version
```

Confirm optional runtimes:

```bash
ollama --version
llama-cli --version
```

## 2. Install the monorepo

From the repository root:

```bash
npm install
```

Run the complete source validation:

```bash
npm run check
npm test
npm run build
```

## 3. Use the CLI from source

The npm package is named `@wundercorp/openmodel`, but the executable command is `om`.

Run it through the repository script without installing anything globally:

```bash
npm run dev:cli -- help
npm run dev:cli -- doctor
npm run dev:cli -- gateways
```

To use the literal `om` command while developing, create a global npm link:

```bash
cd apps/cli
npm link
cd ../..
om help
om doctor
```

Remove the development link later with:

```bash
npm uninstall --global @wundercorp/openmodel
```

### Keep development model data inside the repository

By default, OpenModel uses the operating system application-data directory. For an isolated local checkout, set `OPENMODEL_HOME` to an ignored directory:

```bash
export OPENMODEL_HOME="$PWD/.openmodel"
```

PowerShell:

```powershell
$env:OPENMODEL_HOME = "$PWD/.openmodel"
```

The `.openmodel/` directory, downloaded models, credentials, and model-weight formats are ignored by Git.

### Test the built-in gateways without inference

```bash
om gateways
om doctor
```

Pull a public GGUF file:

```bash
om pull hf://OWNER/REPOSITORY/path/to/model.gguf --alias local-model
om list
```

For gated or private Hugging Face repositories:

```bash
export HF_TOKEN="your-development-token"
om pull hf://OWNER/REPOSITORY/path/to/model.gguf --alias local-model
```

Do not place a real token in a committed file.

Pull through an existing Ollama installation:

```bash
om pull ollama://qwen2.5:3b
om list
```

### Run a model

GGUF through llama.cpp:

```bash
om run local-model "Explain local model gateways in one paragraph." --runtime llama.cpp
```

Ollama:

```bash
om run qwen2.5:3b "Explain local model gateways in one paragraph." --runtime ollama
```

### Start the local inference API

```bash
om serve local-model --host 127.0.0.1 --port 11435
```

In another terminal:

```bash
curl http://127.0.0.1:11435/health
curl http://127.0.0.1:11435/v1/models
```

OpenAI-compatible request:

```bash
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "local-model",
    "messages": [
      {"role": "user", "content": "Say hello from a local model."}
    ]
  }'
```

Ollama-compatible request:

```bash
curl http://127.0.0.1:11435/api/generate \
  -H 'content-type: application/json' \
  -d '{
    "model": "local-model",
    "prompt": "Say hello from a local model.",
    "stream": false
  }'
```

Remove a test model:

```bash
om remove local-model
```

## 4. Run the website locally

Create a local-only Vite environment file:

```bash
cp apps/web/.env.local.example apps/web/.env.local
```

Start the development server:

```bash
npm run dev:web
```

Open:

```text
http://localhost:5173
```

The landing page, themes, accents, gateway content, and API examples work without signing in.

The sign-in button uses the configured Cognito domain. The Cognito app client must allow this callback:

```text
http://localhost:5173/auth/callback
```

The local environment file is ignored by Git. Never add client secrets to a Vite environment variable because every `VITE_*` value is public in the browser bundle.

## 5. Run the cloud API locally

Start Wrangler's local Worker runtime:

```bash
npm run dev:cloud
```

The default Worker URL is:

```text
http://127.0.0.1:8787
```

Test the public endpoints:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/gateways
```

The protected endpoints continue to validate real RS256 access tokens from the configured issuer. For Cognito, set `AUTH_AUDIENCE` to the same generated app client ID used by the web application and obtain an access token whose `client_id` matches that value. After changing the app client ID, sign out and sign in again so the browser does not reuse a token from the previous client:

```bash
curl http://127.0.0.1:8787/v1/me \
  -H "authorization: Bearer $OPENMODEL_ACCESS_TOKEN"
```

To use local Worker overrides, create the ignored file below:

```bash
cp apps/cloud/.dev.vars.example apps/cloud/.dev.vars
```

Only put development values in `.dev.vars`. It is ignored by Git.

The contributed-gateway write endpoint also requires a `gateways:write` permission or scope and a configured `GATEWAY_REGISTRY` KV binding. Public gateway listing works without KV and returns the built-in gateways.

## 6. Run website and cloud API together without Docker

Use two terminals from the repository root.

Terminal 1:

```bash
npm run dev:cloud
```

Terminal 2:

```bash
cp -n apps/web/.env.local.example apps/web/.env.local
npm run dev:web
```

Verify both services:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/gateways
curl -I http://localhost:5173
```

The model inference API is a third independent process. Start it only when you need local model execution:

```bash
om serve local-model --port 11435
```

## 7. Run website and cloud API with Docker Compose

Build and start both services:

```bash
docker compose -f deploy/docker/compose.yaml up --build
```

Open the website:

```text
http://localhost:8080
```

Test the Worker:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/gateways
```

Stop the stack:

```bash
docker compose -f deploy/docker/compose.yaml down
```

The Compose website build uses these local defaults:

```text
Website:          http://localhost:8080
OIDC callback:    http://localhost:8080/auth/callback
Cloud API:        http://localhost:8787
Auth issuer:      https://auth.wundercorp.co
Auth audience:    https://api.openmodel.sh
```

Override them from the shell when needed:

```bash
OPENMODEL_WEB_AUTH_CLIENT_ID=replace-with-cognito-app-client-id \
OPENMODEL_WEB_REDIRECT_URI=http://localhost:8080/auth/callback \
OPENMODEL_CLOUD_API_URL=http://localhost:8787 \
docker compose -f deploy/docker/compose.yaml up --build
```

The CLI and local inference server are intentionally not placed inside Compose. They need direct access to model files, host accelerators, and locally installed runtimes. Run `om` on the host while the web and cloud services run in containers.

## 8. Test a contributed gateway locally

The included example is a workspace package. First validate all gateway contracts:

```bash
npm test
```

To test installation behavior exactly as an external contributor would, pack the SDK and example gateway, install the SDK into the isolated plugin directory, and add the generated gateway package through `om`:

```bash
mkdir -p .artifacts
npm pack --workspace @wundercorp/openmodel-gateway-sdk --pack-destination .artifacts
npm pack --workspace @wundercorp/openmodel-gateway-example --pack-destination .artifacts

npm install \
  --prefix "$OPENMODEL_HOME/plugins" \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  "$PWD/.artifacts/wundercorp-openmodel-gateway-sdk-0.1.0.tgz"

om gateway add "$PWD/.artifacts/wundercorp-openmodel-gateway-example-0.1.0.tgz"
om gateways
```

`om` records the installed package name from the plugin package manifest, so local tarball paths and registry package specifications use the same gateway-loading path.

Remove it after testing:

```bash
om gateway remove @wundercorp/openmodel-gateway-example
```

Package archives and `.artifacts/` are ignored by Git.

## 9. Validate npm publication without publishing

Inspect the exact package contents:

```bash
mkdir -p .artifacts
npm run pack:cli
npm publish --workspace @wundercorp/openmodel-gateway-sdk --dry-run
npm publish --workspace @wundercorp/openmodel --dry-run
```

Confirm that the CLI package exposes `om`:

```bash
tar -xOf .artifacts/wundercorp-openmodel-0.1.0.tgz package/package.json | grep -A 2 '"bin"'
```

## 10. Final pre-deployment checklist

Run:

```bash
npm run check
npm test
npm run build
npm run release:dry-run
git status --short
```

Confirm that `git status` does not contain:

- `.env`, `.env.local`, or `.dev.vars`
- access tokens, credentials, keys, or certificates
- `.openmodel/` or downloaded model files
- `node_modules/`, `dist/`, `.wrangler/`, or build caches
- package archives under `.artifacts/`
- Terraform state, Kubernetes credentials, or deployment-specific overrides

After these checks pass, follow `docs/deployment.md` for production deployment.

## Deployment preflight

Before using production credentials, validate the one-shot deployment path locally:

```bash
npm run deploy:validate
```

Review the production plan after creating a secure ignored `.env.deploy` file:

```bash
cp env.deploy.example .env.deploy
chmod 600 .env.deploy
npm run deploy -- --plan-only
```

The full deployment and npm release procedure is documented in `DEPLOY.md`.

## Cloud agent telemetry

Run `om setup` for the guided external-usage workflow. Keep `om serve --port 11435` running, then connect a tool with `om setup <integration>`. The easiest Claude Code path is `om setup claude-code --launch`. Codex prints a block to add to `~/.codex/config.toml`; OpenRouter and BuilderStudio print exact SDK reporting examples. Review events with `om telemetry summary`, view them under Metrics → External Usage, and publish them explicitly with `om telemetry sync`. Full setup examples are in `docs/session-telemetry.md`.
