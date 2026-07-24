import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, CodeBlock } from "./ui";
import {
  createGpuCapacity,
  getMyGpuCapacity,
  getProviderEarnings,
  getProviderNodes,
  getProviderPayoutProfile,
  getProviderPayouts,
  getProviderReservations,
  getPublicGpuCapacity,
  registerProviderNode,
  requestProviderPayout,
  rotateProviderNodeToken,
  setGpuCapacityStatus,
  setProviderNodeStatus,
  updateProviderPayoutProfile,
  type GpuAllocationMode,
  type GpuCapacityListing,
  type GpuCapacitySubmission,
  type GpuConnectionMode,
  type GpuEarningsResponse,
  type GpuPayout,
  type GpuPayoutProfile,
  type GpuReservation,
  type ProviderNode,
  type ProviderNodeSubmission,
} from "../lib/api";

const gpuModels = [
  "NVIDIA H100 80GB",
  "NVIDIA H200 141GB",
  "NVIDIA A100 80GB",
  "NVIDIA L40S",
  "NVIDIA RTX 6000 Ada",
  "NVIDIA RTX 5090",
  "NVIDIA RTX 4090",
  "NVIDIA RTX 3090",
  "AMD Instinct MI300X",
  "AMD Radeon PRO W7900",
  "Apple Silicon",
  "Other",
];

const initialSubmission: GpuCapacitySubmission = {
  title: "",
  description: "GPU capacity managed by the OpenModel hyperscaler control plane.",
  gpuModel: "NVIDIA RTX 4090",
  gpuCount: 1,
  availableGpuCount: 1,
  vramGbPerGpu: 24,
  allocationMode: "EXCLUSIVE",
  runtime: "OpenModel",
  connectionMode: "OPENMODEL_API",
  endpointUrl: "",
  locationLabel: "Location shared after purchase",
  pricePerGpuHour: 0.75,
  currency: "USD",
  minimumHours: 1,
  maxSessionHours: 24,
  providerInstructions: "",
  publish: false,
};

const initialNodeSubmission: ProviderNodeSubmission = {
  name: "OpenModel GPU worker",
  gpuModel: "NVIDIA RTX 4090",
  gpuCount: 1,
  availableGpuCount: 1,
  vramGbPerGpu: 24,
  allocationModes: ["EXCLUSIVE"],
  runtime: "OpenModel",
  endpointUrl: "",
  region: "undisclosed",
};

const emptyEarnings: GpuEarningsResponse = { earnings: [], totals: {} };

type GpuCapacityNumberField =
  | "gpuCount"
  | "availableGpuCount"
  | "vramGbPerGpu"
  | "latitude"
  | "longitude"
  | "pricePerGpuHour"
  | "minimumHours"
  | "maxSessionHours";

type ProviderNodeNumberField =
  | "gpuCount"
  | "availableGpuCount"
  | "vramGbPerGpu";

function formatMoney(value: number | undefined, currency = "USD") {
  return `${currency} ${Number(value ?? 0).toFixed(2)}`;
}

function formatPrice(listing: GpuCapacityListing) {
  return `${listing.currency} ${Number(listing.pricePerGpuHour).toFixed(2)} / GPU-hour`;
}

function heartbeatLabel(value?: string | null) {
  if (!value) return "No heartbeat received";
  return `Last seen ${new Date(value).toLocaleString()}`;
}

function capacityPercent(listing: GpuCapacityListing) {
  if (listing.gpuCount <= 0) return 0;
  return Math.max(0, Math.min(100, (listing.availableGpuCount / listing.gpuCount) * 100));
}

