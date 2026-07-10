#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(git rev-parse --show-toplevel 2>/dev/null || true)"
deployment_environment_file="${OPENMODEL_DEPLOY_ENV_FILE:-$repository_root_directory/.env.deploy}"
push_rewritten_history="false"
automatically_confirm="false"

fail_cleanup() {
  printf 'History cleanup failed: %s\n' "$1" >&2
  exit 1
}

print_usage() {
  cat <<'USAGE'
Usage: ./purge-git-history.sh [options]

Reads deployment identifiers from the ignored .env.deploy file, redacts them
from every local branch and tag with git-filter-repo, and optionally force-pushes
the rewritten history.

Options:
  --push    Force-push all rewritten branches and tags to origin.
  --yes     Skip the destructive-operation confirmation.
  --help    Show this help.

Recommended:
  ./purge-git-history.sh --push
USAGE
}

read_environment_value() {
  local key="$1"
  local line
  line="$(grep -E "^[[:space:]]*${key}=" "$deployment_environment_file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return
  fi
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line#\"}"
  line="${line%\"}"
  line="${line#\'}"
  line="${line%\'}"
  printf '%s' "$line"
}

append_redaction() {
  local value="$1"
  local replacement="$2"
  if [[ -n "$value" ]]; then
    printf 'literal:%s==>%s\n' "$value" "$replacement" >> "$redaction_file"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)
      push_rewritten_history="true"
      ;;
    --yes)
      automatically_confirm="true"
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      fail_cleanup "Unknown option: $1"
      ;;
  esac
  shift
done

[[ -n "$repository_root_directory" ]] || fail_cleanup "Run this command inside the Git repository."
command -v git-filter-repo >/dev/null 2>&1 || fail_cleanup "git-filter-repo is required. On macOS: brew install git-filter-repo"
[[ -f "$deployment_environment_file" ]] || fail_cleanup "Missing ignored deployment file: $deployment_environment_file"
git diff --quiet && git diff --cached --quiet || fail_cleanup "Commit or stash tracked changes before rewriting history."

deployment_file_relative_path="${deployment_environment_file#"$repository_root_directory/"}"
git check-ignore -q "$deployment_file_relative_path" || fail_cleanup "$deployment_file_relative_path must be ignored by Git."

aws_account_id="$(read_environment_value OPENMODEL_AWS_ACCOUNT_ID)"
route53_zone_id="$(read_environment_value OPENMODEL_ROUTE53_ZONE_ID)"
expected_name_servers="$(read_environment_value OPENMODEL_ROUTE53_EXPECTED_NAME_SERVERS)"
terraform_state_bucket="$(read_environment_value OPENMODEL_TERRAFORM_STATE_BUCKET)"

[[ -n "$aws_account_id" || -n "$route53_zone_id" || -n "$expected_name_servers" || -n "$terraform_state_bucket" ]] || fail_cleanup "No deployment identifiers were found in $deployment_environment_file."

redaction_file="$(mktemp)"
trap 'rm -f "$redaction_file"' EXIT
chmod 600 "$redaction_file"

append_redaction "$terraform_state_bucket" 'REMOVED_TERRAFORM_STATE_BUCKET'
if [[ -n "$aws_account_id" ]]; then
  append_redaction "openmodel-terraform-state-$aws_account_id" 'REMOVED_TERRAFORM_STATE_BUCKET'
fi
append_redaction "$aws_account_id" 'REMOVED_AWS_ACCOUNT_ID'
append_redaction "$route53_zone_id" 'REMOVED_ROUTE53_ZONE_ID'

if [[ -n "$expected_name_servers" ]]; then
  old_ifs="$IFS"
  IFS=','
  read -r -a name_server_values <<< "$expected_name_servers"
  IFS="$old_ifs"
  name_server_number=1
  for name_server_value in "${name_server_values[@]}"; do
    append_redaction "$name_server_value" "REMOVED_ROUTE53_NAME_SERVER_${name_server_number}"
    name_server_number=$((name_server_number + 1))
  done
fi

origin_url="$(git remote get-url origin 2>/dev/null || true)"

if [[ "$automatically_confirm" != "true" ]]; then
  printf '%s\n' 'This rewrites every local commit, branch, and tag.'
  printf '%s' 'Type rewrite to continue: '
  read -r confirmation
  [[ "$confirmation" == "rewrite" ]] || fail_cleanup "Cancelled."
fi

git filter-repo --force --replace-text "$redaction_file"

if [[ -n "$origin_url" ]] && ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$origin_url"
fi

if [[ "$push_rewritten_history" == "true" ]]; then
  [[ -n "$origin_url" ]] || fail_cleanup "No origin remote existed before the rewrite."
  git push --force --all origin
  git push --force --tags origin
  printf '%s\n' 'Rewritten branches and tags were force-pushed to origin.'
else
  printf '%s\n' 'Local history was rewritten. Review it, then run:'
  printf '%s\n' '  git push --force --all origin'
  printf '%s\n' '  git push --force --tags origin'
fi

printf '%s\n' 'Rotate any actual credentials or tokens that were ever committed; history rewriting cannot revoke them.'
