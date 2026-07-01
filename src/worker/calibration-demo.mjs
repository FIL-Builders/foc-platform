import { createPublicClient, getAddress, http, isAddress } from "viem";
import { filecoinCalibration } from "viem/chains";

const DEFAULT_REGISTRY_ADDRESS = "0x7771d916a9d742B1D60597a332C7ABBd5796609c";
const DEFAULT_REGISTRY_DEPLOY_TX =
  "0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552";
const DEFAULT_REGISTRY_RUNTIME_SHA256 =
  "0xed478a27e255a1b27989ffa4f2fcbf38f1a9ec61a84c8d3e20aceb4e26f72040";
const DEFAULT_RPC_URL = "https://api.calibration.node.glif.io/rpc/v1";
const UPLOAD_STATUS_LABELS = Object.freeze([
  "None",
  "Requested",
  "Uploading",
  "Committed",
  "Partial",
  "Failed",
  "Cancelled",
  "Expired",
  "Deleted",
]);

// Kept local to make the deployed Worker bundle independent of Node-oriented
// artifact generation modules.
const REGISTRY_READ_ABI = [
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextObjectId",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getStorageObject",
    inputs: [{ name: "objectId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "objectId", type: "uint256" },
          { name: "accountId", type: "bytes32" },
          { name: "user", type: "address" },
          { name: "idempotencyKey", type: "bytes32" },
          { name: "contentHash", type: "bytes32" },
          { name: "metadataHash", type: "bytes32" },
          { name: "pieceCidHash", type: "bytes32" },
          { name: "size", type: "uint64" },
          { name: "requestedCopies", type: "uint8" },
          { name: "completedCopies", type: "uint8" },
          { name: "withCDN", type: "bool" },
          { name: "maxCost", type: "uint256" },
          { name: "reservedCost", type: "uint256" },
          { name: "actualCost", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "coordinator", type: "address" },
          { name: "requestExpiresAt", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "updatedAt", type: "uint64" },
          { name: "receiptHash", type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAccountUsage",
    inputs: [{ name: "accountId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "activeBytes", type: "uint256" },
          { name: "activeObjects", type: "uint256" },
          { name: "pendingBytes", type: "uint256" },
          { name: "reservedCost", type: "uint256" },
          { name: "totalActualCost", type: "uint256" },
          { name: "totalUploadedBytes", type: "uint256" },
          { name: "totalRequestedUploads", type: "uint256" },
          { name: "totalFinalizedUploads", type: "uint256" },
          { name: "totalFailedUploads", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getCopyReceipts",
    inputs: [{ name: "objectId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "providerId", type: "uint256" },
          { name: "datasetId", type: "uint256" },
          { name: "pieceId", type: "uint256" },
          { name: "addPieceTxHash", type: "bytes32" },
          { name: "retrievalUrlHash", type: "bytes32" },
          { name: "isNewDataSet", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "receiptPayer",
    inputs: [{ name: "objectId", type: "uint256" }],
    outputs: [{ name: "payer", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDatasetRecord",
    inputs: [
      { name: "accountId", type: "bytes32" },
      { name: "providerId", type: "uint256" },
      { name: "datasetId", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "accountId", type: "bytes32" },
          { name: "payer", type: "address" },
          { name: "providerId", type: "uint256" },
          { name: "datasetId", type: "uint256" },
          { name: "storageClass", type: "bytes32" },
          { name: "withCDN", type: "bool" },
          { name: "createdAt", type: "uint64" },
          { name: "updatedAt", type: "uint64" },
        ],
      },
    ],
    stateMutability: "view",
  },
];

export default {
  async fetch(request, env, ctx) {
    return handleCalibrationDemoRequest(request, env, { ctx });
  },
};

export async function handleCalibrationDemoRequest(request, env = {}, options = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: { code: "method_not_allowed" } }, { status: 405 });
  }

  const url = new URL(request.url);
  const evidence = buildDemoEvidence(env);
  const shouldReadRegistry = url.searchParams.get("live") !== "false";

  if (url.pathname === "/" || url.pathname === "/demo") {
    return htmlResponse(renderDemoHtml(evidence));
  }

  if (url.pathname === "/api/health") {
    return jsonResponse({
      ok: true,
      service: "foc-platform-calibration-demo",
      mode: evidence.mode,
      registryAddress: evidence.registry.address,
      privilegedActions: false,
    });
  }

  if (url.pathname === "/api/demo/evidence") {
    return jsonResponse(withLinks(evidence, url));
  }

  if (url.pathname === "/api/demo/registry") {
    if (!shouldReadRegistry) {
      return jsonResponse({
        source: "skipped",
        evidence: withLinks(evidence, url),
      });
    }

    const readRegistrySnapshot = options.readRegistrySnapshot ?? readPublicRegistrySnapshot;
    try {
      return jsonResponse({
        source: "filecoin_calibration_public_rpc",
        evidence: withLinks(evidence, url),
        registry: await readRegistrySnapshot(evidence, env),
      });
    } catch (error) {
      return jsonResponse(
        {
          error: {
            code: "registry_read_failed",
            message: error?.message ?? "registry read failed",
          },
          evidence: withLinks(evidence, url),
        },
        { status: 502 },
      );
    }
  }

  return jsonResponse({ error: { code: "not_found" } }, { status: 404 });
}

export function buildDemoEvidence(env = {}) {
  const registryAddress = optionalString(env.FOC_PLATFORM_REGISTRY_ADDRESS) ?? DEFAULT_REGISTRY_ADDRESS;
  const objectId = optionalString(env.FOC_PLATFORM_DEMO_OBJECT_ID);
  const accountId = normalizeBytes32(optionalString(env.FOC_PLATFORM_DEMO_ACCOUNT_ID));
  const providerId = optionalString(env.FOC_PLATFORM_DEMO_PROVIDER_ID);
  const datasetId = optionalString(env.FOC_PLATFORM_DEMO_DATASET_ID);
  const registryTxHashes = parseJsonObject(env.FOC_PLATFORM_DEMO_REGISTRY_TX_HASHES_JSON);

  return {
    schemaVersion: 1,
    generatedAt: optionalString(env.FOC_PLATFORM_DEMO_GENERATED_AT) ?? new Date(0).toISOString(),
    mode: optionalString(env.FOC_PLATFORM_DEMO_MODE) ?? "partial_phase0_registry_only",
    network: optionalString(env.FOC_PLATFORM_DEMO_NETWORK) ?? "filecoin_calibration",
    chainId: parsePositiveInteger(env.FOC_PLATFORM_DEMO_CHAIN_ID, 314159),
    registry: {
      address: isAddress(registryAddress) ? getAddress(registryAddress) : registryAddress,
      deployTxHash: optionalString(env.FOC_PLATFORM_REGISTRY_DEPLOY_TX) ?? DEFAULT_REGISTRY_DEPLOY_TX,
      deployBlock: optionalString(env.FOC_PLATFORM_REGISTRY_DEPLOY_BLOCK) ?? "3852147",
      runtimeSha256:
        optionalString(env.FOC_PLATFORM_REGISTRY_RUNTIME_SHA256) ??
        DEFAULT_REGISTRY_RUNTIME_SHA256,
    },
    demo: {
      status:
        optionalString(env.FOC_PLATFORM_DEMO_STATUS) ??
        (objectId ? "configured_live_object" : "pending_live_upload"),
      objectId,
      accountId,
      providerId,
      datasetId,
      pieceId: optionalString(env.FOC_PLATFORM_DEMO_PIECE_ID),
      pieceCid: optionalString(env.FOC_PLATFORM_DEMO_PIECE_CID),
      retrievalUrl: optionalString(env.FOC_PLATFORM_DEMO_RETRIEVAL_URL),
      uploadTxHash: optionalString(env.FOC_PLATFORM_DEMO_UPLOAD_TX_HASH),
      registryTxHashes,
    },
    worker: {
      mode: "read_only_public_evidence",
      privilegedActions: false,
      servesPrivateKeys: false,
      endpoints: ["/", "/api/health", "/api/demo/evidence", "/api/demo/registry"],
    },
    boundaries: [
      "The Worker serves public evidence and performs public registry reads only.",
      "Local operator scripts perform privileged FOC upload and registry transaction submission.",
      "No signing credentials belong in wrangler.jsonc, Worker source, generated UI, or committed artifacts.",
    ],
  };
}

export async function readPublicRegistrySnapshot(evidence, env = {}) {
  const rpcUrl = optionalString(env.FILECOIN_CALIBRATION_RPC_URL) ?? DEFAULT_RPC_URL;
  const client = createPublicClient({
    chain: filecoinCalibration,
    transport: http(rpcUrl),
  });
  const address = evidence.registry.address;
  if (!isAddress(address)) {
    throw new Error("FOC_PLATFORM_REGISTRY_ADDRESS must be an EVM address");
  }

  const [owner, nextObjectId] = await Promise.all([
    client.readContract({ address, abi: REGISTRY_READ_ABI, functionName: "owner" }),
    client.readContract({ address, abi: REGISTRY_READ_ABI, functionName: "nextObjectId" }),
  ]);

  const snapshot = {
    checkedAt: new Date().toISOString(),
    rpcUrl,
    owner,
    nextObjectId: decimal(nextObjectId),
  };

  const objectId = evidence.demo.objectId;
  if (objectId) {
    const [object, copyReceipts, receiptPayer] = await Promise.all([
      client.readContract({
        address,
        abi: REGISTRY_READ_ABI,
        functionName: "getStorageObject",
        args: [BigInt(objectId)],
      }),
      client.readContract({
        address,
        abi: REGISTRY_READ_ABI,
        functionName: "getCopyReceipts",
        args: [BigInt(objectId)],
      }),
      client.readContract({
        address,
        abi: REGISTRY_READ_ABI,
        functionName: "receiptPayer",
        args: [BigInt(objectId)],
      }),
    ]);

    snapshot.object = formatStorageObject(object);
    snapshot.copyReceipts = Array.from(copyReceipts ?? []).map(formatCopyReceipt);
    snapshot.receiptPayer = receiptPayer;
  }

  if (evidence.demo.accountId) {
    const usage = await client.readContract({
      address,
      abi: REGISTRY_READ_ABI,
      functionName: "getAccountUsage",
      args: [evidence.demo.accountId],
    });
    snapshot.usage = formatAccountUsage(usage);
  }

  if (evidence.demo.accountId && evidence.demo.providerId && evidence.demo.datasetId) {
    const dataset = await client.readContract({
      address,
      abi: REGISTRY_READ_ABI,
      functionName: "getDatasetRecord",
      args: [
        evidence.demo.accountId,
        BigInt(evidence.demo.providerId),
        BigInt(evidence.demo.datasetId),
      ],
    });
    snapshot.dataset = formatDatasetRecord(dataset);
  }

  return snapshot;
}

function renderDemoHtml(evidence) {
  const status = evidence.demo.status;
  const registry = evidence.registry.address;
  const objectId = evidence.demo.objectId ?? "not configured";
  const pieceCid = evidence.demo.pieceCid ?? "pending";
  const retrievalUrl = evidence.demo.retrievalUrl;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FOC Platform Calibration Demo</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #17201c;
      --muted: #62706a;
      --line: #d8ddd6;
      --surface: #ffffff;
      --accent: #2f6f5e;
      --warn: #b85c38;
      --code: #26312d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { min-height: 100svh; }
    .hero {
      min-height: 52svh;
      padding: clamp(36px, 7vw, 86px);
      display: grid;
      align-items: end;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(115deg, rgba(47,111,94,.18), rgba(184,92,56,.10) 48%, rgba(255,255,255,.55)),
        var(--bg);
    }
    .hero h1 {
      max-width: 920px;
      margin: 0;
      font-size: clamp(38px, 7vw, 86px);
      line-height: .96;
      letter-spacing: 0;
    }
    .hero p {
      max-width: 720px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: clamp(16px, 2vw, 21px);
    }
    .bar {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      padding: 18px clamp(20px, 7vw, 86px);
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.72);
    }
    .bar a {
      color: var(--accent);
      font-weight: 700;
      text-decoration: none;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr);
      gap: clamp(24px, 5vw, 64px);
      padding: clamp(28px, 7vw, 86px);
    }
    section { border-top: 1px solid var(--line); padding-top: 18px; }
    h2 { margin: 0 0 18px; font-size: 18px; letter-spacing: 0; }
    dl { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 10px 18px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--code); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      background: var(--surface);
      font-weight: 700;
      color: ${status === "pending_live_upload" ? "var(--warn)" : "var(--accent)"};
    }
    .flow {
      display: grid;
      gap: 10px;
      margin-top: 18px;
    }
    .step {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 14px;
      align-items: start;
      padding: 14px 0;
      border-top: 1px solid var(--line);
    }
    .num {
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--accent);
      color: white;
      font-size: 13px;
      font-weight: 800;
    }
    .step strong { display: block; margin-bottom: 2px; }
    .step span { color: var(--muted); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width: 760px) {
      .hero { min-height: 44svh; padding: 30px 20px; }
      .bar { padding: 14px 20px; }
      .grid { grid-template-columns: 1fr; padding: 28px 20px; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<main>
  <div class="hero">
    <div>
      <h1>FOC Platform Calibration Demo</h1>
      <p>Read-only Worker surface for the Filecoin Calibration registry, Token Host wrapper metadata, and local FOC upload evidence.</p>
    </div>
  </div>
  <nav class="bar" aria-label="Demo endpoints">
    <a href="/api/health">Health</a>
    <a href="/api/demo/evidence">Evidence JSON</a>
    <a href="/api/demo/registry">Live registry read</a>
  </nav>
  <div class="grid">
    <section>
      <h2>Lifecycle Evidence</h2>
      <p class="status">${escapeHtml(status)}</p>
      <div class="flow">
        <div class="step"><div class="num">1</div><div><strong>Registry</strong><span>${escapeHtml(registry)}</span></div></div>
        <div class="step"><div class="num">2</div><div><strong>Object</strong><span>${escapeHtml(objectId)}</span></div></div>
        <div class="step"><div class="num">3</div><div><strong>FOC piece</strong><span>${escapeHtml(pieceCid)}</span></div></div>
        <div class="step"><div class="num">4</div><div><strong>Retrieval</strong><span>${retrievalUrl ? `<a href="${escapeAttribute(retrievalUrl)}">${escapeHtml(retrievalUrl)}</a>` : "pending"}</span></div></div>
      </div>
    </section>
    <section>
      <h2>Public Configuration</h2>
      <dl>
        <dt>Network</dt><dd>${escapeHtml(evidence.network)}</dd>
        <dt>Chain ID</dt><dd>${escapeHtml(String(evidence.chainId))}</dd>
        <dt>Mode</dt><dd>${escapeHtml(evidence.mode)}</dd>
        <dt>Deploy tx</dt><dd>${escapeHtml(evidence.registry.deployTxHash)}</dd>
        <dt>Runtime SHA</dt><dd>${escapeHtml(evidence.registry.runtimeSha256)}</dd>
        <dt>Worker authority</dt><dd>read only</dd>
      </dl>
    </section>
  </div>
</main>
</body>
</html>`;
}

function withLinks(evidence, url) {
  const origin = url.origin;
  return {
    ...evidence,
    links: {
      html: `${origin}/`,
      health: `${origin}/api/health`,
      evidence: `${origin}/api/demo/evidence`,
      registry: `${origin}/api/demo/registry`,
    },
  };
}

function formatStorageObject(object) {
  const status = Number(field(object, "status", 14));
  return {
    objectId: decimal(field(object, "objectId", 0)),
    accountId: field(object, "accountId", 1),
    user: field(object, "user", 2),
    idempotencyKey: field(object, "idempotencyKey", 3),
    contentHash: field(object, "contentHash", 4),
    metadataHash: field(object, "metadataHash", 5),
    pieceCidHash: field(object, "pieceCidHash", 6),
    size: decimal(field(object, "size", 7)),
    requestedCopies: Number(field(object, "requestedCopies", 8)),
    completedCopies: Number(field(object, "completedCopies", 9)),
    withCDN: Boolean(field(object, "withCDN", 10)),
    maxCost: decimal(field(object, "maxCost", 11)),
    reservedCost: decimal(field(object, "reservedCost", 12)),
    actualCost: decimal(field(object, "actualCost", 13)),
    status,
    statusLabel: UPLOAD_STATUS_LABELS[status] ?? `Unknown(${String(status)})`,
    coordinator: field(object, "coordinator", 15),
    requestExpiresAt: decimal(field(object, "requestExpiresAt", 16)),
    createdAt: decimal(field(object, "createdAt", 17)),
    updatedAt: decimal(field(object, "updatedAt", 18)),
    receiptHash: field(object, "receiptHash", 19),
  };
}

function formatAccountUsage(usage) {
  return {
    activeBytes: decimal(field(usage, "activeBytes", 0)),
    activeObjects: decimal(field(usage, "activeObjects", 1)),
    pendingBytes: decimal(field(usage, "pendingBytes", 2)),
    reservedCost: decimal(field(usage, "reservedCost", 3)),
    totalActualCost: decimal(field(usage, "totalActualCost", 4)),
    totalUploadedBytes: decimal(field(usage, "totalUploadedBytes", 5)),
    totalRequestedUploads: decimal(field(usage, "totalRequestedUploads", 6)),
    totalFinalizedUploads: decimal(field(usage, "totalFinalizedUploads", 7)),
    totalFailedUploads: decimal(field(usage, "totalFailedUploads", 8)),
  };
}

function formatCopyReceipt(receipt) {
  return {
    providerId: decimal(field(receipt, "providerId", 0)),
    datasetId: decimal(field(receipt, "datasetId", 1)),
    pieceId: decimal(field(receipt, "pieceId", 2)),
    addPieceTxHash: field(receipt, "addPieceTxHash", 3),
    retrievalUrlHash: field(receipt, "retrievalUrlHash", 4),
    isNewDataSet: Boolean(field(receipt, "isNewDataSet", 5)),
  };
}

function formatDatasetRecord(dataset) {
  return {
    accountId: field(dataset, "accountId", 0),
    payer: field(dataset, "payer", 1),
    providerId: decimal(field(dataset, "providerId", 2)),
    datasetId: decimal(field(dataset, "datasetId", 3)),
    storageClass: field(dataset, "storageClass", 4),
    withCDN: Boolean(field(dataset, "withCDN", 5)),
    createdAt: decimal(field(dataset, "createdAt", 6)),
    updatedAt: decimal(field(dataset, "updatedAt", 7)),
  };
}

function field(value, name, index) {
  return value?.[name] ?? value?.[index];
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeBytes32(value) {
  if (!value) return null;
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : value;
}

function parseJsonObject(value) {
  const raw = optionalString(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePositiveInteger(value, fallback) {
  const raw = optionalString(value);
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function decimal(value) {
  if (value === undefined || value === null) return "0";
  return typeof value === "bigint" ? value.toString() : String(value);
}

function htmlResponse(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(jsonSafe(body), null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  const url = String(value);
  if (!/^https?:\/\//.test(url)) return "#";
  return escapeHtml(url);
}
