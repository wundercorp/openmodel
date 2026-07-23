#!/usr/bin/env bash
set -Eeuo pipefail
repository_root_directory="$(cd "$(dirname "$0")" && pwd)"
exec bash "$repository_root_directory/scripts/release.sh" "$@"
