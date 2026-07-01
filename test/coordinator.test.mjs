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
  const request = requestFixture({ size: 4n });
  const sessionKey = createCoordinatorSessionKey({
    address: SESSION,
    rootAddress: ROOT,
    expiresAt: 499n,
    permissionsHash,
  });
  const registry = createRegistry();
  const uploadCalls = [];
  const coordinator = createLocalHostedCoordinator({
    config,
    sessionKey,
    registry,
    focClient: createFocClient({ uploadCalls }),
    clock: () => 500n,
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "expired_session_key");
      return true;
    },
  );
  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);

  const configuredExpiredRegistry = createRegistry();
  const configuredExpiredUploadCalls = [];
  const configuredExpiredCoordinator = createLocalHostedCoordinator({
    config,
    sessionKey: createCoordinatorSessionKey({
      address: SESSION,
      rootAddress: ROOT,
      expiresAt: 1000n,
      permissionsHash,
    }),
    registry: configuredExpiredRegistry,
    focClient: createFocClient({ uploadCalls: configuredExpiredUploadCalls }),
    clock: () => 501n,
  });
  await assert.rejects(
    () =>
      configuredExpiredCoordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "expired_session_key");
      assert.equal(error.details.expiresAt, "500");
      return true;
    },
  );
  assert.equal(configuredExpiredRegistry.startCalls.length, 0);
  assert.equal(configuredExpiredRegistry.finalizeCalls.length, 0);
  assert.equal(configuredExpiredRegistry.failCalls.length, 0);
  assert.equal(configuredExpiredUploadCalls.length, 0);

  const mismatchRegistry = createRegistry();
  const mismatchUploadCalls = [];
  const mismatchCoordinator = createLocalHostedCoordinator({
    config,
    sessionKey: createCoordinatorSessionKey({
      address: SESSION,
      rootAddress: ROOT,
      expiresAt: 1000n,
      permissionsHash,
    }),
    registry: mismatchRegistry,
    focClient: createFocClient({ uploadCalls: mismatchUploadCalls }),
    clock: () => 100n,
  });
  await assert.rejects(
    () =>
      mismatchCoordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "session_key_expiry_mismatch");
      assert.deepEqual(error.details, { maximum: "500", actual: "1000" });
      return true;
    },
  );
  assert.equal(mismatchRegistry.startCalls.length, 0);
  assert.equal(mismatchRegistry.finalizeCalls.length, 0);
  assert.equal(mismatchRegistry.failCalls.length, 0);
  assert.equal(mismatchUploadCalls.length, 0);

  const noExpiryRegistry = createRegistry();
  const noExpiryUploadCalls = [];
  const noExpiryCoordinator = createLocalHostedCoordinator({
    config,
    sessionKey: createCoordinatorSessionKey({
      address: SESSION,
      rootAddress: ROOT,
      expiresAt: 0n,
      permissionsHash,
    }),
    registry: noExpiryRegistry,
    focClient: createFocClient({ uploadCalls: noExpiryUploadCalls }),
    clock: () => 100n,
  });
  await assert.rejects(
    () =>
      noExpiryCoordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorConfigError");
      assert.equal(error.code, "session_key_expiry_mismatch");
      assert.deepEqual(error.details, { maximum: "500", actual: "0" });
      return true;
    },
  );
  assert.equal(noExpiryRegistry.startCalls.length, 0);
  assert.equal(noExpiryRegistry.finalizeCalls.length, 0);
  assert.equal(noExpiryRegistry.failCalls.length, 0);
  assert.equal(noExpiryUploadCalls.length, 0);
});

