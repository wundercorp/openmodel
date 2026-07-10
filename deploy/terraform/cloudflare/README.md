# Cloudflare Terraform

This stack manages the shared OpenModel Cloudflare infrastructure:

- Contributed-gateway KV namespace
- Website DNS record
- Cloudflare Pages custom domain
- Cloud API Worker custom domain

Wrangler creates or updates the Pages project and Worker code before the complete Terraform apply. This avoids placing application bundles inside Terraform state while retaining declarative lifecycle management for long-lived infrastructure.

Run the stack through the repository deployment command:

```bash
./deploy.sh --provider cloudflare --plan-only
./deploy.sh --provider cloudflare --yes
```

Do not commit `terraform.tfvars`, state, plans, backend credentials, generated configuration, or `.env.deploy`. See `DEPLOY.md` for the complete deployment sequence.
