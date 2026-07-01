import { getAddress, isAddress, keccak256, stringToHex } from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_ACCOUNT_NAMESPACE = "foc-platform:v1:demo";
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

export const PLATFORM_API_ROUTES = Object.freeze({
  createUpload: ["POST /storage/upload-requests", "POST /storage/upload"],
  uploadBytes: "POST /storage/uploads/:objectId/bytes",
  uploadStatus: ["GET /storage/uploads/:objectId/status", "GET /storage/uploads/:objectId"],
  object: "GET /storage/objects/:objectId",
  usage: ["GET /storage/usage/:accountId", "GET /usage"],
});

export class PlatformApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "PlatformApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class DuplicateUploadRequestError extends PlatformApiError {
  constructor({ accountId, idempotencyKey, objectId }) {
    super(409, "duplicate_idempotency_key", "idempotency key already created an upload", {
      accountId,
      idempotencyKey,
      objectId: decimal(objectId),
    });
  }
}

export function createPlatformAccountMapper({ namespace = DEFAULT_ACCOUNT_NAMESPACE } = {}) {
  return {
    accountForUser(auth) {
      return {
        accountId: deriveAccountId({ namespace, subject: auth.platformUserId }),
        user: auth.walletAddress ?? ZERO_ADDRESS,
      };
    },
  };
}

export function deriveAccountId({ namespace = DEFAULT_ACCOUNT_NAMESPACE, subject }) {
  if (!subject) {
    throw new PlatformApiError(401, "missing_auth", "platform user id is required");
  }
  return keccak256(stringToHex(`foc-platform-account:v1:${namespace}:${subject}`));
}

export function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") {
    throw new PlatformApiError(400, "missing_idempotency_key", "idempotency key is required");
  }
  if (typeof value !== "string") {
    throw new PlatformApiError(
      400,
      "invalid_idempotency_key",
      "idempotency key must be a string or bytes32",
    );
  }
  if (isBytes32(value)) return value.toLowerCase();
  return keccak256(stringToHex(`foc-platform-idempotency:v1:${value}`));
}

export function normalizeBytes32(value, label) {
  if (value === undefined || value === null || value === "") return zeroBytes32();
  if (isBytes32(value)) return value.toLowerCase();
  if (typeof value !== "string") {
    throw new PlatformApiError(400, `invalid_${label}`, `${label} must be a string or bytes32`);
  }
  return keccak256(stringToHex(`foc-platform-${label}:v1:${value}`));
}

