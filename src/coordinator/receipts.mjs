import { bytesToHex, isAddress, keccak256, stringToHex, toBytes } from "viem";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const FINALIZATION_STATUS = Object.freeze({
  Committed: 0,
  Partial: 1,
  Failed: 2,
});

export const TERMINAL_UPLOAD_STATUSES = Object.freeze([
  "Committed",
  "Partial",
  "Failed",
  "Cancelled",
  "Expired",
  "Deleted",
]);

export class CoordinatorReceiptError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CoordinatorReceiptError";
    this.code = code;
    this.details = details;
  }
}

export function validateUploadBytes({
  bytes,
  declaredSize,
  contentHash,
  contentHashAlgorithm,
} = {}) {
  const data = normalizeBytes(bytes);
  const normalizedContentHash = normalizeContentHash(contentHash, contentHashAlgorithm);
  const size = BigInt(data.byteLength);
  if (size === 0n) {
    throw new CoordinatorReceiptError("empty_upload", "upload bytes are required");
  }
  if (declaredSize !== undefined && declaredSize !== null && BigInt(declaredSize) !== size) {
    throw new CoordinatorReceiptError("size_mismatch", "upload byte length does not match request", {
      declaredSize: BigInt(declaredSize).toString(),
      actualSize: size.toString(),
    });
  }
  if (normalizedContentHash && !contentHashAlgorithm) {
    throw new CoordinatorReceiptError(
      "missing_content_hash_algorithm",
      "content hash algorithm is required when content hash is declared",
      { contentHash: normalizedContentHash },
    );
  }
  if (normalizedContentHash && contentHashAlgorithm) {
    const actual = hashBytes(data, contentHashAlgorithm);
    if (actual !== normalizedContentHash) {
      throw new CoordinatorReceiptError(
        "content_commitment_mismatch",
        "upload bytes do not match declared content commitment",
        {
          contentHash: normalizedContentHash,
          actual,
          contentHashAlgorithm,
        },
      );
    }
  }
  return data;
}

export function mapSynapseResultToUploadReceipt({
  result = {},
  request,
  payer,
  receiptSalt = "foc-platform-local-coordinator:v1",
} = {}) {
  if (!request) {
    throw new CoordinatorReceiptError("missing_request", "upload request is required");
  }
  if (!isAddress(payer)) {
    throw new CoordinatorReceiptError("invalid_payer", "receipt payer must be an address");
  }

  const requestedCopies = numberOrDefault(request.requestedCopies, 1, "requestedCopies");
  const copies = normalizeCopies(result.copies ?? []);
  const completedCopies = normalizeCompletedCopies(result.completedCopies, copies.length);
  const actualCost = normalizeUint(result.actualCost ?? 0n, "actualCost");
  const maxCost = normalizeUint(request.maxCost ?? 0n, "maxCost");
  if (actualCost > maxCost) {
    throw new CoordinatorReceiptError(
      "actual_cost_exceeds_max_cost",
      "actual cost exceeds upload request maxCost",
      { actualCost: actualCost.toString(), maxCost: maxCost.toString() },
    );
  }
  if (completedCopies > requestedCopies) {
    throw new CoordinatorReceiptError(
      "completed_copies_exceed_requested",
      "completed copy count exceeds requested copies",
      { completedCopies: String(completedCopies), requestedCopies: String(requestedCopies) },
    );
  }
  const finalizationStatus = resolveFinalizationStatus({
    requestedCopies,
    completedCopies,
    explicitStatus: result.finalizationStatus,
  });
  validateFinalizationStatusForCopies({ finalizationStatus, completedCopies, requestedCopies });
  const pieceCidHash = normalizeBytes32(
    result.pieceCidHash ?? hashText(`piece-cid:${result.pieceCid ?? ""}`),
    "pieceCidHash",
  );
  const receiptHash = normalizeBytes32(
    result.receiptHash ??
      deriveReceiptHash({
        receiptSalt,
        request,
        payer,
        pieceCidHash,
        requestedCopies,
        completedCopies,
        actualCost,
        copies,
        source: result.source ?? "simulated-synapse",
      }),
    "receiptHash",
  );

  return Object.freeze({
    finalizationStatus,
    finalizationStatusLabel: statusLabel(finalizationStatus),
    payer,
    pieceCidHash,
    size: normalizeUint(request.size, "size"),
    requestedCopies,
    completedCopies,
    actualCost,
    receiptHash,
    copies,
  });
}

export function mapFailureToReasonHash(error, fallback = "coordinator_failure") {
  const code = error?.code ?? error?.name ?? fallback;
  const message = error?.message ?? String(error ?? fallback);
  return hashText(`failure:${code}:${message}`);
}

export function createFailureReceipt({ request, payer, error, chargedCost = 0n } = {}) {
  return mapSynapseResultToUploadReceipt({
    request,
    payer,
    result: {
      finalizationStatus: "Failed",
      completedCopies: 0,
      copies: [],
      actualCost: chargedCost,
      pieceCidHash: hashText("failed-piece-cid"),
      receiptHash: mapFailureToReasonHash(error),
      source: "coordinator-failure",
    },
  });
}

export function idempotencyOperationKey({ objectId, idempotencyKey, bytes }) {
  if (idempotencyKey) return `${String(objectId)}:${String(idempotencyKey).toLowerCase()}`;
  const data = bytes ? normalizeBytes(bytes) : new Uint8Array();
  return `${String(objectId)}:${keccak256(data)}`;
}

