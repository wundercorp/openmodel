import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig, writeConfig } from './config.js';
import { capacityApiRequest, detectNvidiaGpus } from './capacity.js';

function stringFlag(flags, name, fallback = '') {
  const value = flags[name];
  return value === undefined || value === true ? fallback : String(value).trim();
}

function booleanFlag(flags, name) {
  const value = flags[name];
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  const normalizedValue = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) return false;
  throw new Error(`--${name} must be true or false.`);
}

function numberFlag(flags, name, fallback) {
  const value = flags[name];
  const resolvedValue = value === undefined || value === true ? fallback : Number(value);
  if (!Number.isFinite(resolvedValue)) {
    throw new Error(`--${name} must be a number.`);
  }
  return resolvedValue;
}

function integerFlag(flags, name, fallback) {
  const resolvedValue = numberFlag(flags, name, fallback);
  if (!Number.isInteger(resolvedValue)) {
    throw new Error(`--${name} must be an integer.`);
  }
  return resolvedValue;
}

async function resolveNode(nodeId) {
  const config = await readConfig();
  const resolvedNodeId = nodeId || config.provider?.lastNodeId;
  if (!resolvedNodeId) {
    throw new Error('No provider node is selected. Run om provider enroll or pass --node-id.');
  }
  const savedNode = config.provider?.nodes?.[resolvedNodeId];
  if (!savedNode?.token) {
    throw new Error(`No node token is stored for ${resolvedNodeId}. Run om provider rotate-token --node-id ${resolvedNodeId}.`);
  }
  return { config, nodeId: resolvedNodeId, token: savedNode.token, savedNode };
}

export async function enrollProviderNode(flags = {}) {
  const detectedGpu = await detectNvidiaGpus();
  const gpuModel = stringFlag(flags, 'gpu-model', detectedGpu?.gpuModel ?? '');
  const gpuCount = integerFlag(flags, 'gpus', detectedGpu?.gpuCount);
  const vramGbPerGpu = numberFlag(flags, 'vram-gb', detectedGpu?.vramGbPerGpu);
  if (!gpuModel) throw new Error('GPU model was not detected. Pass --gpu-model.');
  if (!gpuCount || gpuCount < 1) throw new Error('GPU count was not detected. Pass --gpus.');
  if (!vramGbPerGpu || vramGbPerGpu <= 0) throw new Error('VRAM was not detected. Pass --vram-gb.');

  const body = {
    name: stringFlag(flags, 'name', `${gpuModel} provider node`),
    gpuModel,
    gpuCount,
    availableGpuCount: integerFlag(flags, 'available-gpus', gpuCount),
    vramGbPerGpu,
    allocationModes: stringFlag(flags, 'allocation-modes', 'EXCLUSIVE').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
    runtime: stringFlag(flags, 'runtime', 'OpenModel'),
    runtimeVersion: stringFlag(flags, 'runtime-version') || undefined,
    driverVersion: stringFlag(flags, 'driver', detectedGpu?.driverVersion ?? '') || undefined,
    cudaVersion: stringFlag(flags, 'cuda') || undefined,
    endpointUrl: stringFlag(flags, 'endpoint') || undefined,
    region: stringFlag(flags, 'region', 'undisclosed'),
    healthStatus: 'REGISTERING'
  };

  if (booleanFlag(flags, 'dry-run')) {
    return { dryRun: true, detectedGpu, body };
  }

  const { payload, apiBaseUrl } = await capacityApiRequest('/v1/provider/nodes', {
    method: 'POST',
    body,
    apiUrl: flags['api-url']
  });
  const node = payload.data;
  const config = await readConfig();
  config.provider = {
    ...(config.provider ?? {}),
    lastNodeId: node.id,
    nodes: {
      ...(config.provider?.nodes ?? {}),
      [node.id]: {
        id: node.id,
        name: node.name,
        token: payload.nodeToken,
        apiBaseUrl,
        gpuCount: node.gpuCount,
        reportedAvailableGpuCount: node.reportedAvailableGpuCount ?? node.availableGpuCount,
        vramGbPerGpu: node.vramGbPerGpu
      }
    }
  };
  await writeConfig(config);
  return { node, apiBaseUrl, detectedGpu };
}

