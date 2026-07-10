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

terraform_state_attribute() {
  local resource_address="$1"
  local attribute_name="$2"

  terraform -chdir="$terraform_directory" state show -no-color "$resource_address" 2>/dev/null | \
    awk -F' = ' -v attribute_name="$attribute_name" '
      $1 ~ "^[[:space:]]*" attribute_name "$" {
        value = $2
        gsub(/^\"|\"$/, "", value)
        print value
        exit
      }
    '
}

remove_stale_state_binding() {
  local resource_address="$1"
  local comparison_attribute="$2"
  local expected_value="$3"

  if ! terraform_state_contains "$resource_address"; then
    return
  fi

  local current_value
  current_value="$(terraform_state_attribute "$resource_address" "$comparison_attribute")"

  if [[ "$current_value" == "$expected_value" ]]; then
    log_message "$resource_address already points to the expected AWS object"
    return
  fi

  log_message "Removing stale Terraform state binding for $resource_address"
  printf 'Current %s: %s\n' "$comparison_attribute" "${current_value:-<missing>}"
  printf 'Expected %s: %s\n' "$comparison_attribute" "$expected_value"
  terraform -chdir="$terraform_directory" state rm "$resource_address"
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

  log_message "Importing $resource_address as $resource_identifier"
  terraform -chdir="$terraform_directory" import \
    -input=false \
    "$resource_address" \
    "$resource_identifier"
}

read_json_value() {
  local json_file="$1"
  local python_expression="$2"

  python3 - "$json_file" "$python_expression" <<'PY'
import json
import sys

json_file = sys.argv[1]
python_expression = sys.argv[2]

with open(json_file, "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

value = eval(python_expression, {"__builtins__": {}}, {"data": data})

if value is None:
    print("")
elif isinstance(value, (dict, list)):
    print(json.dumps(value))
else:
    print(value)
PY
}

require_command aws
require_command terraform
require_command python3

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
api_function_name="${OPENMODEL_PROJECT_NAME}-cloud-api"
api_name="${OPENMODEL_PROJECT_NAME}-http-api"

mkdir -p "$deployment_directory"
chmod 700 "$deployment_directory"

log_message "Verifying the existing S3 website bucket"
if ! aws s3api head-bucket \
  "${aws_arguments[@]}" \
  --bucket "$website_bucket_name" >/dev/null 2>&1; then
  fail_adoption "The bucket $website_bucket_name is not accessible with the selected AWS identity."
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

api_domain_json="$deployment_directory/api-domain.json"
aws apigatewayv2 get-domain-name \
  "${aws_arguments[@]}" \
  --domain-name "$OPENMODEL_API_HOSTNAME" > "$api_domain_json"

api_gateway_domain_name="$(read_json_value "$api_domain_json" "(data.get('DomainNameConfigurations') or [{}])[0].get('ApiGatewayDomainName', '')")"
api_gateway_hosted_zone_id="$(read_json_value "$api_domain_json" "(data.get('DomainNameConfigurations') or [{}])[0].get('HostedZoneId', '')")"
[[ -n "$api_gateway_domain_name" ]] || fail_adoption "Could not determine the API Gateway target domain."

cloudfront_distributions_json="$deployment_directory/cloudfront-distributions.json"
aws cloudfront list-distributions \
  "${aws_arguments[@]}" > "$cloudfront_distributions_json"

cloudfront_distribution_id="$(
  python3 - "$cloudfront_distributions_json" "$OPENMODEL_WEB_HOSTNAME" "$website_bucket_name" <<'PY'
import json
import sys

json_file, alias_name, bucket_name = sys.argv[1:4]

with open(json_file, "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

matches = []
for distribution in (data.get("DistributionList") or {}).get("Items") or []:
    aliases = (distribution.get("Aliases") or {}).get("Items") or []
    if alias_name not in aliases:
        continue

    origins = (distribution.get("Origins") or {}).get("Items") or []
    origin_domains = [origin.get("DomainName", "") for origin in origins]

    if not any(domain_name.startswith(bucket_name + ".") for domain_name in origin_domains):
        print(
            "A CloudFront distribution owns the web alias, but its origin does not match "
            f"the expected bucket {bucket_name}: {distribution.get('Id')} {origin_domains}",
            file=sys.stderr,
        )
        sys.exit(2)

    matches.append(distribution)

if len(matches) == 0:
    sys.exit(3)

if len(matches) > 1:
    print("More than one CloudFront distribution matched the web hostname.", file=sys.stderr)
    sys.exit(4)

print(matches[0]["Id"])
PY
)" || {
  cloudfront_discovery_status="$?"
  if [[ "$cloudfront_discovery_status" == "3" ]]; then
    fail_adoption "No CloudFront distribution in this AWS account owns $OPENMODEL_WEB_HOSTNAME."
  fi
  fail_adoption "The existing CloudFront alias could not be safely matched to this deployment."
}

cloudfront_distribution_json="$deployment_directory/cloudfront-distribution.json"
aws cloudfront get-distribution \
  "${aws_arguments[@]}" \
  --id "$cloudfront_distribution_id" > "$cloudfront_distribution_json"

cloudfront_distribution_domain_name="$(read_json_value "$cloudfront_distribution_json" "data.get('Distribution', {}).get('DomainName', '')")"
[[ -n "$cloudfront_distribution_domain_name" ]] || fail_adoption "Could not determine the CloudFront distribution domain."

lambda_function_json="$deployment_directory/lambda-function.json"
aws lambda get-function \
  "${aws_arguments[@]}" \
  --function-name "$api_function_name" > "$lambda_function_json"

lambda_function_arn="$(read_json_value "$lambda_function_json" "data.get('Configuration', {}).get('FunctionArn', '')")"
[[ -n "$lambda_function_arn" ]] || fail_adoption "Could not determine the Lambda function ARN."

api_mappings_json="$deployment_directory/api-mappings.json"
aws apigatewayv2 get-api-mappings \
  "${aws_arguments[@]}" \
  --domain-name "$OPENMODEL_API_HOSTNAME" > "$api_mappings_json"

api_mapping_line="$(
  python3 - "$api_mappings_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

root_mappings = [
    mapping
    for mapping in data.get("Items", [])
    if mapping.get("ApiMappingKey") in (None, "")
]

if len(root_mappings) != 1:
    print(f"Expected exactly one root API mapping, found {len(root_mappings)}.", file=sys.stderr)
    sys.exit(1)

mapping = root_mappings[0]
print("\t".join([
    mapping.get("ApiId", ""),
    mapping.get("ApiMappingId", ""),
    mapping.get("Stage", ""),
]))
PY
)" || fail_adoption "Could not safely identify the existing root API mapping."

