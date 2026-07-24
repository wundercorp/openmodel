import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyUsageReport,
  calculateEffectiveAvailableGpuCount,
  createEarning,
  createPayout,
  createReservation,
  transitionReservation,
  validateGpuCapacitySubmission,
  validatePayoutProfile,
  validateProviderNodeSubmission
} from '../src/index.js';

const now = new Date('2026-07-24T12:00:00.000Z');

function nodeFixture() {
  return validateProviderNodeSubmission({
    name: 'worker-1', gpuModel: 'NVIDIA H100 80GB', gpuCount: 8,
    availableGpuCount: 8, vramGbPerGpu: 80, healthStatus: 'READY'
  }, {
    id: 'node-1', ownerId: 'provider-1', ownerDisplayName: 'Provider', tokenHash: 'hash', tokenLastFour: '1234', lastHeartbeatAt: now.toISOString()
  }, { now });
}

function listingFixture() {
  return validateGpuCapacitySubmission({
    workerNodeId: 'node-1', gpuModel: 'NVIDIA H100 80GB', gpuCount: 8,
    availableGpuCount: 8, vramGbPerGpu: 80, allocationMode: 'EXCLUSIVE',
    connectionMode: 'OPENMODEL_API', pricePerGpuHour: 2.5, minimumHours: 1,
    maxSessionHours: 12, currency: 'USD', publish: true
  }, {
    id: 'listing-1', ownerId: 'provider-1', ownerDisplayName: 'Provider', status: 'PUBLISHED'
  }, { now, platformFeeBps: 1000 });
}

test('creates a master-managed reservation with fee and provider earnings snapshots', () => {
  const reservation = createReservation({
    gpuCount: 2, requestedHours: 4, fundingReference: 'auth_123',
    workloadReference: 'oci://registry.example/workload@sha256:abc'
  }, listingFixture(), nodeFixture(), { sub: 'buyer-1', name: 'Hyperscaler' }, { id: 'reservation-1' }, { now });
  assert.equal(reservation.status, 'ASSIGNED');
  assert.equal(reservation.grossAuthorizedAmount, 20);
  assert.equal(reservation.platformFeeAuthorizedAmount, 2);
  assert.equal(reservation.providerAuthorizedAmount, 18);
});

test('rejects workload metadata containing secrets', () => {
  assert.throws(() => createReservation({
    gpuCount: 1, requestedHours: 1, fundingReference: 'auth_123',
    workloadReference: 'session:1', workloadMetadata: { apiToken: 'secret' }
  }, listingFixture(), nodeFixture(), { sub: 'buyer-1' }, { id: 'reservation-1' }, { now }), /must not contain secrets/);
});

test('enforces reservation state and monotonic metering', () => {
  let reservation = createReservation({
    gpuCount: 1, requestedHours: 2, fundingReference: 'auth_123', workloadReference: 'session:1'
  }, listingFixture(), nodeFixture(), { sub: 'buyer-1' }, { id: 'reservation-1' }, { now });
  reservation = transitionReservation(reservation, 'accept', {}, { now: new Date(now.getTime() + 1000) });
  reservation = transitionReservation(reservation, 'start', {}, { now: new Date(now.getTime() + 2000) });
  reservation = applyUsageReport(reservation, { sequence: 1, cumulativeBillableSeconds: 1800 }, { now: new Date(now.getTime() + 1802000) });
  assert.equal(reservation.providerAmount, 1.125);
  assert.throws(() => applyUsageReport(reservation, { sequence: 1, cumulativeBillableSeconds: 1800 }), /sequence must increase/);
});

test('creates held earnings for failures and pending earnings for completions', () => {
  let reservation = createReservation({
    gpuCount: 1, requestedHours: 2, fundingReference: 'auth_123', workloadReference: 'session:1'
  }, listingFixture(), nodeFixture(), { sub: 'buyer-1' }, { id: 'reservation-1' }, { now });
  reservation = transitionReservation(reservation, 'accept', {}, { now: new Date(now.getTime() + 1000) });
  reservation = transitionReservation(reservation, 'start', {}, { now: new Date(now.getTime() + 2000) });
  reservation = transitionReservation(reservation, 'complete', { sequence: 1, cumulativeBillableSeconds: 3600 }, { now: new Date(now.getTime() + 3602000) });
  const earning = createEarning(reservation, { id: 'earning-1' }, { now });
  assert.equal(earning.status, 'PENDING');
  assert.equal(earning.netAmount, 2.25);
});

test('requires tokenized payout destinations and whole earning records', () => {
  const profile = validatePayoutProfile({ method: 'STRIPE_CONNECT', destinationReference: 'acct_12345', status: 'VERIFIED' }, 'provider-1', undefined, { now, allowStatusOverride: true });
  const earning = {
    recordType: 'GPU_EARNING', id: 'earning-1', providerId: 'provider-1', reservationId: 'reservation-1',
    status: 'AVAILABLE', netAmount: 30, grossAmount: 33.333333, platformFeeAmount: 3.333333,
    currency: 'USD', availableAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1
  };
  const result = createPayout({ currency: 'USD' }, profile, [earning], { id: 'payout-1' }, { now, minimumPayoutAmount: 25 });
  assert.equal(result.payout.amount, 30);
  assert.equal(result.earnings[0].status, 'PAYOUT_PENDING');
});

