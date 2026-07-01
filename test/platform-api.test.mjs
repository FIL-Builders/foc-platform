import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

import {
  DuplicateUploadRequestError,
  PlatformApiError,
  createPlatformAccountMapper,
  createPlatformApi,
} from "../src/api/platform-api.mjs";
import {
  DEV_UPLOAD_SPINE_FIXTURE,
  runDevUploadSpine,
} from "../src/dev/upload-spine.mjs";

const WALLET = "0x0000000000000000000000000000000000001234";

test("POST /storage/upload creates an opaque-account upload request", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({
    registry,
    accountMapper: createPlatformAccountMapper({ namespace: "api-test" }),
  });

  const response = await api.handle({
    method: "POST",
    path: "/storage/upload",
    headers: platformHeaders("user@example.com"),
    body: {
      idempotencyKey: "avatar-upload",
      contentHash: "hello-content",
      metadataHash: "hello-metadata",
      size: 1024,
      requestedCopies: 2,
      withCDN: true,
      maxCost: "10",
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.request.objectId, "1");
  assert.equal(response.body.request.status, "Requested");
  assert.match(response.body.request.accountId, /^0x[0-9a-f]{64}$/);
  assert.notEqual(response.body.request.accountId, "user@example.com");
  assert.equal(response.body.links.uploadBytes, "/storage/uploads/1/bytes");
  assert.equal(registry.createCalls[0].request.accountId, response.body.request.accountId);
  assert.equal(registry.createCalls[0].request.user, WALLET);
});

test("duplicate idempotency returns a stable 409 without creating a second object", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });
  const first = await api.handle(createUploadRequest({ idempotencyKey: "same-key" }));
  const second = await api.handle(createUploadRequest({ idempotencyKey: "same-key" }));

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "duplicate_idempotency_key");
  assert.equal(second.body.error.objectId, "1");
  assert.equal(registry.objects.size, 1);
});

test("standard Headers objects preserve authenticated platform headers", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });

  const response = await api.handle({
    ...createUploadRequest({ idempotencyKey: "headers-key" }),
    headers: new Headers(platformHeaders()),
  });

  assert.equal(response.status, 201);
  assert.equal(registry.createCalls[0].account.accountId, response.body.request.accountId);
});

test("create upload rejects malformed boundary inputs before adapter work", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });

  const badIdempotency = await api.handle(
    createUploadRequest({ idempotencyKey: { not: "a string" } }),
  );
  const tooLargeSize = await api.handle(
    createUploadRequest({ idempotencyKey: "too-large-size", size: (1n << 64n).toString() }),
  );
  const negativeCost = await api.handle({
    ...createUploadRequest({ idempotencyKey: "negative-cost" }),
    body: {
      ...createUploadRequest({ idempotencyKey: "negative-cost" }).body,
      maxCost: "-1",
    },
  });
  const fractionalExpiry = await api.handle({
    ...createUploadRequest({ idempotencyKey: "fractional-expiry" }),
    body: {
      ...createUploadRequest({ idempotencyKey: "fractional-expiry" }).body,
      requestExpiresAt: "1.5",
    },
  });

  assert.equal(badIdempotency.status, 400);
  assert.equal(badIdempotency.body.error.code, "invalid_idempotency_key");
  assert.equal(tooLargeSize.status, 400);
  assert.equal(tooLargeSize.body.error.code, "invalid_size");
  assert.equal(negativeCost.status, 400);
  assert.equal(negativeCost.body.error.code, "invalid_maxCost");
  assert.equal(fractionalExpiry.status, 400);
  assert.equal(fractionalExpiry.body.error.code, "invalid_requestExpiresAt");
  assert.equal(registry.createCalls.length, 0);
});

test("invalid account mapper output returns structured mapping errors", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({
    registry,
    accountMapper: () => ({
      accountId: 123n,
      user: WALLET,
    }),
  });

  const response = await api.handle(createUploadRequest({ idempotencyKey: "bad-account" }));

  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, "invalid_account_mapping");
  assert.equal(registry.createCalls.length, 0);
});

