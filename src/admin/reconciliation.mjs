import {
  applyRegistryEvents,
  createRegistryReadModel,
} from "../registry/read-model.mjs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const UPLOAD_STATUS_LABELS = [
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
const STORED_STATUSES = new Set(["Committed", "Partial"]);
const PENDING_STATUSES = new Set(["Requested", "Uploading"]);

export const ADMIN_SOURCE_OF_TRUTH = Object.freeze({
  platformState: "FocPlatformRegistry contract views and reconstructed registry events",
  focState: "FOC contracts, provider-confirmed transactions, datasets, pieces, and payment rails",
  nonAuthoritative: [
    "coordinator-private state",
    "generated Token Host generic CRUD state",
    "platform API cache state",
  ],
});

export function buildAdminSurfaces(input = {}, options = {}) {
  const model = resolveModel(input);
  const now = timestampSeconds(options.now ?? input.now);
  const quotas = normalizeQuotas(options.quotas ?? input.quotas);
  const focEvidence = options.focEvidence ?? input.focEvidence ?? {};

  const objectDetails = buildObjectDetails(model, { focEvidence });
  const usage = buildUsageRows(model, objectDetails, quotas);
  const datasets = buildDatasetRows(model, objectDetails);
  const providers = buildProviderRows(datasets, objectDetails);
  const coordinators = buildCoordinatorRows(model, objectDetails, { now });
  const relayers = buildRelayerRows(model);
  const reconciliation = buildReconciliation({
    objectDetails,
    usage,
    coordinators,
  });

  const checksByObject = groupBy(reconciliation.checks, "objectId");
  const objects = objectDetails.map((detail) => buildObjectRow(detail, checksByObject));
  const detailRows = objectDetails.map((detail) => ({
    ...detail,
    issues: checksByObject[detail.objectId] ?? [],
    reconciliationStatus: statusForChecks(checksByObject[detail.objectId] ?? []),
  }));

  return {
    version: "0.1.0",
    sourceOfTruth: ADMIN_SOURCE_OF_TRUTH,
    summary: buildSummary({
      objects,
      usage,
      datasets,
      providers,
      coordinators,
      relayers,
      reconciliation,
    }),
    objects,
    objectDetails: detailRows,
    usage,
    datasets,
    providers,
    coordinators,
    relayers,
    reconciliation,
  };
}

export function buildAdminSurfacesFromEvents(events, options = {}) {
  return buildAdminSurfaces({ events }, options);
}

function resolveModel(input) {
  if (Array.isArray(input)) {
    return applyRegistryEvents(input);
  }
  if (input.events) {
    return applyRegistryEvents(input.events);
  }
  if (input.model) {
    return input.model;
  }
  if (
    input.objects ||
    input.usage ||
    input.copyReceipts ||
    input.receiptPayers ||
    input.datasets ||
    input.coordinators ||
    input.relayers
  ) {
    return input;
  }
  return createRegistryReadModel();
}

function buildObjectDetails(model, { focEvidence }) {
  return sortedObjectEntries(model.objects ?? {}).map(([objectId, object]) => {
    const normalizedObject = normalizeObject(objectId, object);
    const copyReceipts = Array.from(model.copyReceipts?.[objectId] ?? []).map((receipt) =>
      normalizeCopyReceipt(receipt),
    );
    const receiptPayer = model.receiptPayers?.[objectId] ?? object.receiptPayer ?? null;
    const evidence = objectEvidence(focEvidence, objectId);
    const accountId = object.accountId ?? null;

    return {
      objectId,
      object: normalizedObject,
      accountId,
      user: object.user ?? null,
      status: normalizedObject.status,
      size: normalizedObject.size,
      requestedCopies: normalizedObject.requestedCopies,
      completedCopies: normalizedObject.completedCopies,
      expectedCopies: expectedCopies(normalizedObject),
      activeBytes: activeBytes(normalizedObject),
      requestedBytes: requestedBytes(normalizedObject),
      reservedCost: normalizedObject.reservedCost,
      copyReceipts,
      receiptPayer,
      datasetAttribution: copyReceipts.map((receipt) =>
        buildCopyDatasetAttribution(model, accountId, receipt),
      ),
      focEvidence: evidence ?? null,
      focEvidenceStatus: focEvidenceStatus(evidence),
    };
  });
}

