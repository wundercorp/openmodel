# Cognito dashboard setup

The web dashboard uses the OAuth 2.0 authorization-code flow with PKCE. The browser app must use a Cognito app client without a client secret.

## Cognito app client

Enable these settings on the web app client:

```text
OAuth grant: Authorization code grant
Scopes: openid profile email
```

Add these callback URLs:

```text
https://openmodel.sh/auth/callback
http://localhost:5173/auth/callback
```

Add these sign-out URLs:

```text
https://openmodel.sh
http://localhost:5173
```

Record these Cognito values:

```text
User-pool issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE
Hosted or custom domain: https://auth.wundercorp.co
Generated app client ID: replace-with-cognito-app-client-id
```

The app client ID is the generated Cognito identifier. It is not the app client display name.

## Production deployment values

Create an ignored `.env.deploy` file from `env.deploy.example` and set:

```text
OPENMODEL_AUTH_ISSUER="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE"
OPENMODEL_AUTH_DOMAIN="https://auth.wundercorp.co"
OPENMODEL_WEB_AUTH_CLIENT_ID="replace-with-cognito-app-client-id"
OPENMODEL_AUTH_AUDIENCE="replace-with-cognito-app-client-id"
OPENMODEL_WEB_AUTH_SCOPES="openid profile email"
```

Create the file with:

```bash
cp env.deploy.example .env.deploy
chmod 600 .env.deploy
```

The deployment scripts load `.env.deploy` before validating these values, including for `--validate-only`.

`OPENMODEL_AUTH_AUDIENCE` intentionally contains the Cognito app client ID. Cognito access tokens identify the app client in the `client_id` claim, while ID tokens identify it in `aud`.

For the AWS GitHub Actions deployment, add these repository or environment secrets:

```text
OPENMODEL_AUTH_ISSUER
OPENMODEL_AUTH_DOMAIN
OPENMODEL_WEB_AUTH_CLIENT_ID
```

## Local browser values

Copy the local template:

```bash
cp apps/web/.env.local.example apps/web/.env.local
```

Set the same issuer, domain, and app client ID. Keep the local callback and logout URLs from the template.

Start the site:

```bash
npm run dev:web
```

Open `http://localhost:5173`, select `SIGN IN`, complete Cognito sign-in, and confirm that Cognito returns to `/auth/callback`. The app exchanges the code with PKCE, stores the session in `sessionStorage`, moves to `/dashboard`, calls `/v1/me` with the access token, and loads `/v1/gateways`.

## API token validation

The AWS Lambda and Cloudflare Worker accept access tokens only when all of these checks succeed:

```text
RS256 signature is valid
iss matches OPENMODEL_AUTH_ISSUER
client_id, aud, or azp matches OPENMODEL_AUTH_AUDIENCE
token_use is access when the claim is present
exp and nbf are valid
```

A Cognito custom resource-server scope such as `https://api.openmodel.sh/gateways:write` is accepted for the `gateways:write` permission because the API recognizes both the full scope and its final scope name.
