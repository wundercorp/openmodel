# Releasing OpenModel

OpenModel includes a workspace-aware semantic version incrementer and a one-shot npm release command.

## Version rules

The default target is the CLI package:

```bash
npm run version:bump
```

That performs a patch increment of `@wundercorp/openmodel` and updates `package-lock.json`.

Available increment types:

```bash
npm run version:bump -- patch
npm run version:bump -- minor
npm run version:bump -- major
npm run version:bump -- prerelease --preid beta
```

Available package selections:

```bash
npm run version:bump -- patch --package cli
npm run version:bump -- patch --package sdk
npm run version:bump -- patch --package all
```

Selecting `sdk` increments the gateway SDK and automatically increments the CLI because the CLI contains an exact dependency on the SDK version. Selecting `all` applies the requested increment to both packages.

Preview without writing files:

```bash
npm run version:bump -- patch --package cli --dry-run
```

## One-shot release

Run a safe CLI patch release locally:

```bash
./release.sh patch \
  --package cli \
  --commit \
  --push \
  --publish \
  --tag \
  --yes
```

The command:

1. Requires a clean Git worktree.
2. Updates package manifests and `package-lock.json`.
3. Runs checks, tests, and npm publication dry runs.
4. Commits the release files.
5. Pushes the release commit when requested.
6. Publishes only npm versions that do not already exist.
7. Creates and pushes `v<CLI version>` when requested.

The npm login must already be configured:

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

## SDK release

A gateway SDK patch release automatically gives the CLI its own patch release and updates the exact dependency:

```bash
./release.sh patch \
  --package sdk \
  --commit \
  --push \
  --publish \
  --tag \
  --yes
```

## Prerelease

```bash
./release.sh prerelease \
  --package all \
  --preid beta \
  --dist-tag beta \
  --commit \
  --push \
  --publish \
  --tag \
  --yes
```

A stable version such as `0.2.0` becomes `0.2.1-beta.0`. Repeating the command increments the prerelease suffix to `beta.1`, `beta.2`, and so on.

## GitHub tag publication

Pushing a tag such as `v0.1.2` starts `.github/workflows/release-npm.yml`. The workflow verifies that the tag matches the CLI package version and skips package versions that already exist. This makes a tag pushed after a local publication safe and idempotent.

To let GitHub perform the npm publication instead of publishing locally:

```bash
./release.sh patch \
  --package cli \
  --commit \
  --push \
  --tag \
  --yes
```

Configure either npm trusted publishing or `NPM_TOKEN` in the GitHub `npm` environment before using tag-driven publication.

## Separate deployment

Package release and infrastructure deployment remain separate:

```bash
./release.sh patch --package cli --commit --push --publish --tag --yes
./deploy.sh --yes
```

Publishing npm packages does not require redeploying the website, and deploying the website does not increment package versions.
