#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(basename "$repository_root_directory")" == "scripts" ]]; then
  repository_root_directory="$(cd "$repository_root_directory/.." && pwd)"
fi

terraform_directory="$repository_root_directory/deploy/terraform/aws"
deployment_directory="$repository_root_directory/.deploy"
deployment_environment_file="${OPENMODEL_DEPLOY_ENV_FILE:-$repository_root_directory/.env.deploy}"

log_message() {
  printf '\n[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1"
}

fail_adoption() {
  printf '\nAWS adoption failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail_adoption "Required command '$command_name' was not found."
}

terraform_state_contains() {
  local resource_address="$1"
  terraform -chdir="$terraform_directory" state show "$resource_address" >/dev/null 2>&1
}

import_resource_if_missing() {
  local resource_address="$1"
  local resource_identifier="$2"

  if terraform_state_contains "$resource_address"; then
    log_message "$resource_address is already in Terraform state"
    return
  fi

  if [[ -z "$resource_identifier" || "$resource_identifier" == "None" || "$resource_identifier" == "null" ]]; then
    fail_adoption "Could not determine the AWS identifier for $resource_address."
  fi

  log_message "Importing $resource_address"
  terraform -chdir="$terraform_directory" import \
    -input=false \
    "$resource_address" \
    "$resource_identifier"
}

require_command aws
require_command terraform

[[ -d "$terraform_directory" ]] || fail_adoption "Terraform directory was not found: $terraform_directory"
[[ -f "$deployment_environment_file" ]] || fail_adoption "Deployment environment file was not found: $deployment_environment_file"

deployment_environment_permissions="$(stat -c '%a' "$deployment_environment_file" 2>/dev/null || stat -f '%Lp' "$deployment_environment_file")"
if (( (8#$deployment_environment_permissions & 077) != 0 )); then
  fail_adoption "Run: chmod 600 $deployment_environment_file"
fi

set -a
source "$deployment_environment_file"
set +a

unset NPM_TOKEN
unset NODE_AUTH_TOKEN
unset CLOUDFLARE_API_TOKEN

OPENMODEL_AWS_REGION="${OPENMODEL_AWS_REGION:-us-east-1}"
OPENMODEL_AWS_PROFILE="${OPENMODEL_AWS_PROFILE:-default}"
OPENMODEL_PROJECT_NAME="${OPENMODEL_PROJECT_NAME:-openmodel}"
OPENMODEL_ROUTE53_ZONE_NAME="${OPENMODEL_ROUTE53_ZONE_NAME:-openmodel.sh}"
OPENMODEL_WEB_HOSTNAME="${OPENMODEL_WEB_HOSTNAME:-openmodel.sh}"
OPENMODEL_API_HOSTNAME="${OPENMODEL_API_HOSTNAME:-api.openmodel.sh}"
OPENMODEL_AUTH_ISSUER="${OPENMODEL_AUTH_ISSUER:-https://auth.wundercorp.co}"
OPENMODEL_AUTH_AUDIENCE="${OPENMODEL_AUTH_AUDIENCE:-https://api.openmodel.sh}"
OPENMODEL_ALLOWED_ORIGINS="${OPENMODEL_ALLOWED_ORIGINS:-https://$OPENMODEL_WEB_HOSTNAME}"
OPENMODEL_CLOUDFRONT_PRICE_CLASS="${OPENMODEL_CLOUDFRONT_PRICE_CLASS:-PriceClass_100}"
OPENMODEL_LOG_RETENTION_DAYS="${OPENMODEL_LOG_RETENTION_DAYS:-30}"
OPENMODEL_FORCE_DESTROY_WEB_BUCKET="${OPENMODEL_FORCE_DESTROY_WEB_BUCKET:-0}"
OPENMODEL_TERRAFORM_STATE_KEY="${OPENMODEL_TERRAFORM_STATE_KEY:-openmodel/production.tfstate}"

aws_arguments=(--region "$OPENMODEL_AWS_REGION")
if [[ -n "$OPENMODEL_AWS_PROFILE" ]]; then
  aws_arguments+=(--profile "$OPENMODEL_AWS_PROFILE")
  export AWS_PROFILE="$OPENMODEL_AWS_PROFILE"
fi
export AWS_REGION="$OPENMODEL_AWS_REGION"
export AWS_DEFAULT_REGION="$OPENMODEL_AWS_REGION"

OPENMODEL_AWS_ACCOUNT_ID="${OPENMODEL_AWS_ACCOUNT_ID:-$(
  aws sts get-caller-identity \
    "${aws_arguments[@]}" \
    --query Account \
    --output text
)}"

[[ "$OPENMODEL_AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail_adoption "Could not determine the AWS account ID."

OPENMODEL_TERRAFORM_STATE_BUCKET="${OPENMODEL_TERRAFORM_STATE_BUCKET:-openmodel-terraform-state-$OPENMODEL_AWS_ACCOUNT_ID}"

if [[ -z "${OPENMODEL_ROUTE53_ZONE_ID:-}" ]]; then
  OPENMODEL_ROUTE53_ZONE_ID="$(
    aws route53 list-hosted-zones-by-name \
      "${aws_arguments[@]}" \
      --dns-name "$OPENMODEL_ROUTE53_ZONE_NAME" \
      --query "HostedZones[?Name=='${OPENMODEL_ROUTE53_ZONE_NAME%.}.'].Id | [0]" \
      --output text
  )"
  OPENMODEL_ROUTE53_ZONE_ID="${OPENMODEL_ROUTE53_ZONE_ID#/hostedzone/}"
fi

[[ -n "$OPENMODEL_ROUTE53_ZONE_ID" && "$OPENMODEL_ROUTE53_ZONE_ID" != "None" ]] || fail_adoption "Could not determine the Route 53 hosted-zone ID."

lambda_bundle_file="$repository_root_directory/apps/aws-api/dist/index.mjs"
[[ -f "$lambda_bundle_file" ]] || fail_adoption "The Lambda bundle is missing. Run: npm run build --workspace @wundercorp/openmodel-aws-api"

website_bucket_name="${OPENMODEL_PROJECT_NAME}-web-${OPENMODEL_AWS_ACCOUNT_ID}"
origin_access_control_name="${OPENMODEL_PROJECT_NAME}-website-oac"
response_headers_policy_name="${OPENMODEL_PROJECT_NAME}-security-headers"
gateway_registry_table_name="${OPENMODEL_PROJECT_NAME}-gateway-registry"
api_role_name="${OPENMODEL_PROJECT_NAME}-cloud-api-role"
api_log_group_name="/aws/lambda/${OPENMODEL_PROJECT_NAME}-cloud-api"

log_message "Verifying the existing S3 website bucket"
if ! aws s3api head-bucket \
  "${aws_arguments[@]}" \
  --bucket "$website_bucket_name" >/dev/null 2>&1; then
  fail_adoption "The bucket $website_bucket_name exists globally but is not accessible with the selected AWS identity. Do not import it. Confirm ownership or choose a different project name."
fi

origin_access_control_id="$(
  aws cloudfront list-origin-access-controls \
    "${aws_arguments[@]}" \
    --query "OriginAccessControlList.Items[?Name=='$origin_access_control_name'].Id | [0]" \
    --output text
)"

response_headers_policy_id="$(
  aws cloudfront list-response-headers-policies \
    "${aws_arguments[@]}" \
    --type custom \
    --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='$response_headers_policy_name'].ResponseHeadersPolicy.Id | [0]" \
    --output text
)"