export async function listProviderNodes(flags = {}) {
  const { payload, apiBaseUrl } = await capacityApiRequest('/v1/provider/nodes', { apiUrl: flags['api-url'] });
  return { nodes: Array.isArray(payload.data) ? payload.data : [], apiBaseUrl };
}

export async function providerNodeHeartbeat(flags = {}) {
  const resolved = await resolveNode(stringFlag(flags, 'node-id'));
  const detectedGpu = await detectNvidiaGpus();
  const configuredGpuCount = Number(resolved.savedNode.gpuCount ?? detectedGpu?.gpuCount);
  const configuredAvailableGpuCount = Number(resolved.savedNode.reportedAvailableGpuCount ?? configuredGpuCount);
  const body = {
    gpuCount: flags.gpus === undefined ? configuredGpuCount : integerFlag(flags, 'gpus'),
    availableGpuCount: flags['available-gpus'] === undefined ? configuredAvailableGpuCount : integerFlag(flags, 'available-gpus'),
    runtime: stringFlag(flags, 'runtime') || undefined,
    runtimeVersion: stringFlag(flags, 'runtime-version') || undefined,
    driverVersion: stringFlag(flags, 'driver', detectedGpu?.driverVersion ?? '') || undefined,
    cudaVersion: stringFlag(flags, 'cuda') || undefined,
    endpointUrl: stringFlag(flags, 'endpoint') || undefined,
    healthStatus: stringFlag(flags, 'health', 'READY').toUpperCase()
  };
  const { payload, apiBaseUrl } = await capacityApiRequest(`/v1/provider/nodes/${encodeURIComponent(resolved.nodeId)}/heartbeat`, {
    method: 'POST',
    body,
    nodeToken: resolved.token,
    apiUrl: flags['api-url'] ?? resolved.savedNode.apiBaseUrl
  });
  const reportedAvailableGpuCount = payload.data.reportedAvailableGpuCount ?? body.availableGpuCount;
  const savedGpuCount = payload.data.gpuCount ?? body.gpuCount;
  if (resolved.savedNode.reportedAvailableGpuCount !== reportedAvailableGpuCount || resolved.savedNode.gpuCount !== savedGpuCount) {
    resolved.config.provider = {
      ...(resolved.config.provider ?? {}),
      lastNodeId: resolved.nodeId,
      nodes: {
        ...(resolved.config.provider?.nodes ?? {}),
        [resolved.nodeId]: {
          ...resolved.savedNode,
          apiBaseUrl,
          gpuCount: savedGpuCount,
          reportedAvailableGpuCount,
          vramGbPerGpu: payload.data.vramGbPerGpu ?? resolved.savedNode.vramGbPerGpu
        }
      }
    };
    await writeConfig(resolved.config);
  }
  return { node: payload.data, apiBaseUrl, detectedGpu };
}

export async function listProviderAssignments(flags = {}) {
  const resolved = await resolveNode(stringFlag(flags, 'node-id'));
  const { payload, apiBaseUrl } = await capacityApiRequest(`/v1/provider/nodes/${encodeURIComponent(resolved.nodeId)}/assignments`, {
    nodeToken: resolved.token,
    apiUrl: flags['api-url'] ?? resolved.savedNode.apiBaseUrl
  });
  return { assignments: Array.isArray(payload.data) ? payload.data : [], apiBaseUrl };
}

