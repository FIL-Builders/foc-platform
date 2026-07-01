import assert from "node:assert/strict";
import test from "node:test";

import { OpsConfigError, validateOpsConfig } from "../scripts/validate-ops-config.mjs";
import { runOpsSmoke } from "../scripts/run-ops-smoke.mjs";

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
  for (const key of ["MNEMONIC", "SEED", "PLATFORM_ROOT_MNEMONIC", "COORDINATOR_SEED", "FOC_COORDINATOR_MNEMONIC"]) {
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
