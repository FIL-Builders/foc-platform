import { keccak256 } from "viem";
import { buildAdminSurfaces } from "../admin/reconciliation.mjs";
import {
  createRegistryReadModel,
  normalizeRegistryAccountUsage,
  normalizeRegistryCoordinatorPolicy,
  normalizeRegistryCopyReceipt,
  normalizeRegistryDatasetRecord,
  normalizeRegistryStorageObject,
  registryAccountIdsPageRead,
  registryAccountObjectIdsPageRead,
  registryCoordinatorAddressesPageRead,
  registryCoordinatorDetailRead,
  registryDatasetDetailRead,
  registryDatasetKeyId,
  registryDatasetKeysPageRead,
  registryDirectReadDefaults,
  registryObjectDetailReads,
  registryRelayerAddressesPageRead,
  registryRelayerDetailRead,
  registryStorageObjectIdsPageRead,
  registryUsageRead,
} from "../registry/read-model.mjs";

const DIRECT_READ_SOURCE = registryDirectReadDefaults.sourceOfTruth;

export function createTokenHostDemoClient({
  api,
  userId = "tokenhost-demo-user",
  walletAddress,
} = {}) {
  if (!api?.handle) {
    throw new Error("createTokenHostDemoClient requires a platform API handler");
  }

  const headers = createTokenHostAuthHeaders({ userId, walletAddress });

  return {
    async uploadFile(input = {}) {
      const bytes = input.bytes ?? new Uint8Array(input.size ?? 1);
      const size = input.size ?? uploadBodySize(bytes);
      const contentType = input.contentType ?? "application/octet-stream";
      const fileName = input.fileName ?? "upload.bin";
      return tokenHostStateFromResponse(
        await api.handle({
          method: "POST",
          path: "/storage/tokenhost/upload",
          headers: {
            ...headers,
            "content-type": contentType,
            "x-tokenhost-idempotency-key":
              input.idempotencyKey ??
              tokenHostUploadIdempotencyKey({ fileName, contentType, size, body: bytes }),
            "x-tokenhost-upload-filename": fileName,
            "x-tokenhost-upload-size": String(size),
          },
          body: bytes,
        }),
      );
    },

    async requestUpload(input = {}) {
      return tokenHostStateFromResponse(
        await api.handle({
          method: "POST",
          path: "/storage/upload",
          headers,
          body: {
            idempotencyKey: input.idempotencyKey,
            contentHash: input.contentHash ?? input.cid ?? input.label,
            metadataHash: input.metadataHash ?? input.label,
            size: input.size,
            requestedCopies: input.requestedCopies ?? 2,
            withCDN: input.withCDN ?? true,
            maxCost: input.maxCost ?? "0",
          },
        }),
      );
    },

    async submitBytes({ objectId, byteLength, receiptHash }) {
      return tokenHostStateFromResponse(
        await api.handle({
          method: "POST",
          path: `/storage/uploads/${objectId}/bytes`,
          headers,
          body: {
            byteLength,
            receiptHash,
          },
        }),
      );
    },

    async readStatus(objectId) {
      return tokenHostStateFromResponse(
        await api.handle({
          method: "GET",
          path: `/storage/uploads/${objectId}/status`,
          headers,
        }),
      );
    },

    async readObject(objectId) {
      return tokenHostStateFromResponse(
        await api.handle({
          method: "GET",
          path: `/storage/objects/${objectId}`,
          headers,
        }),
      );
    },

    async readUsage(accountId) {
      return tokenHostStateFromResponse(
        await api.handle({
          method: "GET",
          path: accountId ? `/storage/usage/${accountId}` : "/usage",
          headers,
        }),
      );
    },
  };
}