function normalizeObject(objectId, object) {
  return {
    ...object,
    objectId,
    status: normalizeUploadStatus(object.status),
    size: decimal(object.size),
    requestedCopies: numberValue(object.requestedCopies),
    completedCopies: numberValue(object.completedCopies),
    maxCost: decimal(object.maxCost),
    reservedCost: decimal(object.reservedCost ?? object.maxCost),
    actualCost: decimal(object.actualCost),
  };
}

function normalizeUploadStatus(value) {
  if (value === undefined || value === null || value === "") return "Unknown";
  if (typeof value === "string" && !/^\d+$/.test(value)) return value;

  const numericStatus = Number(value);
  if (!Number.isInteger(numericStatus)) return `Unknown(${String(value)})`;
  return UPLOAD_STATUS_LABELS[numericStatus] ?? `Unknown(${String(value)})`;
}

function normalizeCopyReceipt(receipt) {
  return {
    providerId: decimal(receipt.providerId),
    datasetId: decimal(receipt.datasetId),
    pieceId: decimal(receipt.pieceId),
    addPieceTxHash: receipt.addPieceTxHash,
    retrievalUrlHash: receipt.retrievalUrlHash,
    isNewDataSet: Boolean(receipt.isNewDataSet),
  };
}

function buildCopyDatasetAttribution(model, accountId, receipt) {
  const datasetKey = datasetKeyFor(accountId, receipt.providerId, receipt.datasetId);
  const dataset = datasetKey ? model.datasets?.[datasetKey] : undefined;
  return {
    ...receipt,
    accountId,
    datasetKey,
    datasetRecordStatus: dataset ? "recorded" : "missing",
    dataset: dataset ? normalizeDataset(datasetKey, dataset) : null,
  };
}

function buildObjectRow(detail, checksByObject) {
  const issues = checksByObject[detail.objectId] ?? [];
  return {
    objectId: detail.objectId,
    accountId: detail.accountId,
    status: detail.status,
    size: detail.size,
    requestedCopies: detail.requestedCopies,
    completedCopies: detail.completedCopies,
    expectedCopies: detail.expectedCopies,
    activeBytes: detail.activeBytes,
    copyCount: detail.copyReceipts.length,
    providerIds: uniqueSorted(detail.copyReceipts.map((receipt) => receipt.providerId)),
    datasetIds: uniqueSorted(detail.copyReceipts.map((receipt) => receipt.datasetId)),
    receiptHash: detail.object.receiptHash ?? null,
    receiptPayer: detail.receiptPayer,
    coordinator: detail.object.coordinator ?? null,
    focEvidenceStatus: detail.focEvidenceStatus,
    issueCount: issues.length,
    reconciliationStatus: statusForChecks(issues),
  };
}

