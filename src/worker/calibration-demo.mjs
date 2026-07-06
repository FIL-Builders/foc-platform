import { createPublicClient, getAddress, http, isAddress } from "viem";
import { filecoinCalibration } from "viem/chains";
import { buildAdminSurfaces } from "../admin/reconciliation.mjs";
import { createTokenHostRegistryDirectReadAdapter } from "../demo/tokenhost-wrapper.mjs";
import {
  createRegistryReadModel,
  registryAccountCountRead,
  registryCoordinatorCountRead,
  registryDatasetRecordCountRead,
  registryDirectReadDefaults,
  registryObjectCountRead,
  registryArtifact,
  registryRelayerCountRead,
} from "../registry/read-model.mjs";

const DEFAULT_REGISTRY_ADDRESS = "0x8F6563Bb9E53aeDfE9d87d4C1E162f0371649c18";
const DEFAULT_REGISTRY_DEPLOY_TX =
  "0xae42c13c50c1b268a1d38389e27d8fa776264b405e28a1cf11a974dd4b178eae";
const DEFAULT_REGISTRY_DEPLOY_BLOCK = "3854411";
const DEFAULT_REGISTRY_RUNTIME_SHA256 =
  "0x2c49443e7a9ebf3337453240e706df249d29f4f217ec948d6c10e9502a199d1f";