test("bytes, status, object, and usage endpoints use the registry adapter state", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });
  const create = await api.handle(createUploadRequest({ idempotencyKey: "flow-key", size: 2048 }));

  const bytes = await api.handle({
    method: "POST",
    path: create.body.links.uploadBytes,
    headers: platformHeaders(),
    body: {
      byteLength: 2048,
      receiptHash: "api-receipt",
    },
  });
  const status = await api.handle({
    method: "GET",
    path: create.body.links.status,
    headers: platformHeaders(),
  });
  const tokenHostStatus = await api.handle({
    method: "GET",
    path: `/storage/uploads/status?objectId=${create.body.request.objectId}`,
    headers: platformHeaders(),
  });
  const object = await api.handle({
    method: "GET",
    path: create.body.links.object,
    headers: platformHeaders(),
  });
  const usage = await api.handle({
    method: "GET",
    path: "/usage",
    headers: platformHeaders(),
  });

  assert.equal(bytes.status, 200);
  assert.equal(bytes.body.upload.status, "Committed");
  assert.equal(status.body.upload.status, "Committed");
  assert.equal(tokenHostStatus.status, 200);
  assert.equal(tokenHostStatus.body.upload.objectId, create.body.request.objectId);
  assert.equal(object.body.object.receiptHash, registry.fixtureReceiptHash);
  assert.equal(usage.body.usage.activeBytes, "4096");
  assert.equal(usage.body.usage.totalFinalizedUploads, "1");
});

test("Token Host status endpoint rejects missing object id before adapter work", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });

  const response = await api.handle({
    method: "GET",
    path: "/storage/uploads/status",
    headers: platformHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "missing_object_id");
  assert.equal(registry.objects.size, 0);
});

test("Token Host generated upload adapter accepts bytes and returns upload metadata", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });
  const bytes = new Uint8Array([1, 2, 3, 4]);

  const status = await api.handle({
    method: "GET",
    path: "/storage/tokenhost/upload/status",
  });
  const upload = await api.handle({
    method: "POST",
    path: "/storage/tokenhost/upload",
    headers: {
      ...platformHeaders("tokenhost-user"),
      "content-type": "image/png",
      "x-tokenhost-upload-filename": "launch.png",
      "x-tokenhost-upload-size": String(bytes.byteLength),
    },
    body: bytes,
  });

  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.endpointUrl, "/storage/tokenhost/upload");
  assert.equal(upload.status, 200);
  assert.equal(upload.body.ok, true);
  assert.equal(upload.body.upload.url, "/storage/objects/1");
  assert.equal(upload.body.upload.size, "4");
  assert.equal(upload.body.upload.provider, "filecoin_onchain_cloud");
  assert.equal(upload.body.upload.runnerMode, "remote");
  assert.equal(upload.body.upload.contentType, "image/png");
  assert.equal(upload.body.upload.metadata.objectId, "1");
  assert.equal(registry.createCalls[0].request.size, "4");
  assert.equal(registry.createCalls[0].request.requestedCopies, 2);
});

test("Token Host generated upload adapter rejects empty or mismatched byte uploads", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });

  const empty = await api.handle({
    method: "POST",
    path: "/storage/tokenhost/upload",
    headers: {
      ...platformHeaders("tokenhost-user"),
      "x-tokenhost-upload-filename": "empty.bin",
      "x-tokenhost-upload-size": "1",
    },
    body: new Uint8Array(),
  });
  const mismatch = await api.handle({
    method: "POST",
    path: "/storage/tokenhost/upload",
    headers: {
      ...platformHeaders("tokenhost-user"),
      "x-tokenhost-upload-filename": "wrong-size.bin",
      "x-tokenhost-upload-size": "10",
    },
    body: new Uint8Array([1, 2, 3]),
  });

  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, "empty_tokenhost_upload");
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, "invalid_tokenhost_upload_size");
  assert.equal(registry.objects.size, 0);
});

