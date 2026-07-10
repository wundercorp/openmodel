#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bump_type="patch"
package_selection="cli"
prerelease_identifier="beta"
distribution_tag="latest"
run_commit="false"
run_tag="false"
run_push="false"
run_publish="false"
run_provenance="false"
skip_validation="false"
dry_run="false"
automatically_confirm="false"

print_usage() {
  cat <<'USAGE'
Usage: ./release.sh [patch|minor|major|prerelease] [options]

Options:
  --package cli|sdk|all  Package selection. Default: cli.
  --preid NAME           Prerelease identifier. Default: beta.
  --dist-tag NAME        npm distribution tag. Default: latest.
  --commit               Commit the version changes.
  --tag                  Create v<CLI version> after publication.
  --push                 Push the release commit and optional tag.
  --publish              Publish unpublished npm package versions.
  --provenance           Request npm provenance during publication.
  --skip-validation      Skip source checks, tests, and publish dry runs.
  --dry-run              Show the version changes without modifying files.
  --yes                  Skip the release confirmation prompt.
  --help                 Show this help text.

Examples:
  ./release.sh patch
  ./release.sh minor --package cli --commit
  ./release.sh patch --package sdk --commit --push --publish --tag --yes
  ./release.sh prerelease --preid beta --package all --commit --publish --yes
USAGE
}

fail_release() {
  printf 'Release failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail_release "Required command '$1' was not found."
}

parse_arguments() {
  local positional_bump_type_set="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      patch|minor|major|prerelease)
        if [[ "$positional_bump_type_set" == "true" ]]; then
          fail_release "Only one version bump type may be provided."
        fi
        bump_type="$1"
        positional_bump_type_set="true"
        ;;
      --package)
        shift
        [[ $# -gt 0 ]] || fail_release "--package requires cli, sdk, or all."
        package_selection="$1"
        ;;
      --preid)
        shift
        [[ $# -gt 0 ]] || fail_release "--preid requires a value."
        prerelease_identifier="$1"
        ;;
      --dist-tag)
        shift
        [[ $# -gt 0 ]] || fail_release "--dist-tag requires a value."
        distribution_tag="$1"
        ;;
      --commit)
        run_commit="true"
        ;;
      --tag)
        run_tag="true"
        ;;
      --push)
        run_push="true"
        ;;
      --publish)
        run_publish="true"
        ;;
      --provenance)
        run_provenance="true"
        ;;
      --skip-validation)
        skip_validation="true"
        ;;
      --dry-run)
        dry_run="true"
        ;;
      --yes)
        automatically_confirm="true"
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        fail_release "Unknown option: $1"
        ;;
    esac
    shift
  done
}

validate_release_configuration() {
  [[ "$package_selection" == "cli" || "$package_selection" == "sdk" || "$package_selection" == "all" ]] || fail_release "--package must be cli, sdk, or all."
  [[ "$prerelease_identifier" =~ ^[0-9A-Za-z-]+$ ]] || fail_release "--preid contains unsupported characters."
  [[ "$distribution_tag" =~ ^[A-Za-z][A-Za-z0-9._-]*$ ]] || fail_release "--dist-tag is invalid."

  if [[ "$run_tag" == "true" || "$run_push" == "true" || "$run_publish" == "true" ]]; then
    [[ "$run_commit" == "true" ]] || fail_release "--tag, --push, and --publish require --commit so released source is recorded."
  fi

  if [[ "$dry_run" == "true" && ( "$run_commit" == "true" || "$run_tag" == "true" || "$run_push" == "true" || "$run_publish" == "true" ) ]]; then
    fail_release "--dry-run cannot be combined with commit, tag, push, or publish operations."
  fi
}

validate_git_state() {
  if [[ "$run_commit" != "true" ]]; then
    return
  fi

  require_command git
  git -C "$repository_root_directory" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail_release "The repository is not initialized with Git."
  [[ -z "$(git -C "$repository_root_directory" status --porcelain)" ]] || fail_release "Commit or stash existing changes before running a one-shot release."
  [[ -n "$(git -C "$repository_root_directory" branch --show-current)" ]] || fail_release "A release cannot be created from a detached HEAD."
}

confirm_release() {
  if [[ "$automatically_confirm" == "true" || "$dry_run" == "true" ]]; then
    return
  fi

  if [[ "$run_commit" != "true" && "$run_publish" != "true" && "$run_push" != "true" && "$run_tag" != "true" ]]; then
    return
  fi

  printf 'Release %s bump for %s. Type release to continue: ' "$bump_type" "$package_selection"
  local confirmation_value
  read -r confirmation_value
  [[ "$confirmation_value" == "release" ]] || fail_release "Release confirmation was not provided."
}

run_validation() {
  if [[ "$skip_validation" == "true" ]]; then
    return
  fi

  npm --prefix "$repository_root_directory" run check
  npm --prefix "$repository_root_directory" test
  npm --prefix "$repository_root_directory" run release:dry-run
}

commit_release() {
  if [[ "$run_commit" != "true" ]]; then
    return
  fi

  local cli_version
  local gateway_sdk_version
  cli_version="$(node -p "require('$repository_root_directory/apps/cli/package.json').version")"
  gateway_sdk_version="$(node -p "require('$repository_root_directory/packages/gateway-sdk/package.json').version")"

  git -C "$repository_root_directory" add \
    apps/cli/package.json \
    packages/gateway-sdk/package.json \
    package-lock.json
  git -C "$repository_root_directory" commit -m "Release OpenModel $cli_version" -m "Gateway SDK: $gateway_sdk_version"
}

push_release_commit() {
  if [[ "$run_push" != "true" ]]; then
    return
  fi

  local current_branch
  current_branch="$(git -C "$repository_root_directory" branch --show-current)"
  git -C "$repository_root_directory" push origin "$current_branch"
}

publish_release() {
  if [[ "$run_publish" != "true" ]]; then
    return
  fi

  local publish_arguments=(--tag "$distribution_tag")
  if [[ "$run_provenance" == "true" ]]; then
    publish_arguments+=(--provenance)
  fi

  node "$repository_root_directory/scripts/publish-npm.mjs" "${publish_arguments[@]}"
}

create_release_tag() {
  if [[ "$run_tag" != "true" ]]; then
    return
  fi

  local cli_version
  local release_tag
  cli_version="$(node -p "require('$repository_root_directory/apps/cli/package.json').version")"
  release_tag="v$cli_version"

  if git -C "$repository_root_directory" rev-parse "$release_tag" >/dev/null 2>&1; then
    fail_release "Git tag $release_tag already exists."
  fi

  git -C "$repository_root_directory" tag -a "$release_tag" -m "OpenModel $cli_version"

  if [[ "$run_push" == "true" ]]; then
    git -C "$repository_root_directory" push origin "$release_tag"
  fi
}

main() {
  parse_arguments "$@"
  validate_release_configuration
  require_command node
  require_command npm
  validate_git_state
  confirm_release

  local bump_arguments=("$bump_type" --package "$package_selection" --preid "$prerelease_identifier")
  if [[ "$dry_run" == "true" ]]; then
    bump_arguments+=(--dry-run)
  fi

  node "$repository_root_directory/scripts/version-bump.mjs" "${bump_arguments[@]}"

  if [[ "$dry_run" == "true" ]]; then
    exit 0
  fi

  run_validation
  commit_release
  push_release_commit
  publish_release
  create_release_tag

  printf 'Release completed.\n'
}

main "$@"
