import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PLATFORM_ADMIN_API_ROUTES } from "../src/api/platform-admin-api.mjs";
import {
  DuplicateUploadRequestError,
  PLATFORM_API_ROUTES,
  PlatformApiError,
  createPlatformApi,
} from "../src/api/platform-api.mjs";
import {
  createTokenHostDemoClient,
  runTokenHostDemoFlow,
} from "../src/demo/tokenhost-wrapper.mjs";

const TOKENHOST_SCHEMA_PATH = "apps/tokenhost-foc-platform/schema.json";
const TOKENHOST_CONFIG_PATH = "tokenhost/foc-platform-wrapper.config.json";
const TOKENHOST_MANIFEST_PATH = "artifacts/tokenhost/foc-platform-wrapper-manifest.json";

test("Token Host schema and wrapper config preserve section 6.7 boundaries", async () => {
  const schema = await readJson(TOKENHOST_SCHEMA_PATH);
  const config = await readJson(TOKENHOST_CONFIG_PATH);

  assert.equal(schema.app.slug, "foc-platform-demo");
  assert.equal(schema.app.features.uploads, true);
  assert.equal(schema.app.deploy.netlify.uploads.provider, "filecoin_onchain_cloud");
  assert.equal(schema.app.deploy.netlify.uploads.runner, "background-function");
  assert.equal(schema.app.ui.homePage.mode, "custom");
  assert.equal(schema.app.ui.extensions.directory, "ui-overrides");
  assert.equal(schema.app.focPlatform, undefined);
  assert.equal(schema.metadata.focPlatform.mode, "wrapper");
  assert.equal(schema.metadata.focPlatform.contractMode, "handWrittenRegistry");

  assert.equal(config.mode, "handWrittenRegistryWrapper");
  assert.equal(config.focPlatform.contractMode, "handWrittenRegistry");
  assert.equal(config.focPlatform.accountIdSource, "platformUserHash");
  assert.equal(config.registry.authoritativeState, "FocPlatformRegistryDirectReads");
  assert.equal(config.registry.directReads.sourceOfTruth, "FocPlatformRegistryDirectReads");
  assert.equal(config.registry.directReads.eventProjectionRole, "auditFallbackOnly");
  assert.equal(config.registry.directReads.chain, "filecoin_calibration");
  assert.equal(config.registry.directReads.maxPageSize, 50);
  assert.equal(config.registry.directReads.batch.method, "readBatch");
  assert.equal(config.registry.directReads.batch.maxCalls, 50);
  assert.equal(config.registry.directReads.batch.fallback, "viemMulticall");
  assert.deepEqual(config.registry.directReads.datasetKeyTuple, [
    "accountId",
    "providerId",
    "datasetId",
  ]);
  assert.deepEqual(config.registry.directReads.addressSource, {
    env: "FOC_PLATFORM_REGISTRY_ADDRESS",
    deploymentMetadata: {
      path: "artifacts/calibration/demo-evidence.json",
      jsonPointer: "/registry/address",
    },
  });
  assert.deepEqual(config.platformApi.routes, PLATFORM_API_ROUTES);
  assert.equal(config.tokenHostRuntime.generatedUploadEndpoint, "/storage/tokenhost/upload");
  assert.equal(
    config.tokenHostRuntime.generatedUploadStatusEndpoint,
    "/storage/tokenhost/upload/status",
  );
  assert.deepEqual(
    config.externalBuilderIssues.map((issue) => issue.issue),
    [
      "tokenhost/tokenhost-builder#79",
      "tokenhost/tokenhost-builder#80",
      "tokenhost/tokenhost-builder#81",
      "tokenhost/tokenhost-builder#82",
    ],
  );
  assert.deepEqual(config.adminApi.routes, PLATFORM_ADMIN_API_ROUTES);
  assert.ok(
    config.boundaries.some((boundary) => boundary.includes("FocPlatformRegistry remains authoritative")),
  );
});

