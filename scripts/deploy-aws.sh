#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
terraform_directory="$repository_root_directory/deploy/terraform/aws"
deployment_work_directory="$repository_root_directory/.deploy"
default_deployment_environment_file="$repository_root_directory/.env.deploy"
deployment_environment_file="${OPENMODEL_DEPLOY_ENV_FILE:-$default_deployment_environment_file}"
temporary_npm_configuration_file=""
npm_public_registry_url="https://registry.npmjs.org/"

deployment_mode="deploy"
publish_npm_packages="false"
skip_source_validation="false"
automatically_approve_terraform="false"
npm_publication_authentication_configured="false"
publish_gateway_sdk_package="false"
publish_cli_package="false"
npm_release_versions_prepared="false"

print_usage() {
  cat <<'USAGE'
Usage: ./deploy.sh [options]

Options:
  --publish-npm       Publish the gateway SDK and CLI after the AWS deployment.
  --skip-validation   Skip npm install, checks, tests, and source builds.
  --plan-only         Initialize Terraform and create a plan without changing AWS.
  --validate-only     Validate source, packages, Lambda bundle, and Terraform without deploying.
  --yes               Apply Terraform without an interactive approval prompt.
  --help              Show this help text.

AWS deployment without npm publication:
  ./deploy.sh --yes

Complete AWS deployment including npm publication:
  ./deploy.sh --publish-npm --yes
USAGE
}

log_message() {
  printf '\n[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1"
}

fail_deployment() {
  printf '\nDeployment failed: %s\n' "$1" >&2
  exit 1
}

cleanup_temporary_files() {
  if [[ -n "$temporary_npm_configuration_file" && -f "$temporary_npm_configuration_file" ]]; then
    rm -f "$temporary_npm_configuration_file"
  fi
}

trap cleanup_temporary_files EXIT

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail_deployment "Required command '$command_name' was not found."
  fi
}

require_environment_variable() {
  local variable_name="$1"
  if [[ -z "${!variable_name:-}" ]]; then
    fail_deployment "Required environment variable '$variable_name' is empty."
  fi
}

validate_deployment_environment_file_security() {
  if [[ ! -f "$deployment_environment_file" ]]; then
    return
  fi

  if [[ -L "$deployment_environment_file" ]]; then
    fail_deployment "The deployment environment file must not be a symbolic link: $deployment_environment_file"
  fi

  local deployment_environment_file_permissions
  deployment_environment_file_permissions="$(stat -c '%a' "$deployment_environment_file" 2>/dev/null || stat -f '%Lp' "$deployment_environment_file")"
  if (( (8#$deployment_environment_file_permissions & 077) != 0 )); then
    fail_deployment "The deployment environment file is readable by other users. Run: chmod 600 $deployment_environment_file"
  fi

  if [[ "$deployment_environment_file" == "$repository_root_directory/"* ]]; then
    if command -v git >/dev/null 2>&1 && git -C "$repository_root_directory" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      if ! git -C "$repository_root_directory" check-ignore -q "${deployment_environment_file#"$repository_root_directory/"}"; then
        fail_deployment "The deployment environment file is not ignored by Git: $deployment_environment_file"
      fi
    fi
  fi
}

load_deployment_environment() {
  validate_deployment_environment_file_security
  if [[ ! -f "$deployment_environment_file" ]]; then
    return
  fi
  set -a
  source "$deployment_environment_file"
  set +a
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --publish-npm)
        publish_npm_packages="true"
        ;;
      --skip-validation)
        skip_source_validation="true"
        ;;
      --plan-only)
        deployment_mode="plan"
        ;;
      --validate-only)
        deployment_mode="validate"
        ;;
      --yes)
        automatically_approve_terraform="true"
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        fail_deployment "Unknown AWS deployment option: $1"
        ;;
    esac
    shift
  done
}

