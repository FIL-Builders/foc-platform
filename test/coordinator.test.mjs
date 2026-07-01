import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";

import {
  CoordinatorConfigError,
  HostedCoordinatorError,
  createCoordinatorSessionKey,
  createLocalHostedCoordinator,
  derivePermissionsHash,
  loadCoordinatorConfig,
  mapFailureToReasonHash,
  mapSynapseResultToUploadReceipt,
  validateUploadBytes,
} from "../src/coordinator/index.mjs";

const ROOT = "0x0000000000000000000000000000000000001000";
const SESSION = "0x0000000000000000000000000000000000002000";
const PAYER = "0x0000000000000000000000000000000000003000";
const ACCOUNT_ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IDEMPOTENCY_KEY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONTENT_HASH = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

test("coordinator config rejects raw private key material", () => {
  assert.throws(
    () =>
      loadCoordinatorConfig({
        FOC_COORDINATOR_ADDRESS: SESSION,
        FOC_ROOT_ADDRESS: ROOT,
        FOC_SESSION_KEY_PRIVATE_KEY: "0x1234",
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "secret_material_in_config");
      assert.deepEqual(error.details.keys, ["FOC_SESSION_KEY_PRIVATE_KEY"]);
      return true;
    },
  );
});

test("coordinator config bounds default requested copies to uint8", () => {
  assert.throws(
    () =>
      loadCoordinatorConfig({
        FOC_COORDINATOR_DEFAULT_REQUESTED_COPIES: "256",
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "invalid_defaultRequestedCopies");
      assert.match(error.message, /must fit uint8/);
      return true;
    },
  );
  assert.throws(
    () =>
      loadCoordinatorConfig({
        FOC_COORDINATOR_DEFAULT_REQUESTED_COPIES: "0",
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "invalid_default_requested_copies");
      return true;
    },
  );
});

test("session-key config validates expiry and permissions hash", async () => {
  const permissionsHash = derivePermissionsHash({
    dataset: "write",
    piece: "add",
  });
  const config = loadCoordinatorConfig({
    FOC_COORDINATOR_ADDRESS: SESSION,
    FOC_ROOT_ADDRESS: ROOT,
    FOC_SESSION_KEY_ADDRESS: SESSION,
    FOC_SESSION_KEY_EXPIRES_AT: "500",
    FOC_SESSION_KEY_PERMISSIONS_HASH: permissionsHash,
  });
  const sessionKey = createCoordinatorSessionKey({
    address: SESSION,
    rootAddress: ROOT,
    expiresAt: 499n,
    permissionsHash,
  });
  const coordinator = createLocalHostedCoordinator({
    config,
    sessionKey,
    registry: createRegistry(),
    focClient: createFocClient(),
    clock: () => 500n,
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "expired_session_key");
      return true;
    },
  );
});

test("receipt mapping produces section 6.7-compatible committed receipt fields", () => {
  const receipt = mapSynapseResultToUploadReceipt({
    payer: PAYER,
    request: requestFixture({ size: 4n, requestedCopies: 2 }),
    result: {
      pieceCid: "baga6ea4seaqtest",
      actualCost: 7n,
      copies: [
        copyFixture({ providerId: 111n, datasetId: 222n, pieceId: 333n }),
        copyFixture({ providerId: 112n, datasetId: 223n, pieceId: 334n }),
      ],
    },
  });

  assert.equal(receipt.finalizationStatus, 0);
  assert.equal(receipt.finalizationStatusLabel, "Committed");
  assert.equal(receipt.payer, PAYER);
  assert.equal(receipt.size, 4n);
  assert.equal(receipt.requestedCopies, 2);
  assert.equal(receipt.completedCopies, 2);
  assert.equal(receipt.actualCost, 7n);
  assert.match(receipt.pieceCidHash, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.receiptHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.copies[0].providerId, 111n);
});

test("receipt hash is canonical across object key insertion order", () => {
  const requestA = requestFixture({ size: 4n, requestedCopies: 1 });
  const requestB = {
    maxCost: requestA.maxCost,
    withCDN: requestA.withCDN,
    requestedCopies: requestA.requestedCopies,
    size: requestA.size,
    metadataHash: requestA.metadataHash,
    contentHash: requestA.contentHash,
    idempotencyKey: requestA.idempotencyKey,
    accountId: requestA.accountId,
    objectId: requestA.objectId,
  };
  const result = {
    actualCost: 7n,
    completedCopies: 1,
    pieceCidHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    copies: [copyFixture()],
  };

  const receiptA = mapSynapseResultToUploadReceipt({
    payer: PAYER,
    request: requestA,
    result,
  });
  const receiptB = mapSynapseResultToUploadReceipt({
    payer: PAYER,
    request: requestB,
    result,
  });

  assert.equal(receiptA.receiptHash, receiptB.receiptHash);
});

