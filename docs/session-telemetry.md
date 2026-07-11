# Cloud Agent Session Telemetry

OpenModel can collect normalized token and cost events from cloud-backed coding agents and SDKs while keeping prompt and response content out of the telemetry store.

## Architecture

OpenModel uses three collection paths:

1. OTLP logs for tools with native OpenTelemetry export, including Claude Code and Codex.
2. Exact response-usage adapters for APIs such as OpenRouter and first-party integrations such as `@wundercorp/bs`.
3. A normalized local HTTP endpoint for other agents, wrappers, gateways, and scripts.

All events are stored locally in JSONL under the OpenModel home directory. Publishing to Wundership is an explicit action.

## Quick setup

Run the guided setup command first:

```bash
om setup
```

It prints the complete four-step flow and the available integrations.

### 1. Start the local collector

Keep this process running while Claude Code, Codex, OpenRouter, BuilderStudio, or another client is in use:

```bash
om serve --port 11435
```

The collector exposes:

```text
POST /v1/telemetry/otlp/v1/logs
POST /v1/logs
POST /v1/telemetry/events
GET  /v1/telemetry/events
GET  /v1/telemetry/summary
```

The OTLP endpoints accept OTLP JSON and OTLP protobuf logs. The normalized event endpoint accepts one event or an `events` array.

### 2. Connect one tool

#### Claude Code

The easiest path launches Claude Code with telemetry configured for the current process:

```bash
om setup claude-code --launch
```

This points OTLP logs at the local OpenModel collector and disables prompt and assistant-response export.

To print the shell environment instead of launching Claude Code:

```bash
om setup claude-code
```

#### Codex

Generate the Codex configuration:

```bash
om setup codex
```

Copy the printed `[otel]` block into `~/.codex/config.toml`, save the file, and restart Codex.

#### OpenRouter

Generate an exact response-usage reporting example:

```bash
om setup openrouter
```

Add the generated reporting call after each completed OpenRouter response, when the final usage object and provider cost are available.

#### BuilderStudio and `@wundercorp/bs`

Generate the gateway SDK integration snippet:

```bash
om setup bs
```

Add the reporter immediately after BuilderStudio receives the completed provider response.

### 3. Verify local capture

Run a request in the connected tool, then inspect the local summary:

```bash
om telemetry summary
```

The dashboard shows the same information under **Metrics → External Usage**.

### 4. Optionally publish normalized usage

Publishing remains explicit:

```bash
om telemetry sync
```

Only normalized usage metadata is synchronized. Prompts, responses, transcripts, source code, and tool arguments remain excluded.

## Generic normalized event

```json
{
  "source": "custom-agent",
  "sessionId": "session-123",
  "requestId": "request-456",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "occurredAt": "2026-07-11T16:00:00Z",
  "usage": {
    "inputTokens": 1200,
    "outputTokens": 350,
    "cachedInputTokens": 800,
    "reasoningTokens": 0,
    "totalTokens": 1550
  },
  "cost": {
    "amount": 0.00039,
    "currency": "USD",
    "source": "reported"
  },
  "accuracy": "exact"
}
```

Submit it directly:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  --data @usage-event.json \
  http://127.0.0.1:11435/v1/telemetry/events
```

Or pipe it through the CLI:

```bash
cat usage-event.json | om telemetry emit
```

## Inspecting sessions

```bash
om telemetry summary
om telemetry events
```

The **Metrics → External Usage** tab shows setup instructions, external session totals, reported cost, source and model breakdowns, and recent sessions after the dashboard connects to the local API.

## Publishing usage to Wundership

Publishing remains explicit:

```bash
om telemetry sync
```

OpenModel sends normalized token counts, timestamps, provider/model mapping, cost metadata, and an idempotency key to the Wundership usage endpoint. Synced event IDs are tracked locally so repeated runs do not resend the same event.

## Privacy

OpenModel does not persist prompts, responses, transcripts, tool arguments, source code, or model weights in the telemetry store. Metadata is restricted to an allowlist. Setup commands disable prompt and response export when the upstream tool supports those controls.

## Accuracy levels

Use `exact` when the upstream response or telemetry event provides provider token counts. Use `estimated` only when token counts are calculated locally. Subscription products that expose neither usage fields nor telemetry can only be estimated until the provider offers an export, billing API, or reconciliation feed.
