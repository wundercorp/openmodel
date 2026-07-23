#!/usr/bin/env bash
set -Eeuo pipefail

for base_url in "${OPENMODEL_CLOUD_API_URL:-https://api.openmodel.sh}" "${OPENMODEL_CLOUD_API_FALLBACK_URL:-https://api.walton.bot}"; do
  base_url="${base_url%/}"
  printf '\nChecking %s\n' "$base_url"
  curl --fail --silent --show-error "$base_url/health"
  printf '\n'
  curl --fail --silent --show-error "$base_url/v1/capacity/gpu"
  printf '\n'
done
