import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildAdminSurfaces } from "../src/admin/reconciliation.mjs";
import {
  buildDemoEvidence,
  handleCalibrationDemoRequest,
} from "../src/worker/calibration-demo.mjs";
import { registryArtifact } from "../src/registry/read-model.mjs";

const REGISTRY = "0x7771d916a9d742B1D60597a332C7ABBd5796609c";
const ACCOUNT_ID = `0x${"12".repeat(32)}`;
const ACCOUNT_B = `0x${"34".repeat(32)}`;
const USER = "0x0000000000000000000000000000000000001000";
const PAYER = "0x0000000000000000000000000000000000002000";
const COORDINATOR = "0x000000000000000000000000000000000000abcd";
const RELAYER = "0x0000000000000000000000000000000000004000";

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
  const offlineHtml = await handleCalibrationDemoRequest(
    new Request("https://demo.example/admin?live=false"),
    { FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY },
  );
  const liveHtml = await handleCalibrationDemoRequest(
    new Request("https://demo.example/admin?live=true"),
    { FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY },
  );

  assert.equal(html.status, 200);
  const htmlBody = await html.text();
  assert.match(htmlBody, /FOC Platform Admin/);
  assert.match(htmlBody, /\/api\/admin\/files/);
  assert.match(htmlBody, /data-page-action="next"/);
  assert.match(htmlBody, /function renderCoordinatorView/);
  assert.match(htmlBody, /function combinedOffsetPagination/);
  assert.match(htmlBody, /function renderSkippedView/);
  assert.match(htmlBody, /body\.source === "skipped"/);
  assert.match(htmlBody, /summary\.warningCount === undefined/);
  assert.match(htmlBody, /const requestId = \+\+state\.requestSeq/);
  assert.match(htmlBody, /requestId !== state\.requestSeq/);
  assert.match(htmlBody, /function renderView\(body, view = state\.view\)/);
  assert.match(htmlBody, /Dashboard reads unavailable/);
  assert.match(htmlBody, /const relayerRows = body\.relayers \|\| \[\];/);
  assert.match(htmlBody, /const cursorViews = new Set\(\["files", "reconciliation"\]\);/);
  assert.match(htmlBody, /Relayers/);
  assert.match(htmlBody, /const liveReads = false;/);
  assert.match(await offlineHtml.text(), /const liveReads = false;/);
  assert.match(await liveHtml.text(), /const liveReads = true;/);

  assert.equal(evidence.status, 200);
  const evidenceBody = await evidence.json();
  assert.equal(evidenceBody.demo.objectId, "7");
  assert.equal(evidenceBody.links.registry, "https://demo.example/api/demo/registry");
  assert.equal(evidenceBody.links.dashboard.files, "https://demo.example/api/admin/files");

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

