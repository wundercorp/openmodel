import { useMemo, useState } from "react";
import { Card } from "./ui";
import type {
  ExternalUsageEvent,
  LocalMetricsSnapshot,
} from "../lib/api";
import {
  finiteNumber,
  formatCompactNumber,
  formatExactInteger,
} from "../lib/format";

interface ExternalUsageDashboardProps {
  connected: boolean;
  localApiUrl: string;
  localMetrics?: LocalMetricsSnapshot;
}

interface SetupCommandProps {
  id: string;
  title: string;
  description: string;
  command: string;
  copiedCommand?: string;
  onCopy: (id: string, command: string) => void;
}

interface TokenMixItem {
  id: string;
  label: string;
  value: number;
}

function formatInteger(value: unknown) {
  return formatCompactNumber(value, 1);
}

function formatCurrency(value: unknown, currency = "USD") {
  const numericValue = finiteNumber(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: Math.abs(numericValue) < 0.01 ? 4 : 2,
    maximumFractionDigits: Math.abs(numericValue) < 0.01 ? 6 : 2,
  }).format(numericValue);
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}

function formatDuration(value: number) {
  const durationMilliseconds = finiteNumber(value);
  if (durationMilliseconds <= 0) {
    return "NOT REPORTED";
  }
  if (durationMilliseconds < 1000) {
    return `${Math.round(durationMilliseconds)} MS`;
  }
  if (durationMilliseconds < 60000) {
    return `${(durationMilliseconds / 1000).toFixed(2)} S`;
  }
  return `${(durationMilliseconds / 60000).toFixed(1)} M`;
}

function normalizeModelName(provider: string | undefined, model: string | undefined) {
  const providerValue = String(provider ?? "").trim();
  const modelValue = String(model ?? "").trim();
  if (!modelValue) {
    return "unknown";
  }
  if (providerValue && modelValue.toLowerCase().startsWith(`${providerValue.toLowerCase()}/`)) {
    return modelValue.slice(providerValue.length + 1);
  }
  return modelValue;
}

function formatRelativeTime(value: string | undefined) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return "NO CAPTURE YET";
  }
  const elapsedMilliseconds = Math.max(0, Date.now() - timestamp);
  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
  if (elapsedSeconds < 60) {
    return `${Math.max(1, elapsedSeconds)}S AGO`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}M AGO`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}H AGO`;
  }
  return `${Math.floor(elapsedHours / 24)}D AGO`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function SetupCommand({
  id,
  title,
  description,
  command,
  copiedCommand,
  onCopy,
}: SetupCommandProps) {
  return (
    <div className="dashboard-external-setup-command">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <code>{command}</code>
      <button type="button" onClick={() => onCopy(id, command)}>
        {copiedCommand === id ? "COPIED" : "COPY"}
      </button>
    </div>
  );
}