export function createTokenHostRegistryDirectReadAdapter({
  publicClient,
  registryAddress,
  maxPageSize = registryDirectReadDefaults.maxPageSize,
  includeTerminal = true,
  maxPagesPerSurface = 100,
  detailConcurrency = 4,
  now,
} = {}) {
  if (!publicClient?.readContract) {
    throw new Error("createTokenHostRegistryDirectReadAdapter requires publicClient.readContract");
  }
  if (!registryAddress) {
    throw new Error("createTokenHostRegistryDirectReadAdapter requires registryAddress");
  }

  const maxLimit = normalizeMaxPageSize(maxPageSize);
  const maxDetailConcurrency = normalizeConcurrency(detailConcurrency);

  async function readContract(read) {
    return await publicClient.readContract(read);
  }

  async function readObjectDetails(objectId) {
    const reads = registryObjectDetailReads(registryAddress, objectId);
    const [objectResult, receiptResults, receiptPayer] = await Promise.all([
      readContract(reads.object),
      readContract(reads.copyReceipts),
      readContract(reads.receiptPayer),
    ]);
    const object = normalizeRegistryStorageObject(objectResult);
    if (isMissingRegistryObject(object)) return null;
    const normalizedObjectId = object.objectId;

    return {
      objectId: normalizedObjectId,
      object: { ...object, objectId: normalizedObjectId },
      copyReceipts: Array.from(receiptResults ?? [], (receipt) =>
        normalizeRegistryCopyReceipt(receipt),
      ),
      receiptPayer,
    };
  }

  async function readObjectPage({
    cursorIdExclusive = 0n,
    limit = maxLimit,
    includeTerminal: pageIncludeTerminal = includeTerminal,
  } = {}) {
    const normalizedLimit = normalizePageLimit(limit, maxLimit);
    const page = await readCursorIdsPage({
      cursorIdExclusive,
      includeTerminal: pageIncludeTerminal,
      readPage: (effectiveCursorIdExclusive) =>
        readContract(
          registryStorageObjectIdsPageRead(registryAddress, {
            cursorIdExclusive: effectiveCursorIdExclusive,
            limit: normalizedLimit,
            includeTerminal: pageIncludeTerminal,
          }),
        ),
    });
    const ids = Array.from(page.values, decimalString);
    const objects = (
      await mapWithConcurrency(ids, maxDetailConcurrency, readObjectDetails)
    ).filter(Boolean);

    return {
      sourceOfTruth: DIRECT_READ_SOURCE,
      pagination: cursorPagination({
        cursorIdExclusive: page.cursorIdExclusive,
        requestedCursorIdExclusive: page.requestedCursorIdExclusive,
        limit: normalizedLimit,
        includeTerminal: pageIncludeTerminal,
        ids,
        restarted: page.restarted,
        restartReason: page.restartReason,
      }),
      ids,
      objects,
    };
  }

  async function readAccountPage({
    offset = 0n,
    limit = maxLimit,
    includeTerminal: accountObjectIncludeTerminal = includeTerminal,
  } = {}) {
    const normalizedLimit = normalizePageLimit(limit, maxLimit);
    const accountIds = Array.from(
      await readContract(
        registryAccountIdsPageRead(registryAddress, { offset, limit: normalizedLimit }),
      ),
    );
    const accounts = await mapWithConcurrency(
      accountIds,
      maxDetailConcurrency,
      async (accountId) => {
        const [usage, objectPage] = await Promise.all([
          readContract(registryUsageRead(registryAddress, accountId)),
          readAccountObjectPage(accountId, {
            cursorIdExclusive: 0n,
            limit: normalizedLimit,
            includeTerminal: accountObjectIncludeTerminal,
          }),
        ]);
        return {
          accountId,
          usage: normalizeRegistryAccountUsage(usage),
          objectIds: objectPage.ids,
          objectPagination: objectPage.pagination,
        };
      },
    );

    return {
      sourceOfTruth: DIRECT_READ_SOURCE,
      pagination: offsetPagination({ offset, limit: normalizedLimit, rows: accountIds }),
      accountIds,
      accounts,
    };
  }

  async function readAccountObjectPage(
    accountId,
    {
      cursorIdExclusive = 0n,
      limit = maxLimit,
      includeTerminal: pageIncludeTerminal = includeTerminal,
    } = {},
  ) {
    const normalizedLimit = normalizePageLimit(limit, maxLimit);
    const page = await readCursorIdsPage({
      cursorIdExclusive,
      includeTerminal: pageIncludeTerminal,
      readPage: (effectiveCursorIdExclusive) =>
        readContract(
          registryAccountObjectIdsPageRead(registryAddress, accountId, {
            cursorIdExclusive: effectiveCursorIdExclusive,
            limit: normalizedLimit,
            includeTerminal: pageIncludeTerminal,
          }),
        ),
    });
    const ids = Array.from(page.values, decimalString);

    return {
      sourceOfTruth: DIRECT_READ_SOURCE,
      accountId,
      pagination: cursorPagination({
        cursorIdExclusive: page.cursorIdExclusive,
        requestedCursorIdExclusive: page.requestedCursorIdExclusive,
        limit: normalizedLimit,
        includeTerminal: pageIncludeTerminal,
        ids,
        restarted: page.restarted,
        restartReason: page.restartReason,
      }),
      ids,
    };
  }

  async function readDatasetPage({ offset = 0n, limit = maxLimit } = {}) {
    const normalizedLimit = normalizePageLimit(limit, maxLimit);
    const rawKeys = Array.from(
      await readContract(
        registryDatasetKeysPageRead(registryAddress, { offset, limit: normalizedLimit }),
      ),
    );
    const keys = rawKeys.map(registryDatasetKeyId);
    const datasets = await mapWithConcurrency(
      rawKeys,
      maxDetailConcurrency,
      async (key) => {
        const dataset = normalizeRegistryDatasetRecord(
          await readContract(registryDatasetDetailRead(registryAddress, key)),
        );
        return {
          key: registryDatasetKeyId(key),
          dataset,
        };
      },
    );

    return {
      sourceOfTruth: DIRECT_READ_SOURCE,
      pagination: offsetPagination({ offset, limit: normalizedLimit, rows: rawKeys }),
      keys,
      datasets,
    };
  }

  async function readCoordinatorPage({ offset = 0n, limit = maxLimit } = {}) {
    const normalizedLimit = normalizePageLimit(limit, maxLimit);
    const addresses = Array.from(
      await readContract(
        registryCoordinatorAddressesPageRead(registryAddress, { offset, limit: normalizedLimit }),
      ),
    );
    const coordinators = await mapWithConcurrency(
      addresses,
      maxDetailConcurrency,
      async (coordinator) => ({
        coordinator: lower(coordinator),
        policy: normalizeRegistryCoordinatorPolicy(
          await readContract(registryCoordinatorDetailRead(registryAddress, coordinator)),
        ),
      }),
    );

    return {
      sourceOfTruth: DIRECT_READ_SOURCE,
      pagination: offsetPagination({ offset, limit: normalizedLimit, rows: addresses }),
      addresses,
      coordinators,
    };
  }

  async function readRelayerPage({ offset = 0n, limit = maxLimit } = {}) {
    const normalizedLimit = normalizePageLimit(limit, maxLimit);
    const addresses = Array.from(
      await readContract(
        registryRelayerAddressesPageRead(registryAddress, { offset, limit: normalizedLimit }),
      ),
    );
    const relayers = await mapWithConcurrency(
      addresses,
      maxDetailConcurrency,
      async (relayer) => ({
        relayer: lower(relayer),
        allowed: Boolean(await readContract(registryRelayerDetailRead(registryAddress, relayer))),
      }),
    );

    return {
      sourceOfTruth: DIRECT_READ_SOURCE,
      pagination: offsetPagination({ offset, limit: normalizedLimit, rows: addresses }),
      addresses,
      relayers,
    };
  }

  async function readRegistryModel(options = {}) {
    const model = createRegistryReadModel();
    const pageLimit = normalizePageLimit(options.limit ?? maxLimit, maxLimit);
    const surfaces = registrySurfacesForRoute(options.route);

    if (surfaces.objectId) {
      await mergeObjectDetail(model, surfaces.objectId);
      return model;
    }

    if (surfaces.objects) await mergeObjectPages(model, pageLimit, options);
    if (surfaces.accounts) await mergeAccountPages(model, pageLimit, options);
    if (surfaces.datasets) await mergeDatasetPages(model, pageLimit);
    if (surfaces.coordinators) await mergeCoordinatorPages(model, pageLimit);
    if (surfaces.relayers) await mergeRelayerPages(model, pageLimit);

    return model;
  }

  async function mergeObjectDetail(model, objectId) {
    const row = await readObjectDetails(objectId);
    if (!row) return;
    model.objects[row.objectId] = row.object;
    model.copyReceipts[row.objectId] = row.copyReceipts;
    model.receiptPayers[row.objectId] = row.receiptPayer;
  }

  async function mergeObjectPages(model, pageLimit, options) {
    let cursorIdExclusive = 0n;
    for (let page = 0; page < maxPagesPerSurface; page += 1) {
      const result = await readObjectPage({
        cursorIdExclusive,
        limit: pageLimit,
        includeTerminal: options.includeTerminal ?? includeTerminal,
      });
      for (const row of result.objects) {
        if (!row) continue;
        model.objects[row.objectId] = row.object;
        model.copyReceipts[row.objectId] = row.copyReceipts;
        model.receiptPayers[row.objectId] = row.receiptPayer;
      }
      if (isLastCursorPage(result.ids, pageLimit)) return;
      const nextCursor = BigInt(result.ids.at(-1));
      const effectiveCursor = BigInt(result.pagination.cursorIdExclusive);
      if (nextCursor === effectiveCursor) {
        throw new Error("registry object cursor did not advance");
      }
      cursorIdExclusive = nextCursor;
    }
    throw new Error("registry object pagination exceeded maxPagesPerSurface");
  }

  async function mergeAccountPages(model, pageLimit, options) {
    await forEachOffsetPage(pageLimit, async (offset) => readAccountPage({
      offset,
      limit: pageLimit,
      includeTerminal: options.includeTerminal ?? includeTerminal,
    }), (result) => {
      for (const row of result.accounts) {
        model.usage[row.accountId] = row.usage;
      }
      return result.accounts.length;
    });
  }

  async function mergeDatasetPages(model, pageLimit) {
    await forEachOffsetPage(pageLimit, async (offset) => readDatasetPage({
      offset,
      limit: pageLimit,
    }), (result) => {
      for (const row of result.datasets) {
        model.datasets[row.key] = row.dataset;
      }
      return result.datasets.length;
    });
  }

  async function mergeCoordinatorPages(model, pageLimit) {
    await forEachOffsetPage(pageLimit, async (offset) => readCoordinatorPage({
      offset,
      limit: pageLimit,
    }), (result) => {
      for (const row of result.coordinators) {
        model.coordinators[row.coordinator] = row.policy;
      }
      return result.coordinators.length;
    });
  }

  async function mergeRelayerPages(model, pageLimit) {
    await forEachOffsetPage(pageLimit, async (offset) => readRelayerPage({
      offset,
      limit: pageLimit,
    }), (result) => {
      for (const row of result.relayers) {
        model.relayers[row.relayer] = row.allowed;
      }
      return result.relayers.length;
    });
  }

  async function forEachOffsetPage(pageLimit, readPage, applyPage) {
    let offset = 0n;
    for (let page = 0; page < maxPagesPerSurface; page += 1) {
      const result = await readPage(offset);
      const rowCount = applyPage(result);
      if (rowCount < Number(pageLimit) || pageLimit === 0n) return;
      offset += BigInt(rowCount);
    }
    throw new Error("registry offset pagination exceeded maxPagesPerSurface");
  }

  async function readAdminSurfaces(options = {}) {
    const model = await readRegistryModel(options);
    return buildAdminSurfaces(
      { model },
      {
        ...options,
        now: options.now ?? now ?? currentUnixSeconds(),
      },
    );
  }

  return {
    sourceOfTruth: DIRECT_READ_SOURCE,
    maxPageSize: Number(maxLimit),
    detailConcurrency: maxDetailConcurrency,
    readObjectPage,
    readAccountPage,
    readAccountObjectPage,
    readDatasetPage,
    readCoordinatorPage,
    readRelayerPage,
    readRegistryModel,
    readAdminSurfaces,
  };
}

