import { readFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData } from "viem";

const artifactUrl = new URL("../../artifacts/contracts/FocPlatformRegistry.json", import.meta.url);

export const registryArtifact = JSON.parse(readFileSync(artifactUrl, "utf8"));
export const registryAbi = registryArtifact.abi;

const FINALIZATION_STATUS = ["Committed", "Partial", "Failed"];
const UPLOAD_STATUS = [
  "None",
  "Requested",
  "Uploading",
  "Committed",
  "Partial",
  "Failed",
  "Cancelled",
  "Expired",
  "Deleted",
];
const REGISTRY_MAX_LIST_LIMIT = 50n;
const STORAGE_OBJECT_FIELDS = [
  "objectId",
  "accountId",
  "user",
  "idempotencyKey",
  "contentHash",
  "metadataHash",
  "pieceCidHash",
  "size",
  "requestedCopies",
  "completedCopies",
  "withCDN",
  "maxCost",
  "reservedCost",
  "actualCost",
  "status",
  "coordinator",
  "requestExpiresAt",
  "createdAt",
  "updatedAt",
  "receiptHash",
];
const ACCOUNT_USAGE_FIELDS = [
  "activeBytes",
  "activeObjects",
  "pendingBytes",
  "reservedCost",
  "totalActualCost",
  "totalUploadedBytes",
  "totalRequestedUploads",
  "totalFinalizedUploads",
  "totalFailedUploads",
];
const COPY_RECEIPT_FIELDS = [
  "providerId",
  "datasetId",
  "pieceId",
  "addPieceTxHash",
  "retrievalUrlHash",
  "isNewDataSet",
];
const COORDINATOR_POLICY_FIELDS = [
  "allowed",
  "maxFinalizeDelay",
  "sessionKeyExpiresAt",
  "permissionsHash",
];
const DATASET_RECORD_FIELDS = [
  "accountId",
  "payer",
  "providerId",
  "datasetId",
  "storageClass",
  "withCDN",
  "createdAt",
  "updatedAt",
];
const DATASET_KEY_FIELDS = ["accountId", "providerId", "datasetId"];

export const registryDirectReadDefaults = Object.freeze({
  sourceOfTruth: "FocPlatformRegistryDirectReads",
  eventProjectionRole: "auditFallbackOnly",
  maxPageSize: Number(REGISTRY_MAX_LIST_LIMIT),
  batchMethod: "readBatch",
});

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

export function registryReadCallData(read) {
  return encodeFunctionData({
    abi: read.abi ?? registryAbi,
    functionName: read.functionName,
    args: read.args ?? [],
  });
}

export function registryMaxListLimitRead(address) {
  return registryReadRequest(address, "MAX_LIST_LIMIT");
}

export function registryObjectCountRead(address) {
  return registryReadRequest(address, "objectCount");
}

export function registryAccountCountRead(address) {
  return registryReadRequest(address, "accountCount");
}

export function registryDatasetRecordCountRead(address) {
  return registryReadRequest(address, "datasetRecordCount");
}

export function registryCoordinatorCountRead(address) {
  return registryReadRequest(address, "coordinatorCount");
}

export function registryRelayerCountRead(address) {
  return registryReadRequest(address, "relayerCount");
}

export function registryStorageObjectIdsPageRead(
  address,
  { cursorIdExclusive = 0n, limit = REGISTRY_MAX_LIST_LIMIT, includeTerminal = true } = {},
) {
  return registryReadRequest(address, "listStorageObjectIds", [
    BigInt(cursorIdExclusive),
    BigInt(limit),
    Boolean(includeTerminal),
  ]);
}

export function registryAccountObjectIdsPageRead(
  address,
  accountId,
  { cursorIdExclusive = 0n, limit = REGISTRY_MAX_LIST_LIMIT, includeTerminal = true } = {},
) {
  return registryReadRequest(address, "listAccountObjectIds", [
    accountId,
    BigInt(cursorIdExclusive),
    BigInt(limit),
    Boolean(includeTerminal),
  ]);
}

export function registryAccountIdsPageRead(
  address,
  { offset = 0n, limit = REGISTRY_MAX_LIST_LIMIT } = {},
) {
  return registryReadRequest(address, "listAccountIds", [BigInt(offset), BigInt(limit)]);
}

export function registryDatasetKeysPageRead(
  address,
  { offset = 0n, limit = REGISTRY_MAX_LIST_LIMIT } = {},
) {
  return registryReadRequest(address, "listDatasetKeys", [BigInt(offset), BigInt(limit)]);
}

export function registryCoordinatorAddressesPageRead(
  address,
  { offset = 0n, limit = REGISTRY_MAX_LIST_LIMIT } = {},
) {
  return registryReadRequest(address, "listCoordinatorAddresses", [BigInt(offset), BigInt(limit)]);
}

export function registryRelayerAddressesPageRead(
  address,
  { offset = 0n, limit = REGISTRY_MAX_LIST_LIMIT } = {},
) {
  return registryReadRequest(address, "listRelayerAddresses", [BigInt(offset), BigInt(limit)]);
}