old_ifs="$IFS"
IFS=$'\t' read -r api_id api_mapping_id api_stage_name <<< "$api_mapping_line"
IFS="$old_ifs"

[[ -n "$api_id" ]] || fail_adoption "The root API mapping did not contain an API ID."
[[ -n "$api_mapping_id" ]] || fail_adoption "The root API mapping did not contain a mapping ID."
[[ -n "$api_stage_name" ]] || fail_adoption "The root API mapping did not contain a stage name."

mapped_api_json="$deployment_directory/mapped-api.json"
aws apigatewayv2 get-api \
  "${aws_arguments[@]}" \
  --api-id "$api_id" > "$mapped_api_json"

python3 - "$mapped_api_json" "$api_name" <<'PY'
import json
import sys

json_file, expected_name = sys.argv[1:3]
with open(json_file, "r", encoding="utf-8") as file_handle:
    api = json.load(file_handle)

if api.get("Name") != expected_name:
    print(
        f"The API mapped to the production domain is named {api.get('Name')!r}, "
        f"not expected {expected_name!r}.",
        file=sys.stderr,
    )
    sys.exit(1)

if api.get("ProtocolType") != "HTTP":
    print(
        f"The mapped API uses protocol {api.get('ProtocolType')!r}, not HTTP.",
        file=sys.stderr,
    )
    sys.exit(2)
PY

apis_json="$deployment_directory/apis.json"
aws apigatewayv2 get-apis \
  "${aws_arguments[@]}" > "$apis_json"

orphan_api_ids="$(
  python3 - "$apis_json" "$api_name" "$api_id" <<'PY'
import json
import sys

json_file, expected_name, mapped_api_id = sys.argv[1:4]
with open(json_file, "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

orphan_ids = [
    item.get("ApiId", "")
    for item in data.get("Items", [])
    if item.get("Name") == expected_name and item.get("ApiId") != mapped_api_id
]
print(" ".join(api_id for api_id in orphan_ids if api_id))
PY
)"

log_message "Using API $api_id because it is mapped to $OPENMODEL_API_HOSTNAME"
if [[ -n "$orphan_api_ids" ]]; then
  printf 'Unmapped same-named API IDs retained for later review: %s\n' "$orphan_api_ids"
  printf '%s\n' "$orphan_api_ids" > "$deployment_directory/orphan-api-ids.txt"
  chmod 600 "$deployment_directory/orphan-api-ids.txt"