set_default_configuration() {
  OPENMODEL_AWS_REGION="${OPENMODEL_AWS_REGION:-us-east-1}"
  OPENMODEL_AWS_PROFILE="${OPENMODEL_AWS_PROFILE:-}"
  OPENMODEL_AWS_ACCOUNT_ID="${OPENMODEL_AWS_ACCOUNT_ID:-}"
  OPENMODEL_ROUTE53_ZONE_ID="${OPENMODEL_ROUTE53_ZONE_ID:-}"
  OPENMODEL_ROUTE53_ZONE_NAME="${OPENMODEL_ROUTE53_ZONE_NAME:-openmodel.sh}"
  OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS="${OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS:-}"
  OPENMODEL_PROJECT_NAME="${OPENMODEL_PROJECT_NAME:-openmodel}"
  OPENMODEL_TERRAFORM_STATE_BUCKET="${OPENMODEL_TERRAFORM_STATE_BUCKET:-}"
  OPENMODEL_TERRAFORM_STATE_KEY="${OPENMODEL_TERRAFORM_STATE_KEY:-openmodel/production.tfstate}"
  OPENMODEL_TERRAFORM_BOOTSTRAP_STATE="${OPENMODEL_TERRAFORM_BOOTSTRAP_STATE:-1}"
  OPENMODEL_WEB_HOSTNAME="${OPENMODEL_WEB_HOSTNAME:-openmodel.sh}"
  OPENMODEL_API_HOSTNAME="${OPENMODEL_API_HOSTNAME:-api.openmodel.sh}"
  OPENMODEL_API_ALIAS_HOSTNAME="${OPENMODEL_API_ALIAS_HOSTNAME:-api.walton.bot}"
  OPENMODEL_AUTH_ISSUER="${OPENMODEL_AUTH_ISSUER:-}"
  OPENMODEL_AUTH_DOMAIN="${OPENMODEL_AUTH_DOMAIN:-}"
  OPENMODEL_WEB_AUTH_CLIENT_ID="${OPENMODEL_WEB_AUTH_CLIENT_ID:-}"
  OPENMODEL_CLI_AUTH_CLIENT_ID="${OPENMODEL_CLI_AUTH_CLIENT_ID:-${OPENMODEL_AUTH_CLIENT_ID:-}}"
  OPENMODEL_AUTH_AUDIENCE="${OPENMODEL_AUTH_AUDIENCE:-$OPENMODEL_WEB_AUTH_CLIENT_ID${OPENMODEL_CLI_AUTH_CLIENT_ID:+,$OPENMODEL_CLI_AUTH_CLIENT_ID}}"
  OPENMODEL_WEB_AUTH_SCOPES="${OPENMODEL_WEB_AUTH_SCOPES:-openid profile email}"
  OPENMODEL_WEB_URL="${OPENMODEL_WEB_URL:-https://$OPENMODEL_WEB_HOSTNAME}"
  OPENMODEL_CLOUD_API_URL="${OPENMODEL_CLOUD_API_URL:-https://$OPENMODEL_API_HOSTNAME}"
  OPENMODEL_WUNDERSHIP_API_URL="${OPENMODEL_WUNDERSHIP_API_URL:-https://api.wundership.com/openmodel/v1}"
  OPENMODEL_ALLOWED_ORIGINS="${OPENMODEL_ALLOWED_ORIGINS:-$OPENMODEL_WEB_URL,https://walton.bot,https://www.walton.bot}"
  OPENMODEL_CLOUDFRONT_PRICE_CLASS="${OPENMODEL_CLOUDFRONT_PRICE_CLASS:-PriceClass_100}"
  OPENMODEL_LOG_RETENTION_DAYS="${OPENMODEL_LOG_RETENTION_DAYS:-30}"
  OPENMODEL_FORCE_DESTROY_WEB_BUCKET="${OPENMODEL_FORCE_DESTROY_WEB_BUCKET:-0}"
  OPENMODEL_SKIP_HEALTHCHECK="${OPENMODEL_SKIP_HEALTHCHECK:-0}"
  NPM_DIST_TAG="${NPM_DIST_TAG:-latest}"

  if [[ "${OPENMODEL_PUBLISH_NPM:-0}" == "1" ]]; then
    publish_npm_packages="true"
  fi
}

validate_backend_string() {
  local variable_name="$1"
  local variable_value="$2"
  if [[ "$variable_value" == *$'\n'* || "$variable_value" == *$'\r'* || "$variable_value" == *'"'* || "$variable_value" == *'\\'* ]]; then
    fail_deployment "$variable_name contains a character that cannot be written safely to the generated Terraform backend configuration."
  fi
}

auth_audience_contains() {
  local expected_client_id="$1"
  local candidate_client_id
  local original_ifs="$IFS"
  IFS=','
  for candidate_client_id in $OPENMODEL_AUTH_AUDIENCE; do
    candidate_client_id="${candidate_client_id//[[:space:]]/}"
    if [[ "$candidate_client_id" == "$expected_client_id" ]]; then
      IFS="$original_ifs"
      return 0
    fi
  done
  IFS="$original_ifs"
  return 1
}