test("authorization mapping protects status, object, and usage reads", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });
  const create = await api.handle(createUploadRequest({ idempotencyKey: "auth-key" }));

  const missingAuth = await api.handle({
    method: "GET",
    path: create.body.links.status,
  });
  const wrongUser = await api.handle({
    method: "GET",
    path: create.body.links.object,
    headers: platformHeaders("other-user"),
  });
  const wrongUsage = await api.handle({
    method: "GET",
    path: `/storage/usage/${create.body.request.accountId}`,
    headers: platformHeaders("other-user"),
  });

  assert.equal(missingAuth.status, 401);
  assert.equal(wrongUser.status, 403);
  assert.equal(wrongUser.body.error.code, "object_not_owned");
  assert.equal(wrongUsage.status, 403);
  assert.equal(wrongUsage.body.error.code, "account_mismatch");
});

test("failed byte submission exposes terminal status and idempotent retry boundary", async () => {
  const registry = createMemoryRegistry();
  const api = createPlatformApi({ registry });
  const create = await api.handle(createUploadRequest({ idempotencyKey: "failure-key" }));

  const failed = await api.handle({
    method: "POST",
    path: create.body.links.uploadBytes,
    headers: platformHeaders(),
    body: {
      fail: true,
      reason: "coordinator-timeout",
    },
  });
  const retryBytes = await api.handle({
    method: "POST",
    path: create.body.links.uploadBytes,
    headers: platformHeaders(),
    body: {
      byteLength: 1024,
    },
  });
  const duplicateCreate = await api.handle(createUploadRequest({ idempotencyKey: "failure-key" }));

  assert.equal(failed.status, 200);
  assert.equal(failed.body.upload.status, "Failed");
  assert.equal(retryBytes.status, 409);
  assert.equal(retryBytes.body.error.code, "terminal_upload");
  assert.equal(duplicateCreate.status, 409);
  assert.equal(duplicateCreate.body.error.code, "duplicate_idempotency_key");
});

test("read endpoints can bind to the dev spine contract/read-model result", {
  timeout: 90_000,
}, async (t) => {
  const anvil = await startAnvil(t);
  const spine = await runDevUploadSpine({ rpcUrl: anvil.rpcUrl });
  const api = createPlatformApi({
    registry: createSpineReadRegistry(spine),
    accountMapper: () => ({
      accountId: DEV_UPLOAD_SPINE_FIXTURE.accountId,
      user: spine.roles.user,
    }),
  });

  const status = await api.handle({
    method: "GET",
    path: `/storage/uploads/${spine.objectId}`,
    headers: platformHeaders("spine-user", spine.roles.user),
  });
  const object = await api.handle({
    method: "GET",
    path: `/storage/objects/${spine.objectId}`,
    headers: platformHeaders("spine-user", spine.roles.user),
  });
  const usage = await api.handle({
    method: "GET",
    path: "/usage",
    headers: platformHeaders("spine-user", spine.roles.user),
  });

  assert.equal(status.status, 200);
  assert.equal(status.body.upload.status, "Committed");
  assert.equal(status.body.projection.object.status, "Committed");
  assert.equal(object.body.object.receiptHash, DEV_UPLOAD_SPINE_FIXTURE.receiptHash);
  assert.equal(usage.body.usage.activeBytes, spine.reads.usage.activeBytes);
  assert.equal(usage.body.mocked.focBytesMoved, false);
});

function createUploadRequest({ idempotencyKey, size = 1024 } = {}) {
  return {
    method: "POST",
    path: "/storage/upload-requests",
    headers: platformHeaders(),
    body: {
      idempotencyKey,
      size,
      requestedCopies: 2,
      withCDN: false,
      maxCost: "10",
    },
  };
}

function platformHeaders(user = "platform-user", wallet = WALLET) {
  return {
    "x-platform-user-id": user,
    "x-platform-wallet-address": wallet,
  };
}

