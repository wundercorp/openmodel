import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import {
  CapacityContractError,
  applyProviderNodeHeartbeat,
  applyUsageReport,
  calculateEffectiveAvailableGpuCount,
  createEarning,
  createPayout,
  createReservation,
  materializeEarningStatus,
  sanitizeProviderNode,
  summarizeEarnings,
  transitionPayout,
  transitionReservation,
  validateGpuCapacitySubmission,
  validatePayoutProfile,
  validateProviderNodeSubmission
} from '../../../packages/capacity-core/src/index.js';

const dynamoDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const metadataCache = new Map();
const jwksCache = new Map();

const gpuCapacityPath = '/v1/capacity/gpu';
const providerNodesPath = '/v1/provider/nodes';
const providerReservationsPath = '/v1/provider/reservations';
const providerEarningsPath = '/v1/provider/earnings';
const providerPayoutProfilePath = '/v1/provider/payout-profile';
const providerPayoutsPath = '/v1/provider/payouts';
const hyperscalerReservationsPath = '/v1/hyperscaler/reservations';
const hyperscalerPayoutsPath = '/v1/hyperscaler/payouts';
const hyperscalerPayoutProfilesPath = '/v1/hyperscaler/payout-profiles';

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const path = normalizePath(event.rawPath ?? event.path ?? '/');
  const headers = normalizeHeaders(event.headers ?? {});
  const corsHeaders = createCorsHeaders(headers.origin ?? null, process.env.ALLOWED_ORIGINS ?? '*');

  if (method === 'OPTIONS') {
    return createResponse(204, null, corsHeaders);
  }

  try {
    if (method === 'GET' && path === '/health') {
      return createResponse(200, {
        status: 'ok',
        service: 'openmodel-aws-api',
        apiAliases: ['https://api.openmodel.sh', 'https://api.walton.bot'],
        capacityControlPlane: 'hyperscaler-master-v1'
      }, corsHeaders);
    }

    if (method === 'GET' && path === '/v1/gateways') {
      return createResponse(200, { data: await listGateways() }, corsHeaders);
    }

    if (method === 'GET' && path === gpuCapacityPath) {
      const records = await listCapacityRecords();
      const nodesById = new Map(records.filter((record) => record.recordType === 'GPU_PROVIDER_NODE').map((node) => [node.id, node]));
      const listings = records
        .filter((record) => record.recordType === 'GPU_CAPACITY' && record.status === 'PUBLISHED')
        .map((listing) => projectPublicListing(listing, nodesById.get(listing.workerNodeId)))
        .filter(Boolean);
      return createResponse(200, {
        data: listings,
        meta: {
          canonicalApi: 'https://api.openmodel.sh',
          aliasApi: 'https://api.walton.bot',
          architecture: 'hyperscaler-master/provider-worker',
          heartbeatMaximumAgeSeconds: heartbeatMaximumAgeSeconds()
        }
      }, corsHeaders);
    }

    const nodeRoute = matchNodeControlRoute(path);
    if (nodeRoute) {
      const node = await authenticateNode(headers.authorization, nodeRoute.nodeId);
      return await handleNodeControlRoute(method, nodeRoute, node, event, corsHeaders);
    }

    const user = await authenticate(headers.authorization);

    if (method === 'GET' && path === '/v1/me') {
      return createResponse(200, {
        id: user.sub,
        email: user.email,
        name: user.name,
        username: user.username ?? user['cognito:username'],
        scope: user.scope,
        permissions: user.permissions ?? [],
        groups: Array.isArray(user['cognito:groups']) ? user['cognito:groups'] : [],
        clientId: user.client_id ?? user.azp ?? (Array.isArray(user.aud) ? user.aud[0] : user.aud),
        capacityRoles: {
          provider: true,
          hyperscalerMaster: hasHyperscalerPermission(user)
        }
      }, corsHeaders);
    }

    if (method === 'POST' && path === '/v1/gateways') {
      requirePermission(user, 'gateways:write');
      const gateway = validateGatewaySubmission(parseJsonBody(event.body, event.isBase64Encoded));
      await dynamoDocumentClient.send(new PutCommand({
        TableName: requireEnvironmentVariable('GATEWAY_REGISTRY_TABLE'),
        Item: gateway,
        ConditionExpression: 'attribute_not_exists(id)'
      }));
      return createResponse(201, { data: gateway }, corsHeaders);
    }

    if (path === providerNodesPath || path.startsWith(`${providerNodesPath}/`)) {
      return await handleProviderNodesRoute(method, path, user, event, corsHeaders);
    }

    if (path === providerReservationsPath) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const reservations = (await listRecordsByType('GPU_RESERVATION'))
        .filter((reservation) => reservation.providerId === user.sub)
        .map(projectProviderReservation);
      return createResponse(200, { data: reservations }, corsHeaders);
    }

    if (path === providerEarningsPath) {
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const storedEarnings = (await listRecordsByType('GPU_EARNING')).filter((earning) => earning.providerId === user.sub);
      const summary = summarizeEarnings(storedEarnings);
      await persistMaterializedEarnings(storedEarnings, summary.earnings);
      return createResponse(200, { data: summary.earnings, totals: summary.totals }, corsHeaders);
    }

    if (path === providerPayoutProfilePath) {
      return await handleProviderPayoutProfileRoute(method, user, event, corsHeaders);
    }

    if (path === providerPayoutsPath) {
      return await handleProviderPayoutsRoute(method, user, event, corsHeaders);
    }

    if (path === hyperscalerReservationsPath || path.startsWith(`${hyperscalerReservationsPath}/`)) {
      requireHyperscaler(user);
      return await handleHyperscalerReservationsRoute(method, path, user, event, corsHeaders);
    }

    if (path === hyperscalerPayoutsPath || path.startsWith(`${hyperscalerPayoutsPath}/`)) {
      requireHyperscaler(user, 'capacity:settle');
      return await handleHyperscalerPayoutsRoute(method, path, event, corsHeaders);
    }

    if (path.startsWith(`${hyperscalerPayoutProfilesPath}/`)) {
      requireHyperscaler(user, 'capacity:settle');
      return await handleHyperscalerPayoutProfileRoute(method, path, event, corsHeaders);
    }

    if (method === 'GET' && path === `${gpuCapacityPath}/mine`) {
      const listings = await listRecordsByType('GPU_CAPACITY');
      return createResponse(200, { data: listings.filter((listing) => listing.ownerId === user.sub) }, corsHeaders);
    }

    if (method === 'POST' && path === gpuCapacityPath) {
      const body = parseJsonBody(event.body, event.isBase64Encoded);
      await assertWorkerListingCompatible(body, body.workerNodeId, user.sub);
      const listing = validateGpuCapacitySubmission(body, {
        id: randomUUID(),
        ownerId: user.sub,
        ownerDisplayName: userDisplayName(user),
        status: body.publish === true ? 'PUBLISHED' : 'DRAFT'
      }, { platformFeeBps: platformFeeBps() });
      await saveRecord(listing, true);
      return createResponse(201, { data: listing }, corsHeaders);
    }

    const listingRoute = matchGpuCapacityListingRoute(path);
    if (listingRoute) {
      return await handleGpuListingRoute(method, listingRoute, user, event, corsHeaders);
    }

    return createResponse(404, { error: 'Not found', code: 'NOT_FOUND' }, corsHeaders);
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException' || error?.name === 'TransactionCanceledException') {
      return createResponse(409, { error: 'The capacity record changed concurrently. Refresh and retry.', code: 'CAPACITY_CONFLICT' }, corsHeaders);
    }
    const status = error instanceof HttpError || error instanceof CapacityContractError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Internal error';
    const code = error?.code ?? (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
    return createResponse(status, { error: message, code }, corsHeaders);
  }
}

