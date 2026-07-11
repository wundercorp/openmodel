# Wundership API origin configuration for OpenModel

The OpenModel web dashboard calls the authenticated Wundership pricing API directly from the browser.

Apply `wundership-openmodel-origin-allowlist.patch` to the Wundership API source, or set the production origin environment variable so it includes the OpenModel origins:

```text
SECURITY_ALLOWED_ORIGINS=http://localhost:4000,http://localhost:5173,https://startup.you,https://loops.you,https://ship.you,https://launch.you,https://open.you,https://openmodel.sh,https://www.openmodel.sh
```

Required browser methods and headers for `/openmodel/v1/**`:

```text
Methods: GET, POST, OPTIONS
Headers: Authorization, Content-Type, Accept
Credentials: bearer token; browser cookies are not required
```

Keep authentication and account scoping enabled. This change only allows the trusted browser origins through the origin/CORS layer.
