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
      return tokenHostStateFromResponse(
        await api.handle({
          method: "POST",
          path: "/storage/tokenhost/upload",
          headers: {
            ...headers,
            "content-type": input.contentType ?? "application/octet-stream",
            "x-tokenhost-upload-filename": input.fileName ?? "upload.bin",
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