const DEFAULT_RPC_URL = "https://api.calibration.node.glif.io/rpc/v1";
const DEFAULT_DASHBOARD_PAGE_LIMIT = 10;
const PAGE_SCOPED_RECONCILIATION_OMITTED_FAMILIES = Object.freeze([
  "account_usage",
  "dataset_records",
  "coordinator_policies",
]);
const PAGE_SCOPED_RECONCILIATION_OMITTED_CODES = new Set([
  "missing_dataset_record",
  "usage_active_bytes_mismatch",
  "usage_pending_bytes_mismatch",
  "usage_reserved_cost_mismatch",
  "account_over_quota",
  "uploading_object_missing_coordinator",
  "uploading_object_disallowed_coordinator",
  "uploading_object_expired_coordinator",
]);
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
const DASHBOARD_API_ENDPOINTS = Object.freeze({
  overview: "/api/admin/overview",
  files: "/api/admin/files",
  accounts: "/api/admin/accounts",
  datasets: "/api/admin/datasets",
  coordinators: "/api/admin/coordinators",
  reconciliation: "/api/admin/reconciliation",
});

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
  const shouldReadDashboard = dashboardLiveReadsEnabled(url, evidence);
  const shouldReadRegistry = url.searchParams.get("live") !== "false";

  if (url.pathname === "/" || url.pathname === "/demo" || url.pathname === "/admin") {
    return htmlResponse(renderAdminDashboardHtml(evidence, { live: shouldReadDashboard }));
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

  if (url.pathname.startsWith("/api/admin/")) {
    const dashboardRoute = dashboardApiRoute(url.pathname);
    if (!dashboardRoute) {
      return jsonResponse({ error: { code: "not_found" } }, { status: 404 });
    }

    if (!shouldReadDashboard) {
      return jsonResponse({
        source: "skipped",
        route: dashboardRoute,
        metadata: dashboardMetadata(evidence, env),
        evidence: withLinks(evidence, url),
      });
    }

    try {
      return jsonResponse(
        await readDashboardApi({
          route: dashboardRoute,
          query: url.searchParams,
          evidence,
          env,
          options,
        }),
      );
    } catch (error) {
      const status = error instanceof DashboardApiError ? error.status : 502;
      return jsonResponse(
        {
          error: {
            code: error instanceof DashboardApiError ? error.code : "dashboard_read_failed",
            message: error?.message ?? "dashboard read failed",
          },
          metadata: dashboardMetadata(evidence, env),
          evidence: withLinks(evidence, url),
        },
        { status },
      );
    }
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
  const registryAddressOverride = optionalString(env.FOC_PLATFORM_REGISTRY_ADDRESS);
  const registryAddress = registryAddressOverride ?? DEFAULT_REGISTRY_ADDRESS;
  const registryDeployTxHash =
    optionalString(env.FOC_PLATFORM_REGISTRY_DEPLOY_TX) ??
    defaultRegistryMetadataValue(registryAddress, DEFAULT_REGISTRY_DEPLOY_TX);
  const registryDeployBlock =
    optionalString(env.FOC_PLATFORM_REGISTRY_DEPLOY_BLOCK) ??
    defaultRegistryMetadataValue(registryAddress, DEFAULT_REGISTRY_DEPLOY_BLOCK);
  const registryRuntimeSha256 =
    optionalString(env.FOC_PLATFORM_REGISTRY_RUNTIME_SHA256) ??
    defaultRegistryMetadataValue(registryAddress, DEFAULT_REGISTRY_RUNTIME_SHA256);
  const objectId = optionalString(env.FOC_PLATFORM_DEMO_OBJECT_ID);
  const accountId = normalizeBytes32(optionalString(env.FOC_PLATFORM_DEMO_ACCOUNT_ID));
  const providerId = optionalString(env.FOC_PLATFORM_DEMO_PROVIDER_ID);
  const datasetId = optionalString(env.FOC_PLATFORM_DEMO_DATASET_ID);
  const registryTxHashes = parseJsonObject(env.FOC_PLATFORM_DEMO_REGISTRY_TX_HASHES_JSON);

  return {
    schemaVersion: 1,
    generatedAt: optionalString(env.FOC_PLATFORM_DEMO_GENERATED_AT) ?? new Date(0).toISOString(),
    mode: optionalString(env.FOC_PLATFORM_DEMO_MODE) ?? "calibration_live_evidence",
    network: optionalString(env.FOC_PLATFORM_DEMO_NETWORK) ?? "filecoin_calibration",
    chainId: parsePositiveInteger(env.FOC_PLATFORM_DEMO_CHAIN_ID, 314159),
    registry: {
      address: isAddress(registryAddress) ? getAddress(registryAddress) : registryAddress,
      deployTxHash: registryDeployTxHash,
      deployBlock: registryDeployBlock,
      runtimeSha256: registryRuntimeSha256,
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
      endpoints: [
        "/",
        "/admin",
        "/api/health",
        "/api/demo/evidence",
        "/api/demo/registry",
        ...Object.values(DASHBOARD_API_ENDPOINTS),
      ],
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

async function readDashboardApi({ route, query, evidence, env, options }) {
  const metadata = dashboardMetadata(evidence, env);
  const adapter = createDashboardReadAdapter({ evidence, env, options, metadata });
  const limit = dashboardPageLimit(query, env);
  const includeTerminal = query.get("includeTerminal") !== "false";

  switch (route) {
    case "overview": {
      const summary = await readDashboardOverviewSummary({
        adapter,
        evidence,
        env,
        options,
        metadata,
      });
      return {
        metadata,
        summary,
        sourceOfTruth: registryDirectReadDefaults,
        endpoints: DASHBOARD_API_ENDPOINTS,
      };
    }
    case "files": {
      const page = await adapter.readObjectPage({
        cursorIdExclusive: dashboardCursor(query),
        limit,
        includeTerminal,
      });
      return {
        metadata,
        pagination: dashboardPagination(page.pagination, page.ids.length, limit),
        ids: page.ids,
        files: filterObjectRows(fileRowsFromObjectPage(page), query),
      };
    }
    case "accounts": {
      const page = await adapter.readAccountPage({
        offset: dashboardOffset(query),
        limit,
        includeTerminal,
      });
      return {
        metadata,
        pagination: dashboardPagination(page.pagination, page.accounts.length, limit),
        accounts: filterAccountRows(
          page.accounts.map((row) => ({
            accountId: row.accountId,
            objectIds: row.objectIds,
            objectPagination: row.objectPagination,
            ...row.usage,
          })),
          query,
        ),
      };
    }
    case "datasets": {
      const page = await adapter.readDatasetPage({
        offset: dashboardOffset(query),
        limit,
      });
      return {
        metadata,
        pagination: dashboardPagination(page.pagination, page.datasets.length, limit),
        datasets: filterDatasetRows(
          page.datasets.map((row) => ({
            key: row.key,
            ...row.dataset,
          })),
          query,
        ),
      };
    }
    case "coordinators": {
      const [coordinatorPage, relayerPage] = await Promise.all([
        adapter.readCoordinatorPage({
          offset: dashboardOffset(query),
          limit,
        }),
        adapter.readRelayerPage({
          offset: dashboardOffset(query),
          limit,
        }),
      ]);
      return {
        metadata,
        pagination: {
          coordinators: dashboardPagination(
            coordinatorPage.pagination,
            coordinatorPage.coordinators.length,
            limit,
          ),
          relayers: dashboardPagination(
            relayerPage.pagination,
            relayerPage.relayers.length,
            limit,
          ),
        },
        coordinators: filterCoordinatorRows(
          coordinatorPage.coordinators.map((row) => ({
            coordinator: row.coordinator,
            ...row.policy,
            sessionStatus: coordinatorSessionStatus(row.policy, metadata.readUnixTime),
          })),
          query,
        ),
        relayers: filterRelayerRows(relayerPage.relayers, query),
      };
    }
    case "reconciliation": {
      const objectPage = await adapter.readObjectPage({
        cursorIdExclusive: dashboardCursor(query),
        limit,
        includeTerminal,
      });
      const reconciliation = buildPageScopedReconciliation(objectPage, {
        now: metadata.readUnixTime,
      });
      return {
        metadata,
        pagination: dashboardPagination(
          objectPage.pagination,
          objectPage.objects.length,
          limit,
        ),
        ids: objectPage.ids,
        reconciliation: {
          ...reconciliation,
          checks: filterReconciliationRows(reconciliation.checks, query),
        },
        sourceOfTruth: objectPage.sourceOfTruth,
      };
    }
    default:
      throw new DashboardApiError(404, "not_found", "dashboard API route not found");
  }
}

function createDashboardReadAdapter({ evidence, env, options, metadata }) {
  if (options.dashboardAdapter) return options.dashboardAdapter;
  if (options.createDashboardAdapter) {
    return options.createDashboardAdapter({ evidence, env, metadata });
  }

  const registryAddress = evidence.registry.address;
  if (!isAddress(registryAddress)) {
    throw new Error("FOC_PLATFORM_REGISTRY_ADDRESS must be an EVM address");
  }

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain: filecoinCalibration,
      transport: http(metadata.rpcUrl),
    });

  return createTokenHostRegistryDirectReadAdapter({
    publicClient,
    registryAddress,
    maxPageSize: metadata.maxPageSize,
    detailConcurrency: parsePositiveInteger(
      env.FOC_PLATFORM_DASHBOARD_DETAIL_CONCURRENCY,
      4,
    ),
    maxPagesPerSurface: parsePositiveInteger(
      env.FOC_PLATFORM_DASHBOARD_MAX_PAGES_PER_SURFACE,
      100,
    ),
    includeTerminal: true,
    now: metadata.readUnixTime,
  });
}

async function readDashboardOverviewSummary({ adapter, evidence, env, options, metadata }) {
  if (adapter.readOverviewCounts) {
    return overviewSummaryFromCounts(
      await adapter.readOverviewCounts({ evidence, env, metadata }),
    );
  }

  if (options.dashboardAdapter || options.createDashboardAdapter) {
    const surfaces = await adapter.readAdminSurfaces({
      route: { name: "dashboard" },
      limit: BigInt(metadata.defaultPageLimit),
      includeTerminal: true,
      now: metadata.readUnixTime,
    });
    return surfaces.summary;
  }

  const registryAddress = evidence.registry.address;
  if (!isAddress(registryAddress)) {
    throw new Error("FOC_PLATFORM_REGISTRY_ADDRESS must be an EVM address");
  }

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain: filecoinCalibration,
      transport: http(metadata.rpcUrl),
    });

  const [
    objectCount,
    accountCount,
    datasetCount,
    coordinatorCount,
    relayerCount,
  ] = await Promise.all(
    [
      registryObjectCountRead(registryAddress),
      registryAccountCountRead(registryAddress),
      registryDatasetRecordCountRead(registryAddress),
      registryCoordinatorCountRead(registryAddress),
      registryRelayerCountRead(registryAddress),
    ].map((read) => publicClient.readContract(read)),
  );

  return overviewSummaryFromCounts({
    objectCount,
    accountCount,
    datasetCount,
    coordinatorCount,
    relayerCount,
  });
}