function ListingCard({
  listing,
  owner,
  busy,
  onStatusChange,
}: {
  listing: GpuCapacityListing;
  owner?: boolean;
  busy?: boolean;
  onStatusChange?: (listing: GpuCapacityListing, action: "publish" | "pause") => void;
}) {
  const percent = capacityPercent(listing);
  return (
    <Card className="capacity-listing-card">
      <div className="capacity-listing-heading">
        <div>
          <span className="dashboard-panel-kicker">{listing.status}</span>
          <h3>{listing.title}</h3>
          <p>{listing.description || `${listing.gpuModel} capacity`}</p>
        </div>
        <Badge>{formatPrice(listing)}</Badge>
      </div>

      <div className="capacity-stat-grid">
        <div><span>GPU</span><strong>{listing.gpuModel}</strong></div>
        <div><span>AVAILABLE</span><strong>{listing.availableGpuCount} / {listing.gpuCount}</strong></div>
        <div><span>VRAM</span><strong>{listing.vramGbPerGpu} GB / GPU</strong></div>
        <div><span>CONTROL</span><strong>{listing.managedBy === "HYPERSCALER_MASTER" ? "MASTER MANAGED" : "PROVIDER HANDOFF"}</strong></div>
      </div>

      <div className="capacity-meter" aria-label={`${percent.toFixed(0)} percent of GPU capacity available`}>
        <span style={{ width: `${percent}%` }} />
      </div>

      <div className="capacity-listing-meta">
        <span>{listing.locationLabel}</span>
        <span>{heartbeatLabel(listing.lastHeartbeatAt)}</span>
      </div>

      {owner && listing.endpointUrl ? <code className="capacity-endpoint">{listing.endpointUrl}</code> : null}

      {owner && onStatusChange ? (
        <div className="capacity-listing-actions">
          {listing.status === "PUBLISHED" ? (
            <Button variant="outline" disabled={busy} onClick={() => onStatusChange(listing, "pause")}>Pause listing</Button>
          ) : (
            <Button disabled={busy} onClick={() => onStatusChange(listing, "publish")}>Publish listing</Button>
          )}
        </div>
      ) : listing.managedBy === "HYPERSCALER_MASTER" ? (
        <p className="capacity-helper">The hyperscaler master reserves this capacity, assigns the worker, meters usage, and settles provider earnings.</p>
      ) : null}
    </Card>
  );
}

function NodeCard({
  node,
  busy,
  onStatusChange,
  onRotateToken,
}: {
  node: ProviderNode;
  busy?: boolean;
  onStatusChange: (node: ProviderNode, action: "enable" | "drain" | "disable") => void;
  onRotateToken: (node: ProviderNode) => void;
}) {
  return (
    <Card className="capacity-listing-card">
      <div className="capacity-listing-heading">
        <div>
          <span className="dashboard-panel-kicker">{node.status}</span>
          <h3>{node.name}</h3>
          <p>{node.gpuModel} · {node.region}</p>
        </div>
        <Badge>{node.healthStatus}</Badge>
      </div>
      <div className="capacity-stat-grid">
        <div><span>EFFECTIVE FREE</span><strong>{node.availableGpuCount} / {node.gpuCount}</strong></div>
        <div><span>WORKER REPORTED</span><strong>{node.reportedAvailableGpuCount ?? node.availableGpuCount}</strong></div>
        <div><span>MASTER RESERVED</span><strong>{node.reservedGpuCount ?? 0}</strong></div>
        <div><span>VRAM</span><strong>{node.vramGbPerGpu} GB / GPU</strong></div>
        <div><span>RUNTIME</span><strong>{node.runtime}</strong></div>
        <div><span>TOKEN</span><strong>••••{node.tokenLastFour ?? "----"}</strong></div>
      </div>
      <div className="capacity-listing-meta">
        <span>{node.id}</span>
        <span>{heartbeatLabel(node.lastHeartbeatAt)}</span>
      </div>
      <div className="capacity-listing-actions">
        {node.status === "ACTIVE" ? <Button variant="outline" disabled={busy} onClick={() => onStatusChange(node, "drain")}>Drain</Button> : null}
        {node.status !== "ACTIVE" ? <Button variant="outline" disabled={busy} onClick={() => onStatusChange(node, "enable")}>Enable</Button> : null}
        {node.status === "DRAINING" ? <Button variant="outline" disabled={busy} onClick={() => onStatusChange(node, "disable")}>Disable</Button> : null}
        <Button variant="outline" disabled={busy} onClick={() => onRotateToken(node)}>Rotate token</Button>
      </div>
    </Card>
  );
}