async function handleProviderNodesRoute(method, path, user, event, corsHeaders) {
  if (path === providerNodesPath) {
    if (method === 'GET') {
      const nodes = (await listRecordsByType('GPU_PROVIDER_NODE'))
        .filter((node) => node.ownerId === user.sub)
        .map(sanitizeProviderNode);
      return createResponse(200, { data: nodes }, corsHeaders);
    }
    if (method === 'POST') {
      const body = parseJsonBody(event.body, event.isBase64Encoded);
      const id = `node_${randomUUID()}`;
      const credential = `${id}.${createSecret()}`;
      const node = validateProviderNodeSubmission(body, {
        id,
        ownerId: user.sub,
        ownerDisplayName: userDisplayName(user),
        tokenHash: await sha256Hex(credential),
        tokenLastFour: credential.slice(-4)
      });
      await saveRecord(node, true);
      return createResponse(201, { data: sanitizeProviderNode(node), nodeToken: credential }, corsHeaders);
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  const match = path.match(/^\/v1\/provider\/nodes\/([^/]+)(?:\/(rotate-token|enable|drain|disable))?$/);
  if (!match) throw new HttpError(404, 'Provider node route was not found.');
  const node = await readRecord(decodeURIComponent(match[1]));
  if (!node || node.recordType !== 'GPU_PROVIDER_NODE') throw new HttpError(404, 'Provider node was not found.');
  if (node.ownerId !== user.sub) throw new HttpError(403, 'Only the node owner can manage this provider node.');
  const action = match[2];

  if (method === 'GET' && !action) {
    return createResponse(200, { data: sanitizeProviderNode(node) }, corsHeaders);
  }
  if (method !== 'POST' || !action) throw new HttpError(405, 'Method not allowed.');

  if (action === 'rotate-token') {
    const credential = `${node.id}.${createSecret()}`;
    const updated = {
      ...node,
      tokenHash: await sha256Hex(credential),
      tokenLastFour: credential.slice(-4),
      tokenCreatedAt: new Date().toISOString(),
      status: 'ACTIVE',
      updatedAt: new Date().toISOString(),
      revision: Number(node.revision ?? 0) + 1
    };
    await saveRecordWithRevision(updated, node.revision);
    return createResponse(200, { data: sanitizeProviderNode(updated), nodeToken: credential }, corsHeaders);
  }

  if (action === 'disable' && await hasActiveReservationsForNode(node.id)) {
    throw new HttpError(409, 'Drain the node and finish or cancel its active assignments before disabling it.');
  }
  const nextStatus = action === 'enable' ? 'ACTIVE' : action === 'drain' ? 'DRAINING' : 'DISABLED';
  const updated = {
    ...node,
    status: nextStatus,
    healthStatus: action === 'disable' ? 'OFFLINE' : node.healthStatus,
    updatedAt: new Date().toISOString(),
    revision: Number(node.revision ?? 0) + 1
  };
  await saveRecordWithRevision(updated, node.revision);
  return createResponse(200, { data: sanitizeProviderNode(updated) }, corsHeaders);
}

async function handleNodeControlRoute(method, route, node, event, corsHeaders) {
  if (route.action === 'heartbeat') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const body = parseJsonBody(event.body, event.isBase64Encoded, {});
    const updatedNode = applyProviderNodeHeartbeat(node, body);
    await saveRecordWithRevision(updatedNode, node.revision);
    await synchronizeListingsFromNode(updatedNode);
    return createResponse(200, { data: sanitizeProviderNode(updatedNode) }, corsHeaders);
  }

  if (route.action === 'assignments' && !route.reservationId) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    await expireStaleAssignmentsForNode(node.id);
    const reservations = (await listRecordsByType('GPU_RESERVATION'))
      .filter((reservation) => reservation.nodeId === node.id && ['ASSIGNED', 'ACCEPTED', 'RUNNING'].includes(reservation.status));
    return createResponse(200, { data: reservations.map(projectNodeAssignment) }, corsHeaders);
  }

  if (route.action === 'assignments' && route.reservationId && route.assignmentAction) {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const reservation = await readRecord(route.reservationId);
    if (!reservation || reservation.recordType !== 'GPU_RESERVATION' || reservation.nodeId !== node.id) {
      throw new HttpError(404, 'Assignment was not found for this node.');
    }
    const body = parseJsonBody(event.body, event.isBase64Encoded, {});
    if (route.assignmentAction === 'usage') {
      const updated = applyUsageReport(reservation, body);
      await saveRecordWithRevision(updated, reservation.revision);
      return createResponse(200, { data: updated }, corsHeaders);
    }
    const updated = transitionReservation(reservation, route.assignmentAction, body);
    let responseReservation = updated;
    if (['COMPLETED', 'FAILED'].includes(updated.status)) {
      responseReservation = await finalizeReservation(reservation, updated);
    } else {
      await saveRecordWithRevision(updated, reservation.revision);
    }
    return createResponse(200, { data: responseReservation }, corsHeaders);
  }

  throw new HttpError(404, 'Node control route was not found.');
}

