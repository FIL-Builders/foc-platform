import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDemoEvidence,
  handleCalibrationDemoRequest,
} from "../src/worker/calibration-demo.mjs";

const REGISTRY = "0x7771d916a9d742B1D60597a332C7ABBd5796609c";
const ACCOUNT_ID = `0x${"12".repeat(32)}`;

test("Worker evidence builder keeps privileged credentials out of public state", () => {
  const evidence = buildDemoEvidence({
    FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY,
    FOC_PLATFORM_DEMO_OBJECT_ID: "42",
    FOC_PLATFORM_DEMO_ACCOUNT_ID: ACCOUNT_ID,
    FOC_PLATFORM_DEMO_PIECE_CID: "baga-demo",
    FOC_PLATFORM_DEMO_REGISTRY_TX_HASHES_JSON: '{"request":"0xabc"}',
    PRIVATE_KEY: "0xshould-not-be-used",
  });

  assert.equal(evidence.registry.address, REGISTRY);
  assert.equal(evidence.demo.status, "configured_live_object");
  assert.equal(evidence.demo.objectId, "42");
  assert.equal(evidence.demo.accountId, ACCOUNT_ID);
  assert.equal(evidence.demo.registryTxHashes.request, "0xabc");
  assert.equal(buildDemoEvidence({ FOC_PLATFORM_DEMO_CHAIN_ID: "not-a-number" }).chainId, 314159);
  assert.equal(evidence.worker.privilegedActions, false);
  assert.equal(JSON.stringify(evidence).includes("should-not-be-used"), false);
});

test("Worker serves HTML and public evidence endpoints", async () => {
  const html = await handleCalibrationDemoRequest(
    new Request("https://demo.example/"),
    {
      FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY,
      FOC_PLATFORM_DEMO_OBJECT_ID: "7",
      FOC_PLATFORM_DEMO_PIECE_CID: "baga-demo-piece",
    },
  );
  const evidence = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/demo/evidence"),
    {
      FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY,
      FOC_PLATFORM_DEMO_OBJECT_ID: "7",
    },
  );
  const health = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/health"),
    { FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY },
  );

  assert.equal(html.status, 200);
  assert.match(await html.text(), /FOC Platform Calibration Demo/);

  assert.equal(evidence.status, 200);
  const evidenceBody = await evidence.json();
  assert.equal(evidenceBody.demo.objectId, "7");
  assert.equal(evidenceBody.links.registry, "https://demo.example/api/demo/registry");

  assert.equal(health.status, 200);
  assert.equal((await health.json()).privilegedActions, false);
});

test("Worker registry endpoint accepts injected public read snapshot", async () => {
  const response = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/demo/registry"),
    {
      FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY,
      FOC_PLATFORM_DEMO_OBJECT_ID: "7",
      FOC_PLATFORM_DEMO_ACCOUNT_ID: ACCOUNT_ID,
    },
    {
      readRegistrySnapshot: async (evidence) => ({
        checkedAt: "2026-07-01T00:00:00.000Z",
        owner: "0xF00DCE36817586672B47480FB48C94177A97278B",
        nextObjectId: "8",
        object: {
          objectId: evidence.demo.objectId,
          statusLabel: "Committed",
        },
      }),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "filecoin_calibration_public_rpc");
  assert.equal(body.registry.object.statusLabel, "Committed");
});

test("Worker rejects unsupported methods and unknown routes", async () => {
  const post = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/demo/evidence", { method: "POST" }),
  );
  const missing = await handleCalibrationDemoRequest(new Request("https://demo.example/nope"));

  assert.equal(post.status, 405);
  assert.equal((await post.json()).error.code, "method_not_allowed");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
});

test("Committed Worker config and evidence artifact do not contain private keys", async () => {
  const wrangler = await readFile("wrangler.jsonc", "utf8");
  const evidence = await readFile("artifacts/calibration/demo-evidence.json", "utf8");

  assert.equal(/PRIVATE_KEY|SECRET|WALLET_SEED/.test(wrangler), false);
  assert.equal(/privateKey|walletSeed/.test(evidence), false);
});

test("Calibration registry runner is safe to import", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?test=${Date.now()}`);

  assert.equal(typeof runner.runCalibrationRegistryDemo, "function");
  assert.equal(typeof runner.main, "function");
});

test("Calibration registry runner honors documented upload tx hash env", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?hash=${Date.now()}`);
  const txHash = `0x${"ab".repeat(32)}`;

  assert.deepEqual(runner.normalizeDemoUploadTxHash({ FOC_PLATFORM_DEMO_UPLOAD_TX_HASH: txHash }), {
    uploadTxHash: txHash,
    addPieceTxHash: txHash,
  });
  assert.deepEqual(
    runner.normalizeDemoUploadTxHash({
      FOC_PLATFORM_DEMO_UPLOAD_TX_HASH: " ",
      FOC_PLATFORM_DEMO_ADD_PIECE_TX_HASH: txHash,
    }),
    {
      uploadTxHash: txHash,
      addPieceTxHash: txHash,
    },
  );
  assert.equal(runner.normalizeDemoUploadTxHash({}).uploadTxHash, null);
});