test("generated Token Host wrapper manifest binds schema, registry, and platform API", async () => {
  const schemaText = await readFile(TOKENHOST_SCHEMA_PATH, "utf8");
  const configText = await readFile(TOKENHOST_CONFIG_PATH, "utf8");
  const config = JSON.parse(configText);
  const manifest = await readJson(TOKENHOST_MANIFEST_PATH);

  assert.equal(manifest.kind, "foc-platform-tokenhost-wrapper");
  assert.equal(manifest.mode, "handWrittenRegistryWrapper");
  assert.equal(manifest.schema.sha256, sha256(schemaText));
  assert.equal(manifest.configSha256, sha256(configText));
  assert.equal(manifest.registry.name, "FocPlatformRegistry");
  assert.ok(manifest.registry.bytecodeSha256.startsWith("0x"));
  assert.deepEqual(manifest.platformApi.routes, PLATFORM_API_ROUTES);
  assert.deepEqual(manifest.adminApi.routes, PLATFORM_ADMIN_API_ROUTES);
  assert.equal(manifest.adminApi.projectionPath, "src/admin/reconciliation.mjs");
  assert.equal(manifest.extensions.focPlatform.contractMode, "handWrittenRegistry");
  assert.equal(manifest.registry.authoritativeState, "FocPlatformRegistryDirectReads");
  assert.deepEqual(manifest.registry.directReads, config.registry.directReads);
  assert.equal(manifest.registry.directReads.sourceOfTruth, "FocPlatformRegistryDirectReads");
  assert.equal(manifest.registry.directReads.maxPageSize, 50);
  assert.equal(manifest.registry.directReads.listMethods.objects.pagination, "cursor");
  assert.equal(manifest.registry.directReads.listMethods.accountObjects.pagination, "cursor");
  assert.equal(manifest.registry.directReads.listMethods.accounts.pagination, "offset");
  assert.equal(manifest.registry.directReads.listMethods.datasetKeys.pagination, "offset");
  assert.deepEqual(manifest.registry.directReads.listMethods.datasetKeys.tupleShape, [
    "accountId",
    "providerId",
    "datasetId",
  ]);
  assert.equal(manifest.registry.directReads.detailMethods.storageObject.method, "getStorageObject");
  assert.equal(manifest.registry.directReads.detailMethods.usage.method, "getAccountUsage");
  assert.equal(manifest.registry.directReads.detailMethods.copyReceipts.method, "getCopyReceipts");
  assert.equal(manifest.registry.directReads.detailMethods.receiptPayer.method, "receiptPayer");
  assert.equal(manifest.registry.directReads.detailMethods.datasetRecord.method, "getDatasetRecord");
  assert.equal(
    manifest.registry.directReads.detailMethods.coordinatorPolicy.method,
    "coordinatorPolicies",
  );
  assert.equal(manifest.registry.directReads.detailMethods.relayerStatus.method, "isRelayer");
  assert.equal(manifest.tokenHostRuntime.transactionMode, "sponsored");
  assert.ok(manifest.registry.requiredFunctions.includes("finalizeUpload"));
  assert.ok(manifest.registry.requiredFunctions.includes("MAX_LIST_LIMIT"));
  assert.ok(manifest.registry.requiredFunctions.includes("readBatch"));
  assert.ok(manifest.registry.requiredFunctions.includes("listDatasetKeys"));
  assert.ok(manifest.registry.requiredFunctions.includes("coordinatorPolicies"));
  assert.ok(manifest.screens.some((screen) => screen.id === "usage"));
  assert.ok(manifest.screens.some((screen) => screen.id === "admin-reconciliation"));
});

test("Token Host wrapper metadata avoids private credential surfaces", async () => {
  const configText = await readFile(TOKENHOST_CONFIG_PATH, "utf8");
  const manifestText = await readFile(TOKENHOST_MANIFEST_PATH, "utf8");
  const combined = `${configText}\n${manifestText}`;

  assert.doesNotMatch(
    combined,
    /\b(privateKey|sessionKey|paymentSecret|PRIVATE_KEY|SESSION_KEY|PAYMENT_SECRET)\b/,
  );
  assert.doesNotMatch(combined, /private-key|session-key|payment-secret/i);
});