async function handleHyperscalerReservationsRoute(method, path, user, event, corsHeaders) {
  if (path === `${hyperscalerReservationsPath}/sweep`) {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const result = await expireAllStaleAssignments();
    return createResponse(200, { data: result }, corsHeaders);
  }
  if (path === hyperscalerReservationsPath) {
    if (method === 'GET') {
      const reservations = await listRecordsByType('GPU_RESERVATION');
      return createResponse(200, { data: reservations }, corsHeaders);
    }
    if (method === 'POST') {
      const body = parseJsonBody(event.body, event.isBase64Encoded);
      if (body.clientRequestId) {
        const existing = (await listRecordsByType('GPU_RESERVATION')).find((reservation) =>
          reservation.buyerId === user.sub && reservation.clientRequestId === String(body.clientRequestId));
        if (existing) return createResponse(200, { data: existing, idempotent: true }, corsHeaders);
      }
      const listing = await readRecord(String(body.listingId ?? ''));
      const node = listing?.workerNodeId ? await readRecord(listing.workerNodeId) : undefined;
      const reservationId = body.clientRequestId
        ? `reservation_${(await sha256Hex(`reservation:${user.sub}:${String(body.clientRequestId)}`)).slice(0, 48)}`
        : `reservation_${randomUUID()}`;
      const reservation = createReservation(body, listing, node, user, { id: reservationId }, {
        maximumHeartbeatAgeSeconds: heartbeatMaximumAgeSeconds(),
        assignmentTimeoutSeconds: assignmentTimeoutSeconds()
      });
      try {
        await reserveCapacity(listing, reservation);
      } catch (error) {
        if (body.clientRequestId && ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.name)) {
          const idempotentReservation = await readRecord(reservationId);
          if (idempotentReservation?.buyerId === user.sub && idempotentReservation?.clientRequestId === String(body.clientRequestId)) {
            return createResponse(200, { data: idempotentReservation, idempotent: true }, corsHeaders);
          }
        }
        throw error;
      }
      return createResponse(201, { data: reservation }, corsHeaders);
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  const match = path.match(/^\/v1\/hyperscaler\/reservations\/([^/]+)(?:\/(cancel|dispute|expire))?$/);
  if (!match) throw new HttpError(404, 'Hyperscaler reservation route was not found.');
  const reservation = await readRecord(decodeURIComponent(match[1]));
  if (!reservation || reservation.recordType !== 'GPU_RESERVATION') throw new HttpError(404, 'Reservation was not found.');
  const action = match[2];
  if (method === 'GET' && !action) return createResponse(200, { data: reservation }, corsHeaders);
  if (method === 'POST' && action) {
    const body = parseJsonBody(event.body, event.isBase64Encoded, {});
    const updated = transitionReservation(reservation, action, body);
    let responseReservation = updated;
    if (updated.status === 'DISPUTED') {
      responseReservation = await persistDisputedReservation(reservation, updated);
    } else if (['CANCELLED', 'EXPIRED'].includes(updated.status)) {
      responseReservation = await finalizeReservation(reservation, updated, { createEarningRecord: false });
    } else {
      await saveRecordWithRevision(updated, reservation.revision);
    }
    return createResponse(200, { data: responseReservation }, corsHeaders);
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function handleProviderPayoutProfileRoute(method, user, event, corsHeaders) {
  const id = `payout-profile:${user.sub}`;
  const existing = await readRecord(id);
  if (method === 'GET') return createResponse(200, { data: existing ?? null }, corsHeaders);
  if (method === 'PUT') {
    const body = parseJsonBody(event.body, event.isBase64Encoded);
    const profile = validatePayoutProfile(body, user.sub, existing);
    if (existing) await saveRecordWithRevision(profile, existing.revision);
    else await saveRecord(profile, true);
    return createResponse(existing ? 200 : 201, { data: profile }, corsHeaders);
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function handleProviderPayoutsRoute(method, user, event, corsHeaders) {
  if (method === 'GET') {
    const payouts = (await listRecordsByType('GPU_PAYOUT')).filter((payout) => payout.providerId === user.sub);
    return createResponse(200, { data: payouts }, corsHeaders);
  }
  if (method === 'POST') {
    const body = parseJsonBody(event.body, event.isBase64Encoded, {});
    const profile = await readRecord(`payout-profile:${user.sub}`);
    const storedEarnings = (await listRecordsByType('GPU_EARNING')).filter((earning) => earning.providerId === user.sub);
    const materialized = storedEarnings.map((earning) => materializeEarningStatus(earning));
    await persistMaterializedEarnings(storedEarnings, materialized);
    const result = createPayout(body, profile, materialized, { id: `payout_${randomUUID()}` }, {
      minimumPayoutAmount: minimumPayoutAmount()
    });
    if (result.earnings.length > 90) throw new HttpError(409, 'A payout can include at most 90 earning records. Request smaller payouts more frequently.');
    await writePayoutTransaction(result.payout, result.earnings);
    return createResponse(201, { data: result.payout }, corsHeaders);
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function handleHyperscalerPayoutsRoute(method, path, event, corsHeaders) {
  if (path === hyperscalerPayoutsPath) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    return createResponse(200, { data: await listRecordsByType('GPU_PAYOUT') }, corsHeaders);
  }
  const match = path.match(/^\/v1\/hyperscaler\/payouts\/([^/]+)\/(processing|paid|failed)$/);
  if (!match || method !== 'POST') throw new HttpError(404, 'Hyperscaler payout route was not found.');
  const payout = await readRecord(decodeURIComponent(match[1]));
  const body = parseJsonBody(event.body, event.isBase64Encoded, {});
  const updated = transitionPayout(payout, match[2], body);
  const earningIds = Array.isArray(payout.earningIds) ? payout.earningIds : [];
  if (earningIds.length === 0) throw new HttpError(409, 'Payout has no earning records and cannot be settled.');
  const earnings = await Promise.all(earningIds.map((id) => readRecord(id)));
  if (earnings.some((earning) => !earning)) throw new HttpError(409, 'One or more payout earning records are missing.');
  for (const earning of earnings) {
    if (earning.recordType !== 'GPU_EARNING' || earning.providerId !== payout.providerId || earning.currency !== payout.currency) {
      throw new HttpError(409, 'A payout earning record does not match the payout owner or currency.');
    }
    if (earning.payoutId !== payout.id || earning.status !== 'PAYOUT_PENDING') {
      throw new HttpError(409, 'A payout earning record is no longer reserved for this payout.');
    }
  }
  const earningAmount = roundMoney(earnings.reduce((total, earning) => total + Number(earning.netAmount ?? 0), 0));
  if (earningAmount !== roundMoney(payout.amount)) throw new HttpError(409, 'Payout amount does not match its earning records.');
  const updatedEarnings = earnings.map((earning) => ({
    ...earning,
    status: updated.status === 'PAID' ? 'PAID' : updated.status === 'FAILED' ? 'AVAILABLE' : 'PAYOUT_PENDING',
    payoutId: updated.status === 'FAILED' ? null : payout.id,
    paidAt: updated.status === 'PAID' ? updated.paidAt : earning.paidAt,
    updatedAt: new Date().toISOString(),
    revision: Number(earning.revision ?? 0) + 1
  }));
  await writePayoutTransaction(updated, updatedEarnings, payout.revision);
  return createResponse(200, { data: updated }, corsHeaders);
}

async function handleHyperscalerPayoutProfileRoute(method, path, event, corsHeaders) {
  const match = path.match(/^\/v1\/hyperscaler\/payout-profiles\/([^/]+)\/(verify|reject)$/);
  if (!match || method !== 'POST') throw new HttpError(404, 'Hyperscaler payout profile route was not found.');
  const profile = await readRecord(`payout-profile:${decodeURIComponent(match[1])}`);
  if (!profile) throw new HttpError(404, 'Payout profile was not found.');
  const body = parseJsonBody(event.body, event.isBase64Encoded, {});
  const updated = {
    ...profile,
    status: match[2] === 'verify' ? 'VERIFIED' : 'REJECTED',
    verificationReference: normalizeOptionalString(body.verificationReference),
    rejectionReason: match[2] === 'reject' ? normalizeOptionalString(body.reason) : undefined,
    updatedAt: new Date().toISOString(),
    revision: Number(profile.revision ?? 0) + 1
  };
  await saveRecordWithRevision(updated, profile.revision);
  return createResponse(200, { data: updated }, corsHeaders);
}

async function handleGpuListingRoute(method, listingRoute, user, event, corsHeaders) {
  const existing = await readRecord(listingRoute.id);
  if (!existing || existing.recordType !== 'GPU_CAPACITY') throw new HttpError(404, 'GPU capacity listing was not found.');
  if (existing.ownerId !== user.sub) throw new HttpError(403, 'Only the listing owner can change this GPU capacity.');

  if (method === 'GET' && !listingRoute.action) return createResponse(200, { data: existing }, corsHeaders);
  if (method === 'PUT' && !listingRoute.action) {
    const body = parseJsonBody(event.body, event.isBase64Encoded);
    await assertWorkerListingCompatible({ ...existing, ...body }, body.workerNodeId ?? existing.workerNodeId, user.sub);
    await assertListingUpdateSafe(existing, body);
    const updated = validateGpuCapacitySubmission({ ...existing, ...body }, {
      id: existing.id,
      ownerId: existing.ownerId,
      ownerDisplayName: existing.ownerDisplayName,
      status: body.status ?? existing.status,
      createdAt: existing.createdAt,
      revision: Number(existing.revision ?? 0) + 1
    }, { platformFeeBps: existing.platformFeeBps ?? platformFeeBps() });
    await saveRecordWithRevision(updated, existing.revision);
    return createResponse(200, { data: updated }, corsHeaders);
  }
  if (method === 'POST' && listingRoute.action === 'publish') {
    await assertWorkerListingCompatible(existing, existing.workerNodeId, user.sub);
    const updated = validateGpuCapacitySubmission({ ...existing, status: 'PUBLISHED' }, {
      id: existing.id,
      ownerId: existing.ownerId,
      ownerDisplayName: existing.ownerDisplayName,
      status: 'PUBLISHED',
      createdAt: existing.createdAt,
      revision: Number(existing.revision ?? 0) + 1
    }, { platformFeeBps: existing.platformFeeBps ?? platformFeeBps() });
    await saveRecordWithRevision(updated, existing.revision);
    return createResponse(200, { data: updated }, corsHeaders);
  }
  if (method === 'POST' && listingRoute.action === 'pause') {
    const updated = { ...existing, status: 'PAUSED', updatedAt: new Date().toISOString(), revision: Number(existing.revision ?? 0) + 1 };
    await saveRecordWithRevision(updated, existing.revision);
    return createResponse(200, { data: updated }, corsHeaders);
  }
  if (method === 'POST' && listingRoute.action === 'heartbeat') {
    if (existing.workerNodeId) throw new HttpError(409, 'Master-managed listings must be updated through the provider node heartbeat endpoint.');
    const body = parseJsonBody(event.body, event.isBase64Encoded, {});
    const availableGpuCount = body.availableGpuCount === undefined
      ? existing.availableGpuCount
      : requirePositiveInteger(body.availableGpuCount, 'availableGpuCount', { allowZero: true });
    if (availableGpuCount > existing.gpuCount) throw new HttpError(400, 'availableGpuCount cannot exceed gpuCount.');
    const updated = {
      ...existing,
      availableGpuCount,
      lastHeartbeatAt: new Date().toISOString(),
      runtimeStatus: normalizeOptionalString(body.runtimeStatus) ?? existing.runtimeStatus,
      updatedAt: new Date().toISOString(),
      revision: Number(existing.revision ?? 0) + 1
    };
    await saveRecordWithRevision(updated, existing.revision);
    return createResponse(200, { data: updated }, corsHeaders);
  }
  throw new HttpError(405, 'Method not allowed.');
}

async function reserveCapacity(listing, reservation) {
  const heartbeatCutoff = new Date(Date.now() - heartbeatMaximumAgeSeconds() * 1000).toISOString();
  await dynamoDocumentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: capacityTableName(),
          Key: { id: listing.id },
          UpdateExpression: 'SET availableGpuCount = availableGpuCount - :gpu, updatedAt = :now, revision = if_not_exists(revision, :zero) + :one',
          ConditionExpression: 'recordType = :listingType AND #status = :published AND ownerId = :providerId AND workerNodeId = :nodeId AND availableGpuCount >= :gpu',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':gpu': reservation.gpuCount,
            ':now': reservation.createdAt,
            ':zero': 0,
            ':one': 1,
            ':published': 'PUBLISHED',
            ':listingType': 'GPU_CAPACITY',
            ':providerId': reservation.providerId,
            ':nodeId': reservation.nodeId
          }
        }
      },
      {
        Update: {
          TableName: capacityTableName(),
          Key: { id: reservation.nodeId },
          UpdateExpression: 'SET availableGpuCount = availableGpuCount - :gpu, reservedGpuCount = if_not_exists(reservedGpuCount, :zero) + :gpu, updatedAt = :now, revision = if_not_exists(revision, :zero) + :one',
          ConditionExpression: 'recordType = :nodeType AND #status = :active AND ownerId = :providerId AND healthStatus = :ready AND availableGpuCount >= :gpu AND lastHeartbeatAt >= :heartbeatCutoff',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':gpu': reservation.gpuCount,
            ':now': reservation.createdAt,
            ':zero': 0,
            ':one': 1,
            ':active': 'ACTIVE',
            ':ready': 'READY',
            ':heartbeatCutoff': heartbeatCutoff,
            ':nodeType': 'GPU_PROVIDER_NODE',
            ':providerId': reservation.providerId
          }
        }
      },
      {
        Put: {
          TableName: capacityTableName(),
          Item: reservation,
          ConditionExpression: 'attribute_not_exists(id)'
        }
      }
    ]
  }));
}