test("Calibration registry runner refreshes expired coordinator policies", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?policy=${Date.now()}`);
  const zeroBytes32 = `0x${"00".repeat(32)}`;

  assert.equal(
    runner.shouldRefreshDemoCoordinatorPolicy({
      allowed: true,
      maxFinalizeDelay: 86_400n,
      sessionKeyExpiresAt: 1n,
      permissionsHash: zeroBytes32,
    }),
    true,
  );
  assert.equal(
    runner.shouldRefreshDemoCoordinatorPolicy({
      allowed: true,
      maxFinalizeDelay: 86_400n,
      sessionKeyExpiresAt: 0n,
      permissionsHash: zeroBytes32,
    }),
    false,
  );
});

test("Calibration registry runner treats blank demo ID env vars as unset", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?ids=${Date.now()}`);

  assert.deepEqual(
    runner.normalizeDemoIds({
      FOC_PLATFORM_DEMO_PROVIDER_ID: " ",
      FOC_PLATFORM_DEMO_DATASET_ID: "",
      FOC_PLATFORM_DEMO_PIECE_ID: undefined,
    }),
    {
      providerId: "4",
      datasetId: "12524",
      pieceId: "34",
    },
  );
  assert.deepEqual(
    runner.normalizeDemoIds({
      FOC_PLATFORM_DEMO_PROVIDER_ID: " 5 ",
      FOC_PLATFORM_DEMO_DATASET_ID: " 12525 ",
      FOC_PLATFORM_DEMO_PIECE_ID: " 35 ",
    }),
    {
      providerId: "5",
      datasetId: "12525",
      pieceId: "35",
    },
  );
});

