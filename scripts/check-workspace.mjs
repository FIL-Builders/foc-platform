import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "README.md",
  "spec.md",
  "foundry.toml",
  "package.json",
  ".env.example",
  "apps/tokenhost-foc-platform/schema.json",
  "apps/tokenhost-foc-platform/ui-overrides/app/page.tsx",
  "artifacts/contracts/FocPlatformRegistry.json",
  "artifacts/calibration/demo-evidence.json",
  "artifacts/tokenhost/foc-platform-wrapper-manifest.json",
  "docs/calibration-worker-demo.md",
  "docs/deployment.md",
  "docs/admin-reconciliation.md",
  "docs/production-hardening-runbook.md",
  "docs/platform-api.md",
  "docs/registry.md",
  "docs/tokenhost-demo.md",
  "docs/upload-spine.md",
  "contracts/FocPlatformRegistry.sol",
  "contracts/WorkspaceSentinel.sol",
  "script/DeployFocPlatformRegistry.s.sol",
  "scripts/generate-registry-artifacts.mjs",
  "scripts/generate-tokenhost-wrapper-artifacts.mjs",
  "scripts/run-ops-smoke.mjs",
  "scripts/validate-ops-config.mjs",
  "src/admin/reconciliation.mjs",
  "src/api/platform-admin-api.mjs",
  "src/api/platform-api.mjs",
  "src/demo/tokenhost-wrapper.mjs",
  "src/dev/upload-spine.mjs",
  "src/registry/read-model.mjs",
  "src/worker/calibration-demo.mjs",
  "src/worker/worker-configuration.d.ts",
  "test/calibration-worker.test.mjs",
  "test/contracts/FocPlatformRegistry.t.sol",
  "test/contracts/WorkspaceSentinel.t.sol",
  "test/admin-reconciliation.test.mjs",
  "test/dev-upload-spine.test.mjs",
  "test/platform-admin-api.test.mjs",
  "test/platform-api.test.mjs",
  "test/ops-hardening.test.mjs",
  "test/registry-read-model.test.mjs",
  "test/tokenhost-demo.test.mjs",
  "test/workspace.test.mjs",
  "tokenhost/foc-platform-wrapper.config.json",
  "wrangler.jsonc",
];

for (const filePath of requiredFiles) {
  await access(filePath);
}

const envExample = await readFile(".env.example", "utf8");
const privateKeyPattern = /PRIVATE_KEY=0x[0-9a-fA-F]{64}/;
if (privateKeyPattern.test(envExample)) {
  throw new Error(".env.example must not contain concrete private key values");
}

const wrangler = await readFile("wrangler.jsonc", "utf8");
const secretSurfacePattern =
  /\bprivate[\s_-]*key\b|\bprivateKey\b|\bwallet[\s_-]*seed\b|\bsecret\b|wrangler\s+secret\s+put/i;
if (secretSurfacePattern.test(wrangler)) {
  throw new Error("wrangler.jsonc must not contain secret bindings or key placeholders");
}
const workerSource = await readFile("src/worker/calibration-demo.mjs", "utf8");
if (/process\.env/i.test(workerSource) || secretSurfacePattern.test(workerSource)) {
  throw new Error("Worker source must stay read-only and secret-free");
}

const gitignore = await readFile(".gitignore", "utf8");
if (!/^broadcast\/$/m.test(gitignore)) {
  throw new Error(".gitignore must ignore Foundry broadcast outputs");
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const script of [
  "lint",
  "ops:smoke",
  "ops:validate",
  "test",
  "test:admin",
  "test:api",
  "test:node",
  "test:ops",
  "test:contracts",
  "test:spine",
  "test:tokenhost",
  "build:contracts",
  "build:artifacts",
  "build:tokenhost",
  "worker:dev",
  "worker:dry-run",
  "worker:types",
]) {
  if (!pkg.scripts?.[script]) {
    throw new Error(`package.json is missing script: ${script}`);
  }
}

const artifact = JSON.parse(await readFile("artifacts/contracts/FocPlatformRegistry.json", "utf8"));
if (artifact.contractName !== "FocPlatformRegistry" || !Array.isArray(artifact.abi)) {
  throw new Error("registry artifact must expose FocPlatformRegistry ABI");
}

const calibrationEvidence = JSON.parse(
  await readFile("artifacts/calibration/demo-evidence.json", "utf8"),
);
if (
  calibrationEvidence.worker?.privilegedActions !== false ||
  calibrationEvidence.worker?.servesPrivateKeys !== false
) {
  throw new Error("Calibration evidence must record the Worker as read-only and secret-free");
}

const productionRunbook = await readFile("docs/production-hardening-runbook.md", "utf8");
for (const phrase of [
  "Threat Model",
  "Secret Management",
  "Rate Limits And Timeouts",
  "Reconciliation Runbook",
  "Remaining Production Gates",
  "productionReady",
]) {
  if (!productionRunbook.includes(phrase)) {
    throw new Error(`production hardening runbook is missing: ${phrase}`);
  }
}

const ci = await readFile(".github/workflows/ci.yml", "utf8");
for (const command of ["pnpm ops:validate", "pnpm ops:smoke", "pnpm worker:dry-run"]) {
  if (!ci.includes(command)) {
    throw new Error(`CI must run ${command}`);
  }
}
if (!ci.includes("pnpm build:artifacts") || !ci.includes("git diff --exit-code")) {
  throw new Error("CI must regenerate and compare committed registry artifacts");
}

console.log("workspace scaffold checks passed");