function buildUsageRows(model, objectDetails, quotas) {
  const accounts = new Set(Object.keys(model.usage ?? {}));
  for (const detail of objectDetails) {
    if (detail.accountId) accounts.add(detail.accountId);
  }

  return Array.from(accounts)
    .sort()
    .map((accountId) => {
      const usage = model.usage?.[accountId] ?? {};
      const accountObjects = objectDetails.filter((detail) => detail.accountId === accountId);
      const projectedActiveBytes = sum(accountObjects.map((detail) => detail.activeBytes));
      const projectedPendingBytes = sum(
        accountObjects
          .filter((detail) => PENDING_STATUSES.has(detail.status))
          .map((detail) => detail.requestedBytes),
      );
      const projectedReservedCost = sum(
        accountObjects
          .filter((detail) => PENDING_STATUSES.has(detail.status))
          .map((detail) => detail.reservedCost),
      );
      const quota = quotas[accountId] ?? null;
      const maxActiveBytes = quota?.maxActiveBytes ?? null;

      return {
        accountId,
        activeBytes: decimal(usage.activeBytes),
        activeObjects: decimal(usage.activeObjects),
        pendingBytes: decimal(usage.pendingBytes),
        reservedCost: decimal(usage.reservedCost),
        totalActualCost: decimal(usage.totalActualCost),
        totalUploadedBytes: decimal(usage.totalUploadedBytes),
        totalRequestedUploads: decimal(usage.totalRequestedUploads),
        totalFinalizedUploads: decimal(usage.totalFinalizedUploads),
        totalFailedUploads: decimal(usage.totalFailedUploads),
        projectedActiveBytes,
        projectedPendingBytes,
        projectedReservedCost,
        quota: quota
          ? {
              maxActiveBytes,
              activeBytesRemaining:
                maxActiveBytes === null ? null : subtract(maxActiveBytes, usage.activeBytes),
              runwayStatus:
                maxActiveBytes === null
                  ? "unknown"
                  : compare(usage.activeBytes, maxActiveBytes) > 0
                    ? "over_quota"
                    : "within_quota",
            }
          : null,
      };
    });
}

function buildDatasetRows(model, objectDetails) {
  const rows = new Map();

  for (const [key, dataset] of Object.entries(model.datasets ?? {})) {
    rows.set(key, {
      ...normalizeDataset(key, dataset),
      copyCount: 0,
      objectIds: [],
      missingDatasetRecord: false,
    });
  }

  for (const detail of objectDetails) {
    for (const copy of detail.datasetAttribution) {
      const key = copy.datasetKey;
      if (!key) continue;
      if (!rows.has(key)) {
        rows.set(key, {
          key,
          accountId: detail.accountId,
          providerId: copy.providerId,
          datasetId: copy.datasetId,
          payer: null,
          storageClass: null,
          withCDN: null,
          updatedAt: null,
          copyCount: 0,
          objectIds: [],
          missingDatasetRecord: true,
        });
      }
      const row = rows.get(key);
      row.copyCount += 1;
      row.objectIds = uniqueSorted([...row.objectIds, detail.objectId]);
    }
  }

  return Array.from(rows.values()).sort(compareDatasetRows);
}

function normalizeDataset(key, dataset) {
  return {
    key,
    accountId: dataset.accountId,
    providerId: decimal(dataset.providerId),
    datasetId: decimal(dataset.datasetId),
    payer: dataset.payer,
    storageClass: dataset.storageClass,
    withCDN: Boolean(dataset.withCDN),
    updatedAt: dataset.updatedAt ?? null,
  };
}

function buildProviderRows(datasets, objectDetails) {
  const rows = new Map();
  for (const dataset of datasets) {
    const row = ensureProviderRow(rows, dataset.providerId);
    row.datasetKeys = uniqueSorted([...row.datasetKeys, dataset.key]);
    row.accounts = uniqueSorted([...row.accounts, dataset.accountId].filter(Boolean));
    row.copyCount += dataset.copyCount;
    row.missingDatasetRecords += dataset.missingDatasetRecord ? 1 : 0;
  }

  for (const detail of objectDetails) {
    for (const copy of detail.copyReceipts) {
      const row = ensureProviderRow(rows, copy.providerId);
      row.objectIds = uniqueSorted([...row.objectIds, detail.objectId]);
    }
  }

  return Array.from(rows.values()).sort((left, right) => compare(left.providerId, right.providerId));
}

function ensureProviderRow(rows, providerId) {
  if (!rows.has(providerId)) {
    rows.set(providerId, {
      providerId,
      datasetKeys: [],
      objectIds: [],
      accounts: [],
      copyCount: 0,
      missingDatasetRecords: 0,
    });
  }
  return rows.get(providerId);
}