export async function changeProviderAssignment(reservationId, action, flags = {}) {
  if (!reservationId) throw new Error(`Usage: om provider ${action} <reservation-id>`);
  const resolved = await resolveNode(stringFlag(flags, 'node-id'));
  const body = action === 'usage' ? {
    sequence: integerFlag(flags, 'sequence'),
    cumulativeBillableSeconds: integerFlag(flags, 'billable-seconds')
  } : action === 'complete' ? {
    sequence: flags.sequence === undefined ? undefined : integerFlag(flags, 'sequence'),
    cumulativeBillableSeconds: flags['billable-seconds'] === undefined ? undefined : integerFlag(flags, 'billable-seconds'),
    completionReference: stringFlag(flags, 'completion-reference') || undefined
  } : action === 'fail' ? {
    sequence: flags.sequence === undefined ? undefined : integerFlag(flags, 'sequence'),
    cumulativeBillableSeconds: flags['billable-seconds'] === undefined ? undefined : integerFlag(flags, 'billable-seconds'),
    failureCode: stringFlag(flags, 'failure-code', 'PROVIDER_FAILURE'),
    failureMessage: stringFlag(flags, 'failure-message') || undefined
  } : action === 'accept' ? {
    providerSessionReference: stringFlag(flags, 'session-reference') || undefined
  } : {};
  const { payload, apiBaseUrl } = await capacityApiRequest(`/v1/provider/nodes/${encodeURIComponent(resolved.nodeId)}/assignments/${encodeURIComponent(reservationId)}/${action}`, {
    method: 'POST',
    body,
    nodeToken: resolved.token,
    apiUrl: flags['api-url'] ?? resolved.savedNode.apiBaseUrl
  });
  return { reservation: payload.data, apiBaseUrl };
}

export async function rotateProviderNodeToken(flags = {}) {
  const config = await readConfig();
  const nodeId = stringFlag(flags, 'node-id', config.provider?.lastNodeId ?? '');
  if (!nodeId) throw new Error('Pass --node-id or enroll a provider node first.');
  const { payload, apiBaseUrl } = await capacityApiRequest(`/v1/provider/nodes/${encodeURIComponent(nodeId)}/rotate-token`, {
    method: 'POST',
    body: {},
    apiUrl: flags['api-url']
  });
  config.provider = {
    ...(config.provider ?? {}),
    lastNodeId: nodeId,
    nodes: {
      ...(config.provider?.nodes ?? {}),
      [nodeId]: {
        ...(config.provider?.nodes?.[nodeId] ?? {}),
        id: nodeId,
        name: payload.data.name,
        token: payload.nodeToken,
        apiBaseUrl
      }
    }
  };
  await writeConfig(config);
  return { node: payload.data, apiBaseUrl };
}

export async function changeProviderNodeStatus(action, flags = {}) {
  if (!['enable', 'drain', 'disable'].includes(action)) {
    throw new Error('Provider node action must be enable, drain, or disable.');
  }
  const config = await readConfig();
  const nodeId = stringFlag(flags, 'node-id', config.provider?.lastNodeId ?? '');
  if (!nodeId) throw new Error('Pass --node-id or enroll a provider node first.');
  const { payload, apiBaseUrl } = await capacityApiRequest(`/v1/provider/nodes/${encodeURIComponent(nodeId)}/${action}`, {
    method: 'POST',
    body: {},
    apiUrl: flags['api-url'] ?? config.provider?.nodes?.[nodeId]?.apiBaseUrl
  });
  return { node: payload.data, apiBaseUrl };
}

export async function runProviderAgent(flags = {}, dependencies = {}) {
  const output = dependencies.output ?? ((value) => process.stdout.write(`${JSON.stringify(value)}
`));
  const sleepFunction = dependencies.sleep ?? sleep;
  const randomFunction = dependencies.random ?? Math.random;
  const once = booleanFlag(flags, 'once');
  const quiet = booleanFlag(flags, 'quiet');
  const failFast = booleanFlag(flags, 'fail-fast');
  const intervalSeconds = integerFlag(flags, 'interval-seconds', 30);
  if (intervalSeconds < 5 || intervalSeconds > 300) throw new Error('--interval-seconds must be between 5 and 300.');
  let consecutiveFailures = 0;
  let cycleNumber = 0;
  while (true) {
    cycleNumber += 1;
    try {
      const heartbeat = await providerNodeHeartbeat(flags);
      const assignments = await listProviderAssignments(flags);
      consecutiveFailures = 0;
      const cycle = {
        type: 'provider-agent-cycle',
        cycle: cycleNumber,
        nodeId: heartbeat.node.id,
        healthStatus: heartbeat.node.healthStatus,
        availableGpuCount: heartbeat.node.availableGpuCount,
        reservedGpuCount: heartbeat.node.reservedGpuCount ?? 0,
        assignmentCount: assignments.assignments.length,
        assignments: assignments.assignments,
        completedAt: new Date().toISOString()
      };
      if (!quiet) output(cycle);
      if (once) return cycle;
      const jitterMilliseconds = Math.floor(randomFunction() * Math.min(5000, intervalSeconds * 100));
      await sleepFunction(intervalSeconds * 1000 + jitterMilliseconds);
    } catch (error) {
      consecutiveFailures += 1;
      const failure = {
        type: 'provider-agent-error',
        cycle: cycleNumber,
        consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString()
      };
      output(failure);
      if (once || failFast) throw error;
      const retrySeconds = Math.min(300, Math.max(5, intervalSeconds * (2 ** Math.min(consecutiveFailures - 1, 4))));
      await sleepFunction(retrySeconds * 1000);
    }
  }
}

