# OpenModel release workflow correction

The Changesets-based `.github/workflows/release.yml` belongs to the standalone BaseUI repository and must not be used in OpenModel.

Remove it from the OpenModel repository:

```bash
rm -f .github/workflows/release.yml
```

Keep these OpenModel workflows instead:

- `.github/workflows/ci.yml`
- `.github/workflows/release-npm.yml`

OpenModel releases npm packages only from version tags such as `v0.1.15`. The tag must equal the version in `apps/cli/package.json`.

Before pushing a release tag:

```bash
npm ci
npm run ci
npm run release:dry-run
npm run release:verify-cli
```

Create and push a release with the existing helper:

```bash
./release.sh patch --package cli --commit --push --tag --yes
```

The `npm` GitHub environment must have npm trusted publishing configured for this repository, or the workflow must be adapted to use an npm token.
