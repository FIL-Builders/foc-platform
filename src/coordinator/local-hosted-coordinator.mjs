import {
  CoordinatorConfigError,
  ZERO_BYTES32,
  assertActiveSessionKey,
  publicCoordinatorConfig,
} from "./config.mjs";
import {
  TERMINAL_UPLOAD_STATUSES,
  createFailureReceipt,
  idempotencyOperationKey,
  mapFailureToReasonHash,
  mapSynapseResultToUploadReceipt,
  validateUploadBytes,
} from "./receipts.mjs";

export class HostedCoordinatorError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, { cause });
    this.name = "HostedCoordinatorError";
    this.code = code;
    this.details = details;
  }
}

const UPLOAD_STATUS_LABELS = Object.freeze([
  "None",
  "Requested",
  "Uploading",
  "Committed",
  "Partial",
  "Failed",
  "Cancelled",
  "Expired",
  "Deleted",
]);
const PRE_FOC_RETRYABLE_ERROR = Symbol("preFocRetryableError");
const FINALIZE_RECEIPT = Symbol("finalizeReceipt");

export function createLocalHostedCoordinator({
  config,
  registry,
  focClient,
  sessionKey,
  idempotencyStore = new Map(),
  clock = () => BigInt(Math.floor(Date.now() / 1000)),
} = {}) {
  if (!config) throw new HostedCoordinatorError("missing_config", "coordinator config is required");
  if (!registry) {
    throw new HostedCoordinatorError("missing_registry", "registry adapter is required");
  }
  if (!focClient) {
    throw new HostedCoordinatorError("missing_foc_client", "FOC client adapter is required");
  }

  return Object.freeze({
    config: publicCoordinatorConfig(config),
    async executeUpload(input) {
      const preflightIdempotency = preflightIdempotencyOperation(input);
      if (preflightIdempotency) {
        const cached = cachedIdempotencyResult(
          idempotencyStore.get(preflightIdempotency.key),
          preflightIdempotency,
        );
        if (cached.hit) return cached.result;
      }
      const prepared = prepareInput(input, config, sessionKey, clock);
      const key =
        preflightIdempotency?.key ??
        coordinatorIdempotencyOperationKey({
          objectId: prepared.objectId,
          idempotencyKey: prepared.idempotencyKey,
          bytes: prepared.bytes,
          account: prepared.account,
        });
      const cached = cachedIdempotencyResult(idempotencyStore.get(key), prepared);
      if (cached.hit) return cached.result;

      idempotencyStore.set(key, { state: "running" });
      try {
        const result = cached.pendingFinalize
          ? await finalizePreparedReceipt({
              prepared,
              registry,
              receipt: cached.pendingFinalize.receipt,
              sessionKey,
              config,
            })
          : await executePreparedUpload({
              prepared,
              registry,
              focClient,
              sessionKey,
              config,
              clock,
            });
        idempotencyStore.set(key, { state: "completed", result });
        return result;
      } catch (error) {
        if (error?.code === "finalize_upload_failed" && error[FINALIZE_RECEIPT]) {
          idempotencyStore.set(key, { state: "pending_finalize", receipt: error[FINALIZE_RECEIPT] });
          throw error;
        }
        if (isPreFocRetryableError(error) || error?.code === "finalize_upload_failed") {
          idempotencyStore.delete(key);
          throw error;
        }
        const mapped =
          error?.code === "terminal_upload" ||
          error?.code === "request_expired" ||
          error?.code === "invalid_request_expiry"
            ? error
            : await failPreparedUpload({
                prepared,
                registry,
                sessionKey,
                config,
                error,
              });
        if (mapped.code === "finalize_upload_failed") {
          idempotencyStore.delete(key);
          throw mapped;
        }
        idempotencyStore.set(key, { state: "failed", error: mapped });
        throw mapped;
      }
    },
  });
}