test("Worker dashboard APIs expose injected direct-read admin pages", async () => {
  let readAdminSurfacesCalls = 0;
  const dashboardAdapter = {
    ...createDashboardFixtureAdapter(),
    async readAdminSurfaces() {
      readAdminSurfacesCalls += 1;
      throw new Error("dashboard reconciliation should stay page-bounded");
    },
  };
  const env = {
    FOC_PLATFORM_REGISTRY_ADDRESS: REGISTRY,
    FOC_PLATFORM_DASHBOARD_DEFAULT_PAGE_LIMIT: "2",
  };

  const skippedOverview = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/overview"),
    env,
    { dashboardAdapter },
  );
  const skippedFiles = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/files"),
    env,
    { dashboardAdapter },
  );
  const overview = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/overview?live=true"),
    env,
    { dashboardAdapter },
  );
  const upgradedOverview = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/overview"),
    {
      ...env,
      FOC_PLATFORM_REGISTRY_RUNTIME_SHA256: registryArtifact.deployedBytecodeSha256,
    },
    { dashboardAdapter },
  );
  const upgradedBareHexOverview = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/overview"),
    {
      ...env,
      FOC_PLATFORM_REGISTRY_RUNTIME_SHA256: registryArtifact.deployedBytecodeSha256.replace(
        /^0x/i,
        "",
      ),
    },
    { dashboardAdapter },
  );
  const files = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/files?live=true&status=Committed&q=0000"),
    env,
    { dashboardAdapter },
  );
  const accounts = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/accounts?live=true"),
    env,
    { dashboardAdapter },
  );
  const datasets = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/datasets?live=true&provider=111"),
    env,
    { dashboardAdapter },
  );
  const coordinators = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/coordinators?live=true"),
    env,
    { dashboardAdapter },
  );
  const uppercaseCoordinatorFilter = await handleCalibrationDemoRequest(
    new Request(
      "https://demo.example/api/admin/coordinators?live=true&coordinator=0x000000000000000000000000000000000000ABCD",
    ),
    env,
    { dashboardAdapter },
  );
  const reconciliation = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/reconciliation?live=true"),
    env,
    { dashboardAdapter },
  );

  assert.equal(skippedOverview.status, 200);
  const skippedOverviewBody = await skippedOverview.json();
  assert.equal(skippedOverviewBody.source, "skipped");
  assert.equal(skippedOverviewBody.metadata.dashboardLiveDefault, false);
  assert.equal(skippedFiles.status, 200);
  const skippedFilesBody = await skippedFiles.json();
  assert.equal(skippedFilesBody.source, "skipped");
  assert.equal("files" in skippedFilesBody, false);

  assert.equal(overview.status, 200);
  const overviewBody = await overview.json();
  assert.equal(overviewBody.summary.mode, "contractCounts");
  assert.equal(overviewBody.summary.objectCount, 2);
  assert.equal(overviewBody.summary.providerCount, null);
  assert.equal(overviewBody.metadata.dashboardLiveDefault, false);

  assert.equal(upgradedOverview.status, 200);
  const upgradedOverviewBody = await upgradedOverview.json();
  assert.equal(upgradedOverviewBody.summary.objectCount, 2);
  assert.equal(upgradedOverviewBody.metadata.dashboardLiveDefault, true);
  assert.equal(upgradedBareHexOverview.status, 200);
  const upgradedBareHexOverviewBody = await upgradedBareHexOverview.json();
  assert.equal(upgradedBareHexOverviewBody.summary.objectCount, 2);
  assert.equal(upgradedBareHexOverviewBody.metadata.dashboardLiveDefault, true);

  assert.equal(files.status, 200);
  const filesBody = await files.json();
  assert.equal(filesBody.metadata.sourceOfTruth, "FocPlatformRegistryDirectReads");
  assert.deepEqual(filesBody.ids, ["2", "1"]);
  assert.deepEqual(filesBody.files.map((row) => row.objectId), ["1"]);
  assert.equal("issues" in filesBody.files[0], false);
  assert.equal("reconciliationStatus" in filesBody.files[0], false);
  assert.equal(filesBody.pagination.mode, "objectIdCursor");
  assert.equal(filesBody.pagination.hasNextPage, true);
  assert.equal(filesBody.pagination.nextCursorIdExclusive, "1");
  assert.doesNotThrow(() => JSON.stringify(filesBody));

  assert.equal(accounts.status, 200);
  const accountsBody = await accounts.json();
  assert.equal(accountsBody.accounts[0].accountId, ACCOUNT_ID);
  assert.deepEqual(accountsBody.accounts[0].objectIds, ["1"]);

  assert.equal(datasets.status, 200);
  const datasetsBody = await datasets.json();
  assert.equal(datasetsBody.datasets[0].providerId, "111");

  assert.equal(coordinators.status, 200);
  const coordinatorBody = await coordinators.json();
  assert.equal(coordinatorBody.coordinators[0].coordinator, COORDINATOR);
  assert.equal(coordinatorBody.relayers[0].relayer, RELAYER);
  assert.equal(uppercaseCoordinatorFilter.status, 200);
  assert.deepEqual((await uppercaseCoordinatorFilter.json()).coordinators.map((row) => row.coordinator), [
    COORDINATOR,
  ]);

  assert.equal(reconciliation.status, 200);
  const reconciliationBody = await reconciliation.json();
  assert.equal(reconciliationBody.reconciliation.status, "pending_external_evidence");
  assert.equal(reconciliationBody.reconciliation.scope, "object_page");
  assert.deepEqual(reconciliationBody.reconciliation.objectIds, ["2", "1"]);
  assert.deepEqual(reconciliationBody.ids, ["2", "1"]);
  assert.equal(reconciliationBody.pagination.mode, "objectIdCursor");
  assert.equal(reconciliationBody.pagination.hasNextPage, true);
  assert.ok(reconciliationBody.reconciliation.omittedCheckFamilies.includes("account_usage"));
  assert.equal(
    reconciliationBody.reconciliation.checks.some((check) =>
      reconciliationBody.reconciliation.omittedCheckCodes.includes(check.code),
    ),
    false,
  );
  assert.equal(readAdminSurfacesCalls, 0);
});

