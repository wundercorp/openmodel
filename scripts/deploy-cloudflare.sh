#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
terraform_directory="$repository_root_directory/deploy/terraform/cloudflare"
deployment_work_directory="$repository_root_directory/.deploy"
generated_worker_configuration_file="$repository_root_directory/apps/cloud/wrangler.production.generated.json"
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
  --publish-npm       Publish the gateway SDK and CLI after the cloud deployment.
  --skip-validation   Skip npm install, checks, tests, and source builds.
  --plan-only         Initialize Terraform and create a plan without changing remote resources.
  --validate-only     Validate source, packages, Wrangler bundles, and Terraform without credentials.
  --yes               Apply Terraform without an interactive approval prompt.
  --help              Show this help text.

Full production deployment including npm publication:
  ./deploy.sh --publish-npm --yes

Safe local validation without deployment credentials:
  ./deploy.sh --validate-only
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
        fail_deployment "Unknown option: $1"
        ;;
    esac
    shift
  done
}

set_default_configuration() {
  OPENMODEL_MANAGE_CUSTOM_DOMAINS="${OPENMODEL_MANAGE_CUSTOM_DOMAINS:-1}"
  OPENMODEL_WEB_HOSTNAME="${OPENMODEL_WEB_HOSTNAME:-openmodel.sh}"
  OPENMODEL_API_HOSTNAME="${OPENMODEL_API_HOSTNAME:-api.openmodel.sh}"
  OPENMODEL_PAGES_PROJECT="${OPENMODEL_PAGES_PROJECT:-openmodel-web}"
  OPENMODEL_PAGES_BRANCH="${OPENMODEL_PAGES_BRANCH:-main}"
  OPENMODEL_WORKER_NAME="${OPENMODEL_WORKER_NAME:-openmodel-cloud}"
  OPENMODEL_GATEWAY_KV_TITLE="${OPENMODEL_GATEWAY_KV_TITLE:-openmodel-gateway-registry}"
  OPENMODEL_AUTH_ISSUER="${OPENMODEL_AUTH_ISSUER:-}"
  OPENMODEL_AUTH_DOMAIN="${OPENMODEL_AUTH_DOMAIN:-}"
  OPENMODEL_WEB_AUTH_CLIENT_ID="${OPENMODEL_WEB_AUTH_CLIENT_ID:-}"
  OPENMODEL_CLI_AUTH_CLIENT_ID="${OPENMODEL_CLI_AUTH_CLIENT_ID:-${OPENMODEL_AUTH_CLIENT_ID:-}}"
  OPENMODEL_AUTH_AUDIENCE="${OPENMODEL_AUTH_AUDIENCE:-$OPENMODEL_WEB_AUTH_CLIENT_ID${OPENMODEL_CLI_AUTH_CLIENT_ID:+,$OPENMODEL_CLI_AUTH_CLIENT_ID}}"
  OPENMODEL_WEB_AUTH_SCOPES="${OPENMODEL_WEB_AUTH_SCOPES:-openid profile email}"
  OPENMODEL_WEB_URL="${OPENMODEL_WEB_URL:-https://$OPENMODEL_WEB_HOSTNAME}"
  OPENMODEL_CLOUD_API_URL="${OPENMODEL_CLOUD_API_URL:-https://$OPENMODEL_API_HOSTNAME}"
  OPENMODEL_WUNDERSHIP_API_URL="${OPENMODEL_WUNDERSHIP_API_URL:-https://api.wundership.com/openmodel/v1}"
  OPENMODEL_ALLOWED_ORIGINS="${OPENMODEL_ALLOWED_ORIGINS:-$OPENMODEL_WEB_URL}"
  OPENMODEL_SKIP_HEALTHCHECK="${OPENMODEL_SKIP_HEALTHCHECK:-0}"
  NPM_DIST_TAG="${NPM_DIST_TAG:-latest}"

  if [[ "${OPENMODEL_PUBLISH_NPM:-0}" == "1" ]]; then
    publish_npm_packages="true"
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

validate_boolean_configuration() {
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

  if [[ "$OPENMODEL_MANAGE_CUSTOM_DOMAINS" != "0" && "$OPENMODEL_MANAGE_CUSTOM_DOMAINS" != "1" ]]; then
    fail_deployment "OPENMODEL_MANAGE_CUSTOM_DOMAINS must be 0 or 1."
  fi

  if [[ "$OPENMODEL_SKIP_HEALTHCHECK" != "0" && "$OPENMODEL_SKIP_HEALTHCHECK" != "1" ]]; then
    fail_deployment "OPENMODEL_SKIP_HEALTHCHECK must be 0 or 1."
  fi
}

prepare_directories() {
  mkdir -p "$deployment_work_directory"
}

run_npm_without_deployment_secrets() {
  env \
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

  log_message "Building source"
  VITE_AUTH_ISSUER="$OPENMODEL_AUTH_ISSUER" \
  VITE_AUTH_DOMAIN="$OPENMODEL_AUTH_DOMAIN" \
  VITE_AUTH_CLIENT_ID="$OPENMODEL_WEB_AUTH_CLIENT_ID" \
  VITE_AUTH_REDIRECT_URI="$OPENMODEL_WEB_URL/auth/callback" \
  VITE_AUTH_LOGOUT_URI="$OPENMODEL_WEB_URL" \
  VITE_AUTH_SCOPES="$OPENMODEL_WEB_AUTH_SCOPES" \
  VITE_API_URL="$OPENMODEL_CLOUD_API_URL" \
  VITE_WUNDERSHIP_API_URL="$OPENMODEL_WUNDERSHIP_API_URL" \
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run build
}

initialize_terraform() {
  log_message "Initializing Terraform"
  terraform -chdir="$terraform_directory" init -input=false

  log_message "Validating Terraform"
  terraform -chdir="$terraform_directory" validate
}

export_terraform_variables() {
  export TF_IN_AUTOMATION=1
  export TF_INPUT=0
  export TF_VAR_cloudflare_account_id="${CLOUDFLARE_ACCOUNT_ID:-validation-account-id}"
  export TF_VAR_cloudflare_zone_id="${CLOUDFLARE_ZONE_ID:-validation-zone-id}"
  export TF_VAR_manage_custom_domains="$([[ "$OPENMODEL_MANAGE_CUSTOM_DOMAINS" == "1" ]] && printf true || printf false)"
  export TF_VAR_web_hostname="$OPENMODEL_WEB_HOSTNAME"
  export TF_VAR_api_hostname="$OPENMODEL_API_HOSTNAME"
  export TF_VAR_pages_project_name="$OPENMODEL_PAGES_PROJECT"
  export TF_VAR_worker_service_name="$OPENMODEL_WORKER_NAME"
  export TF_VAR_gateway_registry_namespace_title="$OPENMODEL_GATEWAY_KV_TITLE"
}

run_validate_only() {
  require_command node
  require_command npm
  require_command terraform

  export_terraform_variables
  initialize_terraform

  log_message "Validating npm package contents"
  run_npm_without_deployment_secrets npm --prefix "$repository_root_directory" run release:dry-run

  log_message "Validation completed without changing remote resources"
}

create_terraform_plan() {
  local terraform_plan_file="$deployment_work_directory/openmodel.tfplan"

  log_message "Creating Terraform plan"
  terraform -chdir="$terraform_directory" plan -input=false -out="$terraform_plan_file"

  if [[ "$deployment_mode" == "plan" ]]; then
    log_message "Plan completed. No remote resources were changed"
    exit 0
  fi
}

bootstrap_gateway_registry() {
  local terraform_apply_arguments=(
    -input=false
    -target=cloudflare_workers_kv_namespace.gateway_registry
  )

  if [[ "$automatically_approve_terraform" == "true" ]]; then
    terraform_apply_arguments+=( -auto-approve )
  fi

  log_message "Provisioning the gateway registry KV namespace"
  terraform -chdir="$terraform_directory" apply "${terraform_apply_arguments[@]}"
}

read_gateway_registry_namespace_id() {
  terraform -chdir="$terraform_directory" output -raw gateway_registry_namespace_id
}

write_worker_configuration() {
  local gateway_registry_namespace_id="$1"

  OPENMODEL_GENERATED_WORKER_NAME="$OPENMODEL_WORKER_NAME" \
  OPENMODEL_GENERATED_AUTH_ISSUER="$OPENMODEL_AUTH_ISSUER" \
  OPENMODEL_GENERATED_AUTH_AUDIENCE="$OPENMODEL_AUTH_AUDIENCE" \
  OPENMODEL_GENERATED_ALLOWED_ORIGINS="$OPENMODEL_ALLOWED_ORIGINS" \
  OPENMODEL_GENERATED_GATEWAY_REGISTRY_ID="$gateway_registry_namespace_id" \
  OPENMODEL_GENERATED_CONFIG_FILE="$generated_worker_configuration_file" \
  node <<'EOF_NODE'
const fs = require('node:fs');
const configuration = {
  $schema: '../../node_modules/wrangler/config-schema.json',
  name: process.env.OPENMODEL_GENERATED_WORKER_NAME,
  main: 'src/index.ts',
  compatibility_date: '2026-07-01',
  workers_dev: true,
  vars: {
    AUTH_ISSUER: process.env.OPENMODEL_GENERATED_AUTH_ISSUER,
    AUTH_AUDIENCE: process.env.OPENMODEL_GENERATED_AUTH_AUDIENCE,
    ALLOWED_ORIGINS: process.env.OPENMODEL_GENERATED_ALLOWED_ORIGINS
  },
  kv_namespaces: [
    {
      binding: 'GATEWAY_REGISTRY',
      id: process.env.OPENMODEL_GENERATED_GATEWAY_REGISTRY_ID
    }
  ]
};
fs.writeFileSync(process.env.OPENMODEL_GENERATED_CONFIG_FILE, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
EOF_NODE
}

wrangler_executable() {
  local executable_path="$repository_root_directory/node_modules/.bin/wrangler"
  if [[ ! -x "$executable_path" ]]; then
    fail_deployment "Wrangler is not installed. Run npm ci first or remove --skip-validation."
  fi
  printf '%s' "$executable_path"
}

deploy_cloud_worker() {
  local gateway_registry_namespace_id="$1"
  local wrangler_command
  wrangler_command="$(wrangler_executable)"

  write_worker_configuration "$gateway_registry_namespace_id"

  log_message "Deploying the Cloudflare Worker"
  "$wrangler_command" deploy --cwd "$repository_root_directory/apps/cloud" --config "wrangler.production.generated.json"
}

ensure_pages_project() {
  local wrangler_command
  local pages_project_list_file="$deployment_work_directory/pages-projects.json"
  wrangler_command="$(wrangler_executable)"

  log_message "Checking the Cloudflare Pages project"
  "$wrangler_command" pages project list --json > "$pages_project_list_file"

  if node - "$OPENMODEL_PAGES_PROJECT" "$pages_project_list_file" <<'EOF_NODE'
const fs = require('node:fs');
const projectName = process.argv[2];
const filePath = process.argv[3];
const parsedValue = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const projects = Array.isArray(parsedValue) ? parsedValue : parsedValue.result;
if (!Array.isArray(projects)) process.exit(2);
process.exit(projects.some((project) => project.name === projectName) ? 0 : 1);
EOF_NODE
  then
    log_message "Cloudflare Pages project already exists"
    return
  fi

  log_message "Creating the Cloudflare Pages project"
  "$wrangler_command" pages project create "$OPENMODEL_PAGES_PROJECT" --production-branch "$OPENMODEL_PAGES_BRANCH"
}

build_and_deploy_website() {
  local wrangler_command
  wrangler_command="$(wrangler_executable)"

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

  log_message "Deploying the website to Cloudflare Pages"
  "$wrangler_command" pages deploy "$repository_root_directory/apps/web/dist" \
    --project-name "$OPENMODEL_PAGES_PROJECT" \
    --branch "$OPENMODEL_PAGES_BRANCH"
}

apply_complete_terraform_plan() {
  local terraform_plan_file="$deployment_work_directory/openmodel.tfplan"
  local approval_response=""

  create_terraform_plan

  if [[ "$automatically_approve_terraform" != "true" ]]; then
    if [[ ! -t 0 ]]; then
      fail_deployment "Terraform changes require an interactive terminal or the --yes option."
    fi

    printf '\nApply the complete Terraform plan shown above? Type deploy to continue: '
    read -r approval_response
    if [[ "$approval_response" != "deploy" ]]; then
      fail_deployment "Terraform apply was cancelled."
    fi
  fi

  log_message "Applying the complete Terraform plan"
  terraform -chdir="$terraform_directory" apply -input=false "$terraform_plan_file"
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
  env -u CLOUDFLARE_API_TOKEN \
    npm --prefix "$repository_root_directory" publish \
      --workspace "$workspace_name" \
      --access public \
      --tag "$NPM_DIST_TAG" \
      --registry "$npm_public_registry_url" \
      --provenance=false
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

  log_message "Verifying npm publication authentication before changing remote infrastructure"
  configure_npm_authentication
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

  log_message "Checking the cloud API"
  if ! curl --silent --show-error --fail --retry 5 --retry-delay 5 "$OPENMODEL_CLOUD_API_URL/health" >/dev/null; then
    printf 'Warning: API health check did not succeed. DNS or certificate activation may still be in progress.\n' >&2
  fi

  log_message "Checking the website"
  if ! curl --silent --show-error --fail --retry 5 --retry-delay 5 "$OPENMODEL_WEB_URL" >/dev/null; then
    printf 'Warning: Website health check did not succeed. DNS or certificate activation may still be in progress.\n' >&2
  fi
}

run_remote_deployment() {
  require_command node
  require_command npm
  require_command terraform
  require_command git
  require_environment_variable CLOUDFLARE_API_TOKEN
  require_environment_variable CLOUDFLARE_ACCOUNT_ID

  if [[ "$OPENMODEL_MANAGE_CUSTOM_DOMAINS" == "1" ]]; then
    require_environment_variable CLOUDFLARE_ZONE_ID
  fi

  export_terraform_variables
  initialize_terraform

  if [[ "$deployment_mode" == "plan" ]]; then
    create_terraform_plan
  fi

  prepare_npm_release
  bootstrap_gateway_registry
  gateway_registry_namespace_id="$(read_gateway_registry_namespace_id)"
  deploy_cloud_worker "$gateway_registry_namespace_id"
  ensure_pages_project
  build_and_deploy_website
  apply_complete_terraform_plan
  publish_npm_release
  run_health_checks

  log_message "Deployment completed"
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
  validate_boolean_configuration

  if [[ "$deployment_mode" == "validate" ]]; then
    run_validate_only
    return
  fi

  run_source_validation
  run_remote_deployment
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