async function finalizeReservation(previous, updated, options = {}) {
  if (previous.capacityReleasedAt) {
    throw new HttpError(409, 'Reservation capacity was already released.');
  }
  const timestamp = new Date().toISOString();
  const finalized = { ...updated, capacityReleasedAt: timestamp, updatedAt: timestamp };
  const maximumAttempts = 4;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const node = await readRecord(previous.nodeId);
    if (!node || node.recordType !== 'GPU_PROVIDER_NODE' || node.ownerId !== previous.providerId) {
      throw new HttpError(409, 'The reservation provider node no longer exists or changed ownership.');
    }
    const reservedGpuCount = Number(node.reservedGpuCount ?? 0);
    if (!Number.isInteger(reservedGpuCount) || reservedGpuCount < previous.gpuCount) {
      throw new HttpError(409, 'Provider node reservation accounting is inconsistent.');
    }
    const nextReservedGpuCount = reservedGpuCount - previous.gpuCount;
    const reportedAvailableGpuCount = Number.isInteger(Number(node.reportedAvailableGpuCount))
      ? Number(node.reportedAvailableGpuCount)
      : Math.min(Number(node.gpuCount), Number(node.availableGpuCount ?? 0) + reservedGpuCount);
    const releasedNode = {
      ...node,
      reservedGpuCount: nextReservedGpuCount,
      availableGpuCount: calculateEffectiveAvailableGpuCount(Number(node.gpuCount), reportedAvailableGpuCount, nextReservedGpuCount),
      updatedAt: timestamp,
      revision: Number(node.revision ?? 0) + 1
    };
    const transactionItems = [
      {
        Put: {
          TableName: capacityTableName(),
          Item: finalized,
          ConditionExpression: '#status = :expectedStatus AND revision = :expectedRevision AND attribute_not_exists(capacityReleasedAt)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expectedStatus': previous.status,
            ':expectedRevision': Number(previous.revision ?? 1)
          }
        }
      },
      {
        Update: {
          TableName: capacityTableName(),
          Key: { id: previous.listingId },
          UpdateExpression: 'SET availableGpuCount = availableGpuCount + :gpu, updatedAt = :now, revision = if_not_exists(revision, :zero) + :one',
          ConditionExpression: 'recordType = :listingType AND ownerId = :providerId AND workerNodeId = :nodeId',
          ExpressionAttributeValues: {
            ':gpu': previous.gpuCount,
            ':now': timestamp,
            ':zero': 0,
            ':one': 1,
            ':listingType': 'GPU_CAPACITY',
            ':providerId': previous.providerId,
            ':nodeId': previous.nodeId
          }
        }
      },
      {
        Put: {
          TableName: capacityTableName(),
          Item: releasedNode,
          ConditionExpression: 'recordType = :nodeType AND ownerId = :providerId AND revision = :expectedRevision',
          ExpressionAttributeValues: {
            ':nodeType': 'GPU_PROVIDER_NODE',
            ':providerId': previous.providerId,
            ':expectedRevision': Number(node.revision ?? 1)
          }
        }
      }
    ];
    if (options.createEarningRecord !== false) {
      const earning = createEarning(finalized, { id: `earning:${finalized.id}` }, { holdSeconds: earningsHoldSeconds() });
      transactionItems.push({
        Put: {
          TableName: capacityTableName(),
          Item: earning,
          ConditionExpression: 'attribute_not_exists(id)'
        }
      });
    }

    try {
      await dynamoDocumentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }));
      return finalized;
    } catch (error) {
      if (!['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.name)) throw error;
      const latestReservation = await readRecord(previous.id);
      if (latestReservation?.capacityReleasedAt) {
        if (latestReservation.status === finalized.status) return latestReservation;
        throw new HttpError(409, `Reservation was already finalized as ${latestReservation.status}.`);
      }
      if (!latestReservation || latestReservation.status !== previous.status || Number(latestReservation.revision ?? 0) !== Number(previous.revision ?? 0)) {
        throw new HttpError(409, 'Reservation changed while it was being finalized. Reload it before retrying.');
      }
      if (attempt === maximumAttempts) {
        throw new HttpError(409, 'Provider node state changed repeatedly while capacity was being released. Retry the operation.');
      }
    }
  }
  throw new HttpError(409, 'Reservation finalization could not be completed.');
}

