import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";

import {
  applyRegistryEvents,
  decodeRegistryLog,
  registryAbi,
  registryArtifact,
  registryCoordinatorPolicyRead,
  registryCopyReceiptsRead,
  registryDatasetRecordRead,
  registryObjectRead,
  registryReceiptPayerRead,
  registryRelayerRead,
  registryUsageRead,
} from "../src/registry/read-model.mjs";

const REGISTRY_ADDRESS = "0x0000000000000000000000000000000000001000";
const USER = "0x0000000000000000000000000000000000002000";
const COORDINATOR = "0x0000000000000000000000000000000000003000";
const PAYER = "0x0000000000000000000000000000000000004000";
const ACCOUNT_ID = hex32("01");
const IDEMPOTENCY_KEY = hex32("02");
const CONTENT_HASH = hex32("03");
const METADATA_HASH = hex32("04");
const PIECE_CID_HASH = hex32("05");
const RECEIPT_HASH = hex32("06");
const ADD_PIECE_TX_HASH = hex32("07");
const RETRIEVAL_URL_HASH = hex32("08");
const STORAGE_CLASS_HASH = hex32("09");
const FAILURE_REASON_HASH = hex32("0a");

test("registry artifact exposes stable ABI and bytecode hashes", () => {
  assert.equal(registryArtifact.contractName, "FocPlatformRegistry");
  assert.equal(registryArtifact.sourceName, "contracts/FocPlatformRegistry.sol");
  assert.match(registryArtifact.bytecodeSha256, /^0x[0-9a-f]{64}$/);
  assert.match(registryArtifact.deployedBytecodeSha256, /^0x[0-9a-f]{64}$/);

  assert.ok(findAbiItem("function", "requestUpload"));
  assert.ok(findAbiItem("function", "receiptPayer"));
  assert.ok(findAbiItem("function", "domainSeparator"));
  assert.ok(findAbiItem("event", "UploadRequested"));
  assert.ok(findAbiItem("event", "ReceiptPayerRecorded"));
});

test("decodeRegistryLog decodes an UploadRequested log from ABI topics and data", () => {
  const decoded = decodeRegistryLog(
    encodeLog("UploadRequested", { objectId: 1n, accountId: ACCOUNT_ID, user: USER }, [
      IDEMPOTENCY_KEY,
      CONTENT_HASH,
      METADATA_HASH,
      1024n,
      2,
      true,
      10n,
      5000n,
    ]),
  );

  assert.equal(decoded.eventName, "UploadRequested");
  assert.equal(decoded.args.objectId, 1n);
  assert.equal(decoded.args.accountId, ACCOUNT_ID);
  assert.equal(decoded.args.user, USER);
  assert.equal(decoded.args.size, 1024n);
  assert.equal(decoded.args.requestedCopies, 2);
});

test("registry read helpers build viem-compatible contract read requests", () => {
  assert.deepEqual(registryObjectRead(REGISTRY_ADDRESS, 1n), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "getStorageObject",
    args: [1n],
  });
  assert.deepEqual(registryUsageRead(REGISTRY_ADDRESS, ACCOUNT_ID), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "getAccountUsage",
    args: [ACCOUNT_ID],
  });
  assert.deepEqual(registryCopyReceiptsRead(REGISTRY_ADDRESS, 1n), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "getCopyReceipts",
    args: [1n],
  });
  assert.deepEqual(registryReceiptPayerRead(REGISTRY_ADDRESS, 1n), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "receiptPayer",
    args: [1n],
  });
  assert.deepEqual(registryCoordinatorPolicyRead(REGISTRY_ADDRESS, COORDINATOR), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "coordinatorPolicies",
    args: [COORDINATOR],
  });
  assert.deepEqual(registryRelayerRead(REGISTRY_ADDRESS, USER), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "isRelayer",
    args: [USER],
  });
  assert.deepEqual(registryDatasetRecordRead(REGISTRY_ADDRESS, ACCOUNT_ID, 111n, 222n), {
    address: REGISTRY_ADDRESS,
    abi: registryAbi,
    functionName: "getDatasetRecord",
    args: [ACCOUNT_ID, 111n, 222n],
  });
});

