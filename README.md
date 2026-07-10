# openmodel.sh

OpenModel is a gateway-first local model runtime distributed as `@wundercorp/openmodel`, with a shadcn-styled website and a separately deployable cloud API.

<img width="1138" height="720" alt="Bazaart_C1455751-0317-490B-9B26-0165F4BB215E" src="https://github.com/user-attachments/assets/84f5567c-8fbb-4bc8-b42a-32a9e9d92a11" />

It provides:

- `om pull` for Hugging Face GGUF files, direct artifact URLs, Ollama model references, and contributed gateways
- `om run` for llama.cpp and Ollama runtimes
- `om serve` with OpenAI-compatible and Ollama-compatible local endpoints
- Explicit gateway package registration with a versioned SDK contract
- OIDC device login for the CLI through `auth.wundercorp.co`
- OIDC Authorization Code with PKCE for the website
- AWS Lambda and API Gateway deployment for the cloud layer
- AWS S3 and CloudFront deployment for the production website
- Optional Cloudflare Worker and Pages deployment
- Static website deployment through Docker or Kubernetes

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

Start a local API:

```bash
om serve tinyllama --port 11435
curl http://127.0.0.1:11435/v1/models
```

The local server supports:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /api/tags`
- `POST /api/generate`

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