test("receipt mapping rejects completed copy count mismatches", () => {
  assert.throws(
    () =>
      mapSynapseResultToUploadReceipt({
        payer: PAYER,
        request: requestFixture({ size: 4n, requestedCopies: 2 }),
        result: {
          completedCopies: 2,
          copies: [copyFixture()],
        },
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "copy_count_mismatch");
      assert.deepEqual(error.details, { completedCopies: "2", copyCount: "1" });
      return true;
    },
  );
});

test("upload bytes validate declared size and optional keccak content commitment", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const contentHash = keccak256(bytes);

  assert.deepEqual(
    validateUploadBytes({
      bytes,
      declaredSize: 4n,
      contentHash,
      contentHashAlgorithm: "keccak256",
    }),
    bytes,
  );
  assert.throws(
    () =>
      validateUploadBytes({
        bytes,
        declaredSize: 5n,
        contentHash,
        contentHashAlgorithm: "keccak256",
      }),
    /upload byte length does not match request/,
  );
  assert.throws(
    () =>
      validateUploadBytes({
        bytes,
        declaredSize: 4n,
        contentHash: CONTENT_HASH,
        contentHashAlgorithm: "keccak256",
      }),
    /upload bytes do not match declared content commitment/,
  );
  assert.throws(
    () =>
      validateUploadBytes({
        bytes,
        declaredSize: 4n,
        contentHash,
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "missing_content_hash_algorithm");
      return true;
    },
  );
  assert.deepEqual(
    validateUploadBytes({
      bytes,
      declaredSize: 4n,
      contentHash: ZERO_BYTES32,
    }),
    bytes,
  );
});

test("upload bytes validate identity-bytes32 content commitments", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const contentHash = `0x${Buffer.from(bytes).toString("hex")}`;

  assert.deepEqual(
    validateUploadBytes({
      bytes,
      declaredSize: 32n,
      contentHash: contentHash.toUpperCase().replace("0X", "0x"),
      contentHashAlgorithm: "identity-bytes32",
    }),
    bytes,
  );
  assert.throws(
    () =>
      validateUploadBytes({
        bytes: new Uint8Array([1, 2, 3, 4]),
        declaredSize: 4n,
        contentHash,
        contentHashAlgorithm: "identity-bytes32",
      }),
    /must be exactly 32 bytes/,
  );
});

test("upload byte validation describes accepted input shapes", () => {
  assert.throws(
    () =>
      validateUploadBytes({
        bytes: { unsupported: true },
        declaredSize: 4n,
      }),
    /Uint8Array, hex\/text string, or number array/,
  );
  assert.throws(
    () =>
      validateUploadBytes({
        bytes: [0, 256],
        declaredSize: 2n,
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "invalid_upload_bytes");
      assert.match(error.message, /integers from 0 to 255/);
      assert.equal(error.details.index, 1);
      assert.equal(error.details.value, 256);
      return true;
    },
  );
});

test("local hosted coordinator starts and finalizes through injected adapters", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });
  const request = requestFixture({ size: 4n, requestedCopies: 2 });

  const first = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  const replay = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(first.status, "Committed");
  assert.equal(first.receipt.finalizationStatus, 0);
  assert.equal(first.receipt.completedCopies, 2);
  assert.equal(registry.startCalls.length, 1);
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(uploadCalls.length, 1);
  assert.equal(replay, first);
  assert.equal(first.mocked.focBytesMoved, false);
});

test("local hosted coordinator uploads the validated byte snapshot", async () => {
  const registry = createRegistry();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const uploadCalls = [];
  registry.startUpload = async (args) => {
    registry.status = "Uploading";
    registry.startCalls.push(args);
    bytes[0] = 99;
    return { status: registry.status };
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request: requestFixture({ size: 4n }),
    bytes,
  });

  assert.equal(result.status, "Committed");
  assert.deepEqual(Array.from(bytes), [99, 2, 3, 4]);
  assert.deepEqual(Array.from(uploadCalls[0].bytes), [1, 2, 3, 4]);
});

