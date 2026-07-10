# Deployment architecture

Use `DEPLOY.md` and the root `deploy.sh` command for the supported one-shot production deployment.

## Default AWS architecture

Route 53 is authoritative for `openmodel.sh`, so AWS is the default provider.

Terraform manages:

- Existing hosted-zone application records
- ACM certificate validation
- Private S3 website storage
- CloudFront distribution and origin access control
- API Gateway HTTP API and custom domain
- Lambda cloud API
- DynamoDB gateway registry
- IAM and CloudWatch resources

The deployment script manages deployable artifacts:

- `apps/web/dist` upload to S3
- CloudFront invalidation
- `apps/aws-api/dist/index.mjs` Lambda bundle consumed by Terraform

npm manages immutable public releases:

- `@wundercorp/openmodel-gateway-sdk`
- `@wundercorp/openmodel`

## One-shot commands

```bash
./deploy.sh --validate-only
./deploy.sh --plan-only
./deploy.sh --yes
./deploy.sh --publish-npm --yes
```

## Source-control commands

```bash
./git-init.sh
GIT_REMOTE_URL="git@github.com:wundercorp/openmodel.git" ./git-push.sh
```

Compose Git and deployment only when desired:

```bash
./deploy.sh \
  --git-init \
  --git-push \
  --git-remote-url git@github.com:wundercorp/openmodel.git \
  --yes
```

## Browser build variables

```text
VITE_AUTH_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE
VITE_AUTH_DOMAIN=https://auth.wundercorp.co
VITE_AUTH_CLIENT_ID=replace-with-cognito-app-client-id
VITE_AUTH_REDIRECT_URI=https://openmodel.sh/auth/callback
VITE_AUTH_LOGOUT_URI=https://openmodel.sh
VITE_AUTH_SCOPES=openid profile email
VITE_API_URL=https://api.openmodel.sh
```

These are public browser configuration values. Never place secrets in `VITE_*` variables. The Cognito web app client must not have a client secret.

## Lambda variables

```text
AUTH_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE
AUTH_AUDIENCE=replace-with-cognito-app-client-id
ALLOWED_ORIGINS=https://openmodel.sh
GATEWAY_REGISTRY_TABLE=openmodel-gateway-registry
```

Terraform injects these values into the Lambda environment.

## Authentication and secrets

The deployment uses the normal AWS credential chain. Prefer AWS IAM Identity Center locally and GitHub OIDC in CI.

Do not store these values in the repository or `.env.deploy`:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN
```

`NPM_TOKEN` is required only when explicitly publishing npm packages without npm trusted publishing.

## Terraform state

The AWS deploy script bootstraps a private, encrypted, versioned S3 backend and enables native S3 lock files. Generated backend configuration and plans live under `.deploy/` and are ignored.

## Optional Cloudflare architecture

The earlier Cloudflare Worker and Pages path remains available:

```bash
./deploy.sh --provider cloudflare --yes
```

Use that provider only with an intentionally supported DNS topology. The Route 53-hosted root domain is why AWS is the production default.

## Rollback

For the website, restore a previous S3 object version or redeploy a prior Git commit and invalidate CloudFront. For the Lambda API, redeploy a prior Git commit. Use a reviewed Terraform revert for infrastructure changes and publish a new corrected npm version rather than trying to overwrite an immutable release.

See `docs/cognito-dashboard.md` for the complete Cognito callback, sign-out, local development, and dashboard setup.