function PayoutCard({ payout }: { payout: GpuPayout }) {
  return (
    <Card className="capacity-listing-card">
      <div className="capacity-listing-heading">
        <div>
          <span className="dashboard-panel-kicker">{payout.status}</span>
          <h3>{formatMoney(payout.amount, payout.currency)}</h3>
          <p>{payout.earningIds.length} earning record{payout.earningIds.length === 1 ? "" : "s"}</p>
        </div>
        <Badge>{payout.destinationMethod}</Badge>
      </div>
      <div className="capacity-listing-meta">
        <span>{payout.id}</span>
        <span>{payout.paidAt ? `Paid ${new Date(payout.paidAt).toLocaleString()}` : `Requested ${new Date(payout.requestedAt).toLocaleString()}`}</span>
      </div>
      {payout.failureMessage ? <p className="capacity-helper">{payout.failureMessage}</p> : null}
    </Card>
  );
}

function ReservationCard({ reservation }: { reservation: GpuReservation }) {
  return (
    <Card className="capacity-listing-card">
      <div className="capacity-listing-heading">
        <div>
          <span className="dashboard-panel-kicker">{reservation.status}</span>
          <h3>{reservation.gpuCount} GPU reservation</h3>
          <p>{reservation.workloadReference}</p>
        </div>
        <Badge>{formatMoney(reservation.providerAuthorizedAmount, reservation.currency)} AUTHORIZED</Badge>
      </div>
      <div className="capacity-stat-grid">
        <div><span>HOURS</span><strong>{reservation.requestedHours}</strong></div>
        <div><span>RATE</span><strong>{formatMoney(reservation.pricePerGpuHour, reservation.currency)} / GPU-h</strong></div>
        <div><span>EARNED</span><strong>{formatMoney(reservation.providerAmount, reservation.currency)}</strong></div>
        <div><span>BUYER</span><strong>{reservation.buyerDisplayName}</strong></div>
      </div>
      <div className="capacity-listing-meta">
        <span>{reservation.id}</span>
        <span>Updated {new Date(reservation.updatedAt).toLocaleString()}</span>
      </div>
    </Card>
  );
}

