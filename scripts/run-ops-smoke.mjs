import { pathToFileURL } from "node:url";

import { keccak256, stringToHex } from "viem";

import {
  DuplicateUploadRequestError,
  PlatformApiError,
  createPlatformApi,
} from "../src/api/platform-api.mjs";
import {
  ZERO_BYTES32,
  createCoordinatorSessionKey,
  createLocalHostedCoordinator,
  derivePermissionsHash,
  loadCoordinatorConfig,
} from "../src/coordinator/index.mjs";

const ROOT = "0x0000000000000000000000000000000000001000";
const SESSION = "0x0000000000000000000000000000000000002000";
const PAYER = "0x0000000000000000000000000000000000003000";
const ACCOUNT_ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET = "0x0000000000000000000000000000000000001234";

export async function runOpsSmoke({ iterations = 3 } = {}) {
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("iterations must be a positive integer");
  }
  const api = await runApiSmoke(iterations);
  const coordinator = await runCoordinatorSmoke(iterations);
  return {
    ok: true,
    mocked: true,
    productionReady: false,
    iterations,
    api,
    coordinator,
  };
}

async function runApiSmoke(iterations) {
  const registry = createApiMemoryRegistry();
  const api = createPlatformApi({ registry });
  const summary = {
    created: 0,
    duplicates: 0,
    statusReads: 0,
  };

  for (let index = 0; index < iterations; index += 1) {
    const request = createApiUploadRequest(index);
    const created = await api.handle(request);
    if (created.status !== 201) {
      throw new Error(`API create failed at iteration ${index}: ${created.body?.error?.code}`);
    }
    summary.created += 1;

    const duplicate = await api.handle(request);
    if (duplicate.status !== 409 || duplicate.body?.error?.code !== "duplicate_idempotency_key") {
      throw new Error(`API duplicate boundary failed at iteration ${index}`);
    }
    summary.duplicates += 1;

    const status = await api.handle({
      method: "GET",
      path: created.body.links.status,
      headers: platformHeaders(),
    });
    if (status.status !== 200 || status.body.upload.status !== "Requested") {
      throw new Error(`API status read failed at iteration ${index}`);
    }
    summary.statusReads += 1;
  }

  return summary;
}

async function runCoordinatorSmoke(iterations) {
  const permissionsHash = derivePermissionsHash({ dataset: "write", piece: "add" });
  const config = loadCoordinatorConfig({
    FOC_COORDINATOR_MODE: "ops-smoke",
    FOC_COORDINATOR_NETWORK: "local-simulated",
    FOC_COORDINATOR_RUNNER: "mocked-synapse",
    FOC_COORDINATOR_ADDRESS: SESSION,
    FOC_ROOT_ADDRESS: ROOT,
    FOC_SESSION_KEY_ADDRESS: SESSION,
    FOC_SESSION_KEY_EXPIRES_AT: "1000",
    FOC_SESSION_KEY_PERMISSIONS_HASH: permissionsHash,
  });
  const sessionKey = createCoordinatorSessionKey({
    address: SESSION,
    rootAddress: ROOT,
    expiresAt: 1000n,
    permissionsHash,
  });
  const registry = createCoordinatorRegistry();
  const uploadCalls = [];
  const coordinator = createLocalHostedCoordinator({
    config,
    registry,
    focClient: createFocClient({ uploadCalls }),
    sessionKey,
    clock: () => 100n,
  });
  const summary = {
    committed: 0,
    replays: 0,
    uploadCalls: 0,
    finalizeCalls: 0,
  };

  for (let index = 0; index < iterations; index += 1) {
    const objectId = BigInt(index + 1);
    const request = coordinatorRequest(objectId);
    registry.seed(request);
    const bytes = new Uint8Array([index, index + 1, index + 2, index + 3].map((value) => value % 256));
    const first = await coordinator.executeUpload({ objectId, request, bytes, account: account() });
    const replay = await coordinator.executeUpload({ objectId, request, bytes, account: account() });

    if (first.status !== "Committed") {
      throw new Error(`coordinator commit failed at iteration ${index}`);
    }
    if (replay !== first) {
      throw new Error(`coordinator idempotent replay failed at iteration ${index}`);
    }
    summary.committed += 1;
    summary.replays += 1;
  }

  summary.uploadCalls = uploadCalls.length;
  summary.finalizeCalls = registry.finalizeCalls.length;
  if (summary.uploadCalls !== iterations || summary.finalizeCalls !== iterations) {
    throw new Error("coordinator smoke did not preserve upload/finalize idempotency");
  }
  return summary;
}