function prepareInput(input = {}, config, sessionKey, clock) {
  const objectId = required(input.objectId, "objectId");
  const request = required(input.request, "request");
  const contentCommitment = resolveContentCommitment(input, request);
  const bytes = validateUploadBytes({
    bytes: input.bytes,
    declaredSize: request.size,
    contentHash: contentCommitment.contentHash,
    contentHashAlgorithm: contentCommitment.contentHashAlgorithm,
  });

  if (config.maxBytes !== undefined && BigInt(bytes.byteLength) > config.maxBytes) {
    throw new HostedCoordinatorError("max_bytes_exceeded", "upload exceeds coordinator max bytes", {
      maxBytes: config.maxBytes.toString(),
      actualBytes: String(bytes.byteLength),
    });
  }
  assertActiveSessionKey(sessionKey, {
    now: clock(),
    requiredPermissionsHash: config.permissionsHash ?? ZERO_BYTES32,
    requiredSessionKeyAddress: config.sessionKeyAddress ?? config.coordinatorAddress,
    requiredSessionKeyExpiresAt: config.sessionKeyExpiresAt,
    requiredRootAddress: config.rootAddress,
  });

  return {
    objectId,
    request,
    bytes,
    idempotencyKey: request.idempotencyKey ?? input.idempotencyKey,
    account: input.account,
    metadata: input.metadata ?? {},
  };
}

function resolveContentCommitment(input, request) {
  const requestAlgorithm = request.contentHashAlgorithm;
  const requestHash = request.contentHash;
  if (requestAlgorithm) {
    if (
      input.contentHashAlgorithm !== undefined &&
      input.contentHashAlgorithm !== requestAlgorithm
    ) {
      throw new HostedCoordinatorError(
        "content_hash_algorithm_conflict",
        "upload content hash algorithm cannot override request commitment",
        {
          requestContentHashAlgorithm: requestAlgorithm,
          inputContentHashAlgorithm: input.contentHashAlgorithm,
        },
      );
    }
    if (hasContentHash(requestHash)) {
      if (
        input.contentHash !== undefined &&
        (!hasContentHash(input.contentHash) || !sameContentHash(input.contentHash, requestHash))
      ) {
        throw new HostedCoordinatorError(
          "content_hash_conflict",
          "upload content hash cannot override request commitment",
          {
            requestContentHash: requestHash,
            inputContentHash: input.contentHash,
          },
        );
      }
      return { contentHash: requestHash, contentHashAlgorithm: requestAlgorithm };
    }
    return {
      contentHash: input.contentHash,
      contentHashAlgorithm: requestAlgorithm,
    };
  }

  return {
    contentHash: input.contentHash,
    contentHashAlgorithm: input.contentHashAlgorithm,
  };
}

function hasContentHash(value) {
  return value !== undefined && value !== null && value !== "";
}

