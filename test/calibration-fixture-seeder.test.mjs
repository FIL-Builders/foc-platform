import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { main } from "../scripts/seed-calibration-registry-fixtures.mjs";

test("Calibration fixture seeder help documents retry-safe defaults", async () => {
  const lines = [];
  const result = await main({
    argv: ["node", "scripts/seed-calibration-registry-fixtures.mjs", "--help"],
    stdout: (line) => lines.push(line),
  });

  assert.equal(result, null);
  const help = lines.join("\n");
  assert.match(help, /FOC_PLATFORM_FIXTURE_RECEIPT_TIMEOUT_MS\s+defaults to 600000/);
  assert.match(help, /--batch-size <n>\s+transactions to send before waiting, default 4/);
});

test("Calibration fixture seeder keeps replacement-aware receipt polling", async () => {
  const source = await readFile(new URL("../scripts/seed-calibration-registry-fixtures.mjs", import.meta.url), "utf8");

  assert.match(source, /publicClient\.waitForTransactionReceipt/);
  assert.match(source, /pollingInterval: RECEIPT_POLL_INTERVAL_MS/);
  assert.doesNotMatch(source, /publicClient\.getTransactionReceipt\(\{ hash \}\)/);
});

test("Calibration fixture seed summary includes retry-tuned schema fields", async () => {
  const summary = JSON.parse(
    await readFile(new URL("../artifacts/calibration/fixture-seed-summary.json", import.meta.url), "utf8"),
  );

  assert.equal(summary.receiptTimeoutMs, 600_000);
  assert.equal(summary.batchSize, 4);
  assert.equal(summary.observedFixtures?.committed, 48);
  assert.equal(summary.observedFixtures?.uploading, 0);
  assert.equal(summary.observedFixtures?.requested, 0);
});