async function writePayoutTransaction(payout, earnings, expectedPayoutRevision) {
  const payoutPut = {
    TableName: capacityTableName(),
    Item: payout
  };
  if (expectedPayoutRevision === undefined) payoutPut.ConditionExpression = 'attribute_not_exists(id)';
  else {
    payoutPut.ConditionExpression = 'revision = :expectedRevision';
    payoutPut.ExpressionAttributeValues = { ':expectedRevision': expectedPayoutRevision };
  }
  await dynamoDocumentClient.send(new TransactWriteCommand({
    TransactItems: [
      { Put: payoutPut },
      ...earnings.map((earning) => ({
        Put: {
          TableName: capacityTableName(),
          Item: earning,
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': Number(earning.revision ?? 1) - 1 }
        }
      }))
    ]
  }));
}

async function synchronizeListingsFromNode(node) {
  const records = await listCapacityRecords();
  const listings = records.filter((record) => record.recordType === 'GPU_CAPACITY' && record.workerNodeId === node.id);
  await Promise.allSettled(listings.map((listing) => saveRecordWithRevision({
    ...listing,
    lastHeartbeatAt: node.lastHeartbeatAt,
    runtimeStatus: node.healthStatus,
    endpointUrl: node.endpointUrl ?? listing.endpointUrl,
    updatedAt: new Date().toISOString(),
    revision: Number(listing.revision ?? 0) + 1
  }, listing.revision)));
}