function sameContentHash(actual, expected) {
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function preflightIdempotencyOperation(input = {}) {
  const objectId = input?.objectId;
  const idempotencyKey = input?.request?.idempotencyKey ?? input?.idempotencyKey;
  if (objectId === undefined || objectId === null || objectId === "" || !idempotencyKey) {
    return undefined;
  }
  return {
    key: coordinatorIdempotencyOperationKey({
      objectId,
      idempotencyKey,
      account: input?.account,
    }),
    objectId,
    idempotencyKey,
  };
}

function coordinatorIdempotencyOperationKey({ objectId, idempotencyKey, bytes, account }) {
  const baseKey = idempotencyOperationKey({ objectId, idempotencyKey, bytes });
  const accountKey = accountIdempotencyScope(account);
  return accountKey ? `${accountKey}:${baseKey}` : baseKey;
}

function accountIdempotencyScope(account) {
  const value = account?.accountId ?? account?.id ?? account?.user ?? account?.address;
  if (value === undefined || value === null || value === "") return undefined;
  return String(value).toLowerCase();
}

function cachedIdempotencyResult(existing, details) {
  if (existing?.state === "completed") {
    return { hit: true, result: existing.result };
  }
  if (existing?.state === "failed") throw existing.error;
  if (existing?.state === "running") {
    throw new HostedCoordinatorError("upload_in_progress", "idempotent upload is in progress", {
      objectId: details.objectId,
      idempotencyKey: details.idempotencyKey,
    });
  }
  if (existing?.state === "pending_finalize") {
    return { hit: false, pendingFinalize: existing };
  }
  return { hit: false };
}

async function executePreparedUpload({ prepared, registry, focClient, sessionKey, config, clock }) {
  const currentObject = await preFocRetryableCall(() => readUploadObject(registry, prepared));
  if (currentObject?.status && TERMINAL_UPLOAD_STATUSES.includes(currentObject.status)) {
    throw new HostedCoordinatorError("terminal_upload", "terminal upload cannot accept bytes", {
      objectId: prepared.objectId,
      status: currentObject.status,
    });
  }
  validateRegistryRequest(prepared, currentObject);
  assertUploadRequestNotExpired({ prepared, object: currentObject, now: clock() });

  if (currentObject?.status !== "Uploading") {
    await preFocRetryableCall(() => startOrResumeUploading({ prepared, registry, sessionKey }));
  }

  assertUploadRequestNotExpired({ prepared, object: currentObject, now: clock() });
  let synapseResult;
  try {
    synapseResult = await focClient.upload({
      objectId: prepared.objectId,
      request: prepared.request,
      bytes: prepared.bytes,
      sessionKey: publicSessionKey(sessionKey),
      metadata: prepared.metadata,
    });
  } catch (error) {
    assertUploadRequestNotExpired({ prepared, object: currentObject, now: clock() });
    throw error;
  }
  assertUploadRequestNotExpired({ prepared, object: currentObject, now: clock() });
  const receipt = mapSynapseResultToUploadReceipt({
    result: synapseResult,
    request: prepared.request,
    payer: synapseResult?.payer ?? config.rootAddress ?? sessionKey.rootAddress,
  });
  return finalizePreparedReceipt({ prepared, registry, receipt, sessionKey, config });
}

async function finalizePreparedReceipt({ prepared, registry, receipt, sessionKey, config }) {
  let finalizeResult;
  try {
    finalizeResult = await requiredCall(registry.finalizeUpload, registry, {
      objectId: prepared.objectId,
      account: prepared.account,
      receipt: contractReceipt(receipt),
      sessionKey: publicSessionKey(sessionKey),
    });
  } catch (error) {
    const recovered = await recoverFinalizedUpload({
      prepared,
      registry,
      receipt,
      config,
      error,
    });
    if (recovered) return recovered;
    const finalizeError = new HostedCoordinatorError(
      "finalize_upload_failed",
      "registry finalization failed after FOC upload; retry without failing upload",
      {
        objectId: String(prepared.objectId),
        sourceCode: error?.code,
        sourceMessage: error?.message,
      },
      error,
    );
    Object.defineProperty(finalizeError, FINALIZE_RECEIPT, {
      value: receipt,
      configurable: true,
    });
    throw finalizeError;
  }

  return Object.freeze(uploadResult({ prepared, receipt, registryResult: finalizeResult, config }));
}

function validateRegistryRequest(prepared, object) {
  if (!object || typeof object !== "object") return;
  const mismatches = [];
  compareRegistryUint(mismatches, object, prepared.request, "size");
  compareRegistryUint(mismatches, object, prepared.request, "requestedCopies");
  compareRegistryUint(mismatches, object, prepared.request, "maxCost");
  compareRegistryUint(mismatches, object, prepared.request, "requestExpiresAt");
  compareRegistryBoolean(mismatches, object, prepared.request, "withCDN");
  compareRegistryContentHash(mismatches, object, prepared.request);
  compareRegistryString(mismatches, object, prepared.request, "contentHashAlgorithm");
  compareRegistryString(mismatches, object, prepared.request, "metadataHash", {
    normalize: (value) => String(value).toLowerCase(),
  });
  if (mismatches.length === 0) return;
  throw markPreFocRetryableError(
    new HostedCoordinatorError(
      "registry_request_mismatch",
      "registry upload request does not match prepared request",
      {
        objectId: String(prepared.objectId),
        mismatches,
      },
    ),
  );
}

function compareRegistryUint(mismatches, object, request, field) {
  if (!hasRegistryField(object, field)) return;
  if (equalUint(object[field], request[field])) return;
  mismatches.push({
    field,
    registry: String(object[field]),
    request: request[field] === undefined || request[field] === null ? undefined : String(request[field]),
  });
}

function compareRegistryBoolean(mismatches, object, request, field) {
  if (!hasRegistryField(object, field)) return;
  if (Boolean(object[field]) === Boolean(request[field])) return;
  mismatches.push({
    field,
    registry: String(Boolean(object[field])),
    request: String(Boolean(request[field])),
  });
}

function compareRegistryContentHash(mismatches, object, request) {
  if (!hasRegistryField(object, "contentHash")) return;
  const registryValue = normalizeRegistryContentHash(object.contentHash);
  const requestValue = hasContentHash(request?.contentHash)
    ? normalizeRegistryContentHash(request.contentHash)
    : ZERO_BYTES32;
  if (registryValue === requestValue) return;
  mismatches.push({
    field: "contentHash",
    registry: registryValue,
    request: requestValue,
  });
}

function normalizeRegistryContentHash(value) {
  return hasContentHash(value) ? String(value).toLowerCase() : ZERO_BYTES32;
}

function compareRegistryString(
  mismatches,
  object,
  request,
  field,
  { isPresent = (value) => hasRegistryField({ value }, "value"), normalize = String } = {},
) {
  if (!isPresent(object?.[field])) return;
  const registryValue = normalize(object[field]);
  const requestValue = isPresent(request?.[field]) ? normalize(request[field]) : undefined;
  if (registryValue === requestValue) return;
  mismatches.push({
    field,
    registry: registryValue,
    request: requestValue,
  });
}

function hasRegistryField(value, field) {
  return value?.[field] !== undefined && value?.[field] !== null && value?.[field] !== "";
}

async function preFocRetryableCall(call) {
  try {
    return await call();
  } catch (error) {
    if (isCoordinatorTerminalError(error)) throw error;
    throw markPreFocRetryableError(error);
  }
}

function isCoordinatorTerminalError(error) {
  return (
    error?.name === "HostedCoordinatorError" &&
    (error.code === "terminal_upload" ||
      error.code === "request_expired" ||
      error.code === "invalid_request_expiry")
  );
}

function markPreFocRetryableError(error) {
  if (error && typeof error === "object" && definePreFocRetryableMarker(error)) {
    return error;
  }
  const wrapped = new HostedCoordinatorError(
    "pre_foc_upload_failed",
    "pre-FOC upload step failed before bytes were committed",
    {},
    error,
  );
  definePreFocRetryableMarker(wrapped);
  return wrapped;
}

function definePreFocRetryableMarker(error) {
  try {
    Object.defineProperty(error, PRE_FOC_RETRYABLE_ERROR, {
      value: true,
      configurable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function isPreFocRetryableError(error) {
  return Boolean(error?.[PRE_FOC_RETRYABLE_ERROR]);
}

function assertUploadRequestNotExpired({ prepared, object, now }) {
  const requestExpiresAt = expiryValue(object?.requestExpiresAt ?? prepared.request.requestExpiresAt);
  if (requestExpiresAt === undefined || requestExpiresAt === 0n) return;
  const currentTime = BigInt(now);
  if (currentTime <= requestExpiresAt) return;
  throw new HostedCoordinatorError("request_expired", "upload request is expired", {
    objectId: String(prepared.objectId),
    requestExpiresAt: requestExpiresAt.toString(),
    now: currentTime.toString(),
  });
}

function expiryValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new HostedCoordinatorError("invalid_request_expiry", "upload request expiry is invalid", {
      requestExpiresAt: value,
    });
  }
}

function uploadResult({ prepared, receipt, registryResult, config }) {
  return {
    objectId: String(prepared.objectId),
    status: receipt.finalizationStatusLabel,
    receipt,
    registry: registryResult,
    mocked: {
      focBytesMoved: false,
      runner: config.runner,
      boundary: "local hosted coordinator with injected FOC adapter",
    },
  };
}

async function recoverFinalizedUpload({ prepared, registry, receipt, config, error }) {
  let latestObject;
  try {
    latestObject = await readUploadObject(registry, prepared);
  } catch {
    return undefined;
  }
  if (!uploadObjectMatchesReceipt(latestObject, receipt)) return undefined;
  return Object.freeze(
    uploadResult({
      prepared,
      receipt,
      registryResult: {
        recoveredAfterFinalizeError: true,
        object: latestObject,
        sourceCode: error?.code,
        sourceMessage: error?.message,
      },
      config,
    }),
  );
}

function uploadObjectMatchesReceipt(object, receipt) {
  return (
    object?.status === receipt.finalizationStatusLabel &&
    equalBytes32(object.receiptHash, receipt.receiptHash) &&
    equalBytes32(object.pieceCidHash, receipt.pieceCidHash) &&
    equalUint(object.completedCopies, receipt.completedCopies) &&
    equalUint(object.actualCost, receipt.actualCost)
  );
}

function equalBytes32(actual, expected) {
  if (actual === undefined || actual === null || expected === undefined || expected === null) {
    return false;
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

function equalUint(actual, expected) {
  if (actual === undefined || actual === null || expected === undefined || expected === null) {
    return false;
  }
  try {
    return BigInt(actual) === BigInt(expected);
  } catch {
    return false;
  }
}

async function startOrResumeUploading({ prepared, registry, sessionKey }) {
  try {
    await maybeCall(registry.startUpload, registry, {
      objectId: prepared.objectId,
      account: prepared.account,
      sessionKey: publicSessionKey(sessionKey),
    });
  } catch (error) {
    const latestObject = await readUploadObject(registry, prepared);
    if (latestObject?.status === "Uploading") return;
    if (latestObject?.status && TERMINAL_UPLOAD_STATUSES.includes(latestObject.status)) {
      throw new HostedCoordinatorError("terminal_upload", "terminal upload cannot accept bytes", {
        objectId: prepared.objectId,
        status: latestObject.status,
      });
    }
    throw error;
  }
}

async function readUploadObject(registry, prepared) {
  const current = await maybeCall(registry.readUploadStatus, registry, {
    objectId: prepared.objectId,
    account: prepared.account,
  });
  return normalizeUploadObjectStatus(current?.object ?? current?.upload ?? current);
}

function normalizeUploadObjectStatus(object) {
  if (!object || typeof object !== "object" || object.status === undefined) return object;
  const status = normalizeUploadStatus(object.status);
  if (status === object.status) return object;
  return { ...object, status };
}

function normalizeUploadStatus(status) {
  if (typeof status === "number" && Number.isInteger(status)) {
    return UPLOAD_STATUS_LABELS[status] ?? status;
  }
  if (typeof status === "bigint") {
    if (status >= 0n && status < BigInt(UPLOAD_STATUS_LABELS.length)) {
      return UPLOAD_STATUS_LABELS[Number(status)] ?? status;
    }
  }
  if (typeof status === "string" && /^[0-9]+$/.test(status)) {
    const numericStatus = Number(status);
    if (Number.isSafeInteger(numericStatus)) return UPLOAD_STATUS_LABELS[numericStatus] ?? status;
  }
  return status;
}

async function failPreparedUpload({ prepared, registry, sessionKey, config, error }) {
  const reasonHash = mapFailureToReasonHash(error);
  const failureReceipt = createFailureReceipt({
    request: prepared.request,
    payer: config.rootAddress ?? sessionKey.rootAddress,
    error,
  });

  let failResult;
  let failRecordError;
  try {
    failResult = await maybeCall(registry.failUpload, registry, {
      objectId: prepared.objectId,
      account: prepared.account,
      reasonHash,
      chargedCost: 0n,
      sessionKey: publicSessionKey(sessionKey),
      receipt: contractReceipt(failureReceipt),
    });
  } catch (recordError) {
    failRecordError = recordError;
  }

  return new HostedCoordinatorError(
    "coordinator_upload_failed",
    failRecordError
      ? "coordinator upload failed and registry failure recording failed"
      : "coordinator upload failed and registry failure was recorded when supported",
    {
      objectId: String(prepared.objectId),
      reasonHash,
      failResult,
      failRecordError: failRecordError
        ? {
            code: failRecordError.code,
            message: failRecordError.message,
            name: failRecordError.name,
          }
        : undefined,
      sourceCode: error?.code,
      sourceMessage: error?.message,
    },
    error,
  );
}

function publicSessionKey(sessionKey) {
  if (!sessionKey) throw new CoordinatorConfigError("missing_session_key", "session key is required");
  return Object.freeze({
    address: sessionKey.address,
    rootAddress: sessionKey.rootAddress,
    expiresAt: sessionKey.expiresAt.toString(),
    permissionsHash: sessionKey.permissionsHash,
  });
}

function contractReceipt(receipt) {
  return {
    finalizationStatus: receipt.finalizationStatus,
    payer: receipt.payer,
    pieceCidHash: receipt.pieceCidHash,
    size: receipt.size,
    requestedCopies: receipt.requestedCopies,
    completedCopies: receipt.completedCopies,
    actualCost: receipt.actualCost,
    receiptHash: receipt.receiptHash,
    copies: receipt.copies,
  };
}

async function maybeCall(fn, receiver, args) {
  if (typeof fn !== "function") return undefined;
  return fn.call(receiver, args);
}

async function requiredCall(fn, receiver, args) {
  if (typeof fn !== "function") {
    throw new HostedCoordinatorError(
      "missing_registry_finalize",
      "registry adapter must implement finalizeUpload",
    );
  }
  return fn.call(receiver, args);
}

function required(value, label) {
  if (value === undefined || value === null || value === "") {
    throw new HostedCoordinatorError(`missing_${label}`, `${label} is required`);
  }
  return value;
}
