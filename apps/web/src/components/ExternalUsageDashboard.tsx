import { useMemo, useState } from "react";
import { Card } from "./ui";
import type { LocalMetricsSnapshot } from "../lib/api";
import { finiteNumber, formatCompactNumber, formatExactInteger } from "../lib/format";

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

export function ExternalUsageDashboard({
  connected,
  localApiUrl,
  localMetrics,
}: ExternalUsageDashboardProps) {
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const externalUsage = localMetrics?.externalUsage;
  const sources = externalUsage?.bySource ?? [];
  const models = externalUsage?.byModel ?? [];
  const sessions = externalUsage?.sessions ?? [];
  const currency = externalUsage?.cost.currency ?? "USD";
  const sortedSessions = useMemo(
    () =>
      [...sessions]
        .sort(
          (firstSession, secondSession) =>
            new Date(secondSession.lastEventAt).getTime() -
            new Date(firstSession.lastEventAt).getTime(),
        )
        .slice(0, 20),
    [sessions],
  );

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
          <h3>EXTERNAL USAGE</h3>
          <p>
            Capture token and cost metadata from Claude Code, Codex, OpenRouter,
            BuilderStudio, and custom SDKs through the local OpenModel collector.
            Prompt text, response text, source code, and tool arguments are not stored.
          </p>
        </div>
        <div className="dashboard-external-intro-actions">
          <span className={connected ? "is-connected" : "is-offline"}>
            {connected ? "COLLECTOR CONNECTED" : "COLLECTOR NOT CONNECTED"}
          </span>
          <code>{localApiUrl}</code>
        </div>
      </Card>

      <Card className="dashboard-external-setup-card">
        <div className="dashboard-panel-heading">
          <div>
            <span className="dashboard-panel-kicker">QUICK SETUP</span>
            <h3>CONNECT A TOOL IN THREE STEPS</h3>
          </div>
          <span className="dashboard-external-privacy-label">LOCAL METADATA ONLY</span>
        </div>

        <div className="dashboard-external-setup-steps">
          <section>
            <span>01</span>
            <div>
              <strong>START THE LOCAL COLLECTOR</strong>
              <p>Keep this command running in a terminal while your AI tools are in use.</p>
              <SetupCommand
                id="start-collector"
                title="START OPENMODEL"
                description="Default local endpoint: http://127.0.0.1:11435"
                command="om serve --port 11435"
                copiedCommand={copiedCommand}
                onCopy={handleCopy}
              />
            </div>
          </section>

          <section>
            <span>02</span>
            <div>
              <strong>CHOOSE THE TOOL YOU USE</strong>
              <p>Run one setup command. Claude Code launches directly, and BuilderStudio is configured globally.</p>
              <div className="dashboard-external-integration-grid">
                <SetupCommand
                  id="setup-claude"
                  title="CLAUDE CODE · EASIEST"
                  description="Launches Claude Code with OTLP token reporting pointed at OpenModel."
                  command="om setup claude-code --launch"
                  copiedCommand={copiedCommand}
                  onCopy={handleCopy}
                />
                <SetupCommand
                  id="setup-codex"
                  title="CODEX"
                  description="Prints the [otel] block. Paste it into ~/.codex/config.toml, save, and restart Codex."
                  command="om setup codex"
                  copiedCommand={copiedCommand}
                  onCopy={handleCopy}
                />
                <SetupCommand
                  id="setup-openrouter"
                  title="OPENROUTER"
                  description="Prints an exact response-usage reporting example for your client or gateway."
                  command="om setup openrouter"
                  copiedCommand={copiedCommand}
                  onCopy={handleCopy}
                />
                <SetupCommand
                  id="setup-bs"
                  title="@WUNDERCORP/BS"
                  description="Configures BuilderStudio globally with native token reporting. No project code changes are required."
                  command="om setup bs"
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
              <p>
                Run a request in the connected tool, verify it locally, then publish only
                normalized usage metadata when desired.
              </p>
              <div className="dashboard-external-verification-grid">
                <SetupCommand
                  id="verify-summary"
                  title="VERIFY LOCAL CAPTURE"
                  description="Shows captured sessions, providers, models, tokens, and reported cost."
                  command="om telemetry summary"
                  copiedCommand={copiedCommand}
                  onCopy={handleCopy}
                />
                <SetupCommand
                  id="sync-usage"
                  title="SYNC TO WUNDERSHIP"
                  description="Optional. Uploads unsynchronized normalized usage events without prompts or responses."
                  command="om telemetry sync"
                  copiedCommand={copiedCommand}
                  onCopy={handleCopy}
                />
              </div>
            </div>
          </section>
        </div>
      </Card>

      <div className="dashboard-pricing-external-summary dashboard-external-summary-grid">
        <Card>
          <span>TOTAL TOKENS</span>
          <strong title={formatExactInteger(externalUsage?.usage.totalTokens ?? 0)}>
            {formatInteger(externalUsage?.usage.totalTokens ?? 0)}
          </strong>
          <small>
            {formatInteger(externalUsage?.usage.inputTokens ?? 0)} INPUT ·{" "}
            {formatInteger(externalUsage?.usage.outputTokens ?? 0)} OUTPUT
          </small>
        </Card>
        <Card>
          <span>SESSIONS</span>
          <strong>{formatInteger(sessions.length)}</strong>
          <small>{formatInteger(externalUsage?.requests.total ?? 0)} REQUESTS</small>
        </Card>
        <Card>
          <span>REPORTED COST</span>
          <strong>{formatCurrency(externalUsage?.cost.reported ?? 0, currency)}</strong>
          <small>PROVIDER-REPORTED WHEN AVAILABLE</small>
        </Card>
        <Card>
          <span>SOURCES</span>
          <strong>{formatInteger(sources.length)}</strong>
          <small>{formatInteger(externalUsage?.requests.failed ?? 0)} FAILED REQUESTS</small>
        </Card>
      </div>

      {!connected ? (
        <Card className="dashboard-pricing-external-empty dashboard-external-empty-state">
          <strong>START OPENMODEL TO RECEIVE EXTERNAL USAGE</strong>
          <p>
            Run <code>om serve --port 11435</code>, keep it running, and then complete one
            integration setup above.
          </p>
        </Card>
      ) : sources.length === 0 ? (
        <Card className="dashboard-pricing-external-empty dashboard-external-empty-state">
          <strong>NO EXTERNAL SESSIONS CAPTURED YET</strong>
          <p>
            Complete one setup above, run a request in that tool, and select REFRESH USAGE.
            You can also verify capture with <code>om telemetry summary</code>.
          </p>
        </Card>
      ) : (
        <>
          <div className="dashboard-external-detail-grid">
            <Card className="dashboard-pricing-external-card">
              <div className="dashboard-panel-heading">
                <div>
                  <span className="dashboard-panel-kicker">SOURCE BREAKDOWN</span>
                  <h3>TOOLS AND CLIENTS</h3>
                </div>
              </div>
              <div className="dashboard-pricing-external-sources">
                {sources.map((source) => (
                  <div key={source.source}>
                    <span>{source.source}</span>
                    <strong>{formatInteger(source.totalTokens)} TOKENS</strong>
                    <small>
                      {formatInteger(source.requests)} REQUESTS ·{" "}
                      {formatCurrency(source.reportedCost, currency)}
                    </small>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="dashboard-pricing-external-card">
              <div className="dashboard-panel-heading">
                <div>
                  <span className="dashboard-panel-kicker">MODEL BREAKDOWN</span>
                  <h3>CLOUD MODELS</h3>
                </div>
              </div>
              <div className="dashboard-pricing-external-sources">
                {models.slice(0, 12).map((model) => (
                  <div key={`${model.provider}:${model.model}`}>
                    <span>{model.provider || "unknown"}</span>
                    <strong title={model.model}>{model.model || "unknown"}</strong>
                    <small>
                      {formatInteger(model.totalTokens)} TOKENS ·{" "}
                      {formatCurrency(model.reportedCost, currency)}
                    </small>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="dashboard-pricing-external-card">
            <div className="dashboard-panel-heading">
              <div>
                <span className="dashboard-panel-kicker">RECENT ACTIVITY</span>
                <h3>EXTERNAL SESSIONS</h3>
              </div>
              <span className="dashboard-pricing-external-status">
                {formatInteger(sortedSessions.length)} SHOWN
              </span>
            </div>
            <div className="dashboard-pricing-session-list dashboard-external-session-list">
              {sortedSessions.map((session) => (
                <div key={`${session.source}:${session.sessionId}`}>
                  <span>{session.source}</span>
                  <strong title={`${session.provider ?? "unknown"}/${session.model ?? "unknown"}`}>
                    {session.provider || "unknown"}/{session.model || "unknown"}
                  </strong>
                  <small>
                    {formatInteger(session.totalTokens)} TOKENS ·{" "}
                    {formatInteger(session.requests)} REQUESTS ·{" "}
                    {formatCurrency(session.reportedCost, currency)}
                  </small>
                  <small>{new Date(session.lastEventAt).toLocaleString()}</small>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      <Card className="dashboard-external-privacy-card">
        <span>PRIVACY</span>
        <p>
          OpenModel stores allowlisted usage metadata locally in the telemetry ledger.
          Prompt content stored: <strong>{externalUsage?.privacy.promptContentStored ? "YES" : "NO"}</strong>. Response content stored:{" "}
          <strong>{externalUsage?.privacy.responseContentStored ? "YES" : "NO"}</strong>. Persistence:{" "}
          <strong>{externalUsage?.privacy.persistence ?? "LOCAL JSONL"}</strong>.
        </p>
      </Card>
    </div>
  );
}