function resolveFinalizationStatus({ requestedCopies, completedCopies, explicitStatus }) {
  if (explicitStatus !== undefined && explicitStatus !== null) {
    if (typeof explicitStatus === "number") {
      if (![0, 1, 2].includes(explicitStatus)) {
        throw new CoordinatorReceiptError("invalid_finalization_status", "unknown receipt status");
      }
      return explicitStatus;
    }
    if (Object.hasOwn(FINALIZATION_STATUS, explicitStatus)) {
      return FINALIZATION_STATUS[explicitStatus];
    }
    throw new CoordinatorReceiptError("invalid_finalization_status", "unknown receipt status");
  }
  if (completedCopies === 0) return FINALIZATION_STATUS.Failed;
  if (completedCopies === requestedCopies) return FINALIZATION_STATUS.Committed;
  return FINALIZATION_STATUS.Partial;
}

function validateFinalizationStatusForCopies({
  finalizationStatus,
  completedCopies,
  requestedCopies,
}) {
  if (
    finalizationStatus === FINALIZATION_STATUS.Committed &&
    completedCopies !== requestedCopies
  ) {
    throw new CoordinatorReceiptError(
      "finalization_status_mismatch",
      "committed receipts must complete every requested copy",
      { completedCopies: String(completedCopies), requestedCopies: String(requestedCopies) },
    );
  }
  if (
    finalizationStatus === FINALIZATION_STATUS.Partial &&
    (completedCopies === 0 || completedCopies >= requestedCopies)
  ) {
    throw new CoordinatorReceiptError(
      "finalization_status_mismatch",
      "partial receipts must complete fewer than requested copies",
      { completedCopies: String(completedCopies), requestedCopies: String(requestedCopies) },
    );
  }
  if (finalizationStatus === FINALIZATION_STATUS.Failed && completedCopies !== 0) {
    throw new CoordinatorReceiptError(
      "finalization_status_mismatch",
      "failed receipts must not include completed copies",
      { completedCopies: String(completedCopies) },
    );
  }
}

function normalizeCopies(copies) {
  return Array.from(copies).map((copy) =>
    Object.freeze({
      providerId: normalizeUint(copy.providerId, "providerId"),
      datasetId: normalizeUint(copy.datasetId, "datasetId"),
      pieceId: normalizeUint(copy.pieceId, "pieceId"),
      addPieceTxHash: normalizeBytes32(copy.addPieceTxHash, "addPieceTxHash"),
      retrievalUrlHash: normalizeBytes32(copy.retrievalUrlHash, "retrievalUrlHash"),
      isNewDataSet: Boolean(copy.isNewDataSet),
    }),
  );
}

function normalizeCompletedCopies(value, copyCount) {
  const completedCopies = numberOrDefault(value ?? copyCount, copyCount, "completedCopies");
  if (completedCopies !== copyCount) {
    throw new CoordinatorReceiptError(
      "copy_count_mismatch",
      "completed copy count must match copy receipts",
      { completedCopies: String(completedCopies), copyCount: String(copyCount) },
    );
  }
  return completedCopies;
}

function normalizeBytes(bytes) {
  if (bytes instanceof Uint8Array) return Uint8Array.from(bytes);
  if (typeof bytes === "string") return toBytes(bytes);
  if (Array.isArray(bytes)) {
    bytes.forEach((byte, index) => {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new CoordinatorReceiptError(
          "invalid_upload_bytes",
          "number-array upload bytes must contain integers from 0 to 255",
          { index, value: byte },
        );
      }
    });
    return Uint8Array.from(bytes);
  }
  throw new CoordinatorReceiptError(
    "invalid_upload_bytes",
    "upload bytes must be Uint8Array, hex/text string, or number array",
  );
}

function hashBytes(bytes, algorithm) {
  if (algorithm === "keccak256") return keccak256(bytes);
  if (algorithm === "identity-bytes32") {
    if (bytes.byteLength !== 32) {
      throw new CoordinatorReceiptError(
        "invalid_identity_bytes32",
        "identity-bytes32 content commitments must be exactly 32 bytes",
        { actualBytes: String(bytes.byteLength) },
      );
    }
    return bytesToHex(bytes).toLowerCase();
  }
  throw new CoordinatorReceiptError(
    "unsupported_content_hash_algorithm",
    "unsupported content hash algorithm",
    { algorithm },
  );
}

function normalizeContentHash(contentHash, contentHashAlgorithm) {
  if (contentHash === undefined || contentHash === null || contentHash === "") return undefined;
  const normalized = String(contentHash).toLowerCase();
  return !contentHashAlgorithm && normalized === ZERO_BYTES32 ? undefined : normalized;
}

function deriveReceiptHash(payload) {
  return keccak256(stringToHex(JSON.stringify(jsonSafe(payload))));
}

function hashText(value) {
  return keccak256(stringToHex(value));
}

function normalizeBytes32(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new CoordinatorReceiptError(`invalid_${label}`, `${label} must be bytes32`);
  }
  return value.toLowerCase();
}

function normalizeUint(value, label) {
  let bigint;
  try {
    bigint = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new CoordinatorReceiptError(`invalid_${label}`, `${label} must be an unsigned integer`);
  }
  if (bigint < 0n) {
    throw new CoordinatorReceiptError(`invalid_${label}`, `${label} must be an unsigned integer`);
  }
  return bigint;
}

function numberOrDefault(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 0 || number > 255) {
    throw new CoordinatorReceiptError(`invalid_${label}`, `${label} must fit uint8`);
  }
  return number;
}

function statusLabel(status) {
  return Object.entries(FINALIZATION_STATUS).find(([, value]) => value === status)?.[0];
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}
