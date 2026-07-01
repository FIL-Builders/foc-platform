import { readFileSync } from "node:fs";
import { decodeEventLog } from "viem";

const artifactUrl = new URL("../../artifacts/contracts/FocPlatformRegistry.json", import.meta.url);

export const registryArtifact = JSON.parse(readFileSync(artifactUrl, "utf8"));
export const registryAbi = registryArtifact.abi;

const FINALIZATION_STATUS = ["Committed", "Partial", "Failed"];

export function decodeRegistryLog(log) {
  const decoded = decodeEventLog({
    abi: registryAbi,
    data: log.data,
    topics: log.topics,
  });

  return {
    address: log.address,
    eventName: decoded.eventName,
    args: decoded.args,
    blockNumber: log.blockNumber,
    blockTimestamp: log.blockTimestamp,
    logIndex: log.logIndex,
    transactionHash: log.transactionHash,
  };
}

export function registryReadRequest(address, functionName, args = []) {
  return {
    address,
    abi: registryAbi,
    functionName,
    args,
  };
}

export function registryObjectRead(address, objectId) {
  return registryReadRequest(address, "getStorageObject", [BigInt(objectId)]);
}

export function registryUsageRead(address, accountId) {
  return registryReadRequest(address, "getAccountUsage", [accountId]);
}

export function registryCopyReceiptsRead(address, objectId) {
  return registryReadRequest(address, "getCopyReceipts", [BigInt(objectId)]);
}

export function registryReceiptPayerRead(address, objectId) {
  return registryReadRequest(address, "receiptPayer", [BigInt(objectId)]);
}

export function registryCoordinatorPolicyRead(address, coordinator) {
  return registryReadRequest(address, "coordinatorPolicies", [coordinator]);
}

export function registryRelayerRead(address, relayer) {
  return registryReadRequest(address, "isRelayer", [relayer]);
}

export function registryDatasetRecordRead(address, accountId, providerId, datasetId) {
  return registryReadRequest(address, "getDatasetRecord", [
    accountId,
    BigInt(providerId),
    BigInt(datasetId),
  ]);
}

export function createRegistryReadModel() {
  return {
    objects: {},
    usage: {},
    copyReceipts: {},
    receiptPayers: {},
    datasets: {},
    coordinators: {},
    relayers: {},
    idempotency: {},
  };
}

export function applyRegistryEvents(events, model = createRegistryReadModel()) {
  for (const event of events) {
    applyRegistryEvent(model, event);
  }
  return model;
}

export function applyRegistryEvent(model, event) {
  const args = event.args ?? {};
  const timestamp = eventTimestamp(event);

  switch (event.eventName) {
    case "UsageReserved":
      applyUsageReserved(model, args);
      break;
    case "UploadRequested":
      applyUploadRequested(model, args, timestamp);
      break;
    case "UploadStarted":
      patchObject(
        model,
        args.objectId,
        withTimestamp(
          {
            status: "Uploading",
            coordinator: args.coordinator,
            startedAt: decimal(args.startedAt),
          },
          timestamp,
          "updatedAt",
        ),
      );
      break;
    case "CopyRecorded":
      applyCopyRecorded(model, args);
      break;
    case "ReceiptPayerRecorded":
      applyReceiptPayerRecorded(model, args);
      break;
    case "UsageReleased":
      applyUsageReleased(model, args);
      break;
    case "UsageFinalized":
      applyUsageFinalized(model, args);
      break;
    case "UploadFinalized":
      applyUploadFinalized(model, args, timestamp);
      break;
    case "UploadFailed":
      applyUploadFailed(model, args, timestamp);
      break;
    case "UploadCancelled":
      patchObject(
        model,
        args.objectId,
        withTimestamp({ status: "Cancelled" }, timestamp, "updatedAt"),
      );
      break;
    case "UploadExpired":
      patchObject(
        model,
        args.objectId,
        withTimestamp({ status: "Expired" }, timestamp, "updatedAt"),
      );
      break;
    case "CoordinatorUpdated":
      model.coordinators[lower(args.coordinator)] = {
        allowed: Boolean(args.allowed),
        maxFinalizeDelay: decimal(args.maxFinalizeDelay),
        sessionKeyExpiresAt: decimal(args.sessionKeyExpiresAt),
        permissionsHash: args.permissionsHash,
      };
      break;
    case "RelayerUpdated":
      model.relayers[lower(args.relayer)] = Boolean(args.allowed);
      break;
    case "DatasetRecorded":
      applyDatasetRecorded(model, args, timestamp);
      break;
    default:
      break;
  }

  return model;
}

function applyUsageReserved(model, args) {
  const usage = ensureUsage(model, args.accountId);
  usage.reservedCost = add(usage.reservedCost, args.reservedCost);
  usage.lastActiveBytesBeforeReservation = decimal(args.activeBytesBefore);
}

function applyUploadRequested(model, args, timestamp) {
  const objectId = id(args.objectId);
  const accountId = args.accountId;

  model.objects[objectId] = withTimestamps(
    {
      objectId,
      accountId,
      user: args.user,
      idempotencyKey: args.idempotencyKey,
      contentHash: args.contentHash,
      metadataHash: args.metadataHash,
      size: decimal(args.size),
      requestedCopies: number(args.requestedCopies),
      withCDN: Boolean(args.withCDN),
      maxCost: decimal(args.maxCost),
      reservedCost: decimal(args.maxCost),
      requestExpiresAt: decimal(args.requestExpiresAt),
      status: "Requested",
    },
    timestamp,
    ["createdAt", "updatedAt"],
  );
  model.idempotency[`${accountId}:${args.idempotencyKey}`] = objectId;

  const usage = ensureUsage(model, accountId);
  usage.pendingBytes = add(usage.pendingBytes, requestedBytes(args));
  usage.totalRequestedUploads = add(usage.totalRequestedUploads, 1n);
}

