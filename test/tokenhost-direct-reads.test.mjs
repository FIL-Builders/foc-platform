import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformAdminApi } from "../src/api/platform-admin-api.mjs";
import { createTokenHostRegistryDirectReadAdapter } from "../src/demo/tokenhost-wrapper.mjs";

const REGISTRY_ADDRESS = "0x0000000000000000000000000000000000001000";
const USER_A = "0x0000000000000000000000000000000000002000";
const USER_B = "0x0000000000000000000000000000000000002001";
const COORDINATOR = "0x0000000000000000000000000000000000003000";
const RELAYER = "0x0000000000000000000000000000000000004000";
const PAYER = "0x0000000000000000000000000000000000005000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ACCOUNT_A = hex32("01");
const ACCOUNT_B = hex32("02");
const IDEMPOTENCY_A = hex32("03");
const IDEMPOTENCY_B = hex32("04");
const CONTENT_HASH = hex32("05");
const METADATA_HASH = hex32("06");
const PIECE_CID_HASH = hex32("07");
const RECEIPT_HASH = hex32("08");
const ADD_PIECE_TX_HASH = hex32("09");
const RETRIEVAL_URL_HASH = hex32("0a");
const STORAGE_CLASS_HASH = hex32("0b");
const PERMISSIONS_HASH = hex32("0c");

