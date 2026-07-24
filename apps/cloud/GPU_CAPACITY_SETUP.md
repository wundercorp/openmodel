# Cloudflare GPU provider marketplace setup

Create and bind a KV namespace:

```bash
wrangler kv namespace create GPU_CAPACITY_REGISTRY
wrangler kv namespace create GPU_CAPACITY_REGISTRY --preview
```

Copy the IDs into `wrangler.toml` using the example block in `wrangler.toml.example`. Attach `api.openmodel.sh` and `api.walton.bot` to the same Worker when both zones are available.

Cloudflare KV is eventually consistent and cannot provide compare-and-swap transactions across a listing, physical worker, reservation, earning, and payout. For real-money sales, use the AWS DynamoDB API as the authoritative hyperscaler master and use Cloudflare only as an edge/public-read layer.

Mutating allocation and settlement endpoints fail closed by default. Enabling this setting explicitly accepts possible overbooking, stale reads, rollback failure, and duplicate-settlement risk:

```dotenv
CAPACITY_ALLOW_EVENTUALLY_CONSISTENT_ALLOCATIONS="true"
```

Do not enable it for production payment settlement unless an external transactional coordinator and reconciliation process protect every mutation.
