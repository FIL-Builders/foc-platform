import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { PLATFORM_ADMIN_API_ROUTES } from "../src/api/platform-admin-api.mjs";
import { PLATFORM_API_ROUTES } from "../src/api/platform-api.mjs";

const schemaPath = new URL("../apps/tokenhost-foc-platform/schema.json", import.meta.url);
const configPath = new URL("../tokenhost/foc-platform-wrapper.config.json", import.meta.url);
const registryArtifactPath = new URL(
  "../artifacts/contracts/FocPlatformRegistry.json",
  import.meta.url,
);
const outputPath = new URL(
  "../artifacts/tokenhost/foc-platform-wrapper-manifest.json",
  import.meta.url,
);

const schemaText = await readFile(schemaPath, "utf8");
const configText = await readFile(configPath, "utf8");
const registryText = await readFile(registryArtifactPath, "utf8");

const schema = JSON.parse(schemaText);
const config = JSON.parse(configText);
const registryArtifact = JSON.parse(registryText);

assertRoutesMatch(config.platformApi.routes, PLATFORM_API_ROUTES, "platformApi");
assertRoutesMatch(config.adminApi.routes, PLATFORM_ADMIN_API_ROUTES, "adminApi");
assertRegistryFunctions(registryArtifact.abi);

const manifest = {
  manifestVersion: "0.1.0",
  kind: "foc-platform-tokenhost-wrapper",
  mode: config.mode,
  schema: {
    path: config.schemaPath,
    thsVersion: schema.thsVersion,
    schemaVersion: schema.schemaVersion,
    appName: schema.app.name,
    appSlug: schema.app.slug,
    primaryCollection: schema.app.primaryCollection,
    sha256: sha256(schemaText),
  },
  builder: {
    repoPath: config.builder.repoPath,
    buildCommand: config.builder.buildCommand,
    chain: config.builder.chain,
    txMode: config.builder.txMode,
    expectedArtifacts: config.builder.expectedArtifacts,
    externalIssues: config.externalBuilderIssues,
  },
  extensions: {
    focPlatform: config.focPlatform,
  },
  focPlatform: config.focPlatform,
  registry: {
    name: config.registry.name,
    artifactPath: config.registry.artifactPath,
    sourceName: registryArtifact.sourceName,
    bytecodeSha256: registryArtifact.bytecodeSha256,
    deployedBytecodeSha256: registryArtifact.deployedBytecodeSha256,
    requiredFunctions: requiredRegistryFunctions(),
  },
  platformApi: {
    sourcePath: config.platformApi.sourcePath,
    routes: PLATFORM_API_ROUTES,
    auth: config.platformApi.auth,
  },
  adminApi: {
    sourcePath: config.adminApi.sourcePath,
    projectionPath: config.adminApi.projectionPath,
    routes: PLATFORM_ADMIN_API_ROUTES,
    auth: config.adminApi.auth,
  },
  tokenHostRuntime: config.tokenHostRuntime,
  screens: config.screens,
  boundaries: config.boundaries,
  configSha256: sha256(configText),
};

await mkdir(new URL("../artifacts/tokenhost/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`wrote ${outputPath.pathname}`);

function assertRoutesMatch(configRoutes, apiRoutes, label) {
  if (JSON.stringify(configRoutes) !== JSON.stringify(apiRoutes)) {
    throw new Error(`Token Host wrapper config ${label} routes drifted from exported routes`);
  }
}

function assertRegistryFunctions(abi) {
  const functions = new Set(
    abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name),
  );
  for (const name of requiredRegistryFunctions()) {
    if (!functions.has(name)) {
      throw new Error(`Registry artifact is missing required function ${name}`);
    }
  }
}

function requiredRegistryFunctions() {
  return [
    "requestUpload",
    "startUpload",
    "finalizeUpload",
    "failUpload",
    "cancelUpload",
    "expireUpload",
    "getStorageObject",
    "getAccountUsage",
    "getCopyReceipts",
    "receiptPayer",
  ];
}

function sha256(text) {
  return `0x${createHash("sha256").update(text).digest("hex")}`;
}
