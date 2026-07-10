#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_name="origin"
remote_url="${GIT_REMOTE_URL:-}"
branch_name="${GIT_BRANCH:-}"
github_repository="${GITHUB_REPOSITORY:-}"
github_visibility="${GITHUB_REPOSITORY_VISIBILITY:-public}"
create_github_repository="false"

print_usage() {
  cat <<'USAGE'
Usage: ./git-push.sh [options]

Options:
  --remote-url URL       Add or update the Git remote before pushing.
  --remote-name NAME     Remote name. Default: origin.
  --branch NAME          Branch to push. Default: current branch.
  --create-github        Create the remote with GitHub CLI when it does not exist.
  --repository OWNER/REPO GitHub repository used with --create-github.
  --visibility VALUE     public, private, or internal. Default: public.
  --help                 Show this help text.

Examples:
  GIT_REMOTE_URL=git@github.com:wundercorp/openmodel.git ./git-push.sh
  ./git-push.sh --create-github --repository wundercorp/openmodel --visibility public
USAGE
}

fail_git_operation() {
  printf 'Git push failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail_git_operation "Required command '$1' was not found."
  fi
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --remote-url)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--remote-url requires a value."
        remote_url="$1"
        ;;
      --remote-name)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--remote-name requires a value."
        remote_name="$1"
        ;;
      --branch)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--branch requires a value."
        branch_name="$1"
        ;;
      --create-github)
        create_github_repository="true"
        ;;
      --repository)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--repository requires a value."
        github_repository="$1"
        ;;
      --visibility)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--visibility requires a value."
        github_visibility="$1"
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        fail_git_operation "Unknown option: $1"
        ;;
    esac
    shift
  done
}

validate_repository_safety() {
  local tracked_path
  while IFS= read -r tracked_path; do
    case "$tracked_path" in
      .env|.env.*|*/.env|*/.env.*|*.tfstate|*.tfstate.*|*.tfplan|terraform.tfvars|*.auto.tfvars|*.pem|*.key|*.p12|*.pfx|*.token|*.secret|credentials.json|secrets.json|.aws/*|.deploy/*|node_modules/*|dist/*|*.gguf|*.safetensors)
        if [[ "$tracked_path" == '.env.example' || "$tracked_path" == '.env.deploy.example' || "$tracked_path" == 'env.deploy.example' || "$tracked_path" == */.env.example || "$tracked_path" == */.env.*.example || "$tracked_path" == *.tfvars.example ]]; then
          continue
        fi
        fail_git_operation "A sensitive or generated file is tracked: $tracked_path"
        ;;
    esac
  done < <(git ls-files)

  if [[ -n "$(git status --porcelain)" ]]; then
    fail_git_operation "The working tree is not clean. Commit or stash changes before pushing."
  fi
}

configure_remote() {
  if [[ -n "$remote_url" ]]; then
    if git remote get-url "$remote_name" >/dev/null 2>&1; then
      git remote set-url "$remote_name" "$remote_url"
    else
      git remote add "$remote_name" "$remote_url"
    fi
    return
  fi

  if git remote get-url "$remote_name" >/dev/null 2>&1; then
    return
  fi

  if [[ "$create_github_repository" != "true" ]]; then
    fail_git_operation "Remote '$remote_name' does not exist. Provide --remote-url or use --create-github."
  fi

  require_command gh
  if [[ -z "$github_repository" ]]; then
    fail_git_operation "--create-github requires --repository OWNER/REPO or GITHUB_REPOSITORY."
  fi
  case "$github_visibility" in
    public|private|internal) ;;
    *) fail_git_operation "Visibility must be public, private, or internal." ;;
  esac

  gh repo create "$github_repository" \
    --source "$repository_root_directory" \
    --remote "$remote_name" \
    "--$github_visibility"
}

main() {
  parse_arguments "$@"
  require_command git
  cd "$repository_root_directory"

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail_git_operation "This directory is not a Git repository. Run ./git-init.sh first."
  fi
  if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    fail_git_operation "The repository has no commit to push."
  fi

  if [[ -z "$branch_name" ]]; then
    branch_name="$(git branch --show-current)"
  fi
  if [[ -z "$branch_name" ]]; then
    fail_git_operation "Could not determine the current branch."
  fi

  validate_repository_safety
  configure_remote
  git push --set-upstream "$remote_name" "$branch_name"
  printf 'Pushed branch %s to %s.\n' "$branch_name" "$remote_name"
}

main "$@"
