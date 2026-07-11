# Usage and pricing dashboard

The OpenModel Metrics route combines local-only inference telemetry with authenticated pricing and monthly allowance data from Wundership.

## Local mode

`/dashboard?view=metrics` is available without authentication. It connects directly to the local OpenModel service and continues to show:

- prompt, completion, and total token estimates
- request counts and status
- latency and completion tokens per second
- per-model runtime usage
- recent local requests
- local usage-over-time charts

Prompt text, response text, model files, latency details, and runtime details are not sent to Wundership.

## Authenticated pricing mode

After sign-in, the page calls the configured Wundership API:

```text
GET  /openmodel/v1/pricing/catalog
POST /openmodel/v1/pricing/estimate
POST /openmodel/v1/usage/events
GET  /openmodel/v1/usage/summary
```

The provider profile uses catalog-backed, filterable selections rather than arbitrary provider/model text. The usage charts support rolling day, week, and month ranges.

The dashboard displays the monthly 10,000,000-unit cost-weighted allowance returned by the API, raw monthly tokens, the selected model's allowance multiplier and effective raw-token cap, provider cost estimates, billable tokens and cost, provider/model pricing details, and local-versus-cloud comparisons. Cheap models receive more experimentation room; expensive models begin metering earlier.

Successful local requests can be synchronized manually. Each event includes token counts, occurrence time, provider/model mapping, and a stable idempotency key. The browser stores synchronized keys locally so the same local request is not intentionally submitted again.

## Configuration

Website build variable:

```text
VITE_WUNDERSHIP_API_URL=https://api.wundership.com/openmodel/v1
```

Deployment wrapper variable:

```text
OPENMODEL_WUNDERSHIP_API_URL=https://api.wundership.com/openmodel/v1
```

The Wundership API origin allowlist must include:

```text
https://openmodel.sh
https://www.openmodel.sh
http://localhost:5173
```

The localhost origin is for browser development and can be omitted from a production-only allowlist.

## Documentation automation

The root build and release flow regenerate Doku artifacts:

```bash
npm run docs:update
npm run docs:open
```

`npm run build` runs all workspace builds and then regenerates `docs.json`, `llms-full.txt`, and `doku.docs.json`.

## Deployment

After the API allowlist and production environment variables are configured, rebuild and deploy with:

```bash
./deploy.sh --yes
```
