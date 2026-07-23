# openmodel.sh

OpenModel is a gateway-first local model runtime distributed as `@wundercorp/openmodel`, with a baseui.sh-powered dashboard, a separate marketing site, and a separately deployable cloud API.

<img width="1138" height="720" alt="Bazaart_C1455751-0317-490B-9B26-0165F4BB215E" src="https://github.com/user-attachments/assets/84f5567c-8fbb-4bc8-b42a-32a9e9d92a11" />

## Documentation
https://doku.sh/#/i/a8cb5b73686a2bd50e-511db60796c841
Auto-Generated via https://doku.sh

It provides:

- `om pull` for Hugging Face GGUF files, direct artifact URLs, Ollama model references, and contributed gateways
- `om run` for llama.cpp and Ollama runtimes
- `om serve` with OpenAI-compatible and Ollama-compatible local endpoints
- `om capacity` for detecting, listing, publishing, pausing, and heartbeating provider GPU capacity
- A dashboard GPU-capacity page with provider listings and public availability visualization
- Explicit gateway package registration with a versioned SDK contract
- OIDC device login for the CLI through `auth.wundercorp.co`
- OIDC Authorization Code with PKCE for the website
- AWS Lambda and API Gateway deployment for the cloud layer
- AWS S3 and CloudFront deployment for the production website
- Optional Cloudflare Worker and Pages deployment
- Static website deployment through Docker or Kubernetes
- An `@wundercorp/baseui`-powered dashboard, typed design tokens, Phosphor-backed icons, and a living component catalogue

## Repository layout

```text
apps/cli                 @wundercorp/openmodel npm package
apps/web                 openmodel.sh React website
apps/cloud               optional Cloudflare Worker cloud API
apps/aws-api             AWS Lambda cloud API
packages/gateway-sdk     public gateway authoring contract
gateways/                first-party and example gateway packages
deploy/terraform/aws     Route 53, CloudFront, S3, API Gateway, Lambda, DynamoDB
deploy/terraform/cloudflare optional Cloudflare infrastructure
deploy/                   Docker and Kubernetes manifests
```

## Install

```bash
npm install --global @wundercorp/openmodel
om doctor
```

## Pull and run

```bash
om pull hf://TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --alias tinyllama
om run tinyllama "Write a four-line poem about local inference."
```

Use an existing Ollama model:

```bash
om pull ollama://qwen2.5:3b
om run qwen2.5:3b "Explain gateway interoperability."
```

Start the local API. A default model is optional, so the dashboard can connect before anything is installed:

```bash
om serve --port 11435
curl http://127.0.0.1:11435/v1/models
```

The local server supports:

- `GET /health`
- `GET /v1/models`
- `GET /v1/model-catalog`
- `POST /v1/models/install`
- `GET /v1/model-installs/:jobId`
- `GET /v1/runtime-status`
- `GET /v1/metrics`
- `POST /v1/metrics/reset`
- `POST /v1/chat/completions`
- `GET /api/tags`
- `POST /api/generate`

The web dashboard uses the catalog and install-job endpoints for a one-click starter-model download with local progress reporting. Its Metrics route remains usable without authentication for local request counts, estimated token usage, latency, throughput, runtime activity, per-model usage, and recent requests. Authenticated sessions also load the Wundership monthly allowance, provider/model pricing estimates, local-versus-cloud cost comparisons, usage and cost charts, and idempotent usage synchronization. Installation and metrics-reset requests remain restricted to configured browser origins.

## GPU capacity marketplace

OpenModel now owns the GPU-provider workflow that was previously embedded in the Walton mobile app. Providers can expose hardware from either the CLI or the authenticated dashboard, while buyers can inspect published availability through the dashboard or public API.

Fast CLI setup:

```bash
om login
om capacity detect
om capacity expose \
  --price-hour 0.75 \
  --endpoint https://gpu-provider.example.com/v1
om capacity heartbeat --available-gpus 1 --runtime-status ready
```

`om capacity expose` uses `nvidia-smi` when available to detect GPU model, count, VRAM, and driver version. Explicit flags are available for mixed or non-NVIDIA systems.

The dashboard route is **GPU Capacity**. It supports creating draft or published listings, seeing owned listings, publishing or pausing them, and visualizing public available capacity.

The API contract is available under both hostnames when both custom domains point at the same deployment:

```text
https://api.openmodel.sh/v1/capacity/gpu
https://api.walton.bot/v1/capacity/gpu
```

Provider management requires the same OpenModel bearer identity used by `om login` and the web dashboard. The public listing endpoint does not require authentication. Configure `GPU_CAPACITY_TABLE` for AWS or `GPU_CAPACITY_REGISTRY` for Cloudflare. See `docs/gpu-capacity.md`.

## baseui.sh design system

