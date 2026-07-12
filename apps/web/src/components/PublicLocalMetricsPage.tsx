import { Badge, Button, Card } from "./ui";
import { UsagePricingDashboard } from "./UsagePricingDashboard";
import type { LocalMetricsSnapshot } from "../lib/api";
import { finiteNumber, formatCompactNumber } from "../lib/format";

type LocalApiState = "idle" | "loading" | "connected" | "offline";

interface PublicLocalMetricsPageProps {
  localApiInput: string;
  localApiState: LocalApiState;
  localApiError?: string;
  localMetrics?: LocalMetricsSnapshot;
  localMetricsError?: string;
  localMetricsLoading: boolean;
  localMetricsResetting: boolean;
  onLocalApiInputChange: (value: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  onReset: () => void;
  onSignIn: () => void;
  onHome: () => void;
}

function numericValue(value: unknown) {
  return finiteNumber(value);
}

function formatMetric(value: unknown) {
  return formatCompactNumber(value, 1);
}

function formatDuration(value: unknown) {
  const milliseconds = numericValue(value);
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(2)} S`;
  }
  return `${Math.round(milliseconds)} MS`;
}

function formatPercent(value: unknown) {
  return `${numericValue(value).toFixed(1)}%`;
}

export function PublicLocalMetricsPage({
  localApiInput,
  localApiState,
  localApiError,
  localMetrics,
  localMetricsError,
  localMetricsLoading,
  localMetricsResetting,
  onLocalApiInputChange,
  onConnect,
  onRefresh,
  onReset,
  onSignIn,
  onHome,
}: PublicLocalMetricsPageProps) {
  const localApiConnected = localApiState === "connected";
  const inference = localMetrics?.inference;
  const totalTokens = inference?.totalTokens ?? 0;
  const successRate = (inference?.totalRequests ?? 0) > 0
    ? ((inference?.successfulRequests ?? 0) / (inference?.totalRequests ?? 1)) * 100
    : 0;

  return (
    <main className="bui-root dashboard-page dashboard-public-metrics-page">
      <header className="dashboard-public-metrics-header">
        <button className="dashboard-auth-brand" type="button" onClick={onHome}>
          <span aria-hidden="true">OM</span>
          <span>OpenModel</span>
        </button>
        <div>
          <Button variant="outline" onClick={onHome}>View site</Button>
          <Button onClick={onSignIn}>Sign in</Button>
        </div>
      </header>

      <div className="dashboard-public-metrics-content">
        <div className="dashboard-page-heading">
          <div>
            <Badge>LOCAL OBSERVABILITY</Badge>
            <h1>Offline metrics</h1>
            <p>
              Connect directly to the local OpenModel service without signing in.
              Cloud allowance, pricing, and synchronization stay disabled until authentication.
            </p>
          </div>
          <div className="dashboard-page-actions">
            <Button
              variant="outline"
              disabled={!localApiConnected || localMetricsLoading}
              onClick={onRefresh}
            >
              {localMetricsLoading ? "REFRESHING" : "REFRESH METRICS"}
            </Button>
            <Button
              variant="ghost"
              disabled={!localApiConnected || !localMetrics || localMetricsResetting}
              onClick={onReset}
            >
              {localMetricsResetting ? "RESETTING" : "RESET LOCAL"}
            </Button>
          </div>
        </div>

        <Card className="dashboard-metrics-privacy">
          <span className="dashboard-metrics-privacy-mark">LOCAL_ONLY</span>
          <div>
            <strong>NO ACCOUNT OR CLOUD CONNECTION REQUIRED</strong>
            <p>
              Counts and timing metadata are read from the local service. Prompt and response content are not retained or uploaded.
            </p>
          </div>
        </Card>

        <Card className="dashboard-metrics-connect-panel">
          <form
            className="dashboard-local-api-form"
            onSubmit={(event) => {
              event.preventDefault();
              onConnect();
            }}
          >
            <label htmlFor="public-metrics-local-api-url">LOCAL SERVICE</label>
            <input
              id="public-metrics-local-api-url"
              value={localApiInput}
              onChange={(event) => onLocalApiInputChange(event.target.value)}
              spellCheck={false}
            />
            <Button disabled={localApiState === "loading"} type="submit">
              {localApiState === "loading" ? "CONNECTING" : localApiConnected ? "RECONNECT" : "CONNECT"}
            </Button>
          </form>
          {localApiError ? <p className="dashboard-local-api-error">{localApiError}</p> : null}
          {localMetricsError ? <p className="dashboard-local-api-error">{localMetricsError}</p> : null}
        </Card>

        <div className="dashboard-metrics-grid">
          <Card className="dashboard-metric-card">
            <span>TOTAL TOKENS</span>
            <strong>{formatMetric(totalTokens)}</strong>
            <small>LOCAL METRICS WINDOW</small>
          </Card>
          <Card className="dashboard-metric-card">
            <span>REQUESTS</span>
            <strong>{formatMetric(inference?.totalRequests)}</strong>
            <small>{formatMetric(inference?.activeRequests)} ACTIVE</small>
          </Card>
          <Card className="dashboard-metric-card">
            <span>SUCCESS RATE</span>
            <strong>{formatPercent(successRate)}</strong>
            <small>{formatMetric(inference?.failedRequests)} FAILED</small>
          </Card>
          <Card className="dashboard-metric-card">
            <span>AVG LATENCY</span>
            <strong>{formatDuration(inference?.averageLatencyMs)}</strong>
            <small>P95 {formatDuration(inference?.p95LatencyMs)}</small>
          </Card>
          <Card className="dashboard-metric-card">
            <span>TOKENS / SECOND</span>
            <strong>{formatMetric(inference?.averageTokensPerSecond)}</strong>
            <small>COMPLETION THROUGHPUT</small>
          </Card>
          <Card className="dashboard-metric-card">
            <span>LOCAL MODELS</span>
            <strong>{formatMetric(localMetrics?.models.installedCount)}</strong>
            <small>{formatMetric(localMetrics?.models.runnableCount)} RUNNABLE</small>
          </Card>
        </div>

        <Card className="dashboard-metrics-table-panel">
          <div className="dashboard-panel-heading">
            <div>
              <span className="dashboard-panel-kicker">INFERENCE LOG</span>
              <h3>Recent local requests</h3>
            </div>
          </div>
          <div className="dashboard-metrics-request-header">
            <span>TIME</span>
            <span>MODEL</span>
            <span>RUNTIME</span>
            <span>TOKENS</span>
            <span>LATENCY</span>
            <span>SPEED</span>
            <span>STATUS</span>
          </div>
          {(localMetrics?.recentRequests.length ?? 0) === 0 ? (
            <div className="dashboard-table-empty">RUN A LOCAL REQUEST TO START THE TRACKER</div>
          ) : (
            localMetrics?.recentRequests.slice(0, 20).map((request) => (
              <div className="dashboard-metrics-request-row" key={request.id}>
                <span>{new Date(request.completedAt).toLocaleTimeString()}</span>
                <code title={request.modelId}>{request.modelId}</code>
                <span>{request.runtimeId ?? "UNKNOWN"}</span>
                <strong>{formatMetric(request.totalTokens)}</strong>
                <span>{formatDuration(request.latencyMs)}</span>
                <span>{formatMetric(request.tokensPerSecond)} TOK/S</span>
                <span className={`dashboard-metrics-status dashboard-metrics-status-${request.status}`}>
                  {request.status.toUpperCase()}
                </span>
              </div>
            ))
          )}
        </Card>

        <UsagePricingDashboard
          authenticated={false}
          localMetrics={localMetrics}
          onSignIn={onSignIn}
        />
      </div>
    </main>
  );
}
