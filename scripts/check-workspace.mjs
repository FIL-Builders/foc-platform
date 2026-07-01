import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "README.md",
  "spec.md",
  "foundry.toml",
  "package.json",
  ".env.example",
  "artifacts/contracts/FocPlatformRegistry.json",
  "docs/deployment.md",
  "docs/registry.md",
  "contracts/FocPlatformRegistry.sol",
  "contracts/WorkspaceSentinel.sol",
  "script/DeployFocPlatformRegistry.s.sol",
  "scripts/generate-registry-artifacts.mjs",
  "src/registry/read-model.mjs",
  "test/contracts/FocPlatformRegistry.t.sol",
  "test/contracts/WorkspaceSentinel.t.sol",
  "test/registry-read-model.test.mjs",
  "test/workspace.test.mjs",
];

for (const filePath of requiredFiles) {
  await access(filePath);
}

const envExample = await readFile(".env.example", "utf8");
const privateKeyPattern = /PRIVATE_KEY=0x[0-9a-fA-F]{64}/;
if (privateKeyPattern.test(envExample)) {
  throw new Error(".env.example must not contain concrete private key values");
}

const gitignore = await readFile(".gitignore", "utf8");
if (!/^broadcast\/$/m.test(gitignore)) {
  throw new Error(".gitignore must ignore Foundry broadcast outputs");
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const script of [
  "lint",
  "test",
  "test:node",
  "test:contracts",
  "build:contracts",
  "build:artifacts",
]) {
  if (!pkg.scripts?.[script]) {
    throw new Error(`package.json is missing script: ${script}`);
  }
}

const artifact = JSON.parse(await readFile("artifacts/contracts/FocPlatformRegistry.json", "utf8"));
if (artifact.contractName !== "FocPlatformRegistry" || !Array.isArray(artifact.abi)) {
  throw new Error("registry artifact must expose FocPlatformRegistry ABI");
}

const ci = await readFile(".github/workflows/ci.yml", "utf8");
if (!ci.includes("pnpm build:artifacts") || !ci.includes("git diff --exit-code")) {
  throw new Error("CI must regenerate and compare committed registry artifacts");
}

console.log("workspace scaffold checks passed");