validate_configuration() {
  if [[ "$OPENMODEL_AWS_REGION" != "us-east-1" ]]; then
    fail_deployment "OPENMODEL_AWS_REGION must currently be us-east-1."
  fi
  if [[ -z "$OPENMODEL_AUTH_ISSUER" ]]; then
    fail_deployment "OPENMODEL_AUTH_ISSUER must be the Cognito user-pool issuer URL."
  fi
  if [[ -z "$OPENMODEL_AUTH_DOMAIN" ]]; then
    fail_deployment "OPENMODEL_AUTH_DOMAIN must be the Cognito hosted or custom domain."
  fi
  if [[ -z "$OPENMODEL_WEB_AUTH_CLIENT_ID" || "$OPENMODEL_WEB_AUTH_CLIENT_ID" == "openmodel-web" ]]; then
    fail_deployment "OPENMODEL_WEB_AUTH_CLIENT_ID must be the generated Cognito app client ID, not the app client name."
  fi
  if [[ -z "$OPENMODEL_AUTH_AUDIENCE" ]]; then
    fail_deployment "OPENMODEL_AUTH_AUDIENCE must contain the Cognito app client IDs accepted by the API."
  fi
  if ! auth_audience_contains "$OPENMODEL_WEB_AUTH_CLIENT_ID"; then
    fail_deployment "OPENMODEL_AUTH_AUDIENCE must include OPENMODEL_WEB_AUTH_CLIENT_ID."
  fi
  if [[ -n "$OPENMODEL_CLI_AUTH_CLIENT_ID" ]] && ! auth_audience_contains "$OPENMODEL_CLI_AUTH_CLIENT_ID"; then
    fail_deployment "OPENMODEL_AUTH_AUDIENCE must include OPENMODEL_CLI_AUTH_CLIENT_ID so om login tokens can manage GPU capacity."
  fi
  if [[ -n "$OPENMODEL_AWS_ACCOUNT_ID" && ! "$OPENMODEL_AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    fail_deployment "OPENMODEL_AWS_ACCOUNT_ID must be a 12-digit AWS account ID when provided."
  fi
  if [[ -n "$OPENMODEL_ROUTE53_ZONE_ID" && ! "$OPENMODEL_ROUTE53_ZONE_ID" =~ ^Z[A-Z0-9]+$ ]]; then
    fail_deployment "OPENMODEL_ROUTE53_ZONE_ID must be a valid Route 53 hosted-zone ID when provided."
  fi
  if [[ ! "$OPENMODEL_ROUTE53_ZONE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]]; then
    fail_deployment "OPENMODEL_ROUTE53_ZONE_NAME must be a valid DNS zone name without a trailing dot."
  fi
  if [[ -n "$OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS" && ! "$OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS" =~ ^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$ ]]; then
    fail_deployment "OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS must be a comma-separated list of DNS names."
  fi
  if [[ -n "$OPENMODEL_TERRAFORM_STATE_BUCKET" ]] && { [[ ! "$OPENMODEL_TERRAFORM_STATE_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || [[ "$OPENMODEL_TERRAFORM_STATE_BUCKET" == *'..'* ]] || [[ "$OPENMODEL_TERRAFORM_STATE_BUCKET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; }; then
    fail_deployment "OPENMODEL_TERRAFORM_STATE_BUCKET must be a valid S3 bucket name."
  fi
  if [[ -z "$OPENMODEL_TERRAFORM_STATE_KEY" || "$OPENMODEL_TERRAFORM_STATE_KEY" == /* ]]; then
    fail_deployment "OPENMODEL_TERRAFORM_STATE_KEY must be a non-empty relative object key."
  fi
  if [[ -n "$OPENMODEL_TERRAFORM_STATE_BUCKET" ]]; then
    validate_backend_string "OPENMODEL_TERRAFORM_STATE_BUCKET" "$OPENMODEL_TERRAFORM_STATE_BUCKET"
  fi
  validate_backend_string "OPENMODEL_TERRAFORM_STATE_KEY" "$OPENMODEL_TERRAFORM_STATE_KEY"
  validate_backend_string "OPENMODEL_AWS_REGION" "$OPENMODEL_AWS_REGION"
  validate_backend_string "OPENMODEL_AWS_PROFILE" "$OPENMODEL_AWS_PROFILE"
  if [[ ! "$OPENMODEL_PROJECT_NAME" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]]; then
    fail_deployment "OPENMODEL_PROJECT_NAME must use 3-32 lowercase letters, numbers, or hyphens and begin with a letter."
  fi
  if [[ "$OPENMODEL_TERRAFORM_BOOTSTRAP_STATE" != "0" && "$OPENMODEL_TERRAFORM_BOOTSTRAP_STATE" != "1" ]]; then
    fail_deployment "OPENMODEL_TERRAFORM_BOOTSTRAP_STATE must be 0 or 1."
  fi
  if [[ "$OPENMODEL_FORCE_DESTROY_WEB_BUCKET" != "0" && "$OPENMODEL_FORCE_DESTROY_WEB_BUCKET" != "1" ]]; then
    fail_deployment "OPENMODEL_FORCE_DESTROY_WEB_BUCKET must be 0 or 1."
  fi
  if [[ "$OPENMODEL_SKIP_HEALTHCHECK" != "0" && "$OPENMODEL_SKIP_HEALTHCHECK" != "1" ]]; then
    fail_deployment "OPENMODEL_SKIP_HEALTHCHECK must be 0 or 1."
  fi
  if [[ ! "$OPENMODEL_LOG_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
    fail_deployment "OPENMODEL_LOG_RETENTION_DAYS must be a whole number."
  fi
}

prepare_directories() {
  mkdir -p "$deployment_work_directory"
}

run_npm_without_deployment_secrets() {
  env \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    -u AWS_SECURITY_TOKEN \
    -u CLOUDFLARE_API_TOKEN \
    -u NPM_TOKEN \
    -u NODE_AUTH_TOKEN \
    -u NODE_ENV \
    -u NPM_CONFIG_PRODUCTION \
    -u npm_config_production \
    -u NPM_CONFIG_OMIT \
    -u npm_config_omit \
    -u NPM_CONFIG_BIN_LINKS \
    -u npm_config_bin_links \
    NPM_CONFIG_USERCONFIG="$repository_root_directory/.npmrc" \
    "$@"
}

validate_package_lock_registry() {
  if ! node "$repository_root_directory/scripts/validate-package-lock-registry.mjs"; then
    fail_deployment "package-lock.json is not public-registry safe. Run npm run lockfile:refresh and commit the result."
  fi
}

install_dependencies() {
  validate_package_lock_registry
  log_message "Checking public npm registry connectivity"
  run_npm_without_deployment_secrets npm ping --registry="$npm_public_registry_url" --fetch-timeout=15000 --fetch-retries=1

  log_message "Installing locked npm dependencies from the public npm registry"
  run_npm_without_deployment_secrets npm \
    --prefix "$repository_root_directory" \
    ci \
    --include=dev \
    --production=false \
    --workspaces \
    --include-workspace-root \
    --bin-links=true \
    --registry="$npm_public_registry_url" \
    --no-audit \
    --no-fund \
    --foreground-scripts \
    --fetch-timeout=60000 \
    --fetch-retries=2 \
    --loglevel=http

  if [[ ! -x "$repository_root_directory/node_modules/.bin/tsc" ]]; then
    printf '\nEffective npm installation settings:\n' >&2
    run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" config get omit >&2 || true
    run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" config get production >&2 || true
    run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" config get bin-links >&2 || true
    run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" ls typescript --all >&2 || true
    fail_deployment "TypeScript was not installed or its tsc binary was not linked. Remove node_modules and rerun deployment with the updated installer."
  fi

  log_message "Verified TypeScript toolchain: $($repository_root_directory/node_modules/.bin/tsc --version)"
}

build_website() {
  log_message "Building the production website"
  VITE_AUTH_ISSUER="$OPENMODEL_AUTH_ISSUER" \
  VITE_AUTH_DOMAIN="$OPENMODEL_AUTH_DOMAIN" \
  VITE_AUTH_CLIENT_ID="$OPENMODEL_WEB_AUTH_CLIENT_ID" \
  VITE_AUTH_REDIRECT_URI="$OPENMODEL_WEB_URL/auth/callback" \
  VITE_AUTH_LOGOUT_URI="$OPENMODEL_WEB_URL" \
  VITE_AUTH_SCOPES="$OPENMODEL_WEB_AUTH_SCOPES" \
  VITE_API_URL="$OPENMODEL_CLOUD_API_URL" \
  VITE_WUNDERSHIP_API_URL="$OPENMODEL_WUNDERSHIP_API_URL" \
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run build --workspace @wundercorp/openmodel-web
}

build_aws_api() {
  log_message "Building the AWS Lambda cloud API"
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run build --workspace @wundercorp/openmodel-aws-api
}

validate_aws_api_bundle() {
  log_message "Smoke-testing the bundled AWS Lambda entrypoint"
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run test:bundle --workspace @wundercorp/openmodel-aws-api
}

run_source_validation() {
  if [[ "$skip_source_validation" == "true" ]]; then
    log_message "Skipping source validation by request"
    return
  fi

  install_dependencies
  log_message "Checking source"
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run check
  log_message "Running tests"
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" test
  prepare_npm_release
}

build_deployment_assets() {
  if [[ "$skip_source_validation" == "true" ]]; then
    ensure_built_assets_exist
  else
    build_website
    build_aws_api
  fi
  validate_aws_api_bundle
}

ensure_built_assets_exist() {
  if [[ ! -f "$repository_root_directory/apps/web/dist/index.html" ]]; then
    fail_deployment "The website build is missing. Remove --skip-validation or run npm run build --workspace @wundercorp/openmodel-web."
  fi
  if [[ ! -f "$repository_root_directory/apps/aws-api/dist/index.mjs" ]]; then
    fail_deployment "The AWS API bundle is missing. Remove --skip-validation or run npm run build --workspace @wundercorp/openmodel-aws-api."
  fi
}

configure_aws_environment() {
  export AWS_REGION="$OPENMODEL_AWS_REGION"
  export AWS_DEFAULT_REGION="$OPENMODEL_AWS_REGION"
  if [[ -n "$OPENMODEL_AWS_PROFILE" ]]; then
    export AWS_PROFILE="$OPENMODEL_AWS_PROFILE"
  fi
}

verify_aws_identity() {
  local active_account_id
  active_account_id="$(aws sts get-caller-identity --query Account --output text)"
  if [[ -n "$OPENMODEL_AWS_ACCOUNT_ID" && "$active_account_id" != "$OPENMODEL_AWS_ACCOUNT_ID" ]]; then
    fail_deployment "AWS credentials belong to account $active_account_id, not expected account $OPENMODEL_AWS_ACCOUNT_ID."
  fi
  OPENMODEL_AWS_ACCOUNT_ID="$active_account_id"
  if [[ -z "$OPENMODEL_TERRAFORM_STATE_BUCKET" ]]; then
    OPENMODEL_TERRAFORM_STATE_BUCKET="openmodel-terraform-state-$OPENMODEL_AWS_ACCOUNT_ID"
  fi
  log_message "AWS identity verified for account $active_account_id"
}

verify_route53_hosted_zone() {
  local actual_zone_name
  local discovered_zone_id
  local normalized_actual_zone_name
  local normalized_expected_zone_name
  local actual_name_servers
  local expected_name_servers

  if [[ -z "$OPENMODEL_ROUTE53_ZONE_ID" ]]; then
    discovered_zone_id="$(
      aws route53 list-hosted-zones-by-name \
        --dns-name "$OPENMODEL_ROUTE53_ZONE_NAME" \
        --query "HostedZones[?Name=='${OPENMODEL_ROUTE53_ZONE_NAME%.}.'].Id | [0]" \
        --output text
    )"
    discovered_zone_id="${discovered_zone_id#/hostedzone/}"
    if [[ -z "$discovered_zone_id" || "$discovered_zone_id" == "None" ]]; then
      fail_deployment "No public Route 53 hosted zone was found for $OPENMODEL_ROUTE53_ZONE_NAME. Set OPENMODEL_ROUTE53_ZONE_ID explicitly."
    fi
    OPENMODEL_ROUTE53_ZONE_ID="$discovered_zone_id"
  fi

  actual_zone_name="$(aws route53 get-hosted-zone --id "$OPENMODEL_ROUTE53_ZONE_ID" --query 'HostedZone.Name' --output text)"
  normalized_actual_zone_name="${actual_zone_name%.}"
  normalized_expected_zone_name="${OPENMODEL_ROUTE53_ZONE_NAME%.}"

  normalized_actual_zone_name="$(printf '%s' "$normalized_actual_zone_name" | tr '[:upper:]' '[:lower:]')"
  normalized_expected_zone_name="$(printf '%s' "$normalized_expected_zone_name" | tr '[:upper:]' '[:lower:]')"
  if [[ "$normalized_actual_zone_name" != "$normalized_expected_zone_name" ]]; then
    fail_deployment "Route 53 hosted zone $OPENMODEL_ROUTE53_ZONE_ID is for $actual_zone_name, not $OPENMODEL_ROUTE53_ZONE_NAME."
  fi

  if [[ -n "$OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS" ]]; then
    actual_name_servers="$(
      aws route53 get-hosted-zone \
        --id "$OPENMODEL_ROUTE53_ZONE_ID" \
        --query 'DelegationSet.NameServers[]' \
        --output text | \
      tr '\t' '\n' | \
      sed -e '/^[[:space:]]*$/d' -e 's/\.$//' | \
      tr '[:upper:]' '[:lower:]' | \
      sort | \
      paste -sd, -
    )"
    expected_name_servers="$(
      printf '%s' "$OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS" | \
      tr ',' '\n' | \
      sed -e '/^[[:space:]]*$/d' -e 's/\.$//' | \
      tr '[:upper:]' '[:lower:]' | \
      sort | \
      paste -sd, -
    )"

    if [[ "$actual_name_servers" != "$expected_name_servers" ]]; then
      fail_deployment "Route 53 hosted zone $OPENMODEL_ROUTE53_ZONE_ID does not have the expected name-server delegation set."
    fi
  fi

  log_message "Route 53 hosted zone verified for $OPENMODEL_ROUTE53_ZONE_NAME"
}

export_terraform_variables() {
  export TF_IN_AUTOMATION=1
  export TF_INPUT=0
  export TF_VAR_aws_region="$OPENMODEL_AWS_REGION"
  export TF_VAR_aws_profile="$OPENMODEL_AWS_PROFILE"
  export TF_VAR_expected_aws_account_id="$OPENMODEL_AWS_ACCOUNT_ID"
  export TF_VAR_route53_zone_id="$OPENMODEL_ROUTE53_ZONE_ID"
  export TF_VAR_project_name="$OPENMODEL_PROJECT_NAME"
  export TF_VAR_web_hostname="$OPENMODEL_WEB_HOSTNAME"
  export TF_VAR_api_hostname="$OPENMODEL_API_HOSTNAME"
  export TF_VAR_api_alias_hostname="$OPENMODEL_API_ALIAS_HOSTNAME"
  export TF_VAR_auth_issuer="$OPENMODEL_AUTH_ISSUER"
  export TF_VAR_auth_audience="$OPENMODEL_AUTH_AUDIENCE"
  export TF_VAR_allowed_origins="$OPENMODEL_ALLOWED_ORIGINS"
  export TF_VAR_lambda_bundle_file="$repository_root_directory/apps/aws-api/dist/index.mjs"
  export TF_VAR_cloudfront_price_class="$OPENMODEL_CLOUDFRONT_PRICE_CLASS"
  export TF_VAR_log_retention_days="$OPENMODEL_LOG_RETENTION_DAYS"
  export TF_VAR_force_destroy_web_bucket="$([[ "$OPENMODEL_FORCE_DESTROY_WEB_BUCKET" == "1" ]] && printf true || printf false)"
}

write_terraform_backend_configuration() {
  local backend_configuration_file="$deployment_work_directory/aws-backend.hcl"
  umask 077
  {
    printf 'bucket = "%s"\n' "$OPENMODEL_TERRAFORM_STATE_BUCKET"
    printf 'key = "%s"\n' "$OPENMODEL_TERRAFORM_STATE_KEY"
    printf 'region = "%s"\n' "$OPENMODEL_AWS_REGION"
    printf 'encrypt = true\n'
    printf 'use_lockfile = true\n'
    if [[ -n "$OPENMODEL_AWS_PROFILE" ]]; then
      printf 'profile = "%s"\n' "$OPENMODEL_AWS_PROFILE"
    fi
  } > "$backend_configuration_file"
  chmod 600 "$backend_configuration_file"
  printf '%s' "$backend_configuration_file"
}

ensure_terraform_state_bucket() {
  if aws s3api head-bucket --bucket "$OPENMODEL_TERRAFORM_STATE_BUCKET" >/dev/null 2>&1; then
    log_message "Terraform state bucket is available"
    return
  fi

  if [[ "$OPENMODEL_TERRAFORM_BOOTSTRAP_STATE" != "1" ]]; then
    fail_deployment "Terraform state bucket $OPENMODEL_TERRAFORM_STATE_BUCKET is unavailable and automatic bootstrap is disabled."
  fi

  log_message "Creating the encrypted Terraform state bucket"
  aws s3api create-bucket \
    --bucket "$OPENMODEL_TERRAFORM_STATE_BUCKET" \
    --region "$OPENMODEL_AWS_REGION" >/dev/null
  aws s3api put-public-access-block \
    --bucket "$OPENMODEL_TERRAFORM_STATE_BUCKET" \
    --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
  aws s3api put-bucket-encryption \
    --bucket "$OPENMODEL_TERRAFORM_STATE_BUCKET" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
  aws s3api put-bucket-versioning \
    --bucket "$OPENMODEL_TERRAFORM_STATE_BUCKET" \
    --versioning-configuration Status=Enabled
}

initialize_terraform() {
  log_message "Initializing AWS Terraform"
  if [[ "$deployment_mode" == "validate" ]]; then
    terraform -chdir="$terraform_directory" init -backend=false -input=false
  else
    local backend_configuration_file
    backend_configuration_file="$(write_terraform_backend_configuration)"
    terraform -chdir="$terraform_directory" init -input=false -reconfigure -backend-config="$backend_configuration_file"
  fi
  log_message "Validating AWS Terraform"
  terraform -chdir="$terraform_directory" validate
}

create_terraform_plan() {
  local terraform_plan_file="$deployment_work_directory/openmodel-aws.tfplan"
  log_message "Creating the AWS Terraform plan"
  terraform -chdir="$terraform_directory" plan -input=false -out="$terraform_plan_file"
}

apply_terraform_plan() {
  local terraform_plan_file="$deployment_work_directory/openmodel-aws.tfplan"
  local approval_response=""

  if [[ "$automatically_approve_terraform" != "true" ]]; then
    if [[ ! -t 0 ]]; then
      fail_deployment "Terraform changes require an interactive terminal or the --yes option."
    fi
    printf '\nApply the AWS Terraform plan shown above? Type deploy to continue: '
    read -r approval_response
    if [[ "$approval_response" != "deploy" ]]; then
      fail_deployment "Terraform apply was cancelled."
    fi
  fi

  log_message "Applying the AWS Terraform plan"
  terraform -chdir="$terraform_directory" apply -input=false "$terraform_plan_file"
}

terraform_output() {
  terraform -chdir="$terraform_directory" output -raw "$1"
}

deploy_website_files() {
  local website_bucket_name
  local cloudfront_distribution_id
  website_bucket_name="$(terraform_output website_bucket_name)"
  cloudfront_distribution_id="$(terraform_output cloudfront_distribution_id)"

  log_message "Uploading website assets to S3"
  aws s3 sync "$repository_root_directory/apps/web/dist/" "s3://$website_bucket_name/" \
    --delete \
    --only-show-errors \
    --exclude 'index.html' \
    --cache-control 'public,max-age=31536000,immutable'

  aws s3 cp "$repository_root_directory/apps/web/dist/index.html" "s3://$website_bucket_name/index.html" \
    --only-show-errors \
    --cache-control 'no-cache,no-store,must-revalidate' \
    --content-type 'text/html; charset=utf-8'

  log_message "Invalidating the CloudFront website cache"
  aws cloudfront create-invalidation \
    --distribution-id "$cloudfront_distribution_id" \
    --paths '/*' \
    --output json > "$deployment_work_directory/cloudfront-invalidation.json"
}

configure_npm_authentication() {
  if [[ "$npm_publication_authentication_configured" == "true" ]]; then
    return
  fi
  if [[ -z "${NPM_TOKEN:-}" ]]; then
    log_message "Using the existing npm login for publication"
    npm whoami --registry "$npm_public_registry_url" >/dev/null
    npm_publication_authentication_configured="true"
    return
  fi
  temporary_npm_configuration_file="$(mktemp)"
  chmod 600 "$temporary_npm_configuration_file"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$temporary_npm_configuration_file"
  printf 'registry=%s\nfund=false\naudit=true\nprovenance=false\n' "$npm_public_registry_url" >> "$temporary_npm_configuration_file"
  export NPM_CONFIG_USERCONFIG="$temporary_npm_configuration_file"
  unset NPM_TOKEN
  npm whoami --registry "$npm_public_registry_url" >/dev/null
  npm_publication_authentication_configured="true"
}

package_version_exists() {
  local package_name="$1"
  local package_version="$2"
  npm view "$package_name@$package_version" version --registry "$npm_public_registry_url" >/dev/null 2>&1
}

published_package_matches_workspace() {
  local workspace_name="$1"
  node "$repository_root_directory/scripts/verify-published-package-contents.mjs" \
    --workspace "$workspace_name" \
    --registry "$npm_public_registry_url"
}

validate_npm_release_versions() {
  if [[ "$npm_release_versions_prepared" != "true" ]]; then
    log_message "Preparing npm release versions"
    node "$repository_root_directory/scripts/prepare-npm-release.mjs" --registry "$npm_public_registry_url"
    npm_release_versions_prepared="true"
  fi

  local gateway_sdk_version
  local cli_gateway_sdk_dependency_version
  gateway_sdk_version="$(node -p "require('$repository_root_directory/packages/gateway-sdk/package.json').version")"
  cli_gateway_sdk_dependency_version="$(node -p "require('$repository_root_directory/apps/cli/package.json').dependencies['@wundercorp/openmodel-gateway-sdk']")"
  if [[ "$gateway_sdk_version" != "$cli_gateway_sdk_dependency_version" ]]; then
    fail_deployment "The CLI dependency on @wundercorp/openmodel-gateway-sdk must match the SDK package version before publication."
  fi
  if [[ ! "$NPM_DIST_TAG" =~ ^[A-Za-z][A-Za-z0-9._-]*$ ]]; then
    fail_deployment "NPM_DIST_TAG must start with a letter and contain only letters, numbers, dots, underscores, or hyphens."
  fi
}

prepare_npm_release() {
  local gateway_sdk_package_name
  local gateway_sdk_package_version
  local cli_package_name
  local cli_package_version

  if [[ "$publish_npm_packages" != "true" || "$deployment_mode" != "deploy" ]]; then
    return
  fi

  validate_npm_release_versions
  gateway_sdk_package_name="$(node -p "require('$repository_root_directory/packages/gateway-sdk/package.json').name")"
  gateway_sdk_package_version="$(node -p "require('$repository_root_directory/packages/gateway-sdk/package.json').version")"
  cli_package_name="$(node -p "require('$repository_root_directory/apps/cli/package.json').name")"
  cli_package_version="$(node -p "require('$repository_root_directory/apps/cli/package.json').version")"

  publish_gateway_sdk_package="false"
  publish_cli_package="false"

  if package_version_exists "$gateway_sdk_package_name" "$gateway_sdk_package_version"; then
    if ! published_package_matches_workspace "@wundercorp/openmodel-gateway-sdk"; then
      fail_deployment "$gateway_sdk_package_name@$gateway_sdk_package_version already exists, but the local package contents differ. Bump the SDK version before publishing."
    fi
    log_message "Reusing published dependency $gateway_sdk_package_name@$gateway_sdk_package_version"
  else
    publish_gateway_sdk_package="true"
  fi

  if package_version_exists "$cli_package_name" "$cli_package_version"; then
    if ! published_package_matches_workspace "@wundercorp/openmodel"; then
      fail_deployment "$cli_package_name@$cli_package_version already exists, but the local package contents differ. Run npm run version:bump -- patch --package cli before publishing."
    fi
    log_message "Reusing published package $cli_package_name@$cli_package_version"
  else
    publish_cli_package="true"
  fi

  if [[ "$publish_gateway_sdk_package" != "true" && "$publish_cli_package" != "true" ]]; then
    log_message "All selected npm package versions already exist and match the local package contents; continuing with the infrastructure and website deployment"
    return
  fi

  log_message "Verifying npm authentication before changing AWS resources"
  configure_npm_authentication
}

publish_workspace_package() {
  local workspace_name="$1"
  local package_json_path="$2"
  local package_name
  local package_version
  package_name="$(node -p "require('$package_json_path').name")"
  package_version="$(node -p "require('$package_json_path').version")"
  if package_version_exists "$package_name" "$package_version"; then
    if published_package_matches_workspace "$workspace_name"; then
      log_message "Reusing $package_name@$package_version because it was published while this deployment was running"
      return
    fi
    fail_deployment "$package_name@$package_version was published with different contents during this deployment. Rerun the deploy command so automatic version preparation can select the next patch version."
  fi
  log_message "Publishing $package_name@$package_version with npm tag $NPM_DIST_TAG"
  env \
    -u AWS_ACCESS_KEY_ID \
    -u AWS_SECRET_ACCESS_KEY \
    -u AWS_SESSION_TOKEN \
    npm --prefix "$repository_root_directory" publish \
      --workspace "$workspace_name" \
      --access public \
      --tag "$NPM_DIST_TAG" \
      --registry "$npm_public_registry_url" \
      --provenance=false
}

publish_npm_release() {
  if [[ "$publish_npm_packages" != "true" ]]; then
    log_message "Skipping npm publication. Add --publish-npm to publish the release"
    return
  fi
  validate_npm_release_versions

  if [[ "$publish_gateway_sdk_package" == "true" ]]; then
    publish_workspace_package "@wundercorp/openmodel-gateway-sdk" "$repository_root_directory/packages/gateway-sdk/package.json"
  else
    log_message "Skipping @wundercorp/openmodel-gateway-sdk because this exact version is already published"
  fi

  if [[ "$publish_cli_package" == "true" ]]; then
    publish_workspace_package "@wundercorp/openmodel" "$repository_root_directory/apps/cli/package.json"
  else
    log_message "Skipping @wundercorp/openmodel because this exact version is already published"
  fi
}

run_health_checks() {
  if [[ "$OPENMODEL_SKIP_HEALTHCHECK" == "1" ]]; then
    log_message "Skipping deployment health checks"
    return
  fi
  require_command curl
  log_message "Checking the AWS cloud API"
  if ! curl --silent --show-error --fail --retry 8 --retry-delay 10 "$OPENMODEL_CLOUD_API_URL/health" >/dev/null; then
    printf 'Warning: API health check did not succeed. DNS or certificate activation may still be in progress.\n' >&2
  fi
  log_message "Checking the website"
  if ! curl --silent --show-error --fail --retry 8 --retry-delay 10 "$OPENMODEL_WEB_URL" >/dev/null; then
    printf 'Warning: Website health check did not succeed. DNS or CloudFront deployment may still be in progress.\n' >&2
  fi
}

run_validate_only() {
  require_command node
  require_command npm
  require_command terraform
  ensure_built_assets_exist
  export_terraform_variables
  initialize_terraform
  log_message "Validating npm package contents"
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run release:dry-run
  log_message "Validation completed without changing AWS resources"
}

run_remote_deployment() {
  require_command node
  require_command npm
  require_command terraform
  require_command aws
  require_command git
  ensure_built_assets_exist
  configure_aws_environment
  verify_aws_identity
  verify_route53_hosted_zone
  validate_configuration
  ensure_terraform_state_bucket
  export_terraform_variables
  initialize_terraform
  prepare_npm_release
  create_terraform_plan

  if [[ "$deployment_mode" == "plan" ]]; then
    log_message "Plan completed. No AWS resources were changed"
    return
  fi

  apply_terraform_plan
  deploy_website_files
  publish_npm_release
  run_health_checks

  log_message "AWS deployment completed"
  printf 'Website: %s\n' "$OPENMODEL_WEB_URL"
  printf 'Cloud API: %s\n' "$OPENMODEL_CLOUD_API_URL"
  printf 'CLI package: @wundercorp/openmodel\n'
}

main() {
  parse_arguments "$@"
  prepare_directories
  cd "$repository_root_directory"

  validate_deployment_environment_file_security
  load_deployment_environment
  set_default_configuration
  validate_configuration

  if [[ "$deployment_mode" == "validate" ]]; then
    run_source_validation
    build_deployment_assets
    run_validate_only
    return
  fi

  run_source_validation
  build_deployment_assets
  run_remote_deployment
}

main "$@"