function createMemoryRegistry() {
  const objects = new Map();
  const usage = new Map();
  const idempotency = new Map();
  const createCalls = [];
  const fixtureReceiptHash = "0xabc0000000000000000000000000000000000000000000000000000000000000";
  let nextObjectId = 1n;

  return {
    objects,
    createCalls,
    fixtureReceiptHash,
    async createUploadRequest({ account, request }) {
      createCalls.push({ account, request });
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
      return { object, mocked: { registry: "memory-test" } };
    },
    async submitUploadBytes({ objectId, account, bytes }) {
      const object = ownedObject(objects, objectId, account.accountId);
      const terminalStatuses = ["Committed", "Partial", "Failed", "Cancelled", "Expired", "Deleted"];
      if (terminalStatuses.includes(object.status)) {
        throw new PlatformApiError(409, "terminal_upload", "terminal upload cannot accept bytes", {
          objectId,
          status: object.status,
        });
      }

      const accountUsage = ensureUsage(usage, account.accountId);
      accountUsage.pendingBytes = "0";
      accountUsage.reservedCost = "0";
      if (bytes?.fail) {
        object.status = "Failed";
        accountUsage.totalFailedUploads = add(accountUsage.totalFailedUploads, 1n);
      } else {
        object.status = "Committed";
        object.completedCopies = object.requestedCopies;
        object.actualCost = "7";
        object.receiptHash = fixtureReceiptHash;
        object.pieceCidHash = "0xdef0000000000000000000000000000000000000000000000000000000000000";
        accountUsage.activeBytes = add(
          accountUsage.activeBytes,
          BigInt(object.size) * BigInt(object.completedCopies),
        );
        accountUsage.activeObjects = add(accountUsage.activeObjects, 1n);
        accountUsage.totalActualCost = add(accountUsage.totalActualCost, object.actualCost);
        accountUsage.totalUploadedBytes = accountUsage.activeBytes;
        accountUsage.totalFinalizedUploads = add(accountUsage.totalFinalizedUploads, 1n);
      }

      return this.readUploadStatus({ objectId, account });
    },
    async readUploadStatus({ objectId, account }) {
      const object = ownedObject(objects, objectId, account.accountId);
      return {
        object,
        usage: ensureUsage(usage, account.accountId),
        copyReceipts:
          object.status === "Committed"
            ? [{ providerId: "111", datasetId: "222", pieceId: "333" }]
            : [],
        receiptPayer: object.status === "Committed" ? account.user : undefined,
        projection: {
          object: { status: object.status },
          usage: ensureUsage(usage, account.accountId),
        },
        mocked: { registry: "memory-test" },
      };
    },
    async readObject({ objectId, account }) {
      return this.readUploadStatus({ objectId, account });
    },
    async readUsage({ account }) {
      return {
        accountId: account.accountId,
        usage: ensureUsage(usage, account.accountId),
        mocked: { registry: "memory-test" },
      };
    },
  };
}

function createSpineReadRegistry(spine) {
  return {
    async createUploadRequest() {
      throw new PlatformApiError(501, "read_only_spine", "dev spine adapter is read-only");
    },
    async submitUploadBytes() {
      throw new PlatformApiError(501, "read_only_spine", "dev spine adapter is read-only");
    },
    async readUploadStatus() {
      return {
        object: spine.reads.object,
        usage: spine.reads.usage,
        copyReceipts: spine.reads.copyReceipts,
        receiptPayer: spine.reads.receiptPayer,
        projection: spine.projection,
        mocked: spine.mocked,
      };
    },
    async readObject() {
      return this.readUploadStatus();
    },
    async readUsage() {
      return {
        accountId: DEV_UPLOAD_SPINE_FIXTURE.accountId,
        usage: spine.reads.usage,
        projection: spine.projection,
        mocked: spine.mocked,
      };
    },
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

async function startAnvil(t) {
  const port = await getFreePort();
  const proc = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--accounts", "4", "--balance", "1000"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    output += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    output += chunk;
  });

  t.after(() => {
    if (!proc.killed) proc.kill("SIGTERM");
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`anvil did not start on port ${port}\n${output}`));
    }, 15_000);

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`anvil exited before readiness: code=${code} signal=${signal}\n${output}`));
    });
    proc.stdout.on("data", (chunk) => {
      if (chunk.includes("Listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  return { rpcUrl: `http://127.0.0.1:${port}` };
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