function overviewSummaryFromCounts(counts = {}) {
  return {
    mode: "contractCounts",
    objectCount: jsonCount(counts.objectCount),
    accountCount: jsonCount(counts.accountCount),
    datasetCount: jsonCount(counts.datasetCount),
    providerCount: null,
    coordinatorCount: jsonCount(counts.coordinatorCount),
    relayerCount: jsonCount(counts.relayerCount),
    objectStatuses: null,
    mismatchCount: null,
    warningCount: null,
    pendingEvidenceCount: null,
  };
}

function jsonCount(value) {
  const count = BigInt(value ?? 0);
  return count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count.toString();
}

function dashboardApiRoute(pathname) {
  return Object.entries(DASHBOARD_API_ENDPOINTS).find(([, path]) => path === pathname)?.[0] ?? null;
}

function dashboardLiveReadsEnabled(url, evidence) {
  const live = url.searchParams.get("live");
  if (live === "true") return true;
  if (live === "false") return false;
  return dashboardDirectReadAbiMatches(evidence);
}

function dashboardDirectReadAbiMatches(evidence) {
  return (
    normalizeHash(evidence.registry.runtimeSha256) ===
    normalizeHash(registryArtifact.deployedBytecodeSha256)
  );
}

function normalizeHash(value) {
  return optionalString(value)?.toLowerCase().replace(/^0x/, "") ?? "";
}

function sameEvmAddress(left, right) {
  return isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right);
}

function defaultRegistryMetadataValue(registryAddress, value) {
  return sameEvmAddress(registryAddress, DEFAULT_REGISTRY_ADDRESS) ? value : undefined;
}

function dashboardMetadata(evidence, env = {}) {
  const now = new Date();
  return {
    schemaVersion: 1,
    sourceOfTruth: registryDirectReadDefaults.sourceOfTruth,
    network: evidence.network,
    chainId: evidence.chainId,
    registryAddress: evidence.registry.address,
    registryDeployTx: evidence.registry.deployTxHash,
    registryRuntimeSha256: evidence.registry.runtimeSha256,
    expectedRuntimeSha256: registryArtifact.deployedBytecodeSha256,
    dashboardLiveDefault: dashboardDirectReadAbiMatches(evidence),
    rpcUrl: optionalString(env.FILECOIN_CALIBRATION_RPC_URL) ?? DEFAULT_RPC_URL,
    readAt: now.toISOString(),
    readUnixTime: Math.floor(now.getTime() / 1000),
    maxPageSize: parsePositiveInteger(
      env.FOC_PLATFORM_DASHBOARD_MAX_PAGE_SIZE,
      registryDirectReadDefaults.maxPageSize,
    ),
    defaultPageLimit: parsePositiveInteger(
      env.FOC_PLATFORM_DASHBOARD_DEFAULT_PAGE_LIMIT,
      DEFAULT_DASHBOARD_PAGE_LIMIT,
    ),
    workerMode: evidence.worker.mode,
    privilegedActions: false,
    caveats: [
      "Dashboard endpoints perform public read-only contract calls.",
      "FOC payment/provider evidence is shown only when public evidence exists.",
      "Session-key coordinator and production payment readiness remain tracked outside this public dashboard.",
    ],
  };
}

function dashboardPageLimit(query, env = {}) {
  const fallback = parsePositiveInteger(
    env.FOC_PLATFORM_DASHBOARD_DEFAULT_PAGE_LIMIT,
    DEFAULT_DASHBOARD_PAGE_LIMIT,
  );
  const requested = parsePositiveInteger(query.get("limit"), fallback);
  const max = parsePositiveInteger(
    env.FOC_PLATFORM_DASHBOARD_MAX_PAGE_SIZE,
    registryDirectReadDefaults.maxPageSize,
  );
  return BigInt(Math.min(requested, max));
}

function dashboardCursor(query) {
  return parseBigIntString(query.get("cursor"), 0n);
}

function dashboardOffset(query) {
  return parseBigIntString(query.get("offset"), 0n);
}

function dashboardPagination(pagination, rowCount, limit) {
  const pageLimit = Number(limit);
  return {
    ...pagination,
    rowCount,
    hasNextPage: pageLimit > 0 && rowCount >= pageLimit,
  };
}

function parseBigIntString(value, fallback) {
  const raw = optionalString(value);
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return BigInt(raw);
}

function fileRowsFromObjectPage(page) {
  return (page.objects ?? []).map((row) => ({
    objectId: row.objectId,
    accountId: row.object.accountId,
    user: row.object.user,
    status: row.object.status,
    size: row.object.size,
    requestedCopies: row.object.requestedCopies,
    completedCopies: row.object.completedCopies,
    activeBytes: row.object.activeBytes,
    reservedCost: row.object.reservedCost,
    actualCost: row.object.actualCost,
    pieceCidHash: row.object.pieceCidHash,
    receiptHash: row.object.receiptHash,
    receiptPayer: row.receiptPayer,
    coordinator: row.object.coordinator,
    providerIds: (row.copyReceipts ?? []).map((receipt) => receipt.providerId),
    datasetIds: (row.copyReceipts ?? []).map((receipt) => receipt.datasetId),
    copyReceipts: row.copyReceipts ?? [],
  }));
}

function buildPageScopedReconciliation(objectPage, { now } = {}) {
  const model = createRegistryReadModel();
  for (const row of objectPage.objects ?? []) {
    model.objects[row.objectId] = row.object;
    model.copyReceipts[row.objectId] = row.copyReceipts ?? [];
    model.receiptPayers[row.objectId] = row.receiptPayer;
  }

  const surfaces = buildAdminSurfaces({ model }, { now });
  const checks = surfaces.reconciliation.checks.filter(
    (check) => !PAGE_SCOPED_RECONCILIATION_OMITTED_CODES.has(check.code),
  );

  return {
    ...reconciliationSummaryFromChecks(checks),
    scope: "object_page",
    objectCount: objectPage.objects?.length ?? 0,
    objectIds: objectPage.ids ?? [],
    omittedCheckFamilies: PAGE_SCOPED_RECONCILIATION_OMITTED_FAMILIES,
    omittedCheckCodes: Array.from(PAGE_SCOPED_RECONCILIATION_OMITTED_CODES),
    checks,
  };
}

