# Contributing

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Run the CLI directly:

```bash
node apps/cli/bin/om.mjs gateways
node apps/cli/bin/om.mjs doctor
```

Run the website and cloud API:

```bash
npm run dev:web
npm run dev:cloud
```

## Adding a gateway

Copy `gateways/example-gateway`, choose a globally unique gateway ID, implement the gateway SDK contract, add tests, and document the reference schemes the gateway accepts.

A gateway contribution should not modify CLI command code. It should expose a package entry point, declare an `openmodel` manifest in `package.json`, and return normalized model descriptors from `resolve`.

Required gateway properties:

- Stable `id`, `name`, and `apiVersion`
- Explicit `schemes` and `capabilities`
- Deterministic `canHandle` behavior
- Safe URL and header handling
- Abort-signal support for network operations
- No credential logging
- Tests for valid and invalid references

Third-party packages can be registered with:

```bash
om gateway add @scope/openmodel-gateway-example
```

## Pull requests

Keep generated output, release archives, model weights, credentials, local state, Terraform state, and Wrangler state out of commits. Add tests for behavior changes and include a concise migration note for gateway contract changes.
