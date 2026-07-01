import { readFile, writeFile } from "node:fs/promises";
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
const DEFAULT_REGISTRY_ADDRESS = "0x7771d916a9d742B1D60597a332C7ABBd5796609c";
const DEFAULT_EVIDENCE_PATH = "artifacts/calibration/demo-evidence.json";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const DEFAULT_GAS_LIMIT = 80_000_000n;
const STATUS_LABELS = [
  "None",
  "Requested",
  "Uploading",
  "Committed",
  "Partial",
  "Failed",
  "Cancelled",
  "Expired",
  "Deleted",
];

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}

export async function main({ argv = process.argv, stdout = console.log } = {}) {
  const args = new Set(argv.slice(2));
  if (args.has("--help")) {
    stdout(`Usage: node scripts/run-calibration-registry-demo.mjs [--write]

Required environment:
  PRIVATE_KEY or PLATFORM_ROOT_PRIVATE_KEY  local Calibration signer, never printed
  FOC_PLATFORM_DEMO_PIECE_CID              FOC piece CID
  FOC_PLATFORM_DEMO_RETRIEVAL_URL          public provider retrieval URL

Common optional environment:
  FILECOIN_CALIBRATION_RPC_URL             defaults to public GLIF Calibration RPC
  FOC_PLATFORM_REGISTRY_ADDRESS            defaults to committed Phase 0 registry
  FOC_PLATFORM_DEMO_PAYLOAD_PATH           defaults to /tmp/foc-platform-calibration-demo.bin
  FOC_PLATFORM_DEMO_PROVIDER_ID            defaults to 4
  FOC_PLATFORM_DEMO_DATASET_ID             defaults to 12524
  FOC_PLATFORM_DEMO_PIECE_ID               defaults to 34
  FOC_PLATFORM_DEMO_UPLOAD_TX_HASH         optional FOC upload/add-piece tx hash
  FOC_PLATFORM_DEMO_ADD_PIECE_TX_HASH      optional alias for upload/add-piece tx hash
  FOC_PLATFORM_DEMO_GAS_LIMIT              defaults to 80000000
`);
    return null;
  }

  const result = await runCalibrationRegistryDemo({
    write: args.has("--write"),
  });

  stdout(JSON.stringify(result.summary, null, 2));
  return result;
}