export async function getProviderEarnings(flags = {}) {
  const { payload, apiBaseUrl } = await capacityApiRequest('/v1/provider/earnings', { apiUrl: flags['api-url'] });
  return { earnings: payload.data ?? [], totals: payload.totals ?? {}, apiBaseUrl };
}

export async function configurePayoutProfile(flags = {}) {
  const method = stringFlag(flags, 'method').toUpperCase();
  const destinationReference = stringFlag(flags, 'destination-reference');
  if (!method || !destinationReference) {
    throw new Error('Usage: om provider payout-profile --method STRIPE_CONNECT --destination-reference acct_123');
  }
  const { payload, apiBaseUrl } = await capacityApiRequest('/v1/provider/payout-profile', {
    method: 'PUT',
    body: {
      method,
      destinationReference,
      destinationLabel: stringFlag(flags, 'destination-label') || undefined
    },
    apiUrl: flags['api-url']
  });
  return { profile: payload.data, apiBaseUrl };
}

export async function requestProviderPayout(flags = {}) {
  const { payload, apiBaseUrl } = await capacityApiRequest('/v1/provider/payouts', {
    method: 'POST',
    body: {
      currency: stringFlag(flags, 'currency', 'USD').toUpperCase(),
      amount: flags.amount === undefined ? undefined : numberFlag(flags, 'amount')
    },
    apiUrl: flags['api-url']
  });
  return { payout: payload.data, apiBaseUrl };
}

export function formatProviderNodes(nodes) {
  if (!nodes.length) return 'No provider nodes registered.';
  const header = ['ID', 'STATUS', 'HEALTH', 'GPU', 'AVAILABLE', 'LAST HEARTBEAT'].join('\t');
  return [header, ...nodes.map((node) => [
    node.id,
    node.status,
    node.healthStatus,
    node.gpuModel,
    `${node.availableGpuCount}/${node.gpuCount}`,
    node.lastHeartbeatAt ?? 'never'
  ].join('\t'))].join('\n');
}

export function formatProviderAssignments(assignments) {
  if (!assignments.length) return 'No active assignments.';
  const header = ['ID', 'STATUS', 'GPUS', 'HOURS', 'AUTHORIZED', 'WORKLOAD'].join('\t');
  return [header, ...assignments.map((assignment) => [
    assignment.id,
    assignment.status,
    assignment.gpuCount,
    assignment.requestedHours,
    `${assignment.currency} ${Number(assignment.providerAuthorizedAmount).toFixed(2)}`,
    assignment.workloadReference
  ].join('\t'))].join('\n');
}

export function providerHelpText() {
  return `om provider <command> [options]

Commands:
  enroll [--name worker-1] [--endpoint https://worker.example.com]
  nodes
  heartbeat [--node-id id] [--available-gpus 1]
  agent [--node-id id] [--interval-seconds 20] [--once] [--quiet]
  assignments [--node-id id]
  accept <reservation-id>
  start <reservation-id>
  usage <reservation-id> --sequence 1 --billable-seconds 300
  complete <reservation-id> [--sequence 2 --billable-seconds 3600]
  fail <reservation-id> [--failure-code RUNTIME_ERROR]
  enable|drain|disable [--node-id id]
  rotate-token [--node-id id]
  earnings
  payout-profile --method STRIPE_CONNECT --destination-reference acct_123
  payout [--currency USD] [--amount 100]

Security:
  Node tokens are shown once and stored with mode 0600 in OpenModel config.
  Workload metadata containing secrets is rejected by the master.
  The provider agent pulls assignments; it never executes buyer commands automatically.
`;
}
