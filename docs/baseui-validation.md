# baseui.sh integration validation

## Dependency boundary

- Package: `@wundercorp/baseui` version range `^0.1.0`
- Source: public npm registry
- Repository: `https://github.com/wundercorp/baseui`
- The OpenModel repository does not contain a local baseui.sh workspace package.
- React and React DOM remain application dependencies and satisfy the library peer range.
- Phosphor is supplied transitively by the component library.

## Application integration

- `apps/web/src/main.tsx` imports `@wundercorp/baseui/styles.css` once.
- `apps/web/src/components/ui.tsx` re-exports the shared product primitives from the npm package.
- Dashboard semantic variables resolve to baseui.sh CSS tokens.
- Dashboard and authentication surfaces are isolated through `.bui-root` and dashboard route classes.
- The marketing home page remains on its existing visual system.
- The `/baseui` route renders the package catalogue from the installed dependency.
- Dashboard navigation uses the semantic icon registry.
- Social actions use the package's tree-shakeable Phosphor passthrough entry point.

## Validation performed

The integration was checked with the package installed at the real `node_modules/@wundercorp/baseui` path:

```bash
tsc -b apps/web/tsconfig.json --pretty false
vite build
node scripts/validate-package-lock-registry.mjs
```

The web TypeScript build and production bundle completed successfully. The lockfile registry validator confirmed that all resolved package URLs use the public npm registry.

## Design invariants

- Standard component surfaces use the shared 4px radius token.
- Intrinsically circular indicators, including spinners, use the library's circular geometry token.
- Monospace typography is reserved for code, identifiers, commands, and measured values.
- Dashboard accent usage is limited to primary actions, focus, active navigation, and meaningful status.
- Product code should consume semantic component props and tokens rather than overriding internal `bui-*` selectors.
