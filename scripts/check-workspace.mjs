import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "README.md",
  "spec.md",
  "foundry.toml",
  "package.json",
  ".env.example",
  "contracts/WorkspaceSentinel.sol",
  "test/contracts/WorkspaceSentinel.t.sol",
  "test/workspace.test.mjs",
];

for (const path of requiredFiles) {
  await access(path);
}

const envExample = await readFile(".env.example", "utf8");
for (const forbidden of ["0x0000000000000000000000000000000000000000000000000000000000000000"]) {
  if (envExample.includes(forbidden)) {
    throw new Error(`.env.example must not contain placeholder private key ${forbidden}`);
  }
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const script of ["lint", "test", "test:node", "test:contracts", "build:contracts"]) {
  if (!pkg.scripts?.[script]) {
    throw new Error(`package.json is missing script: ${script}`);
  }
}

console.log("workspace scaffold checks passed");
