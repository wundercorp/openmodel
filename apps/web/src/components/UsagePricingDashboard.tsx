import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card } from "./ui";
import {
  estimateWundershipCloudCost,
  getWundershipApiBaseUrl,
  getWundershipPricingCatalog,
  getWundershipUsageSummary,
  submitWundershipUsageEvents,
  type LocalInferenceRecentRequest,
  type LocalMetricsSnapshot,
  type WundershipPricingCatalogEntry,
  type WundershipPricingCatalogResponse,
  type WundershipPricingEstimateResponse,
  type WundershipUsageEvent,
  type WundershipUsageSummary,
} from "../lib/api";
import { finiteNumber, formatCompactNumber, formatExactInteger } from "../lib/format";

interface UsagePricingDashboardProps {
  authenticated: boolean;
  localMetrics?: LocalMetricsSnapshot;
  onSignIn: () => void;
}

interface PricingRates {
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
  pricingVersion: string;
}

interface TimelinePoint {
  id: string;
  label: string;
  tokens: number;
  cumulativeTokens: number;
  estimatedCost: number;
  cumulativeCost: number;
}

type TimelineRange = "day" | "week" | "month";

interface FilterableSelectProps {
  label: string;
  value: string;
  options: string[];
  disabled?: boolean;
  loading?: boolean;
  onChange: (value: string) => void;
}

const providerStorageKey = "openmodel:wundership-provider";
const modelStorageKey = "openmodel:wundership-model";
const regionStorageKey = "openmodel:wundership-region";
const serviceTierStorageKey = "openmodel:wundership-service-tier";
const syncedUsageStorageKey = "openmodel:wundership-synced-usage-events";
const timelineRangeStorageKey = "openmodel:wundership-timeline-range";

const timelineRanges: TimelineRange[] = ["day", "week", "month"];
const timelineRangeConfiguration: Record<TimelineRange, { durationMilliseconds: number; bucketMilliseconds: number }> = {
  day: {
    durationMilliseconds: 24 * 60 * 60 * 1000,
    bucketMilliseconds: 60 * 60 * 1000,
  },
  week: {
    durationMilliseconds: 7 * 24 * 60 * 60 * 1000,
    bucketMilliseconds: 24 * 60 * 60 * 1000,
  },
  month: {
    durationMilliseconds: 30 * 24 * 60 * 60 * 1000,
    bucketMilliseconds: 24 * 60 * 60 * 1000,
  },
};

function formatInteger(value: unknown) {
  return formatCompactNumber(value, 1);
}

function formatCurrency(value: unknown, currency = "USD") {
  const numericValue = finiteNumber(value);
  const resolvedCurrency = currency || "USD";

  if (Math.abs(numericValue) >= 1_000) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: resolvedCurrency,
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    })
      .format(numericValue)
      .replace(/([KMBT])(?=\s|$)/g, (suffix) => suffix.toLowerCase());
  }

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: resolvedCurrency,
    minimumFractionDigits: Math.abs(numericValue) < 0.01 ? 4 : 2,
    maximumFractionDigits: Math.abs(numericValue) < 0.01 ? 6 : 2,
  }).format(numericValue);
}