fi

api_routes_json="$deployment_directory/api-routes.json"
aws apigatewayv2 get-routes \
  "${aws_arguments[@]}" \
  --api-id "$api_id" > "$api_routes_json"

route_line="$(
  python3 - "$api_routes_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

matches = [item for item in data.get("Items", []) if item.get("RouteKey") == "$default"]
if len(matches) != 1:
    print(f"Expected exactly one $default route, found {len(matches)}.", file=sys.stderr)
    sys.exit(1)

route = matches[0]
target = route.get("Target", "")
if not target.startswith("integrations/"):
    print(f"The $default route has an unexpected target: {target!r}.", file=sys.stderr)
    sys.exit(2)

print("\t".join([route.get("RouteId", ""), target.split("/", 1)[1]]))
PY
)" || fail_adoption "Could not safely identify the API route and integration."

old_ifs="$IFS"
IFS=$'\t' read -r api_route_id api_integration_id <<< "$route_line"
IFS="$old_ifs"

[[ -n "$api_route_id" ]] || fail_adoption "Could not determine the $default route ID."
[[ -n "$api_integration_id" ]] || fail_adoption "Could not determine the Lambda integration ID."

api_integration_json="$deployment_directory/api-integration.json"
aws apigatewayv2 get-integration \
  "${aws_arguments[@]}" \
  --api-id "$api_id" \
  --integration-id "$api_integration_id" > "$api_integration_json"

python3 - "$api_integration_json" "$lambda_function_arn" <<'PY'
import json
import sys

json_file, expected_lambda_arn = sys.argv[1:3]
with open(json_file, "r", encoding="utf-8") as file_handle:
    integration = json.load(file_handle)

if integration.get("IntegrationType") != "AWS_PROXY":
    print(
        f"The mapped API integration type is {integration.get('IntegrationType')!r}, not AWS_PROXY.",
        file=sys.stderr,
    )
    sys.exit(1)

integration_uri = integration.get("IntegrationUri", "")
if expected_lambda_arn not in integration_uri:
    print(
        f"The mapped API integration does not target the expected Lambda function: {integration_uri!r}.",
        file=sys.stderr,
    )
    sys.exit(2)
PY

aws apigatewayv2 get-stage \
  "${aws_arguments[@]}" \
  --api-id "$api_id" \
  --stage-name "$api_stage_name" >/dev/null

route53_records_json="$deployment_directory/route53-records.json"
aws route53 list-resource-record-sets \
  "${aws_arguments[@]}" \
  --hosted-zone-id "$OPENMODEL_ROUTE53_ZONE_ID" > "$route53_records_json"

python3 - \
  "$route53_records_json" \
  "${OPENMODEL_API_HOSTNAME%.}." \
  "$api_gateway_domain_name" \
  "$api_gateway_hosted_zone_id" <<'PY'
import json
import sys

