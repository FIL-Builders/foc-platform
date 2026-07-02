import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { filecoinCalibration } from "viem/chains";

import { registryAbi } from "../src/registry/read-model.mjs";

const DEFAULT_RPC_URL = "https://api.calibration.node.glif.io/rpc/v1";
const DEFAULT_REGISTRY_ADDRESS = "0x8F6563Bb9E53aeDfE9d87d4C1E162f0371649c18";
const DEFAULT_OUTPUT_PATH = "artifacts/calibration/fixture-seed-summary.json";
const DEFAULT_FIXTURE_SEED = "2026-07-demo-grid-durable";
const DEFAULT_FIXTURE_REQUEST_EXPIRES_AT = 4_102_444_800n; // 2100-01-01T00:00:00Z
const DEFAULT_GAS_LIMIT = 125_000_000n;
const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_RECEIPT_TIMEOUT_MS = 300_000;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const FIXTURE_COORDINATOR_MAX_FINALIZE_DELAY = 86_400n;
const STATUS = Object.freeze({
  requested: 1,
  uploading: 2,
  committed: 3,
  partial: 4,
  failed: 5,
});

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}

export async function main({ argv = process.argv, stdout = console.log } = {}) {
  const args = parseArgs(argv.slice(2));
  if (args.help) {
    stdout(`Usage: node scripts/seed-calibration-registry-fixtures.mjs [options]

Creates deterministic synthetic registry-only demo rows on Filecoin Calibration.
The script never prints or writes the private key.

Required environment:
  PRIVATE_KEY or PLATFORM_ROOT_PRIVATE_KEY  local Calibration signer

Common optional environment:
  FILECOIN_CALIBRATION_RPC_URL              defaults to public GLIF Calibration RPC
  FOC_PLATFORM_REGISTRY_ADDRESS             defaults to the committed demo registry
  FOC_PLATFORM_FIXTURE_GAS_LIMIT            defaults to 125000000
  FOC_PLATFORM_FIXTURE_RPC_TIMEOUT_MS       defaults to 120000
  FOC_PLATFORM_FIXTURE_RECEIPT_TIMEOUT_MS   defaults to 300000

Options:
  --objects <n>       total fixture files to ensure, default 48
  --accounts <n>      total fixture users/accounts to rotate across, default 24
  --committed <n>     number of files to finalize as committed, default 8
  --uploading <n>     number of files to advance to uploading, default 8
  --seed <text>       deterministic fixture namespace, default ${DEFAULT_FIXTURE_SEED}
  --request-expires-at <unix>
                       durable request expiry timestamp, default ${DEFAULT_FIXTURE_REQUEST_EXPIRES_AT}
  --provider <n>      synthetic provider id base, default 40
  --dataset <n>       synthetic dataset id base, default 13000
  --piece <n>         synthetic piece id base, default 7000
  --batch-size <n>    transactions to send before waiting, default 12
  --output <path>     write public summary JSON, default ${DEFAULT_OUTPUT_PATH}
  --dry-run           read and plan only; do not submit transactions
`);
    return null;
  }

  const result = await seedCalibrationRegistryFixtures({
    env: process.env,
    options: args,
    stdout,
  });
  stdout(JSON.stringify(result.summary, null, 2));
  return result;
}

