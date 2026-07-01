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
GET  /storage/uploads/:objectId
GET  /usage
```

`GET /storage/uploads/status?objectId=:objectId` is the Token Host upload
runner status alias for generated upload metadata. The canonical object status
route remains `GET /storage/uploads/:objectId/status`.

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
