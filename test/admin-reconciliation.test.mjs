import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_SOURCE_OF_TRUTH,
  buildAdminSurfaces,
  buildAdminSurfacesFromEvents,
} from "../src/admin/reconciliation.mjs";
import { applyRegistryEvents } from "../src/registry/read-model.mjs";

const ACCOUNT_ID = hex32("01");
const USER = "0x0000000000000000000000000000000000001000";
const PAYER = "0x0000000000000000000000000000000000002000";
const COORDINATOR = "0x0000000000000000000000000000000000003000";
const EXPIRED_COORDINATOR = "0x0000000000000000000000000000000000004000";
const RELAYER = "0x0000000000000000000000000000000000005000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

test("admin surfaces project objects, usage, datasets, coordinators, and mismatches", () => {
  const model = fixtureModelWithMismatch();
  const surfaces = buildAdminSurfaces(
    {
      model,
      now: 500,
      focEvidence: {
        objects: {
          1: { verified: true, verifiedCopies: 2 },
        },
      },
    },
    {
      quotas: {
        [ACCOUNT_ID]: { maxActiveBytes: "4096" },
      },
    },
  );

  assert.equal(surfaces.sourceOfTruth, ADMIN_SOURCE_OF_TRUTH);
  assert.equal(surfaces.summary.objectCount, 3);
  assert.equal(surfaces.summary.accountCount, 1);
  assert.equal(surfaces.summary.coordinatorCount, 2);
  assert.equal(surfaces.summary.reconciliationStatus, "mismatch");
  assert.equal(surfaces.summary.warningCount, 1);
  assert.deepEqual(surfaces.summary.objectStatuses, {
    Committed: 1,
    Failed: 1,
    Uploading: 1,
  });

  const committed = surfaces.objects.find((object) => object.objectId === "1");
  assert.equal(committed.status, "Committed");
  assert.equal(committed.copyCount, 2);
  assert.equal(committed.focEvidenceStatus, "checked");
  assert.equal(committed.reconciliationStatus, "matched");

  const uploading = surfaces.objectDetails.find((object) => object.objectId === "3");
  assert.equal(uploading.status, "Uploading");
  assert.equal(uploading.copyReceipts.length, 1);
  assert.equal(uploading.datasetAttribution[0].datasetRecordStatus, "missing");
  assert.match(
    uploading.issues.map((issue) => issue.code).join(" "),
    /uploading_object_expired_coordinator/,
  );

  assert.deepEqual(surfaces.usage[0].quota, {
    maxActiveBytes: "4096",
    activeBytesRemaining: "2048",
    runwayStatus: "within_quota",
  });
  assert.equal(surfaces.usage[0].activeBytes, "2048");
  assert.equal(surfaces.usage[0].projectedActiveBytes, "2048");
  assert.equal(surfaces.usage[0].projectedPendingBytes, "1536");

  const provider111 = surfaces.providers.find((provider) => provider.providerId === "111");
  assert.equal(provider111.copyCount, 2);
  assert.deepEqual(provider111.objectIds, ["1"]);

  const provider999 = surfaces.providers.find((provider) => provider.providerId === "999");
  assert.equal(provider999.missingDatasetRecords, 1);
  assert.deepEqual(provider999.objectIds, ["3"]);

  const expiredCoordinator = surfaces.coordinators.find(
    (coordinator) => coordinator.coordinator === EXPIRED_COORDINATOR,
  );
  assert.equal(expiredCoordinator.sessionStatus, "expired");
  assert.equal(expiredCoordinator.uploadingObjectCount, 1);

  const codes = surfaces.reconciliation.checks.map((check) => check.code);
  assert.ok(codes.includes("missing_dataset_record"));
  assert.ok(codes.includes("usage_pending_bytes_mismatch"));
  assert.ok(codes.includes("uploading_object_expired_coordinator"));
});

test("admin surfaces can be reconstructed directly from registry events", () => {
  const surfaces = buildAdminSurfacesFromEvents(fixtureEvents(), {
    now: 200,
    focEvidence: {
      objects: {
        1: { verified: true, copyCount: 2 },
      },
    },
  });

  assert.equal(surfaces.summary.objectCount, 3);
  assert.equal(surfaces.summary.reconciliationStatus, "warning");
  assert.equal(surfaces.objects[0].accountId, ACCOUNT_ID);
  assert.equal(JSON.stringify(surfaces).includes("platform-user@example.com"), false);
});

test("admin surfaces normalize contract-view numeric upload statuses", () => {
  const model = fixtureModelWithMismatch();
  model.objects["1"].status = 3;
  model.objects["2"].status = 5n;
  model.objects["3"].status = "2";

  const surfaces = buildAdminSurfaces({ model, now: 500 });
  const committed = surfaces.objects.find((object) => object.objectId === "1");
  const uploading = surfaces.objectDetails.find((object) => object.objectId === "3");

  assert.equal(committed.status, "Committed");
  assert.equal(committed.activeBytes, "2048");
  assert.equal(committed.reconciliationStatus, "pending_external_evidence");
  assert.equal(uploading.status, "Uploading");
  assert.match(
    uploading.issues.map((issue) => issue.code).join(" "),
    /uploading_object_expired_coordinator/,
  );
});

