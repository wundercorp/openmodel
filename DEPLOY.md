# OpenModel Production Deployment

## Production topology

The `openmodel.sh` public hosted zone is already in Amazon Route 53:

- AWS account: `<YOUR_AWS_ACCOUNT_ID>`
- Hosted zone: `<YOUR_ROUTE53_HOSTED_ZONE_ID>`
- Assigned name servers: `<ROUTE53_NAME_SERVER_1>`, `<ROUTE53_NAME_SERVER_2>`, `<ROUTE53_NAME_SERVER_3>`, and `<ROUTE53_NAME_SERVER_4>`
- Website: `openmodel.sh`
- API: `api.openmodel.sh`

The default deployment provider is AWS because the domain is delegated to Route 53. The AWS deployment creates:

- A private, versioned S3 bucket for the website
- CloudFront with origin access control, TLS, IPv6, compression, SPA fallback, and security headers
- ACM certificate validation through Route 53
- Route 53 `A` and `AAAA` alias records for the CloudFront website
- A Route 53 `A` alias record for the API Gateway custom domain
- API Gateway HTTP API at `api.openmodel.sh`
- A Node.js Lambda API
- A DynamoDB contributed-gateway registry with point-in-time recovery
- CloudWatch logs with configured retention
- A private, encrypted, versioned S3 Terraform state bucket with native state locking

The existing hosted zone is referenced by ID. Terraform does not create, delete, or replace the zone, its NS records, or its SOA record.

## Prerequisites

Install:

- Node.js 20.19 or newer
- npm
- Git
- Terraform 1.10 or newer
- AWS CLI v2
- curl

Authenticate through an AWS profile, AWS IAM Identity Center, an instance role, or CI OIDC. Do not place AWS access keys in `.env.deploy`.

Example AWS IAM Identity Center setup:

```bash
aws configure sso --profile wundercorp
aws sso login --profile wundercorp
aws sts get-caller-identity --profile wundercorp
```

The returned account must be `<YOUR_AWS_ACCOUNT_ID>`.

## Configure deployment

Use the private `.env.deploy` file directly and keep it at mode `600`:

```bash
chmod 600 .env.deploy
```

For an AWS profile, set:

```dotenv
OPENMODEL_DEPLOY_PROVIDER="aws"
OPENMODEL_AWS_PROFILE="wundercorp"
OPENMODEL_AWS_ACCOUNT_ID="<YOUR_AWS_ACCOUNT_ID>"
OPENMODEL_ROUTE53_ZONE_ID="<YOUR_ROUTE53_HOSTED_ZONE_ID>"
OPENMODEL_ROUTE53_ZONE_NAME="openmodel.sh"
OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS="<ROUTE53_NAME_SERVER_1>,<ROUTE53_NAME_SERVER_2>,<ROUTE53_NAME_SERVER_3>,<ROUTE53_NAME_SERVER_4>"
OPENMODEL_WUNDERSHIP_API_URL="https://api.wundership.com/api/openmodel/v1"
```

Keep account IDs, hosted-zone IDs, state-bucket names, delegation sets, and tokens only in the ignored `.env.deploy` or protected CI settings. The deploy script verifies configured targets before changing resources. The account ID can be discovered from the active AWS identity, and the hosted-zone ID can be discovered from the zone name when omitted.

Do not add these values to the file:

```dotenv
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
```

Use the AWS credential chain instead.

## Validate without deployment

```bash
./deploy.sh --validate-only
```

This installs locked dependencies, checks source files, runs tests, builds the website, bundles the Lambda API, validates npm package contents, initializes Terraform without a backend, and validates Terraform configuration.

## Review the AWS plan

```bash
./deploy.sh --plan-only
```

The command verifies the AWS account, hosted-zone name, and assigned Route 53 name servers before planning. On the first run it can create the Terraform state bucket named:

```text
openmodel-terraform-state-<YOUR_AWS_ACCOUNT_ID>
```

The state object key defaults to:

```text
openmodel/production.tfstate
```

Disable automatic state-bucket creation with:

```dotenv
OPENMODEL_TERRAFORM_BOOTSTRAP_STATE="0"
```

## Deploy the website and API

Interactive:

```bash
./deploy.sh
```

Non-interactive:

```bash
./deploy.sh --yes
```

This does not publish npm packages unless npm publication is explicitly enabled.

After Terraform applies, the script:

1. Uploads hashed website assets with immutable cache headers.
2. Uploads `index.html` with no-cache headers.
3. Removes files from S3 that are no longer present in the build.
4. Creates a CloudFront invalidation.
5. Checks `https://api.openmodel.sh/health`.
6. Checks `https://openmodel.sh`.

CloudFront and certificate provisioning can take several minutes even after Terraform completes.

## Publish npm packages too

Set an npm automation token in the protected deployment file:

```dotenv
NPM_TOKEN="replace-with-npm-automation-token"
OPENMODEL_PUBLISH_NPM="1"
NPM_DIST_TAG="latest"
```

Then run:

```bash
./deploy.sh --publish-npm --yes
```

The gateway SDK is checked before the CLI. Missing versions are published. When an exact version already exists, OpenModel compares the local packed files with the published tarball. Matching packages are safely reused. Differing package contents trigger an automatic patch increment for only the affected package; an SDK increment also increments the CLI because the CLI pins the SDK exactly. The deployment then continues with the newly selected unpublished version.

`deploy.sh` publishes the versions already recorded in the package manifests; it does not change versions. Use the separate release incrementer before deployment when a new npm version is required:

```bash
./release.sh patch --package cli --commit --push --publish --tag --yes
```

See `RELEASING.md` for SDK, minor, major, and prerelease releases.

To deploy the site and API without npm publication:

```bash
./deploy.sh --yes
```

Do not pass `--publish-npm`, and leave `OPENMODEL_PUBLISH_NPM="0"`.

## Git repository one-shot commands

Configure your Git identity once:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Initialize the repository and create the first safe commit:

```bash
./git-init.sh
```

Push to an existing repository:

```bash
GIT_REMOTE_URL="git@github.com:wundercorp/openmodel.git" ./git-push.sh
```

Create a public GitHub repository and push using GitHub CLI:

```bash
gh auth login
./git-push.sh \
  --create-github \
  --repository wundercorp/openmodel \
  --visibility public
```

The Git scripts refuse to push a dirty working tree or known sensitive and generated files.

## Git and deployment in one command

For a new repository with an existing remote:

```bash
./deploy.sh \
  --git-init \
  --git-push \
  --git-remote-url git@github.com:wundercorp/openmodel.git \
  --yes
```

Create the GitHub repository, push, deploy AWS, and publish npm packages:

```bash
./deploy.sh \
  --git-init \
  --git-push \
  --git-create-github \
  --git-repository wundercorp/openmodel \
  --git-visibility public \
  --publish-npm \
  --yes
```

Git remains optional. A normal `./deploy.sh --yes` never initializes or pushes a repository.

## Cloudflare alternative

The original Cloudflare Pages and Workers deployment remains available:

```bash
./deploy.sh --provider cloudflare --yes
```

Because the authoritative DNS zone is in Route 53, the AWS provider is the correct default for the root website and API custom domains. Use Cloudflare custom-domain management only after intentionally moving the zone's authoritative name servers to Cloudflare or designing a supported external-DNS topology.

## Required AWS permissions

The deploying identity needs permission for:

- STS caller identity
- S3 bucket and object management
- CloudFront distributions, origin access controls, policies, and invalidations
- ACM certificates
- Route 53 records in hosted zone `<YOUR_ROUTE53_HOSTED_ZONE_ID>`
- Lambda functions and permissions
- API Gateway v2 APIs and custom domains
- DynamoDB tables
- IAM roles and inline policies for the Lambda function
- CloudWatch log groups

Use a dedicated deployment role rather than root credentials.

## Terraform state safety

The deployment script creates an S3 backend configuration in `.deploy/aws-backend.hcl`. It is mode `600` and ignored by Git.

The state bucket uses:

- Public-access blocking
- Server-side encryption
- Versioning
- Terraform S3 native lock files

Terraform state can contain infrastructure metadata. Never commit it, upload it to issue trackers, or share it publicly.

## Destruction safeguards

The website bucket and gateway registry table use `prevent_destroy`. The website bucket also defaults to `force_destroy = false`.

Do not remove these safeguards simply to make a destroy command succeed. Export required data and deliberately change the lifecycle settings during an approved teardown.

## Troubleshooting

Verify identity:

```bash
aws sts get-caller-identity --profile wundercorp
```

Verify the hosted zone:

```bash
aws route53 get-hosted-zone \
  --id <YOUR_ROUTE53_HOSTED_ZONE_ID> \
  --profile wundercorp
```

Verify that the registrar currently delegates the public domain to the same name servers:

```bash
dig +short NS openmodel.sh
```

Inspect Route 53 records:

```bash
aws route53 list-resource-record-sets \
  --hosted-zone-id <YOUR_ROUTE53_HOSTED_ZONE_ID> \
  --profile wundercorp
```

Check the API:

```bash
curl --fail https://api.openmodel.sh/health
```

Check Terraform output:

```bash
terraform -chdir=deploy/terraform/aws output
```

Skip health checks only when DNS or certificates are expected to remain pending:

```dotenv
OPENMODEL_SKIP_HEALTHCHECK="1"
```

## GitHub Actions deployment

The manual `Deploy AWS production` workflow uses GitHub OIDC rather than stored AWS access keys.

Create a GitHub production-environment secret:

```text
AWS_DEPLOY_ROLE_ARN
```

The IAM role trust policy should restrict the GitHub OIDC subject to the intended repository and production environment. Add `NPM_TOKEN` only when the workflow will publish npm packages.

Run the workflow from GitHub Actions and choose whether npm publication is enabled. The workflow pins the expected AWS account and refuses credentials from another account.