The dashboard consumes the independently published [`@wundercorp/baseui`](https://www.npmjs.com/package/@wundercorp/baseui) package. The component library is no longer copied into this repository or linked as a workspace package.

Install dependencies normally from the repository root:

```bash
npm install
```

The web workspace imports the package stylesheet once in `apps/web/src/main.tsx`:

```tsx
import "@wundercorp/baseui/styles.css";
```

Shared dashboard primitives are exposed through `apps/web/src/components/ui.tsx`, which keeps product imports stable while resolving them to the external package. The dashboard uses baseui.sh buttons, cards, badges, code blocks, semantic icons, tokens, and the full Phosphor passthrough entry point. The marketing home page retains its existing visual language.

Run the web app and open `/baseui` to review the component catalogue in the OpenModel application:

```bash
npm run dev:web
```

The reusable library itself lives at:

```text
https://github.com/wundercorp/baseui
```

See `docs/baseui-integration.md`, `docs/baseui-design-language.md`, and `docs/baseui-validation.md` for the integration boundary and dashboard-specific usage rules.

## Gateway interoperability

Gateways normalize external model catalogs and artifact sources into a stable descriptor. Runtimes are separate from gateways, so one gateway can feed multiple local runtimes and one runtime can execute models from multiple gateways.

Built-in gateway reference formats:

```text
hf://owner/repository/path/to/model.gguf?revision=main
https://example.com/model.gguf
ollama://model:tag
```

Third-party gateway packages are explicit and opt-in:

```bash
om gateway add @acme/openmodel-gateway-modelhub
om gateways
```

See `docs/gateway-authoring.md` and `gateways/example-gateway`.

## Authentication

The CLI uses OAuth 2.0 Device Authorization Grant when supported by the configured issuer:

```bash
om login
om whoami
om logout
```

Defaults can be overridden with:

```text
OPENMODEL_AUTH_ISSUER
OPENMODEL_AUTH_CLIENT_ID
OPENMODEL_AUTH_AUDIENCE
OPENMODEL_CLOUD_API_URL
```

Expired CLI access tokens are refreshed automatically when a refresh token is available. Protected API deployments must accept the CLI app client ID in `AUTH_AUDIENCE` in addition to the web app client ID.

The website uses Authorization Code with PKCE and stores access tokens in session storage rather than local storage.

## Development

```bash
npm install
npm run check
npm test
npm run build
```

See `LOCAL.md` for complete CLI, website, cloud API, Docker Compose, authentication, gateway-plugin, and pre-deployment instructions.

## Package releases

Preview the next CLI patch version without changing files:

```bash
npm run version:bump -- patch --package cli --dry-run
```

Create, validate, commit, push, publish, and tag a CLI patch release:

```bash
./release.sh patch \
  --package cli \
  --commit \
  --push \
  --publish \
  --tag \
  --yes
```

SDK increments automatically update the CLI dependency and give the CLI its own release bump. See `RELEASING.md` for prereleases, GitHub tag publication, and all available options.

## Deployment

The production domain is hosted in Route 53, so AWS is the default provider.

Create the protected configuration:

```bash
cp env.deploy.example .env.deploy
chmod 600 .env.deploy
```

Validate without deploying:

```bash
./deploy.sh --validate-only
```

Review the Terraform plan:

```bash
./deploy.sh --plan-only
```

Deploy the website and API without publishing npm packages:

```bash
./deploy.sh --yes
```

Deploy and explicitly publish the npm packages:

```bash
./deploy.sh --publish-npm --yes

When package contents changed but the current version is already on npm, deployment automatically selects an unpublished patch version for the affected package.
```

Initialize and push the source repository separately:

```bash
./git-init.sh
GIT_REMOTE_URL="git@github.com:wundercorp/openmodel.git" ./git-push.sh
```

Or compose Git with deployment:

```bash
./deploy.sh \
  --git-init \
  --git-push \
  --git-remote-url git@github.com:wundercorp/openmodel.git \
  --yes
```

The AWS deployment verifies and uses the existing Route 53 hosted zone and assigned name servers, private S3 storage, CloudFront, ACM, API Gateway, Lambda, DynamoDB, CloudWatch, and an encrypted remote Terraform state bucket. See `DEPLOY.md` and `GIT.md`.

The optional Cloudflare deployment remains available:

```bash
./deploy.sh --provider cloudflare --yes
```

Local composition remains available with:

```bash
docker compose -f deploy/docker/compose.yaml up --build
```

Kubernetes manifests live in `deploy/kubernetes`. They contain no credentials and use a separately created Secret for environment-specific values.

## Scope

OpenModel can only run formats supported by an installed runtime. The included llama.cpp adapter targets GGUF artifacts. The Ollama adapter targets models supported by the local Ollama installation. Other formats and remote providers belong in runtime or gateway plugins rather than hard-coded CLI branches.

## License

Apache-2.0

## Cloud agent session telemetry

OpenModel can collect token and cost usage from Claude Code, Codex, OpenRouter, BuilderStudio, and other cloud-backed agents through OTLP logs or normalized local usage events. Collection stays local until `om telemetry sync` is run. See [Cloud Agent Session Telemetry](docs/session-telemetry.md).

```bash
om setup
om serve --port 11435
om setup claude-code --launch
om telemetry summary
om telemetry sync
```