function formatMultiplier(value: unknown) {
  const numericValue = finiteNumber(value);
  if (numericValue === 0) {
    return "--";
  }
  if (numericValue >= 10) {
    return `${numericValue.toFixed(1)}x`;
  }
  if (numericValue >= 1) {
    return `${numericValue.toFixed(2).replace(/\.00$/, "")}x`;
  }
  return `${numericValue.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

function formatDateRange(start?: string, end?: string) {
  if (!start || !end) {
    return "CURRENT BILLING MONTH";
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  return `${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`;
}

function readSyncedUsageKeys() {
  try {
    const parsedValue = JSON.parse(
      localStorage.getItem(syncedUsageStorageKey) ?? "[]",
    ) as unknown;
    return new Set(
      Array.isArray(parsedValue)
        ? parsedValue.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

function writeSyncedUsageKeys(keys: Set<string>) {
  localStorage.setItem(
    syncedUsageStorageKey,
    JSON.stringify(Array.from(keys).slice(-2000)),
  );
}

function buildUsageKey(
  request: LocalInferenceRecentRequest,
  provider: string,
  model: string,
) {
  return `openmodel-web:${provider}:${model}:${request.id}`;
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((firstValue, secondValue) =>
    firstValue.localeCompare(secondValue, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function timelineLabel(timestamp: number, range: TimelineRange) {
  const date = new Date(timestamp);
  if (range === "day") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function timelineWindowLabel(range: TimelineRange, referenceTime?: string) {
  const configuration = timelineRangeConfiguration[range];
  const parsedReferenceTime = referenceTime ? new Date(referenceTime).getTime() : Date.now();
  const endTime = Number.isFinite(parsedReferenceTime) ? parsedReferenceTime : Date.now();
  const startTime = endTime - configuration.durationMilliseconds;
  const dateOptions: Intl.DateTimeFormatOptions = range === "day"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `${new Date(startTime).toLocaleString([], dateOptions)} – ${new Date(endTime).toLocaleString([], dateOptions)}`;
}

function buildTimeline(
  requests: LocalInferenceRecentRequest[],
  inputRatePerMillion: number,
  outputRatePerMillion: number,
  range: TimelineRange,
  referenceTime?: string,
) {
  const configuration = timelineRangeConfiguration[range];
  const parsedReferenceTime = referenceTime ? new Date(referenceTime).getTime() : Date.now();
  const endTime = Number.isFinite(parsedReferenceTime) ? parsedReferenceTime : Date.now();
  const startTime = endTime - configuration.durationMilliseconds;
  const buckets = new Map<number, { tokens: number; estimatedCost: number }>();

  requests
    .filter((request) => request.status === "success")
    .forEach((request) => {
      const completedAt = new Date(request.completedAt).getTime();
      if (!Number.isFinite(completedAt) || completedAt < startTime || completedAt > endTime) {
        return;
      }
      const bucketTimestamp = Math.floor(completedAt / configuration.bucketMilliseconds)
        * configuration.bucketMilliseconds;
      const existingBucket = buckets.get(bucketTimestamp) ?? { tokens: 0, estimatedCost: 0 };
      existingBucket.tokens += request.totalTokens;
      existingBucket.estimatedCost +=
        (request.promptTokens * inputRatePerMillion) / 1_000_000 +
        (request.completionTokens * outputRatePerMillion) / 1_000_000;
      buckets.set(bucketTimestamp, existingBucket);
    });

  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  return Array.from(buckets.entries())
    .sort(([firstTimestamp], [secondTimestamp]) => firstTimestamp - secondTimestamp)
    .map(([timestamp, bucket]) => {
      cumulativeTokens += bucket.tokens;
      cumulativeCost += bucket.estimatedCost;
      return {
        id: String(timestamp),
        label: timelineLabel(timestamp, range),
        tokens: bucket.tokens,
        cumulativeTokens,
        estimatedCost: bucket.estimatedCost,
        cumulativeCost,
      } satisfies TimelinePoint;
    });
}

function FilterableSelect({
  label,
  value,
  options,
  disabled = false,
  loading = false,
  onChange,
}: FilterableSelectProps) {
  const [filter, setFilter] = useState("");
  const visibleOptions = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    const filteredOptions = normalizedFilter
      ? options.filter((option) => option.toLowerCase().includes(normalizedFilter))
      : options;
    const selectedOptionExists = options.includes(value);
    return uniqueSorted(selectedOptionExists && value && !filteredOptions.includes(value)
      ? [value, ...filteredOptions]
      : filteredOptions);
  }, [filter, options, value]);

  return (
    <label className="dashboard-pricing-filterable-select">
      <span>{label}</span>
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={`FILTER ${label}`}
        aria-label={`Filter ${label.toLowerCase()} options`}
        disabled={disabled}
      />
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || visibleOptions.length === 0}
      >
        {visibleOptions.length === 0 ? (
          <option value="">{loading ? "LOADING" : "NO OPTIONS"}</option>
        ) : null}
        {visibleOptions.map((option) => (
          <option value={option} key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function polylinePoints(values: number[], width: number, height: number) {
  if (values.length === 0) {
    return "";
  }
  const maximumValue = Math.max(...values, 1);
  const horizontalStep = values.length === 1 ? 0 : width / (values.length - 1);
  return values
    .map((value, index) => {
      const xPosition = index * horizontalStep;
      const yPosition = height - (value / maximumValue) * height;
      return `${xPosition.toFixed(2)},${yPosition.toFixed(2)}`;
    })
    .join(" ");
}

function UsageLineChart({ points, range }: { points: TimelinePoint[]; range: TimelineRange }) {
  const width = 720;
  const height = 190;
  const tokenPoints = polylinePoints(
    points.map((point) => point.cumulativeTokens),
    width,
    height,
  );
  const costPoints = polylinePoints(
    points.map((point) => point.cumulativeCost),
    width,
    height,
  );

  if (points.length === 0) {
    return (
      <div className="dashboard-pricing-chart-empty">
        NO LOCAL REQUESTS IN THE SELECTED {range.toUpperCase()} RANGE
      </div>
    );
  }

  return (
    <div className="dashboard-pricing-line-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cumulative local token usage and estimated cloud cost over time">
        <g className="dashboard-pricing-chart-grid">
          <line x1="0" y1="0" x2={width} y2="0" />
          <line x1="0" y1={height / 2} x2={width} y2={height / 2} />
          <line x1="0" y1={height} x2={width} y2={height} />
        </g>
        <polyline className="dashboard-pricing-token-line" points={tokenPoints} />
        <polyline className="dashboard-pricing-cost-line" points={costPoints} />
      </svg>
      <div className="dashboard-pricing-chart-axis">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <div className="dashboard-pricing-chart-legend">
        <span><i className="dashboard-pricing-token-key"></i>CUMULATIVE TOKENS</span>
        <span><i className="dashboard-pricing-cost-key"></i>ESTIMATED CLOUD COST</span>
      </div>
      <small className="dashboard-pricing-chart-note">
        TOKEN AND COST LINES USE INDEPENDENT NORMALIZED SCALES.
      </small>
    </div>
  );
}

function UsageBarChart({ points, currency, range }: { points: TimelinePoint[]; currency: string; range: TimelineRange }) {
  const maximumTokens = Math.max(...points.map((point) => point.tokens), 1);
  if (points.length === 0) {
    return (
      <div className="dashboard-pricing-chart-empty">
        NO LOCAL REQUESTS IN THE SELECTED {range.toUpperCase()} RANGE
      </div>
    );
  }

  return (
    <div className="dashboard-pricing-bars" aria-label={`Tokens and estimated cloud cost per ${range} time bucket`}>
      {points.slice(-12).map((point) => (
        <div className="dashboard-pricing-bar-row" key={point.id}>
          <span>{point.label}</span>
          <div>
            <i style={{ width: `${Math.max(3, (point.tokens / maximumTokens) * 100)}%` }}></i>
          </div>
          <strong>{formatInteger(point.tokens)} TOK</strong>
          <small>{formatCurrency(point.estimatedCost, currency)}</small>
        </div>
      ))}
    </div>
  );
}

export function UsagePricingDashboard({
  authenticated,
  localMetrics,
  onSignIn,
}: UsagePricingDashboardProps) {
  const [provider, setProvider] = useState(
    () => localStorage.getItem(providerStorageKey) ?? "openai",
  );
  const [model, setModel] = useState(
    () => localStorage.getItem(modelStorageKey) ?? "gpt-4o-mini",
  );
  const [region, setRegion] = useState(
    () => localStorage.getItem(regionStorageKey) ?? "global",
  );
  const [serviceTier, setServiceTier] = useState(
    () => localStorage.getItem(serviceTierStorageKey) ?? "default",
  );
  const [timelineRange, setTimelineRange] = useState<TimelineRange>(() => {
    const storedRange = localStorage.getItem(timelineRangeStorageKey);
    return timelineRanges.includes(storedRange as TimelineRange)
      ? storedRange as TimelineRange
      : "day";
  });
  const [catalog, setCatalog] = useState<WundershipPricingCatalogResponse>();
  const [summary, setSummary] = useState<WundershipUsageSummary>();
  const [estimate, setEstimate] = useState<WundershipPricingEstimateResponse>();
  const [rates, setRates] = useState<PricingRates>();
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [catalogErrorMessage, setCatalogErrorMessage] = useState<string>();
  const [syncMessage, setSyncMessage] = useState<string>();
  const requestAbortController = useRef<AbortController | undefined>(undefined);
  const catalogAbortController = useRef<AbortController | undefined>(undefined);

  const localInference = localMetrics?.inference;
  const localRequests = localMetrics?.recentRequests ?? [];
  const catalogEntries = useMemo(() => catalog?.entries ?? [], [catalog]);
  const providerOptions = useMemo(
    () => uniqueSorted(catalogEntries.map((entry) => entry.provider)),
    [catalogEntries],
  );
  const providerEntries = useMemo(
    () => catalogEntries.filter((entry) => entry.provider === provider),
    [catalogEntries, provider],
  );
  const exactProviderEntries = useMemo(
    () => providerEntries.filter(
      (entry) => entry.matchType.toLowerCase() !== "glob" && !entry.model.includes("*"),
    ),
    [providerEntries],
  );
  const selectableProviderEntries = exactProviderEntries.length > 0
    ? exactProviderEntries
    : providerEntries;
  const modelOptions = useMemo(
    () => uniqueSorted(selectableProviderEntries.map((entry) => entry.model)),
    [selectableProviderEntries],
  );
  const modelEntries = useMemo(
    () => providerEntries.filter((entry) => entry.model === model),
    [model, providerEntries],
  );
  const regionOptions = useMemo(
    () => uniqueSorted(modelEntries.map((entry) => entry.region)),
    [modelEntries],
  );
  const regionEntries = useMemo(
    () => modelEntries.filter((entry) => entry.region === region),
    [modelEntries, region],
  );
  const serviceTierOptions = useMemo(
    () => uniqueSorted(regionEntries.map((entry) => entry.serviceTier)),
    [regionEntries],
  );
  const selectedCatalogEntry = useMemo<WundershipPricingCatalogEntry | undefined>(
    () => regionEntries.find((entry) => entry.serviceTier === serviceTier),
    [regionEntries, serviceTier],
  );
  const successfulRequests = useMemo(
    () => localRequests.filter((request) => request.status === "success"),
    [localRequests],
  );
  const syncedUsageKeys = useMemo(() => readSyncedUsageKeys(), [syncMessage]);
  const pendingRequests = useMemo(
    () =>
      successfulRequests.filter(
        (request) => !syncedUsageKeys.has(buildUsageKey(request, provider, model)),
      ),
    [model, provider, successfulRequests, syncedUsageKeys],
  );
  const timelinePoints = useMemo(
    () =>
      buildTimeline(
        successfulRequests,
        rates?.inputPerMillion ?? 0,
        rates?.outputPerMillion ?? 0,
        timelineRange,
        localMetrics?.generatedAt,
      ),
    [localMetrics?.generatedAt, rates, successfulRequests, timelineRange],
  );
  const freeTokenCap = summary?.freeTokenCap ?? estimate?.monthlyFreeTokenCap ?? 10_000_000;
  const monthlyAllowanceUnits = summary?.allowanceUnits
    ?? summary?.tokens
    ?? estimate?.monthlyAllowanceUnitsBefore
    ?? estimate?.monthlyTokensBefore
    ?? 0;
  const monthlyRawTokens = summary?.rawTokens ?? estimate?.monthlyTokensBefore ?? 0;
  const remainingAllowanceUnits = summary?.remainingAllowanceUnits
    ?? summary?.remainingFreeTokens
    ?? estimate?.remainingAllowanceUnits
    ?? Math.max(0, freeTokenCap - monthlyAllowanceUnits);
  const allowanceUsedPercent = freeTokenCap > 0
    ? Math.min(100, (monthlyAllowanceUnits / freeTokenCap) * 100)
    : 0;
  const allowanceMultiplier = estimate?.allowanceMultiplier ?? 0;
  const effectiveFreeTokenCap = estimate?.effectiveFreeTokenCap ?? freeTokenCap;
  const currentLocalEstimatedCost = estimate?.estimatedCost ?? 0;
  const currentLocalBillableCost = estimate?.billableCost ?? 0;
  const currency = summary?.currency ?? estimate?.currency ?? rates?.currency ?? "USD";

  const refreshCatalog = useCallback(async () => {
    if (!authenticated) {
      setCatalog(undefined);
      return;
    }
    setLoadingCatalog(true);
    setCatalogErrorMessage(undefined);
    catalogAbortController.current?.abort();
    const abortController = new AbortController();
    catalogAbortController.current = abortController;
    try {
      setCatalog(await getWundershipPricingCatalog(abortController.signal));
    } catch (error) {
      if (!abortController.signal.aborted) {
        setCatalogErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to load the Wundership pricing catalog.",
        );
      }
    } finally {
      if (!abortController.signal.aborted) {
        setLoadingCatalog(false);
      }
    }
  }, [authenticated]);

  const refreshSummary = useCallback(async () => {
    if (!authenticated) {
      setSummary(undefined);
      return;
    }
    setLoadingSummary(true);
    setErrorMessage(undefined);
    requestAbortController.current?.abort();
    const abortController = new AbortController();
    requestAbortController.current = abortController;
    try {
      setSummary(await getWundershipUsageSummary(abortController.signal));
    } catch (error) {
      if (!abortController.signal.aborted) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to load Wundership usage summary.",
        );
      }
    } finally {
      if (!abortController.signal.aborted) {
        setLoadingSummary(false);
      }
    }
  }, [authenticated]);

  const calculatePricing = useCallback(async () => {
    const normalizedProvider = provider.trim();
    const normalizedModel = model.trim();
    if (!authenticated) {
      onSignIn();
      return;
    }
    if (!normalizedProvider || !normalizedModel) {
      setErrorMessage("Provider and model are required for a pricing estimate.");
      return;
    }

    localStorage.setItem(providerStorageKey, normalizedProvider);
    localStorage.setItem(modelStorageKey, normalizedModel);
    localStorage.setItem(regionStorageKey, region.trim() || "global");
    localStorage.setItem(serviceTierStorageKey, serviceTier.trim() || "default");
    setCalculating(true);
    setErrorMessage(undefined);
    setSyncMessage(undefined);
    requestAbortController.current?.abort();
    const abortController = new AbortController();
    requestAbortController.current = abortController;

    const baseRequest = {
      provider: normalizedProvider,
      model: normalizedModel,
      region: region.trim() || "global",
      serviceTier: serviceTier.trim() || "default",
    };
    try {
      if (!selectedCatalogEntry) {
        throw new Error("Select an active provider, model, region, and service tier from the pricing catalog.");
      }
      const [summaryResult, currentResult] = await Promise.all([
        getWundershipUsageSummary(abortController.signal),
        estimateWundershipCloudCost(
          {
            ...baseRequest,
            usage: {
              inputTokens: localInference?.promptTokens ?? 0,
              outputTokens: localInference?.completionTokens ?? 0,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          },
          abortController.signal,
        ),
      ]);
      setSummary(summaryResult);
      setEstimate(currentResult);
      setRates({
        inputPerMillion: finiteNumber(selectedCatalogEntry.inputPerMillion),
        outputPerMillion: finiteNumber(selectedCatalogEntry.outputPerMillion),
        currency: selectedCatalogEntry.currency,
        pricingVersion: selectedCatalogEntry.pricingVersion,
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to calculate Wundership pricing.",
        );
      }
    } finally {
      if (!abortController.signal.aborted) {
        setCalculating(false);
      }
    }
  }, [authenticated, localInference, model, onSignIn, provider, region, selectedCatalogEntry, serviceTier]);

  const syncLocalUsage = useCallback(async () => {
    const normalizedProvider = provider.trim();
    const normalizedModel = model.trim();
    if (!authenticated) {
      onSignIn();
      return;
    }
    if (!normalizedProvider || !normalizedModel) {
      setErrorMessage("Provider and model are required before usage can be synchronized.");
      return;
    }
    if (pendingRequests.length === 0) {
      setSyncMessage("All successful local requests in this metrics window are already synchronized.");
      return;
    }

    const usageEvents: WundershipUsageEvent[] = pendingRequests.map((request) => ({
      schemaVersion: 1,
      idempotencyKey: buildUsageKey(request, normalizedProvider, normalizedModel),
      source: "openmodel-web-local",
      provider: normalizedProvider,
      model: normalizedModel,
      region: region.trim() || "global",
      serviceTier: serviceTier.trim() || "default",
      usage: {
        inputTokens: request.promptTokens,
        outputTokens: request.completionTokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      occurredAt: request.completedAt,
    }));

    setSyncing(true);
    setErrorMessage(undefined);
    setSyncMessage(undefined);
    requestAbortController.current?.abort();
    const abortController = new AbortController();
    requestAbortController.current = abortController;
    try {
      await submitWundershipUsageEvents(usageEvents, abortController.signal);
      const updatedSyncedUsageKeys = readSyncedUsageKeys();
      usageEvents.forEach((event) => updatedSyncedUsageKeys.add(event.idempotencyKey));
      writeSyncedUsageKeys(updatedSyncedUsageKeys);
      setSyncMessage(`${usageEvents.length} local usage event${usageEvents.length === 1 ? "" : "s"} synchronized with Wundership.`);
      setSummary(await getWundershipUsageSummary(abortController.signal));
    } catch (error) {
      if (!abortController.signal.aborted) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Unable to synchronize local usage with Wundership.",
        );
      }
    } finally {
      if (!abortController.signal.aborted) {
        setSyncing(false);
      }
    }
  }, [authenticated, model, onSignIn, pendingRequests, provider, region, serviceTier]);

  useEffect(() => {
    void refreshCatalog();
    void refreshSummary();
    return () => {
      catalogAbortController.current?.abort();
      requestAbortController.current?.abort();
    };
  }, [refreshCatalog, refreshSummary]);

  useEffect(() => {
    if (providerOptions.length > 0 && !providerOptions.includes(provider)) {
      setProvider(providerOptions[0]);
    }
  }, [provider, providerOptions]);

  useEffect(() => {
    if (modelOptions.length > 0 && !modelOptions.includes(model)) {
      setModel(modelOptions[0]);
    }
  }, [model, modelOptions]);

  useEffect(() => {
    if (regionOptions.length > 0 && !regionOptions.includes(region)) {
      setRegion(regionOptions[0]);
    }
  }, [region, regionOptions]);

  useEffect(() => {
    if (serviceTierOptions.length > 0 && !serviceTierOptions.includes(serviceTier)) {
      setServiceTier(serviceTierOptions[0]);
    }
  }, [serviceTier, serviceTierOptions]);

  useEffect(() => {
    localStorage.setItem(providerStorageKey, provider);
    localStorage.setItem(modelStorageKey, model);
    localStorage.setItem(regionStorageKey, region);
    localStorage.setItem(serviceTierStorageKey, serviceTier);
  }, [model, provider, region, serviceTier]);

  useEffect(() => {
    localStorage.setItem(timelineRangeStorageKey, timelineRange);
  }, [timelineRange]);

  useEffect(() => {
    if (!selectedCatalogEntry) {
      return;
    }
    setRates({
      inputPerMillion: finiteNumber(selectedCatalogEntry.inputPerMillion),
      outputPerMillion: finiteNumber(selectedCatalogEntry.outputPerMillion),
      currency: selectedCatalogEntry.currency,
      pricingVersion: selectedCatalogEntry.pricingVersion,
    });
    setEstimate(undefined);
  }, [selectedCatalogEntry]);

  return (
    <section className="dashboard-pricing-section">
      <div className="dashboard-metrics-cloud-heading dashboard-pricing-heading">
        <div>
          <span className="dashboard-panel-kicker">WUNDERSHIP PRICING ENGINE</span>
          <h3>USAGE &amp; PRICING</h3>
          <p>
            Compare local inference with provider pricing, review the monthly free allowance,
            and synchronize selected local usage events after authentication.
          </p>
        </div>
        <div className="dashboard-pricing-heading-actions">
          <Button
            variant="outline"
            disabled={!authenticated || loadingSummary}
            onClick={() => void refreshSummary()}
          >
            {loadingSummary ? "REFRESHING" : "REFRESH ALLOWANCE"}
          </Button>
          <Button
            disabled={calculating || (authenticated && !selectedCatalogEntry)}
            onClick={() => void calculatePricing()}
          >
            {calculating ? "CALCULATING" : "CALCULATE PRICING"}
          </Button>
        </div>
      </div>

      {!authenticated ? (
        <Card className="dashboard-pricing-auth-card">
          <div>
            <span className="dashboard-panel-kicker">LOCAL METRICS REMAIN AVAILABLE</span>
            <h3>SIGN IN FOR WUNDERSHIP PRICING</h3>
            <p>
              Local token, latency, throughput, and request charts continue to work offline.
              Authentication is required only for pricing estimates, allowance totals, and usage synchronization.
            </p>
          </div>
          <Button onClick={onSignIn}>SIGN IN</Button>
        </Card>
      ) : null}

      {errorMessage ? (
        <div className="authentication-notice authentication-notice-error dashboard-notice">
          <span>PRICING_API_ERROR</span>
          <strong>{errorMessage}</strong>
          <button type="button" onClick={() => setErrorMessage(undefined)}>DISMISS</button>
        </div>
      ) : null}

      {catalogErrorMessage ? (
        <div className="authentication-notice authentication-notice-error dashboard-notice">
          <span>PRICING_CATALOG_ERROR</span>
          <strong>{catalogErrorMessage}</strong>
          <button type="button" onClick={() => setCatalogErrorMessage(undefined)}>DISMISS</button>
        </div>
      ) : null}

      {syncMessage ? (
        <div className="authentication-notice dashboard-notice dashboard-pricing-success">
          <span>USAGE_SYNC</span>
          <strong>{syncMessage}</strong>
          <button type="button" onClick={() => setSyncMessage(undefined)}>DISMISS</button>
        </div>
      ) : null}

      <Card className="dashboard-pricing-config-card">
        <div className="dashboard-panel-heading">
          <div>
            <span className="dashboard-panel-kicker">PROVIDER PROFILE</span>
            <h3>PRICING LOOKUP</h3>
          </div>
          <div className="dashboard-pricing-catalog-status">
            <code>{getWundershipApiBaseUrl()}</code>
            <button
              type="button"
              disabled={!authenticated || loadingCatalog}
              onClick={() => void refreshCatalog()}
            >
              {loadingCatalog ? "LOADING CATALOG" : "REFRESH CATALOG"}
            </button>
          </div>
        </div>
        <div className="dashboard-pricing-form-grid">
          <FilterableSelect
            label="PROVIDER"
            value={provider}
            options={providerOptions}
            disabled={!authenticated || loadingCatalog}
            loading={loadingCatalog}
            onChange={setProvider}
          />
          <FilterableSelect
            label="MODEL"
            value={model}
            options={modelOptions}
            disabled={!authenticated || loadingCatalog || providerOptions.length === 0}
            loading={loadingCatalog}
            onChange={setModel}
          />
          <FilterableSelect
            label="REGION"
            value={region}
            options={regionOptions}
            disabled={!authenticated || loadingCatalog || modelOptions.length === 0}
            loading={loadingCatalog}
            onChange={setRegion}
          />
          <FilterableSelect
            label="SERVICE TIER"
            value={serviceTier}
            options={serviceTierOptions}
            disabled={!authenticated || loadingCatalog || regionOptions.length === 0}
            loading={loadingCatalog}
            onChange={setServiceTier}
          />
        </div>
        <p className="dashboard-pricing-config-note">
          Select from {formatInteger(providerOptions.length)} providers and {formatInteger(catalogEntries.length)} active pricing profiles.
          The selected profile is the cloud comparison and synchronization target for this browser session.
          Local model files and prompt/response content are never included in usage events.
          The allowance is cost weighted: expensive models consume allowance units faster, while cheaper models receive more room for experimentation.
        </p>
      </Card>

      <div className="dashboard-pricing-summary-grid">
        <Card className="dashboard-metric-card">
          <span>FREE ALLOWANCE</span>
          <strong title={formatExactInteger(freeTokenCap)}>{formatInteger(freeTokenCap)}</strong>
          <small>COST-WEIGHTED UNITS / MONTH</small>
        </Card>
        <Card className="dashboard-metric-card">
          <span>ALLOWANCE USAGE</span>
          <strong title={formatExactInteger(monthlyAllowanceUnits)}>{formatInteger(monthlyAllowanceUnits)}</strong>
          <small>{formatDateRange(summary?.periodStart, summary?.periodEnd)}</small>
        </Card>
        <Card className="dashboard-metric-card">
          <span>REMAINING ALLOWANCE</span>
          <strong title={formatExactInteger(remainingAllowanceUnits)}>{formatInteger(remainingAllowanceUnits)}</strong>
          <small>{allowanceUsedPercent.toFixed(1)}% USED</small>
        </Card>
        <Card className="dashboard-metric-card">
          <span>BILLABLE USAGE</span>
          <strong title={formatExactInteger(estimate?.billableTokens ?? 0)}>{formatInteger(estimate?.billableTokens ?? 0)}</strong>
          <small>{summary?.meteringActive ? "METERING ACTIVE" : "WITHIN ALLOWANCE"}</small>
        </Card>
        <Card className="dashboard-metric-card">
          <span>PROVIDER COST</span>
          <strong>{formatCurrency(currentLocalEstimatedCost, currency)}</strong>
          <small>CURRENT LOCAL TOKEN MIX</small>
        </Card>
        <Card className="dashboard-metric-card">
          <span>BILLABLE COST</span>
          <strong>{formatCurrency(summary?.billableCost ?? currentLocalBillableCost, currency)}</strong>
          <small>AFTER FREE ALLOWANCE</small>
        </Card>
      </div>

      <Card className="dashboard-pricing-allowance-card">
        <div className="dashboard-pricing-allowance-header">
          <div>
            <span>COST-WEIGHTED MONTHLY ALLOWANCE</span>
            <strong>{formatInteger(monthlyAllowanceUnits)} / {formatInteger(freeTokenCap)}</strong>
          </div>
          <span>{formatInteger(remainingAllowanceUnits)} REMAINING</span>
        </div>
        <div className="dashboard-pricing-allowance-track" aria-label={`${allowanceUsedPercent.toFixed(1)} percent of monthly allowance used`}>
          <i style={{ width: `${allowanceUsedPercent}%` }}></i>
        </div>
      </Card>

      <div className="dashboard-pricing-rate-grid">
        <Card className="dashboard-pricing-rate-card">
          <span>INPUT RATE</span>
          <strong>{rates ? formatCurrency(rates.inputPerMillion, rates.currency) : "--"}</strong>
          <small>PER 1M TOKENS</small>
        </Card>
        <Card className="dashboard-pricing-rate-card">
          <span>OUTPUT RATE</span>
          <strong>{rates ? formatCurrency(rates.outputPerMillion, rates.currency) : "--"}</strong>
          <small>PER 1M TOKENS</small>
        </Card>
        <Card className="dashboard-pricing-rate-card">
          <span>MODEL ALLOWANCE WEIGHT</span>
          <strong>{formatMultiplier(allowanceMultiplier)}</strong>
          <small>{allowanceMultiplier > 1 ? "BILLS EARLIER" : allowanceMultiplier > 0 ? "MORE EXPERIMENTATION" : "CALCULATE TO LOAD"}</small>
        </Card>
        <Card className="dashboard-pricing-rate-card">
          <span>EFFECTIVE MODEL CAP</span>
          <strong title={formatExactInteger(effectiveFreeTokenCap)}>{formatInteger(effectiveFreeTokenCap)}</strong>
          <small>RAW TOKENS AT CURRENT MIX</small>
        </Card>
        <Card className="dashboard-pricing-rate-card">
          <span>RAW MONTHLY TOKENS</span>
          <strong title={formatExactInteger(monthlyRawTokens)}>{formatInteger(monthlyRawTokens)}</strong>
          <small>UNWEIGHTED USAGE</small>
        </Card>
        <Card className="dashboard-pricing-rate-card">
          <span>PRICING VERSION</span>
          <strong title={rates?.pricingVersion}>{rates?.pricingVersion ?? "CALCULATE TO LOAD"}</strong>
          <small>{estimate ? `${estimate.provider} / ${estimate.model}` : "EFFECTIVE-DATED CATALOG"}</small>
        </Card>
        <Card className="dashboard-pricing-rate-card">
          <span>SYNC STATUS</span>
          <strong title={formatExactInteger(pendingRequests.length)}>{formatInteger(pendingRequests.length)}</strong>
          <small>LOCAL EVENTS PENDING</small>
        </Card>
      </div>

      <div className="dashboard-pricing-comparison-grid">
        <Card className="dashboard-pricing-comparison-card dashboard-pricing-comparison-local">
          <span>LOCAL OPENMODEL</span>
          <strong>{formatCurrency(0, currency)}</strong>
          <p>
            No cloud provider token charge. Hardware, electricity, and operational costs are not estimated here.
          </p>
        </Card>
        <Card className="dashboard-pricing-comparison-card">
          <span>{provider || "CLOUD PROVIDER"}</span>
          <strong>{formatCurrency(currentLocalEstimatedCost, currency)}</strong>
          <p>
            Estimated provider token cost for {formatInteger(localInference?.promptTokens)} input and {formatInteger(localInference?.completionTokens)} output tokens.
          </p>
        </Card>
        <Card className="dashboard-pricing-comparison-card">
          <span>AFTER ALLOWANCE</span>
          <strong>{formatCurrency(currentLocalBillableCost, currency)}</strong>
          <p>
            Estimated billable portion of the current local token mix after the monthly free allowance is applied.
          </p>
        </Card>
      </div>

      <div className="dashboard-pricing-chart-grid">
        <Card className="dashboard-pricing-chart-card">
          <div className="dashboard-panel-heading dashboard-pricing-chart-heading">
            <div>
              <span className="dashboard-panel-kicker">USAGE OVER TIME</span>
              <h3>CUMULATIVE TOKENS &amp; COST</h3>
            </div>
            <div className="dashboard-pricing-chart-controls">
              <span>{timelineWindowLabel(timelineRange, localMetrics?.generatedAt)}</span>
              <div className="dashboard-pricing-range-selector" aria-label="Usage chart time range">
                {timelineRanges.map((range) => (
                  <button
                    type="button"
                    className={timelineRange === range ? "is-active" : ""}
                    onClick={() => setTimelineRange(range)}
                    aria-pressed={timelineRange === range}
                    key={range}
                  >
                    {range.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <UsageLineChart points={timelinePoints} range={timelineRange} />
        </Card>
        <Card className="dashboard-pricing-chart-card">
          <div className="dashboard-panel-heading">
            <div>
              <span className="dashboard-panel-kicker">RANGE PROFILE</span>
              <h3>TOKENS &amp; CLOUD COST</h3>
            </div>
          </div>
          <UsageBarChart points={timelinePoints} currency={currency} range={timelineRange} />
        </Card>
      </div>

      <Card className="dashboard-pricing-sync-card">
        <div>
          <span className="dashboard-panel-kicker">WUNDERSHIP-SYNCHRONIZED USAGE</span>
          <h3>SYNC SUCCESSFUL LOCAL REQUESTS</h3>
          <p>
            Sends token counts, timestamps, provider/model mapping, and an idempotency key.
            Prompt text, response text, model weights, latency, and local runtime details stay local.
          </p>
        </div>
        <div className="dashboard-pricing-sync-actions">
          <span>{formatInteger(pendingRequests.length)} PENDING · {formatInteger(successfulRequests.length - pendingRequests.length)} SYNCED</span>
          <Button
            disabled={!authenticated || syncing || pendingRequests.length === 0}
            onClick={() => void syncLocalUsage()}
          >
            {syncing ? "SYNCHRONIZING" : "SYNC LOCAL USAGE"}
          </Button>
        </div>
      </Card>
    </section>
  );
}