test("applyRegistryEvents reconstructs committed object, usage, copy, and payer state", () => {
  const events = [
    decodeRegistryLog(
      encodeLog("UsageReserved", { accountId: ACCOUNT_ID, objectId: 1n }, [10n, 0n], {
        blockTimestamp: 100n,
      }),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadRequested",
        { objectId: 1n, accountId: ACCOUNT_ID, user: USER },
        [IDEMPOTENCY_KEY, CONTENT_HASH, METADATA_HASH, 1024n, 1, true, 10n, 5000n],
        { blockTimestamp: 100n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UploadStarted", { objectId: 1n, coordinator: COORDINATOR }, [101n], {
        blockTimestamp: 101n,
      }),
    ),
    decodeRegistryLog(
      encodeLog("CopyRecorded", { objectId: 1n, providerId: 111n, datasetId: 222n }, [
        333n,
        ADD_PIECE_TX_HASH,
        RETRIEVAL_URL_HASH,
        true,
      ]),
    ),
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 1n }, [3n], {
        blockTimestamp: 102n,
      }),
    ),
    decodeRegistryLog(
      encodeLog("UsageFinalized", { accountId: ACCOUNT_ID, objectId: 1n }, [7n, 1024n], {
        blockTimestamp: 102n,
      }),
    ),
    decodeRegistryLog(
      encodeLog(
        "ReceiptPayerRecorded",
        { objectId: 1n, accountId: ACCOUNT_ID, payer: PAYER },
        [],
        { blockTimestamp: 102n },
      ),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadFinalized",
        { objectId: 1n, accountId: ACCOUNT_ID },
        [0, PIECE_CID_HASH, 1, 7n, RECEIPT_HASH],
        { blockTimestamp: 102n },
      ),
    ),
  ];

  const model = applyRegistryEvents(events);

  assert.deepEqual(model.objects["1"], {
    objectId: "1",
    accountId: ACCOUNT_ID,
    user: USER,
    idempotencyKey: IDEMPOTENCY_KEY,
    contentHash: CONTENT_HASH,
    metadataHash: METADATA_HASH,
    size: "1024",
    requestedCopies: 1,
    withCDN: true,
    maxCost: "10",
    reservedCost: "10",
    requestExpiresAt: "5000",
    status: "Committed",
    createdAt: "100",
    updatedAt: "102",
    coordinator: COORDINATOR,
    startedAt: "101",
    receiptPayer: PAYER,
    pieceCidHash: PIECE_CID_HASH,
    completedCopies: 1,
    actualCost: "7",
    receiptHash: RECEIPT_HASH,
  });
  assert.deepEqual(model.usage[ACCOUNT_ID], {
    activeBytes: "1024",
    activeObjects: "1",
    pendingBytes: "0",
    reservedCost: "0",
    totalActualCost: "7",
    totalUploadedBytes: "1024",
    totalRequestedUploads: "1",
    totalFinalizedUploads: "1",
    totalFailedUploads: "0",
    lastActiveBytesBeforeReservation: "0",
    lastReleasedCost: "3",
  });
  assert.deepEqual(model.copyReceipts["1"], [
    {
      providerId: "111",
      datasetId: "222",
      pieceId: "333",
      addPieceTxHash: ADD_PIECE_TX_HASH,
      retrievalUrlHash: RETRIEVAL_URL_HASH,
      isNewDataSet: true,
    },
  ]);
  assert.equal(model.receiptPayers["1"], PAYER);
  assert.equal(model.idempotency[`${ACCOUNT_ID}:${IDEMPOTENCY_KEY}`], "1");
});

