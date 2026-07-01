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
