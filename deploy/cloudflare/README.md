# Cloudflare deployment

Use the repository one-shot deployment command:

```bash
./deploy.sh --validate-only
./deploy.sh --plan-only
./deploy.sh --yes
```

The command provisions KV, deploys the Worker, creates or updates the Pages project, deploys the website, and applies DNS and custom domains through Terraform.

A full npm release can be included explicitly:

```bash
./deploy.sh --publish-npm --yes
```

Production credentials belong in the shell, a secret manager, or the ignored mode-`600` `.env.deploy` file. Never commit Cloudflare tokens, npm tokens, Terraform state, variable files, backend credentials, `.dev.vars`, generated Wrangler configuration, or production namespace identifiers in hand-written configuration.

See `DEPLOY.md` for the complete preparation, state, authentication, rollback, and security instructions.