test("applyRegistryEvents sorts positioned logs by block number and log index", () => {
  const events = [
    decodeRegistryLog(
      encodeLog("UploadCancelled", { objectId: 6n, accountId: ACCOUNT_ID }, [], {
        blockNumber: 300n,
        blockTimestamp: 303n,
        logIndex: 3n,
      }),
    ),
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 6n }, [9n], {
        blockNumber: 300n,
        blockTimestamp: 302n,
        logIndex: 2n,
      }),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadRequested",
        { objectId: 6n, accountId: ACCOUNT_ID, user: USER },
        [hex32("16"), CONTENT_HASH, METADATA_HASH, 256n, 2, false, 9n, 5000n],
        { blockNumber: 300n, blockTimestamp: 301n, logIndex: 1n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UsageReserved", { accountId: ACCOUNT_ID, objectId: 6n }, [9n, 0n], {
        blockNumber: 300n,
        blockTimestamp: 300n,
        logIndex: 0n,
      }),
    ),
  ];

  const model = applyRegistryEvents(events);

  assert.equal(model.objects["6"].status, "Cancelled");
  assert.equal(model.objects["6"].createdAt, "301");
  assert.equal(model.objects["6"].updatedAt, "303");
  assert.deepEqual(model.usage[ACCOUNT_ID], {
    activeBytes: "0",
    activeObjects: "0",
    pendingBytes: "0",
    reservedCost: "0",
    totalActualCost: "0",
    totalUploadedBytes: "0",
    totalRequestedUploads: "1",
    totalFinalizedUploads: "0",
    totalFailedUploads: "0",
    lastActiveBytesBeforeReservation: "0",
    lastReleasedCost: "9",
  });
});

test("applyRegistryEvents reconstructs coordinator, relayer, and dataset state", () => {
  const permissionsHash = hex32("0b");
  const events = [
    decodeRegistryLog(
      encodeLog("CoordinatorUpdated", { coordinator: COORDINATOR }, [
        true,
        3600n,
        10_000n,
        permissionsHash,
      ]),
    ),
    decodeRegistryLog(encodeLog("RelayerUpdated", { relayer: USER }, [true])),
    decodeRegistryLog(
      encodeLog(
        "DatasetRecorded",
        { accountId: ACCOUNT_ID, providerId: 111n, datasetId: 222n },
        [PAYER, STORAGE_CLASS_HASH, true],
        { blockTimestamp: 200n },
      ),
    ),
  ];

  const model = applyRegistryEvents(events);

  assert.deepEqual(model.coordinators[COORDINATOR.toLowerCase()], {
    allowed: true,
    maxFinalizeDelay: "3600",
    sessionKeyExpiresAt: "10000",
    permissionsHash,
  });
  assert.equal(model.relayers[USER.toLowerCase()], true);
  assert.deepEqual(model.datasets[`${ACCOUNT_ID}:111:222`], {
    accountId: ACCOUNT_ID,
    providerId: "111",
    datasetId: "222",
    payer: PAYER,
    storageClass: STORAGE_CLASS_HASH,
    withCDN: true,
    updatedAt: "200",
  });
});

