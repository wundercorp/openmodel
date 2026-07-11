const defaultRecentRequestLimit = 100;
const defaultLatencySampleLimit = 500;

function clampInteger(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(numericValue));
}

function roundMetric(value, fractionDigits = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  const multiplier = 10 ** fractionDigits;
  return Math.round(numericValue * multiplier) / multiplier;
}

function calculatePercentile(values, percentile) {
  if (values.length === 0) {
    return 0;
  }
  const sortedValues = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1)
  );
  return sortedValues[index];
}

export function estimateTokenCount(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return 0;
  }

  const characterCount = [...text].length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const characterEstimate = characterCount / 4;
  const wordEstimate = wordCount * 1.25;
  return Math.max(1, Math.ceil(Math.max(characterEstimate, wordEstimate)));
}

function createModelMetrics(modelId) {
  return {
    modelId,
    runtimeId: undefined,
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    cancelledRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastUsedAt: undefined,
    totalCompletionSeconds: 0
  };
}

function serializeModelMetrics(modelMetrics) {
  const completedRequests = modelMetrics.successfulRequests;
  const averageLatencyMs = completedRequests > 0
    ? modelMetrics.totalLatencyMs / completedRequests
    : 0;
  const averageTokensPerSecond = modelMetrics.totalCompletionSeconds > 0
    ? modelMetrics.completionTokens / modelMetrics.totalCompletionSeconds
    : 0;

  return {
    modelId: modelMetrics.modelId,
    runtimeId: modelMetrics.runtimeId,
    requests: modelMetrics.requests,
    successfulRequests: modelMetrics.successfulRequests,
    failedRequests: modelMetrics.failedRequests,
    cancelledRequests: modelMetrics.cancelledRequests,
    promptTokens: modelMetrics.promptTokens,
    completionTokens: modelMetrics.completionTokens,
    totalTokens: modelMetrics.totalTokens,
    averageLatencyMs: roundMetric(averageLatencyMs),
    maxLatencyMs: clampInteger(modelMetrics.maxLatencyMs),
    averageTokensPerSecond: roundMetric(averageTokensPerSecond, 2),
    lastUsedAt: modelMetrics.lastUsedAt
  };
}

