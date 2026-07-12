# Integrating `@wundercorp/baseui` in OpenModel

## Installation

The web workspace declares the package directly:

```json
{
  "dependencies": {
    "@wundercorp/baseui": "^0.1.0"
  }
}
```

Install from the monorepo root so npm updates the shared workspace lockfile:

```bash
npm install
```

## Global stylesheet

Import the complete stylesheet once at the web entry point, before application-specific CSS:

```tsx
import "@wundercorp/baseui/styles.css";
import "./styles.css";
import "./dashboard.css";
```

This ordering allows OpenModel to compose layout-specific rules while retaining the component library's state, accessibility, and token behavior.

## Shared primitive boundary

Application code should import common primitives from `apps/web/src/components/ui.tsx`:

```tsx
import { Badge, Button, Card, CodeBlock, Icon } from "./components/ui";
```

That file re-exports the public package API and provides one migration boundary if component usage changes later.

For larger catalogue or workflow surfaces, importing directly from the package is appropriate:

```tsx
import {
  BaseUIProvider,
  Field,
  Input,
  MetricCard,
  PageHeader,
  Stack,
} from "@wundercorp/baseui";
```

## Icons

Use semantic icons for product concepts:

```tsx
import { Icon } from "@wundercorp/baseui";

<Icon name="dashboard" size={20} />
```

Use the Phosphor passthrough entry point for brand or domain-specific icons that are not part of the semantic registry:

```tsx
import { PhosphorIcon } from "@wundercorp/baseui";
import { GithubLogoIcon } from "@wundercorp/baseui/phosphor";

<PhosphorIcon icon={GithubLogoIcon} label="GitHub" />
```

## Theming boundary

The marketing home page keeps its existing terminal-inspired theme. Dashboard and authentication routes opt into baseui.sh by applying `.bui-root`, `data-bui-theme`, and their route-specific classes.

Do not place `.bui-root` around the entire website unless the marketing page is intentionally migrated too.

## Updating the package

Review available versions:

```bash
npm view @wundercorp/baseui version
```

Update the web workspace and run the integration checks:

```bash
npm install @wundercorp/baseui@latest --workspace @wundercorp/openmodel-web
npm run check --workspace @wundercorp/openmodel-web
npm run build --workspace @wundercorp/openmodel-web
```

Commit both `apps/web/package.json` and the root `package-lock.json`.
