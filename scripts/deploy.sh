#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deployment_environment_file="${OPENMODEL_DEPLOY_ENV_FILE:-$repository_root_directory/.env.deploy}"
deployment_provider="${OPENMODEL_DEPLOY_PROVIDER:-}"
run_git_initialization="false"
run_git_push="false"
git_remote_url=""
git_create_github="false"
git_repository=""
git_visibility="public"
provider_arguments=()

print_usage() {
  cat <<'USAGE'
Usage: ./deploy.sh [options]

Deployment selection:
  --provider aws|cloudflare  Deployment provider. Default: aws.

Optional Git integration:
  --git-init                 Initialize and commit the repository before deployment.
  --git-push                 Push the current clean branch before deployment.
  --git-remote-url URL       Configure the Git remote used by --git-push.
  --git-create-github        Create a GitHub repository through gh before pushing.
  --git-repository OWNER/REPO
  --git-visibility VALUE     public, private, or internal.

Provider options:
  --publish-npm
  --skip-validation
  --plan-only
  --validate-only
  --yes
  --help

AWS site and API deployment without npm publication:
  ./deploy.sh --yes

Initialize, push, deploy, and publish npm packages:
  ./deploy.sh --git-init --git-push --git-remote-url git@github.com:wundercorp/openmodel.git --publish-npm --yes
USAGE
}

fail_deployment() {
  printf 'Deployment failed: %s\n' "$1" >&2
  exit 1
}

read_provider_from_environment_file() {
  if [[ -n "$deployment_provider" || ! -f "$deployment_environment_file" ]]; then
    return
  fi

  local provider_line
  provider_line="$(grep -E '^[[:space:]]*OPENMODEL_DEPLOY_PROVIDER=' "$deployment_environment_file" | tail -n 1 || true)"
  if [[ -z "$provider_line" ]]; then
    return
  fi

  deployment_provider="${provider_line#*=}"
  deployment_provider="${deployment_provider%$'\r'}"
  deployment_provider="${deployment_provider#\"}"
  deployment_provider="${deployment_provider%\"}"
  deployment_provider="${deployment_provider#\'}"
  deployment_provider="${deployment_provider%\'}"
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --provider)
        shift
        [[ $# -gt 0 ]] || fail_deployment "--provider requires aws or cloudflare."
        deployment_provider="$1"
        ;;
      --git-init)
        run_git_initialization="true"
        ;;
      --git-push)
        run_git_push="true"
        ;;
      --git-remote-url)
        shift
        [[ $# -gt 0 ]] || fail_deployment "--git-remote-url requires a value."
        git_remote_url="$1"
        ;;
      --git-create-github)
        git_create_github="true"
        ;;
      --git-repository)
        shift
        [[ $# -gt 0 ]] || fail_deployment "--git-repository requires OWNER/REPO."
        git_repository="$1"
        ;;
      --git-visibility)
        shift
        [[ $# -gt 0 ]] || fail_deployment "--git-visibility requires a value."
        git_visibility="$1"
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        provider_arguments+=("$1")
        ;;
    esac
    shift
  done
}

run_git_steps() {
  if [[ "$run_git_initialization" == "true" ]]; then
    "$repository_root_directory/scripts/git-init.sh"
  fi

  if [[ "$run_git_push" != "true" ]]; then
    return
  fi

  local git_push_arguments=()
  if [[ -n "$git_remote_url" ]]; then
    git_push_arguments+=(--remote-url "$git_remote_url")
  fi
  if [[ "$git_create_github" == "true" ]]; then
    git_push_arguments+=(--create-github)
  fi
  if [[ -n "$git_repository" ]]; then
    git_push_arguments+=(--repository "$git_repository")
  fi
  git_push_arguments+=(--visibility "$git_visibility")
  "$repository_root_directory/scripts/git-push.sh" "${git_push_arguments[@]}"
}

main() {
  parse_arguments "$@"
  read_provider_from_environment_file
  deployment_provider="${deployment_provider:-aws}"

  case "$deployment_provider" in
    aws|cloudflare) ;;
    *) fail_deployment "OPENMODEL_DEPLOY_PROVIDER must be aws or cloudflare." ;;
  esac

  run_git_steps

  if [[ "$deployment_provider" == "aws" ]]; then
    if (( ${#provider_arguments[@]} > 0 )); then
      exec bash "$repository_root_directory/scripts/deploy-aws.sh" "${provider_arguments[@]}"
    fi
    exec bash "$repository_root_directory/scripts/deploy-aws.sh"
  fi

  if (( ${#provider_arguments[@]} > 0 )); then
    exec bash "$repository_root_directory/scripts/deploy-cloudflare.sh" "${provider_arguments[@]}"
  fi
  exec bash "$repository_root_directory/scripts/deploy-cloudflare.sh"
}

main "$@"