export async function seedCalibrationRegistryFixtures({
  env = process.env,
  options = {},
  stdout = console.log,
} = {}) {
  const config = loadConfig(env, options);
  const publicClient = createPublicClient({
    chain: filecoinCalibration,
    transport: http(config.rpcUrl, {
      retryCount: 2,
      retryDelay: 1_000,
      timeout: config.rpcTimeoutMs,
    }),
  });
  const walletClient = createWalletClient({
    account: config.account,
    chain: filecoinCalibration,
    transport: http(config.rpcUrl, {
      retryCount: 2,
      retryDelay: 1_000,
      timeout: config.rpcTimeoutMs,
    }),
  });

  const txHashes = [];
  const skipped = [];
  const created = [];
  const advanced = [];

  await assertOwner({ publicClient, config });
  await ensureCoordinator({ publicClient, walletClient, config, stdout, txHashes });
  await ensureRelayer({ publicClient, walletClient, config, stdout, txHashes });

  const beforeCounts = await readCounts({ publicClient, config });
  const rowStates = buildFixtureRows(config).map((row) => ({
    row,
    objectId: 0n,
    status: 0,
    existed: false,
  }));

  for (const state of rowStates) {
    const { row } = state;
    const existingObjectId = await readObjectByIdempotencyKey({ publicClient, config, row });
    state.objectId = existingObjectId;
    state.existed = existingObjectId !== 0n;

    if (existingObjectId !== 0n) {
      const object = await readStorageObject({ publicClient, config, objectId: existingObjectId });
      assertFixtureRequestMatches({ row, objectId: existingObjectId, object });
      state.status = objectStatus(object);
    }
  }

  const requestPlans = rowStates
    .filter((state) => state.objectId === 0n)
    .map((state) => ({
      label: `request ${state.row.label}`,
      functionName: "requestUpload",
      args: [state.row.requestParams, "0x"],
    }));
  await sendBatch({
    publicClient,
    walletClient,
    config,
    stdout,
    dryRun: config.dryRun,
    txHashes,
    plans: requestPlans,
  });

  for (const state of rowStates) {
    const { row } = state;
    if (state.objectId === 0n && !config.dryRun) {
      state.objectId = await readObjectByIdempotencyKey({ publicClient, config, row });
      if (state.objectId !== 0n) created.push(row.label);
    }
    if (state.objectId === 0n) {
      skipped.push({ label: row.label, reason: "dry_run_not_created" });
      continue;
    }
    const object = await readStorageObject({ publicClient, config, objectId: state.objectId });
    assertFixtureRequestMatches({ row, objectId: state.objectId, object });
    state.status = objectStatus(object);
  }

  const startPlans = rowStates
    .filter(
      (state) =>
        state.objectId !== 0n &&
        state.row.targetStatus >= STATUS.uploading &&
        state.status === STATUS.requested,
    )
    .map((state) => ({
      state,
      label: `start ${state.row.label}`,
      functionName: "startUpload",
      args: [state.objectId],
    }));
  await sendBatch({
    publicClient,
    walletClient,
    config,
    stdout,
    dryRun: config.dryRun,
    txHashes,
    plans: startPlans,
  });
  if (!config.dryRun) {
    for (const plan of startPlans) {
      plan.state.status = STATUS.uploading;
      advanced.push(`${plan.state.row.label}:uploading`);
    }
  }

  for (const state of rowStates) {
    if (state.objectId === 0n || state.row.targetStatus < STATUS.committed) continue;
    const object = await readStorageObject({ publicClient, config, objectId: state.objectId });
    state.status = objectStatus(object);
    if (state.status >= STATUS.committed) {
      skipped.push({
        label: state.row.label,
        objectId: state.objectId.toString(),
        reason: "already_terminal",
      });
    }
  }

  const finalizationPlans = rowStates
    .filter(
      (state) =>
        state.objectId !== 0n &&
        state.row.targetStatus >= STATUS.committed &&
        state.status === STATUS.uploading,
    )
    .flatMap((state) => [
      {
        state,
        label: `record dataset ${state.row.label}`,
        functionName: "recordDataset",
        args: [state.row.dataset],
      },
      {
        state,
        label: `finalize ${state.row.label}`,
        functionName: "finalizeUpload",
        args: [state.objectId, state.row.receipt],
      },
    ]);
  await sendBatch({
    publicClient,
    walletClient,
    config,
    stdout,
    dryRun: config.dryRun,
    txHashes,
    plans: finalizationPlans,
  });
  if (!config.dryRun) {
    for (const plan of finalizationPlans.filter((item) => item.functionName === "finalizeUpload")) {
      plan.state.status = STATUS.committed;
      advanced.push(`${plan.state.row.label}:committed`);
    }
  }

  const afterCounts = config.dryRun ? beforeCounts : await readCounts({ publicClient, config });
  const summary = {
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    network: "filecoin_calibration",
    chainId: 314159,
    registry: config.registryAddress,
    signer: config.account.address,
    seed: config.seed,
    gasLimit: config.gas.toString(),
    receiptTimeoutMs: config.receiptTimeoutMs,
    requestedFixtures: {
      objects: config.objectCount,
      accounts: config.accountCount,
      committed: config.committedCount,
      uploading: config.uploadingCount,
      requested: Math.max(0, config.objectCount - config.committedCount - config.uploadingCount),
      requestExpiresAt: config.requestExpiresAt.toString(),
    },
    counts: {
      before: stringifyCounts(beforeCounts),
      after: stringifyCounts(afterCounts),
    },
    observedFixtures: summarizeObservedFixtures(rowStates, config),
    changes: {
      created,
      advanced,
      skipped,
      txCount: txHashes.length,
      txHashes,
    },
    boundary:
      "Synthetic registry-only fixtures for the public read-only Worker dashboard; these rows do not prove real FOC provider storage.",
  };

  if (!config.dryRun && config.outputPath) {
    await writeFile(config.outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  return { summary };
}

function loadConfig(env, options) {
  const privateKey = normalizePrivateKey(env.PRIVATE_KEY ?? env.PLATFORM_ROOT_PRIVATE_KEY);
  const objectCount = positiveInt(options.objects ?? "48", "objects");
  const accountCount = positiveInt(options.accounts ?? "24", "accounts");
  const committedCount = boundedCount(options.committed ?? "8", objectCount, "committed");
  const uploadingCount = boundedCount(options.uploading ?? "8", objectCount - committedCount, "uploading");

  return {
    account: privateKeyToAccount(privateKey),
    rpcUrl: optionalEnvDefault(env, "FILECOIN_CALIBRATION_RPC_URL", DEFAULT_RPC_URL),
    registryAddress: normalizeAddress(
      optionalEnvDefault(env, "FOC_PLATFORM_REGISTRY_ADDRESS", DEFAULT_REGISTRY_ADDRESS),
      "FOC_PLATFORM_REGISTRY_ADDRESS",
    ),
    rpcTimeoutMs: positiveInt(
      optionalEnvDefault(env, "FOC_PLATFORM_FIXTURE_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS),
      "FOC_PLATFORM_FIXTURE_RPC_TIMEOUT_MS",
    ),
    receiptTimeoutMs: positiveInt(
      optionalEnvDefault(env, "FOC_PLATFORM_FIXTURE_RECEIPT_TIMEOUT_MS", DEFAULT_RECEIPT_TIMEOUT_MS),
      "FOC_PLATFORM_FIXTURE_RECEIPT_TIMEOUT_MS",
    ),
    gas: BigInt(optionalEnvDefault(env, "FOC_PLATFORM_FIXTURE_GAS_LIMIT", DEFAULT_GAS_LIMIT.toString())),
    batchSize: positiveInt(options.batchSize ?? "12", "batch-size"),
    dryRun: Boolean(options.dryRun),
    outputPath: options.output ?? DEFAULT_OUTPUT_PATH,
    seed: String(options.seed ?? DEFAULT_FIXTURE_SEED),
    requestExpiresAt: uint64(
      options.requestExpiresAt ?? DEFAULT_FIXTURE_REQUEST_EXPIRES_AT.toString(),
      "request-expires-at",
    ),
    objectCount,
    accountCount,
    committedCount,
    uploadingCount,
    providerBase: positiveInt(options.provider ?? "40", "provider"),
    datasetBase: positiveInt(options.dataset ?? "13000", "dataset"),
    pieceBase: positiveInt(options.piece ?? "7000", "piece"),
  };
}

function buildFixtureRows(config) {
  return Array.from({ length: config.objectCount }, (_, index) => {
    const fixtureNumber = index + 1;
    const accountNumber = (index % config.accountCount) + 1;
    const label = `fixture-${fixtureNumber}`;
    const accountId = bytes32(`${config.seed}:account:${accountNumber}`);
    const user = fixtureUserAddress(config.seed, accountNumber);
    const idempotencyKey = bytes32(`${config.seed}:object:${fixtureNumber}`);
    const providerId = BigInt(config.providerBase + (accountNumber % 4));
    const datasetId = BigInt(config.datasetBase + accountNumber);
    const pieceId = BigInt(config.pieceBase + fixtureNumber);
    const size = BigInt(131_072 + fixtureNumber * 4096);
    const maxCost = 1_000_000_000_000_000n + BigInt(fixtureNumber);
    const actualCost = BigInt(fixtureNumber % 5);
    const targetStatus =
      index < config.committedCount
        ? STATUS.committed
        : index < config.committedCount + config.uploadingCount
          ? STATUS.uploading
          : STATUS.requested;
    const metadata = {
      project: "foc-platform",
      purpose: "worker-admin-fixture",
      seed: config.seed,
      fixtureNumber,
      accountNumber,
    };
    const retrievalUrl = `https://example.invalid/foc-platform/fixtures/${config.seed}/${fixtureNumber}`;
    const contentHash = bytes32(`${config.seed}:content:${fixtureNumber}`);
    const metadataHash = keccak256(stringToHex(stableJson(metadata)));
    const syntheticPieceCid = `fixture-piece-${config.seed}-${fixtureNumber}`;
    const receiptHash = keccak256(
      stringToHex(
        stableJson({
          ...metadata,
          contentHash,
          metadataHash,
          pieceId: pieceId.toString(),
          retrievalUrl,
          actualCost: actualCost.toString(),
        }),
      ),
    );

    return {
      label,
      targetStatus,
      accountId,
      idempotencyKey,
      requestParams: {
        accountId,
        user,
        idempotencyKey,
        contentHash,
        metadataHash,
        size,
        requestedCopies: 1,
        withCDN: false,
        maxCost,
        requestExpiresAt: config.requestExpiresAt,
      },
      dataset: {
        accountId,
        payer: config.account.address,
        providerId,
        datasetId,
        storageClass: keccak256(stringToHex("foc-calibration-fixture")),
        withCDN: false,
        createdAt: 0n,
        updatedAt: 0n,
      },
      receipt: {
        finalizationStatus: 0,
        payer: config.account.address,
        pieceCidHash: keccak256(stringToHex(syntheticPieceCid)),
        size,
        requestedCopies: 1,
        completedCopies: 1,
        actualCost,
        receiptHash,
        copies: [
          {
            providerId,
            datasetId,
            pieceId,
            addPieceTxHash: ZERO_BYTES32,
            retrievalUrlHash: keccak256(stringToHex(retrievalUrl)),
            isNewDataSet: false,
          },
        ],
      },
    };
  });
}

async function ensureCoordinator({ publicClient, walletClient, config, stdout, txHashes }) {
  const policy = await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "coordinatorPolicies",
    args: [config.account.address],
  });
  const allowed = Boolean(policy.allowed ?? policy[0]);
  const maxFinalizeDelay = BigInt(policy.maxFinalizeDelay ?? policy[1]);
  const sessionKeyExpiresAt = BigInt(policy.sessionKeyExpiresAt ?? policy[2]);
  const permissionsHash = String(policy.permissionsHash ?? policy[3]).toLowerCase();
  if (
    allowed &&
    maxFinalizeDelay === FIXTURE_COORDINATOR_MAX_FINALIZE_DELAY &&
    sessionKeyExpiresAt === 0n &&
    permissionsHash === ZERO_BYTES32
  ) {
    return;
  }

  await maybeSend({
    publicClient,
    walletClient,
    config,
    stdout,
    dryRun: config.dryRun,
    txHashes,
    label: "set fixture coordinator",
    functionName: "setCoordinator",
    args: [
      config.account.address,
      {
        allowed: true,
        maxFinalizeDelay: FIXTURE_COORDINATOR_MAX_FINALIZE_DELAY,
        sessionKeyExpiresAt: 0n,
        permissionsHash: ZERO_BYTES32,
      },
    ],
  });
}

async function ensureRelayer({ publicClient, walletClient, config, stdout, txHashes }) {
  const relayerAllowed = await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "isRelayer",
    args: [config.account.address],
  });
  if (relayerAllowed) return;

  await maybeSend({
    publicClient,
    walletClient,
    config,
    stdout,
    dryRun: config.dryRun,
    txHashes,
    label: "set fixture relayer",
    functionName: "setRelayer",
    args: [config.account.address, true],
  });
}

