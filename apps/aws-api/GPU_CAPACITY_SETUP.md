# AWS GPU provider marketplace setup

The AWS Lambda API is the authoritative hyperscaler master because DynamoDB transactions prevent a physical worker or listing from being sold twice.

## Storage

Create or reuse a DynamoDB table with a string partition key named `id`, then expose its name as `GPU_CAPACITY_TABLE`.

The same table stores provider nodes, listings, reservations, earnings, payout profiles, and payouts. Record types are separated by the `recordType` field.

The Lambda execution role needs these table actions:

- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:Scan`
- `dynamodb:TransactWriteItems`

Point-in-time recovery, server-side encryption, deletion protection, and continuous backups are strongly recommended because settlement records affect provider balances.

## Identity and master authorization

Set `AUTH_AUDIENCE` to a comma-separated list containing the web and CLI Cognito app client IDs. The CLI token `client_id` must be accepted or provider commands return HTTP 401.

Authorize trusted hyperscaler operators with at least one of:

- the `capacity:master` permission or scope;
- the `capacity-masters` or `hyperscalers` Cognito group;
- a subject listed in `HYPERSCALER_SUBJECTS`.

Settlement operators also need `capacity:settle`, unless they already carry `capacity:master`.

## Capacity policy

Configure:

```dotenv
CAPACITY_HEARTBEAT_MAX_AGE_SECONDS="120"
CAPACITY_ASSIGNMENT_TIMEOUT_SECONDS="300"
CAPACITY_EARNINGS_HOLD_SECONDS="604800"
CAPACITY_MINIMUM_PAYOUT_AMOUNT="25"
CAPACITY_PLATFORM_FEE_BPS="1000"
HYPERSCALER_SUBJECTS="trusted-cognito-subject-1,trusted-cognito-subject-2"
```

The platform fee is snapshotted by the master when a reservation is created. Providers cannot override it. Payout destinations must be processor-issued tokens or account references, never raw card, bank, password, private-key, or API-token data.

## Domains

The handler is hostname-neutral. Attach `api.openmodel.sh` and `api.walton.bot` to the same API Gateway stage, or point the alias to the canonical domain through the DNS/CDN provider.