function buildCoordinatorRows(model, objectDetails, { now }) {
  const coordinators = new Map();
  for (const [coordinator, policy] of Object.entries(model.coordinators ?? {})) {
    coordinators.set(coordinator.toLowerCase(), {
      coordinator: coordinator.toLowerCase(),
      allowed: Boolean(policy.allowed),
      maxFinalizeDelay: decimal(policy.maxFinalizeDelay),
      sessionKeyExpiresAt: decimal(policy.sessionKeyExpiresAt),
      permissionsHash: policy.permissionsHash,
    });
  }
  for (const detail of objectDetails) {
    const coordinator = normalizedCoordinator(detail.object.coordinator);
    if (coordinator && !coordinators.has(coordinator)) {
      coordinators.set(coordinator, {
        coordinator,
        allowed: false,
        maxFinalizeDelay: "0",
        sessionKeyExpiresAt: "0",
        permissionsHash: ZERO_BYTES32,
        missingPolicy: true,
      });
    }
  }

  return Array.from(coordinators.values())
    .map((row) => {
      const objects = objectDetails.filter(
        (detail) => normalizedCoordinator(detail.object.coordinator) === row.coordinator,
      );
      return {
        ...row,
        sessionStatus: coordinatorSessionStatus(row, now),
        objectCount: objects.length,
        uploadingObjectCount: objects.filter((detail) => detail.status === "Uploading").length,
        activeObjectIds: objects
          .filter((detail) => ["Requested", "Uploading"].includes(detail.status))
          .map((detail) => detail.objectId),
      };
    })
    .sort((left, right) => left.coordinator.localeCompare(right.coordinator));
}

function buildRelayerRows(model) {
  return Object.entries(model.relayers ?? {})
    .map(([relayer, allowed]) => ({ relayer: relayer.toLowerCase(), allowed: Boolean(allowed) }))
    .sort((left, right) => left.relayer.localeCompare(right.relayer));
}

function buildReconciliation({ objectDetails, usage, coordinators }) {
  const checks = [
    ...objectChecks(objectDetails),
    ...usageChecks(usage),
    ...coordinatorChecks(objectDetails, coordinators),
  ];
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
    checks,
  };
}

function objectChecks(objectDetails) {
  const checks = [];
  for (const detail of objectDetails) {
    const receiptHash = detail.object.receiptHash;
    for (const copy of detail.datasetAttribution) {
      if (copy.datasetRecordStatus === "missing") {
        checks.push(check("warning", "missing_dataset_record", detail, {
          providerId: copy.providerId,
          datasetId: copy.datasetId,
          datasetKey: copy.datasetKey,
        }));
      }
    }
    if (detail.status === "Committed" && detail.completedCopies !== detail.requestedCopies) {
      checks.push(check("error", "committed_copy_count_mismatch", detail, {
        expectedCopies: String(detail.requestedCopies),
        actualCopies: String(detail.completedCopies),
      }));
    }
    if (STORED_STATUSES.has(detail.status)) {
      if (detail.copyReceipts.length !== detail.completedCopies) {
        checks.push(check("error", "copy_receipt_count_mismatch", detail, {
          expectedCopies: String(detail.completedCopies),
          actualCopies: String(detail.copyReceipts.length),
        }));
      }
      if (!receiptHash || isZeroBytes32(receiptHash)) {
        checks.push(check("error", "missing_receipt_hash", detail));
      }
      if (!detail.receiptPayer || isZeroAddress(detail.receiptPayer)) {
        checks.push(check("error", "missing_receipt_payer", detail));
      }
      checks.push(...focEvidenceChecks(detail));
    }
    if (["Failed", "Cancelled", "Expired"].includes(detail.status) && detail.copyReceipts.length > 0) {
      checks.push(check("warning", "terminal_object_has_copy_receipts", detail, {
        copyCount: String(detail.copyReceipts.length),
      }));
    }
  }
  return checks;
}

