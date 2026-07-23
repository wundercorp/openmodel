# GPU capacity

OpenModel is the provider-facing home for Walton GPU capacity. The Walton mobile app no longer creates or manages capacity listings.

## Provider workflow

1. Install the CLI and run `om login`.
2. Start a reachable OpenModel-compatible inference or workload endpoint.
3. Run `om capacity expose --price-hour <usd> --endpoint <https-url>`.
4. Keep availability current with `om capacity heartbeat`.
5. Use the GPU Capacity dashboard to inspect, publish, or pause listings.

The listing is coordination metadata. OpenModel does not open firewall ports, change router configuration, or proxy provider inference traffic. The provider controls the endpoint and access policy.

## Buyer workflow

Published listings are visible in the OpenModel dashboard and from `GET /v1/capacity/gpu`. A listing may include a provider checkout URL or a provider-controlled endpoint. Purchase/session orchestration can be layered onto this contract without moving provider network credentials into Walton mobile.

## API

Public:

- `GET /v1/capacity/gpu`

Authenticated provider operations:

- `GET /v1/capacity/gpu/mine`
- `POST /v1/capacity/gpu`
- `GET /v1/capacity/gpu/{id}`
- `PUT /v1/capacity/gpu/{id}`
- `POST /v1/capacity/gpu/{id}/publish`
- `POST /v1/capacity/gpu/{id}/pause`
- `POST /v1/capacity/gpu/{id}/heartbeat`

## Storage

AWS Lambda uses `GPU_CAPACITY_TABLE` (or the compatibility fallback `CAPACITY_TABLE`). The table needs a string primary key named `id`, and the Lambda role needs Scan and PutItem permissions.

Cloudflare Worker uses the `GPU_CAPACITY_REGISTRY` KV binding.

## API aliases

The source treats `https://api.openmodel.sh` as canonical and `https://api.walton.bot` as a fallback. DNS/custom-domain configuration must route both names to the same API deployment. This repository cannot create a Walton DNS record unless the corresponding hosted zone/account is included in the deployment infrastructure.