function createApiUploadRequest(index) {
  return {
    method: "POST",
    path: "/storage/upload-requests",
    headers: platformHeaders(),
    body: {
      idempotencyKey: `ops-api-${index}`,
      size: 1024 + index,
      requestedCopies: 2,
      withCDN: false,
      maxCost: "10",
    },
  };
}

function platformHeaders(user = "ops-smoke-user") {
  return {
    "x-platform-user-id": user,
    "x-platform-wallet-address": WALLET,
  };
}

function createApiMemoryRegistry() {
  const objects = new Map();
  const usage = new Map();
  const idempotency = new Map();
  let nextObjectId = 1n;

  return {
    async createUploadRequest({ account, request }) {
      const key = `${account.accountId}:${request.idempotencyKey}`;
      if (idempotency.has(key)) {
        throw new DuplicateUploadRequestError({
          accountId: account.accountId,
          idempotencyKey: request.idempotencyKey,
          objectId: idempotency.get(key),
        });
      }

      const objectId = nextObjectId++;
      const object = {
        objectId: objectId.toString(),
        accountId: account.accountId,
        user: account.user,
        idempotencyKey: request.idempotencyKey,
        contentHash: request.contentHash,
        metadataHash: request.metadataHash,
        size: request.size,
        requestedCopies: request.requestedCopies,
        completedCopies: 0,
        withCDN: request.withCDN,
        maxCost: request.maxCost,
        reservedCost: request.maxCost,
        actualCost: "0",
        status: "Requested",
        requestExpiresAt: request.requestExpiresAt ?? "0",
      };
      objects.set(object.objectId, object);
      idempotency.set(key, object.objectId);
      const accountUsage = ensureUsage(usage, account.accountId);
      accountUsage.pendingBytes = add(
        accountUsage.pendingBytes,
        BigInt(object.size) * BigInt(object.requestedCopies),
      );
      accountUsage.reservedCost = add(accountUsage.reservedCost, object.maxCost);
      accountUsage.totalRequestedUploads = add(accountUsage.totalRequestedUploads, 1n);
      return { object, mocked: { registry: "ops-smoke" } };
    },
    async submitUploadBytes({ objectId, account }) {
      const object = ownedObject(objects, objectId, account.accountId);
      if (["Committed", "Partial", "Failed", "Cancelled", "Expired", "Deleted"].includes(object.status)) {
        throw new PlatformApiError(409, "terminal_upload", "terminal upload cannot accept bytes", {
          objectId,
          status: object.status,
        });
      }
      object.status = "Committed";
      return this.readUploadStatus({ objectId, account });
    },
    async readUploadStatus({ objectId, account }) {
      const object = ownedObject(objects, objectId, account.accountId);
      return {
        object,
        usage: ensureUsage(usage, account.accountId),
        copyReceipts: [],
        projection: { object: { status: object.status } },
        mocked: { registry: "ops-smoke" },
      };
    },
    async readObject({ objectId, account }) {
      return this.readUploadStatus({ objectId, account });
    },
    async readUsage({ account }) {
      return {
        accountId: account.accountId,
        usage: ensureUsage(usage, account.accountId),
        mocked: { registry: "ops-smoke" },
      };
    },
  };
}

