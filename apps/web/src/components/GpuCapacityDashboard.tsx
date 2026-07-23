import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, CodeBlock } from "./ui";
import {
  createGpuCapacity,
  getMyGpuCapacity,
  getPublicGpuCapacity,
  setGpuCapacityStatus,
  type GpuAllocationMode,
  type GpuCapacityListing,
  type GpuCapacitySubmission,
  type GpuConnectionMode,
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
  description: "GPU capacity exposed through OpenModel.",
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

function formatPrice(listing: GpuCapacityListing) {
  return `${listing.currency} ${Number(listing.pricePerGpuHour).toFixed(2)} / GPU-hour`;
}

function heartbeatLabel(listing: GpuCapacityListing) {
  if (!listing.lastHeartbeatAt) {
    return "No CLI heartbeat";
  }
  return `Last seen ${new Date(listing.lastHeartbeatAt).toLocaleString()}`;
}

function capacityPercent(listing: GpuCapacityListing) {
  if (listing.gpuCount <= 0) {
    return 0;
  }
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
        <div><span>HANDOFF</span><strong>{listing.connectionMode.replaceAll("_", " ")}</strong></div>
      </div>

      <div className="capacity-meter" aria-label={`${percent.toFixed(0)} percent of GPU capacity available`}>
        <span style={{ width: `${percent}%` }} />
      </div>

      <div className="capacity-listing-meta">
        <span>{listing.locationLabel}</span>
        <span>{heartbeatLabel(listing)}</span>
      </div>

      {listing.endpointUrl ? (
        <code className="capacity-endpoint">{listing.endpointUrl}</code>
      ) : null}

      {owner && onStatusChange ? (
        <div className="capacity-listing-actions">
          {listing.status === "PUBLISHED" ? (
            <Button variant="outline" disabled={busy} onClick={() => onStatusChange(listing, "pause")}>Pause listing</Button>
          ) : (
            <Button disabled={busy} onClick={() => onStatusChange(listing, "publish")}>Publish listing</Button>
          )}
        </div>
      ) : listing.checkoutUrl ? (
        <a className="button button-outline" href={listing.checkoutUrl} target="_blank" rel="noreferrer">Open purchase flow</a>
      ) : null}
    </Card>
  );
}