function reconciliationSummaryFromChecks(checks) {
  const mismatchCount = checks.filter((check) => check.severity === "error").length;
  const warningCount = checks.filter((check) => check.severity === "warning").length;
  const pendingEvidenceCount = checks.filter((check) => check.code === "foc_evidence_not_checked").length;
  return {
    status:
      mismatchCount > 0
        ? "mismatch"
        : warningCount > 0
          ? "warning"
        : pendingEvidenceCount > 0
          ? "pending_external_evidence"
          : "matched",
    mismatchCount,
    warningCount,
    pendingEvidenceCount,
  };
}

function filterObjectRows(rows, query) {
  const status = optionalString(query.get("status"));
  const account = optionalString(query.get("account"));
  const provider = optionalString(query.get("provider"));
  const dataset = optionalString(query.get("dataset"));
  const coordinator = optionalString(query.get("coordinator"))?.toLowerCase();
  return textFilter(
    rows.filter((row) => {
      if (status && row.status !== status) return false;
      if (account && row.accountId !== account) return false;
      if (provider && !row.providerIds.includes(provider)) return false;
      if (dataset && !row.datasetIds.includes(dataset)) return false;
      if (coordinator && String(row.coordinator ?? "").toLowerCase() !== coordinator) return false;
      return true;
    }),
    query,
    ["objectId", "accountId", "user", "receiptHash", "receiptPayer", "coordinator"],
  );
}

function filterAccountRows(rows, query) {
  return textFilter(rows, query, ["accountId", "objectIds"]);
}

function filterDatasetRows(rows, query) {
  const provider = optionalString(query.get("provider"));
  const dataset = optionalString(query.get("dataset"));
  return textFilter(
    rows.filter((row) => {
      if (provider && row.providerId !== provider) return false;
      if (dataset && row.datasetId !== dataset) return false;
      return true;
    }),
    query,
    ["key", "accountId", "providerId", "datasetId", "payer", "storageClass"],
  );
}

function filterCoordinatorRows(rows, query) {
  const coordinator = optionalString(query.get("coordinator"))?.toLowerCase();
  return textFilter(
    rows.filter((row) => !coordinator || String(row.coordinator ?? "").toLowerCase() === coordinator),
    query,
    ["coordinator", "permissionsHash", "sessionStatus"],
  );
}

function filterRelayerRows(rows, query) {
  return textFilter(rows, query, ["relayer", "allowed"]);
}

function filterReconciliationRows(rows, query) {
  const severity = optionalString(query.get("severity"));
  const code = optionalString(query.get("code"));
  return textFilter(
    rows.filter((row) => {
      if (severity && row.severity !== severity) return false;
      if (code && row.code !== code) return false;
      return true;
    }),
    query,
    ["code", "severity", "objectId", "accountId", "providerId", "datasetId", "coordinator"],
  );
}

function textFilter(rows, query, fields) {
  const raw = optionalString(query.get("q"));
  if (!raw) return rows;
  const needle = raw.toLowerCase();
  return rows.filter((row) =>
    fields.some((fieldName) => {
      const value = row[fieldName];
      if (Array.isArray(value)) return value.some((item) => String(item).toLowerCase().includes(needle));
      return String(value ?? "").toLowerCase().includes(needle);
    }),
  );
}

function coordinatorSessionStatus(policy, now) {
  if (!policy.allowed) return "disabled";
  const expiresAt = BigInt(policy.sessionKeyExpiresAt ?? 0);
  if (expiresAt === 0n) return "active";
  return BigInt(now) > expiresAt ? "expired" : "active";
}

class DashboardApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function renderAdminDashboardHtml(evidence, { live = true } = {}) {
  const registry = evidence.registry.address;
  const network = evidence.network;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FOC Platform Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f8;
      --ink: #111827;
      --muted: #667085;
      --line: #d9dee7;
      --surface: #ffffff;
      --surface-2: #eef2f7;
      --accent: #0f766e;
      --accent-2: #3255a4;
      --warn: #a15c16;
      --bad: #b42318;
      --good: #087443;
      --code: #1f2937;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select {
      font: inherit;
    }
    main {
      min-height: 100svh;
      display: grid;
      grid-template-rows: auto auto 1fr;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      flex-wrap: wrap;
      padding: 18px clamp(18px, 4vw, 42px);
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    .brand {
      display: grid;
      gap: 3px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .statusline {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 4px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--code);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto auto auto;
      gap: 10px;
      padding: 12px clamp(18px, 4vw, 42px);
      border-bottom: 1px solid var(--line);
      background: #fafbfc;
    }
    .toolbar input, .toolbar select {
      min-width: 0;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
      padding: 0 10px;
    }
    .workspace {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      min-height: 0;
    }
    .nav {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      padding: 14px 10px;
    }
    .nav button {
      width: 100%;
      min-height: 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 2px 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--ink);
      padding: 0 10px;
      text-align: left;
      cursor: pointer;
    }
    .nav button[aria-selected="true"] {
      background: #e7edf8;
      color: var(--accent-2);
      font-weight: 800;
    }
    .content {
      min-width: 0;
      padding: clamp(16px, 3vw, 30px);
      display: grid;
      gap: 18px;
      align-content: start;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
    }
    .metric {
      min-height: 78px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      padding: 12px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .metric strong {
      display: block;
      margin-top: 6px;
      font-size: 23px;
      line-height: 1;
      letter-spacing: 0;
    }
    .panel {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 48px;
      padding: 0 14px;
      border-bottom: 1px solid var(--line);
    }
    h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }
    .table-wrap {
      width: 100%;
      overflow: auto;
    }
    table {
      width: 100%;
      min-width: 920px;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      background: #fafbfc;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    td {
      font-size: 13px;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--code);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      background: var(--surface-2);
    }
    .pill.good { color: var(--good); }
    .pill.warn { color: var(--warn); }
    .pill.bad { color: var(--bad); }
    .copy {
      max-width: 100%;
      border: 0;
      background: transparent;
      color: var(--accent-2);
      padding: 0;
      text-align: left;
      cursor: pointer;
      font: inherit;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .object-link {
      max-width: 100%;
      border: 0;
      background: transparent;
      color: var(--accent-2);
      padding: 0;
      text-align: left;
      cursor: pointer;
      font: inherit;
      font-weight: 800;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .muted-state {
      color: var(--muted);
      font-weight: 700;
    }
    .detail-row[hidden] {
      display: none;
    }
    .detail-row td {
      padding: 0;
      background: #fbfcfd;
    }
    .object-detail {
      display: grid;
      gap: 12px;
      padding: 14px;
      border-bottom: 1px solid var(--line);
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 10px;
    }
    .detail-item {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .detail-item span,
    .receipt-list span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .detail-item strong,
    .receipt-item strong {
      min-width: 0;
      color: var(--code);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .receipt-list {
      display: grid;
      gap: 8px;
    }
    .receipt-item {
      display: grid;
      grid-template-columns: repeat(4, minmax(130px, 1fr));
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
    }
    .empty, .error {
      padding: 18px 14px;
      color: var(--muted);
    }
    .empty strong {
      display: block;
      margin-bottom: 4px;
      color: var(--ink);
    }
    .subtable-title {
      padding: 12px 14px 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .error {
      color: var(--bad);
    }
    .footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .pager {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .pager button {
      min-width: 32px;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
      padding: 0 10px;
      cursor: pointer;
    }
    .pager button[aria-current="page"] {
      border-color: var(--ink);
      box-shadow: inset 0 0 0 1px var(--ink);
      background: #fff;
      color: var(--ink);
      font-weight: 800;
    }
    .pager button:disabled {
      cursor: default;
      color: var(--muted);
      background: #f3f4f6;
    }
    .pager-gap {
      min-width: 18px;
      color: var(--muted);
      text-align: center;
      font-weight: 800;
    }
    a {
      color: var(--accent-2);
      text-decoration: none;
      font-weight: 700;
    }
    @media (max-width: 980px) {
      .toolbar { grid-template-columns: 1fr 1fr; }
      .workspace { grid-template-columns: 1fr; }
      .nav {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .nav button {
        width: auto;
        flex: 0 0 auto;
      }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail-grid,
      .receipt-item {
        grid-template-columns: repeat(2, minmax(140px, 1fr));
      }
    }
    @media (max-width: 620px) {
      .topbar { align-items: flex-start; }
      .statusline { justify-content: flex-start; }
      .toolbar { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
      .detail-grid,
      .receipt-item {
        grid-template-columns: 1fr;
      }
      table { min-width: 760px; }
    }
  </style>
</head>
<body>
<main>
  <header class="topbar">
    <div class="brand">
      <h1>FOC Platform Admin</h1>
      <div class="meta"><span>${escapeHtml(network)}</span> / <span class="mono">${escapeHtml(registry)}</span></div>
    </div>
    <div class="statusline">
      <span class="chip">Read only</span>
      <span class="chip">Direct registry reads</span>
      <span class="chip">Chain ${escapeHtml(String(evidence.chainId))}</span>
    </div>
  </header>
  <section class="toolbar" aria-label="Dashboard filters">
    <input id="q" name="q" placeholder="Search ids, addresses, hashes" autocomplete="off">
    <select id="status" name="status" aria-label="Status filter">
      <option value="">All statuses</option>
      ${UPLOAD_STATUS_LABELS.slice(1).map((label) => `<option value="${escapeHtml(label)}"${label === "Committed" ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
    </select>
    <input id="provider" name="provider" placeholder="Provider id" autocomplete="off">
    <select id="limit" name="limit" aria-label="Page limit">
      <option value="10" selected>10 rows</option>
      <option value="20">20 rows</option>
      <option value="50">50 rows</option>
    </select>
  </section>
  <div class="workspace">
    <nav class="nav" aria-label="Admin views">
      <button type="button" data-view="files" aria-selected="true">Files <span id="nav-files"></span></button>
      <button type="button" data-view="accounts" aria-selected="false">Accounts <span id="nav-accounts"></span></button>
      <button type="button" data-view="datasets" aria-selected="false">Datasets <span id="nav-datasets"></span></button>
      <button type="button" data-view="coordinators" aria-selected="false">Coordinators <span id="nav-coordinators"></span></button>
      <button type="button" data-view="reconciliation" aria-selected="false">Reconciliation <span id="nav-reconciliation"></span></button>
    </nav>
    <section class="content">
      <div class="metrics" id="metrics" aria-live="polite"></div>
      <section class="panel">
        <div class="panel-header">
          <h2 id="table-title">Files</h2>
          <a href="/api/demo/evidence">Evidence JSON</a>
        </div>
        <div class="table-wrap" id="table-wrap"></div>
        <div class="footer" id="footer">Loading current registry state</div>
      </section>
    </section>
  </div>
</main>
<script>
(() => {
  const endpoints = ${JSON.stringify(DASHBOARD_API_ENDPOINTS)};
  const liveReads = ${live ? "true" : "false"};
  const cursorViews = new Set(["files", "reconciliation"]);
  const offsetViews = new Set(["accounts", "datasets", "coordinators"]);
  const state = {
    view: "files",
    summary: null,
    pagination: null,
    pageRequestPending: false,
    requestSeq: 0,
    pages: {
      files: { cursor: "0", cursors: ["0"], index: 0 },
      accounts: { offset: "0", offsets: ["0"], index: 0 },
      datasets: { offset: "0", offsets: ["0"], index: 0 },
      coordinators: { offset: "0", offsets: ["0"], index: 0 },
      reconciliation: { cursor: "0", cursors: ["0"], index: 0 },
    },
  };
  const $ = (id) => document.getElementById(id);
  const text = (value) => value === undefined || value === null || value === "" ? "n/a" : String(value);
  const short = (value) => {
    const raw = text(value);
    return raw.length > 18 ? raw.slice(0, 10) + "..." + raw.slice(-6) : raw;
  };
  const esc = (value) => text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const copy = (value) => '<button type="button" class="copy" title="' + esc(value) + '" data-copy="' + esc(value) + '">' + esc(short(value)) + '</button>';
  const pill = (value) => {
    const normalized = text(value);
    const tone = ["Committed", "active", "matched"].includes(normalized) ? "good" : ["Failed", "Expired", "mismatch", "expired", "disabled"].includes(normalized) ? "bad" : "warn";
    return '<span class="pill ' + tone + '">' + esc(normalized) + '</span>';
  };
  const zeroHex = (value) => /^0x0+$/i.test(text(value));
  const pending = (value) => '<span class="muted-state">' + esc(value) + '</span>';
  const objectButton = (row) => {
    const id = esc(row.objectId);
    return '<button type="button" class="object-link" data-object-id="' + id + '" aria-controls="object-detail-' + id + '" aria-expanded="false">' + id + '</button>';
  };
  const receiptCell = (row) => {
    if (!zeroHex(row.receiptHash)) return copy(row.receiptHash);
    return row.status === "Committed" ? pill("Missing receipt") : pending("Pending receipt");
  };
  const coordinatorCell = (row) => {
    if (!zeroHex(row.coordinator)) return copy(row.coordinator);
    return row.status === "Requested" ? pending("Not assigned") : pill("Missing coordinator");
  };
  const providerCell = (row) => {
    const providers = row.providerIds || [];
    if (providers.length > 0) return esc(providers.join(", "));
    return row.status === "Committed" ? pill("Missing providers") : pending("n/a");
  };
  const detailItem = (label, value) =>
    '<div class="detail-item"><span>' + esc(label) + '</span><strong>' + value + '</strong></div>';
  const fileDetailMarkup = (row) => {
    const receipts = row.copyReceipts || [];
    const receiptRows = receipts.length > 0
      ? receipts.map((receipt) =>
        '<div class="receipt-item">' +
        detailItem("Provider", esc(receipt.providerId)) +
        detailItem("Dataset", esc(receipt.datasetId)) +
        detailItem("Piece", esc(receipt.pieceId)) +
        detailItem("Add piece tx", copy(receipt.addPieceTxHash)) +
        detailItem("Retrieval URL", copy(receipt.retrievalUrlHash)) +
        detailItem("New dataset", esc(receipt.isNewDataSet)) +
        '</div>',
      ).join("")
      : pending(row.status === "Committed" ? "No copy receipts returned" : "Copy receipts pending");
    return '<div class="object-detail">' +
      '<div class="detail-grid">' +
      detailItem("Object", copy(row.objectId)) +
      detailItem("Account", copy(row.accountId)) +
      detailItem("User", copy(row.user)) +
      detailItem("Status", pill(row.status)) +
      detailItem("Size", esc(row.size)) +
      detailItem("Active bytes", esc(row.activeBytes)) +
      detailItem("Copies", esc(row.completedCopies) + "/" + esc(row.requestedCopies)) +
      detailItem("Coordinator", coordinatorCell(row)) +
      detailItem("Reserved cost", esc(row.reservedCost)) +
      detailItem("Actual cost", esc(row.actualCost)) +
      detailItem("Piece CID hash", zeroHex(row.pieceCidHash) ? pending("Pending piece") : copy(row.pieceCidHash)) +
      detailItem("Receipt hash", receiptCell(row)) +
      detailItem("Receipt payer", zeroHex(row.receiptPayer) ? pending("Pending payer") : copy(row.receiptPayer)) +
      '</div>' +
      '<div class="receipt-list"><span>Copy receipts</span>' + receiptRows + '</div>' +
      '</div>';
  };
  async function fetchJson(path, view = state.view) {
    const url = new URL(path, location.origin);
    url.searchParams.set("limit", $("limit").value);
    url.searchParams.set("live", liveReads ? "true" : "false");
    const q = $("q").value.trim();
    const status = $("status").value;
    const provider = $("provider").value.trim();
    const page = currentPage(view);
    if (cursorViews.has(view) && page.cursor !== "0") url.searchParams.set("cursor", page.cursor);
    if (offsetViews.has(view) && page.offset !== "0") url.searchParams.set("offset", page.offset);
    if (q) url.searchParams.set("q", q);
    if (status && view === "files") url.searchParams.set("status", status);
    if (provider && ["files", "datasets"].includes(view)) url.searchParams.set("provider", provider);
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error?.message || "request failed");
    }
    return body;
  }
  async function loadOverview() {
    const body = await fetchJson(endpoints.overview);
    state.summary = body.summary;
    renderMetrics(body.summary);
  }
  async function loadView() {
    const view = state.view;
    const requestId = ++state.requestSeq;
    state.pageRequestPending = true;
    disablePagerActions();
    $("table-wrap").innerHTML = '<div class="empty">Loading ' + esc(view) + '</div>';
    $("table-title").textContent = title(view);
    document.querySelectorAll(".nav button").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.view === view));
    });
    try {
      const body = await fetchJson(endpoints[view], view);
      if (requestId !== state.requestSeq || view !== state.view) return;
      state.pageRequestPending = false;
      renderView(body, view);
      renderFooter(body, view);
    } catch (error) {
      if (requestId !== state.requestSeq || view !== state.view) return;
      state.pageRequestPending = false;
      $("table-wrap").innerHTML = '<div class="error">' + esc(error.message) + '</div>';
      $("footer").textContent = "Registry read unavailable";
    }
  }
  function disablePagerActions() {
    document.querySelectorAll("[data-page-action]").forEach((button) => {
      button.disabled = true;
    });
  }
  function renderMetrics(summary = {}) {
    const warningsUnavailable =
      summary.warningCount === undefined ||
      summary.warningCount === null ||
      summary.mismatchCount === undefined ||
      summary.mismatchCount === null;
    const metrics = [
      ["Objects", summary.objectCount],
      ["Accounts", summary.accountCount],
      ["Datasets", summary.datasetCount],
      ["Providers", summary.providerCount],
      ["Coordinators", summary.coordinatorCount],
      ["Warnings", warningsUnavailable ? null : Number(summary.warningCount || 0) + Number(summary.mismatchCount || 0)],
    ];
    $("metrics").innerHTML = metrics.map(([label, value]) => '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value ?? "n/a") + '</strong></div>').join("");
    $("nav-files").textContent = summary.objectCount ?? "";
    $("nav-accounts").textContent = summary.accountCount ?? "";
    $("nav-datasets").textContent = summary.datasetCount ?? "";
    $("nav-coordinators").textContent = summary.coordinatorCount ?? "";
    $("nav-reconciliation").textContent = summary.mismatchCount ?? "";
  }
  function renderView(body, view = state.view) {
    state.pagination = primaryPagination(body.pagination);
    if (body.source === "skipped") return renderSkippedView(body);
    if (view === "files") return renderFileRows(body.files);
    if (view === "accounts") return table(["Account", "Objects", "Active bytes", "Pending bytes", "Reserved", "Finalized", "Failed"], body.accounts, (row) => [
      copy(row.accountId),
      esc((row.objectIds || []).join(", ") || row.activeObjects),
      esc(row.activeBytes),
      esc(row.pendingBytes),
      esc(row.reservedCost),
      esc(row.totalFinalizedUploads),
      esc(row.totalFailedUploads),
    ]);
    if (view === "datasets") return table(["Dataset", "Provider", "Account", "Payer", "CDN", "Storage class", "Updated"], body.datasets, (row) => [
      copy(row.datasetId),
      esc(row.providerId),
      copy(row.accountId),
      copy(row.payer),
      esc(row.withCDN),
      copy(row.storageClass),
      esc(row.updatedAt),
    ]);
    if (view === "coordinators") return renderCoordinatorView(body);
    return table(["Severity", "Code", "Object", "Account", "Provider", "Current"], body.reconciliation?.checks || [], (row) => [
      pill(row.severity),
      esc(row.code),
      copy(row.objectId),
      copy(row.accountId),
      esc(row.providerId || ""),
      esc(row.actualCopies || row.actualActiveBytes || row.actualPendingBytes || row.actualReservedCost || ""),
    ]);
  }
  function renderSkippedView(body) {
    state.pagination = null;
    const metadata = body.metadata || {};
    const reason = metadata.dashboardLiveDefault === false
      ? "Direct onchain reads are skipped because the configured registry runtime does not match the pagination-capable artifact."
      : "Direct onchain reads are skipped for this request.";
    $("table-wrap").innerHTML =
      '<div class="empty"><strong>Dashboard reads unavailable</strong><span>' + esc(reason) + '</span></div>';
  }
  function renderCoordinatorView(body) {
    const coordinatorRows = body.coordinators || [];
    const relayerRows = body.relayers || [];
    const sections = [];
    if (coordinatorRows.length > 0) {
      sections.push(
        '<div class="subtable-title">Coordinator policies</div>' +
        tableMarkup(["Coordinator", "Allowed", "Session", "Expires", "Permissions"], coordinatorRows, (row) => [
          copy(row.coordinator),
          pill(row.allowed ? "active" : "disabled"),
          pill(row.sessionStatus),
          esc(row.sessionKeyExpiresAt),
          copy(row.permissionsHash),
        ]),
      );
    }
    if (relayerRows.length > 0) {
      sections.push(
        '<div class="subtable-title">Relayers</div>' +
        tableMarkup(["Relayer", "Allowed"], relayerRows, (row) => [
          copy(row.relayer),
          pill(row.allowed ? "active" : "disabled"),
        ]),
      );
    }
    if (sections.length === 0) {
      $("table-wrap").innerHTML = '<div class="empty">No rows on this page</div>';
      return;
    }
    $("table-wrap").innerHTML = sections.join("");
  }
  function renderFileRows(rows) {
    if (!rows || rows.length === 0) {
      $("table-wrap").innerHTML = '<div class="empty">No rows on this page</div>';
      return;
    }
    const headers = ["Object", "Status", "Account", "Size", "Copies", "Providers", "Receipt", "Coordinator"];
    $("table-wrap").innerHTML =
      '<table><thead><tr>' + headers.map((header) => '<th>' + esc(header) + '</th>').join("") + '</tr></thead><tbody>' +
      rows.map((row) => {
        const id = esc(row.objectId);
        const cells = [
          objectButton(row),
          pill(row.status),
          copy(row.accountId),
          esc(row.size),
          esc(row.completedCopies) + "/" + esc(row.requestedCopies),
          providerCell(row),
          receiptCell(row),
          coordinatorCell(row),
        ];
        return '<tr data-object-row="' + id + '">' + cells.map((cell) => '<td>' + cell + '</td>').join("") + '</tr>' +
          '<tr class="detail-row" id="object-detail-' + id + '" hidden><td colspan="8">' + fileDetailMarkup(row) + '</td></tr>';
      }).join("") +
      '</tbody></table>';
  }
  function tableMarkup(headers, rows, mapRow) {
    return '<table><thead><tr>' + headers.map((header) => '<th>' + esc(header) + '</th>').join("") + '</tr></thead><tbody>' + rows.map((row, index) => '<tr>' + mapRow(row, index).map((cell) => '<td>' + cell + '</td>').join("") + '</tr>').join("") + '</tbody></table>';
  }
  function table(headers, rows, mapRow) {
    if (!rows || rows.length === 0) {
      $("table-wrap").innerHTML = '<div class="empty">No rows on this page</div>';
      return;
    }
    $("table-wrap").innerHTML = tableMarkup(headers, rows, mapRow);
  }
  function renderFooter(body, view = state.view) {
    const pagination = state.pagination;
    const metadata = body.metadata || {};
    const readState = esc(metadata.sourceOfTruth) + " / read " + esc(metadata.readAt) + " / page limit " + esc($("limit").value);
    if (!pagination) {
      $("footer").innerHTML = '<span>' + readState + '</span>';
      return;
    }
    rememberPagePosition(view, pagination);
    const page = currentPage(view);
    const position = pagination.mode === "objectIdCursor"
      ? "cursor " + esc(pagination.cursorIdExclusive || "0")
      : "offset " + esc(pagination.offset || "0");
    const pageLabel = "page " + esc(currentPageNumber(view));
    $("footer").innerHTML =
      '<span>' + readState + " / " + position + " / " + pageLabel + '</span>' +
      renderPager(view, pagination);
  }
  function renderPager(view, pagination) {
    const page = currentPage(view);
    const currentIndex = Number(page.index || 0);
    const maxKnownIndex = knownPageMaxIndex(view, pagination);
    const isFirst = currentIndex === 0;
    const items = paginationWindow(currentIndex, maxKnownIndex);
    const buttons = [
      '<button type="button" data-page-action="previous"' + (isFirst ? " disabled" : "") + '>Previous</button>',
      ...items.map((item) => {
        if (item === "gap") return '<span class="pager-gap" aria-hidden="true">...</span>';
        const pageNumber = item + 1;
        const current = item === currentIndex;
        return '<button type="button" data-page-action="page" data-page-index="' + esc(item) + '"' + (current ? ' aria-current="page"' : "") + '>' + esc(pageNumber) + '</button>';
      }),
      '<button type="button" data-page-action="next"' + (!pagination.hasNextPage ? " disabled" : "") + '>Next</button>',
    ];
    return '<span class="pager" aria-label="Pagination">' + buttons.join("") + '</span>';
  }
  function rememberPagePosition(view, pagination) {
    const page = currentPage(view);
    page.index = Number(page.index || 0);
    if (cursorViews.has(view)) {
      page.cursors = page.cursors || ["0"];
      page.cursors[page.index] = page.cursor || pagination.cursorIdExclusive || "0";
      if (pagination.hasNextPage && pagination.nextCursorIdExclusive) {
        page.cursors[page.index + 1] = pagination.nextCursorIdExclusive;
      }
    }
    if (offsetViews.has(view)) {
      page.offsets = page.offsets || ["0"];
      page.offsets[page.index] = page.offset || pagination.offset || "0";
      if (pagination.hasNextPage && pagination.nextOffset) {
        page.offsets[page.index + 1] = pagination.nextOffset;
      }
    }
  }
  function currentPageNumber(view = state.view) {
    return Number(currentPage(view).index || 0) + 1;
  }
  function knownPageMaxIndex(view, pagination) {
    const page = currentPage(view);
    const currentIndex = Number(page.index || 0);
    const positions = cursorViews.has(view) ? page.cursors : page.offsets;
    const discoveredIndex = Math.max(0, (positions || ["0"]).length - 1);
    const nextIndex = pagination?.hasNextPage ? currentIndex + 1 : currentIndex;
    return Math.max(currentIndex, discoveredIndex, nextIndex);
  }
  function paginationWindow(currentIndex, maxKnownIndex) {
    const selected = new Set([0, currentIndex, maxKnownIndex]);
    for (let index = currentIndex - 1; index <= currentIndex + 1; index += 1) {
      if (index >= 0 && index <= maxKnownIndex) selected.add(index);
    }
    const indexes = Array.from(selected).filter((index) => index >= 0 && index <= maxKnownIndex).sort((a, b) => a - b);
    const items = [];
    indexes.forEach((index) => {
      const previous = items[items.length - 1];
      if (typeof previous === "number" && index - previous > 1) items.push("gap");
      items.push(index);
    });
    return items;
  }
  function primaryPagination(pagination) {
    if (!pagination) return null;
    if (pagination.coordinators || pagination.relayers) {
      return combinedOffsetPagination([pagination.coordinators, pagination.relayers]);
    }
    return pagination;
  }
  function combinedOffsetPagination(pages) {
    const available = pages.filter(Boolean);
    if (available.length === 0) return null;
    const pageWithNext = available.find((page) => page.hasNextPage);
    const primary = pageWithNext || available[0];
    return {
      ...primary,
      mode: "offset",
      offset: primary.offset || available[0].offset || "0",
      nextOffset: pageWithNext?.nextOffset || primary.nextOffset || primary.offset || "0",
      hasNextPage: available.some((page) => page.hasNextPage),
    };
  }
  function currentPage(view = state.view) {
    return state.pages[view] || {};
  }
  function resetPage(view = state.view) {
    state.pages[view].index = 0;
    if (cursorViews.has(view)) {
      state.pages[view].cursor = "0";
      state.pages[view].cursors = ["0"];
    }
    if (offsetViews.has(view)) {
      state.pages[view].offset = "0";
      state.pages[view].offsets = ["0"];
    }
  }
  function resetAllPages() {
    Object.keys(state.pages).forEach((view) => resetPage(view));
  }
  function goToPage(index, view = state.view) {
    const page = currentPage(view);
    const nextIndex = Math.max(0, Number(index) || 0);
    if (nextIndex === Number(page.index || 0)) return;
    if (cursorViews.has(view)) {
      const cursor = (page.cursors || ["0"])[nextIndex];
      if (cursor === undefined) return;
      page.cursor = cursor;
    }
    if (offsetViews.has(view)) {
      const offset = (page.offsets || ["0"])[nextIndex];
      if (offset === undefined) return;
      page.offset = offset;
    }
    page.index = nextIndex;
    loadView();
  }
  function applyPageAction(action, targetIndex) {
    if (state.pageRequestPending) return;
    const pagination = state.pagination;
    const page = currentPage();
    const currentIndex = Number(page.index || 0);
    if (action === "previous") {
      goToPage(currentIndex - 1);
      return;
    }
    if (action === "page") {
      goToPage(targetIndex);
      return;
    }
    if (action === "next" && pagination?.hasNextPage) {
      const nextIndex = currentIndex + 1;
      if (pagination.mode === "objectIdCursor") {
        page.cursors = page.cursors || ["0"];
        page.cursors[nextIndex] = pagination.nextCursorIdExclusive || "0";
      }
      if (pagination.mode === "offset") {
        page.offsets = page.offsets || ["0"];
        page.offsets[nextIndex] = pagination.nextOffset || "0";
      }
      goToPage(nextIndex);
    }
  }
  function title(view) {
    return ({ files: "Files", accounts: "Accounts", datasets: "Datasets", coordinators: "Coordinators", reconciliation: "Reconciliation" })[view] || "Files";
  }
  document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    loadView();
  }));
  ["status", "provider", "limit"].forEach((id) => $(id).addEventListener("change", () => {
    resetAllPages();
    loadView();
  }));
  $("q").addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      resetAllPages();
      loadView();
    }, 180);
  });
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-page-action]");
    if (action) {
      applyPageAction(action.dataset.pageAction, action.dataset.pageIndex);
      return;
    }
    const objectToggle = event.target.closest("[data-object-id]");
    if (objectToggle) {
      const detail = document.getElementById("object-detail-" + objectToggle.dataset.objectId);
      if (detail) {
        const expanded = objectToggle.getAttribute("aria-expanded") === "true";
        objectToggle.setAttribute("aria-expanded", String(!expanded));
        detail.hidden = expanded;
      }
      return;
    }
    const target = event.target.closest("[data-copy]");
    if (target && navigator.clipboard) navigator.clipboard.writeText(target.dataset.copy);
  });
  loadOverview().catch((error) => {
    $("metrics").innerHTML = '<div class="error">' + esc(error.message) + '</div>';
  }).finally(loadView);
})();
</script>
</body>
</html>`;
}

function withLinks(evidence, url) {
  const origin = url.origin;
  return {
    ...evidence,
    links: {
      html: `${origin}/`,
      admin: `${origin}/admin`,
      health: `${origin}/api/health`,
      evidence: `${origin}/api/demo/evidence`,
      registry: `${origin}/api/demo/registry`,
      dashboard: Object.fromEntries(
        Object.entries(DASHBOARD_API_ENDPOINTS).map(([key, path]) => [key, `${origin}${path}`]),
      ),
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
