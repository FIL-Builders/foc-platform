import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
} from "viem";
import { foundry } from "viem/chains";

import {
  applyRegistryEvents,
  decodeRegistryLog,
  registryAbi,
  registryArtifact,
  registryCopyReceiptsRead,
  registryObjectRead,
  registryReceiptPayerRead,
  registryUsageRead,
} from "../registry/read-model.mjs";

const UPLOAD_STATUS = [
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

const FINALIZATION_STATUS = ["Committed", "Partial", "Failed"];
const DEV_ANVIL_TRANSACTION_GAS = 5_000_000n;

export const DEV_UPLOAD_SPINE_FIXTURE = Object.freeze({
  accountId: devHash("account:demo-customer"),
  idempotencyKey: devHash("idempotency:demo-upload-001"),
  contentHash: devHash("content:hello-foc-platform"),
  metadataHash: devHash("metadata:application-json"),
  pieceCidHash: devHash("piece-cid:baga6ea4seaqdemo"),
  receiptHash: devHash("receipt:mocked-foc-finalization"),
  permissionsHash: devHash("permissions:dev-coordinator"),
  size: 2048n,
  requestedCopies: 2,
  withCDN: true,
  maxCost: parseEther("0.005"),
  actualCost: parseEther("0.003"),
  copies: Object.freeze([
    Object.freeze({
      providerId: 111n,
      datasetId: 222n,
      pieceId: 333n,
      addPieceTxHash: devHash("copy:provider-111:add-piece"),
      retrievalUrlHash: devHash("copy:provider-111:retrieval-url"),
      isNewDataSet: true,
    }),
    Object.freeze({
      providerId: 112n,
      datasetId: 223n,
      pieceId: 334n,
      addPieceTxHash: devHash("copy:provider-112:add-piece"),
      retrievalUrlHash: devHash("copy:provider-112:retrieval-url"),
      isNewDataSet: false,
    }),
  ]),
});

export async function runDevUploadSpine({ rpcUrl, chain = foundry, accounts } = {}) {
  if (!rpcUrl) {
    throw new Error("runDevUploadSpine requires rpcUrl");
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const roles = await resolveDevAccounts(publicClient, accounts);
  const rootClient = createRoleWallet(rpcUrl, chain, roles.platformRoot);
  const relayerClient = createRoleWallet(rpcUrl, chain, roles.relayer);
  const coordinatorClient = createRoleWallet(rpcUrl, chain, roles.coordinator);

  const deployTx = await rootClient.deployContract({
    abi: registryAbi,
    bytecode: registryArtifact.bytecode,
    gas: DEV_ANVIL_TRANSACTION_GAS,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
  assertSuccessfulReceipt(deployReceipt, "deploy registry");
  if (!deployReceipt.contractAddress) {
    throw new Error(`registry deployment did not return a contract address: ${deployTx}`);
  }
  const registryAddress = deployReceipt.contractAddress;

  const latestBlock = await publicClient.getBlock();
  const requestExpiresAt = latestBlock.timestamp + 3600n;

  const setRelayerReceipt = await writeAndWait(
    publicClient,
    rootClient,
    registryAddress,
    "setRelayer",
    [roles.relayer, true],
  );
  const setCoordinatorReceipt = await writeAndWait(
    publicClient,
    rootClient,
    registryAddress,
    "setCoordinator",
    [
      roles.coordinator,
      {
        allowed: true,
        maxFinalizeDelay: 3600n,
        sessionKeyExpiresAt: 0n,
        permissionsHash: DEV_UPLOAD_SPINE_FIXTURE.permissionsHash,
      },
    ],
  );

  const request = {
    accountId: DEV_UPLOAD_SPINE_FIXTURE.accountId,
    user: roles.user,
    idempotencyKey: DEV_UPLOAD_SPINE_FIXTURE.idempotencyKey,
    contentHash: DEV_UPLOAD_SPINE_FIXTURE.contentHash,
    metadataHash: DEV_UPLOAD_SPINE_FIXTURE.metadataHash,
    size: DEV_UPLOAD_SPINE_FIXTURE.size,
    requestedCopies: DEV_UPLOAD_SPINE_FIXTURE.requestedCopies,
    withCDN: DEV_UPLOAD_SPINE_FIXTURE.withCDN,
    maxCost: DEV_UPLOAD_SPINE_FIXTURE.maxCost,
    requestExpiresAt,
  };

  const requestReceipt = await writeAndWait(
    publicClient,
    relayerClient,
    registryAddress,
    "requestUpload",
    [request, "0x"],
  );
  const objectId = await publicClient.readContract({
    address: registryAddress,
    abi: registryAbi,
    functionName: "objectByIdempotencyKey",
    args: [request.accountId, request.idempotencyKey],
  });

  const startReceipt = await writeAndWait(
    publicClient,
    coordinatorClient,
    registryAddress,
    "startUpload",
    [objectId],
  );

  const receipt = {
    finalizationStatus: 0,
    payer: roles.platformRoot,
    pieceCidHash: DEV_UPLOAD_SPINE_FIXTURE.pieceCidHash,
    size: request.size,
    requestedCopies: request.requestedCopies,
    completedCopies: DEV_UPLOAD_SPINE_FIXTURE.copies.length,
    actualCost: DEV_UPLOAD_SPINE_FIXTURE.actualCost,
    receiptHash: DEV_UPLOAD_SPINE_FIXTURE.receiptHash,
    copies: DEV_UPLOAD_SPINE_FIXTURE.copies,
  };
  const finalizeReceipt = await writeAndWait(
    publicClient,
    coordinatorClient,
    registryAddress,
    "finalizeUpload",
    [objectId, receipt],
  );

  const reads = {
    object: normalizeStorageObject(
      await publicClient.readContract(registryObjectRead(registryAddress, objectId)),
    ),
    usage: normalizeUsage(
      await publicClient.readContract(registryUsageRead(registryAddress, request.accountId)),
    ),
    copyReceipts: normalizeCopyReceipts(
      await publicClient.readContract(registryCopyReceiptsRead(registryAddress, objectId)),
    ),
    receiptPayer: await publicClient.readContract(
      registryReceiptPayerRead(registryAddress, objectId),
    ),
  };

  const events = await readRegistryReceiptEvents(publicClient, registryAddress, [
    deployReceipt,
    setRelayerReceipt,
    setCoordinatorReceipt,
    requestReceipt,
    startReceipt,
    finalizeReceipt,
  ]);
  const projection = applyRegistryEvents(events);
  const objectKey = decimal(objectId);
  const demoStatus = createDemoStatus({
    objectId,
    roles,
    request,
    receipt,
    reads,
    projection,
  });

  return {
    registryAddress,
    chainId: decimal(await publicClient.getChainId()),
    objectId: objectKey,
    roles,
    mocked: mockedBoundary(),
    request: normalizeRequest(request),
    receipt: normalizeReceipt(receipt),
    reads,
    projection: {
      object: projection.objects[objectKey],
      usage: projection.usage[request.accountId],
      copyReceipts: projection.copyReceipts[objectKey] ?? [],
      receiptPayer: projection.receiptPayers[objectKey],
    },
    demoStatus,
    events: events.map(summarizeEvent),
  };
}

function createRoleWallet(rpcUrl, chain, account) {
  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
}

async function resolveDevAccounts(publicClient, accounts) {
  const addresses = accounts ?? (await publicClient.request({ method: "eth_accounts" }));
  if (!Array.isArray(addresses) || addresses.length < 4) {
    throw new Error("dev upload spine requires at least four unlocked JSON-RPC accounts");
  }

  return {
    platformRoot: getAddress(addresses[0]),
    user: getAddress(addresses[1]),
    relayer: getAddress(addresses[2]),
    coordinator: getAddress(addresses[3]),
  };
}

async function writeAndWait(publicClient, walletClient, registryAddress, functionName, args) {
  const hash = await walletClient.writeContract({
    address: registryAddress,
    abi: registryAbi,
    functionName,
    args,
    gas: DEV_ANVIL_TRANSACTION_GAS,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assertSuccessfulReceipt(receipt, functionName);
  return receipt;
}

async function readRegistryReceiptEvents(publicClient, address, receipts) {
  const blockCache = new Map();
  const events = [];

  for (const receipt of receipts) {
    const key = decimal(receipt.blockNumber);
    let block = blockCache.get(key);
    if (!block) {
      block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      blockCache.set(key, block);
    }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address.toLowerCase()) continue;
      events.push(decodeRegistryLog({ ...log, blockTimestamp: block.timestamp }));
    }
  }

  return events;
}

function assertSuccessfulReceipt(receipt, label) {
  if (receipt.status !== "success") {
    throw new Error(`${label} transaction failed: ${receipt.transactionHash}`);
  }
}

function createDemoStatus({ objectId, roles, request, receipt, reads, projection }) {
  return {
    objectId: decimal(objectId),
    accountId: request.accountId,
    user: request.user,
    status: reads.object.status,
    size: decimal(request.size),
    requestedCopies: request.requestedCopies,
    completedCopies: reads.object.completedCopies,
    withCDN: request.withCDN,
    payer: reads.receiptPayer,
    contentHash: request.contentHash,
    metadataHash: request.metadataHash,
    pieceCidHash: reads.object.pieceCidHash,
    receiptHash: reads.object.receiptHash,
    usage: reads.usage,
    copyReceipts: reads.copyReceipts,
    coordinator: roles.coordinator,
    projectedStatus: projection.objects[decimal(objectId)]?.status,
    mocked: mockedBoundary(),
    tokenHostBinding: {
      contractReads: ["getStorageObject", "getAccountUsage", "getCopyReceipts", "receiptPayer"],
      eventProjection: [
        "UploadRequested",
        "UploadStarted",
        "CopyRecorded",
        "UsageReleased",
        "UsageFinalized",
        "ReceiptPayerRecorded",
        "UploadFinalized",
      ],
      stableFixtureFields: {
        accountId: request.accountId,
        idempotencyKey: request.idempotencyKey,
        receiptHash: receipt.receiptHash,
      },
    },
  };
}

function mockedBoundary() {
  return {
    network: "local Anvil only",
    focBytesMoved: false,
    coordinator: "dev wallet role calls startUpload and finalizeUpload",
    receipt: "deterministic fixture; no Synapse SDK or Filecoin Calibration transaction",
    productionSemantics: [
      "registry access control",
      "idempotency",
      "request lifecycle",
      "receipt validation",
      "copy receipts",
      "usage accounting",
      "contract reads",
      "event projection",
    ],
  };
}

function normalizeRequest(request) {
  return {
    accountId: request.accountId,
    user: request.user,
    idempotencyKey: request.idempotencyKey,
    contentHash: request.contentHash,
    metadataHash: request.metadataHash,
    size: decimal(request.size),
    requestedCopies: request.requestedCopies,
    withCDN: request.withCDN,
    maxCost: decimal(request.maxCost),
    requestExpiresAt: decimal(request.requestExpiresAt),
  };
}

function normalizeReceipt(receipt) {
  return {
    finalizationStatus: FINALIZATION_STATUS[receipt.finalizationStatus],
    payer: receipt.payer,
    pieceCidHash: receipt.pieceCidHash,
    size: decimal(receipt.size),
    requestedCopies: receipt.requestedCopies,
    completedCopies: receipt.completedCopies,
    actualCost: decimal(receipt.actualCost),
    receiptHash: receipt.receiptHash,
    copies: normalizeCopyReceipts(receipt.copies),
  };
}

function normalizeStorageObject(value) {
  return {
    objectId: decimal(tupleValue(value, "objectId", 0)),
    accountId: tupleValue(value, "accountId", 1),
    user: tupleValue(value, "user", 2),
    idempotencyKey: tupleValue(value, "idempotencyKey", 3),
    contentHash: tupleValue(value, "contentHash", 4),
    metadataHash: tupleValue(value, "metadataHash", 5),
    pieceCidHash: tupleValue(value, "pieceCidHash", 6),
    size: decimal(tupleValue(value, "size", 7)),
    requestedCopies: number(tupleValue(value, "requestedCopies", 8)),
    completedCopies: number(tupleValue(value, "completedCopies", 9)),
    withCDN: Boolean(tupleValue(value, "withCDN", 10)),
    maxCost: decimal(tupleValue(value, "maxCost", 11)),
    reservedCost: decimal(tupleValue(value, "reservedCost", 12)),
    actualCost: decimal(tupleValue(value, "actualCost", 13)),
    status: UPLOAD_STATUS[number(tupleValue(value, "status", 14))],
    coordinator: tupleValue(value, "coordinator", 15),
    requestExpiresAt: decimal(tupleValue(value, "requestExpiresAt", 16)),
    createdAt: decimal(tupleValue(value, "createdAt", 17)),
    updatedAt: decimal(tupleValue(value, "updatedAt", 18)),
    receiptHash: tupleValue(value, "receiptHash", 19),
  };
}

function normalizeUsage(value) {
  return {
    activeBytes: decimal(tupleValue(value, "activeBytes", 0)),
    activeObjects: decimal(tupleValue(value, "activeObjects", 1)),
    pendingBytes: decimal(tupleValue(value, "pendingBytes", 2)),
    reservedCost: decimal(tupleValue(value, "reservedCost", 3)),
    totalActualCost: decimal(tupleValue(value, "totalActualCost", 4)),
    totalUploadedBytes: decimal(tupleValue(value, "totalUploadedBytes", 5)),
    totalRequestedUploads: decimal(tupleValue(value, "totalRequestedUploads", 6)),
    totalFinalizedUploads: decimal(tupleValue(value, "totalFinalizedUploads", 7)),
    totalFailedUploads: decimal(tupleValue(value, "totalFailedUploads", 8)),
  };
}

function normalizeCopyReceipts(copies) {
  return Array.from(copies).map((copy) => ({
    providerId: decimal(tupleValue(copy, "providerId", 0)),
    datasetId: decimal(tupleValue(copy, "datasetId", 1)),
    pieceId: decimal(tupleValue(copy, "pieceId", 2)),
    addPieceTxHash: tupleValue(copy, "addPieceTxHash", 3),
    retrievalUrlHash: tupleValue(copy, "retrievalUrlHash", 4),
    isNewDataSet: Boolean(tupleValue(copy, "isNewDataSet", 5)),
  }));
}

function summarizeEvent(event) {
  return {
    eventName: event.eventName,
    blockNumber: decimal(event.blockNumber),
    logIndex: decimal(event.logIndex),
    transactionHash: event.transactionHash,
    args: jsonSafe(event.args),
  };
}

function tupleValue(value, field, index) {
  if (Object.prototype.hasOwnProperty.call(value, field)) return value[field];
  return value[index];
}

function jsonSafe(value) {
  if (typeof value === "bigint") return decimal(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function decimal(value) {
  return (typeof value === "bigint" ? value : BigInt(value)).toString();
}

function number(value) {
  return Number(typeof value === "bigint" ? value : BigInt(value));
}

function devHash(label) {
  return keccak256(stringToHex(`foc-platform-dev:${label}`));
}