test("session-key config validates configured key and root identity", async () => {
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
  const request = requestFixture({ size: 4n });

  for (const [sessionKey, code] of [
    [
      createCoordinatorSessionKey({
        address: PAYER,
        rootAddress: ROOT,
        expiresAt: 500n,
        permissionsHash,
      }),
      "session_key_address_mismatch",
    ],
    [
      createCoordinatorSessionKey({
        address: SESSION,
        rootAddress: PAYER,
        expiresAt: 500n,
        permissionsHash,
      }),
      "session_key_root_mismatch",
    ],
  ]) {
    const registry = createRegistry();
    const uploadCalls = [];
    const coordinator = createLocalHostedCoordinator({
      config,
      sessionKey,
      registry,
      focClient: createFocClient({ uploadCalls }),
      clock: () => 100n,
    });

    await assert.rejects(
      () =>
        coordinator.executeUpload({
          objectId: 1n,
          request,
          bytes: new Uint8Array([1, 2, 3, 4]),
        }),
      (error) => {
        assert.equal(error.name, "CoordinatorConfigError");
        assert.equal(error.code, code);
        return true;
      },
    );
    assert.equal(registry.startCalls.length, 0);
    assert.equal(registry.finalizeCalls.length, 0);
    assert.equal(registry.failCalls.length, 0);
    assert.equal(uploadCalls.length, 0);
  }
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

test("receipt mapping treats zero receipt hashes as missing", () => {
  const request = requestFixture({ size: 4n, requestedCopies: 1 });
  const result = {
    actualCost: 7n,
    completedCopies: 1,
    pieceCid: "baga6ea4seaqtest",
    copies: [copyFixture()],
  };
  const fallbackReceipt = mapSynapseResultToUploadReceipt({
    payer: PAYER,
    request,
    result,
  });
  const zeroReceipt = mapSynapseResultToUploadReceipt({
    payer: PAYER,
    request,
    result: {
      ...result,
      receiptHash: ZERO_BYTES32,
    },
  });

  assert.notEqual(zeroReceipt.receiptHash, ZERO_BYTES32);
  assert.equal(zeroReceipt.receiptHash, fallbackReceipt.receiptHash);
});

test("receipt mapping rejects completed receipts without PieceCID material", () => {
  for (const [name, request, result] of [
    [
      "committed",
      requestFixture({ size: 4n, requestedCopies: 1 }),
      {
        actualCost: 7n,
        completedCopies: 1,
        copies: [copyFixture()],
      },
    ],
    [
      "partial",
      requestFixture({ size: 4n, requestedCopies: 2 }),
      {
        finalizationStatus: "Partial",
        actualCost: 7n,
        completedCopies: 1,
        copies: [copyFixture()],
      },
    ],
  ]) {
    assert.throws(
      () =>
        mapSynapseResultToUploadReceipt({
          payer: PAYER,
          request,
          result,
        }),
      (error) => {
        assert.equal(error.name, "CoordinatorReceiptError", name);
        assert.equal(error.code, "missing_piece_cid", name);
        return true;
      },
    );
  }
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

test("receipt mapping rejects over-budget actual cost before finalization", () => {
  assert.throws(
    () =>
      mapSynapseResultToUploadReceipt({
        payer: PAYER,
        request: requestFixture({ size: 4n, requestedCopies: 1 }),
        result: {
          actualCost: 11n,
          copies: [copyFixture()],
        },
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "actual_cost_exceeds_max_cost");
      assert.deepEqual(error.details, { actualCost: "11", maxCost: "10" });
      return true;
    },
  );
});

test("receipt mapping rejects over-complete copy receipts before finalization", () => {
  assert.throws(
    () =>
      mapSynapseResultToUploadReceipt({
        payer: PAYER,
        request: requestFixture({ size: 4n, requestedCopies: 1 }),
        result: {
          actualCost: 7n,
          copies: [
            copyFixture({ providerId: 111n, datasetId: 222n, pieceId: 333n }),
            copyFixture({ providerId: 112n, datasetId: 223n, pieceId: 334n }),
          ],
        },
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "completed_copies_exceed_requested");
      assert.deepEqual(error.details, { completedCopies: "2", requestedCopies: "1" });
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
  assert.throws(
    () =>
      validateUploadBytes({
        bytes,
        declaredSize: 4n,
        contentHash: ZERO_BYTES32,
        contentHashAlgorithm: "keccak256",
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "content_commitment_mismatch");
      assert.equal(error.details.contentHash, ZERO_BYTES32);
      assert.equal(error.details.contentHashAlgorithm, "keccak256");
      return true;
    },
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
  assert.deepEqual(
    validateUploadBytes({
      bytes: new Uint8Array(32),
      declaredSize: 32n,
      contentHash: ZERO_BYTES32,
      contentHashAlgorithm: "identity-bytes32",
    }),
    new Uint8Array(32),
  );
  assert.throws(
    () =>
      validateUploadBytes({
        bytes,
        declaredSize: 32n,
        contentHash: ZERO_BYTES32,
        contentHashAlgorithm: "identity-bytes32",
      }),
    (error) => {
      assert.equal(error.name, "CoordinatorReceiptError");
      assert.equal(error.code, "content_commitment_mismatch");
      assert.equal(error.details.contentHash, ZERO_BYTES32);
      assert.equal(error.details.actual, contentHash);
      assert.equal(error.details.contentHashAlgorithm, "identity-bytes32");
      return true;
    },
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

test("local hosted coordinator replays completed idempotency before session validation", async () => {
  let now = 100n;
  const permissionsHash = derivePermissionsHash({ dataset: "write", piece: "add" });
  const sessionKey = createCoordinatorSessionKey({
    address: SESSION,
    rootAddress: ROOT,
    expiresAt: 150n,
    permissionsHash,
  });
  const uploadCalls = [];
  const coordinator = createCoordinator({
    focClient: createFocClient({ uploadCalls }),
    sessionKey,
    clock: () => now,
  });
  const request = requestFixture({ size: 4n });

  const first = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  now = 200n;
  const replay = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array(),
  });

  assert.equal(replay, first);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator validates account before completed idempotency replay", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const baseReadUploadStatus = registry.readUploadStatus;
  const readCalls = [];
  registry.readUploadStatus = async function readUploadStatus(args) {
    readCalls.push(args);
    if (args.account?.accountId !== ACCOUNT_ID) {
      throw new HostedCoordinatorError("account_mismatch", "upload does not belong to account", {
        expectedAccountId: ACCOUNT_ID,
        actualAccountId: args.account?.accountId,
      });
    }
    return baseReadUploadStatus.call(this, args);
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });
  const request = requestFixture({ size: 4n });
  const account = { accountId: ACCOUNT_ID, user: ROOT };
  const otherAccount = {
    accountId: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    user: "0x0000000000000000000000000000000000004000",
  };

  const first = await coordinator.executeUpload({
    objectId: 1n,
    account,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        account: otherAccount,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "account_mismatch");
      assert.equal(error.details.actualAccountId, otherAccount.accountId);
      return true;
    },
  );

  assert.equal(first.status, "Committed");
  assert.equal(uploadCalls.length, 1);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(readCalls.length, 2);
});

test("local hosted coordinator uses request idempotency key for running uploads", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  let releaseUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((resolve) => {
    markUploadStarted = resolve;
  });
  const uploadReleased = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload(input) {
        uploadCalls.push(input);
        markUploadStarted();
        await uploadReleased;
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
    },
  });
  const request = requestFixture({ size: 4n });
  const firstUploadLevelKey =
    "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const secondUploadLevelKey =
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  const first = coordinator.executeUpload({
    objectId: 1n,
    request,
    idempotencyKey: firstUploadLevelKey,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  await uploadStarted;

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        idempotencyKey: secondUploadLevelKey,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "upload_in_progress");
      assert.equal(error.details.idempotencyKey, request.idempotencyKey);
      return true;
    },
  );

  assert.equal(uploadCalls.length, 1);
  releaseUpload();
  const result = await first;
  assert.equal(result.status, "Committed");
});

test("local hosted coordinator leaves pre-FOC start failures retryable", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const startError = new Error("registry rpc unavailable");
  startError.code = "rpc_unavailable";
  let shouldFailStart = true;
  registry.startUpload = async function startUpload(args) {
    this.startCalls.push(args);
    if (shouldFailStart) throw startError;
    this.status = "Uploading";
    return { status: this.status };
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });
  const request = requestFixture({ size: 4n });
  const input = {
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  };

  await assert.rejects(
    () => coordinator.executeUpload(input),
    (error) => {
      assert.equal(error, startError);
      return true;
    },
  );

  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);

  shouldFailStart = false;
  const retry = await coordinator.executeUpload(input);

  assert.equal(retry.status, "Committed");
  assert.equal(registry.startCalls.length, 2);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator validates registry request details before FOC upload", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  registry.readUploadStatus = async function readUploadStatus({ objectId }) {
    return {
      object: {
        objectId: String(objectId),
        status: this.status,
        size: 5n,
        requestedCopies: 2,
        maxCost: 10n,
        contentHash: ZERO_BYTES32,
      },
    };
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, requestedCopies: 2 }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "registry_request_mismatch");
      assert.deepEqual(error.details.mismatches, [
        {
          field: "size",
          registry: "5",
          request: "4",
        },
      ]);
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);
});

