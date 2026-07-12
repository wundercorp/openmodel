#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

echo "Current workflows:"
find .github/workflows -maxdepth 1 -type f -print | sort

if [ -f ".github/workflows/release.yml" ]; then
  cp ".github/workflows/release.yml" "/tmp/openmodel-accidental-release.yml"
  rm ".github/workflows/release.yml"

  echo
  echo "Removed the accidental push-triggered release workflow."
  echo "Backup: /tmp/openmodel-accidental-release.yml"
fi

python3 <<'PY'
import re
from pathlib import Path

node_version = "22.14.0"

for workflow_path in Path(".github/workflows").glob("*.y*ml"):
    content = workflow_path.read_text(encoding="utf-8")

    if "actions/setup-node@" not in content:
        continue

    content = re.sub(
        r'(?m)^(\s*)node-version-file:\s*.*$',
        rf'\1node-version: "{node_version}"',
        content,
    )

    content = re.sub(
        r'(?m)^(\s*)node-version:\s*.*$',
        rf'\1node-version: "{node_version}"',
        content,
    )

    workflow_path.write_text(content, encoding="utf-8")
    print(f"Updated Node version in {workflow_path}")
PY

printf '22.14.0\n' > .nvmrc
printf '22.14.0\n' > .node-version

echo
echo "Remaining workflows:"
find .github/workflows -maxdepth 1 -type f -print | sort

echo
echo "Node configurations:"
grep -R \
  --line-number \
  -E 'node-version|node-version-file' \
  .github/workflows || true

echo
echo "Changes:"
git status --short
git diff -- .github/workflows .nvmrc .node-version
