#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repository_root"

rm -f .github/workflows/release.yml

printf 'Removed the accidental Changesets release workflow.\n'
printf 'OpenModel now uses .github/workflows/ci.yml and .github/workflows/release-npm.yml.\n'
printf 'Run npm ci && npm run ci before committing.\n'