function focEvidenceChecks(detail) {
  if (!detail.focEvidence) {
    return [check("info", "foc_evidence_not_checked", detail)];
  }
  if (detail.focEvidence.verified === false) {
    return [check("error", "foc_evidence_failed", detail)];
  }
  const verifiedCopies = detail.focEvidence.verifiedCopies ?? detail.focEvidence.copyCount;
  if (verifiedCopies !== undefined && Number(verifiedCopies) !== detail.copyReceipts.length) {
    return [
      check("error", "foc_copy_evidence_mismatch", detail, {
        expectedCopies: String(detail.copyReceipts.length),
        verifiedCopies: String(verifiedCopies),
      }),
    ];
  }
  return [];
}

function usageChecks(usageRows) {
  const checks = [];
  for (const row of usageRows) {
    if (row.activeBytes !== row.projectedActiveBytes) {
      checks.push(accountCheck("error", "usage_active_bytes_mismatch", row, {
        expectedActiveBytes: row.projectedActiveBytes,
        actualActiveBytes: row.activeBytes,
      }));
    }
    if (row.pendingBytes !== row.projectedPendingBytes) {
      checks.push(accountCheck("error", "usage_pending_bytes_mismatch", row, {
        expectedPendingBytes: row.projectedPendingBytes,
        actualPendingBytes: row.pendingBytes,
      }));
    }
    if (row.reservedCost !== row.projectedReservedCost) {
      checks.push(accountCheck("error", "usage_reserved_cost_mismatch", row, {
        expectedReservedCost: row.projectedReservedCost,
        actualReservedCost: row.reservedCost,
      }));
    }
    if (row.quota?.runwayStatus === "over_quota") {
      checks.push(accountCheck("warning", "account_over_quota", row, {
        maxActiveBytes: row.quota.maxActiveBytes,
        activeBytes: row.activeBytes,
      }));
    }
  }
  return checks;
}

function coordinatorChecks(objectDetails, coordinators) {
  const checks = [];
  const coordinatorByAddress = Object.fromEntries(
    coordinators.map((coordinator) => [coordinator.coordinator, coordinator]),
  );

  for (const detail of objectDetails) {
    if (detail.status !== "Uploading") continue;
    const coordinator = normalizedCoordinator(detail.object.coordinator);
    if (!coordinator) {
      checks.push(check("error", "uploading_object_missing_coordinator", detail));
      continue;
    }
    const row = coordinatorByAddress[coordinator];
    if (!row?.allowed || row.missingPolicy) {
      checks.push(check("error", "uploading_object_disallowed_coordinator", detail, {
        coordinator,
      }));
    } else if (row.sessionStatus === "expired") {
      checks.push(check("error", "uploading_object_expired_coordinator", detail, {
        coordinator,
        sessionKeyExpiresAt: row.sessionKeyExpiresAt,
      }));
    }
  }

  return checks;
}

function normalizedCoordinator(value) {
  if (isZeroAddress(value)) return null;
  return String(value).toLowerCase();
}

function check(severity, code, detail, fields = {}) {
  return {
    severity,
    code,
    objectId: detail.objectId,
    accountId: detail.accountId,
    status: detail.status,
    ...fields,
  };
}

function accountCheck(severity, code, row, fields = {}) {
  return {
    severity,
    code,
    accountId: row.accountId,
    ...fields,
  };
}

function buildSummary({
  objects,
  usage,
  datasets,
  providers,
  coordinators,
  relayers,
  reconciliation,
}) {
  return {
    objectCount: objects.length,
    accountCount: usage.length,
    datasetCount: datasets.length,
    providerCount: providers.length,
    coordinatorCount: coordinators.length,
    relayerCount: relayers.length,
    mismatchCount: reconciliation.mismatchCount,
    warningCount: reconciliation.warningCount,
    pendingEvidenceCount: reconciliation.pendingEvidenceCount,
    reconciliationStatus: reconciliation.status,
    objectStatuses: countBy(objects, "status"),
  };
}

