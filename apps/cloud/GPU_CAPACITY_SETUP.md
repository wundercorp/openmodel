# Cloudflare GPU capacity setup

Create and bind a KV namespace:

```bash
wrangler kv namespace create GPU_CAPACITY_REGISTRY
wrangler kv namespace create GPU_CAPACITY_REGISTRY --preview
```

Copy the IDs into `wrangler.toml` using the example block in `wrangler.toml.example`.

Attach both `api.openmodel.sh` and `api.walton.bot` as custom domains/routes for the same Worker when both zones are available in the Cloudflare account.
