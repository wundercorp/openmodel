# Pricing and metering integration

OpenModel measures usage locally and Wundership owns effective-dated provider pricing, free-tier accounting, idempotent usage ingestion, and future billing.

## Website dashboard

Dashboard > Metrics includes a Usage & Pricing section that:

- keeps local token, latency, throughput, per-model, and recent-request metrics available without authentication
- loads active provider/model/region/service-tier choices from `GET /openmodel/v1/pricing/catalog`
- reads the authenticated monthly allowance from `GET /openmodel/v1/usage/summary`
- estimates provider cost through `POST /openmodel/v1/pricing/estimate`
- reads input/output token rates directly from the active pricing catalog, avoiding extra estimate calls
- compares local provider charges with estimated cloud-provider charges
- renders rolling day/week/month cumulative usage and cost charts plus hourly/daily token-cost buckets
- synchronizes successful local request token counts through `POST /openmodel/v1/usage/events`
- uses stable browser-generated idempotency keys so repeated synchronization does not duplicate usage

The browser sends token counts, occurrence time, provider/model mapping, source, and an idempotency key. Prompt text, response text, model weights, latency, and runtime details remain local.

Browser configuration:

```text
VITE_WUNDERSHIP_API_URL=https://api.wundership.com/openmodel/v1
```

Deployment configuration:

```text
OPENMODEL_WUNDERSHIP_API_URL=https://api.wundership.com/openmodel/v1
```

The Wundership API CORS/origin configuration must include `https://openmodel.sh` and optionally `https://www.openmodel.sh` and `http://localhost:5173` for local browser development.

## CLI

Configure `OPENMODEL_PRICING_API_URL` and authenticate with `om login`.

```bash
om pricing example-provider example-family-v2 --input-tokens 1000000 --output-tokens 250000
om usage summary
om usage sync
```

## API

```text
GET  /openmodel/v1/pricing/catalog
POST /openmodel/v1/pricing/estimate
POST /openmodel/v1/usage/events
GET  /openmodel/v1/usage/summary
POST /openmodel/v1/admin/pricing/refresh
```

The monthly allowance defaults to 10,000,000 cost-weighted allowance units. With the default reference price of $1 per million tokens, the allowance represents a nominal $10 monthly provider-cost budget. Cheaper models consume fewer allowance units per raw token, while expensive models consume more and begin metering earlier. Pricing feeds use a provider-neutral HTTPS JSON format and support exact or wildcard model-family entries.

The authenticated dashboard uses the non-MPP endpoints. Machine clients may purchase a pricing estimate through `POST /mpp/openmodel/pricing/estimate`, which defaults to $0.01 per request and uses the same cost-weighted policy.

The root-level `/openmodel/v1` prefix is canonical. `/api/openmodel/v1` remains a compatibility alias on Wundership deployments that keep `ApiPrefixAliasFilter` enabled.