aws dynamodb describe-table \
  "${aws_arguments[@]}" \
  --table-name "$gateway_registry_table_name" >/dev/null

aws iam get-role \
  "${aws_arguments[@]}" \
  --role-name "$api_role_name" >/dev/null

log_group_name="$(
  aws logs describe-log-groups \
    "${aws_arguments[@]}" \
    --log-group-name-prefix "$api_log_group_name" \
    --query "logGroups[?logGroupName=='$api_log_group_name'].logGroupName | [0]" \
    --output text
)"

aws apigatewayv2 get-domain-name \
  "${aws_arguments[@]}" \
  --domain-name "$OPENMODEL_API_HOSTNAME" >/dev/null

mkdir -p "$deployment_directory"
chmod 700 "$deployment_directory"

backend_configuration_file="$deployment_directory/aws-backend.hcl"
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

export TF_IN_AUTOMATION=1
export TF_INPUT=0
export TF_VAR_aws_region="$OPENMODEL_AWS_REGION"
export TF_VAR_aws_profile="$OPENMODEL_AWS_PROFILE"
export TF_VAR_expected_aws_account_id="$OPENMODEL_AWS_ACCOUNT_ID"
export TF_VAR_route53_zone_id="$OPENMODEL_ROUTE53_ZONE_ID"
export TF_VAR_project_name="$OPENMODEL_PROJECT_NAME"
export TF_VAR_web_hostname="$OPENMODEL_WEB_HOSTNAME"
export TF_VAR_api_hostname="$OPENMODEL_API_HOSTNAME"
export TF_VAR_auth_issuer="$OPENMODEL_AUTH_ISSUER"
export TF_VAR_auth_audience="$OPENMODEL_AUTH_AUDIENCE"
export TF_VAR_allowed_origins="$OPENMODEL_ALLOWED_ORIGINS"
export TF_VAR_lambda_bundle_file="$lambda_bundle_file"
export TF_VAR_cloudfront_price_class="$OPENMODEL_CLOUDFRONT_PRICE_CLASS"
export TF_VAR_log_retention_days="$OPENMODEL_LOG_RETENTION_DAYS"
if [[ "$OPENMODEL_FORCE_DESTROY_WEB_BUCKET" == "1" ]]; then
  export TF_VAR_force_destroy_web_bucket=true
else
  export TF_VAR_force_destroy_web_bucket=false
fi

log_message "Initializing Terraform with the production backend"
terraform -chdir="$terraform_directory" init \
  -input=false \
  -reconfigure \
  -backend-config="$backend_configuration_file"

state_backup_file="$deployment_directory/terraform-state-before-adoption-$(date -u '+%Y%m%dT%H%M%SZ').json"
terraform -chdir="$terraform_directory" state pull > "$state_backup_file"
chmod 600 "$state_backup_file"
log_message "Saved a state backup to $state_backup_file"

import_resource_if_missing "aws_s3_bucket.website" "$website_bucket_name"
import_resource_if_missing "aws_cloudfront_origin_access_control.website" "$origin_access_control_id"
import_resource_if_missing "aws_cloudfront_response_headers_policy.security" "$response_headers_policy_id"
import_resource_if_missing "aws_dynamodb_table.gateway_registry" "$gateway_registry_table_name"
import_resource_if_missing "aws_iam_role.api" "$api_role_name"
import_resource_if_missing "aws_cloudwatch_log_group.api" "$log_group_name"
import_resource_if_missing "aws_apigatewayv2_domain_name.api" "$OPENMODEL_API_HOSTNAME"

log_message "Creating a reconciliation plan"
terraform -chdir="$terraform_directory" plan -input=false

printf '\nExisting AWS resources were adopted into Terraform state.\n'
printf 'Review the plan above carefully, then run: ./deploy.sh --yes\n'
