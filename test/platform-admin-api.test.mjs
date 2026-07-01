import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_ADMIN_API_ROUTES,
  createPlatformAdminApi,
  createStaticAdminAuthorizer,
} from "../src/api/platform-admin-api.mjs";

const ACCOUNT_ID = hex32("01");
const USER = "0x0000000000000000000000000000000000001000";
const PAYER = "0x0000000000000000000000000000000000002000";
const COORDINATOR = "0x0000000000000000000000000000000000003000";

test("admin API requires explicit admin authorization", async () => {
  assert.throws(() => createPlatformAdminApi({ model: fixtureModel() }), /authorizeAdmin/);

  const api = createApi();
  const missing = await api.handle({
    method: "GET",
    path: "/admin/storage/objects",
  });
  const invalid = await api.handle({
    method: "GET",
    path: "/admin/storage/objects",
    headers: { "x-platform-admin-token": "wrong" },
  });

  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, "missing_admin_auth");
  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.error.code, "invalid_admin_auth");
});

test("admin API exposes read-only object and reconciliation views without user ownership checks", async () => {
  const api = createApi();

  const dashboard = await api.handle(adminRequest("/admin/storage/dashboard"));
  const objects = await api.handle(adminRequest("/admin/storage/objects"));
  const object = await api.handle(
    adminRequest("/admin/storage/objects/1", {
      "x-platform-user-id": "unrelated-platform-user",
    }),
  );
  const reconciliation = await api.handle(adminRequest("/admin/storage/reconciliation"));

  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.routes, PLATFORM_ADMIN_API_ROUTES);
  assert.equal(objects.status, 200);
  assert.equal(objects.body.objects[0].objectId, "1");
  assert.equal(object.status, 200);
  assert.equal(object.body.object.accountId, ACCOUNT_ID);
  assert.equal(object.body.object.receiptPayer, PAYER);
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.body.reconciliation.status, "pending_external_evidence");
  assert.equal(JSON.stringify(object.body).includes("unrelated-platform-user"), false);
});

test("admin API exposes usage, dataset, coordinator, and not-found responses", async () => {
  const api = createApi();

  const usage = await api.handle(adminRequest("/admin/storage/usage"));
  const datasets = await api.handle(adminRequest("/admin/storage/datasets"));
  const coordinators = await api.handle(adminRequest("/admin/storage/coordinators"));
  const missing = await api.handle(adminRequest("/admin/storage/objects/999"));

  assert.equal(usage.status, 200);
  assert.equal(usage.body.usage[0].activeBytes, "2048");
  assert.equal(datasets.status, 200);
  assert.equal(datasets.body.datasets[0].providerId, "111");
  assert.equal(coordinators.status, 200);
  assert.equal(coordinators.body.coordinators[0].coordinator, COORDINATOR);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "admin_object_not_found");
});

test("admin API successful responses are JSON-safe for direct contract-view bigints", async () => {
  const model = fixtureModel();
  model.objects[1].createdAt = 100n;
  model.objects[1].updatedAt = 101n;
  model.datasets[`${ACCOUNT_ID}:111:222`].updatedAt = 102n;
  const api = createPlatformAdminApi({
    model,
    authorizeAdmin: createStaticAdminAuthorizer({ token: "secret" }),
  });

  const object = await api.handle(adminRequest("/admin/storage/objects/1"));
  const datasets = await api.handle(adminRequest("/admin/storage/datasets"));

  assert.equal(object.body.object.object.createdAt, "100");
  assert.equal(object.body.object.object.updatedAt, "101");
  assert.equal(datasets.body.datasets[0].updatedAt, "102");
  assert.doesNotThrow(() => JSON.stringify(object.body));
  assert.doesNotThrow(() => JSON.stringify(datasets.body));
});

test("admin API defaults coordinator expiry checks to the current request time", async () => {
  const model = fixtureModel();
  model.objects[1].status = "Uploading";
  model.objects[1].completedCopies = 0;
  model.coordinators[COORDINATOR].sessionKeyExpiresAt = "1";
  const api = createPlatformAdminApi({
    model,
    authorizeAdmin: createStaticAdminAuthorizer({ token: "secret" }),
  });

  const coordinators = await api.handle(adminRequest("/admin/storage/coordinators"));
  const reconciliation = await api.handle(adminRequest("/admin/storage/reconciliation"));

  assert.equal(coordinators.body.coordinators[0].sessionStatus, "expired");
  assert.ok(
    reconciliation.body.reconciliation.checks
      .map((issue) => issue.code)
      .includes("uploading_object_expired_coordinator"),
  );
});

function createApi() {
  return createPlatformAdminApi({
    model: fixtureModel(),
    authorizeAdmin: createStaticAdminAuthorizer({ token: "secret" }),
  });
}

function adminRequest(path, headers = {}) {
  return {
    method: "GET",
    path,
    headers: {
      "x-platform-admin-token": "secret",
      ...headers,
    },
  };
}

function fixtureModel() {
  return {
    objects: {
      1: {
        objectId: "1",
        accountId: ACCOUNT_ID,
        user: USER,
        idempotencyKey: hex32("02"),
        contentHash: hex32("03"),
        metadataHash: hex32("04"),
        size: "1024",
        requestedCopies: 2,
        completedCopies: 2,
        withCDN: true,
        maxCost: "10",
        reservedCost: "10",
        actualCost: "7",
        status: "Committed",
        coordinator: COORDINATOR,
        receiptHash: hex32("05"),
      },
    },
    usage: {
      [ACCOUNT_ID]: {
        activeBytes: "2048",
        activeObjects: "1",
        pendingBytes: "0",
        reservedCost: "0",
        totalActualCost: "7",
        totalUploadedBytes: "2048",
        totalRequestedUploads: "1",
        totalFinalizedUploads: "1",
        totalFailedUploads: "0",
      },
    },
    copyReceipts: {
      1: [
        {
          providerId: "111",
          datasetId: "222",
          pieceId: "333",
          addPieceTxHash: hex32("06"),
          retrievalUrlHash: hex32("07"),
          isNewDataSet: true,
        },
        {
          providerId: "111",
          datasetId: "222",
          pieceId: "334",
          addPieceTxHash: hex32("08"),
          retrievalUrlHash: hex32("09"),
          isNewDataSet: false,
        },
      ],
    },
    receiptPayers: {
      1: PAYER,
    },
    datasets: {
      [`${ACCOUNT_ID}:111:222`]: {
        accountId: ACCOUNT_ID,
        providerId: "111",
        datasetId: "222",
        payer: PAYER,
        storageClass: hex32("0a"),
        withCDN: true,
        updatedAt: "100",
      },
    },
    coordinators: {
      [COORDINATOR]: {
        allowed: true,
        maxFinalizeDelay: "3600",
        sessionKeyExpiresAt: "0",
        permissionsHash: hex32("0b"),
      },
    },
    relayers: {},
    idempotency: {},
  };
}

function hex32(suffix) {
  return `0x${String(suffix).padStart(64, "0")}`;
}