test('keeps provider-reported capacity separate from master reservations', () => {
  const node = validateProviderNodeSubmission({
    name: 'worker-1', gpuModel: 'NVIDIA H100 80GB', gpuCount: 8,
    availableGpuCount: 8, vramGbPerGpu: 80, healthStatus: 'READY'
  }, {
    id: 'node-1', ownerId: 'provider-1', ownerDisplayName: 'Provider', tokenHash: 'hash', tokenLastFour: '1234',
    lastHeartbeatAt: now.toISOString(), reservedGpuCount: 3
  }, { now });
  assert.equal(node.reportedAvailableGpuCount, 8);
  assert.equal(node.reservedGpuCount, 3);
  assert.equal(node.availableGpuCount, 5);
});

test('rejects reservations when effective worker capacity is exhausted', () => {
  const node = { ...nodeFixture(), availableGpuCount: 0, reservedGpuCount: 8 };
  assert.throws(() => createReservation({
    gpuCount: 1, requestedHours: 1, fundingReference: 'auth_123', workloadReference: 'session:1'
  }, listingFixture(), node, { sub: 'buyer-1' }, { id: 'reservation-1' }, { now }), /No GPU capacity/);
});

test('expires only assignments whose acceptance deadline has passed', () => {
  const reservation = createReservation({
    gpuCount: 1, requestedHours: 1, fundingReference: 'auth_123', workloadReference: 'session:1'
  }, listingFixture(), nodeFixture(), { sub: 'buyer-1' }, { id: 'reservation-1' }, { now, assignmentTimeoutSeconds: 60 });
  assert.throws(() => transitionReservation(reservation, 'expire', {}, { now: new Date(now.getTime() + 30_000) }), /has not expired/);
  const expired = transitionReservation(reservation, 'expire', {}, { now: new Date(now.getTime() + 61_000) });
  assert.equal(expired.status, 'EXPIRED');
});

test('does not let providers override the hyperscaler fee snapshot', () => {
  const listing = validateGpuCapacitySubmission({
    workerNodeId: 'node-1', gpuModel: 'NVIDIA H100 80GB', gpuCount: 8,
    availableGpuCount: 8, vramGbPerGpu: 80, allocationMode: 'EXCLUSIVE',
    connectionMode: 'OPENMODEL_API', pricePerGpuHour: 2.5, platformFeeBps: 0
  }, {
    id: 'listing-1', ownerId: 'provider-1', ownerDisplayName: 'Provider', status: 'PUBLISHED'
  }, { now, platformFeeBps: 1250 });
  assert.equal(listing.platformFeeBps, 1250);
});

test('resets payout verification when the destination changes', () => {
  const existing = validatePayoutProfile({ method: 'STRIPE_CONNECT', destinationReference: 'acct_old' }, 'provider-1', undefined, { now });
  existing.status = 'VERIFIED';
  const updated = validatePayoutProfile({ method: 'STRIPE_CONNECT', destinationReference: 'acct_new', status: 'VERIFIED' }, 'provider-1', existing, { now });
  assert.equal(updated.status, 'PENDING_VERIFICATION');
});

test('rejects payout amounts that would over-claim an earning record', () => {
  const profile = validatePayoutProfile({ method: 'STRIPE_CONNECT', destinationReference: 'acct_12345', status: 'VERIFIED' }, 'provider-1', undefined, { now, allowStatusOverride: true });
  const earnings = [30, 40].map((netAmount, index) => ({
    recordType: 'GPU_EARNING', id: `earning-${index}`, providerId: 'provider-1', reservationId: `reservation-${index}`,
    status: 'AVAILABLE', netAmount, grossAmount: netAmount, platformFeeAmount: 0,
    currency: 'USD', availableAt: new Date(now.getTime() + index).toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1
  }));
  assert.throws(() => createPayout({ currency: 'USD', amount: 50 }, profile, earnings, { id: 'payout-1' }, { now, minimumPayoutAmount: 25 }), /oldest whole earning records/);
});


test('rejects invalid payout profile verification states', () => {
  assert.throws(() => validatePayoutProfile({ method: 'STRIPE_CONNECT', destinationReference: 'acct_12345', status: 'APPROVED' }, 'provider-1', undefined, { now, allowStatusOverride: true }), /status must be one of/);
});


test('rejects zero-value payouts even when the configured minimum is zero', () => {
  const profile = validatePayoutProfile({ method: 'STRIPE_CONNECT', destinationReference: 'acct_12345', status: 'VERIFIED' }, 'provider-1', undefined, { now, allowStatusOverride: true });
  const earning = {
    recordType: 'GPU_EARNING', id: 'earning-zero', providerId: 'provider-1', reservationId: 'reservation-zero',
    status: 'AVAILABLE', netAmount: 0, grossAmount: 0, platformFeeAmount: 0,
    currency: 'USD', availableAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1
  };
  assert.throws(() => createPayout({ currency: 'USD' }, profile, [earning], { id: 'payout-zero' }, { now, minimumPayoutAmount: 0 }), /No positive USD earnings/);
});


test('does not restore capacity above the worker latest reported availability', () => {
  assert.equal(calculateEffectiveAvailableGpuCount(8, 0, 0), 0);
  assert.equal(calculateEffectiveAvailableGpuCount(8, 2, 0), 2);
  assert.equal(calculateEffectiveAvailableGpuCount(8, 8, 3), 5);
});
