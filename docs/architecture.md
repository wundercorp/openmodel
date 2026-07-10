# Architecture

OpenModel separates model discovery, artifact acquisition, model storage, execution, API serving, authentication, and cloud services.

A model reference enters the gateway registry. The registry chooses a gateway by explicit scheme or deterministic `canHandle` checks. The gateway returns a normalized descriptor containing artifacts, native runtime handles, metadata, and runtime hints. The model store materializes files into an application data directory and records a manifest. Runtime adapters consume manifests without knowing which gateway produced them.

The local server maps OpenAI-compatible and Ollama-compatible requests onto the same runtime adapter. Cloud authentication is independent of local inference and can be omitted entirely for offline use.

Third-party gateway packages are never discovered automatically. Users register package names explicitly. This avoids surprising code execution and makes the active interoperability surface auditable.