test("local hosted coordinator accepts registry default request expiry", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  registry.readUploadStatus = async function readUploadStatus({ objectId }) {
    return {
      object: {
        objectId: String(objectId),
        status: this.status,
        size: 4n,
        requestedCopies: 2,
        maxCost: 10n,
        requestExpiresAt: 1_000n,
        contentHash: ZERO_BYTES32,
      },
    };
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
    clock: () => 100n,
  });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request: requestFixture({ size: 4n, requestedCopies: 2 }),
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(result.status, "Committed");
  assert.equal(registry.startCalls.length, 1);
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator rejects stale content hash when registry stores zero", async () => {
  const registry = createRegistry();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const uploadCalls = [];
  registry.readUploadStatus = async function readUploadStatus({ objectId }) {
    return {
      object: {
        objectId: String(objectId),
        status: this.status,
        size: 4n,
        requestedCopies: 2,
        maxCost: 10n,
        contentHash: ZERO_BYTES32,
      },
    };
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, contentHash: CONTENT_HASH }),
        bytes,
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "registry_request_mismatch");
      assert.deepEqual(error.details.mismatches, [
        {
          field: "contentHash",
          registry: ZERO_BYTES32,
          request: CONTENT_HASH,
        },
      ]);
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);
});

test("local hosted coordinator validates request content hash when algorithm is available", async () => {
  const registry = createRegistry();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const uploadCalls = [];
  const request = requestFixture({
    size: 4n,
    contentHash: keccak256(bytes),
    contentHashAlgorithm: "keccak256",
  });
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes,
  });

  assert.equal(result.status, "Committed");
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].request.contentHashAlgorithm, "keccak256");
});

