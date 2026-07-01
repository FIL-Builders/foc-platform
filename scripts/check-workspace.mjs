import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "README.md",
  "spec.md",
  "foundry.toml",
  "package.json",
  ".env.example",
  "docs/registry.md",
  "contracts/FocPlatformRegistry.sol",
  "contracts/WorkspaceSentinel.sol",
  "test/contracts/FocPlatformRegistry.t.sol",
  "test/contracts/WorkspaceSentinel.t.sol",
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

const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const script of ["lint", "test", "test:node", "test:contracts", "build:contracts"]) {
  if (!pkg.scripts?.[script]) {
    throw new Error(`package.json is missing script: ${script}`);
  }
}

console.log("workspace scaffold checks passed");