test("Token Host direct read adapter builds admin surfaces from registry list views", async () => {
  const publicClient = createRegistryFixtureClient();
  const adapter = createTokenHostRegistryDirectReadAdapter({
    publicClient,
    registryAddress: REGISTRY_ADDRESS,
    maxPageSize: 2,
    now: 1_000,
  });

  const objectPage = await adapter.readObjectPage({ limit: 2n, includeTerminal: true });
  assert.equal(objectPage.sourceOfTruth, "FocPlatformRegistryDirectReads");
  assert.deepEqual(objectPage.ids, ["2", "1"]);
  assert.equal(objectPage.pagination.mode, "objectIdCursor");
  assert.equal(objectPage.pagination.nextCursorIdExclusive, "1");
  assert.equal(
    objectPage.objects.find((row) => row.objectId === "1").object.status,
    "Committed",
  );

  const accountPage = await adapter.readAccountPage({ limit: 2n });
  assert.deepEqual(
    accountPage.accounts.map((row) => row.accountId),
    [ACCOUNT_A, ACCOUNT_B],
  );
  assert.deepEqual(accountPage.accounts[0].objectIds, ["1"]);
  assert.equal(accountPage.accounts[0].objectPagination.mode, "objectIdCursor");
  assert.deepEqual((await adapter.readAccountObjectPage(ACCOUNT_A, { limit: 2n })).ids, ["1"]);

  const datasetPage = await adapter.readDatasetPage({ limit: 2n });
  assert.deepEqual(datasetPage.keys, [`${ACCOUNT_A}:111:222`]);
  assert.doesNotThrow(() => JSON.stringify(datasetPage));

  const surfaces = await adapter.readAdminSurfaces({ limit: 2n });
  assert.equal(
    surfaces.sourceOfTruth.platformState,
    "FocPlatformRegistry direct contract list/detail/readBatch views",
  );
  assert.equal(
    surfaces.sourceOfTruth.eventProjectionRole,
    "audit, fixture, history, and fallback reconstruction only",
  );
  assert.equal(surfaces.summary.objectCount, 2);
  assert.equal(surfaces.summary.accountCount, 2);
  assert.equal(surfaces.summary.datasetCount, 1);
  assert.equal(surfaces.summary.coordinatorCount, 1);
  assert.equal(surfaces.summary.relayerCount, 1);
  assert.deepEqual(surfaces.summary.objectStatuses, {
    Committed: 1,
    Uploading: 1,
  });
  assert.equal(surfaces.objects[0].objectId, "1");
  assert.equal(surfaces.objects[0].copyCount, 1);
  assert.equal(surfaces.usage.find((row) => row.accountId === ACCOUNT_A).activeBytes, "1024");
  assert.equal(surfaces.datasets[0].key, `${ACCOUNT_A}:111:222`);
  assert.equal(surfaces.coordinators[0].sessionStatus, "active");
  assert.equal(surfaces.relayers[0].allowed, true);

  const api = createPlatformAdminApi({
    admin: adapter,
    authorizeAdmin: () => ({ admin: true }),
    options: { now: 1_000 },
  });
  const response = await api.handle({
    method: "GET",
    path: "/admin/storage/dashboard",
    headers: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary.objectCount, 2);
  assert.equal(
    response.body.sourceOfTruth.platformState,
    "FocPlatformRegistry direct contract list/detail/readBatch views",
  );

  const singleRowPages = await adapter.readAdminSurfaces({ limit: 1n });
  assert.equal(singleRowPages.summary.objectCount, 2);
  assert.deepEqual(
    singleRowPages.objects.map((row) => row.objectId),
    ["1", "2"],
  );
});

test("Token Host direct read adapter enforces the configured registry page cap", async () => {
  const adapter = createTokenHostRegistryDirectReadAdapter({
    publicClient: createRegistryFixtureClient(),
    registryAddress: REGISTRY_ADDRESS,
    maxPageSize: 2,
  });

  await assert.rejects(
    () => adapter.readObjectPage({ limit: 3n }),
    /registry page limit 3 exceeds maxPageSize 2/,
  );
});

test("Token Host direct read adapter honors admin route hints", async () => {
  const calls = [];
  const adapter = createTokenHostRegistryDirectReadAdapter({
    publicClient: createRegistryFixtureClient({ calls }),
    registryAddress: REGISTRY_ADDRESS,
    maxPageSize: 2,
    now: 1_000,
  });
  const api = createPlatformAdminApi({
    admin: adapter,
    authorizeAdmin: () => ({ admin: true }),
  });

  const coordinators = await api.handle({
    method: "GET",
    path: "/admin/storage/coordinators",
    headers: {},
  });
  assert.equal(coordinators.status, 200);
  assert.equal(coordinators.body.coordinators.length, 1);
  assert.equal(coordinators.body.relayers.length, 1);
  assert.equal(coordinators.body.coordinators[0].objectCount, 2);
  assert.deepEqual(coordinators.body.coordinators[0].activeObjectIds, ["2"]);
  assert.deepEqual(calls.map((call) => call.functionName), [
    "listStorageObjectIds",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "listStorageObjectIds",
    "listCoordinatorAddresses",
    "coordinatorPolicies",
    "listRelayerAddresses",
    "isRelayer",
  ]);

  calls.length = 0;
  const usage = await api.handle({
    method: "GET",
    path: "/admin/storage/usage",
    headers: {},
  });
  assert.equal(usage.status, 200);
  const accountBUsage = usage.body.usage.find((row) => row.accountId === ACCOUNT_B);
  assert.equal(accountBUsage.projectedPendingBytes, "1024");
  assert.equal(usage.body.summary.accountCount, 2);
  assert.equal(usage.body.summary.datasetCount, 1);
  assert.equal(usage.body.summary.coordinatorCount, 1);
  assert.equal(usage.body.summary.relayerCount, 1);
  assert.equal(usage.body.summary.mismatchCount, 0);
  assert.equal(usage.body.summary.warningCount, 0);
  assert.equal(usage.body.summary.pendingEvidenceCount, 1);
  assert.deepEqual(calls.map((call) => call.functionName), [
    "listStorageObjectIds",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "listStorageObjectIds",
    "listAccountIds",
    "getAccountUsage",
    "listAccountObjectIds",
    "getAccountUsage",
    "listAccountObjectIds",
    "listAccountIds",
    "listDatasetKeys",
    "getDatasetRecord",
    "listCoordinatorAddresses",
    "coordinatorPolicies",
    "listRelayerAddresses",
    "isRelayer",
  ]);

  calls.length = 0;
  const datasets = await api.handle({
    method: "GET",
    path: "/admin/storage/datasets",
    headers: {},
  });
  assert.equal(datasets.status, 200);
  assert.equal(datasets.body.datasets[0].copyCount, 1);
  assert.deepEqual(datasets.body.datasets[0].objectIds, ["1"]);
  assert.deepEqual(calls.map((call) => call.functionName), [
    "listStorageObjectIds",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "listStorageObjectIds",
    "listDatasetKeys",
    "getDatasetRecord",
  ]);

  calls.length = 0;
  const objects = await api.handle({
    method: "GET",
    path: "/admin/storage/objects",
    headers: {},
  });
  assert.equal(objects.status, 200);
  const committedObject = objects.body.objects.find((row) => row.objectId === "1");
  const uploadingObject = objects.body.objects.find((row) => row.objectId === "2");
  assert.ok(committedObject);
  assert.ok(uploadingObject);
  assert.equal(
    committedObject.reconciliationStatus,
    "pending_external_evidence",
  );
  assert.equal(uploadingObject.reconciliationStatus, "matched");
  assert.equal(objects.body.summary.accountCount, 2);
  assert.equal(objects.body.summary.datasetCount, 1);
  assert.equal(objects.body.summary.coordinatorCount, 1);
  assert.equal(objects.body.summary.relayerCount, 1);
  assert.equal(objects.body.summary.mismatchCount, 0);
  assert.equal(objects.body.summary.warningCount, 0);
  assert.equal(objects.body.summary.pendingEvidenceCount, 1);
  assert.deepEqual(calls.map((call) => call.functionName), [
    "listStorageObjectIds",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "listStorageObjectIds",
    "listAccountIds",
    "getAccountUsage",
    "listAccountObjectIds",
    "getAccountUsage",
    "listAccountObjectIds",
    "listAccountIds",
    "listDatasetKeys",
    "getDatasetRecord",
    "listCoordinatorAddresses",
    "coordinatorPolicies",
    "listRelayerAddresses",
    "isRelayer",
  ]);

  calls.length = 0;
  const object = await api.handle({
    method: "GET",
    path: "/admin/storage/objects/1",
    headers: {},
  });
  assert.equal(object.status, 200);
  assert.equal(object.body.object.objectId, "1");
  assert.equal(
    object.body.object.datasetAttribution[0].datasetRecordStatus,
    "recorded",
  );
  assert.equal(
    object.body.object.issues.some((issue) => issue.code === "missing_dataset_record"),
    false,
  );
  assert.deepEqual(calls.map((call) => call.functionName), [
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
    "listDatasetKeys",
    "getDatasetRecord",
    "listCoordinatorAddresses",
    "coordinatorPolicies",
  ]);

  calls.length = 0;
  const missingObject = await api.handle({
    method: "GET",
    path: "/admin/storage/objects/999",
    headers: {},
  });
  assert.equal(missingObject.status, 404);
  assert.equal(missingObject.body.error.code, "admin_object_not_found");
  assert.deepEqual(calls.map((call) => call.functionName), [
    "getStorageObject",
    "getCopyReceipts",
    "receiptPayer",
  ]);
});

test("Token Host direct read adapter defaults admin time for coordinator expiry checks", async () => {
  const adapter = createTokenHostRegistryDirectReadAdapter({
    publicClient: createRegistryFixtureClient(),
    registryAddress: REGISTRY_ADDRESS,
    maxPageSize: 2,
  });
  const surfaces = await adapter.readAdminSurfaces({ route: { name: "coordinators" } });

  assert.equal(surfaces.coordinators[0].sessionStatus, "expired");
});

test("Token Host direct read adapter restarts active cursor pages from the registry head", async () => {
  const adapter = createTokenHostRegistryDirectReadAdapter({
    publicClient: createRegistryFixtureClient({ staleActiveCursor: 99n }),
    registryAddress: REGISTRY_ADDRESS,
    maxPageSize: 2,
    includeTerminal: false,
  });

  const objectPage = await adapter.readObjectPage({ cursorIdExclusive: 99n, limit: 2n });
  assert.deepEqual(objectPage.ids, ["2", "1"]);
  assert.equal(objectPage.pagination.cursorIdExclusive, "0");
  assert.equal(objectPage.pagination.requestedCursorIdExclusive, "99");
  assert.equal(objectPage.pagination.restarted, true);
  assert.equal(objectPage.pagination.restartReason, "ActiveCursorTraversalLimitExceeded");

  const accountObjectPage = await adapter.readAccountObjectPage(ACCOUNT_A, {
    cursorIdExclusive: 99n,
    limit: 2n,
  });
  assert.deepEqual(accountObjectPage.ids, ["1"]);
  assert.equal(accountObjectPage.pagination.cursorIdExclusive, "0");
  assert.equal(accountObjectPage.pagination.requestedCursorIdExclusive, "99");
  assert.equal(accountObjectPage.pagination.restarted, true);
});

function createRegistryFixtureClient({ staleActiveCursor, calls } = {}) {
  const objects = new Map([
    [
      "1",
      {
        objectId: 1n,
        accountId: ACCOUNT_A,
        user: USER_A,
        idempotencyKey: IDEMPOTENCY_A,
        contentHash: CONTENT_HASH,
        metadataHash: METADATA_HASH,
        pieceCidHash: PIECE_CID_HASH,
        size: 1024n,
        requestedCopies: 1,
        completedCopies: 1,
        withCDN: true,
        maxCost: 10n,
        reservedCost: 0n,
        actualCost: 7n,
        status: 3,
        coordinator: COORDINATOR,
        requestExpiresAt: 2_000n,
        createdAt: 100n,
        updatedAt: 120n,
        receiptHash: RECEIPT_HASH,
      },
    ],
    [
      "2",
      {
        objectId: 2n,
        accountId: ACCOUNT_B,
        user: USER_B,
        idempotencyKey: IDEMPOTENCY_B,
        contentHash: CONTENT_HASH,
        metadataHash: METADATA_HASH,
        pieceCidHash: hex32("00"),
        size: 512n,
        requestedCopies: 2,
        completedCopies: 0,
        withCDN: false,
        maxCost: 3n,
        reservedCost: 3n,
        actualCost: 0n,
        status: 2,
        coordinator: COORDINATOR,
        requestExpiresAt: 2_000n,
        createdAt: 101n,
        updatedAt: 102n,
        receiptHash: hex32("00"),
      },
    ],
  ]);
  const usage = new Map([
    [
      ACCOUNT_A,
      {
        activeBytes: 1024n,
        activeObjects: 1n,
        pendingBytes: 0n,
        reservedCost: 0n,
        totalActualCost: 7n,
        totalUploadedBytes: 1024n,
        totalRequestedUploads: 1n,
        totalFinalizedUploads: 1n,
        totalFailedUploads: 0n,
      },
    ],
    [
      ACCOUNT_B,
      {
        activeBytes: 0n,
        activeObjects: 0n,
        pendingBytes: 1024n,
        reservedCost: 3n,
        totalActualCost: 0n,
        totalUploadedBytes: 0n,
        totalRequestedUploads: 1n,
        totalFinalizedUploads: 0n,
        totalFailedUploads: 0n,
      },
    ],
  ]);

  return {
    async readContract({ functionName, args = [] }) {
      calls?.push({ functionName, args });
      switch (functionName) {
        case "listStorageObjectIds":
          maybeThrowActiveCursorTraversalLimitExceeded({
            staleActiveCursor,
            cursorIdExclusive: args[0],
            includeTerminal: args[2],
          });
          return cursorPage([2n, 1n], args[0], args[1]);
        case "listAccountIds":
          return offsetPage([ACCOUNT_A, ACCOUNT_B], args[0], args[1]);
        case "listAccountObjectIds":
          maybeThrowActiveCursorTraversalLimitExceeded({
            staleActiveCursor,
            cursorIdExclusive: args[1],
            includeTerminal: args[3],
          });
          return cursorPage(args[0] === ACCOUNT_A ? [1n] : [2n], args[1], args[2]);
        case "listDatasetKeys":
          return offsetPage(
            [{ accountId: ACCOUNT_A, providerId: 111n, datasetId: 222n }],
            args[0],
            args[1],
          );
        case "listCoordinatorAddresses":
          return offsetPage([COORDINATOR], args[0], args[1]);
        case "listRelayerAddresses":
          return offsetPage([RELAYER], args[0], args[1]);
        case "getStorageObject":
          return objects.get(String(args[0])) ?? zeroStorageObject();
        case "getAccountUsage":
          return usage.get(args[0]);
        case "getCopyReceipts":
          return String(args[0]) === "1"
            ? [
                {
                  providerId: 111n,
                  datasetId: 222n,
                  pieceId: 333n,
                  addPieceTxHash: ADD_PIECE_TX_HASH,
                  retrievalUrlHash: RETRIEVAL_URL_HASH,
                  isNewDataSet: true,
                },
              ]
            : [];
        case "receiptPayer":
          return String(args[0]) === "1" ? PAYER : ZERO_ADDRESS;
        case "getDatasetRecord":
          return {
            accountId: args[0],
            payer: PAYER,
            providerId: args[1],
            datasetId: args[2],
            storageClass: STORAGE_CLASS_HASH,
            withCDN: true,
            createdAt: 100n,
            updatedAt: 120n,
          };
        case "coordinatorPolicies":
          return {
            allowed: true,
            maxFinalizeDelay: 3600n,
            sessionKeyExpiresAt: 2_000n,
            permissionsHash: PERMISSIONS_HASH,
          };
        case "isRelayer":
          return args[0] === RELAYER;
        default:
          throw new Error(`unexpected registry read ${functionName}`);
      }
    },
  };
}

function maybeThrowActiveCursorTraversalLimitExceeded({
  staleActiveCursor,
  cursorIdExclusive,
  includeTerminal,
}) {
  if (!includeTerminal && BigInt(cursorIdExclusive) === BigInt(staleActiveCursor ?? -1)) {
    const error = new Error("ActiveCursorTraversalLimitExceeded(uint256,uint256)");
    error.errorName = "ActiveCursorTraversalLimitExceeded";
    throw error;
  }
}

function cursorPage(values, cursorIdExclusive, limit) {
  const cursor = BigInt(cursorIdExclusive);
  return values
    .filter((value) => cursor === 0n || BigInt(value) < cursor)
    .slice(0, Number(limit));
}

function offsetPage(values, offset, limit) {
  return values.slice(Number(offset), Number(offset) + Number(limit));
}

function zeroStorageObject() {
  return {
    objectId: 0n,
    accountId: hex32("00"),
    user: ZERO_ADDRESS,
    idempotencyKey: hex32("00"),
    contentHash: hex32("00"),
    metadataHash: hex32("00"),
    pieceCidHash: hex32("00"),
    size: 0n,
    requestedCopies: 0,
    completedCopies: 0,
    withCDN: false,
    maxCost: 0n,
    reservedCost: 0n,
    actualCost: 0n,
    status: 0,
    coordinator: ZERO_ADDRESS,
    requestExpiresAt: 0n,
    createdAt: 0n,
    updatedAt: 0n,
    receiptHash: hex32("00"),
  };
}

function hex32(byte) {
  return `0x${byte.padStart(64, "0")}`;
}