test("local hosted coordinator rejects upload-level content hash overrides", async () => {
  const registry = createRegistry();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const uploadCalls = [];
  const request = requestFixture({
    size: 4n,
    contentHash: keccak256(bytes),
    contentHashAlgorithm: "keccak256",
  });
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes,
        contentHash: "",
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "content_hash_conflict");
      return true;
    },
  );
  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes,
        contentHash: CONTENT_HASH,
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "content_hash_conflict");
      return true;
    },
  );
  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes,
        contentHashAlgorithm: "identity-bytes32",
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "content_hash_algorithm_conflict");
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);
});

test("local hosted coordinator treats stored content hash as opaque without algorithm", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const request = requestFixture({
    size: 4n,
    contentHash: CONTENT_HASH,
  });
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(result.status, "Committed");
  assert.equal(uploadCalls.length, 1);
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

test("local hosted coordinator rejects expired Uploading requests before FOC upload", async () => {
  const registry = createRegistry();
  registry.status = "Uploading";
  const uploadCalls = [];
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
    clock: () => 101n,
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, requestExpiresAt: 100n }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "request_expired");
      assert.deepEqual(error.details, {
        objectId: "1",
        requestExpiresAt: "100",
        now: "101",
      });
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);
});

test("local hosted coordinator rejects successful FOC uploads that expire before finalize", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  let now = 100n;
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload(input) {
        uploadCalls.push(input);
        now = 101n;
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
    },
    clock: () => now,
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, requestExpiresAt: 100n }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "request_expired");
      assert.deepEqual(error.details, {
        objectId: "1",
        requestExpiresAt: "100",
        now: "101",
      });
      return true;
    },
  );

  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator skips failUpload when FOC errors after expiry", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const uploadError = new Error("provider timed out");
  uploadError.code = "provider_timeout";
  let now = 100n;
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload(input) {
        uploadCalls.push(input);
        now = 101n;
        throw uploadError;
      },
    },
    clock: () => now,
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, requestExpiresAt: 100n }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "request_expired");
      assert.deepEqual(error.details, {
        objectId: "1",
        requestExpiresAt: "100",
        now: "101",
      });
      return true;
    },
  );

  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator resumes raw numeric Uploading status without replaying startUpload", async () => {
  const registry = createRegistry();
  registry.status = 2;
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