test("Token Host wrapper client drives the generated byte-upload adapter", async () => {
  const api = createPlatformApi({
    registry: createTokenHostMemoryRegistry(),
  });
  const client = createTokenHostDemoClient({
    api,
    userId: "generated-upload-user",
    walletAddress: "0x0000000000000000000000000000000000001234",
  });

  const upload = await client.uploadFile({
    fileName: "launch.png",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(upload.ok, true);
  assert.equal(upload.upload.url, "/storage/objects/1");
  assert.equal(upload.upload.size, "4");
  assert.equal(upload.upload.provider, "filecoin_onchain_cloud");
  assert.equal(upload.upload.runnerMode, "remote");
  assert.equal(upload.upload.metadata.status, "Committed");
});

test("Token Host wrapper client resumes direct upload retries with stable idempotency", async () => {
  const registry = createTokenHostMemoryRegistry();
  const submitUploadBytes = registry.submitUploadBytes.bind(registry);
  let submitAttempts = 0;
  registry.submitUploadBytes = async (args) => {
    submitAttempts += 1;
    if (submitAttempts === 1) {
      throw new PlatformApiError(
        503,
        "transient_tokenhost_submit_failure",
        "transient byte submit failure",
      );
    }
    return submitUploadBytes(args);
  };
  const api = createPlatformApi({ registry });
  const client = createTokenHostDemoClient({
    api,
    userId: "generated-upload-user",
    walletAddress: "0x0000000000000000000000000000000000001234",
  });
  const upload = {
    fileName: "retry.png",
    contentType: "image/png",
    bytes: new Uint8Array([5, 6, 7, 8]),
  };

  const failed = await client.uploadFile(upload);
  const retried = await client.uploadFile(upload);

  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  assert.equal(failed.error.code, "transient_tokenhost_submit_failure");
  assert.equal(retried.ok, true);
  assert.equal(retried.upload.metadata.objectId, "1");
  assert.equal(submitAttempts, 2);
  assert.equal(registry.createCalls.length, 2);
  assert.equal(registry.objects.size, 1);
});

test("Token Host wrapper client drives request, status, object, and usage paths", async () => {
  const api = createPlatformApi({
    registry: createTokenHostMemoryRegistry(),
  });
  const client = createTokenHostDemoClient({
    api,
    userId: "demo-user",
    walletAddress: "0x0000000000000000000000000000000000001234",
  });

  const flow = await runTokenHostDemoFlow({
    client,
    upload: {
      label: "launch-image",
      idempotencyKey: "tokenhost-launch-image",
      size: 2048,
      requestedCopies: 2,
      receiptHash: "0xabc0000000000000000000000000000000000000000000000000000000000000",
    },
  });

  assert.equal(flow.request.ok, true);
  assert.equal(flow.request.request.status, "Requested");
  assert.equal(flow.status.upload.status, "Committed");
  assert.equal(flow.object.object.receiptHash, flow.bytes.upload.receiptHash);
  assert.equal(flow.usage.usage.activeBytes, "4096");
  assert.deepEqual(
    flow.screens.map((screen) => screen.id),
    ["request", "status", "object", "usage"],
  );
});

function createTokenHostMemoryRegistry() {
  const objects = new Map();
  const usage = new Map();
  const idempotency = new Map();
  const createCalls = [];
  let nextObjectId = 1n;

  return {
    objects,
    createCalls,
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
        status: "Requested",
        requestExpiresAt: "0",
      };
      objects.set(object.objectId, object);
      idempotency.set(key, object.objectId);
      return { object, mocked: { tokenHostWrapper: true } };
    },
    async submitUploadBytes({ objectId, account, bytes }) {
      const object = ownedObject(objects, objectId, account.accountId);
      object.status = "Committed";
      object.completedCopies = object.requestedCopies;
      object.receiptHash =
        bytes.receiptHash ?? "0xabc0000000000000000000000000000000000000000000000000000000000000";

      const accountUsage = ensureUsage(usage, account.accountId);
      accountUsage.activeBytes = add(
        accountUsage.activeBytes,
        BigInt(object.size) * BigInt(object.completedCopies),
      );
      accountUsage.activeObjects = add(accountUsage.activeObjects, 1n);
      return this.readUploadStatus({ objectId, account });
    },
    async readUploadStatus({ objectId, account }) {
      const object = ownedObject(objects, objectId, account.accountId);
      return {
        object,
        usage: ensureUsage(usage, account.accountId),
        copyReceipts: [{ providerId: "111", datasetId: "222", pieceId: "333" }],
        receiptPayer: object.user,
        mocked: { tokenHostWrapper: true },
      };
    },
    async readObject({ objectId, account }) {
      return this.readUploadStatus({ objectId, account });
    },
    async readUsage({ account }) {
      return {
        accountId: account.accountId,
        usage: ensureUsage(usage, account.accountId),
        mocked: { tokenHostWrapper: true },
      };
    },
  };
}

function ownedObject(objects, objectId, accountId) {
  const object = objects.get(String(objectId));
  assert.ok(object, `missing object ${objectId}`);
  assert.equal(object.accountId, accountId);
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(text) {
  return `0x${createHash("sha256").update(text).digest("hex")}`;
}