export function GpuCapacityDashboard() {
  const [mine, setMine] = useState<GpuCapacityListing[]>([]);
  const [publicListings, setPublicListings] = useState<GpuCapacityListing[]>([]);
  const [submission, setSubmission] = useState<GpuCapacitySubmission>(initialSubmission);
  const [customGpuModel, setCustomGpuModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const resolvedGpuModel = submission.gpuModel === "Other" ? customGpuModel.trim() : submission.gpuModel;
  const cliCommand = useMemo(() => {
    const endpoint = submission.endpointUrl?.trim();
    return [
      "om capacity expose",
      `--gpu-model ${JSON.stringify(resolvedGpuModel || "NVIDIA RTX 4090")}`,
      `--gpus ${submission.gpuCount}`,
      `--vram-gb ${submission.vramGbPerGpu}`,
      `--price-hour ${submission.pricePerGpuHour}`,
      `--allocation ${submission.allocationMode}`,
      endpoint ? `--endpoint ${JSON.stringify(endpoint)}` : "--connection MANUAL",
      `--location ${JSON.stringify(submission.locationLabel || "Location shared after purchase")}`,
    ].join(" \\\n  ");
  }, [resolvedGpuModel, submission]);

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const [mineResult, publicResult] = await Promise.allSettled([
      getMyGpuCapacity(),
      getPublicGpuCapacity(),
    ]);
    if (mineResult.status === "fulfilled") {
      setMine(mineResult.value);
    }
    if (publicResult.status === "fulfilled") {
      setPublicListings(publicResult.value);
    }
    const messages = [mineResult, publicResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    const uniqueMessages = [...new Set(messages)];
    if (uniqueMessages.length) {
      setError(uniqueMessages.join(" "));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadCapacity();
  }, [loadCapacity]);

  const updateNumber = (field: keyof GpuCapacitySubmission, value: string) => {
    const parsed = Number(value);
    setSubmission((current) => ({ ...current, [field]: Number.isFinite(parsed) ? parsed : 0 }));
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
      if (listing.status === "PUBLISHED") {
        setPublicListings((current) => [listing, ...current.filter((item) => item.id !== listing.id)]);
      }
      setSuccess(`Created ${listing.title}. ${listing.status === "PUBLISHED" ? "It is visible in the marketplace." : "Publish it when the endpoint is ready."}`);
      setSubmission(initialSubmission);
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
      setPublicListings((current) => action === "publish"
        ? [updated, ...current.filter((item) => item.id !== updated.id)]
        : current.filter((item) => item.id !== updated.id));
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally {
      setStatusBusyId(undefined);
    }
  };

  return (
    <section className="dashboard-section dashboard-page-view capacity-page">
      <div className="dashboard-section-header">
        <div>
          <span className="dashboard-section-index">02</span>
          <Badge>GPU CAPACITY</Badge>
          <h2>Expose GPUs through OpenModel</h2>
          <p>List capacity from the dashboard or let the CLI detect NVIDIA hardware. OpenModel publishes availability and the provider-controlled handoff; inference traffic stays between buyer and provider.</p>
        </div>
        <Button variant="outline" disabled={loading} onClick={() => void loadCapacity()}>{loading ? "Refreshing" : "Refresh capacity"}</Button>
      </div>

      {error ? <div className="authentication-notice authentication-notice-error dashboard-notice"><span>CAPACITY_ERROR</span><strong>{error}</strong></div> : null}
      {success ? <div className="authentication-notice dashboard-notice"><span>CAPACITY_READY</span><strong>{success}</strong></div> : null}

      <div className="capacity-command-grid">
        <Card className="capacity-command-card">
          <span className="dashboard-panel-kicker">FASTEST PROVIDER SETUP</span>
          <h3>Detect and publish from the CLI</h3>
          <p>OpenModel reads NVIDIA model, count, VRAM, and driver information from <code>nvidia-smi</code>. You only provide price and a reachable session endpoint.</p>
          <div className="capacity-terminal">
            <CodeBlock>{cliCommand}</CodeBlock>
          </div>
          <p className="capacity-helper">Run <code>om login</code> once. Both <code>api.openmodel.sh</code> and <code>api.walton.bot</code> use this same capacity contract.</p>
        </Card>

        <Card className="capacity-command-card">
          <span className="dashboard-panel-kicker">KEEP AVAILABILITY CURRENT</span>
          <h3>Send a lightweight heartbeat</h3>
          <p>Update the number of GPUs that can be booked without exposing your host credentials or local network.</p>
          <div className="capacity-terminal">
            <CodeBlock>{`om capacity heartbeat <listing-id> --available-gpus 1 --runtime-status ready`}</CodeBlock>
          </div>
        </Card>
      </div>

      <Card className="capacity-form-card">
        <div className="capacity-form-heading">
          <div>
            <span className="dashboard-panel-kicker">DASHBOARD LISTING</span>
            <h3>List GPU capacity</h3>
          </div>
          <Badge>{submission.publish ? "PUBLISH NOW" : "SAVE DRAFT"}</Badge>
        </div>
        <form className="capacity-form" onSubmit={submitListing}>
          <label className="capacity-field capacity-field-wide">
            <span>LISTING TITLE</span>
            <input value={submission.title} onChange={(event) => setSubmission((current) => ({ ...current, title: event.target.value }))} placeholder={`${submission.gpuCount}× ${resolvedGpuModel || "GPU"}`} />
          </label>

          <label className="capacity-field">
            <span>GPU MODEL</span>
            <select value={submission.gpuModel} onChange={(event) => setSubmission((current) => ({ ...current, gpuModel: event.target.value }))}>
              {gpuModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>

          {submission.gpuModel === "Other" ? (
            <label className="capacity-field">
              <span>CUSTOM GPU MODEL</span>
              <input required value={customGpuModel} onChange={(event) => setCustomGpuModel(event.target.value)} />
            </label>
          ) : null}

          <label className="capacity-field">
            <span>GPU COUNT</span>
            <div className="capacity-unit-input"><input type="number" min="1" step="1" value={submission.gpuCount} onChange={(event) => updateNumber("gpuCount", event.target.value)} /><em>GPUs</em></div>
          </label>

          <label className="capacity-field">
            <span>AVAILABLE NOW</span>
            <div className="capacity-unit-input"><input type="number" min="0" max={submission.gpuCount} step="1" value={submission.availableGpuCount} onChange={(event) => updateNumber("availableGpuCount", event.target.value)} /><em>GPUs</em></div>
          </label>

          <label className="capacity-field">
            <span>VRAM PER GPU</span>
            <div className="capacity-unit-input"><input type="number" min="1" step="1" value={submission.vramGbPerGpu} onChange={(event) => updateNumber("vramGbPerGpu", event.target.value)} /><em>GB</em></div>
          </label>

          <label className="capacity-field">
            <span>PRICE</span>
            <div className="capacity-unit-input"><input type="number" min="0" step="0.01" value={submission.pricePerGpuHour} onChange={(event) => updateNumber("pricePerGpuHour", event.target.value)} /><em>USD / GPU-h</em></div>
          </label>

          <label className="capacity-field">
            <span>ALLOCATION</span>
            <select value={submission.allocationMode} onChange={(event) => setSubmission((current) => ({ ...current, allocationMode: event.target.value as GpuAllocationMode }))}>
              <option value="EXCLUSIVE">Exclusive GPU</option>
              <option value="MIG">NVIDIA MIG slice</option>
              <option value="TIME_SLICED">Time sliced</option>
            </select>
          </label>

          <label className="capacity-field">
            <span>BUYER HANDOFF</span>
            <select value={submission.connectionMode} onChange={(event) => setSubmission((current) => ({ ...current, connectionMode: event.target.value as GpuConnectionMode }))}>
              <option value="OPENMODEL_API">OpenModel API</option>
              <option value="HTTPS_API">HTTPS API</option>
              <option value="SSH">SSH</option>
              <option value="WIREGUARD">WireGuard</option>
              <option value="TAILSCALE">Tailscale</option>
              <option value="MANUAL">Manual peering</option>
            </select>
          </label>

          <label className="capacity-field capacity-field-wide">
            <span>REACHABLE ENDPOINT</span>
            <input type="url" value={submission.endpointUrl ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, endpointUrl: event.target.value }))} placeholder="https://gpu-provider.example.com" />
          </label>

          <label className="capacity-field capacity-field-wide">
            <span>PUBLIC LOCATION LABEL</span>
            <input value={submission.locationLabel ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, locationLabel: event.target.value }))} placeholder="Northern Virginia" />
          </label>

          <label className="capacity-field">
            <span>MINIMUM BOOKING</span>
            <div className="capacity-unit-input"><input type="number" min="0.25" step="0.25" value={submission.minimumHours} onChange={(event) => updateNumber("minimumHours", event.target.value)} /><em>hours</em></div>
          </label>

          <label className="capacity-field">
            <span>MAXIMUM SESSION</span>
            <div className="capacity-unit-input"><input type="number" min="1" step="1" value={submission.maxSessionHours} onChange={(event) => updateNumber("maxSessionHours", event.target.value)} /><em>hours</em></div>
          </label>

          <label className="capacity-field capacity-field-wide">
            <span>OPTIONAL BUYER CHECKOUT URL</span>
            <input type="url" value={submission.checkoutUrl ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, checkoutUrl: event.target.value }))} placeholder="https://provider.example.com/checkout" />
          </label>

          <label className="capacity-field capacity-field-wide">
            <span>DESCRIPTION</span>
            <textarea rows={3} value={submission.description ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, description: event.target.value }))} />
          </label>

          <label className="capacity-field capacity-field-wide">
            <span>PROVIDER HANDOFF NOTES</span>
            <textarea rows={3} value={submission.providerInstructions ?? ""} onChange={(event) => setSubmission((current) => ({ ...current, providerInstructions: event.target.value }))} placeholder="Explain what the buyer must configure after purchase." />
          </label>

          <label className="capacity-publish-toggle">
            <input type="checkbox" checked={submission.publish === true} onChange={(event) => setSubmission((current) => ({ ...current, publish: event.target.checked }))} />
            <span><strong>Publish immediately</strong><small>OpenModel API listings require a reachable endpoint before publication.</small></span>
          </label>

          <div className="capacity-form-actions">
            <Button type="submit" disabled={saving}>{saving ? "Saving GPU capacity" : submission.publish ? "Publish GPU capacity" : "Save GPU draft"}</Button>
          </div>
        </form>
      </Card>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">YOUR PROVIDER INVENTORY</span><h3>My GPU listings</h3></div><Badge>{mine.length} LISTINGS</Badge></div>
        <div className="capacity-list-grid">
          {mine.length ? mine.map((listing) => <ListingCard key={listing.id} listing={listing} owner busy={statusBusyId === listing.id} onStatusChange={changeStatus} />) : <Card className="capacity-empty-card"><h3>No GPU capacity listed yet</h3><p>Use the form or run <code>om capacity expose</code>.</p></Card>}
        </div>
      </div>

      <div className="capacity-list-section">
        <div className="capacity-list-heading"><div><span className="dashboard-panel-kicker">OPENMODEL MARKETPLACE</span><h3>Published capacity</h3></div><Badge>{publicListings.length} LIVE</Badge></div>
        <div className="capacity-list-grid">
          {publicListings.length ? publicListings.map((listing) => <ListingCard key={listing.id} listing={listing} />) : <Card className="capacity-empty-card"><h3>No public GPU listings</h3><p>Published provider capacity appears here.</p></Card>}
        </div>
      </div>
    </section>
  );
}