test("Calibration registry runner preserves prior transaction hashes on rerun", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?tx=${Date.now()}`);
  const idempotencyKey = `0x${"66".repeat(32)}`;
  const evidence = {
    network: "filecoin_calibration",
    chainId: 314159,
    registry: {
      address: REGISTRY,
    },
    demo: {
      objectId: "42",
      accountId: ACCOUNT_ID,
      request: { idempotencyKey },
      registryTxHashes: {
        requestUpload: `0x${"11".repeat(32)}`,
        startUpload: `0x${"22".repeat(32)}`,
        finalizeUpload: `0x${"33".repeat(32)}`,
      },
    },
  };

  assert.deepEqual(
    runner.mergeRegistryTxHashes(
      runner.reusableRegistryTxHashesFromEvidence(evidence, {
        registryAddress: REGISTRY,
        network: "filecoin_calibration",
        chainId: 314159,
        objectId: 42n,
        accountId: ACCOUNT_ID,
        idempotencyKey,
      }),
      {
        recordDataset: `0x${"44".repeat(32)}`,
        finalizeUpload: `0x${"55".repeat(32)}`,
      },
    ),
    {
      requestUpload: `0x${"11".repeat(32)}`,
      startUpload: `0x${"22".repeat(32)}`,
      recordDataset: `0x${"44".repeat(32)}`,
      finalizeUpload: `0x${"55".repeat(32)}`,
    },
  );

  assert.deepEqual(
    runner.reusableRegistryTxHashesFromEvidence(evidence, {
      registryAddress: REGISTRY,
      network: "filecoin_calibration",
      chainId: 314159,
      objectId: 43n,
      accountId: ACCOUNT_ID,
      idempotencyKey,
    }),
    {},
  );
  assert.deepEqual(
    runner.reusableRegistryTxHashesFromEvidence(evidence, {
      registryAddress: REGISTRY,
      network: "filecoin_calibration",
      chainId: 314159,
      objectId: 42n,
      accountId: `0x${"34".repeat(32)}`,
      idempotencyKey,
    }),
    {},
  );
  assert.deepEqual(
    runner.reusableRegistryTxHashesFromEvidence(evidence, {
      registryAddress: REGISTRY,
      network: "filecoin_calibration",
      chainId: 314159,
      objectId: 42n,
      accountId: ACCOUNT_ID,
      idempotencyKey: `0x${"77".repeat(32)}`,
    }),
    {},
  );
  assert.deepEqual(
    runner.reusableRegistryTxHashesFromEvidence(evidence, {
      registryAddress: "0x1111111111111111111111111111111111111111",
      network: "filecoin_calibration",
      chainId: 314159,
      objectId: 42n,
      accountId: ACCOUNT_ID,
      idempotencyKey,
    }),
    {},
  );
  assert.deepEqual(
    runner.reusableRegistryTxHashesFromEvidence(evidence, {
      registryAddress: REGISTRY,
      network: "filecoin_calibration",
      chainId: 314160,
      objectId: 42n,
      accountId: ACCOUNT_ID,
      idempotencyKey,
    }),
    {},
  );
});

test("Calibration registry runner validates config evidence against onchain reads", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?validate=${Date.now()}`);
  const objectId = 42n;
  const user = "0x0000000000000000000000000000000000001234";
  const idempotencyKey = `0x${"66".repeat(32)}`;
  const contentHash = `0x${"aa".repeat(32)}`;
  const metadataHash = `0x${"bb".repeat(32)}`;
  const pieceCidHash = `0x${"cc".repeat(32)}`;
  const receiptHash = `0x${"dd".repeat(32)}`;
  const addPieceTxHash = `0x${"ee".repeat(32)}`;
  const retrievalUrlHash = `0x${"ff".repeat(32)}`;
  const storageClass = `0x${"10".repeat(32)}`;
  const config = {
    accountId: ACCOUNT_ID,
    providerId: "4",
    datasetId: "12524",
    storageClass,
    requestParams: {
      user,
      idempotencyKey,
      contentHash,
      metadataHash,
      size: 123n,
      requestedCopies: 1,
      withCDN: false,
      maxCost: 1000n,
    },
    receipt: {
      payer: user,
      pieceCidHash,
      completedCopies: 1,
      actualCost: 0n,
      receiptHash,
      copies: [
        {
          providerId: 4n,
          datasetId: 12524n,
          pieceId: 34n,
          addPieceTxHash,
          retrievalUrlHash,
          isNewDataSet: false,
        },
      ],
    },
  };
  const finalObject = {
    objectId,
    accountId: ACCOUNT_ID,
    user,
    idempotencyKey,
    contentHash,
    metadataHash,
    pieceCidHash,
    size: 123n,
    requestedCopies: 1,
    completedCopies: 1,
    withCDN: false,
    maxCost: 1000n,
    actualCost: 0n,
    receiptHash,
  };
  const copyReceipts = [
    {
      providerId: 4n,
      datasetId: 12524n,
      pieceId: 34n,
      addPieceTxHash,
      retrievalUrlHash,
      isNewDataSet: false,
    },
  ];
  const dataset = {
    accountId: ACCOUNT_ID,
    payer: user,
    providerId: 4n,
    datasetId: 12524n,
    storageClass,
    withCDN: false,
  };

  assert.doesNotThrow(() =>
    runner.validateCalibrationEvidenceInputs({
      config,
      objectId,
      finalObject,
      copyReceipts,
      receiptPayer: user,
      dataset,
    }),
  );
  assert.throws(
    () =>
      runner.validateCalibrationEvidenceInputs({
        config,
        objectId,
        finalObject: { ...finalObject, contentHash: `0x${"01".repeat(32)}` },
        copyReceipts,
        receiptPayer: user,
        dataset,
      }),
    /object\.contentHash/,
  );
  assert.throws(
    () =>
      runner.validateCalibrationEvidenceInputs({
        config,
        objectId,
        finalObject,
        copyReceipts: [
          {
            ...copyReceipts[0],
            retrievalUrlHash: `0x${"02".repeat(32)}`,
          },
        ],
        receiptPayer: user,
        dataset,
      }),
    /copyReceipts\[0\]\.retrievalUrlHash/,
  );
});

test("Calibration registry runner rejects stale request config before mutation", async () => {
  const runner = await import(`../scripts/run-calibration-registry-demo.mjs?request=${Date.now()}`);
  const objectId = 42n;
  const user = "0x0000000000000000000000000000000000001234";
  const idempotencyKey = `0x${"66".repeat(32)}`;
  const config = {
    accountId: ACCOUNT_ID,
    requestParams: {
      user,
      idempotencyKey,
      contentHash: `0x${"aa".repeat(32)}`,
      metadataHash: `0x${"bb".repeat(32)}`,
      size: 123n,
      requestedCopies: 1,
      withCDN: false,
      maxCost: 1000n,
    },
  };
  const object = {
    objectId,
    accountId: ACCOUNT_ID,
    user,
    idempotencyKey,
    contentHash: config.requestParams.contentHash,
    metadataHash: config.requestParams.metadataHash,
    size: 123n,
    requestedCopies: 1,
    withCDN: false,
    maxCost: 1000n,
  };

  assert.doesNotThrow(() =>
    runner.validateStorageObjectRequestInputs({
      config,
      objectId,
      object,
    }),
  );
  assert.throws(
    () =>
      runner.validateStorageObjectRequestInputs({
        config,
        objectId,
        object: { ...object, metadataHash: `0x${"01".repeat(32)}` },
      }),
    /refusing to mutate registry: .*object\.metadataHash/,
  );
});