export async function runCalibrationRegistryDemo({ env = process.env, write = false } = {}) {
  const config = await loadConfig(env);
  const publicClient = createPublicClient({
    chain: filecoinCalibration,
    transport: http(config.rpcUrl),
  });
  const walletClient = createWalletClient({
    account: config.account,
    chain: filecoinCalibration,
    transport: http(config.rpcUrl),
  });

  const txHashes = {};

  await assertOwner({ publicClient, config });
  const coordinatorPolicy = await readCoordinatorPolicy({ publicClient, config });
  if (!coordinatorPolicy.allowed) {
    txHashes.setCoordinator = await sendAndWait({
      publicClient,
      walletClient,
      config,
      functionName: "setCoordinator",
      args: [
        config.account.address,
        {
          allowed: true,
          maxFinalizeDelay: 86_400n,
          sessionKeyExpiresAt: 0n,
          permissionsHash: ZERO_BYTES32,
        },
      ],
    });
  }

  let objectId = await readObjectByIdempotencyKey({ publicClient, config });
  if (objectId === 0n) {
    txHashes.requestUpload = await sendAndWait({
      publicClient,
      walletClient,
      config,
      functionName: "requestUpload",
      args: [config.requestParams, "0x"],
    });
    objectId = await readObjectByIdempotencyKey({ publicClient, config });
  }

  let object = await readStorageObject({ publicClient, config, objectId });
  if (Number(object.status) === 1) {
    txHashes.startUpload = await sendAndWait({
      publicClient,
      walletClient,
      config,
      functionName: "startUpload",
      args: [objectId],
    });
    object = await readStorageObject({ publicClient, config, objectId });
  }

  txHashes.recordDataset = await sendAndWait({
    publicClient,
    walletClient,
    config,
    functionName: "recordDataset",
    args: [
      {
        accountId: config.accountId,
        payer: config.account.address,
        providerId: BigInt(config.providerId),
        datasetId: BigInt(config.datasetId),
        storageClass: config.storageClass,
        withCDN: false,
        createdAt: 0n,
        updatedAt: 0n,
      },
    ],
  });

  object = await readStorageObject({ publicClient, config, objectId });
  if (![3, 4].includes(Number(object.status))) {
    txHashes.finalizeUpload = await sendAndWait({
      publicClient,
      walletClient,
      config,
      functionName: "finalizeUpload",
      args: [objectId, config.receipt],
    });
  }

  const [finalObject, usage, copyReceipts, receiptPayer, dataset] = await Promise.all([
    readStorageObject({ publicClient, config, objectId }),
    publicClient.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "getAccountUsage",
      args: [config.accountId],
    }),
    publicClient.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "getCopyReceipts",
      args: [objectId],
    }),
    publicClient.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "receiptPayer",
      args: [objectId],
    }),
    publicClient.readContract({
      address: config.registryAddress,
      abi: registryAbi,
      functionName: "getDatasetRecord",
      args: [config.accountId, BigInt(config.providerId), BigInt(config.datasetId)],
    }),
  ]);

  const evidence = buildEvidence({
    config,
    objectId,
    txHashes,
    finalObject,
    usage,
    copyReceipts,
    receiptPayer,
    dataset,
  });

  if (write) {
    await writeFile(config.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  return {
    evidence,
    summary: {
      written: write ? config.evidencePath : null,
      registry: config.registryAddress,
      objectId: objectId.toString(),
      accountId: config.accountId,
      status: evidence.demo.status,
      pieceCid: config.pieceCid,
      txHashes,
    },
  };
}

async function loadConfig(env) {
  const privateKey = normalizePrivateKey(env.PRIVATE_KEY ?? env.PLATFORM_ROOT_PRIVATE_KEY);
  const account = privateKeyToAccount(privateKey);
  const registryAddress = normalizeAddress(
    env.FOC_PLATFORM_REGISTRY_ADDRESS ?? DEFAULT_REGISTRY_ADDRESS,
    "FOC_PLATFORM_REGISTRY_ADDRESS",
  );
  const payloadPath = env.FOC_PLATFORM_DEMO_PAYLOAD_PATH ?? "/tmp/foc-platform-calibration-demo.bin";
  const payload = await readFile(payloadPath);
  const pieceCid = required(env.FOC_PLATFORM_DEMO_PIECE_CID, "FOC_PLATFORM_DEMO_PIECE_CID");
  const retrievalUrl = required(
    env.FOC_PLATFORM_DEMO_RETRIEVAL_URL,
    "FOC_PLATFORM_DEMO_RETRIEVAL_URL",
  );
  const providerId = env.FOC_PLATFORM_DEMO_PROVIDER_ID ?? "4";
  const datasetId = env.FOC_PLATFORM_DEMO_DATASET_ID ?? "12524";
  const pieceId = env.FOC_PLATFORM_DEMO_PIECE_ID ?? "34";
  const { uploadTxHash, addPieceTxHash } = normalizeDemoUploadTxHash(env);
  const accountId = normalizeBytes32(
    env.FOC_PLATFORM_DEMO_ACCOUNT_ID ??
      keccak256(stringToHex("foc-platform:calibration-demo:issue-15:account")),
    "FOC_PLATFORM_DEMO_ACCOUNT_ID",
  );
  const idempotencyKey = normalizeBytes32(
    env.FOC_PLATFORM_DEMO_IDEMPOTENCY_KEY ??
      keccak256(stringToHex(`foc-platform:calibration-demo:issue-15:${pieceCid}:${pieceId}`)),
    "FOC_PLATFORM_DEMO_IDEMPOTENCY_KEY",
  );
  const metadata = {
    project: "foc-platform",
    issue: "15",
    purpose: "calibration-demo",
    pieceCid,
    datasetId,
    providerId,
  };
  const contentHash = keccak256(payload);
  const metadataHash = keccak256(stringToHex(stableJson(metadata)));
  const size = BigInt(payload.byteLength);
  const actualCost = BigInt(env.FOC_PLATFORM_DEMO_ACTUAL_COST ?? "0");
  const maxCost = BigInt(env.FOC_PLATFORM_DEMO_MAX_COST ?? "1000000000000000000");
  const receiptHash = keccak256(
    stringToHex(
      stableJson({
        ...metadata,
        pieceId,
        retrievalUrl,
        addPieceTxHash,
        contentHash,
        metadataHash,
        actualCost: actualCost.toString(),
      }),
    ),
  );

  return {
    account,
    registryAddress,
    rpcUrl: env.FILECOIN_CALIBRATION_RPC_URL ?? DEFAULT_RPC_URL,
    evidencePath: env.FOC_PLATFORM_DEMO_EVIDENCE_PATH ?? DEFAULT_EVIDENCE_PATH,
    gas: BigInt(env.FOC_PLATFORM_DEMO_GAS_LIMIT ?? DEFAULT_GAS_LIMIT.toString()),
    payloadPath,
    pieceCid,
    retrievalUrl,
    uploadTxHash,
    providerId,
    datasetId,
    pieceId,
    accountId,
    idempotencyKey,
    contentHash,
    metadataHash,
    storageClass: keccak256(stringToHex("foc-calibration-pdp")),
    requestParams: {
      accountId,
      user: account.address,
      idempotencyKey,
      contentHash,
      metadataHash,
      size,
      requestedCopies: 1,
      withCDN: false,
      maxCost,
      requestExpiresAt: 0n,
    },
    receipt: {
      finalizationStatus: 0,
      payer: account.address,
      pieceCidHash: keccak256(stringToHex(pieceCid)),
      size,
      requestedCopies: 1,
      completedCopies: 1,
      actualCost,
      receiptHash,
      copies: [
        {
          providerId: BigInt(providerId),
          datasetId: BigInt(datasetId),
          pieceId: BigInt(pieceId),
          addPieceTxHash,
          retrievalUrlHash: keccak256(stringToHex(retrievalUrl)),
          isNewDataSet: false,
        },
      ],
    },
  };
}

export function normalizeDemoUploadTxHash(env = {}) {
  const primaryUploadTxHash = String(env.FOC_PLATFORM_DEMO_UPLOAD_TX_HASH ?? "").trim();
  const aliasUploadTxHash = String(env.FOC_PLATFORM_DEMO_ADD_PIECE_TX_HASH ?? "").trim();
  const rawUploadTxHash = primaryUploadTxHash || aliasUploadTxHash;
  const addPieceTxHash = normalizeBytes32(
    rawUploadTxHash || ZERO_BYTES32,
    "FOC_PLATFORM_DEMO_UPLOAD_TX_HASH or FOC_PLATFORM_DEMO_ADD_PIECE_TX_HASH",
  );
  return {
    uploadTxHash: rawUploadTxHash ? addPieceTxHash : null,
    addPieceTxHash,
  };
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

async function readCoordinatorPolicy({ publicClient, config }) {
  const policy = await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "coordinatorPolicies",
    args: [config.account.address],
  });
  return {
    allowed: Boolean(policy.allowed ?? policy[0]),
    maxFinalizeDelay: BigInt(policy.maxFinalizeDelay ?? policy[1]),
    sessionKeyExpiresAt: BigInt(policy.sessionKeyExpiresAt ?? policy[2]),
    permissionsHash: policy.permissionsHash ?? policy[3],
  };
}

