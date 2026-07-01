import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const foundryArtifactPath = new URL(
  "../out/FocPlatformRegistry.sol/FocPlatformRegistry.json",
  import.meta.url,
);
const outputPath = new URL(
  "../artifacts/contracts/FocPlatformRegistry.json",
  import.meta.url,
);

const foundryArtifact = JSON.parse(await readFile(foundryArtifactPath, "utf8"));
const bytecode = normalizeBytecode(foundryArtifact.bytecode?.object);
const deployedBytecode = normalizeBytecode(foundryArtifact.deployedBytecode?.object);

const artifact = {
  schemaVersion: 1,
  contractName: "FocPlatformRegistry",
  sourceName: "contracts/FocPlatformRegistry.sol",
  abi: foundryArtifact.abi,
  bytecode,
  bytecodeSha256: hashHex(bytecode),
  deployedBytecodeSha256: hashHex(deployedBytecode),
};

await mkdir(new URL("../artifacts/contracts/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`wrote ${outputPath.pathname}`);

function normalizeBytecode(bytecodeObject) {
  if (typeof bytecodeObject !== "string" || bytecodeObject.length === 0) {
    throw new Error("Foundry artifact is missing bytecode.object");
  }
  return bytecodeObject.startsWith("0x") ? bytecodeObject : `0x${bytecodeObject}`;
}

function hashHex(hex) {
  return `0x${createHash("sha256").update(hex.slice(2), "hex").digest("hex")}`;
}
