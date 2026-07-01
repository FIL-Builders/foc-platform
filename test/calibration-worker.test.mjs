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
