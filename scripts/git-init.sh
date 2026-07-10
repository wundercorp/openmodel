#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_branch="main"
commit_message="Initial OpenModel release"
create_commit="true"

print_usage() {
  cat <<'USAGE'
Usage: ./git-init.sh [options]

Options:
  --branch NAME       Initial branch name. Default: main.
  --message TEXT      Initial commit message.
  --no-commit         Initialize and stage safely without committing.
  --help              Show this help text.
USAGE
}

fail_git_operation() {
  printf 'Git initialization failed: %s\n' "$1" >&2
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
      --branch)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--branch requires a value."
        default_branch="$1"
        ;;
      --message)
        shift
        [[ $# -gt 0 ]] || fail_git_operation "--message requires a value."
        commit_message="$1"
        ;;
      --no-commit)
        create_commit="false"
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

validate_branch_name() {
  if ! git check-ref-format --branch "$default_branch" >/dev/null 2>&1; then
    fail_git_operation "Invalid branch name: $default_branch"
  fi
}

validate_repository_safety() {
  local required_ignored_path
  local forbidden_pattern
  local tracked_path
  local forbidden_patterns=(
    '.env'
    '.env.*'
    '*/.env'
    '*/.env.*'
    '*.tfstate'
    '*.tfstate.*'
    '*.tfplan'
    'terraform.tfvars'
    '*.auto.tfvars'
    '*.pem'
    '*.key'
    '*.p12'
    '*.pfx'
    '*.token'
    '*.secret'
    '*.credentials'
    'credentials.json'
    'secrets.json'
    '.aws/*'
    '.deploy/*'
    'node_modules/*'
    'dist/*'
    '*.gguf'
    '*.safetensors'
  )

  for required_ignored_path in '.env.deploy' '.deploy/openmodel-aws.tfplan' 'terraform.tfvars' 'apps/cloud/wrangler.production.generated.json'; do
    if ! git -C "$repository_root_directory" check-ignore -q "$required_ignored_path"; then
      fail_git_operation "Required sensitive path is not ignored by Git: $required_ignored_path"
    fi
  done

  while IFS= read -r -d '' tracked_path; do
    for forbidden_pattern in "${forbidden_patterns[@]}"; do
      if [[ "$tracked_path" == $forbidden_pattern ]]; then
        if [[ "$tracked_path" == '.env.example' || "$tracked_path" == '.env.deploy.example' || "$tracked_path" == 'env.deploy.example' || "$tracked_path" == */.env.example || "$tracked_path" == */.env.*.example || "$tracked_path" == *.tfvars.example ]]; then
          continue
        fi
        fail_git_operation "A sensitive or generated file is staged or tracked: $tracked_path"
      fi
    done
  done < <(git -C "$repository_root_directory" ls-files -z --cached --others --exclude-standard)
}

main() {
  parse_arguments "$@"
  require_command git
  cd "$repository_root_directory"

  if [[ ! -d .git ]]; then
    git init -b "$default_branch" >/dev/null 2>&1 || {
      git init >/dev/null
      git symbolic-ref HEAD "refs/heads/$default_branch"
    }
  fi

  validate_branch_name
  validate_repository_safety
  git add --all
  validate_repository_safety

  if git diff --cached --quiet; then
    printf 'Git repository is initialized and there are no staged changes.\n'
    exit 0
  fi

  if [[ "$create_commit" == "false" ]]; then
    printf 'Git repository initialized on %s with changes staged.\n' "$default_branch"
    exit 0
  fi

  if [[ -z "$(git config user.name || true)" || -z "$(git config user.email || true)" ]]; then
    fail_git_operation "Configure git user.name and user.email before creating the initial commit."
  fi

  git commit -m "$commit_message"
  printf 'Git repository initialized and committed on branch %s.\n' "$default_branch"
}

main "$@"