export async function runTokenHostDemoFlow({
  client,
  upload = {},
} = {}) {
  const request = await client.requestUpload({
    label: upload.label ?? "demo-upload",
    idempotencyKey: upload.idempotencyKey ?? "tokenhost-demo-upload",
    contentHash: upload.contentHash ?? "tokenhost-demo-content",
    metadataHash: upload.metadataHash ?? "tokenhost-demo-metadata",
    size: upload.size ?? 1024,
    requestedCopies: upload.requestedCopies ?? 2,
    withCDN: upload.withCDN ?? true,
    maxCost: upload.maxCost ?? "0",
  });

  const objectId = request.request.objectId;
  const bytes = await client.submitBytes({
    objectId,
    byteLength: upload.size ?? 1024,
    receiptHash: upload.receiptHash,
  });
  const status = await client.readStatus(objectId);
  const object = await client.readObject(objectId);
  const usage = await client.readUsage(request.request.accountId);

  return {
    request,
    bytes,
    status,
    object,
    usage,
    screens: buildTokenHostScreens({ request, status, object, usage }),
  };
}

export function createTokenHostAuthHeaders({ userId, walletAddress } = {}) {
  const headers = {
    "x-platform-user-id": userId,
  };
  if (walletAddress) {
    headers["x-platform-wallet-address"] = walletAddress;
  }
  return headers;
}