export function registryReadBatchRead(address, calls) {
  return registryReadRequest(address, "readBatch", [
    Array.from(calls, (call) => (typeof call === "string" ? call : registryReadCallData(call))),
  ]);
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

export function registryObjectDetailReads(address, objectId) {
  return {
    object: registryObjectRead(address, objectId),
    copyReceipts: registryCopyReceiptsRead(address, objectId),
    receiptPayer: registryReceiptPayerRead(address, objectId),
  };
}

export function registryDatasetDetailRead(address, key) {
  const { accountId, providerId, datasetId } = normalizeRegistryDatasetKey(key);
  return registryDatasetRecordRead(address, accountId, providerId, datasetId);
}

export function registryCoordinatorDetailRead(address, coordinator) {
  return registryCoordinatorPolicyRead(address, coordinator);
}

export function registryRelayerDetailRead(address, relayer) {
  return registryRelayerRead(address, relayer);
}

export function normalizeRegistryStorageObject(value) {
  const object = struct(value, STORAGE_OBJECT_FIELDS);
  return {
    objectId: decimal(object.objectId ?? 0n),
    accountId: object.accountId,
    user: object.user,
    idempotencyKey: object.idempotencyKey,
    contentHash: object.contentHash,
    metadataHash: object.metadataHash,
    pieceCidHash: object.pieceCidHash,
    size: decimal(object.size),
    requestedCopies: number(object.requestedCopies),
    completedCopies: number(object.completedCopies),
    withCDN: Boolean(object.withCDN),
    maxCost: decimal(object.maxCost),
    reservedCost: decimal(object.reservedCost ?? object.maxCost ?? 0n),
    actualCost: decimal(object.actualCost),
    status: uploadStatus(object.status),
    coordinator: object.coordinator,
    requestExpiresAt: decimal(object.requestExpiresAt),
    createdAt: decimal(object.createdAt),
    updatedAt: decimal(object.updatedAt),
    receiptHash: object.receiptHash,
  };
}

export function normalizeRegistryAccountUsage(value) {
  const usage = struct(value, ACCOUNT_USAGE_FIELDS);
  return Object.fromEntries(
    ACCOUNT_USAGE_FIELDS.map((field) => [field, decimal(usage[field])]),
  );
}

export function normalizeRegistryCopyReceipt(value) {
  const receipt = struct(value, COPY_RECEIPT_FIELDS);
  return {
    providerId: decimal(receipt.providerId),
    datasetId: decimal(receipt.datasetId),
    pieceId: decimal(receipt.pieceId),
    addPieceTxHash: receipt.addPieceTxHash,
    retrievalUrlHash: receipt.retrievalUrlHash,
    isNewDataSet: Boolean(receipt.isNewDataSet),
  };
}

export function normalizeRegistryCoordinatorPolicy(value) {
  const policy = struct(value, COORDINATOR_POLICY_FIELDS);
  return {
    allowed: Boolean(policy.allowed),
    maxFinalizeDelay: decimal(policy.maxFinalizeDelay),
    sessionKeyExpiresAt: decimal(policy.sessionKeyExpiresAt),
    permissionsHash: policy.permissionsHash,
  };
}

export function normalizeRegistryDatasetRecord(value) {
  const dataset = struct(value, DATASET_RECORD_FIELDS);
  return {
    accountId: dataset.accountId,
    payer: dataset.payer,
    providerId: decimal(dataset.providerId),
    datasetId: decimal(dataset.datasetId),
    storageClass: dataset.storageClass,
    withCDN: Boolean(dataset.withCDN),
    createdAt: decimal(dataset.createdAt),
    updatedAt: decimal(dataset.updatedAt),
  };
}

export function normalizeRegistryDatasetKey(value) {
  const key = struct(value, DATASET_KEY_FIELDS);
  return {
    accountId: key.accountId,
    providerId: decimal(key.providerId),
    datasetId: decimal(key.datasetId),
  };
}

export function registryDatasetKeyId(key) {
  const normalized = normalizeRegistryDatasetKey(key);
  return `${normalized.accountId}:${normalized.providerId}:${normalized.datasetId}`;
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
  for (const event of orderedRegistryEvents(events)) {
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

function uploadStatus(value) {
  if (typeof value === "string" && !/^\d+$/.test(value)) return value;
  return UPLOAD_STATUS[number(value)] ?? `Unknown(${decimal(value)})`;
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
  if (value === undefined || value === null || value === "") return 0n;
  return typeof value === "bigint" ? value : BigInt(value);
}

function add(current, value) {
  return (bigint(current) + bigint(value)).toString();
}

function subtract(current, value) {
  const result = bigint(current) - bigint(value);
  return (result < 0n ? 0n : result).toString();
}

function orderedRegistryEvents(events) {
  const list = Array.from(events);
  if (!list.every(hasLogPosition)) return list;

  return list
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) => compareLogPosition(left.event, right.event) || left.index - right.index,
    )
    .map(({ event }) => event);
}

function hasLogPosition(event) {
  return (
    event?.blockNumber !== undefined &&
    event.blockNumber !== null &&
    event?.logIndex !== undefined &&
    event.logIndex !== null
  );
}

function compareLogPosition(left, right) {
  return (
    compareBigint(left.blockNumber, right.blockNumber) ||
    compareBigint(left.logIndex, right.logIndex)
  );
}

function compareBigint(left, right) {
  const leftValue = bigint(left);
  const rightValue = bigint(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function lower(address) {
  return address.toLowerCase();
}

function requestedBytes(object) {
  return bigint(object.size) * bigint(object.requestedCopies);
}

function struct(value, fields) {
  if (!value) return {};
  if (!Array.isArray(value)) return value;

  return Object.fromEntries(
    fields.map((field, index) => [field, value[field] ?? value[index]]),
  );
}
