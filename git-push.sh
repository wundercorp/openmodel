#!/usr/bin/env bash
set -Eeuo pipefail
repository_root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$repository_root_directory/scripts/git-push.sh" "$@"