function TokenMix({ items }: { items: TokenMixItem[] }) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);

  return (
    <div className="dashboard-external-token-mix">
      <div className="dashboard-external-token-track" aria-label="Token composition">
        {items.map((item) => {
          const width = total > 0 ? (Math.max(0, item.value) / total) * 100 : 0;
          return (
            <span
              key={item.id}
              className={`is-${item.id}`}
              style={{ width: `${width}%` }}
              title={`${item.label}: ${formatExactInteger(item.value)}`}
            />
          );
        })}
      </div>
      <div className="dashboard-external-token-legend">
        {items.map((item) => (
          <div key={item.id}>
            <span className={`is-${item.id}`} />
            <small>{item.label}</small>
            <strong title={formatExactInteger(item.value)}>{formatInteger(item.value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentEventRow({ event, currency }: { event: ExternalUsageEvent; currency: string }) {
  const modelName = normalizeModelName(event.provider, event.model);
  return (
    <div className="dashboard-external-event-row">
      <div className="dashboard-external-event-primary">
        <span className={`dashboard-external-event-status is-${event.status}`}>
          {event.status}
        </span>
        <div>
          <strong title={`${event.provider}/${event.model}`}>
            {event.provider || "unknown"} / {modelName}
          </strong>
          <small>{event.source} · {event.accuracy ?? "unknown"}</small>
        </div>
      </div>
      <div>
        <span>TOKENS</span>
        <strong title={formatExactInteger(event.usage.totalTokens)}>
          {formatInteger(event.usage.totalTokens)}
        </strong>
      </div>
      <div>
        <span>COST</span>
        <strong>{formatCurrency(event.cost.amount, event.cost.currency || currency)}</strong>
      </div>
      <div>
        <span>DURATION</span>
        <strong>{formatDuration(event.durationMs)}</strong>
      </div>
      <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
    </div>
  );
}

export function ExternalUsageDashboard({
  connected,
  localApiUrl,
  localMetrics,
}: ExternalUsageDashboardProps) {
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const [setupExpanded, setSetupExpanded] = useState(false);
  const externalUsage = localMetrics?.externalUsage;
  const sources = externalUsage?.bySource ?? [];
  const models = externalUsage?.byModel ?? [];
  const sessions = externalUsage?.sessions ?? [];
  const recentEvents = externalUsage?.recentEvents ?? [];
  const currency = externalUsage?.cost.currency ?? "USD";
  const requestTotal = externalUsage?.requests.total ?? 0;
  const successfulRequests = externalUsage?.requests.successful ?? 0;
  const failedRequests = externalUsage?.requests.failed ?? 0;
  const totalTokens = externalUsage?.usage.totalTokens ?? 0;
  const inputTokens = externalUsage?.usage.inputTokens ?? 0;
  const outputTokens = externalUsage?.usage.outputTokens ?? 0;
  const cachedInputTokens = externalUsage?.usage.cachedInputTokens ?? 0;
  const reasoningTokens = externalUsage?.usage.reasoningTokens ?? 0;
  const reportedCost = externalUsage?.cost.reported ?? 0;
  const successRate = requestTotal > 0 ? (successfulRequests / requestTotal) * 100 : 0;
  const cacheRate = inputTokens > 0 ? (cachedInputTokens / inputTokens) * 100 : 0;
  const averageTokensPerRequest = requestTotal > 0 ? totalTokens / requestTotal : 0;
  const averageCostPerRequest = requestTotal > 0 ? reportedCost / requestTotal : 0;
  const latestCapturedAt = recentEvents[0]?.occurredAt ?? sessions[0]?.lastEventAt;
  const showSetup = requestTotal === 0 || setupExpanded;
  const sortedSessions = useMemo(
    () =>
      [...sessions]
        .sort(
          (firstSession, secondSession) =>
            new Date(secondSession.lastEventAt).getTime() -
            new Date(firstSession.lastEventAt).getTime(),
        )
        .slice(0, 12),
    [sessions],
  );
  const sortedEvents = useMemo(
    () =>
      [...recentEvents]
        .sort(
          (firstEvent, secondEvent) =>
            new Date(secondEvent.occurredAt).getTime() -
            new Date(firstEvent.occurredAt).getTime(),
        )
        .slice(0, 12),
    [recentEvents],
  );
  const tokenMixItems: TokenMixItem[] = [
    { id: "input", label: "INPUT", value: Math.max(0, inputTokens - cachedInputTokens) },
    { id: "cached", label: "CACHED INPUT", value: cachedInputTokens },
    { id: "output", label: "OUTPUT", value: outputTokens },
    { id: "reasoning", label: "REASONING", value: reasoningTokens },
  ];

  const handleCopy = async (id: string, command: string) => {
    await copyText(command);
    setCopiedCommand(id);
    window.setTimeout(() => {
      setCopiedCommand((currentValue) =>
        currentValue === id ? undefined : currentValue,
      );
    }, 1800);
  };

  return (
    <div className="dashboard-external-usage">
      <Card className="dashboard-external-intro-card">
        <div>
          <span className="dashboard-panel-kicker">SESSION TELEMETRY</span>
          <h3>External usage</h3>
          <p>
            Exact token and provider-cost metadata from BuilderStudio, Claude Code,
            Codex, OpenRouter, and custom SDKs. Prompt text, responses, source code,
            and tool arguments remain excluded.
          </p>
        </div>
        <div className="dashboard-external-intro-actions">
          <span className={connected ? "is-connected" : "is-offline"}>
            {connected ? "COLLECTOR CONNECTED" : "COLLECTOR NOT CONNECTED"}
          </span>
          <strong>{formatRelativeTime(latestCapturedAt)}</strong>
          <code>{localApiUrl}</code>
          <button type="button" onClick={() => setSetupExpanded((currentValue) => !currentValue)}>
            {showSetup && requestTotal > 0 ? "HIDE SETUP" : "SETUP TOOLS"}
          </button>
        </div>
      </Card>

      <div className="dashboard-external-summary-grid">
        <Card>
          <span>TOTAL TOKENS</span>
          <strong title={formatExactInteger(totalTokens)}>{formatInteger(totalTokens)}</strong>
          <small>{formatInteger(inputTokens)} INPUT · {formatInteger(outputTokens)} OUTPUT</small>
        </Card>
        <Card>
          <span>REPORTED COST</span>
          <strong>{formatCurrency(reportedCost, currency)}</strong>
          <small>{formatCurrency(averageCostPerRequest, currency)} / REQUEST</small>
        </Card>
        <Card>
          <span>REQUESTS</span>
          <strong>{formatInteger(requestTotal)}</strong>
          <small>{formatPercent(successRate)} SUCCESS · {formatInteger(failedRequests)} FAILED</small>
        </Card>
        <Card>
          <span>CACHE RATE</span>
          <strong>{formatPercent(cacheRate)}</strong>
          <small>{formatInteger(cachedInputTokens)} CACHED INPUT TOKENS</small>
        </Card>
        <Card>
          <span>SESSIONS</span>
          <strong>{formatInteger(sessions.length)}</strong>
          <small>{formatInteger(sources.length)} SOURCES</small>
        </Card>
        <Card>
          <span>AVG REQUEST</span>
          <strong title={formatExactInteger(averageTokensPerRequest)}>{formatInteger(averageTokensPerRequest)}</strong>
          <small>TOKENS PER REQUEST</small>
        </Card>
      </div>

      {requestTotal > 0 ? (
        <Card className="dashboard-external-token-card">
          <div className="dashboard-panel-heading">
            <div>
              <span className="dashboard-panel-kicker">TOKEN COMPOSITION</span>
              <h3>Usage mix</h3>
            </div>
            <span className="dashboard-pricing-external-status">
              {formatInteger(reasoningTokens)} REASONING
            </span>
          </div>
          <TokenMix items={tokenMixItems} />
        </Card>
      ) : null}

      {showSetup ? (
        <Card className="dashboard-external-setup-card">
          <div className="dashboard-panel-heading">
            <div>
              <span className="dashboard-panel-kicker">QUICK SETUP</span>
              <h3>Connect a tool in three steps</h3>
            </div>
            <span className="dashboard-external-privacy-label">LOCAL METADATA ONLY</span>
          </div>

          <div className="dashboard-external-setup-steps">
            <section>
              <span>01</span>
              <div>
                <strong>START THE LOCAL COLLECTOR</strong>
                <p>Keep this command running while your AI tools are in use.</p>
                <SetupCommand
                  id="start-collector"
                  title="START OPENMODEL"
                  description="Default collector endpoint: http://127.0.0.1:11435"
                  command="om serve --port 11435"
                  copiedCommand={copiedCommand}
                  onCopy={handleCopy}
                />
              </div>
            </section>

            <section>
              <span>02</span>
              <div>
                <strong>CONNECT THE TOOL</strong>
                <p>BuilderStudio configures globally; no project code changes are required.</p>
                <div className="dashboard-external-integration-grid">
                  <SetupCommand
                    id="setup-bs"
                    title="@WUNDERCORP/BS"
                    description="Enables native reporting globally and verifies daemon support."
                    command="om setup bs"
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                  <SetupCommand
                    id="setup-claude"
                    title="CLAUDE CODE"
                    description="Launches Claude Code with private OTLP usage reporting enabled."
                    command="om setup claude-code --launch"
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                  <SetupCommand
                    id="setup-codex"
                    title="CODEX"
                    description="Prints the configuration block for ~/.codex/config.toml."
                    command="om setup codex"
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                  <SetupCommand
                    id="setup-openrouter"
                    title="OPENROUTER / SDK"
                    description="Prints the exact response-usage reporter integration."
                    command="om setup openrouter"
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                </div>
              </div>
            </section>

            <section>
              <span>03</span>
              <div>
                <strong>VERIFY AND OPTIONALLY SYNC</strong>
                <p>Confirm local capture, then publish normalized usage metadata only when desired.</p>
                <div className="dashboard-external-verification-grid">
                  <SetupCommand
                    id="verify-summary"
                    title="VERIFY LOCAL CAPTURE"
                    description="Shows sessions, providers, models, tokens, and reported cost."
                    command="om telemetry summary"
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                  <SetupCommand
                    id="sync-usage"
                    title="SYNC TO WUNDERSHIP"
                    description="Uploads unsynchronized metadata without prompts or responses."
                    command="om telemetry sync"
                    copiedCommand={copiedCommand}
                    onCopy={handleCopy}
                  />
                </div>
              </div>
            </section>
          </div>
        </Card>
      ) : null}

      {!connected ? (
        <Card className="dashboard-pricing-external-empty dashboard-external-empty-state">
          <strong>START OPENMODEL TO RECEIVE EXTERNAL USAGE</strong>
          <p>Run <code>om serve --port 11435</code> and keep it running while using connected tools.</p>
        </Card>
      ) : requestTotal === 0 ? (
        <Card className="dashboard-pricing-external-empty dashboard-external-empty-state">
          <strong>NO EXTERNAL REQUESTS CAPTURED YET</strong>
          <p>Connect a tool above, run one model-backed request, then select REFRESH EXTERNAL.</p>
        </Card>
      ) : (
        <>
          <div className="dashboard-external-detail-grid">
            <Card className="dashboard-pricing-external-card">
              <div className="dashboard-panel-heading">
                <div>
                  <span className="dashboard-panel-kicker">SOURCE BREAKDOWN</span>
                  <h3>Tools and clients</h3>
                </div>
              </div>
              <div className="dashboard-pricing-external-sources">
                {sources.map((source) => (
                  <div key={source.source}>
                    <span>{source.source}</span>
                    <strong>{formatInteger(source.totalTokens)} TOKENS</strong>
                    <small>{formatInteger(source.requests)} REQUESTS · {formatCurrency(source.reportedCost, currency)}</small>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="dashboard-pricing-external-card">
              <div className="dashboard-panel-heading">
                <div>
                  <span className="dashboard-panel-kicker">MODEL BREAKDOWN</span>
                  <h3>Cloud models</h3>
                </div>
              </div>
              <div className="dashboard-pricing-external-sources">
                {models.slice(0, 12).map((model) => (
                  <div key={`${model.provider}:${model.model}`}>
                    <span>{model.provider || "unknown"}</span>
                    <strong title={model.model}>{normalizeModelName(model.provider, model.model)}</strong>
                    <small>{formatInteger(model.totalTokens)} TOKENS · {formatCurrency(model.reportedCost, currency)}</small>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {sortedEvents.length > 0 ? (
            <Card className="dashboard-pricing-external-card dashboard-external-events-card">
              <div className="dashboard-panel-heading">
                <div>
                  <span className="dashboard-panel-kicker">RECENT ACTIVITY</span>
                  <h3>Request events</h3>
                </div>
                <span className="dashboard-pricing-external-status">{formatInteger(sortedEvents.length)} SHOWN</span>
              </div>
              <div className="dashboard-external-event-list">
                {sortedEvents.map((event) => (
                  <RecentEventRow key={event.idempotencyKey} event={event} currency={currency} />
                ))}
              </div>
            </Card>
          ) : (
            <Card className="dashboard-pricing-external-card">
              <div className="dashboard-panel-heading">
                <div>
                  <span className="dashboard-panel-kicker">RECENT ACTIVITY</span>
                  <h3>External sessions</h3>
                </div>
                <span className="dashboard-pricing-external-status">{formatInteger(sortedSessions.length)} SHOWN</span>
              </div>
              <div className="dashboard-pricing-session-list dashboard-external-session-list">
                {sortedSessions.map((session) => (
                  <div key={`${session.source}:${session.sessionId}`}>
                    <span>{session.source}</span>
                    <strong title={`${session.provider ?? "unknown"}/${session.model ?? "unknown"}`}>
                      {session.provider || "unknown"}/{normalizeModelName(session.provider, session.model)}
                    </strong>
                    <small>{formatInteger(session.totalTokens)} TOKENS · {formatInteger(session.requests)} REQUESTS · {formatCurrency(session.reportedCost, currency)}</small>
                    <small>{new Date(session.lastEventAt).toLocaleString()}</small>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Card className="dashboard-external-privacy-card">
        <span>PRIVACY</span>
        <p>
          Allowlisted usage metadata is stored in the local telemetry ledger. Prompt content: <strong>{externalUsage?.privacy.promptContentStored ? "STORED" : "NOT STORED"}</strong>. Response content: <strong>{externalUsage?.privacy.responseContentStored ? "STORED" : "NOT STORED"}</strong>. Persistence: <strong>{externalUsage?.privacy.persistence ?? "LOCAL JSONL"}</strong>.
        </p>
      </Card>
    </div>
  );
}