function coordinatorSessionStatus(row, now) {
  if (!row.allowed) return "disabled";
  if (isZero(row.sessionKeyExpiresAt)) return "active";
  if (now === undefined) return "unknown";
  return compare(now, row.sessionKeyExpiresAt) > 0 ? "expired" : "active";
}

function expectedCopies(object) {
  if (object.status === "Committed") return numberValue(object.requestedCopies);
  if (object.status === "Partial") return numberValue(object.completedCopies);
  if (object.status === "Failed") return 0;
  return numberValue(object.requestedCopies);
}

function activeBytes(object) {
  if (!STORED_STATUSES.has(object.status)) return "0";
  return multiply(object.size, object.completedCopies);
}

function requestedBytes(object) {
  return multiply(object.size, object.requestedCopies);
}

function focEvidenceStatus(evidence) {
  if (!evidence) return "not_checked";
  if (evidence.verified === false) return "failed";
  return "checked";
}

function objectEvidence(focEvidence, objectId) {
  if (!focEvidence) return undefined;
  if (focEvidence.objects?.[objectId]) return focEvidence.objects[objectId];
  return focEvidence[objectId];
}

function normalizeQuotas(quotas = {}) {
  return Object.fromEntries(
    Object.entries(quotas).map(([accountId, quota]) => [
      accountId,
      {
        maxActiveBytes:
          quota?.maxActiveBytes === undefined && quota?.maxActiveBytesPerAccount === undefined
            ? null
            : decimal(quota.maxActiveBytes ?? quota.maxActiveBytesPerAccount),
      },
    ]),
  );
}

function statusForChecks(checks) {
  if (checks.some((issue) => issue.severity === "error")) return "mismatch";
  if (checks.some((issue) => issue.severity === "warning")) return "warning";
  if (checks.some((issue) => issue.code === "foc_evidence_not_checked")) {
    return "pending_external_evidence";
  }
  return "matched";
}

function sortedObjectEntries(objects) {
  return Object.entries(objects).sort(([left], [right]) => compare(left, right));
}

function compareDatasetRows(left, right) {
  return (
    compare(left.providerId, right.providerId) ||
    compare(left.datasetId, right.datasetId) ||
    left.key.localeCompare(right.key)
  );
}

function groupBy(rows, field) {
  const grouped = {};
  for (const row of rows) {
    const key = row[field];
    if (key === undefined || key === null) continue;
    grouped[key] ??= [];
    grouped[key].push(row);
  }
  return grouped;
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = row[field] ?? "Unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function datasetKeyFor(accountId, providerId, datasetId) {
  if (!accountId) return null;
  return `${accountId}:${decimal(providerId)}:${decimal(datasetId)}`;
}

function timestampSeconds(value) {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000).toString();
  return decimal(value);
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter((value) => value !== undefined && value !== null))).sort(
    (left, right) => {
      try {
        return compare(left, right);
      } catch {
        return String(left).localeCompare(String(right));
      }
    },
  );
}

function sum(values) {
  return values.reduce((total, value) => (bigint(total) + bigint(value)).toString(), "0");
}

function subtract(left, right) {
  return (bigint(left) - bigint(right)).toString();
}

function multiply(left, right) {
  return (bigint(left) * bigint(right)).toString();
}

function compare(left, right) {
  const leftValue = bigint(left);
  const rightValue = bigint(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return 0;
  return Number(bigint(value));
}

function decimal(value) {
  return bigint(value).toString();
}

function bigint(value) {
  if (value === undefined || value === null || value === "") return 0n;
  return typeof value === "bigint" ? value : BigInt(value);
}

function isZero(value) {
  return bigint(value) === 0n;
}

function isZeroAddress(value) {
  return !value || String(value).toLowerCase() === ZERO_ADDRESS;
}

function isZeroBytes32(value) {
  return !value || String(value).toLowerCase() === ZERO_BYTES32;
}