function createCoordinatorRegistry() {
  const objects = new Map();
  return {
    startCalls: [],
    finalizeCalls: [],
    failCalls: [],
    seed(request) {
      objects.set(String(request.objectId), {
        objectId: String(request.objectId),
        status: "Requested",
        size: request.size,
        requestedCopies: request.requestedCopies,
        maxCost: request.maxCost,
        withCDN: request.withCDN,
        contentHash: request.contentHash,
        metadataHash: request.metadataHash,
        requestExpiresAt: request.requestExpiresAt,
      });
    },
    async readUploadStatus({ objectId }) {
      const object = objects.get(String(objectId));
      if (!object) {
        throw new PlatformApiError(404, "object_not_found", "object not found", { objectId });
      }
      return { object };
    },
    async startUpload({ objectId, ...args }) {
      const object = objects.get(String(objectId));
      object.status = "Uploading";
      this.startCalls.push({ objectId, ...args });
      return { status: object.status };
    },
    async finalizeUpload({ objectId, receipt, ...args }) {
      const object = objects.get(String(objectId));
      object.status = receipt.finalizationStatus === 0 ? "Committed" : "Partial";
      object.receiptHash = receipt.receiptHash;
      object.pieceCidHash = receipt.pieceCidHash;
      object.completedCopies = receipt.completedCopies;
      object.actualCost = receipt.actualCost;
      this.finalizeCalls.push({ objectId, receipt, ...args });
      return { status: object.status, receipt };
    },
    async failUpload({ objectId, ...args }) {
      const object = objects.get(String(objectId));
      object.status = "Failed";
      this.failCalls.push({ objectId, ...args });
      return { status: object.status };
    },
  };
}

function createFocClient({ uploadCalls }) {
  return {
    async upload(input) {
      uploadCalls.push(input);
      return {
        payer: PAYER,
        actualCost: 7n,
        pieceCid: "baga6ea4seaqtest",
        copies: [
          copyFixture({ providerId: 111n, datasetId: 222n, pieceId: 333n }),
          copyFixture({ providerId: 112n, datasetId: 223n, pieceId: 334n }),
        ],
      };
    },
  };
}

function coordinatorRequest(objectId) {
  return {
    objectId: objectId.toString(),
    accountId: ACCOUNT_ID,
    idempotencyKey: bytes32FromInteger(objectId),
    contentHash: ZERO_BYTES32,
    metadataHash: keccak256(stringToHex(`ops-smoke-metadata-${objectId}`)),
    size: 4n,
    requestedCopies: 2,
    requestExpiresAt: 900n,
    withCDN: false,
    maxCost: 10n,
  };
}

function copyFixture({
  providerId,
  datasetId,
  pieceId,
  addPieceTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111",
  retrievalUrlHash = "0x2222222222222222222222222222222222222222222222222222222222222222",
}) {
  return {
    providerId,
    datasetId,
    pieceId,
    addPieceTxHash,
    retrievalUrlHash,
    isNewDataSet: true,
  };
}

function account() {
  return {
    accountId: ACCOUNT_ID,
    user: ROOT,
  };
}

function ownedObject(objects, objectId, accountId) {
  const object = objects.get(String(objectId));
  if (!object) {
    throw new PlatformApiError(404, "object_not_found", "object not found", { objectId });
  }
  if (object.accountId !== accountId) {
    throw new PlatformApiError(403, "object_not_owned", "object does not belong to caller", {
      objectId,
    });
  }
  return object;
}

function ensureUsage(usage, accountId) {
  if (!usage.has(accountId)) {
    usage.set(accountId, {
      activeBytes: "0",
      activeObjects: "0",
      pendingBytes: "0",
      reservedCost: "0",
      totalActualCost: "0",
      totalUploadedBytes: "0",
      totalRequestedUploads: "0",
      totalFinalizedUploads: "0",
      totalFailedUploads: "0",
    });
  }
  return usage.get(accountId);
}

function add(left, right) {
  return (BigInt(left) + BigInt(right)).toString();
}

function bytes32FromInteger(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function parseIterations(args) {
  const index = args.indexOf("--iterations");
  if (index === -1) return 3;
  return Number(args[index + 1]);
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOpsSmoke({ iterations: parseIterations(process.argv.slice(2)) })
    .then((summary) => {
      console.log(JSON.stringify(summary, jsonReplacer, 2));
    })
    .catch((error) => {
      console.error(
        JSON.stringify(
          {
            ok: false,
            message: error.message,
          },
          jsonReplacer,
          2,
        ),
      );
      process.exitCode = 1;
    });
}