export function tokenHostStateFromResponse(response) {
  if (response.status >= 400) {
    return {
      ok: false,
      status: response.status,
      error: response.body.error,
    };
  }

  const body = response.body;
  const request = body.request ?? body.upload ?? body.object;
  const usage = body.usage;

  return {
    ok: true,
    status: response.status,
    request: body.request,
    upload: body.upload,
    object: body.object,
    usage,
    copyReceipts: body.copyReceipts ?? [],
    receiptPayer: body.receiptPayer,
    projection: body.projection,
    links: body.links ?? uploadLinks(request?.objectId),
    mocked: body.mocked,
  };
}

export function buildTokenHostScreens({ request, status, object, usage }) {
  return [
    {
      id: "request",
      label: "Upload request",
      state: request.request?.status ?? request.upload?.status,
      primaryValue: request.request?.objectId ?? request.upload?.objectId,
    },
    {
      id: "status",
      label: "Upload status",
      state: status.upload?.status,
      primaryValue: status.upload?.objectId,
    },
    {
      id: "object",
      label: "Object receipt",
      state: object.object?.status,
      primaryValue: object.object?.receiptHash,
    },
    {
      id: "usage",
      label: "Account usage",
      state: usage.usage?.activeObjects,
      primaryValue: usage.usage?.activeBytes,
    },
  ];
}