export function GpuCapacityDashboard() {
  const [mine, setMine] = useState<GpuCapacityListing[]>([]);
  const [publicListings, setPublicListings] = useState<GpuCapacityListing[]>([]);
  const [nodes, setNodes] = useState<ProviderNode[]>([]);
  const [reservations, setReservations] = useState<GpuReservation[]>([]);
  const [earnings, setEarnings] = useState<GpuEarningsResponse>(emptyEarnings);
  const [payoutProfile, setPayoutProfile] = useState<GpuPayoutProfile | null>(null);
  const [payouts, setPayouts] = useState<GpuPayout[]>([]);
  const [submission, setSubmission] = useState<GpuCapacitySubmission>(initialSubmission);
  const [nodeSubmission, setNodeSubmission] = useState<ProviderNodeSubmission>(initialNodeSubmission);
  const [customGpuModel, setCustomGpuModel] = useState("");
  const [nodeToken, setNodeToken] = useState<string>();
  const [payoutMethod, setPayoutMethod] = useState<GpuPayoutProfile["method"]>("STRIPE_CONNECT");
  const [payoutDestination, setPayoutDestination] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nodeSaving, setNodeSaving] = useState(false);
  const [payoutSaving, setPayoutSaving] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string>();
  const [nodeBusyId, setNodeBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const resolvedGpuModel = submission.gpuModel === "Other" ? customGpuModel.trim() : submission.gpuModel;
  const usdTotals = earnings.totals.USD ?? { pending: 0, available: 0, payoutPending: 0, paid: 0, held: 0, reversed: 0 };
  const providerCliCommand = useMemo(() => [
    "om login",
    "om provider enroll --name worker-1 --endpoint https://worker.example.com",
    "om provider agent --interval-seconds 20",
    "om capacity expose --node-id <node-id> --price-hour 0.75",
    "om provider assignments",
  ].join("\n"), []);

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const results = await Promise.allSettled([
      getMyGpuCapacity(),
      getPublicGpuCapacity(),
      getProviderNodes(),
      getProviderReservations(),
      getProviderEarnings(),
      getProviderPayoutProfile(),
      getProviderPayouts(),
    ]);
    if (results[0].status === "fulfilled") setMine(results[0].value);
    if (results[1].status === "fulfilled") setPublicListings(results[1].value);
    if (results[2].status === "fulfilled") setNodes(results[2].value);
    if (results[3].status === "fulfilled") setReservations(results[3].value);
    if (results[4].status === "fulfilled") setEarnings(results[4].value);
    if (results[5].status === "fulfilled") {
      setPayoutProfile(results[5].value);
      if (results[5].value) {
        setPayoutMethod(results[5].value.method);
        setPayoutDestination(results[5].value.destinationReference);
      }
    }
    if (results[6].status === "fulfilled") setPayouts(results[6].value);
    const messages = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (messages.length) setError([...new Set(messages)].join(" "));
    setLoading(false);
  }, []);

  useEffect(() => { void loadCapacity(); }, [loadCapacity]);

  const updateNumber = (field: GpuCapacityNumberField, value: string) => {
    const parsed = Number(value);
    setSubmission((current) => ({ ...current, [field]: Number.isFinite(parsed) ? parsed : 0 }));
  };

  const updateNodeNumber = (field: ProviderNodeNumberField, value: string) => {
    const parsed = Number(value);
    setNodeSubmission((current) => ({ ...current, [field]: Number.isFinite(parsed) ? parsed : 0 }));
  };

  const submitNode = async (event: FormEvent) => {
    event.preventDefault();
    setNodeSaving(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await registerProviderNode({
        ...nodeSubmission,
        endpointUrl: nodeSubmission.endpointUrl?.trim() || undefined,
        region: nodeSubmission.region?.trim() || "undisclosed",
      });
      setNodes((current) => [result.data, ...current]);
      setNodeToken(result.nodeToken);
      setSubmission((current) => ({ ...current, workerNodeId: result.data.id, gpuModel: result.data.gpuModel, gpuCount: result.data.gpuCount, availableGpuCount: result.data.availableGpuCount, vramGbPerGpu: result.data.vramGbPerGpu }));
      setSuccess(`Registered ${result.data.name}. Save the node token now; it will not be shown again.`);
    } catch (nodeError) {
      setError(nodeError instanceof Error ? nodeError.message : String(nodeError));
    } finally {
      setNodeSaving(false);
    }
  };

  const submitListing = async (event: FormEvent) => {
    event.preventDefault();
    if (!resolvedGpuModel) {
      setError("Choose a GPU model or enter a custom model.");
      return;
    }
    setSaving(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const listing = await createGpuCapacity({
        ...submission,
        title: submission.title.trim() || `${submission.gpuCount}× ${resolvedGpuModel}`,
        gpuModel: resolvedGpuModel,
        endpointUrl: submission.endpointUrl?.trim() || undefined,
        description: submission.description?.trim() || undefined,
        providerInstructions: submission.providerInstructions?.trim() || undefined,
      });
      setMine((current) => [listing, ...current.filter((item) => item.id !== listing.id)]);
      if (listing.status === "PUBLISHED") setPublicListings((current) => [listing, ...current.filter((item) => item.id !== listing.id)]);
      setSuccess(`Created ${listing.title}. ${listing.status === "PUBLISHED" ? "The hyperscaler can allocate it." : "Publish it after the worker heartbeat is ready."}`);
      setSubmission((current) => ({ ...initialSubmission, workerNodeId: current.workerNodeId }));
      setCustomGpuModel("");
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : String(submissionError));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (listing: GpuCapacityListing, action: "publish" | "pause") => {
    setStatusBusyId(listing.id);
    setError(undefined);
    try {
      const updated = await setGpuCapacityStatus(listing.id, action);
      setMine((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPublicListings((current) => action === "publish" ? [updated, ...current.filter((item) => item.id !== updated.id)] : current.filter((item) => item.id !== updated.id));
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setStatusBusyId(undefined);
    }
  };

  const changeNodeStatus = async (node: ProviderNode, action: "enable" | "drain" | "disable") => {
    setNodeBusyId(node.id);
    setError(undefined);
    setSuccess(undefined);
    try {
      const updated = await setProviderNodeStatus(node.id, action);
      setNodes((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSuccess(`${updated.name} is now ${updated.status.toLowerCase()}.`);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setNodeBusyId(undefined);
    }
  };

  const rotateNodeToken = async (node: ProviderNode) => {
    setNodeBusyId(node.id);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await rotateProviderNodeToken(node.id);
      setNodes((current) => current.map((item) => item.id === result.data.id ? result.data : item));
      setNodeToken(result.nodeToken);
      setSuccess(`Rotated the token for ${result.data.name}. Replace the old worker secret immediately.`);
    } catch (tokenError) {
      setError(tokenError instanceof Error ? tokenError.message : String(tokenError));
    } finally {
      setNodeBusyId(undefined);
    }
  };

  const selectWorkerNode = (workerNodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === workerNodeId);
    setSubmission((current) => node ? {
      ...current,
      workerNodeId: node.id,
      gpuModel: node.gpuModel,
      gpuCount: node.gpuCount,
      availableGpuCount: node.availableGpuCount,
      vramGbPerGpu: node.vramGbPerGpu,
      allocationMode: node.allocationModes[0] ?? "EXCLUSIVE",
      endpointUrl: node.endpointUrl ?? current.endpointUrl,
    } : { ...current, workerNodeId: undefined });
    setCustomGpuModel("");
  };

  const savePayoutProfile = async (event: FormEvent) => {
    event.preventDefault();
    setPayoutSaving(true);
    setError(undefined);
    try {
      const profile = await updateProviderPayoutProfile({ method: payoutMethod, destinationReference: payoutDestination.trim() });
      setPayoutProfile(profile);
      setSuccess("Payout profile saved. The hyperscaler must verify it before funds can be requested.");
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : String(profileError));
    } finally {
      setPayoutSaving(false);
    }
  };

  const requestPayout = async () => {
    setPayoutSaving(true);
    setError(undefined);
    try {
      const payout = await requestProviderPayout("USD");
      setPayouts((current) => [payout, ...current]);
      setSuccess(`Payout ${payout.id} requested for ${formatMoney(payout.amount, payout.currency)}.`);
      await loadCapacity();
    } catch (payoutError) {
      setError(payoutError instanceof Error ? payoutError.message : String(payoutError));
    } finally {
      setPayoutSaving(false);
    }
  };

  return (
    <section className="dashboard-section dashboard-page-view capacity-page">
      <div className="dashboard-section-header">
        <div>
          <span className="dashboard-section-index">02</span>
          <Badge>GPU PROVIDER NETWORK</Badge>
          <h2>Sell GPU capacity to hyperscaler masters</h2>
          <p>Register a worker node, publish inventory, pull master assignments, report metered runtime, and receive provider earnings without exposing host credentials or private network access.</p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void loadCapacity()}>{loading ? "Refreshing" : "Refresh provider data"}</Button>
      </div>

      {error ? <div className="authentication-notice authentication-notice-error dashboard-notice"><span>CAPACITY_ERROR</span><strong>{error}</strong></div> : null}
      {success ? <div className="authentication-notice dashboard-notice"><span>CAPACITY_READY</span><strong>{success}</strong></div> : null}
      {nodeToken ? (
        <div className="authentication-notice dashboard-notice capacity-token-notice">
          <span>NODE_TOKEN_SHOWN_ONCE</span>
          <strong>Store this token as a secret on the worker node.</strong>
          <code>{nodeToken}</code>
        </div>
      ) : null}

      <div className="capacity-command-grid">
        <Card className="capacity-command-card">
          <span className="dashboard-panel-kicker">MASTER / WORKER CONTROL PLANE</span>
          <h3>Hyperscaler master controls allocation</h3>
          <p>The master authorizes funded reservations, decrements inventory atomically on AWS, assigns work to a registered worker, validates monotonic usage reports, releases capacity once, and creates a provider earning ledger.</p>
          <div className="capacity-architecture-flow">
            <strong>HYPERSCALER MASTER</strong><span>assigns</span><strong>PROVIDER WORKER</strong><span>meters</span><strong>EARNINGS + PAYOUT</strong>
          </div>
        </Card>
        <Card className="capacity-command-card">
          <span className="dashboard-panel-kicker">CLI PROVIDER AGENT</span>
          <h3>Enroll and pull assignments</h3>
          <p>The worker initiates every control-plane connection. OpenModel never sends raw shell commands or buyer credentials to the machine.</p>
          <div className="capacity-terminal"><CodeBlock>{providerCliCommand}</CodeBlock></div>
        </Card>
      </div>

      <Card className="capacity-form-card">
        <div className="capacity-form-heading"><div><span className="dashboard-panel-kicker">STEP 1</span><h3>Register a provider worker</h3></div><Badge>{nodes.length} NODES</Badge></div>
        <form className="capacity-form" onSubmit={submitNode}>
          <label className="capacity-field"><span>NODE NAME</span><input value={nodeSubmission.name} onChange={(event) => setNodeSubmission((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="capacity-field"><span>GPU MODEL</span><input value={nodeSubmission.gpuModel} onChange={(event) => setNodeSubmission((current) => ({ ...current, gpuModel: event.target.value }))} /></label>
          <label className="capacity-field"><span>GPU COUNT</span><input type="number" min="1" value={nodeSubmission.gpuCount} onChange={(event) => updateNodeNumber("gpuCount", event.target.value)} /></label>
          <label className="capacity-field"><span>AVAILABLE NOW</span><input type="number" min="0" value={nodeSubmission.availableGpuCount} onChange={(event) => updateNodeNumber("availableGpuCount", event.target.value)} /></label>
          <label className="capacity-field"><span>VRAM PER GPU</span><input type="number" min="1" value={nodeSubmission.vramGbPerGpu} onChange={(event) => updateNodeNumber("vramGbPerGpu", event.target.value)} /></label>
          <label className="capacity-field"><span>REGION LABEL</span><input value={nodeSubmission.region ?? ""} onChange={(event) => setNodeSubmission((current) => ({ ...current, region: event.target.value }))} /></label>
          <label className="capacity-field capacity-field-wide"><span>WORKER ENDPOINT</span><input type="url" value={nodeSubmission.endpointUrl ?? ""} onChange={(event) => setNodeSubmission((current) => ({ ...current, endpointUrl: event.target.value }))} placeholder="https://worker.example.com" /></label>
          <div className="capacity-form-actions"><Button type="submit" disabled={nodeSaving}>{nodeSaving ? "Registering worker" : "Register provider worker"}</Button></div>
        </form>
      </Card>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">WORKER FLEET</span><h3>Registered provider nodes</h3></div><Badge>{nodes.length} NODES</Badge></div>
        <div className="capacity-list-grid">{nodes.length ? nodes.map((node) => <NodeCard key={node.id} node={node} busy={nodeBusyId === node.id} onStatusChange={changeNodeStatus} onRotateToken={rotateNodeToken} />) : <Card className="capacity-empty-card"><h3>No workers registered</h3><p>Register here or run <code>om provider enroll</code>.</p></Card>}</div>
      </div>

      <Card className="capacity-form-card">
        <div className="capacity-form-heading"><div><span className="dashboard-panel-kicker">STEP 2</span><h3>Publish sellable inventory</h3></div><Badge>{submission.workerNodeId ? "MASTER MANAGED" : "MANUAL HANDOFF"}</Badge></div>
        <form className="capacity-form" onSubmit={submitListing}>
          <label className="capacity-field capacity-field-wide"><span>WORKER NODE</span><select value={submission.workerNodeId ?? ""} onChange={(event) => selectWorkerNode(event.target.value)}><option value="">Provider-managed handoff</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.gpuModel}</option>)}</select></label>
          <label className="capacity-field"><span>GPU MODEL</span><select value={submission.gpuModel} onChange={(event) => setSubmission((current) => ({ ...current, gpuModel: event.target.value }))}>{gpuModels.map((model) => <option key={model}>{model}</option>)}</select></label>
          {submission.gpuModel === "Other" ? <label className="capacity-field"><span>CUSTOM GPU MODEL</span><input value={customGpuModel} onChange={(event) => setCustomGpuModel(event.target.value)} /></label> : null}
          <label className="capacity-field"><span>GPU COUNT</span><input type="number" min="1" value={submission.gpuCount} onChange={(event) => updateNumber("gpuCount", event.target.value)} /></label>
          <label className="capacity-field"><span>AVAILABLE NOW</span><input type="number" min="0" value={submission.availableGpuCount} onChange={(event) => updateNumber("availableGpuCount", event.target.value)} /></label>
          <label className="capacity-field"><span>VRAM PER GPU</span><input type="number" min="1" value={submission.vramGbPerGpu} onChange={(event) => updateNumber("vramGbPerGpu", event.target.value)} /></label>
          <label className="capacity-field"><span>PRICE</span><div className="capacity-unit-input"><input type="number" min="0" step="0.01" value={submission.pricePerGpuHour} onChange={(event) => updateNumber("pricePerGpuHour", event.target.value)} /><em>USD / GPU-h</em></div></label>
          <label className="capacity-field"><span>ALLOCATION</span><select value={submission.allocationMode} onChange={(event) => setSubmission((current) => ({ ...current, allocationMode: event.target.value as GpuAllocationMode }))}><option value="EXCLUSIVE">Exclusive GPU</option><option value="MIG">NVIDIA MIG slice</option><option value="TIME_SLICED">Time sliced</option></select></label>
          <label className="capacity-field"><span>BUYER HANDOFF</span><select value={submission.connectionMode} onChange={(event) => setSubmission((current) => ({ ...current, connectionMode: event.target.value as GpuConnectionMode }))}><option value="OPENMODEL_API">OpenModel API</option><option value="HTTPS_API">HTTPS API</option><option value="SSH">SSH</option><option value="WIREGUARD">WireGuard</option><option value="TAILSCALE">Tailscale</option><option value="MANUAL">Manual peering</option></select></label>
          <label className="capacity-field capacity-field-wide"><span>REACHABLE ENDPOINT</span><input type="url" value={submission.endpointUrl ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, endpointUrl: event.target.value }))} placeholder="https://gpu-provider.example.com" /></label>
          <label className="capacity-field"><span>MINIMUM BOOKING</span><input type="number" min="0.25" step="0.25" value={submission.minimumHours} onChange={(event) => updateNumber("minimumHours", event.target.value)} /></label>
          <label className="capacity-field"><span>MAXIMUM SESSION</span><input type="number" min="1" step="1" value={submission.maxSessionHours} onChange={(event) => updateNumber("maxSessionHours", event.target.value)} /></label>
          <label className="capacity-field capacity-field-wide"><span>DESCRIPTION</span><textarea rows={3} value={submission.description ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="capacity-publish-toggle"><input type="checkbox" checked={submission.publish === true} onChange={(event) => setSubmission((current) => ({ ...current, publish: event.target.checked }))} /><span><strong>Publish immediately</strong><small>Master-managed listings only remain public while their worker heartbeat is fresh.</small></span></label>
          <div className="capacity-form-actions"><Button type="submit" disabled={saving}>{saving ? "Saving GPU capacity" : submission.publish ? "Publish GPU capacity" : "Save GPU draft"}</Button></div>
        </form>
      </Card>

      <div className="capacity-command-grid">
        <Card className="capacity-form-card">
          <div className="capacity-form-heading"><div><span className="dashboard-panel-kicker">PROVIDER EARNINGS</span><h3>Settlement balance</h3></div><Badge>{payoutProfile?.status ?? "NO PAYOUT PROFILE"}</Badge></div>
          <div className="capacity-money-grid">
            <div><span>AVAILABLE</span><strong>{formatMoney(usdTotals.available)}</strong></div>
            <div><span>HOLDING</span><strong>{formatMoney(usdTotals.pending)}</strong></div>
            <div><span>PAYOUT PENDING</span><strong>{formatMoney(usdTotals.payoutPending)}</strong></div>
            <div><span>PAID</span><strong>{formatMoney(usdTotals.paid)}</strong></div>
            <div><span>DISPUTED / HELD</span><strong>{formatMoney(usdTotals.held)}</strong></div>
            <div><span>REVERSED</span><strong>{formatMoney(usdTotals.reversed)}</strong></div>
          </div>
          <Button disabled={payoutSaving || usdTotals.available <= 0 || !payoutProfile || !["VERIFIED", "ACTIVE"].includes(payoutProfile.status)} onClick={() => void requestPayout()}>{payoutSaving ? "Requesting payout" : "Request available USD balance"}</Button>
          <p className="capacity-helper">Completed sessions become available after the configured settlement hold. Failed or disputed sessions remain held for master review.</p>
        </Card>
        <Card className="capacity-form-card">
          <div className="capacity-form-heading"><div><span className="dashboard-panel-kicker">TOKENIZED DESTINATION</span><h3>Payout profile</h3></div><Badge>{payouts.length} PAYOUTS</Badge></div>
          <form className="capacity-form capacity-compact-form" onSubmit={savePayoutProfile}>
            <label className="capacity-field"><span>METHOD</span><select value={payoutMethod} onChange={(event) => setPayoutMethod(event.target.value as GpuPayoutProfile["method"])}><option value="STRIPE_CONNECT">Stripe Connect</option><option value="BANK_TOKEN">Bank processor token</option><option value="PAYPAL">PayPal reference</option><option value="CRYPTO_WALLET">Crypto wallet reference</option><option value="MANUAL">Manual settlement</option></select></label>
            <label className="capacity-field"><span>DESTINATION REFERENCE</span><input value={payoutDestination} onChange={(event) => setPayoutDestination(event.target.value)} placeholder="acct_123 or processor token" /></label>
            <div className="capacity-form-actions"><Button type="submit" disabled={payoutSaving}>{payoutSaving ? "Saving payout profile" : "Save payout profile"}</Button></div>
          </form>
          <p className="capacity-helper">Only processor-issued references are stored. Never enter a bank account number, card number, private key, password, or API token.</p>
        </Card>
      </div>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">SETTLEMENT HISTORY</span><h3>Provider payouts</h3></div><Badge>{payouts.length} TOTAL</Badge></div>
        <div className="capacity-list-grid">{payouts.length ? payouts.map((payout) => <PayoutCard key={payout.id} payout={payout} />) : <Card className="capacity-empty-card"><h3>No payouts requested</h3><p>Verified providers can request available whole earning records after the settlement hold.</p></Card>}</div>
      </div>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">MASTER ASSIGNMENTS</span><h3>Provider reservations</h3></div><Badge>{reservations.length} TOTAL</Badge></div>
        <div className="capacity-list-grid">{reservations.length ? reservations.map((reservation) => <ReservationCard key={reservation.id} reservation={reservation} />) : <Card className="capacity-empty-card"><h3>No reservations yet</h3><p>Funded hyperscaler assignments appear here after a master reserves published worker capacity.</p></Card>}</div>
      </div>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">YOUR PROVIDER INVENTORY</span><h3>My GPU listings</h3></div><Badge>{mine.length} LISTINGS</Badge></div>
        <div className="capacity-list-grid">{mine.length ? mine.map((listing) => <ListingCard key={listing.id} listing={listing} owner busy={statusBusyId === listing.id} onStatusChange={changeStatus} />) : <Card className="capacity-empty-card"><h3>No GPU capacity listed yet</h3><p>Register a worker and publish its sellable inventory.</p></Card>}</div>
      </div>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">OPENMODEL MARKETPLACE</span><h3>Published capacity</h3></div><Badge>{publicListings.length} LIVE</Badge></div>
        <div className="capacity-list-grid">{publicListings.length ? publicListings.map((listing) => <ListingCard key={listing.id} listing={listing} />) : <Card className="capacity-empty-card"><h3>No public GPU listings</h3><p>Only published, healthy master-managed capacity appears here.</p></Card>}</div>
      </div>
    </section>
  );
}
