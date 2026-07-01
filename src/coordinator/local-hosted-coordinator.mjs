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
      const prepared = prepareInput(input, config, sessionKey, clock);
      const key = idempotencyOperationKey({
        objectId: prepared.objectId,
        idempotencyKey: prepared.idempotencyKey,
        bytes: prepared.bytes,
      });
      const existing = idempotencyStore.get(key);
      if (existing?.state === "completed") return existing.result;
      if (existing?.state === "failed") throw existing.error;
      if (existing?.state === "running") {
        throw new HostedCoordinatorError("upload_in_progress", "idempotent upload is in progress", {
          objectId: prepared.objectId,
          idempotencyKey: prepared.idempotencyKey,
        });
      }

      idempotencyStore.set(key, { state: "running" });
      try {
        const result = await executePreparedUpload({
          prepared,
          registry,
          focClient,
          sessionKey,
          config,
        });
        idempotencyStore.set(key, { state: "completed", result });
        return result;
      } catch (error) {
        const mapped =
          error?.code === "terminal_upload"
            ? error
            : await failPreparedUpload({
                prepared,
                registry,
                sessionKey,
                config,
                error,
              });
        idempotencyStore.set(key, { state: "failed", error: mapped });
        throw mapped;
      }
    },
  });
}

function prepareInput(input = {}, config, sessionKey, clock) {
  const objectId = required(input.objectId, "objectId");
  const request = required(input.request, "request");
  const bytes = validateUploadBytes({
    bytes: input.bytes,
    declaredSize: request.size,
    contentHash: input.contentHash ?? request.contentHash,
    contentHashAlgorithm: input.contentHashAlgorithm ?? request.contentHashAlgorithm,
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
  });

  return {
    objectId,
    request,
    bytes,
    idempotencyKey: input.idempotencyKey ?? request.idempotencyKey,
    account: input.account,
    metadata: input.metadata ?? {},
  };
}

async function executePreparedUpload({ prepared, registry, focClient, sessionKey, config }) {
  const currentObject = await readUploadObject(registry, prepared);
  if (currentObject?.status && TERMINAL_UPLOAD_STATUSES.includes(currentObject.status)) {
    throw new HostedCoordinatorError("terminal_upload", "terminal upload cannot accept bytes", {
      objectId: prepared.objectId,
      status: currentObject.status,
    });
  }

  if (currentObject?.status !== "Uploading") {
    await startOrResumeUploading({ prepared, registry, sessionKey });
  }

  const synapseResult = await focClient.upload({
    objectId: prepared.objectId,
    request: prepared.request,
    bytes: prepared.bytes,
    sessionKey: publicSessionKey(sessionKey),
    metadata: prepared.metadata,
  });
  const receipt = mapSynapseResultToUploadReceipt({
    result: synapseResult,
    request: prepared.request,
    payer: synapseResult?.payer ?? config.rootAddress ?? sessionKey.rootAddress,
  });
  const finalizeResult = await requiredCall(registry.finalizeUpload, registry, {
    objectId: prepared.objectId,
    account: prepared.account,
    receipt: contractReceipt(receipt),
    sessionKey: publicSessionKey(sessionKey),
  });

  return Object.freeze({
    objectId: String(prepared.objectId),
    status: receipt.finalizationStatusLabel,
    receipt,
    registry: finalizeResult,
    mocked: {
      focBytesMoved: false,
      runner: config.runner,
      boundary: "local hosted coordinator with injected FOC adapter",
    },
  });
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
  return current?.object ?? current?.upload ?? current;
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