function applyCopyRecorded(model, args) {
  const objectId = id(args.objectId);
  const receipt = {
    providerId: decimal(args.providerId),
    datasetId: decimal(args.datasetId),
    pieceId: decimal(args.pieceId),
    addPieceTxHash: args.addPieceTxHash,
    retrievalUrlHash: args.retrievalUrlHash,
    isNewDataSet: Boolean(args.isNewDataSet),
  };

  model.copyReceipts[objectId] ??= [];
  model.copyReceipts[objectId].push(receipt);
}

function applyReceiptPayerRecorded(model, args) {
  const objectId = id(args.objectId);
  model.receiptPayers[objectId] = args.payer;
  patchObject(model, objectId, { receiptPayer: args.payer });
}

function applyUsageReleased(model, args) {
  const usage = ensureUsage(model, args.accountId);
  const object = model.objects[id(args.objectId)];
  const reservedCost = object?.reservedCost ?? object?.maxCost ?? args.releasedCost;
  usage.reservedCost = subtract(usage.reservedCost, reservedCost);
  if (object?.size !== undefined && object?.requestedCopies !== undefined) {
    usage.pendingBytes = subtract(usage.pendingBytes, requestedBytes(object));
  }
  usage.lastReleasedCost = decimal(args.releasedCost);
}

function applyUsageFinalized(model, args) {
  const usage = ensureUsage(model, args.accountId);
  const activeBytesDelta = bigint(args.activeBytesDelta);

  usage.totalActualCost = add(usage.totalActualCost, args.actualCost);
  if (activeBytesDelta > 0n) {
    usage.activeBytes = add(usage.activeBytes, activeBytesDelta);
    usage.activeObjects = add(usage.activeObjects, 1n);
    usage.totalUploadedBytes = add(usage.totalUploadedBytes, activeBytesDelta);
  }
}

function applyUploadFinalized(model, args, timestamp) {
  const objectId = id(args.objectId);
  const status = finalizationStatus(args.finalizationStatus);

  patchObject(
    model,
    objectId,
    withTimestamp(
      {
        status,
        pieceCidHash: args.pieceCidHash,
        completedCopies: number(args.completedCopies),
        actualCost: decimal(args.actualCost),
        receiptHash: args.receiptHash,
      },
      timestamp,
      "updatedAt",
    ),
  );

  const usage = ensureUsage(model, args.accountId);
  if (status === "Failed") {
    usage.totalFailedUploads = add(usage.totalFailedUploads, 1n);
  } else {
    usage.totalFinalizedUploads = add(usage.totalFinalizedUploads, 1n);
  }
}

function applyUploadFailed(model, args, timestamp) {
  patchObject(
    model,
    args.objectId,
    withTimestamp(
      {
        status: "Failed",
        failureReasonHash: args.reasonHash,
        actualCost: decimal(args.chargedCost),
      },
      timestamp,
      "updatedAt",
    ),
  );

  const usage = ensureUsage(model, args.accountId);
  usage.totalActualCost = add(usage.totalActualCost, args.chargedCost);
  usage.totalFailedUploads = add(usage.totalFailedUploads, 1n);
}

function applyDatasetRecorded(model, args, timestamp) {
  const key = `${args.accountId}:${decimal(args.providerId)}:${decimal(args.datasetId)}`;
  model.datasets[key] = withTimestamp(
    {
      accountId: args.accountId,
      providerId: decimal(args.providerId),
      datasetId: decimal(args.datasetId),
      payer: args.payer,
      storageClass: args.storageClass,
      withCDN: Boolean(args.withCDN),
    },
    timestamp,
    "updatedAt",
  );
}

function patchObject(model, objectIdValue, patch) {
  const objectId = id(objectIdValue);
  model.objects[objectId] ??= { objectId };
  Object.assign(model.objects[objectId], patch);
}

function ensureUsage(model, accountId) {
  model.usage[accountId] ??= {
    activeBytes: "0",
    activeObjects: "0",
    pendingBytes: "0",
    reservedCost: "0",
    totalActualCost: "0",
    totalUploadedBytes: "0",
    totalRequestedUploads: "0",
    totalFinalizedUploads: "0",
    totalFailedUploads: "0",
  };
  return model.usage[accountId];
}

function finalizationStatus(value) {
  if (typeof value === "string") return value;
  return FINALIZATION_STATUS[number(value)] ?? `Unknown(${decimal(value)})`;
}

function eventTimestamp(event) {
  if (event.blockTimestamp === undefined || event.blockTimestamp === null) return undefined;
  return decimal(event.blockTimestamp);
}

function withTimestamp(object, timestamp, field) {
  if (timestamp === undefined) return object;
  return { ...object, [field]: timestamp };
}

function withTimestamps(object, timestamp, fields) {
  if (timestamp === undefined) return object;
  const patch = {};
  for (const field of fields) {
    patch[field] = timestamp;
  }
  return { ...object, ...patch };
}

function id(value) {
  return decimal(value);
}

function decimal(value) {
  return bigint(value).toString();
}

function number(value) {
  return Number(bigint(value));
}

function bigint(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function add(current, value) {
  return (bigint(current) + bigint(value)).toString();
}

function subtract(current, value) {
  return (bigint(current) - bigint(value)).toString();
}

function lower(address) {
  return address.toLowerCase();
}

function requestedBytes(object) {
  return bigint(object.size) * bigint(object.requestedCopies);
}