function uploadLinks(objectId) {
  if (objectId === undefined || objectId === null) return undefined;
  return {
    uploadBytes: `/storage/uploads/${objectId}/bytes`,
    status: `/storage/uploads/${objectId}`,
    statusAlias: `/storage/uploads/${objectId}/status`,
    object: `/storage/objects/${objectId}`,
    usage: "/usage",
  };
}

function registrySurfacesForRoute(route) {
  switch (route?.name) {
    case "object":
      return { objectId: route.params?.objectId };
    case "objects":
      return { objects: true };
    case "usage":
      return { objects: true, accounts: true };
    case "datasets":
      return { objects: true, datasets: true };
    case "coordinators":
      return { objects: true, coordinators: true, relayers: true };
    case "dashboard":
    case "reconciliation":
    default:
      return {
        objects: true,
        accounts: true,
        datasets: true,
        coordinators: true,
        relayers: true,
      };
  }
}

async function readCursorIdsPage({ cursorIdExclusive, includeTerminal, readPage }) {
  const requestedCursorIdExclusive = BigInt(cursorIdExclusive);
  try {
    return {
      values: await readPage(requestedCursorIdExclusive),
      cursorIdExclusive: requestedCursorIdExclusive,
      requestedCursorIdExclusive,
      restarted: false,
    };
  } catch (error) {
    if (
      includeTerminal ||
      requestedCursorIdExclusive === 0n ||
      !isActiveCursorTraversalLimitExceeded(error)
    ) {
      throw error;
    }

    return {
      values: await readPage(0n),
      cursorIdExclusive: 0n,
      requestedCursorIdExclusive,
      restarted: true,
      restartReason: "ActiveCursorTraversalLimitExceeded",
    };
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  if (values.length === 0) return [];
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function isActiveCursorTraversalLimitExceeded(error) {
  let current = error;
  while (current) {
    if (
      current.name === "ActiveCursorTraversalLimitExceeded" ||
      current.errorName === "ActiveCursorTraversalLimitExceeded" ||
      String(current.shortMessage ?? "").includes("ActiveCursorTraversalLimitExceeded") ||
      String(current.message ?? "").includes("ActiveCursorTraversalLimitExceeded")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function cursorPagination({
  cursorIdExclusive,
  requestedCursorIdExclusive = cursorIdExclusive,
  limit,
  includeTerminal,
  ids,
  restarted = false,
  restartReason,
}) {
  const pagination = {
    mode: "objectIdCursor",
    cursorIdExclusive: decimalString(cursorIdExclusive),
    nextCursorIdExclusive: ids.length > 0 ? ids.at(-1) : decimalString(cursorIdExclusive),
    limit: decimalString(limit),
    includeTerminal: Boolean(includeTerminal),
  };
  if (restarted) {
    pagination.requestedCursorIdExclusive = decimalString(requestedCursorIdExclusive);
    pagination.restarted = true;
    pagination.restartReason = restartReason;
  }
  return pagination;
}

function offsetPagination({ offset, limit, rows }) {
  return {
    mode: "offset",
    offset: decimalString(offset),
    nextOffset: (BigInt(offset) + BigInt(rows.length)).toString(),
    limit: decimalString(limit),
  };
}

function isLastCursorPage(ids, limit) {
  return limit === 0n || ids.length < Number(limit);
}

function normalizeMaxPageSize(maxPageSize) {
  const value = BigInt(maxPageSize);
  if (value < 0n) throw new Error("maxPageSize must be non-negative");
  return value;
}

function normalizePageLimit(limit, maxPageSize) {
  const value = BigInt(limit);
  if (value < 0n) throw new Error("registry page limit must be non-negative");
  if (value > maxPageSize) {
    throw new Error(`registry page limit ${value} exceeds maxPageSize ${maxPageSize}`);
  }
  return value;
}

function normalizeConcurrency(concurrency) {
  const value = Number(concurrency);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("detailConcurrency must be a positive integer");
  }
  return value;
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isMissingRegistryObject(object) {
  return object.objectId === "0";
}

function decimalString(value) {
  return BigInt(value).toString();
}

function lower(address) {
  return String(address).toLowerCase();
}

function tokenHostUploadIdempotencyKey({ fileName, contentType, size, body }) {
  return `tokenhost-upload:${fileName}:${contentType}:${String(size)}:${tokenHostUploadBodyHash(body)}`;
}

function tokenHostUploadBodyHash(body) {
  const bytes = tokenHostUploadBodyBytes(body);
  return bytes ? keccak256(bytes) : `size:${String(uploadBodySize(body))}`;
}

function tokenHostUploadBodyBytes(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return Uint8Array.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Uint8Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (Array.isArray(body)) {
    if (!body.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return undefined;
    }
    return Uint8Array.from(body);
  }
  return undefined;
}

function uploadBodySize(body) {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof body.byteLength === "number") return body.byteLength;
  if (typeof body.size === "number") return body.size;
  if (typeof body.length === "number") return body.length;
  return 0;
}