async function persistDisputedReservation(previous, disputed) {
  const earning = await readRecord(`earning:${previous.id}`);
  if (!earning) {
    await saveRecordWithRevision(disputed, previous.revision);
    return disputed;
  }
  if (['PAYOUT_PENDING', 'PAID'].includes(earning.status) || earning.payoutId) {
    throw new HttpError(409, 'This reservation cannot be disputed automatically because its earning is already in settlement. Escalate it to settlement operations.');
  }
  const heldEarning = {
    ...earning,
    status: 'HELD',
    updatedAt: disputed.updatedAt,
    revision: Number(earning.revision ?? 0) + 1
  };
  await dynamoDocumentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: capacityTableName(),
          Item: disputed,
          ConditionExpression: 'revision = :expectedRevision AND #status = :expectedStatus',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expectedRevision': Number(previous.revision ?? 1),
            ':expectedStatus': previous.status
          }
        }
      },
      {
        Put: {
          TableName: capacityTableName(),
          Item: heldEarning,
          ConditionExpression: 'revision = :expectedRevision AND (attribute_not_exists(payoutId) OR payoutId = :noPayout)',
          ExpressionAttributeValues: {
            ':expectedRevision': Number(earning.revision ?? 1),
            ':noPayout': null
          }
        }
      }
    ]
  }));
  return disputed;
}

async function persistMaterializedEarnings(stored, materialized) {
  const storedById = new Map(stored.map((earning) => [earning.id, earning]));
  await Promise.allSettled(materialized
    .filter((earning) => storedById.get(earning.id)?.status !== earning.status)
    .map((earning) => saveRecordWithRevision(earning, storedById.get(earning.id)?.revision)));
}

function projectPublicListing(listing, node) {
  if (listing.workerNodeId) {
    if (!node || node.status !== 'ACTIVE' || node.healthStatus !== 'READY') return undefined;
    if (!node.lastHeartbeatAt || Date.parse(node.lastHeartbeatAt) < Date.now() - heartbeatMaximumAgeSeconds() * 1000) return undefined;
  }
  const { endpointUrl, providerInstructions, checkoutUrl, latitude, longitude, workerNodeId, ...publicListing } = listing;
  return {
    ...publicListing,
    availableGpuCount: node ? Math.max(0, Math.min(Number(listing.availableGpuCount ?? 0), Number(node.availableGpuCount ?? 0))) : publicListing.availableGpuCount,
    endpointAvailableAfterReservation: Boolean(endpointUrl || listing.workerNodeId),
    nodeHealthStatus: node?.healthStatus,
    lastHeartbeatAt: node?.lastHeartbeatAt ?? listing.lastHeartbeatAt
  };
}

function projectProviderReservation(reservation) {
  const { fundingReference, ...providerReservation } = reservation;
  return providerReservation;
}

function projectNodeAssignment(reservation) {
  return {
    id: reservation.id,
    listingId: reservation.listingId,
    status: reservation.status,
    gpuCount: reservation.gpuCount,
    requestedHours: reservation.requestedHours,
    workloadReference: reservation.workloadReference,
    workloadKind: reservation.workloadKind,
    workloadMetadata: reservation.workloadMetadata,
    assignmentExpiresAt: reservation.assignmentExpiresAt,
    pricePerGpuHour: reservation.pricePerGpuHour,
    currency: reservation.currency,
    providerAuthorizedAmount: reservation.providerAuthorizedAmount,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt
  };
}

async function hasActiveReservationsForNode(nodeId) {
  return (await listRecordsByType('GPU_RESERVATION')).some((reservation) =>
    reservation.nodeId === nodeId && ['ASSIGNED', 'ACCEPTED', 'RUNNING'].includes(reservation.status));
}

async function assertListingUpdateSafe(existing, body) {
  const activeReservations = (await listRecordsByType('GPU_RESERVATION')).filter((reservation) =>
    reservation.listingId === existing.id && ['ASSIGNED', 'ACCEPTED', 'RUNNING'].includes(reservation.status));
  if (activeReservations.length === 0) return;
  const immutableFields = ['workerNodeId', 'gpuCount', 'availableGpuCount', 'allocationMode', 'pricePerGpuHour', 'currency'];
  const changedField = immutableFields.find((field) => body[field] !== undefined && body[field] !== existing[field]);
  if (changedField) {
    throw new HttpError(409, `${changedField} cannot be changed while the listing has active reservations.`);
  }
  const reservedGpuCount = activeReservations.reduce((total, reservation) => total + Number(reservation.gpuCount ?? 0), 0);
  if (body.availableGpuCount !== undefined && Number(body.availableGpuCount) > Number(existing.gpuCount) - reservedGpuCount) {
    throw new HttpError(409, 'availableGpuCount cannot include GPUs reserved by active assignments.');
  }
}

