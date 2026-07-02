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

const DEFAULT_REGISTRY_ADDRESS = "0x7771d916a9d742B1D60597a332C7ABBd5796609c";
const DEFAULT_REGISTRY_DEPLOY_TX =
  "0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552";
const DEFAULT_REGISTRY_RUNTIME_SHA256 =
  "0xed478a27e255a1b27989ffa4f2fcbf38f1a9ec61a84c8d3e20aceb4e26f72040";
const DEFAULT_RPC_URL = "https://api.calibration.node.glif.io/rpc/v1";
const DEFAULT_DASHBOARD_PAGE_LIMIT = 20;
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
        relayers: relayerPage.relayers,
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
  return optionalString(value)?.toLowerCase() ?? "";
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
    .empty, .error {
      padding: 18px 14px;
      color: var(--muted);
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
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
      padding: 0 10px;
      cursor: pointer;
    }
    .pager button:disabled {
      cursor: default;
      color: var(--muted);
      background: #f3f4f6;
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
    }
    @media (max-width: 620px) {
      .topbar { align-items: flex-start; }
      .statusline { justify-content: flex-start; }
      .toolbar { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
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
      ${UPLOAD_STATUS_LABELS.slice(1).map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join("")}
    </select>
    <input id="provider" name="provider" placeholder="Provider id" autocomplete="off">
    <select id="limit" name="limit" aria-label="Page limit">
      <option value="10">10 rows</option>
      <option value="20" selected>20 rows</option>
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
    pages: {
      files: { cursor: "0" },
      accounts: { offset: "0" },
      datasets: { offset: "0" },
      coordinators: { offset: "0" },
      reconciliation: { cursor: "0" },
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
  async function fetchJson(path) {
    const url = new URL(path, location.origin);
    url.searchParams.set("limit", $("limit").value);
    url.searchParams.set("live", liveReads ? "true" : "false");
    const q = $("q").value.trim();
    const status = $("status").value;
    const provider = $("provider").value.trim();
    const page = currentPage();
    if (cursorViews.has(state.view) && page.cursor !== "0") url.searchParams.set("cursor", page.cursor);
    if (offsetViews.has(state.view) && page.offset !== "0") url.searchParams.set("offset", page.offset);
    if (q) url.searchParams.set("q", q);
    if (status && state.view === "files") url.searchParams.set("status", status);
    if (provider && ["files", "datasets"].includes(state.view)) url.searchParams.set("provider", provider);
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
    $("table-wrap").innerHTML = '<div class="empty">Loading ' + esc(state.view) + '</div>';
    $("table-title").textContent = title(state.view);
    document.querySelectorAll(".nav button").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.view === state.view));
    });
    try {
      const body = await fetchJson(endpoints[state.view]);
      renderView(body);
      renderFooter(body);
    } catch (error) {
      $("table-wrap").innerHTML = '<div class="error">' + esc(error.message) + '</div>';
      $("footer").textContent = "Registry read unavailable";
    }
  }
  function renderMetrics(summary = {}) {
    const metrics = [
      ["Objects", summary.objectCount],
      ["Accounts", summary.accountCount],
      ["Datasets", summary.datasetCount],
      ["Providers", summary.providerCount],
      ["Coordinators", summary.coordinatorCount],
      ["Warnings", summary.warningCount === null || summary.mismatchCount === null ? null : Number(summary.warningCount || 0) + Number(summary.mismatchCount || 0)],
    ];
    $("metrics").innerHTML = metrics.map(([label, value]) => '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value ?? "n/a") + '</strong></div>').join("");
    $("nav-files").textContent = summary.objectCount ?? "";
    $("nav-accounts").textContent = summary.accountCount ?? "";
    $("nav-datasets").textContent = summary.datasetCount ?? "";
    $("nav-coordinators").textContent = summary.coordinatorCount ?? "";
    $("nav-reconciliation").textContent = summary.mismatchCount ?? "";
  }
  function renderView(body) {
    state.pagination = primaryPagination(body.pagination);
    if (state.view === "files") return table(["Object", "Status", "Account", "Size", "Copies", "Providers", "Receipt", "Coordinator"], body.files, (row) => [
      copy(row.objectId),
      pill(row.status),
      copy(row.accountId),
      esc(row.size),
      esc(row.completedCopies) + "/" + esc(row.requestedCopies),
      esc((row.providerIds || []).join(", ") || "n/a"),
      copy(row.receiptHash),
      copy(row.coordinator),
    ]);
    if (state.view === "accounts") return table(["Account", "Objects", "Active bytes", "Pending bytes", "Reserved", "Finalized", "Failed"], body.accounts, (row) => [
      copy(row.accountId),
      esc((row.objectIds || []).join(", ") || row.activeObjects),
      esc(row.activeBytes),
      esc(row.pendingBytes),
      esc(row.reservedCost),
      esc(row.totalFinalizedUploads),
      esc(row.totalFailedUploads),
    ]);
    if (state.view === "datasets") return table(["Dataset", "Provider", "Account", "Payer", "CDN", "Storage class", "Updated"], body.datasets, (row) => [
      copy(row.datasetId),
      esc(row.providerId),
      copy(row.accountId),
      copy(row.payer),
      esc(row.withCDN),
      copy(row.storageClass),
      esc(row.updatedAt),
    ]);
    if (state.view === "coordinators") return renderCoordinatorView(body);
    return table(["Severity", "Code", "Object", "Account", "Provider", "Current"], body.reconciliation?.checks || [], (row) => [
      pill(row.severity),
      esc(row.code),
      copy(row.objectId),
      copy(row.accountId),
      esc(row.providerId || ""),
      esc(row.actualCopies || row.actualActiveBytes || row.actualPendingBytes || row.actualReservedCost || ""),
    ]);
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
  function renderFooter(body) {
    const pagination = state.pagination;
    const metadata = body.metadata || {};
    const readState = esc(metadata.sourceOfTruth) + " / read " + esc(metadata.readAt) + " / page limit " + esc($("limit").value);
    if (!pagination) {
      $("footer").innerHTML = '<span>' + readState + '</span>';
      return;
    }
    const page = currentPage();
    const isFirst = cursorViews.has(state.view) ? page.cursor === "0" : page.offset === "0";
    const position = pagination.mode === "objectIdCursor"
      ? "cursor " + esc(pagination.cursorIdExclusive || "0")
      : "offset " + esc(pagination.offset || "0");
    $("footer").innerHTML =
      '<span>' + readState + " / " + position + '</span>' +
      '<span class="pager">' +
      '<button type="button" data-page-action="first"' + (isFirst ? " disabled" : "") + '>First</button>' +
      '<button type="button" data-page-action="next"' + (!pagination.hasNextPage ? " disabled" : "") + '>Next</button>' +
      '</span>';
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
  function currentPage() {
    return state.pages[state.view] || {};
  }
  function resetPage() {
    if (cursorViews.has(state.view)) state.pages[state.view].cursor = "0";
    if (offsetViews.has(state.view)) state.pages[state.view].offset = "0";
  }
  function applyPageAction(action) {
    const pagination = state.pagination;
    const page = currentPage();
    if (action === "first") {
      resetPage();
    } else if (action === "next" && pagination?.hasNextPage) {
      if (pagination.mode === "objectIdCursor") page.cursor = pagination.nextCursorIdExclusive || "0";
      if (pagination.mode === "offset") page.offset = pagination.nextOffset || "0";
    }
    loadView();
  }
  function title(view) {
    return ({ files: "Files", accounts: "Accounts", datasets: "Datasets", coordinators: "Coordinators", reconciliation: "Reconciliation" })[view] || "Files";
  }
  document.querySelectorAll(".nav button").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    loadView();
  }));
  ["status", "provider", "limit"].forEach((id) => $(id).addEventListener("change", () => {
    resetPage();
    loadView();
  }));
  $("q").addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      resetPage();
      loadView();
    }, 180);
  });
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-page-action]");
    if (action) {
      applyPageAction(action.dataset.pageAction);
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
