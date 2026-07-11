import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalMetricsStore, estimateTokenCount } from '../src/lib/metrics.js';

test('estimates tokens without storing prompt content', () => {
  assert.equal(estimateTokenCount(''), 0);
  assert.ok(estimateTokenCount('Reply with exactly: OpenModel is ready') > 0);
});

test('tracks successful local inference metrics', () => {
  let now = 1000;
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    const metrics = createLocalMetricsStore({ serverStartedAtMs: 0 });
    const request = metrics.beginInference({
      endpoint: '/v1/chat/completions',
      modelId: 'test-model',
      prompt: 'Hello from OpenModel'
    });
    metrics.setRuntime(request, 'llama.cpp');
    now = 1500;
    const usage = metrics.completeInference(request, 'Hello back');
    const snapshot = metrics.snapshot({
      manifests: [{ storedId: 'test-model' }],
      runtimeStatus: { models: [{ id: 'test-model', runnable: true }] },
      modelStorageBytes: 1024,
      installJobs: []
    });

    assert.equal(snapshot.inference.totalRequests, 1);
    assert.equal(snapshot.inference.successfulRequests, 1);
    assert.equal(snapshot.inference.failedRequests, 0);
    assert.equal(snapshot.inference.activeRequests, 0);
    assert.equal(snapshot.inference.totalTokens, usage.totalTokens);
    assert.equal(snapshot.inference.averageLatencyMs, 500);
    assert.equal(snapshot.models.installedCount, 1);
    assert.equal(snapshot.models.runnableCount, 1);
    assert.equal(snapshot.models.storageBytes, 1024);
    assert.equal(snapshot.models.byModel[0].runtimeId, 'llama.cpp');
    assert.equal(snapshot.recentRequests[0].status, 'success');
    assert.equal(snapshot.privacy.promptContentStored, false);
    assert.equal(snapshot.privacy.responseContentStored, false);
  } finally {
    Date.now = originalDateNow;
  }
});

test('tracks failed and cancelled inference separately', () => {
  const metrics = createLocalMetricsStore();
  const failedRequest = metrics.beginInference({ modelId: 'test-model', prompt: 'fail' });
  metrics.failInference(failedRequest, new Error('runtime failed'));

  const cancelledRequest = metrics.beginInference({ modelId: 'test-model', prompt: 'cancel' });
  const abortError = new Error('cancelled');
  abortError.name = 'AbortError';
  metrics.failInference(cancelledRequest, abortError);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.inference.totalRequests, 2);
  assert.equal(snapshot.inference.failedRequests, 1);
  assert.equal(snapshot.inference.cancelledRequests, 1);
  assert.equal(snapshot.inference.totalTokens, 0);
  assert.equal(snapshot.recentRequests[0].status, 'cancelled');
  assert.equal(snapshot.recentRequests[1].status, 'error');
});
