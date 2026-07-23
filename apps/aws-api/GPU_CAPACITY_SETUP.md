# AWS GPU capacity setup

Create a DynamoDB table with a string partition key named `id`, then expose the table name to the Lambda as `GPU_CAPACITY_TABLE`.

The Lambda role needs:

- `dynamodb:Scan`
- `dynamodb:PutItem`

The handler is hostname-neutral. Attach both `api.openmodel.sh` and `api.walton.bot` as custom domains for the same API Gateway stage, or point `api.walton.bot` at the canonical custom domain through your DNS/CDN provider.

Set `AUTH_AUDIENCE` to a comma-separated list containing the web and CLI Cognito app client IDs. The CLI token `client_id` must be accepted or `om capacity expose`, `mine`, `publish`, `pause`, and `heartbeat` will return HTTP 401.
