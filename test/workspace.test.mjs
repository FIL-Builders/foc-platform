import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package scripts expose the baseline workspace commands", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.match(pkg.scripts.lint, /check-workspace/);
  assert.match(pkg.scripts["build:artifacts"], /generate-registry-artifacts/);
  assert.match(pkg.scripts["build:tokenhost"], /tokenhost-wrapper/);
  assert.match(pkg.scripts["test:api"], /platform-api/);
  assert.match(pkg.scripts["test:contracts"], /forge test/);
  assert.match(pkg.scripts["test:spine"], /dev-upload-spine/);
  assert.match(pkg.scripts["test:tokenhost"], /tokenhost-demo/);
});

test("environment example documents secret placeholders without committing secrets", async () => {
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");

  assert.match(env, /FILECOIN_CALIBRATION_RPC_URL=/);
  assert.match(env, /PLATFORM_ROOT_PRIVATE_KEY=/);
  assert.doesNotMatch(env, /PRIVATE_KEY=0x[0-9a-fA-F]{64}/);
});