function isCancelledError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export function createLocalMetricsStore(options = {}) {
  const recentRequestLimit = Math.max(
    10,
    clampInteger(options.recentRequestLimit ?? defaultRecentRequestLimit)
  );
  const latencySampleLimit = Math.max(
    50,
    clampInteger(options.latencySampleLimit ?? defaultLatencySampleLimit)
  );
  const serverStartedAtMs = Number(options.serverStartedAtMs ?? Date.now());
  let metricsStartedAtMs = serverStartedAtMs;
  let requestSequence = 0;
  let activeRequests = 0;
  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  let cancelledRequests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalLatencyMs = 0;
  let maxLatencyMs = 0;
  let totalCompletionSeconds = 0;
  let lastRequestAt;
  let lastSuccessAt;
  let lastFailureAt;
  let latencySamples = [];
  let recentRequests = [];
  let modelMetricsById = new Map();

  function getOrCreateModelMetrics(modelId) {
    const normalizedModelId = String(modelId || 'unknown');
    let modelMetrics = modelMetricsById.get(normalizedModelId);
    if (!modelMetrics) {
      modelMetrics = createModelMetrics(normalizedModelId);
      modelMetricsById.set(normalizedModelId, modelMetrics);
    }
    return modelMetrics;
  }

  function appendRecentRequest(record) {
    recentRequests = [record, ...recentRequests].slice(0, recentRequestLimit);
  }

  function beginInference(input = {}) {
    const startedAtMs = Date.now();
    const modelId = String(input.modelId || 'unknown');
    const promptTokenCount = estimateTokenCount(input.prompt);
    const modelMetrics = getOrCreateModelMetrics(modelId);

    requestSequence += 1;
    activeRequests += 1;
    totalRequests += 1;
    lastRequestAt = new Date(startedAtMs).toISOString();

    modelMetrics.requests += 1;
    modelMetrics.lastUsedAt = lastRequestAt;

    return {
      id: `inference-${startedAtMs}-${requestSequence}`,
      endpoint: String(input.endpoint || '/v1/chat/completions'),
      modelId,
      runtimeId: input.runtimeId ? String(input.runtimeId) : undefined,
      promptTokens: promptTokenCount,
      startedAtMs,
      startedAt: lastRequestAt,
      completed: false
    };
  }

  function setRuntime(handle, runtimeId) {
    if (!handle || handle.completed || !runtimeId) {
      return;
    }
    handle.runtimeId = String(runtimeId);
    const modelMetrics = getOrCreateModelMetrics(handle.modelId);
    modelMetrics.runtimeId = handle.runtimeId;
  }

  function completeInference(handle, output) {
    if (!handle || handle.completed) {
      return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        tokensPerSecond: 0,
        estimated: true
      };
    }

    handle.completed = true;
    activeRequests = Math.max(0, activeRequests - 1);
    successfulRequests += 1;

    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs).toISOString();
    const latencyMs = Math.max(0, completedAtMs - handle.startedAtMs);
    const completionTokenCount = estimateTokenCount(output);
    const totalTokenCount = handle.promptTokens + completionTokenCount;
    const completionSeconds = latencyMs > 0 ? latencyMs / 1000 : 0;
    const tokensPerSecond = completionSeconds > 0
      ? completionTokenCount / completionSeconds
      : 0;

    promptTokens += handle.promptTokens;
    completionTokens += completionTokenCount;
    totalLatencyMs += latencyMs;
    maxLatencyMs = Math.max(maxLatencyMs, latencyMs);
    totalCompletionSeconds += completionSeconds;
    lastSuccessAt = completedAt;
    latencySamples = [...latencySamples, latencyMs].slice(-latencySampleLimit);

    const modelMetrics = getOrCreateModelMetrics(handle.modelId);
    modelMetrics.runtimeId = handle.runtimeId ?? modelMetrics.runtimeId;
    modelMetrics.successfulRequests += 1;
    modelMetrics.promptTokens += handle.promptTokens;
    modelMetrics.completionTokens += completionTokenCount;
    modelMetrics.totalTokens += totalTokenCount;
    modelMetrics.totalLatencyMs += latencyMs;
    modelMetrics.maxLatencyMs = Math.max(modelMetrics.maxLatencyMs, latencyMs);
    modelMetrics.totalCompletionSeconds += completionSeconds;
    modelMetrics.lastUsedAt = completedAt;

    appendRecentRequest({
      id: handle.id,
      endpoint: handle.endpoint,
      modelId: handle.modelId,
      runtimeId: handle.runtimeId,
      status: 'success',
      promptTokens: handle.promptTokens,
      completionTokens: completionTokenCount,
      totalTokens: totalTokenCount,
      latencyMs: clampInteger(latencyMs),
      tokensPerSecond: roundMetric(tokensPerSecond, 2),
      startedAt: handle.startedAt,
      completedAt
    });

    return {
      promptTokens: handle.promptTokens,
      completionTokens: completionTokenCount,
      totalTokens: totalTokenCount,
      latencyMs: clampInteger(latencyMs),
      tokensPerSecond: roundMetric(tokensPerSecond, 2),
      estimated: true
    };
  }

  function failInference(handle, error) {
    if (!handle || handle.completed) {
      return;
    }

    handle.completed = true;
    activeRequests = Math.max(0, activeRequests - 1);

    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs).toISOString();
    const latencyMs = Math.max(0, completedAtMs - handle.startedAtMs);
    const cancelled = isCancelledError(error);

    if (cancelled) {
      cancelledRequests += 1;
    } else {
      failedRequests += 1;
    }
    lastFailureAt = completedAt;

    const modelMetrics = getOrCreateModelMetrics(handle.modelId);
    modelMetrics.runtimeId = handle.runtimeId ?? modelMetrics.runtimeId;
    if (cancelled) {
      modelMetrics.cancelledRequests += 1;
    } else {
      modelMetrics.failedRequests += 1;
    }
    modelMetrics.lastUsedAt = completedAt;

    appendRecentRequest({
      id: handle.id,
      endpoint: handle.endpoint,
      modelId: handle.modelId,
      runtimeId: handle.runtimeId,
      status: cancelled ? 'cancelled' : 'error',
      promptTokens: handle.promptTokens,
      completionTokens: 0,
      totalTokens: handle.promptTokens,
      latencyMs: clampInteger(latencyMs),
      tokensPerSecond: 0,
      error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      startedAt: handle.startedAt,
      completedAt
    });
  }

  function reset() {
    if (activeRequests > 0) {
      const error = new Error('Metrics cannot be reset while inference requests are active.');
      error.code = 'OPENMODEL_METRICS_BUSY';
      throw error;
    }

    metricsStartedAtMs = Date.now();
    requestSequence = 0;
    totalRequests = 0;
    successfulRequests = 0;
    failedRequests = 0;
    cancelledRequests = 0;
    promptTokens = 0;
    completionTokens = 0;
    totalLatencyMs = 0;
    maxLatencyMs = 0;
    totalCompletionSeconds = 0;
    lastRequestAt = undefined;
    lastSuccessAt = undefined;
    lastFailureAt = undefined;
    latencySamples = [];
    recentRequests = [];
    modelMetricsById = new Map();
  }

  function snapshot(context = {}) {
    const nowMs = Date.now();
    const aggregateTotalTokens = promptTokens + completionTokens;
    const completedRequests = successfulRequests;
    const averageLatencyMs = completedRequests > 0
      ? totalLatencyMs / completedRequests
      : 0;
    const averageTokensPerSecond = totalCompletionSeconds > 0
      ? completionTokens / totalCompletionSeconds
      : 0;
    const unsuccessfulRequests = failedRequests + cancelledRequests;
    const errorRate = totalRequests > 0
      ? (unsuccessfulRequests / totalRequests) * 100
      : 0;
    const installJobs = Array.isArray(context.installJobs) ? context.installJobs : [];
    const manifests = Array.isArray(context.manifests) ? context.manifests : [];
    const runtimeModels = Array.isArray(context.runtimeStatus?.models)
      ? context.runtimeStatus.models
      : [];

    return {
      generatedAt: new Date(nowMs).toISOString(),
      scope: 'local',
      privacy: {
        localOnly: true,
        promptContentStored: false,
        responseContentStored: false,
        persistence: 'memory',
        tokenCounting: 'estimated'
      },
      server: {
        startedAt: new Date(serverStartedAtMs).toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((nowMs - serverStartedAtMs) / 1000)),
        metricsStartedAt: new Date(metricsStartedAtMs).toISOString(),
        metricsUptimeSeconds: Math.max(0, Math.floor((nowMs - metricsStartedAtMs) / 1000)),
        host: context.host,
        port: context.port
      },
      inference: {
        activeRequests,
        totalRequests,
        successfulRequests,
        failedRequests,
        cancelledRequests,
        promptTokens,
        completionTokens,
        totalTokens: aggregateTotalTokens,
        averageLatencyMs: roundMetric(averageLatencyMs),
        p50LatencyMs: clampInteger(calculatePercentile(latencySamples, 50)),
        p95LatencyMs: clampInteger(calculatePercentile(latencySamples, 95)),
        maxLatencyMs: clampInteger(maxLatencyMs),
        averageTokensPerSecond: roundMetric(averageTokensPerSecond, 2),
        errorRate: roundMetric(errorRate, 2),
        lastRequestAt,
        lastSuccessAt,
        lastFailureAt
      },
      models: {
        installedCount: manifests.length,
        runnableCount: runtimeModels.filter((model) => model.runnable).length,
        storageBytes: clampInteger(context.modelStorageBytes),
        byModel: [...modelMetricsById.values()]
          .map(serializeModelMetrics)
          .sort((left, right) => right.requests - left.requests)
      },
      installs: {
        active: installJobs.filter((job) => ['queued', 'resolving', 'downloading', 'installing'].includes(job.status)).length,
        completed: installJobs.filter((job) => job.status === 'completed').length,
        failed: installJobs.filter((job) => job.status === 'error').length,
        downloadedBytes: installJobs.reduce(
          (sum, job) => sum + clampInteger(job.downloadedBytes),
          0
        )
      },
      recentRequests
    };
  }

  return {
    beginInference,
    setRuntime,
    completeInference,
    failInference,
    reset,
    snapshot,
    getActiveRequestCount() {
      return activeRequests;
    }
  };
}