test("local hosted coordinator resumes Uploading objects without replaying startUpload", async () => {
  const registry = createRegistry();
  registry.status = "Uploading";
  const uploadCalls = [];
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request: requestFixture({ size: 4n }),
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(result.status, "Committed");
  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator resumes if startUpload loses an Uploading race", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const startRaceError = new Error("already uploading");
  startRaceError.code = "invalid_transition";
  registry.startUpload = async (args) => {
    registry.startCalls.push(args);
    registry.status = "Uploading";
    throw startRaceError;
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request: requestFixture({ size: 4n }),
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(result.status, "Committed");
  assert.equal(registry.startCalls.length, 1);
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator records failUpload and caches failed idempotency result", async () => {
  const registry = createRegistry();
  const uploadError = new Error("simulated provider timeout");
  uploadError.code = "provider_timeout";
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload() {
        throw uploadError;
      },
    },
  });
  const request = requestFixture({ size: 4n });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "coordinator_upload_failed");
      assert.equal(error.details.reasonHash, mapFailureToReasonHash(uploadError));
      return true;
    },
  );
  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    HostedCoordinatorError,
  );

  assert.equal(registry.startCalls.length, 1);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 1);
  assert.equal(registry.failCalls[0].chargedCost, 0n);
  assert.equal(registry.failCalls[0].reasonHash, mapFailureToReasonHash(uploadError));
});

test("local hosted coordinator caches failure even when registry failUpload throws", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const failRecordError = new Error("failure tx rejected");
  failRecordError.code = "failure_tx_rejected";
  registry.failUpload = async (args) => {
    registry.failCalls.push(args);
    throw failRecordError;
  };
  const uploadError = new Error("simulated provider timeout");
  uploadError.code = "provider_timeout";
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload(input) {
        uploadCalls.push(input);
        throw uploadError;
      },
    },
  });
  const request = requestFixture({ size: 4n });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () =>
        coordinator.executeUpload({
          objectId: 1n,
          request,
          bytes: new Uint8Array([1, 2, 3, 4]),
        }),
      (error) => {
        assert.equal(error.name, "HostedCoordinatorError");
        assert.equal(error.code, "coordinator_upload_failed");
        assert.notEqual(error.code, "upload_in_progress");
        assert.equal(error.details.failRecordError.code, "failure_tx_rejected");
        return true;
      },
    );
  }

  assert.equal(uploadCalls.length, 1);
  assert.equal(registry.failCalls.length, 1);
});

test("local hosted coordinator does not failUpload an already terminal object", async () => {
  const registry = createRegistry();
  registry.status = "Committed";
  const coordinator = createCoordinator({ registry });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "terminal_upload");
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
});

function createCoordinator({ registry = createRegistry(), focClient = createFocClient() } = {}) {
  const permissionsHash = derivePermissionsHash({ dataset: "write", piece: "add" });
  const config = loadCoordinatorConfig({
    FOC_COORDINATOR_MODE: "local-dev",
    FOC_COORDINATOR_RUNNER: "simulated-synapse",
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
  return createLocalHostedCoordinator({
    config,
    registry,
    focClient,
    sessionKey,
    clock: () => 100n,
  });
}

function requestFixture({ size = 4n, requestedCopies = 2 } = {}) {
  return {
    objectId: "1",
    accountId: ACCOUNT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    contentHash: undefined,
    metadataHash: CONTENT_HASH,
    size,
    requestedCopies,
    withCDN: false,
    maxCost: 10n,
  };
}

function copyFixture({
  providerId = 111n,
  datasetId = 222n,
  pieceId = 333n,
  addPieceTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111",
  retrievalUrlHash = "0x2222222222222222222222222222222222222222222222222222222222222222",
} = {}) {
  return {
    providerId,
    datasetId,
    pieceId,
    addPieceTxHash,
    retrievalUrlHash,
    isNewDataSet: true,
  };
}

function createFocClient({ uploadCalls = [] } = {}) {
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

function createRegistry() {
  const registry = {
    status: "Requested",
    startCalls: [],
    finalizeCalls: [],
    failCalls: [],
    async readUploadStatus({ objectId }) {
      return {
        object: {
          objectId: String(objectId),
          status: this.status,
        },
      };
    },
    async startUpload(args) {
      this.status = "Uploading";
      this.startCalls.push(args);
      return { status: this.status };
    },
    async finalizeUpload(args) {
      this.status = args.receipt.finalizationStatus === 0 ? "Committed" : "Partial";
      this.finalizeCalls.push(args);
      return { status: this.status, receipt: args.receipt };
    },
    async failUpload(args) {
      this.status = "Failed";
      this.failCalls.push(args);
      return { status: this.status, reasonHash: args.reasonHash };
    },
  };
  return registry;
}
