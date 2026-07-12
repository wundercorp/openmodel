# Dashboard design language

## Scope

The dashboard, sign-in flow, authentication callback, and public local-metrics view use this system. The marketing home page continues to use the existing terminal-inspired presentation.

## Design direction

The dashboard uses a restrained Swiss product language: clear hierarchy, neutral surfaces, strong left alignment, a consistent grid, minimal decoration, and one functional red accent. Product data and actions are the visual focus.

## Core rules

- One radius across the interface: 4px.
- One dashboard accent: restrained red.
- Sans-serif typography for navigation, headings, controls, descriptions, and data labels.
- Monospace typography only for commands, URLs, model identifiers, and machine-readable values.
- One-pixel borders define structure. Shadows are reserved for floating menus and authentication panels.
- Cards do not use decorative corner marks, neon glows, scanlines, offset shadows, or grid textures.
- Uppercase is limited to compact eyebrows, statuses, and table headers.
- Page headings and action labels use sentence case.
- Status color is supplementary; labels remain readable without color.

## Tokens

### Light

- Background: `#f4f4f1`
- Surface: `#ffffff`
- Muted surface: `#f8f8f6`
- Strong muted surface: `#efefeb`
- Primary text: `#171716`
- Secondary text: `#595955`
- Tertiary text: `#7a7a74`
- Border: `#deded8`
- Strong border: `#c5c5bd`
- Accent: `#d42d24`

### Dark

- Background: `#121310`
- Surface: `#191a17`
- Muted surface: `#1f201d`
- Strong muted surface: `#272823`
- Primary text: `#f1f1ec`
- Secondary text: `#b2b2aa`
- Tertiary text: `#8e8e86`
- Border: `#32332e`
- Strong border: `#494a43`
- Accent: `#ef6259`

### Semantic

- Success: green
- Warning: amber
- Danger: red
- Information: blue

Semantic colors use quiet tinted backgrounds and readable text rather than glows.

## Typography

- Interface family: Inter, Helvetica Neue, Helvetica, Arial, system sans-serif.
- Code family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace.
- Page titles: 42–77px responsive, 690 weight, tight tracking.
- Section titles: 34–58px responsive, 690 weight.
- Card titles: 22–32px responsive, 670 weight.
- Body: 13–15px, 1.6–1.65 line height.
- Labels: 10–11px, 650–700 weight, restrained uppercase tracking.

## Layout

- Sidebar: 252px desktop, 72px collapsed.
- Top bar: 64px.
- Main content: 1240px maximum width.
- Desktop page gutter: 32px.
- Mobile page gutter: 14px.
- Primary layout spacing: 12px between related panels, 30–64px between page regions.
- Four-column data grids reduce to two columns, then one column.

## Components

### Navigation

The active item uses a soft red background and red icon/text. Inactive items use neutral secondary text. The dashboard accent selector is intentionally removed from the dashboard because a single accent strengthens hierarchy and consistency.

### Buttons

Primary buttons use solid red. Secondary and ghost buttons use a neutral surface and border. Hover movement is limited to one pixel. Disabled actions remain visible but lose emphasis.

### Cards

Cards use one-pixel borders, white or dark-neutral surfaces, and no decorative corner graphics. Standard panels have no elevation. Hoverable action cards receive subtle elevation only on hover.

### Forms

Inputs and selects are 40px high with clear focus rings. URLs and technical identifiers use the monospace family. Labels remain sans-serif.

### Tables

Headers use muted surfaces and compact uppercase labels. Rows use quiet separators and neutral hover states. Selected model rows use a soft red background and a three-pixel red inset marker.

### Status

Status indicators use square 4px-radius marks. Success, warning, and error states combine text, border, and background changes so meaning does not depend on color alone.

### Commands

Commands remain monospace, but are contained within neutral surfaces. Copy actions use the normal interface button treatment rather than terminal controls.

### Tabs

Tabs form a bordered strip with separators. The active tab uses a soft accent background and bottom indicator. Tabs stack vertically on small screens.

## Route coverage

- Sign in
- Authentication callback
- Overview
- Models
- BuilderStudio resources
- Doku resources
- Metrics overview
- Performance metrics
- External usage
- Usage and pricing
- Cloud session metrics
- Gateways
- Account
- Public local metrics

## Accessibility

- Visible two-pixel focus rings.
- Reduced-motion support.
- Responsive table restructuring on mobile.
- Text labels accompany all semantic colors.
- Minimum 40px primary control height.
- High-contrast dark and light token sets.