test("admin surfaces ignore zero-address coordinators from direct contract views", () => {
  const model = fixtureModelWithMismatch();
  model.objects["4"] = {
    objectId: "4",
    accountId: ACCOUNT_ID,
    user: USER,
    idempotencyKey: hex32("41"),
    contentHash: hex32("42"),
    metadataHash: hex32("43"),
    size: "64",
    requestedCopies: "1",
    completedCopies: "0",
    withCDN: false,
    maxCost: "1",
    reservedCost: "1",
    actualCost: "0",
    status: "Requested",
    coordinator: ZERO_ADDRESS,
    receiptHash: hex32("00"),
  };

  const surfaces = buildAdminSurfaces({ model, now: 500 });

  assert.equal(surfaces.summary.coordinatorCount, 2);
  assert.equal(
    surfaces.coordinators.some((coordinator) => coordinator.coordinator === ZERO_ADDRESS),
    false,
  );
});

function fixtureModelWithMismatch() {
  const model = applyRegistryEvents(fixtureEvents());
  model.usage[ACCOUNT_ID].pendingBytes = "0";
  return model;
}

function fixtureEvents() {
  return [
    event("CoordinatorUpdated", {
      coordinator: COORDINATOR,
      allowed: true,
      maxFinalizeDelay: 3600n,
      sessionKeyExpiresAt: 1000n,
      permissionsHash: hex32("0a"),
    }),
    event("CoordinatorUpdated", {
      coordinator: EXPIRED_COORDINATOR,
      allowed: true,
      maxFinalizeDelay: 3600n,
      sessionKeyExpiresAt: 400n,
      permissionsHash: hex32("0b"),
    }),
    event("RelayerUpdated", {
      relayer: RELAYER,
      allowed: true,
    }),
    event("UsageReserved", {
      accountId: ACCOUNT_ID,
      objectId: 1n,
      reservedCost: 10n,
      activeBytesBefore: 0n,
    }),
    event(
      "UploadRequested",
      {
        objectId: 1n,
        accountId: ACCOUNT_ID,
        user: USER,
        idempotencyKey: hex32("11"),
        contentHash: hex32("12"),
        metadataHash: hex32("13"),
        size: 1024n,
        requestedCopies: 2,
        withCDN: true,
        maxCost: 10n,
        requestExpiresAt: 5000n,
      },
      100n,
    ),
    event("UploadStarted", { objectId: 1n, coordinator: COORDINATOR, startedAt: 101n }, 101n),
    event("CopyRecorded", {
      objectId: 1n,
      providerId: 111n,
      datasetId: 222n,
      pieceId: 333n,
      addPieceTxHash: hex32("14"),
      retrievalUrlHash: hex32("15"),
      isNewDataSet: true,
    }),
    event("CopyRecorded", {
      objectId: 1n,
      providerId: 111n,
      datasetId: 222n,
      pieceId: 334n,
      addPieceTxHash: hex32("16"),
      retrievalUrlHash: hex32("17"),
      isNewDataSet: false,
    }),
    event("DatasetRecorded", {
      accountId: ACCOUNT_ID,
      providerId: 111n,
      datasetId: 222n,
      payer: PAYER,
      storageClass: hex32("18"),
      withCDN: true,
    }),
    event("UsageReleased", { accountId: ACCOUNT_ID, objectId: 1n, releasedCost: 3n }),
    event("UsageFinalized", {
      accountId: ACCOUNT_ID,
      objectId: 1n,
      actualCost: 7n,
      activeBytesDelta: 2048n,
    }),
    event("ReceiptPayerRecorded", {
      objectId: 1n,
      accountId: ACCOUNT_ID,
      payer: PAYER,
    }),
    event("UploadFinalized", {
      objectId: 1n,
      accountId: ACCOUNT_ID,
      finalizationStatus: "Committed",
      pieceCidHash: hex32("19"),
      completedCopies: 2,
      actualCost: 7n,
      receiptHash: hex32("1a"),
    }),
    event("UsageReserved", {
      accountId: ACCOUNT_ID,
      objectId: 2n,
      reservedCost: 5n,
      activeBytesBefore: 2048n,
    }),
    event("UploadRequested", {
      objectId: 2n,
      accountId: ACCOUNT_ID,
      user: USER,
      idempotencyKey: hex32("21"),
      contentHash: hex32("22"),
      metadataHash: hex32("23"),
      size: 512n,
      requestedCopies: 1,
      withCDN: false,
      maxCost: 5n,
      requestExpiresAt: 5000n,
    }),
    event("UsageReleased", { accountId: ACCOUNT_ID, objectId: 2n, releasedCost: 5n }),
    event("UploadFailed", {
      objectId: 2n,
      accountId: ACCOUNT_ID,
      reasonHash: hex32("24"),
      chargedCost: 0n,
    }),
    event("UsageReserved", {
      accountId: ACCOUNT_ID,
      objectId: 3n,
      reservedCost: 8n,
      activeBytesBefore: 2048n,
    }),
    event("UploadRequested", {
      objectId: 3n,
      accountId: ACCOUNT_ID,
      user: USER,
      idempotencyKey: hex32("31"),
      contentHash: hex32("32"),
      metadataHash: hex32("33"),
      size: 768n,
      requestedCopies: 2,
      withCDN: true,
      maxCost: 8n,
      requestExpiresAt: 5000n,
    }),
    event("UploadStarted", {
      objectId: 3n,
      coordinator: EXPIRED_COORDINATOR,
      startedAt: 150n,
    }),
    event("CopyRecorded", {
      objectId: 3n,
      providerId: 999n,
      datasetId: 888n,
      pieceId: 777n,
      addPieceTxHash: hex32("34"),
      retrievalUrlHash: hex32("35"),
      isNewDataSet: true,
    }),
  ];
}

function event(eventName, args, blockTimestamp = 1n) {
  return {
    eventName,
    args,
    blockTimestamp,
  };
}

function hex32(suffix) {
  return `0x${String(suffix).padStart(64, "0")}`;
}
