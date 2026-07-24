# GPU provider marketplace and hyperscaler control plane

OpenModel supports a master/worker GPU marketplace in which a cloud hyperscaler is the control-plane master and independently operated provider machines are worker nodes. The product UI calls them **provider workers** rather than servants, but the topology is the same: workers advertise health and capacity, pull assignments from the master, meter completed work, and accrue provider earnings.

## Goals

- Let an authenticated OpenModel user register a GPU machine and publish sellable capacity.
- Keep worker credentials, private networking, and host access out of public listings.
- Let a hyperscaler allocate capacity without overbooking a physical node.
- Snapshot price, fee, funding, and workload references when a reservation is created.
- Meter usage monotonically and cap billing at the authorized reservation duration.
- Hold earnings before payout, support disputes, and require a verified tokenized payout destination.
- Make retries idempotent and reject concurrent or invalid state transitions.

This repository implements the marketplace ledger and control plane. It does not itself perform KYC, tax reporting, card authorization, bank transfer, or cryptocurrency custody. `fundingReference`, `destinationReference`, `verificationReference`, and `processorReference` are opaque references issued by the hyperscaler's payment systems. Raw card, bank, wallet private-key, password, or API-secret material must never be stored in these fields.

## Architecture

```text
buyer / scheduler
       |
       | authenticated capacity:master request
       v
hyperscaler master API
  - identity and authorization
  - listings and node registry
  - reservation state machine
  - transactional capacity accounting
  - metering and earnings ledger
  - payout verification and settlement states
       |
       | Node <node-id.secret>
       | outbound heartbeat and assignment polling
       v
provider worker agent
  - GPU detection
  - health and availability reporting
  - explicit assignment acceptance
  - provider-controlled workload execution
  - cumulative usage reporting
```

Provider workers make outbound API requests. Buyers never receive the node token, host credentials, private IP address, or an unallocated endpoint. The master returns endpoint and provider instructions only in the authenticated reservation record.

## Provider lifecycle

### 1. Authenticate and enroll a worker

```bash
om login

om provider enroll \
  --name worker-zurich-1 \
  --gpu-model "NVIDIA RTX 4090" \
  --gpus 1 \
  --vram-gb 24 \
  --endpoint https://worker.example.com \
  --region eu-central
```

When `nvidia-smi` is available, GPU model, count, VRAM, and driver are detected automatically. The master returns a node credential once. The CLI stores it in the OpenModel configuration file with mode `0600`; the API stores only a SHA-256 hash and the last four characters.

Use `--dry-run` to inspect the registration payload without contacting the API.

### 2. Start the provider agent

```bash
om provider agent --interval-seconds 30
```

The agent:

- sends a node-scoped heartbeat;
- reports provider-observed GPU availability;
- pulls active assignments;
- retries transient failures with bounded exponential backoff;
- adds jitter to avoid synchronized polling across a fleet;
- does not execute arbitrary workload commands automatically.

Use `om provider agent --once` for cron, systemd timers, Kubernetes probes, and tests. A production integration should inspect assignments and map the opaque `workloadReference` onto a provider-approved runtime or scheduler.

### 3. Publish capacity linked to the worker

```bash
om capacity expose \
  --node-id <node-id> \
  --price-hour 0.75 \
  --allocation EXCLUSIVE \
  --connection OPENMODEL_API \
  --minimum-hours 1 \
  --max-hours 24 \
  --location "Location shared after purchase"
```

A listing linked to a worker has `managedBy=HYPERSCALER_MASTER`. A legacy listing without `workerNodeId` remains a provider-handoff listing and cannot be allocated by the master reservation API.

### 4. Process assignments explicitly

```bash
om provider assignments
om provider accept <reservation-id> --session-reference provider-session-123
om provider start <reservation-id>
om provider usage <reservation-id> --sequence 1 --billable-seconds 300
om provider complete <reservation-id> --sequence 2 --billable-seconds 3600
```

