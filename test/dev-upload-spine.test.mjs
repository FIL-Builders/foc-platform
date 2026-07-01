import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

import {
  DEV_UPLOAD_SPINE_FIXTURE,
  runDevUploadSpine,
} from "../src/dev/upload-spine.mjs";

test("dev upload spine requests, finalizes, and reads a deterministic mocked receipt", {
  timeout: 90_000,
}, async (t) => {
  const anvil = await startAnvil(t);
  const result = await runDevUploadSpine({ rpcUrl: anvil.rpcUrl });

  assert.match(result.registryAddress, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(result.chainId, "31337");
  assert.equal(result.objectId, "1");
  assert.equal(result.mocked.focBytesMoved, false);

  assert.equal(result.request.accountId, DEV_UPLOAD_SPINE_FIXTURE.accountId);
  assert.equal(result.request.idempotencyKey, DEV_UPLOAD_SPINE_FIXTURE.idempotencyKey);
  assert.equal(result.receipt.receiptHash, DEV_UPLOAD_SPINE_FIXTURE.receiptHash);
  assert.equal(result.receipt.copies.length, 2);

  assert.equal(result.reads.object.status, "Committed");
  assert.equal(result.reads.object.size, DEV_UPLOAD_SPINE_FIXTURE.size.toString());
  assert.equal(result.reads.object.requestedCopies, DEV_UPLOAD_SPINE_FIXTURE.requestedCopies);
  assert.equal(result.reads.object.completedCopies, 2);
  assert.equal(result.reads.object.reservedCost, DEV_UPLOAD_SPINE_FIXTURE.maxCost.toString());
  assert.equal(result.reads.object.actualCost, DEV_UPLOAD_SPINE_FIXTURE.actualCost.toString());
  assert.equal(result.reads.object.receiptHash, DEV_UPLOAD_SPINE_FIXTURE.receiptHash);
  assert.equal(result.reads.object.pieceCidHash, DEV_UPLOAD_SPINE_FIXTURE.pieceCidHash);

  assert.equal(result.reads.usage.activeBytes, "4096");
  assert.equal(result.reads.usage.activeObjects, "1");
  assert.equal(result.reads.usage.pendingBytes, "0");
  assert.equal(result.reads.usage.reservedCost, "0");
  assert.equal(result.reads.usage.totalActualCost, DEV_UPLOAD_SPINE_FIXTURE.actualCost.toString());
  assert.equal(result.reads.usage.totalUploadedBytes, "4096");
  assert.equal(result.reads.usage.totalRequestedUploads, "1");
  assert.equal(result.reads.usage.totalFinalizedUploads, "1");
  assert.equal(result.reads.usage.totalFailedUploads, "0");

  assert.equal(result.reads.receiptPayer, result.roles.platformRoot);
  assert.deepEqual(result.reads.copyReceipts, [
    {
      providerId: "111",
      datasetId: "222",
      pieceId: "333",
      addPieceTxHash: DEV_UPLOAD_SPINE_FIXTURE.copies[0].addPieceTxHash,
      retrievalUrlHash: DEV_UPLOAD_SPINE_FIXTURE.copies[0].retrievalUrlHash,
      isNewDataSet: true,
    },
    {
      providerId: "112",
      datasetId: "223",
      pieceId: "334",
      addPieceTxHash: DEV_UPLOAD_SPINE_FIXTURE.copies[1].addPieceTxHash,
      retrievalUrlHash: DEV_UPLOAD_SPINE_FIXTURE.copies[1].retrievalUrlHash,
      isNewDataSet: false,
    },
  ]);

  assert.equal(result.projection.object.status, "Committed");
  assert.equal(result.projection.object.receiptHash, DEV_UPLOAD_SPINE_FIXTURE.receiptHash);
  assert.equal(result.projection.usage.activeBytes, result.reads.usage.activeBytes);
  assert.equal(result.projection.usage.pendingBytes, result.reads.usage.pendingBytes);
  assert.equal(result.projection.copyReceipts.length, 2);
  assert.equal(result.projection.receiptPayer, result.roles.platformRoot);

  assert.equal(result.demoStatus.status, "Committed");
  assert.equal(result.demoStatus.payer, result.roles.platformRoot);
  assert.equal(
    result.demoStatus.tokenHostBinding.stableFixtureFields.receiptHash,
    result.receipt.receiptHash,
  );
  assert.deepEqual(result.demoStatus.tokenHostBinding.contractReads, [
    "getStorageObject",
    "getAccountUsage",
    "getCopyReceipts",
    "receiptPayer",
  ]);

  const eventNames = result.events.map((event) => event.eventName);
  for (const eventName of [
    "RelayerUpdated",
    "CoordinatorUpdated",
    "UsageReserved",
    "UploadRequested",
    "UploadStarted",
    "CopyRecorded",
    "UsageReleased",
    "UsageFinalized",
    "ReceiptPayerRecorded",
    "UploadFinalized",
  ]) {
    assert.ok(eventNames.includes(eventName), `missing event ${eventName}`);
  }
});

async function startAnvil(t) {
  const port = await getFreePort();
  const proc = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--accounts", "4", "--balance", "1000"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    output += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    output += chunk;
  });

  t.after(() => {
    if (!proc.killed) proc.kill("SIGTERM");
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`anvil did not start on port ${port}\n${output}`));
    }, 15_000);

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`anvil exited before readiness: code=${code} signal=${signal}\n${output}`));
    });
    proc.stdout.on("data", (chunk) => {
      if (chunk.includes("Listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  return { rpcUrl: `http://127.0.0.1:${port}` };
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
