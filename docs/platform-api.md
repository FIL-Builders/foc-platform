# Platform API Surface

The platform API module is a dependency-free route-equivalent contract for the
normal product API and generated Token Host UI. It does not start an HTTP
server; a Worker, Node server, or generated adapter can wrap the same
`createPlatformApi({ registry })` handler.

## Routes

Canonical routes follow `spec.md` section 6.7.10:

```http
POST /storage/upload-requests
POST /storage/uploads/:objectId/bytes
GET  /storage/uploads/:objectId/status
GET  /storage/uploads/status?objectId=:objectId
GET  /storage/objects/:objectId
GET  /storage/usage/:accountId
```

The implementation also accepts issue/UI aliases:

```http
POST /storage/upload
POST /storage/tokenhost/upload
GET  /storage/tokenhost/upload/status
GET  /storage/uploads/:objectId
GET  /usage
```

`POST /storage/tokenhost/upload` and
`GET /storage/tokenhost/upload/status` are the generated Token Host upload
adapter endpoints. They speak Token Host Builder's byte-upload contract and
then bridge into the section 6.7 create/submit/read model. The canonical object
status route remains `GET /storage/uploads/:objectId/status`; the
`GET /storage/uploads/status?objectId=:objectId` alias is only an object-status
read alias.

Requests use normal platform authentication outside this repo. The current
handler requires `x-platform-user-id` as the authenticated platform subject and
accepts optional `x-platform-wallet-address` when the product has a user wallet.
The API maps that subject to an opaque bytes32 `accountId`; raw user ids are not
written into contract request parameters or returned as onchain identifiers.

## Registry Adapter Boundary

`createPlatformApi` delegates contract work to a registry adapter with:

- `createUploadRequest({ account, auth, request })`,
- `submitUploadBytes({ objectId, account, auth, bytes })`,
- `readUploadStatus({ objectId, account, auth })`,
- `readObject({ objectId, account, auth })`,
- `readUsage({ account, auth })`.

The adapter is responsible for using the section 6.7 registry, relayer,
coordinator, and read-model semantics. API reads must come from contract views
or reconstructed event state, not from coordinator-private state.

## Idempotency And Retry

`POST /storage/upload-requests` and its `POST /storage/upload` alias require
an idempotency key in either the JSON body or the `idempotency-key` header. Non
bytes32 keys are hashed into the registry-compatible bytes32 key. Duplicate keys
for the same `accountId` return `409 duplicate_idempotency_key` with the
existing object id instead of creating another object.

The byte endpoint is coordinator-facing in v1. Retrying bytes against a
terminal upload returns a terminal-state error; clients should create a new
upload request with a new idempotency key when they need a fresh attempt.

## Token Host Binding

Generated UI/client code should bind to:

- `POST /storage/tokenhost/upload` for direct file-byte uploads from generated
  Token Host upload UI. Successful responses include
  `{ ok: true, upload: { url, size, provider, runnerMode, metadata } }`;
- `GET /storage/tokenhost/upload/status` for upload adapter metadata;
- `request.objectId`, `request.accountId`, `request.status`, and
  `request.requestExpiresAt` from create responses;
- `links.uploadBytes`, `links.status`, `links.object`, and `links.usage` for
  follow-up calls;
- `upload`, `usage`, `copyReceipts`, `receiptPayer`, and optional `projection`
  from status/object responses.

The dev tests also bind these read endpoints to the `runDevUploadSpine`
contract/read-model result, preserving the mocked boundary: no real FOC bytes,
Synapse SDK call, or Calibration transaction is claimed until the hosted
coordinator and Phase 0 evidence exist.

## Admin API Binding

The user API above is separate from the operator/admin surface in
`src/api/platform-admin-api.mjs`. Admin routes are read-only, require an
explicit admin authorization hook, and do not use user object-ownership checks:

```http
GET /admin/storage/dashboard
GET /admin/storage/objects
GET /admin/storage/objects/:objectId
GET /admin/storage/usage
GET /admin/storage/datasets
GET /admin/storage/coordinators
GET /admin/storage/reconciliation
```

Admin responses are built by `src/admin/reconciliation.mjs` from registry
contract views or reconstructed event state. Optional FOC evidence can be
supplied by a wrapper; without it, stored-object reconciliation reports
`foc_evidence_not_checked` rather than claiming live FOC verification. See
[`docs/admin-reconciliation.md`](./admin-reconciliation.md).