test("local hosted coordinator records over-budget FOC receipts before finalization", async () => {
  const registry = createRegistry();
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload() {
        return {
          payer: PAYER,
          actualCost: 11n,
          copies: [copyFixture()],
        };
      },
    },
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, requestedCopies: 1 }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "coordinator_upload_failed");
      assert.equal(error.details.sourceCode, "actual_cost_exceeds_max_cost");
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 1);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 1);
});

test("local hosted coordinator records over-complete FOC receipts before finalization", async () => {
  const registry = createRegistry();
  const coordinator = createCoordinator({
    registry,
    focClient: {
      async upload() {
        return {
          payer: PAYER,
          actualCost: 7n,
          copies: [
            copyFixture({ providerId: 111n, datasetId: 222n, pieceId: 333n }),
            copyFixture({ providerId: 112n, datasetId: 223n, pieceId: 334n }),
          ],
        };
      },
    },
  });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request: requestFixture({ size: 4n, requestedCopies: 1 }),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "coordinator_upload_failed");
      assert.equal(error.details.sourceCode, "completed_copies_exceed_requested");
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 1);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 1);
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

test("local hosted coordinator does not failUpload after post-FOC finalize errors", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const finalizeError = new Error("finalize tx timeout");
  finalizeError.code = "finalize_timeout";
  const finalizeUpload = registry.finalizeUpload;
  let finalizeAttempts = 0;
  registry.finalizeUpload = async function finalizeWithTransientError(args) {
    finalizeAttempts += 1;
    if (finalizeAttempts === 1) throw finalizeError;
    return finalizeUpload.call(this, args);
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
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
      assert.equal(error.code, "finalize_upload_failed");
      assert.equal(error.details.sourceCode, "finalize_timeout");
      return true;
    },
  );

  assert.equal(registry.status, "Uploading");
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);

  const retry = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(retry.status, "Committed");
  assert.equal(finalizeAttempts, 2);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator rejects expired pending-finalize retries before finalizing", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const finalizeError = new Error("finalize tx timeout");
  finalizeError.code = "finalize_timeout";
  const finalizeUpload = registry.finalizeUpload;
  let finalizeAttempts = 0;
  registry.finalizeUpload = async function finalizeWithTransientError(args) {
    finalizeAttempts += 1;
    if (finalizeAttempts === 1) throw finalizeError;
    return finalizeUpload.call(this, args);
  };
  let now = 100n;
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
    clock: () => now,
  });
  const request = requestFixture({ size: 4n, requestExpiresAt: 100n });

  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "finalize_upload_failed");
      assert.equal(error.details.sourceCode, "finalize_timeout");
      return true;
    },
  );

  now = 101n;
  await assert.rejects(
    () =>
      coordinator.executeUpload({
        objectId: 1n,
        request,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    (error) => {
      assert.equal(error.name, "HostedCoordinatorError");
      assert.equal(error.code, "request_expired");
      assert.deepEqual(error.details, {
        objectId: "1",
        requestExpiresAt: "100",
        now: "101",
      });
      return true;
    },
  );

  assert.equal(registry.status, "Uploading");
  assert.equal(finalizeAttempts, 1);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator recovers matched pending finalization before retrying finalize", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const finalizeError = new Error("finalize confirmation timeout");
  finalizeError.code = "finalize_timeout";
  const finalizeUpload = registry.finalizeUpload;
  const readUploadStatus = registry.readUploadStatus;
  let failRecoveryRead = false;
  let readFailures = 0;
  registry.readUploadStatus = async function readUploadStatusWithRecoveryFailure(args) {
    if (failRecoveryRead) {
      failRecoveryRead = false;
      readFailures += 1;
      throw new Error("registry read timeout");
    }
    return readUploadStatus.call(this, args);
  };
  registry.finalizeUpload = async function finalizeThenLoseRecoveryRead(args) {
    await finalizeUpload.call(this, args);
    failRecoveryRead = true;
    throw finalizeError;
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
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
      assert.equal(error.code, "finalize_upload_failed");
      assert.equal(error.details.sourceCode, "finalize_timeout");
      return true;
    },
  );

  const retry = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(retry.status, "Committed");
  assert.equal(retry.registry.recoveredPendingFinalize, true);
  assert.equal(registry.status, "Committed");
  assert.equal(readFailures, 1);
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator recovers ambiguous successful finalization without reuploading", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const finalizeError = new Error("finalize confirmation timeout");
  finalizeError.code = "finalize_timeout";
  const finalizeUpload = registry.finalizeUpload;
  registry.finalizeUpload = async function finalizeThenTimeout(args) {
    await finalizeUpload.call(this, args);
    throw finalizeError;
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });
  const request = requestFixture({ size: 4n });

  const result = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  const replay = await coordinator.executeUpload({
    objectId: 1n,
    request,
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  assert.equal(result.status, "Committed");
  assert.equal(result.registry.recoveredAfterFinalizeError, true);
  assert.equal(result.registry.sourceCode, "finalize_timeout");
  assert.equal(replay, result);
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
});