async function readObjectByIdempotencyKey({ publicClient, config }) {
  return await publicClient.readContract({
    address: config.registryAddress,
    abi: registryAbi,
    functionName: "objectByIdempotencyKey",
    args: [config.accountId, config.idempotencyKey],
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

async function sendAndWait({ publicClient, walletClient, config, functionName, args }) {
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
  return hash;
}

function buildEvidence({
  config,
  objectId,
  txHashes,
  finalObject,
  usage,
  copyReceipts,
  receiptPayer,
  dataset,
}) {
  const status = Number(finalObject.status ?? finalObject[14]);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "calibration_live_evidence",
    network: "filecoin_calibration",
    chainId: 314159,
    registry: {
      address: config.registryAddress,
      deployTxHash: "0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552",
      deployBlock: "3852147",
      runtimeSha256:
        "0xed478a27e255a1b27989ffa4f2fcbf38f1a9ec61a84c8d3e20aceb4e26f72040",
      rootAddress: config.account.address,
    },
    demo: {
      status: STATUS_LABELS[status] ?? `Unknown(${status})`,
      objectId: objectId.toString(),
      accountId: config.accountId,
      providerId: config.providerId,
      datasetId: config.datasetId,
      pieceId: config.pieceId,
      pieceCid: config.pieceCid,
      retrievalUrl: config.retrievalUrl,
      uploadTxHash: config.uploadTxHash,
      uploadEvidence: "FOC MCP upload call timed out locally, but dataset read shows piece metadata.",
      registryTxHashes: txHashes,
      request: jsonSafe(config.requestParams),
      receipt: jsonSafe(config.receipt),
      onchain: {
        object: jsonSafe(finalObject),
        usage: jsonSafe(usage),
        copyReceipts: jsonSafe(copyReceipts),
        receiptPayer,
        dataset: jsonSafe(dataset),
      },
    },
    worker: {
      mode: "read_only_public_evidence",
      privilegedActions: false,
      servesPrivateKeys: false,
    },
    tokenHost: {
      mode: "hand_written_registry_wrapper",
      manifestPath: "artifacts/tokenhost/foc-platform-wrapper-manifest.json",
    },
    limitations: [
      "The FOC upload was performed through the local foc-storage MCP tool using local credentials.",
      "The upload client timed out before returning an add-piece transaction hash; provider dataset state proves the piece exists.",
      "The registry receipt uses zero actualCost because the timed-out upload result did not return a cost field.",
      "The Worker remains read-only and does not hold or use private keys.",
    ],
  };
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

function normalizeBytes32(value, label) {
  const raw = required(value, label);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${label} must be bytes32 hex`);
  }
  return raw.toLowerCase();
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} is required`);
  }
  return String(value).trim();
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

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function isMainModule(metaUrl, entrypoint) {
  return Boolean(entrypoint) && metaUrl === pathToFileURL(resolve(entrypoint)).href;
}
