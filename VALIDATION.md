# Validation report

Validated in Node.js 22 with npm 10.

Completed successfully:

- Locked workspace dependency installation
- JavaScript syntax checks and TypeScript checks
- Gateway SDK, CLI, and AWS Lambda API tests
- Vite production website build
- AWS Lambda bundle build
- Cloudflare Worker dry-run bundle
- npm publish dry runs for the gateway SDK and CLI
- Semantic version increment simulation for CLI-only, SDK-dependent, combined, and prerelease releases
- Package-lock synchronization and file-permission preservation during version increments
- One-shot release commit and tag simulation in a temporary Git repository
- Idempotent npm publication dry run with release-tag validation
- Packed CLI installation exposing only the `om` executable
- Packed third-party gateway installation and removal through `om gateway`
- End-to-end CLI pull, list, serve, model metadata, and removal smoke tests
- Bash syntax validation for deployment, Git initialization, and Git push scripts
- HCL parsing for the AWS and optional Cloudflare Terraform stacks
- YAML parsing for GitHub Actions, Compose, and Kubernetes manifests
- JSON parsing for package and generated deployment configuration files
- Local Git repository initialization, safe initial commit, and push to a local bare remote
- AWS deployment input validation for account, hosted-zone ID/name/delegation set, state bucket, state key, project name, and generated backend configuration values
- Git ignore verification for credentials, deployment environment files, AWS state, Terraform state and plans, generated configuration, dependency directories, build output, model artifacts, and release archives
- Secret-pattern scanning across source files
- npm dependency audit with no known vulnerabilities at the configured threshold

The AWS stack was also reviewed for the intended production topology:

- Existing Route 53 hosted zone is referenced rather than created
- CloudFront website receives Route 53 `A` and `AAAA` aliases
- API Gateway custom domain receives the documented Route 53 `A` alias
- S3 website content remains private behind CloudFront origin access control
- ACM DNS validation records are managed inside the existing hosted zone
- Lambda, API Gateway, DynamoDB, IAM, and CloudWatch resources are Terraform-managed
- Terraform state is configured for an encrypted, versioned S3 backend with native lock files

Not executed in this environment:

- A real AWS credential check, Terraform provider initialization, plan, or apply
- Creation of the remote Terraform state bucket in AWS
- Production Route 53, ACM, CloudFront, S3, API Gateway, Lambda, DynamoDB, IAM, or CloudWatch changes
- A real GitHub repository creation or network push
- Live npm publication
- Docker image build and container startup
- Kubernetes cluster rollout
- Live OIDC authentication against `auth.wundercorp.co`
- Real GGUF inference through llama.cpp
- Real Ollama model pull and inference

Those operations require the target AWS/GitHub/npm identities and network access. Run `./deploy.sh --plan-only` with the intended AWS profile before the first production apply.