export function createPlatformApi({
  registry,
  accountMapper = createPlatformAccountMapper(),
} = {}) {
  if (!registry) {
    throw new Error("createPlatformApi requires a registry adapter");
  }

  return {
    async handle(request) {
      try {
        const normalized = normalizeRequest(request);
        const route = matchRoute(normalized.method, normalized.pathname);
        const auth = authenticate(normalized.headers);
        const account = await mapAccount(accountMapper, auth);

        switch (route.name) {
          case "createUpload":
            return created(
              formatCreateUploadResponse(
                await registry.createUploadRequest({
                  account,
                  auth,
                  request: normalizeUploadRequest(normalized.body, normalized.headers, account),
                }),
              ),
            );
          case "uploadBytes":
            return ok(
              formatUploadStatusResponse(
                await registry.submitUploadBytes({
                  objectId: route.params.objectId,
                  account,
                  auth,
                  bytes: normalized.body,
                }),
              ),
            );
          case "uploadStatus":
            return ok(
              formatUploadStatusResponse(
                await registry.readUploadStatus({
                  objectId: route.params.objectId,
                  account,
                  auth,
                }),
              ),
            );
          case "object":
            return ok(
              formatObjectResponse(
                await registry.readObject({
                  objectId: route.params.objectId,
                  account,
                  auth,
                }),
              ),
            );
          case "usage":
            if (
              route.params.accountId &&
              route.params.accountId.toLowerCase() !== account.accountId
            ) {
              throw new PlatformApiError(
                403,
                "account_mismatch",
                "usage account does not match caller",
              );
            }
            return ok(
              formatUsageResponse(
                await registry.readUsage({
                  account,
                  auth,
                }),
              ),
            );
          default:
            throw new PlatformApiError(404, "not_found", "route not found");
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function formatCreateUploadResponse(payload) {
  const object = payload.object ?? payload.upload ?? payload;
  return jsonSafe({
    request: {
      objectId: decimal(object.objectId),
      accountId: object.accountId,
      status: object.status,
      idempotencyKey: object.idempotencyKey,
      requestExpiresAt: object.requestExpiresAt,
    },
    links: uploadLinks(object.objectId),
    mocked: payload.mocked,
  });
}

export function formatUploadStatusResponse(payload) {
  const object = payload.object ?? payload.reads?.object ?? payload.upload ?? payload;
  return jsonSafe({
    upload: object,
    usage: payload.usage ?? payload.reads?.usage,
    copyReceipts: payload.copyReceipts ?? payload.reads?.copyReceipts ?? [],
    receiptPayer: payload.receiptPayer ?? payload.reads?.receiptPayer,
    projection: payload.projection,
    mocked: payload.mocked,
    links: uploadLinks(object.objectId),
  });
}

export function formatObjectResponse(payload) {
  const object = payload.object ?? payload.reads?.object ?? payload.upload ?? payload;
  return jsonSafe({
    object,
    copyReceipts: payload.copyReceipts ?? payload.reads?.copyReceipts ?? [],
    receiptPayer: payload.receiptPayer ?? payload.reads?.receiptPayer,
    projection: payload.projection?.object,
    mocked: payload.mocked,
    links: uploadLinks(object.objectId),
  });
}

export function formatUsageResponse(payload) {
  const accountId = payload.accountId ?? payload.account?.accountId;
  return jsonSafe({
    accountId,
    usage: payload.usage ?? payload.reads?.usage ?? payload,
    projection: payload.projection?.usage,
    mocked: payload.mocked,
  });
}

function normalizeRequest(request = {}) {
  const method = String(request.method ?? "").toUpperCase();
  const url = new URL(request.path ?? request.url ?? "/", "http://foc-platform.local");
  return {
    method,
    pathname: url.pathname.replace(/\/+$/, "") || "/",
    headers: normalizeHeaders(request.headers ?? {}),
    body: request.body ?? {},
  };
}

function normalizeHeaders(headers) {
  const normalized = {};

  if (headers && typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

function authenticate(headers) {
  const platformUserId = header(headers, "x-platform-user-id");
  if (!platformUserId) {
    throw new PlatformApiError(401, "missing_auth", "x-platform-user-id header is required");
  }
  const walletHeader = header(headers, "x-platform-wallet-address");
  if (walletHeader && !isAddress(walletHeader)) {
    throw new PlatformApiError(400, "invalid_wallet", "x-platform-wallet-address is invalid");
  }
  return {
    platformUserId,
    walletAddress: walletHeader ? getAddress(walletHeader) : ZERO_ADDRESS,
  };
}

async function mapAccount(accountMapper, auth) {
  const account =
    typeof accountMapper === "function"
      ? await accountMapper(auth)
      : await accountMapper.accountForUser(auth);
  if (!account?.accountId) {
    throw new PlatformApiError(
      500,
      "invalid_account_mapping",
      "account mapper returned no accountId",
    );
  }
  if (typeof account.accountId !== "string" || !isBytes32(account.accountId)) {
    throw new PlatformApiError(
      500,
      "invalid_account_mapping",
      "account mapper returned invalid accountId",
    );
  }
  if (
    account.user !== undefined &&
    account.user !== null &&
    (typeof account.user !== "string" || !isAddress(account.user))
  ) {
    throw new PlatformApiError(
      500,
      "invalid_account_mapping",
      "account mapper returned invalid user address",
    );
  }
  return {
    accountId: account.accountId.toLowerCase(),
    user: account.user && isAddress(account.user) ? getAddress(account.user) : ZERO_ADDRESS,
  };
}

function normalizeUploadRequest(body, headers, account) {
  const size = uintValue(body.size, "size", { min: 1n, max: UINT64_MAX });
  const requestedCopies = Number(
    uintValue(body.requestedCopies ?? 1, "requestedCopies", { min: 1n, max: 255n }),
  );
  const maxCost = uintValue(body.maxCost ?? 0, "maxCost", { min: 0n, max: UINT256_MAX });
  const requestExpiresAt =
    body.requestExpiresAt === undefined
      ? undefined
      : uintValue(body.requestExpiresAt, "requestExpiresAt", { min: 0n, max: UINT64_MAX });

  return {
    accountId: account.accountId,
    user: account.user,
    idempotencyKey: normalizeIdempotencyKey(
      body.idempotencyKey ?? header(headers, "idempotency-key"),
    ),
    contentHash: normalizeBytes32(body.contentHash, "content_hash"),
    metadataHash: normalizeBytes32(body.metadataHash, "metadata_hash"),
    size: size.toString(),
    requestedCopies,
    withCDN: Boolean(body.withCDN),
    maxCost: decimal(maxCost),
    requestExpiresAt: requestExpiresAt === undefined ? undefined : decimal(requestExpiresAt),
  };
}

function matchRoute(method, pathname) {
  if (
    method === "POST" &&
    (pathname === "/storage/upload" || pathname === "/storage/upload-requests")
  ) {
    return { name: "createUpload", params: {} };
  }

  const uploadBytes = pathname.match(/^\/storage\/uploads\/([0-9]+)\/bytes$/);
  if (method === "POST" && uploadBytes) {
    return { name: "uploadBytes", params: { objectId: uploadBytes[1] } };
  }

  const uploadStatus = pathname.match(/^\/storage\/uploads\/([0-9]+)(?:\/status)?$/);
  if (method === "GET" && uploadStatus) {
    return { name: "uploadStatus", params: { objectId: uploadStatus[1] } };
  }

  const object = pathname.match(/^\/storage\/objects\/([0-9]+)$/);
  if (method === "GET" && object) {
    return { name: "object", params: { objectId: object[1] } };
  }

  if (method === "GET" && pathname === "/usage") {
    return { name: "usage", params: {} };
  }

  const usage = pathname.match(/^\/storage\/usage\/(0x[0-9a-fA-F]{64})$/);
  if (method === "GET" && usage) {
    return { name: "usage", params: { accountId: usage[1].toLowerCase() } };
  }

  throw new PlatformApiError(404, "not_found", "route not found");
}

function uploadLinks(objectId) {
  const id = decimal(objectId);
  return {
    uploadBytes: `/storage/uploads/${id}/bytes`,
    status: `/storage/uploads/${id}`,
    statusAlias: `/storage/uploads/${id}/status`,
    object: `/storage/objects/${id}`,
    usage: "/usage",
  };
}

function ok(body) {
  return { status: 200, body };
}

function created(body) {
  return { status: 201, body };
}

function errorResponse(error) {
  if (error instanceof PlatformApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...jsonSafe(error.details),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: error?.message ?? "internal error",
      },
    },
  };
}

function uintValue(value, label, { min, max }) {
  if (value === undefined || value === null || value === "") {
    throw new PlatformApiError(400, `invalid_${label}`, `${label} is required`);
  }
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new PlatformApiError(400, `invalid_${label}`, `${label} must be an integer`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new PlatformApiError(400, `invalid_${label}`, `${label} must be a safe integer`);
  }
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new PlatformApiError(400, `invalid_${label}`, `${label} must be an integer`);
  }
  if (!["bigint", "number", "string"].includes(typeof value)) {
    throw new PlatformApiError(400, `invalid_${label}`, `${label} must be an integer`);
  }

  const number = BigInt(value);
  if (number < min || number > max) {
    throw new PlatformApiError(
      400,
      `invalid_${label}`,
      `${label} must be between ${min} and ${max}`,
    );
  }
  return number;
}

function header(headers, key) {
  return headers[key.toLowerCase()];
}

function isBytes32(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function zeroBytes32() {
  return `0x${"0".repeat(64)}`;
}

function decimal(value) {
  return (typeof value === "bigint" ? value : BigInt(value)).toString();
}

function jsonSafe(value) {
  if (typeof value === "bigint") return decimal(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}