test("Worker rejects unsupported methods and unknown routes", async () => {
  const post = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/demo/evidence", { method: "POST" }),
  );
  const missing = await handleCalibrationDemoRequest(new Request("https://demo.example/nope"));
  const missingAdmin = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/nope"),
    {},
    { dashboardAdapter: createDashboardFixtureAdapter() },
  );
  const missingOfflineAdmin = await handleCalibrationDemoRequest(
    new Request("https://demo.example/api/admin/nope?live=false"),
  );

  assert.equal(post.status, 405);
  assert.equal((await post.json()).error.code, "method_not_allowed");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
  assert.equal(missingAdmin.status, 404);
  assert.equal((await missingAdmin.json()).error.code, "not_found");
  assert.equal(missingOfflineAdmin.status, 404);
  assert.equal((await missingOfflineAdmin.json()).error.code, "not_found");
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
  assert.doesNotThrow(() =>
    runner.validateCalibrationEvidenceBeforeMutation({
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
  assert.throws(
    () =>
      runner.validateCalibrationEvidenceBeforeMutation({
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
    /refusing to mutate registry: .*copyReceipts\[0\]\.retrievalUrlHash/,
  );
  assert.throws(
    () =>
      runner.validateCalibrationEvidenceBeforeMutation({
        config,
        objectId,
        finalObject,
        copyReceipts,
        receiptPayer: user,
        dataset: { ...dataset, storageClass: `0x${"03".repeat(32)}` },
      }),
    /refusing to mutate registry: .*dataset\.storageClass/,
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

function createDashboardFixtureAdapter() {
  const model = dashboardFixtureModel();
  return {
    async readOverviewCounts() {
      return {
        objectCount: Object.keys(model.objects).length,
        accountCount: Object.keys(model.usage).length,
        datasetCount: Object.keys(model.datasets).length,
        coordinatorCount: Object.keys(model.coordinators).length,
        relayerCount: Object.keys(model.relayers).length,
      };
    },
    async readAdminSurfaces(options = {}) {
      return buildAdminSurfaces({ model }, { now: options.now ?? 1_000 });
    },
    async readObjectPage({ cursorIdExclusive = 0n, limit = 2n } = {}) {
      const ids = cursorIds(["2", "1"], cursorIdExclusive, limit);
      return {
        sourceOfTruth: "FocPlatformRegistryDirectReads",
        pagination: {
          mode: "objectIdCursor",
          cursorIdExclusive: String(cursorIdExclusive),
          nextCursorIdExclusive: ids.at(-1) ?? String(cursorIdExclusive),
          limit: String(limit),
          includeTerminal: true,
        },
        ids,
        objects: ids.map((objectId) => ({
          objectId,
          object: model.objects[objectId],
          copyReceipts: model.copyReceipts[objectId] ?? [],
          receiptPayer: model.receiptPayers[objectId],
        })),
      };
    },
    async readAccountPage({ offset = 0n, limit = 2n } = {}) {
      const accountIds = offsetRows([ACCOUNT_ID, ACCOUNT_B], offset, limit);
      return {
        sourceOfTruth: "FocPlatformRegistryDirectReads",
        pagination: {
          mode: "offset",
          offset: String(offset),
          nextOffset: String(BigInt(offset) + BigInt(accountIds.length)),
          limit: String(limit),
        },
        accountIds,
        accounts: accountIds.map((accountId) => ({
          accountId,
          usage: model.usage[accountId],
          objectIds: Object.values(model.objects)
            .filter((object) => object.accountId === accountId)
            .map((object) => object.objectId),
          objectPagination: {
            mode: "objectIdCursor",
            cursorIdExclusive: "0",
            nextCursorIdExclusive: "0",
            limit: String(limit),
            includeTerminal: true,
          },
        })),
      };
    },
    async readDatasetPage({ offset = 0n, limit = 2n } = {}) {
      const datasets = offsetRows(
        Object.entries(model.datasets).map(([key, dataset]) => ({ key, dataset })),
        offset,
        limit,
      );
      return {
        sourceOfTruth: "FocPlatformRegistryDirectReads",
        pagination: {
          mode: "offset",
          offset: String(offset),
          nextOffset: String(BigInt(offset) + BigInt(datasets.length)),
          limit: String(limit),
        },
        keys: datasets.map((row) => row.key),
        datasets,
      };
    },
    async readCoordinatorPage({ offset = 0n, limit = 2n } = {}) {
      const coordinators = offsetRows(
        Object.entries(model.coordinators).map(([coordinator, policy]) => ({
          coordinator,
          policy,
        })),
        offset,
        limit,
      );
      return {
        sourceOfTruth: "FocPlatformRegistryDirectReads",
        pagination: {
          mode: "offset",
          offset: String(offset),
          nextOffset: String(BigInt(offset) + BigInt(coordinators.length)),
          limit: String(limit),
        },
        addresses: coordinators.map((row) => row.coordinator),
        coordinators,
      };
    },
    async readRelayerPage({ offset = 0n, limit = 2n } = {}) {
      const relayers = offsetRows(
        Object.entries(model.relayers).map(([relayer, allowed]) => ({
          relayer,
          allowed,
        })),
        offset,
        limit,
      );
      return {
        sourceOfTruth: "FocPlatformRegistryDirectReads",
        pagination: {
          mode: "offset",
          offset: String(offset),
          nextOffset: String(BigInt(offset) + BigInt(relayers.length)),
          limit: String(limit),
        },
        addresses: relayers.map((row) => row.relayer),
        relayers,
      };
    },
  };
}

function cursorIds(ids, cursorIdExclusive, limit) {
  const cursor = BigInt(cursorIdExclusive);
  return ids
    .filter((id) => cursor === 0n || BigInt(id) < cursor)
    .slice(0, Number(limit));
}

function offsetRows(rows, offset, limit) {
  return rows.slice(Number(offset), Number(offset) + Number(limit));
}

function dashboardFixtureModel() {
  return {
    objects: {
      1: {
        objectId: "1",
        accountId: ACCOUNT_ID,
        user: USER,
        idempotencyKey: hex32("01"),
        contentHash: hex32("02"),
        metadataHash: hex32("03"),
        pieceCidHash: hex32("04"),
        size: 1024n,
        requestedCopies: 1,
        completedCopies: 1,
        withCDN: true,
        maxCost: "10",
        reservedCost: "0",
        actualCost: "7",
        status: "Committed",
        coordinator: COORDINATOR,
        requestExpiresAt: "2000",
        createdAt: 100n,
        updatedAt: 120n,
        receiptHash: hex32("05"),
      },
      2: {
        objectId: "2",
        accountId: ACCOUNT_B,
        user: USER,
        idempotencyKey: hex32("06"),
        contentHash: hex32("07"),
        metadataHash: hex32("08"),
        pieceCidHash: hex32("09"),
        size: 512n,
        requestedCopies: 2,
        completedCopies: 0,
        withCDN: false,
        maxCost: "20",
        reservedCost: "20",
        actualCost: "0",
        status: "Uploading",
        coordinator: COORDINATOR,
        requestExpiresAt: "2000",
        createdAt: 110n,
        updatedAt: 115n,
        receiptHash: hex32("00"),
      },
    },
    usage: {
      [ACCOUNT_ID]: {
        activeBytes: "1024",
        activeObjects: "1",
        pendingBytes: "0",
        reservedCost: "0",
        totalActualCost: "7",
        totalUploadedBytes: "1024",
        totalRequestedUploads: "1",
        totalFinalizedUploads: "1",
        totalFailedUploads: "0",
      },
      [ACCOUNT_B]: {
        activeBytes: "0",
        activeObjects: "0",
        pendingBytes: "1024",
        reservedCost: "20",
        totalActualCost: "0",
        totalUploadedBytes: "0",
        totalRequestedUploads: "1",
        totalFinalizedUploads: "0",
        totalFailedUploads: "0",
      },
    },
    copyReceipts: {
      1: [
        {
          providerId: "111",
          datasetId: "222",
          pieceId: "333",
          addPieceTxHash: hex32("0a"),
          retrievalUrlHash: hex32("0b"),
          isNewDataSet: true,
        },
      ],
      2: [],
    },
    receiptPayers: {
      1: PAYER,
      2: PAYER,
    },
    datasets: {
      [`${ACCOUNT_ID}:111:222`]: {
        accountId: ACCOUNT_ID,
        payer: PAYER,
        providerId: "111",
        datasetId: "222",
        storageClass: hex32("0c"),
        withCDN: true,
        createdAt: "100",
        updatedAt: "120",
      },
    },
    coordinators: {
      [COORDINATOR]: {
        allowed: true,
        maxFinalizeDelay: "3600",
        sessionKeyExpiresAt: "9999999999",
        permissionsHash: hex32("0d"),
      },
    },
    relayers: {
      [RELAYER]: true,
    },
    idempotency: {},
  };
}

function hex32(suffix) {
  return `0x${String(suffix).padStart(64, "0")}`;
}