On failure:

```bash
om provider fail <reservation-id> \
  --failure-code RUNTIME_ERROR \
  --failure-message "Container exited before readiness"
```

The usage sequence must increase. `cumulativeBillableSeconds` may never decrease and may not exceed the reservation's authorized duration. Failed reservations create held earnings for operator review rather than immediately payable earnings.

### 5. Drain for maintenance

```bash
om provider drain
```

A draining node continues heartbeats and may finish existing assignments, but the master will not allocate new work. Disable is rejected while assignments remain active.

```bash
om provider disable
om provider enable
```

### 6. Configure payout and request settlement

The destination must be a processor-issued token or account reference:

```bash
om provider payout-profile \
  --method STRIPE_CONNECT \
  --destination-reference acct_123456 \
  --destination-label "Business account"
```

Changing the payout method or destination resets the profile to `PENDING_VERIFICATION`, even if it was previously verified. A hyperscaler settlement operator verifies or rejects the profile through the master API.

Completed reservation earnings become available after `CAPACITY_EARNINGS_HOLD_SECONDS`. Request the full available balance by omitting `--amount`:

```bash
om provider earnings
om provider payout --currency USD
```

Explicit payout amounts must match whole earning records. This prevents one reservation earning from being split across concurrent payouts without a dedicated sub-ledger.

## Reservation state machine

```text
ASSIGNED -> ACCEPTED -> RUNNING -> COMPLETED
    |          |           |
    |          |           +----> FAILED
    |          +----------------> CANCELLED
    +---------------------------> CANCELLED
    +---------------------------> EXPIRED
COMPLETED / FAILED -------------> DISPUTED
```

Rules:

- `ASSIGNED` expires if the worker does not accept it before `assignmentExpiresAt`.
- The worker may accept only an unexpired assignment belonging to its node.
- Only `ACCEPTED` may start.
- Only `RUNNING` may report usage or complete.
- Capacity is released exactly once on `COMPLETED`, `FAILED`, `CANCELLED`, or `EXPIRED`.
- Disputes hold unpaid earnings. Earnings already included in a payout require manual settlement escalation.
- A client request ID is idempotent per hyperscaler identity. The master derives a deterministic reservation key so concurrent retries cannot create two reservations.

Run an explicit sweep from the master scheduler as a safety net:

```http
POST /v1/hyperscaler/reservations/sweep
```

Node assignment polling also expires stale unaccepted assignments for that node.

## Capacity accounting

Provider-observed capacity and master reservations are tracked separately:

- `reportedAvailableGpuCount`: what the worker reports as locally available;
- `reservedGpuCount`: GPUs reserved by active master assignments;
- `availableGpuCount`: effective allocatable GPUs after reservations.

AWS reservation creation updates the listing, provider node, and reservation in one DynamoDB transaction. Finalization updates the reservation, listing, node, and earning in one transaction. This prevents two listings linked to one physical node from independently selling the same GPU.

Listing fields that affect active contracts—worker node, GPU count, advertised availability, allocation mode, price, and currency—cannot be changed while the listing has active reservations. Price and platform fee are snapshotted on each reservation so later listing changes cannot rewrite completed economics.

## Earnings and payout states

Earnings:

```text
PENDING -> AVAILABLE -> PAYOUT_PENDING -> PAID
                   \-> HELD / REVERSED
```

Payouts:

```text
REQUESTED -> PROCESSING -> PAID
          \-> FAILED
```

A failed payout returns its earning records to `AVAILABLE`. Concurrent payout requests use earning revision checks so the same earning cannot be claimed twice on the AWS transactional backend.

The hyperscaler fee is configured by `CAPACITY_PLATFORM_FEE_BPS` and cannot be overridden by a provider request. The fee, gross authorization, and provider authorization are snapshotted when the reservation is created. Final amounts are derived from metered seconds.

## Authentication and roles

User endpoints use the same bearer access token as `om login` and the dashboard.

