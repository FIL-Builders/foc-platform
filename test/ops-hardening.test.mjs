import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { OpsConfigError, validateOpsConfig } from "../scripts/validate-ops-config.mjs";
import { runOpsSmoke } from "../scripts/run-ops-smoke.mjs";

const execFileAsync = promisify(execFile);

test("ops validation passes the default demo profile", async () => {
  const result = await validateOpsConfig({
    env: {},
    scanFiles: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile, "demo");
  assert.equal(result.productionReady, false);
  assert.equal(result.checks.limits.FOC_PLATFORM_API_RATE_LIMIT_RPM, 60);
  assert.equal(result.checks.kms.required, false);
});

test("ops validation rejects raw production secret env values", async () => {
  await assert.rejects(
    () =>
      validateOpsConfig({
        env: {
          FOC_PLATFORM_OPS_PROFILE: "production",
          PLATFORM_ROOT_PRIVATE_KEY: `0x${"11".repeat(32)}`,
          FOC_PLATFORM_ROOT_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/root",
          FOC_COORDINATOR_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/coordinator",
          FOC_PLATFORM_ADMIN_AUTH_AUDIENCE: "https://admin.example.invalid",
        },
        scanFiles: false,
      }),
    (error) => {
      assert.equal(error instanceof OpsConfigError, true);
      assert.equal(error.code, "raw_secret_env");
      assert.deepEqual(error.details.keys, ["PLATFORM_ROOT_PRIVATE_KEY"]);
      return true;
    },
  );
});

test("ops validation rejects scoped mnemonic and seed env values in production", async () => {
  const secretKeys = [
    "MNEMONIC",
    "SEED",
    "PLATFORM_ROOT_MNEMONIC",
    "COORDINATOR_SEED",
    "FOC_COORDINATOR_MNEMONIC",
    "WALLET_MNEMONIC",
    "DEPLOYER_SEED",
    "WALLET_MNEMONIC_PHRASE",
    "DEPLOYER_SEED_WORDS",
  ];

  for (const key of secretKeys) {
    await assert.rejects(
      () =>
        validateOpsConfig({
          env: {
            FOC_PLATFORM_OPS_PROFILE: "production",
            [key]: "test test test test test test test test test test test junk",
            FOC_PLATFORM_ROOT_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/root",
            FOC_COORDINATOR_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/coordinator",
            FOC_PLATFORM_ADMIN_AUTH_AUDIENCE: "https://admin.example.invalid",
          },
          scanFiles: false,
        }),
      (error) => {
        assert.equal(error instanceof OpsConfigError, true);
        assert.equal(error.code, "raw_secret_env");
        assert.deepEqual(error.details.keys, [key]);
        return true;
      },
    );
  }
});

test("ops validation rejects generic unprefixed raw hex secret env values in production", async () => {
  const rawHexKey = "11".repeat(32);

  for (const key of [
    "WALLET_PRIVATE_KEY",
    "DEPLOYER_SECRET",
    "WALLET_PRIVATE_KEY_HEX",
    "DEPLOYER_SECRET_HEX",
  ]) {
    await assert.rejects(
      () =>
        validateOpsConfig({
          env: {
            FOC_PLATFORM_OPS_PROFILE: "production",
            [key]: rawHexKey,
            FOC_PLATFORM_ROOT_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/root",
            FOC_COORDINATOR_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/coordinator",
            FOC_PLATFORM_ADMIN_AUTH_AUDIENCE: "https://admin.example.invalid",
          },
          scanFiles: false,
        }),
      (error) => {
        assert.equal(error instanceof OpsConfigError, true);
        assert.equal(error.code, "raw_secret_env");
        assert.deepEqual(error.details.keys, [key]);
        return true;
      },
    );
  }
});

test("ops validation rejects concrete unprefixed tracked hex secret material", async () => {
  const workspaceRoot = await createMinimalOpsWorkspace({
    "secrets.env": `WALLET_PRIVATE_KEY=${"ab".repeat(32)}\n`,
  });
  try {
    await assert.rejects(
      () =>
        validateOpsConfig({
          env: {},
          workspaceRoot,
        }),
      (error) => {
        assert.equal(error instanceof OpsConfigError, true);
        assert.equal(error.code, "tracked_secret_material");
        assert.deepEqual(error.details.findings.map((finding) => finding.file), ["secrets.env"]);
        return true;
      },
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("ops validation accepts production KMS refs and bounded limits", async () => {
  const result = await validateOpsConfig({
    env: {
      FOC_PLATFORM_OPS_PROFILE: "production",
      FOC_PLATFORM_ROOT_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/root",
      FOC_COORDINATOR_KMS_KEY_REF: "projects/example/keyRings/foc/cryptoKeys/coordinator",
      FOC_PLATFORM_ADMIN_AUTH_AUDIENCE: "https://admin.example.invalid",
      FOC_PLATFORM_API_RATE_LIMIT_RPM: "120",
      FOC_COORDINATOR_MAX_RETRIES: "5",
    },
    scanFiles: false,
  });

  assert.equal(result.profile, "production");
  assert.equal(result.productionReady, false);
  assert.equal(result.checks.kms.required, true);
  assert.equal(result.checks.limits.FOC_PLATFORM_API_RATE_LIMIT_RPM, 120);
  assert.equal(result.checks.limits.FOC_COORDINATOR_MAX_RETRIES, 5);
});

test("ops smoke covers API duplicate boundary and coordinator idempotency", async () => {
  const summary = await runOpsSmoke({ iterations: 2 });

  assert.equal(summary.ok, true);
  assert.equal(summary.mocked, true);
  assert.equal(summary.productionReady, false);
  assert.equal(summary.api.created, 2);
  assert.equal(summary.api.duplicates, 2);
  assert.equal(summary.api.statusReads, 2);
  assert.equal(summary.coordinator.committed, 2);
  assert.equal(summary.coordinator.replays, 2);
  assert.equal(summary.coordinator.uploadCalls, 2);
  assert.equal(summary.coordinator.finalizeCalls, 2);
});

async function createMinimalOpsWorkspace(files) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "foc-platform-ops-"));
  await mkdir(join(workspaceRoot, "docs"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "package.json"),
    `${JSON.stringify(
      {
        scripts: {
          "ops:validate": "node scripts/validate-ops-config.mjs",
          "ops:smoke": "node scripts/run-ops-smoke.mjs",
          "test:ops": "node --test test/ops-hardening.test.mjs",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(workspaceRoot, "docs/production-hardening-runbook.md"),
    [
      "# Production Hardening Runbook",
      "## Threat Model",
      "## Secret Management",
      "## Rate Limits And Timeouts",
      "## Reconciliation Runbook",
      "## Remaining Production Gates",
      "productionReady",
      "https://github.com/FIL-Builders/foc-platform/issues/6",
      "https://github.com/FIL-Builders/foc-platform/issues/11",
      "",
    ].join("\n"),
  );
  for (const [file, contents] of Object.entries(files)) {
    await writeFile(join(workspaceRoot, file), contents);
  }
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
  await execFileAsync("git", ["add", "."], { cwd: workspaceRoot });
  return workspaceRoot;
}