test("applyRegistryEvents handles failed, cancelled, expired, and failed-finalized uploads", () => {
  const events = [
    decodeRegistryLog(
      encodeLog("UsageReserved", { accountId: ACCOUNT_ID, objectId: 2n }, [5n, 0n]),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadRequested",
        { objectId: 2n, accountId: ACCOUNT_ID, user: USER },
        [hex32("12"), CONTENT_HASH, METADATA_HASH, 100n, 1, false, 5n, 5000n],
        { blockTimestamp: 201n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 2n }, [3n]),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadFailed",
        { objectId: 2n, accountId: ACCOUNT_ID },
        [FAILURE_REASON_HASH, 2n],
        { blockTimestamp: 203n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UsageReserved", { accountId: ACCOUNT_ID, objectId: 3n }, [4n, 0n]),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadRequested",
        { objectId: 3n, accountId: ACCOUNT_ID, user: USER },
        [hex32("13"), CONTENT_HASH, METADATA_HASH, 200n, 1, false, 4n, 5000n],
        { blockTimestamp: 211n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 3n }, [4n]),
    ),
    decodeRegistryLog(
      encodeLog("UploadCancelled", { objectId: 3n, accountId: ACCOUNT_ID }, [], {
        blockTimestamp: 213n,
      }),
    ),
    decodeRegistryLog(
      encodeLog("UsageReserved", { accountId: ACCOUNT_ID, objectId: 4n }, [6n, 0n]),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadRequested",
        { objectId: 4n, accountId: ACCOUNT_ID, user: USER },
        [hex32("14"), CONTENT_HASH, METADATA_HASH, 300n, 1, false, 6n, 5000n],
        { blockTimestamp: 221n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 4n }, [6n]),
    ),
    decodeRegistryLog(
      encodeLog("UploadExpired", { objectId: 4n, accountId: ACCOUNT_ID }, [], {
        blockTimestamp: 223n,
      }),
    ),
    decodeRegistryLog(
      encodeLog("UsageReserved", { accountId: ACCOUNT_ID, objectId: 5n }, [8n, 0n]),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadRequested",
        { objectId: 5n, accountId: ACCOUNT_ID, user: USER },
        [hex32("15"), CONTENT_HASH, METADATA_HASH, 400n, 1, false, 8n, 5000n],
        { blockTimestamp: 231n },
      ),
    ),
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 5n }, [8n]),
    ),
    decodeRegistryLog(
      encodeLog("UsageFinalized", { accountId: ACCOUNT_ID, objectId: 5n }, [0n, 0n]),
    ),
    decodeRegistryLog(
      encodeLog("ReceiptPayerRecorded", { objectId: 5n, accountId: ACCOUNT_ID, payer: PAYER }, []),
    ),
    decodeRegistryLog(
      encodeLog(
        "UploadFinalized",
        { objectId: 5n, accountId: ACCOUNT_ID },
        [2, PIECE_CID_HASH, 0, 0n, RECEIPT_HASH],
        { blockTimestamp: 233n },
      ),
    ),
  ];

  const model = applyRegistryEvents(events);

  assert.equal(model.objects["2"].status, "Failed");
  assert.equal(model.objects["2"].failureReasonHash, FAILURE_REASON_HASH);
  assert.equal(model.objects["2"].actualCost, "2");
  assert.equal(model.objects["2"].updatedAt, "203");
  assert.equal(model.objects["3"].status, "Cancelled");
  assert.equal(model.objects["3"].updatedAt, "213");
  assert.equal(model.objects["4"].status, "Expired");
  assert.equal(model.objects["4"].updatedAt, "223");
  assert.equal(model.objects["5"].status, "Failed");
  assert.equal(model.objects["5"].completedCopies, 0);
  assert.equal(model.objects["5"].receiptPayer, PAYER);
  assert.equal(model.objects["5"].updatedAt, "233");

  assert.deepEqual(model.usage[ACCOUNT_ID], {
    activeBytes: "0",
    activeObjects: "0",
    pendingBytes: "0",
    reservedCost: "0",
    totalActualCost: "2",
    totalUploadedBytes: "0",
    totalRequestedUploads: "4",
    totalFinalizedUploads: "0",
    totalFailedUploads: "2",
    lastActiveBytesBeforeReservation: "0",
    lastReleasedCost: "8",
  });
});

test("applyRegistryEvents clamps release counters for partial histories", () => {
  const events = [
    decodeRegistryLog(
      encodeLog("UsageReleased", { accountId: ACCOUNT_ID, objectId: 99n }, [25n]),
    ),
  ];

  const model = applyRegistryEvents(events);

  assert.equal(model.usage[ACCOUNT_ID].reservedCost, "0");
  assert.equal(model.usage[ACCOUNT_ID].pendingBytes, "0");
  assert.equal(model.usage[ACCOUNT_ID].lastReleasedCost, "25");
});

function encodeLog(eventName, indexedArgs, dataArgs, metadata = {}) {
  const abiItem = findAbiItem("event", eventName);
  const dataInputs = abiItem.inputs.filter((input) => !input.indexed);

  return {
    address: REGISTRY_ADDRESS,
    topics: encodeEventTopics({
      abi: registryAbi,
      eventName,
      args: indexedArgs,
    }),
    data: dataInputs.length === 0 ? "0x" : encodeAbiParameters(dataInputs, dataArgs),
    ...metadata,
  };
}

function findAbiItem(type, name) {
  return registryAbi.find((item) => item.type === type && item.name === name);
}

function hex32(byte) {
  return `0x${byte.padStart(64, "0")}`;
}