async function expireStaleAssignmentsForNode(nodeId) {
  const now = new Date();
  const staleAssignments = (await listRecordsByType('GPU_RESERVATION')).filter((reservation) =>
    reservation.nodeId === nodeId && reservation.status === 'ASSIGNED' && Date.parse(reservation.assignmentExpiresAt) <= now.getTime());
  let expiredCount = 0;
  for (const reservation of staleAssignments) {
    try {
      const expired = transitionReservation(reservation, 'expire', {}, { now });
      await finalizeReservation(reservation, expired, { createEarningRecord: false });
      expiredCount += 1;
    } catch (error) {
      if (!['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.name)) throw error;
    }
  }
  return expiredCount;
}

async function expireAllStaleAssignments() {
  const nodeIds = [...new Set((await listRecordsByType('GPU_RESERVATION'))
    .filter((reservation) => reservation.status === 'ASSIGNED' && Date.parse(reservation.assignmentExpiresAt) <= Date.now())
    .map((reservation) => reservation.nodeId))];
  let expiredCount = 0;
  for (const nodeId of nodeIds) expiredCount += await expireStaleAssignmentsForNode(nodeId);
  return { expiredCount, checkedNodeCount: nodeIds.length, sweptAt: new Date().toISOString() };
}

async function assertOwnedWorkerNode(workerNodeId, ownerId) {
  if (!workerNodeId) return undefined;
  const node = await readRecord(String(workerNodeId));
  if (!node || node.recordType !== 'GPU_PROVIDER_NODE') throw new HttpError(400, 'workerNodeId does not identify a registered provider node.');
  if (node.ownerId !== ownerId) throw new HttpError(403, 'workerNodeId belongs to another provider.');
  if (node.status === 'DISABLED') throw new HttpError(409, 'The selected worker node is disabled.');
  return node;
}

async function assertWorkerListingCompatible(submission, workerNodeId, ownerId) {
  const node = await assertOwnedWorkerNode(workerNodeId, ownerId);
  if (!node) return;
  const gpuModel = String(submission.gpuModel ?? '').trim().toLowerCase();
  if (gpuModel && gpuModel !== String(node.gpuModel ?? '').trim().toLowerCase()) {
    throw new HttpError(409, 'The listing GPU model must match the registered worker node.');
  }
  const gpuCount = Number(submission.gpuCount);
  if (Number.isFinite(gpuCount) && gpuCount > Number(node.gpuCount ?? 0)) {
    throw new HttpError(409, 'The listing cannot advertise more GPUs than the registered worker node owns.');
  }
  const allocationMode = String(submission.allocationMode ?? '').trim().toUpperCase();
  if (allocationMode && !Array.isArray(node.allocationModes)) {
    throw new HttpError(409, 'The registered worker node has no supported allocation modes.');
  }
  if (allocationMode && !node.allocationModes.includes(allocationMode)) {
    throw new HttpError(409, `The worker node does not support ${allocationMode} allocation.`);
  }
}

async function authenticateNode(authorizationHeader, expectedNodeId) {
  if (!authorizationHeader?.startsWith('Node ')) throw new HttpError(401, 'A provider node token is required.');
  const credential = authorizationHeader.slice('Node '.length).trim();
  const separatorIndex = credential.indexOf('.');
  const nodeId = separatorIndex > 0 ? credential.slice(0, separatorIndex) : '';
  if (!nodeId || nodeId !== expectedNodeId) throw new HttpError(401, 'Provider node token did not match the requested node.');
  const node = await readRecord(nodeId);
  if (!node || node.recordType !== 'GPU_PROVIDER_NODE' || node.status === 'DISABLED') throw new HttpError(401, 'Provider node token is not active.');
  const presentedHash = Buffer.from(await sha256Hex(credential), 'hex');
  const storedHash = Buffer.from(String(node.tokenHash ?? ''), 'hex');
  if (presentedHash.length !== storedHash.length || !timingSafeEqual(presentedHash, storedHash)) throw new HttpError(401, 'Provider node token was rejected.');
  return node;
}

function matchNodeControlRoute(path) {
  let match = path.match(/^\/v1\/provider\/nodes\/([^/]+)\/(heartbeat|assignments)$/);
  if (match) return { nodeId: decodeURIComponent(match[1]), action: match[2] };
  match = path.match(/^\/v1\/provider\/nodes\/([^/]+)\/assignments\/([^/]+)\/(accept|start|usage|complete|fail)$/);
  if (match) return { nodeId: decodeURIComponent(match[1]), action: 'assignments', reservationId: decodeURIComponent(match[2]), assignmentAction: match[3] };
  return undefined;
}

function matchGpuCapacityListingRoute(path) {
  const match = path.match(/^\/v1\/capacity\/gpu\/([^/]+)(?:\/(publish|pause|heartbeat))?$/);
  if (!match) return undefined;
  return { id: decodeURIComponent(match[1]), action: match[2] };
}

async function listCapacityRecords() {
  const items = [];
  let exclusiveStartKey;
  do {
    const response = await dynamoDocumentClient.send(new ScanCommand({
      TableName: capacityTableName(),
      ExclusiveStartKey: exclusiveStartKey
    }));
    items.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.filter((item) => item && typeof item.recordType === 'string')
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
}

async function listRecordsByType(recordType) {
  return (await listCapacityRecords()).filter((record) => record.recordType === recordType);
}

async function readRecord(id) {
  if (!id) return undefined;
  const response = await dynamoDocumentClient.send(new GetCommand({
    TableName: capacityTableName(),
    Key: { id },
    ConsistentRead: true
  }));
  return response.Item;
}

async function saveRecord(record, requireNew) {
  const command = { TableName: capacityTableName(), Item: record };
  if (requireNew) command.ConditionExpression = 'attribute_not_exists(id)';
  await dynamoDocumentClient.send(new PutCommand(command));
}

async function saveRecordWithRevision(record, expectedRevision) {
  const normalizedExpectedRevision = Number(expectedRevision ?? 1);
  await dynamoDocumentClient.send(new PutCommand({
    TableName: capacityTableName(),
    Item: record,
    ConditionExpression: 'revision = :expectedRevision OR (attribute_not_exists(revision) AND :expectedRevision = :legacyRevision)',
    ExpressionAttributeValues: {
      ':expectedRevision': normalizedExpectedRevision,
      ':legacyRevision': 1
    }
  }));
}

function capacityTableName() {
  const tableName = process.env.GPU_CAPACITY_TABLE ?? process.env.CAPACITY_TABLE;
  if (!tableName) throw new HttpError(503, 'GPU capacity storage is not configured. Set GPU_CAPACITY_TABLE.');
  return tableName;
}

function createSecret() {
  return `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(digest).toString('hex');
}

function heartbeatMaximumAgeSeconds() {
  return integerEnvironmentValue('CAPACITY_HEARTBEAT_MAX_AGE_SECONDS', 120, 30, 3600);
}

function assignmentTimeoutSeconds() {
  return integerEnvironmentValue('CAPACITY_ASSIGNMENT_TIMEOUT_SECONDS', 300, 30, 3600);
}

function earningsHoldSeconds() {
  return integerEnvironmentValue('CAPACITY_EARNINGS_HOLD_SECONDS', 604800, 0, 2592000);
}

function minimumPayoutAmount() {
  const value = Number(process.env.CAPACITY_MINIMUM_PAYOUT_AMOUNT ?? 25);
  return Number.isFinite(value) && value >= 0 ? value : 25;
}

function platformFeeBps() {
  return integerEnvironmentValue('CAPACITY_PLATFORM_FEE_BPS', 1000, 0, 5000);
}

function integerEnvironmentValue(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

async function authenticate(authorizationHeader) {
  if (!authorizationHeader?.startsWith('Bearer ')) throw new HttpError(401, 'A bearer access token is required.');
  const token = authorizationHeader.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed access token.');
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256') throw new HttpError(401, `Unsupported token algorithm ${header.alg}.`);
  const issuer = requireEnvironmentVariable('AUTH_ISSUER').replace(/\/$/, '');
  if (String(payload.iss ?? '').replace(/\/$/, '') !== issuer) throw new HttpError(401, 'Token issuer did not match.');
  if (payload.token_use && payload.token_use !== 'access') throw new HttpError(401, 'An access token is required.');
  const expectedClientIds = requireEnvironmentVariable('AUTH_AUDIENCE').split(',').map((value) => value.trim()).filter(Boolean);
  const presentedClientId = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : undefined;
  if (!presentedClientId || !expectedClientIds.includes(presentedClientId)) throw new HttpError(401, 'Token was issued for a different Cognito app client. Sign out and sign in again.');
  const currentUnixTime = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= currentUnixTime) throw new HttpError(401, 'Access token has expired.');
  if (payload.nbf && payload.nbf > currentUnixTime + 30) throw new HttpError(401, 'Access token is not active yet.');
  const metadata = await getMetadata(issuer);
  const keys = await getJwks(metadata.jwks_uri);
  const key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
  if (!key) throw new HttpError(401, 'Token signing key was not found.');
  const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new HttpError(401, 'Access token signature was invalid.');
  return payload;
}

async function getMetadata(issuer) {
  const cached = metadataCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new HttpError(503, 'Identity provider discovery failed.');
  const value = await response.json();
  metadataCache.set(issuer, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

async function getJwks(jwksUri) {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(jwksUri);
  if (!response.ok) throw new HttpError(503, 'Identity provider signing keys could not be loaded.');
  const value = await response.json();
  jwksCache.set(jwksUri, { value: value.keys, expiresAt: Date.now() + 15 * 60 * 1000 });
  return value.keys;
}

async function listGateways() {
  const builtInGateways = [
    { id: 'huggingface', name: 'Hugging Face', schemes: ['hf'], capabilities: ['resolve', 'download', 'auth'] },
    { id: 'direct', name: 'Direct HTTPS', schemes: ['http', 'https'], capabilities: ['resolve', 'download'] },
    { id: 'ollama', name: 'Ollama Registry', schemes: ['ollama'], capabilities: ['resolve', 'native-pull'] }
  ];
  const tableName = process.env.GATEWAY_REGISTRY_TABLE;
  if (!tableName) return builtInGateways;
  const response = await dynamoDocumentClient.send(new ScanCommand({ TableName: tableName }));
  return [...builtInGateways, ...(response.Items ?? [])];
}

function validateGatewaySubmission(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Gateway submission must be an object.');
  const id = requireString(input.id, 'id');
  const name = requireString(input.name, 'name');
  const packageName = requireString(input.packageName, 'packageName');
  const repository = requireString(input.repository, 'repository');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new HttpError(400, 'Gateway id is invalid.');
  if (!packageName.includes('openmodel-gateway')) throw new HttpError(400, 'Gateway package name must clearly identify itself as an OpenModel gateway.');
  return { id, name, packageName, repository, apiVersion: 1, submittedAt: new Date().toISOString() };
}

function userDisplayName(user) {
  return user.name ?? user.username ?? user['cognito:username'] ?? user.email ?? 'OpenModel provider';
}

function hasPermission(payload, permission) {
  const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];
  const scopes = String(payload.scope ?? '').split(/\s+/).filter(Boolean);
  return permissions.includes(permission) || scopes.some((scope) => scope === permission || scope.endsWith(`/${permission}`));
}

function hasHyperscalerPermission(payload, permission = 'capacity:master') {
  if (hasPermission(payload, permission) || hasPermission(payload, 'capacity:master')) return true;
  const groups = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'].map((value) => String(value).toLowerCase()) : [];
  if (groups.includes('hyperscalers') || groups.includes('capacity-masters')) return true;
  const subjects = String(process.env.HYPERSCALER_SUBJECTS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return subjects.includes(payload.sub);
}

function requirePermission(payload, permission) {
  if (!hasPermission(payload, permission)) throw new HttpError(403, `Permission ${permission} is required.`);
}

function requireHyperscaler(payload, permission = 'capacity:master') {
  if (!hasHyperscalerPermission(payload, permission)) throw new HttpError(403, `Hyperscaler master permission ${permission} is required.`);
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, `${fieldName} is required.`);
  return value.trim();
}

function requirePositiveInteger(value, fieldName, options = {}) {
  const numericValue = Number(value);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(numericValue) || numericValue < minimum) throw new HttpError(400, `${fieldName} must be an integer greater than or equal to ${minimum}.`);
  return numericValue;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function parseJsonBody(body, isBase64Encoded, fallback) {
  if (!body) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, 'A JSON request body is required.');
  }
  const decodedBody = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  try { return JSON.parse(decodedBody); } catch { throw new HttpError(400, 'The request body must contain valid JSON.'); }
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function normalizePath(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function createCorsHeaders(origin, allowedOriginsValue) {
  const defaultOrigins = ['https://openmodel.sh', 'https://www.openmodel.sh', 'https://walton.bot', 'https://www.walton.bot'];
  const allowedOrigins = [...new Set([...allowedOriginsValue.split(',').map((value) => value.trim()).filter(Boolean), ...defaultOrigins])];
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '*';
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'authorization, content-type, idempotency-key',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    vary: 'Origin'
  };
}

function createResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: body === null ? '' : JSON.stringify(body)
  };
}

function decodeJson(value) {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new HttpError(401, 'Malformed access token payload.'); }
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) throw new HttpError(503, `${name} is not configured.`);
  return value;
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
