# GPU capacity

OpenModel provides a provider marketplace and hyperscaler control plane for selling GPU time. The Walton mobile app does not create or manage provider capacity.

## Fast provider setup

```bash
om login
om provider enroll --endpoint https://worker.example.com
om provider agent --interval-seconds 30
om capacity expose --node-id <node-id> --price-hour 0.75
```

The provider agent sends outbound heartbeats and pulls assignments with a node-scoped token. It does not expose host credentials or automatically execute buyer-provided commands.

## Provider operations

```bash
om provider nodes
om provider assignments
om provider accept <reservation-id>
om provider start <reservation-id>
om provider usage <reservation-id> --sequence 1 --billable-seconds 300
om provider complete <reservation-id> --sequence 2 --billable-seconds 3600
om provider earnings
om provider payout-profile --method STRIPE_CONNECT --destination-reference acct_123
om provider payout --currency USD
```

Use `om provider drain` before maintenance. Disable is rejected while active assignments remain.

## API groups

Public inventory:

- `GET /v1/capacity/gpu`

Authenticated provider users:

- `GET|POST /v1/provider/nodes`
- `GET /v1/provider/nodes/{nodeId}`
- `POST /v1/provider/nodes/{nodeId}/rotate-token|enable|drain|disable`
- `GET /v1/provider/reservations`
- `GET /v1/provider/earnings`
- `GET|PUT /v1/provider/payout-profile`
- `GET|POST /v1/provider/payouts`
- existing listing routes under `/v1/capacity/gpu`

Node-scoped worker control:

- `POST /v1/provider/nodes/{nodeId}/heartbeat`
- `GET /v1/provider/nodes/{nodeId}/assignments`
- `POST /v1/provider/nodes/{nodeId}/assignments/{reservationId}/accept|start|usage|complete|fail`

Hyperscaler master:

- `GET|POST /v1/hyperscaler/reservations`
- `GET /v1/hyperscaler/reservations/{reservationId}`
- `POST /v1/hyperscaler/reservations/{reservationId}/cancel|expire|dispute`
- `POST /v1/hyperscaler/reservations/sweep`
- `GET /v1/hyperscaler/payouts`
- `POST /v1/hyperscaler/payouts/{payoutId}/processing|paid|failed`
- `POST /v1/hyperscaler/payout-profiles/{providerId}/verify|reject`

## Storage and consistency

AWS uses `GPU_CAPACITY_TABLE` and DynamoDB transactions for reservation, release, earning, and payout mutations. The table needs a string partition key named `id`.

Cloudflare uses `GPU_CAPACITY_REGISTRY` KV. Transactional allocation and payout writes fail closed by default because KV cannot guarantee atomic capacity accounting. See `docs/gpu-provider-marketplace.md` before enabling the development-only override.

## API aliases

`https://api.openmodel.sh` is canonical and `https://api.walton.bot` is the fallback. Both must route to the same deployment and identity contract.

For the complete state machines, security boundary, payment semantics, deployment values, and edge cases, see [GPU provider marketplace and hyperscaler control plane](gpu-provider-marketplace.md).