test("local hosted coordinator rejects ambiguous finalization with mismatched receipt", async () => {
  const registry = createRegistry();
  const uploadCalls = [];
  const finalizeError = new Error("finalize confirmation timeout");
  finalizeError.code = "finalize_timeout";
  const finalizeUpload = registry.finalizeUpload;
  registry.finalizeUpload = async function finalizeDifferentReceiptThenTimeout(args) {
    await finalizeUpload.call(this, {
      ...args,
      receipt: {
        ...args.receipt,
        receiptHash: CONTENT_HASH,
      },
    });
    throw finalizeError;
  };
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
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
      assert.equal(error.code, "finalize_upload_failed");
      assert.equal(error.details.sourceCode, "finalize_timeout");
      return true;
    },
  );

  assert.equal(registry.status, "Committed");
  assert.equal(registry.finalizeCalls.length, 1);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 1);
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

test("local hosted coordinator treats raw numeric terminal status as terminal", async () => {
  const registry = createRegistry();
  registry.status = 3;
  const uploadCalls = [];
  const coordinator = createCoordinator({
    registry,
    focClient: createFocClient({ uploadCalls }),
  });

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
      assert.equal(error.details.status, "Committed");
      return true;
    },
  );

  assert.equal(registry.startCalls.length, 0);
  assert.equal(registry.finalizeCalls.length, 0);
  assert.equal(registry.failCalls.length, 0);
  assert.equal(uploadCalls.length, 0);
});

function createCoordinator({
  registry = createRegistry(),
  focClient = createFocClient(),
  config,
  sessionKey,
  clock = () => 100n,
} = {}) {
  const permissionsHash = derivePermissionsHash({ dataset: "write", piece: "add" });
  const resolvedConfig =
    config ??
    loadCoordinatorConfig({
      FOC_COORDINATOR_MODE: "local-dev",
      FOC_COORDINATOR_RUNNER: "simulated-synapse",
      FOC_COORDINATOR_ADDRESS: SESSION,
      FOC_ROOT_ADDRESS: ROOT,
      FOC_SESSION_KEY_ADDRESS: SESSION,
      FOC_SESSION_KEY_EXPIRES_AT: "1000",
      FOC_SESSION_KEY_PERMISSIONS_HASH: permissionsHash,
    });
  const resolvedSessionKey =
    sessionKey ??
    createCoordinatorSessionKey({
      address: SESSION,
      rootAddress: ROOT,
      expiresAt: 1000n,
      permissionsHash,
    });
  return createLocalHostedCoordinator({
    config: resolvedConfig,
    registry,
    focClient,
    sessionKey: resolvedSessionKey,
    clock,
  });
}

function requestFixture({
  size = 4n,
  requestedCopies = 2,
  contentHash = undefined,
  contentHashAlgorithm = undefined,
  requestExpiresAt = undefined,
} = {}) {
  return {
    objectId: "1",
    accountId: ACCOUNT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    contentHash,
    contentHashAlgorithm,
    metadataHash: CONTENT_HASH,
    size,
    requestedCopies,
    requestExpiresAt,
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
    receipt: undefined,
    async readUploadStatus({ objectId }) {
      return {
        object: {
          objectId: String(objectId),
          status: this.status,
          ...(this.receipt
            ? {
                receiptHash: this.receipt.receiptHash,
                pieceCidHash: this.receipt.pieceCidHash,
                completedCopies: this.receipt.completedCopies,
                actualCost: this.receipt.actualCost,
              }
            : {}),
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
      this.receipt = args.receipt;
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
