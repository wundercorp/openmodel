# Security policy

Do not open public issues for suspected vulnerabilities, leaked credentials, authentication bypasses, or unsafe model-loading behavior. Send reports to security@wundercorp.co with reproduction steps and impact.

The project never requires committed credentials. Use environment variables, local credential stores, CI secret stores, and deployment-platform secret bindings. Model artifacts and local runtime state are intentionally ignored by Git.

Third-party gateways execute code inside the CLI process. Install gateway packages only from publishers you trust. The CLI never auto-discovers arbitrary packages from `node_modules`; contributors and users must explicitly register gateway package names.