json_file, record_name, expected_target, expected_zone_id = sys.argv[1:5]
with open(json_file, "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

matches = [
    record
    for record in data.get("ResourceRecordSets", [])
    if record.get("Name") == record_name and record.get("Type") == "A"
]

if len(matches) != 1:
    print(f"Expected one Route 53 A record for {record_name}, found {len(matches)}.", file=sys.stderr)
    sys.exit(1)

alias_target = matches[0].get("AliasTarget") or {}
actual_target = (alias_target.get("DNSName") or "").rstrip(".")
expected_target = expected_target.rstrip(".")

if actual_target != expected_target:
    print(
        f"The API DNS record points to {actual_target}, not expected target {expected_target}.",
        file=sys.stderr,
    )
    sys.exit(2)

if alias_target.get("HostedZoneId") != expected_zone_id:
    print(
        f"The API DNS record uses hosted zone {alias_target.get('HostedZoneId')}, "
        f"not expected {expected_zone_id}.",
        file=sys.stderr,
    )
    sys.exit(3)
PY

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

remove_stale_state_binding "aws_apigatewayv2_api.api" "id" "$api_id"
remove_stale_state_binding "aws_apigatewayv2_integration.api" "api_id" "$api_id"
remove_stale_state_binding "aws_apigatewayv2_route.default" "api_id" "$api_id"
remove_stale_state_binding "aws_apigatewayv2_stage.default" "api_id" "$api_id"
remove_stale_state_binding "aws_apigatewayv2_api_mapping.api" "api_id" "$api_id"

import_resource_if_missing "aws_s3_bucket.website" "$website_bucket_name"
import_resource_if_missing "aws_cloudfront_origin_access_control.website" "$origin_access_control_id"
import_resource_if_missing "aws_cloudfront_response_headers_policy.security" "$response_headers_policy_id"
import_resource_if_missing "aws_cloudfront_distribution.website" "$cloudfront_distribution_id"
import_resource_if_missing "aws_dynamodb_table.gateway_registry" "$gateway_registry_table_name"
import_resource_if_missing "aws_iam_role.api" "$api_role_name"
import_resource_if_missing "aws_cloudwatch_log_group.api" "$log_group_name"
import_resource_if_missing "aws_lambda_function.api" "$api_function_name"
import_resource_if_missing "aws_apigatewayv2_api.api" "$api_id"
import_resource_if_missing "aws_apigatewayv2_integration.api" "${api_id}/${api_integration_id}"
import_resource_if_missing "aws_apigatewayv2_route.default" "${api_id}/${api_route_id}"
import_resource_if_missing "aws_apigatewayv2_stage.default" "${api_id}/${api_stage_name}"
import_resource_if_missing "aws_apigatewayv2_domain_name.api" "$OPENMODEL_API_HOSTNAME"
import_resource_if_missing "aws_apigatewayv2_api_mapping.api" "${api_mapping_id}/${OPENMODEL_API_HOSTNAME}"
import_resource_if_missing "aws_route53_record.api_ipv4" "${OPENMODEL_ROUTE53_ZONE_ID}_${OPENMODEL_API_HOSTNAME}_A"

lambda_policy_text="$(
  aws lambda get-policy \
    "${aws_arguments[@]}" \
    --function-name "$api_function_name" \
    --query Policy \
    --output text 2>/dev/null || true
)"

lambda_permission_exists="$(
  python3 - "$lambda_policy_text" <<'PY'
import json
import sys

raw_policy = sys.argv[1]
if raw_policy in ("", "None"):
    print("0")
    raise SystemExit

policy = json.loads(raw_policy)
exists = any(
    statement.get("Sid") == "AllowApiGatewayInvoke"
    for statement in policy.get("Statement", [])
)
print("1" if exists else "0")
PY
)"

if [[ "$lambda_permission_exists" == "1" ]]; then
  import_resource_if_missing "aws_lambda_permission.api_gateway" "${api_function_name}/AllowApiGatewayInvoke"
fi

website_ipv4_exists="$(
  python3 - "$route53_records_json" "${OPENMODEL_WEB_HOSTNAME%.}." "$cloudfront_distribution_domain_name" <<'PY'
import json
import sys

json_file, record_name, expected_target = sys.argv[1:4]
with open(json_file, "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

for record in data.get("ResourceRecordSets", []):
    if record.get("Name") != record_name or record.get("Type") != "A":
        continue
    target = ((record.get("AliasTarget") or {}).get("DNSName") or "").rstrip(".")
    if target == expected_target.rstrip("."):
        print("1")
        break
PY
)"

if [[ "$website_ipv4_exists" == "1" ]]; then
  import_resource_if_missing "aws_route53_record.website_ipv4" "${OPENMODEL_ROUTE53_ZONE_ID}_${OPENMODEL_WEB_HOSTNAME}_A"
fi

website_ipv6_exists="$(
  python3 - "$route53_records_json" "${OPENMODEL_WEB_HOSTNAME%.}." "$cloudfront_distribution_domain_name" <<'PY'
import json
import sys

json_file, record_name, expected_target = sys.argv[1:4]
with open(json_file, "r", encoding="utf-8") as file_handle:
    data = json.load(file_handle)

for record in data.get("ResourceRecordSets", []):
    if record.get("Name") != record_name or record.get("Type") != "AAAA":
        continue
    target = ((record.get("AliasTarget") or {}).get("DNSName") or "").rstrip(".")
    if target == expected_target.rstrip("."):
        print("1")
        break
PY
)"

if [[ "$website_ipv6_exists" == "1" ]]; then
  import_resource_if_missing "aws_route53_record.website_ipv6" "${OPENMODEL_ROUTE53_ZONE_ID}_${OPENMODEL_WEB_HOSTNAME}_AAAA"
fi

log_message "Creating a reconciliation plan"
terraform -chdir="$terraform_directory" plan -input=false

printf '\nExisting AWS resources were adopted into Terraform state.\n'
printf 'Review the plan above carefully, then run: ./deploy.sh --yes\n'
if [[ -n "$orphan_api_ids" ]]; then
  printf 'After production is healthy, review the orphan API IDs in .deploy/orphan-api-ids.txt.\n'
fi