A bearer identity is a hyperscaler master when one of these is true:

- it has `capacity:master` permission or scope;
- it belongs to the `hyperscalers` or `capacity-masters` Cognito group;
- its subject appears in `HYPERSCALER_SUBJECTS`.

Settlement routes also accept `capacity:settle`; a deployment may issue this only to payment operations.

Worker endpoints use:

```http
Authorization: Node <node-id>.<secret>
```

Node credentials are scoped to one node. Rotation invalidates the previous credential immediately.

## Public-data boundary

`GET /v1/capacity/gpu` omits:

- worker endpoint URL;
- provider instructions;
- checkout URL;
- exact latitude and longitude;
- node credential hash;
- workload and funding references.

Provider reservation views and node assignment views also omit the buyer payment `fundingReference`; only trusted hyperscaler master identities can read it.

A master-managed listing is omitted entirely when its worker is disabled, draining, unhealthy, or stale. Its public availability is clamped to the lower of listing inventory and effective physical-node availability.

## AWS and Cloudflare consistency

The AWS Lambda/DynamoDB implementation is the authoritative transactional hyperscaler master.

The Cloudflare implementation stores capacity records in KV. KV does not provide the compare-and-swap transactions required to prevent overbooking and double settlement across concurrent requests. Therefore reservation allocation, expiry finalization, and payout mutation fail closed unless:

```text
CAPACITY_ALLOW_EVENTUALLY_CONSISTENT_ALLOCATIONS=true
```

Enabling that flag explicitly accepts overbooking and settlement-race risk. Use it only for development. A production Cloudflare master should replace KV mutation with Durable Objects, D1 transactions, or another strongly consistent coordinator. Public listing and provider-registry reads may still use KV.

## Required configuration

```text
GPU_CAPACITY_TABLE=openmodel-gpu-capacity
HYPERSCALER_SUBJECTS=<comma-separated trusted subject IDs>
CAPACITY_HEARTBEAT_MAX_AGE_SECONDS=120
CAPACITY_ASSIGNMENT_TIMEOUT_SECONDS=300
CAPACITY_EARNINGS_HOLD_SECONDS=604800
CAPACITY_MINIMUM_PAYOUT_AMOUNT=25
CAPACITY_PLATFORM_FEE_BPS=1000
```

The AWS table requires a string partition key named `id`. The Lambda role needs `dynamodb:GetItem`, `PutItem`, `Scan`, `UpdateItem`, and `TransactWriteItems` on that table.

## Operational edge cases

- **Worker disappears:** stale workers are removed from public inventory. Assigned-but-unaccepted work expires. Accepted or running work remains visible for operator intervention rather than being silently reassigned and double-executed.
- **Duplicate worker reports:** usage sequences and record revisions reject duplicate or out-of-order updates.
- **Mixed GPU hosts:** pass explicit GPU model/count/VRAM flags; automatic detection describes heterogeneous devices as a combined model string.
- **Provider changes local availability:** heartbeat updates reported capacity, but the master subtracts active reservations.
- **Multiple listings on one node:** node-level reservation accounting prevents aggregate overbooking on AWS.
- **Listing edited during a sale:** contract-sensitive fields are locked while reservations are active.
- **Assignment accepted at the deadline:** the master compares ISO timestamps and rejects acceptance after expiration.
- **Completion repeated:** capacity-release guards and earning IDs make terminal finalization idempotency conflicts visible instead of paying twice.
- **Payout destination changed:** verification resets.
- **Payout races:** AWS revision conditions ensure an earning enters at most one payout.
- **Dispute after payout:** automatic hold is rejected and sent to manual settlement operations.
- **Secrets in metadata:** keys resembling token, password, credential, authorization, cookie, or private key are rejected.
- **Zero-price community capacity:** supported; no positive payout accrues.
- **Currency mismatch:** earnings and payouts are grouped by three-letter currency code and never mixed.