async function assertOwner({ publicClient, config }) {
  const owner = await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "owner",
  });
  if (owner.toLowerCase() !== config.account.address.toLowerCase()) {
    throw new Error(`Signer ${config.account.address} is not registry owner ${owner}`);
  }
}

async function readObjectByIdempotencyKey({ publicClient, config, row }) {
  return await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "objectByIdempotencyKey",
    args: [row.accountId, row.idempotencyKey],
  });
}

async function readStorageObject({ publicClient, config, objectId }) {
  return await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "getStorageObject",
    args: [objectId],
  });
}

async function readCounts({ publicClient, config }) {
  const [objectCount, accountCount, datasetRecordCount, coordinatorCount, relayerCount] =
    await Promise.all(
      ["objectCount", "accountCount", "datasetRecordCount", "coordinatorCount", "relayerCount"].map(
        (functionName) =>
          publicClient.readContract({
            address: config.registryAddress,
            abi: registryAbi,
            functionName,
          }),
      ),
    );
  return { objectCount, accountCount, datasetRecordCount, coordinatorCount, relayerCount };
}

async function maybeSend({
  publicClient,
  walletClient,
  config,
  stdout,
  dryRun,
  txHashes,
  label,
  functionName,
  args,
}) {
  if (dryRun) {
    stdout(`[dry-run] ${label}`);
    return null;
  }
  stdout(`[tx] ${label}`);
  const hash = await walletClient.writeContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName,
    args,
    gas: config.gas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${functionName} reverted: ${hash}`);
  }
  txHashes.push({ label, functionName, hash });
  stdout(`[ok] ${label} ${hash}`);
  return hash;
}

async function sendBatch({
  publicClient,
  walletClient,
  config,
  stdout,
  dryRun,
  txHashes,
  plans,
}) {
  if (plans.length === 0) return;
  if (dryRun) {
    for (const plan of plans) stdout(`[dry-run] ${plan.label}`);
    return;
  }

  for (let offset = 0; offset < plans.length; offset += config.batchSize) {
    const batch = plans.slice(offset, offset + config.batchSize);
    let nonce = await publicClient.getTransactionCount({
      address: config.account.address,
      blockTag: "pending",
    });
    const pending = [];

    for (const plan of batch) {
      stdout(`[tx] ${plan.label}`);
      const hash = await walletClient.writeContract({
        address: config.registryAddress,
        abi: registryAbi,
        functionName: plan.functionName,
        args: plan.args,
        gas: config.gas,
        nonce,
      });
      nonce += 1;
      txHashes.push({ label: plan.label, functionName: plan.functionName, hash });
      stdout(`[sent] ${plan.label} ${hash}`);
      pending.push({ ...plan, hash });
    }

    const receipts = await Promise.all(
      pending.map((plan) =>
        publicClient.waitForTransactionReceipt({
          hash: plan.hash,
          timeout: config.receiptTimeoutMs,
        }),
      ),
    );
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      const plan = pending[index];
      if (receipt.status !== "success") {
        throw new Error(`${plan.functionName} reverted: ${plan.hash}`);
      }
      stdout(`[ok] ${plan.label} ${plan.hash}`);
    }
  }
}

function assertFixtureRequestMatches({ row, objectId, object }) {
  const checks = [
    ["objectId", object.objectId ?? object[0], objectId],
    ["accountId", object.accountId ?? object[1], row.requestParams.accountId],
    ["user", object.user ?? object[2], row.requestParams.user],
    ["idempotencyKey", object.idempotencyKey ?? object[3], row.requestParams.idempotencyKey],
    ["contentHash", object.contentHash ?? object[4], row.requestParams.contentHash],
    ["metadataHash", object.metadataHash ?? object[5], row.requestParams.metadataHash],
    ["size", object.size ?? object[7], row.requestParams.size],
    ["requestedCopies", object.requestedCopies ?? object[8], row.requestParams.requestedCopies],
    ["withCDN", object.withCDN ?? object[10], row.requestParams.withCDN],
    ["maxCost", object.maxCost ?? object[11], row.requestParams.maxCost],
    ["requestExpiresAt", object.requestExpiresAt ?? object[16], row.requestParams.requestExpiresAt],
  ];
  const mismatches = checks
    .filter(([, actual, expected]) => identityPart(actual) !== identityPart(expected))
    .map(([field, actual, expected]) => `${field} expected ${expected} got ${actual}`);
  if (mismatches.length > 0) {
    throw new Error(`Existing fixture object ${objectId} does not match deterministic row: ${mismatches.join("; ")}`);
  }
}

function objectStatus(object) {
  return Number(object.status ?? object[14]);
}

function summarizeObservedFixtures(rowStates, config) {
  const summary = {
    total: 0,
    requested: 0,
    uploading: 0,
    committed: 0,
    other: 0,
    missing: [],
    requestExpiresAt: config.requestExpiresAt.toString(),
    requestExpiresAtMismatches: [],
  };
  for (const state of rowStates) {
    if (state.objectId === 0n) {
      summary.missing.push(state.row.label);
      continue;
    }
    summary.total += 1;
    if (state.status === STATUS.requested) summary.requested += 1;
    else if (state.status === STATUS.uploading) summary.uploading += 1;
    else if (state.status === STATUS.committed) summary.committed += 1;
    else summary.other += 1;
    if (state.row.requestParams.requestExpiresAt !== config.requestExpiresAt) {
      summary.requestExpiresAtMismatches.push(state.row.label);
    }
  }
  return summary;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      parsed[key] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function normalizePrivateKey(value) {
  const raw = required(value, "PRIVATE_KEY or PLATFORM_ROOT_PRIVATE_KEY");
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(prefixed)) {
    throw new Error("private key must be 32-byte hex");
  }
  return prefixed;
}

function normalizeAddress(value, label) {
  const raw = required(value, label);
  if (!isAddress(raw)) throw new Error(`${label} must be an EVM address`);
  return getAddress(raw);
}

function optionalEnvDefault(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} is required`);
  }
  return String(value).trim();
}

function positiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function boundedCount(value, max, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${label} must be an integer between 0 and ${max}`);
  }
  return parsed;
}

function uint64(value, label) {
  const parsed = BigInt(String(value));
  if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${label} must be an unsigned 64-bit integer`);
  }
  return parsed;
}

function fixtureUserAddress(seed, accountNumber) {
  return getAddress(`0x${bytes32(`${seed}:user:${accountNumber}`).slice(-40)}`);
}

function bytes32(value) {
  return keccak256(stringToHex(String(value)));
}

function stringifyCounts(counts) {
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value.toString()]));
}

function identityPart(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function isMainModule(metaUrl, entrypoint) {
  return Boolean(entrypoint) && metaUrl === pathToFileURL(resolve(entrypoint)).href;
}
