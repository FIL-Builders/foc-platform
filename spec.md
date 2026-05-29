# FOC Onchain Platform Stack Specification

Status: Draft / option-preserving planning spec  
Owner: FOC client engineering  
Last updated: 2026-05-28  
Related repos:

- `~/dev/filozone/synapse-sdk`
- `~/dev/fil-builders/foc-cli`
- `~/dev/fil-builders/foc-storage-mcp`
- `~/dev/tokenhost/tokenhost-builder`

## 1. Purpose

Define a reusable platform stack that lets a platform company offer Filecoin Onchain Cloud storage to its own users while minimizing platform-managed offchain state.

The target model is:

1. End users interact with a platform API, UI, or generated app.
2. User storage actions are authorized, metered, and auditable through platform-specific smart contracts.
3. A platform-managed wallet, contract wallet, or treasury pays Filecoin Onchain Cloud for storage activity.
4. User-level usage, quotas, prepaid balances, billing events, and object ownership are tracked mostly onchain.
5. Offchain infrastructure is kept as stateless or replaceable as possible and is used primarily for byte movement, FOC SDK execution, relaying, and optional indexing.

This spec intentionally keeps multiple implementation options open. Future revisions may select a narrower architecture after compatibility testing and product validation.

## 2. Product Goal

Build a reusable **FOC Platform Stack** for companies that want to build higher-level products on Filecoin Onchain Cloud.

The stack should make this easy:

```text
platform user -> platform storage action -> platform contract policy/accounting -> FOC storage execution -> onchain receipt/usage update
```

The platform should be able to expose simple APIs such as:

```http
POST /storage/upload
GET  /storage/objects/:id
GET  /usage
```

while using contracts as the primary system of record for:

- who requested storage,
- which object was stored,
- how much storage was consumed,
- what user/account should be charged,
- which FOC datasets/providers/pieces were used,
- whether platform policy allowed the action,
- and what settlement/accounting event occurred.

## 3. Design Principles

### 3.1 Onchain-first accounting

The authoritative usage ledger SHOULD live onchain when economically viable.

Offchain services MAY cache, index, or mirror state, but correctness should derive from contract state and emitted events.

### 3.2 Minimal offchain state

Offchain components SHOULD avoid owning critical business state. Where offchain state is unavoidable, it should be:

- temporary,
- reconstructable from chain events,
- idempotent,
- or explicitly marked as non-authoritative.

### 3.3 Execution/state separation

Contracts SHOULD own policy and accounting. Offchain runners SHOULD perform execution that contracts cannot perform directly, especially:

- receiving file bytes,
- uploading bytes to FOC providers,
- using Synapse SDK,
- submitting FOC-related transactions,
- and calling back with receipts.

### 3.4 Flexible wallet model

The stack MUST keep wallet/payment mode configurable until FOC contract-wallet compatibility is confirmed.

Supported target modes MAY include:

1. platform EOA/KMS wallet pays FOC,
2. platform smart account pays FOC,
3. platform treasury contract pays FOC directly,
4. user wallet pays FOC directly but platform records usage,
5. hybrid prepaid/user-balance model.

### 3.5 Auditability over full trustlessness

The initial product may rely on a trusted platform runner or operator. The important requirement is that user actions, platform decisions, and storage receipts are auditable onchain.

### 3.6 No privacy illusions

Onchain metadata is public. The stack MUST NOT store secrets or sensitive PII onchain. User identifiers should be opaque IDs or addresses. File metadata should be minimized or hashed when possible.

## 4. Scope

### 4.1 In scope

- Platform-specific storage wrapper contracts.
- User storage intents and authorization.
- Onchain object registry.
- Onchain usage/accounting ledger.
- Quotas, prepaid balances, or spend caps.
- FOC upload runner scaffold.
- Synapse SDK integration.
- Token Host Builder integration for generated contracts/UI.
- Optional sponsored transaction / gasless UX.
- Optional offchain indexer or cache.
- Compatibility testing for contract wallets and FOC payment flows.

### 4.2 Out of scope for v0

- Eliminating all offchain infrastructure.
- Uploading bytes directly from smart contracts.
- Building a full fiat invoicing product.
- Guaranteed private storage metadata.
- Decentralized runner marketplace.
- Replacing Synapse SDK.

## 5. Core Architecture

```text
+------------------+       +------------------------+
| End User / App   | ----> | Platform UI/API/Relay  |
+------------------+       +------------------------+
                                  |
                                  v
                         +-------------------+
                         | Platform Contract |
                         | Stack             |
                         +-------------------+
                                  |
                          events / requests
                                  |
                                  v
                         +-------------------+
                         | FOC Runner        |
                         | Synapse SDK       |
                         +-------------------+
                                  |
                                  v
                         +-------------------+
                         | FOC Contracts +   |
                         | Providers         |
                         +-------------------+
                                  |
                                  v
                         +-------------------+
                         | finalize receipt  |
                         | on Platform Stack |
                         +-------------------+
```

## 6. Platform Contract Stack

The contract stack MAY be implemented as one contract for MVP or multiple contracts for modularity.

### 6.1 `PlatformStorageRegistry`

Tracks storage objects and upload lifecycle.

Potential fields:

```solidity
struct StorageObject {
  uint256 objectId;
  address user;
  bytes32 externalUserIdHash;
  bytes32 contentHash;
  string pieceCid;
  uint256 size;
  uint8 requestedCopies;
  uint8 completedCopies;
  bool withCDN;
  UploadStatus status;
  uint256 createdAt;
  uint256 updatedAt;
}
```

Potential statuses:

```solidity
enum UploadStatus {
  None,
  Requested,
  Accepted,
  Uploading,
  Committed,
  Partial,
  Failed,
  Deleted,
  Archived
}
```

Open options:

- Store `pieceCid` as string.
- Store PieceCID as bytes or multihash parts.
- Store only `bytes32 pieceCidHash` plus event data.
- Store provider/dataset details in primary object struct.
- Store provider/dataset details in separate copy records.

### 6.2 `PlatformUsageLedger`

Tracks user/account usage and chargeable events.

Potential fields:

```solidity
struct AccountUsage {
  uint256 activeBytes;
  uint256 activeObjects;
  uint256 monthlyRateEstimate;
  uint256 prepaidBalance;
  uint256 reservedBalance;
  uint256 totalCharged;
  uint256 totalUploadedBytes;
}
```

Potential events:

```solidity
event UsageReserved(address indexed user, uint256 indexed objectId, uint256 amount);
event UsageFinalized(address indexed user, uint256 indexed objectId, uint256 amount, uint256 activeBytesDelta);
event UsageReleased(address indexed user, uint256 indexed objectId, uint256 amount);
event AccountDebited(address indexed user, uint256 amount, bytes32 reason);
event AccountCredited(address indexed user, uint256 amount, bytes32 reason);
```

Open billing models:

1. **Prepaid balance:** users deposit tokens into the platform contract.
2. **Credit ledger:** platform pays FOC and records user debt onchain.
3. **Quota-only:** contract records usage but billing remains external.
4. **Hybrid:** prepaid for some tenants, invoice/credit for others.
5. **Token-gated:** storage rights derive from NFT/ERC20/subscription ownership.

### 6.3 `PlatformPolicyManager`

Enforces platform rules.

Potential rules:

- max file size,
- max total active bytes per user,
- max active objects per user,
- max copies,
- CDN allowed/disallowed,
- accepted MIME/content classes,
- per-period upload count,
- per-user spend cap,
- allowlisted users,
- allowlisted runners,
- platform pause/circuit breaker.

Policy may be:

- hardcoded in the registry contract,
- configured by admin setters,
- generated from Token Host schema,
- delegated to a separate policy contract,
- or implemented partially offchain in relayer policy.

### 6.4 `PlatformIntentRouter`

Verifies signed user intents and creates upload requests.

Potential EIP-712 intent:

```solidity
struct StorageIntent {
  address user;
  uint256 objectId;
  bytes32 contentHash;
  uint256 size;
  uint8 copies;
  bool withCDN;
  uint256 maxCost;
  uint256 nonce;
  uint256 deadline;
  bytes32 metadataHash;
}
```

Required checks:

- signer is user or authorized delegate,
- nonce unused,
- deadline not expired,
- size/copies/CDN policy valid,
- balance/quota sufficient,
- request idempotency key not reused.

Open authorization models:

1. user sends transaction directly,
2. user signs intent and platform sponsors gas,
3. API key maps to an onchain account/admin role,
4. Token Host sponsored transaction model,
5. session key/delegated signer model.

### 6.5 `PlatformTreasury`

Optional treasury contract for user deposits and/or platform operating funds.

Open treasury modes:

1. USDFC prepaid user balances in treasury.
2. Native token gas sponsorship treasury.
3. Contract directly deposits/approves Filecoin Pay.
4. Contract reimburses KMS/EOA execution wallet.
5. No treasury; contract only records usage.

## 7. FOC Session-Key Primitive

Synapse / FOC includes an onchain **SessionKeyRegistry** and SDK support for temporary delegated signing keys. This primitive is important for `foc-platform` because it already solves part of the problem this stack needs: a root identity can authorize another key to perform a limited set of FOC storage operations for a bounded time window.

### 7.1 What FOC session keys are

A FOC session key is an ephemeral signing key authorized by a root wallet through the `SessionKeyRegistry` contract.

The registry stores grants of the form:

```text
root identity address -> session signer address -> permission bytes32 -> expiry timestamp
```

The public registry surface includes:

```solidity
function login(address signer, uint256 expiry, bytes32[] permissions, string origin) external;
function loginAndFund(address payable signer, uint256 expiry, bytes32[] permissions, string origin) external payable;
function revoke(address signer, bytes32[] permissions, string origin) external;
function authorizationExpiry(address user, address signer, bytes32 permission) external view returns (uint256);
```

The registry emits:

```solidity
event AuthorizationsUpdated(
  address indexed identity,
  address signer,
  uint256 expiry,
  bytes32[] permissions,
  string origin
);
```

The SDK wraps this as `SessionKey.fromSecp256k1(...)`, `login(...)`, `revoke(...)`, `syncExpirations()`, and `hasPermissions(...)`.

### 7.2 Current FOC permissions

The SDK defines four default FWSS permissions. These permissions are the `keccak256` type hashes of the corresponding EIP-712 operation types:

- `CreateDataSetPermission`
- `AddPiecesPermission`
- `SchedulePieceRemovalsPermission`
- `DeleteDataSetPermission`

The default permission set is:

```ts
DefaultFwssPermissions = [
  CreateDataSetPermission,
  AddPiecesPermission,
  SchedulePieceRemovalsPermission,
  DeleteDataSetPermission,
]
```

The registry itself is permission-hash agnostic; it can store arbitrary `bytes32` permissions. The current FWSS contracts and SDK convention use the EIP-712 type hashes above.

### 7.3 How session keys are used in Synapse

Session keys are not payment accounts. They are delegated signers.

In Synapse:

- the **root wallet** owns the FOC identity, funds, payment rails, and datasets;
- the **session key** signs FOC EIP-712 operation payloads;
- FOC extraData includes the root/payer address, operation parameters, and the session-key signature;
- FWSS can validate that the recovered signer is authorized for the relevant operation type and not expired.

The SDK's `SessionKeyAccount` carries both:

```ts
address      // session signer address
rootAddress  // root identity / payer address
```

For dataset creation, the SDK explicitly supports a different payer when a session key signs:

```ts
createDataSet(sessionKey.client, {
  payer: sessionKey.rootAddress,
  ...
})
```

For high-level use, `Synapse.create({ account: rootAccount, sessionKey })` validates that the session key has all default FWSS permissions before enabling it for eligible storage operations.

### 7.4 Why this matters for foc-platform

The FOC session-key primitive is close to the runner authorization model needed by `foc-platform`.

It provides:

- an existing onchain authorization registry,
- time-bounded delegation,
- operation-scoped permissions,
- revocation,
- event-based observability,
- compatibility with current Synapse SDK storage flows,
- reduced need to keep a hot root wallet online for every FOC operation.

For platform use, the most direct pattern is:

```text
platform root wallet / payer
  -> authorizes runner session key in SessionKeyRegistry
  -> runner uses session key with Synapse SDK
  -> FOC datasets and payment rails remain owned by platform root
  -> platform wrapper contracts record per-user attribution and usage
```

This gives the platform a safer operational model than using the root wallet directly for all uploads.

### 7.5 Recommended v1 use of session keys

For the first implementation, `foc-platform` SHOULD treat FOC session keys as the preferred authorization layer between the platform's FOC payer identity and the offchain runner.

Recommended v1 model:

1. Platform has a FOC payer/root wallet, likely EOA/KMS initially.
2. Platform generates one or more runner session keys.
3. Platform root calls `SessionKeyRegistry.login(...)` with scoped FWSS permissions and a short expiry.
4. Runner uses the session key with Synapse SDK for create dataset / add pieces / deletion operations.
5. Platform contract stack independently records upload request, user attribution, quota/billing impact, and final receipt.
6. Platform root periodically refreshes or revokes runner session keys.

This separates three concerns:

- FOC root identity and funds,
- operational signing by runner keys,
- user-level policy/accounting in platform contracts.

### 7.6 Session keys vs platform user intents

FOC session keys and platform user intents solve different layers.

| Layer | Primitive | Purpose |
| --- | --- | --- |
| User -> platform | Platform EIP-712 storage intent | User authorizes the platform action and billing/quota impact. |
| Platform -> FOC runner | FOC session key | Platform root authorizes runner to perform FOC operations. |
| FOC runner -> provider/FWSS | Synapse signed extraData | Provider/FWSS verifies operation authorization. |
| Platform accounting | Platform contracts | Track object ownership, usage, quotas, charges, and receipts. |

The platform SHOULD NOT treat a FOC session key as proof that an end user requested an upload. End-user authorization should remain in the platform contract stack.

### 7.7 Contract-wallet considerations

Session keys currently appear EOA/secp256k1-oriented in the SDK. The SDK creates session keys from private keys and signs EIP-712 payloads as a local account.

Open compatibility questions remain:

- Can the root identity be a smart account or contract wallet that calls `SessionKeyRegistry.login(...)`?
- Does FWSS validate EIP-712 signatures only via ECDSA recovery, or can it support ERC-1271 smart-account signatures?
- If the root is a contract, can the session key still sign as an EOA while the payer/root address is the contract?
- Can a contract root hold USDFC, approve Filecoin Pay/Warm Storage, and own datasets/payment rails?

Until these are tested, the safest architecture is:

```text
EOA/KMS platform root wallet + FOC session keys for runner execution + platform contracts for user accounting
```

### 7.8 Spec implication

The FOC session-key primitive should be considered a first-class building block of the platform stack, but not a complete replacement for the platform contract stack.

It should be used for **operator delegation into FOC**, while the platform contracts handle **multi-tenant product semantics**.

## 8. FOC Integration Modes

The stack MUST support multiple FOC payment/execution modes until compatibility is proven.

### 8.1 Mode A: Platform EOA/KMS pays FOC

A platform-managed EOA signs Synapse SDK operations and pays FOC. Platform contracts record usage and receipts.

Pros:

- likely works with current Synapse SDK,
- fastest MVP,
- compatible with existing `foc-cli` / MCP patterns,
- easier operational recovery.

Cons:

- FOC payer is not the platform contract,
- requires signer custody/KMS,
- trust bridge between FOC txs and platform receipts.

### 8.2 Mode B: Platform smart account pays FOC

A smart account is the FOC payer and uses account abstraction or ERC-1271-compatible signing.

Pros:

- stronger onchain custody/accounting story,
- programmable wallet policies,
- easier multi-admin controls.

Cons:

- depends on FOC/Synapse/provider compatibility,
- may require SDK changes,
- may require ERC-1271 support in auth paths.

### 8.3 Mode C: Platform treasury contract pays FOC directly

Platform contract holds USDFC and directly calls Filecoin Pay / Warm Storage contracts.

Pros:

- most onchain-native model,
- minimal custody outside contracts.

Cons:

- may not be compatible with provider HTTP auth flows,
- contract cannot upload bytes,
- likely needs custom integration beyond current SDK.

### 8.4 Mode D: Users pay FOC directly, platform records usage

User wallets perform FOC payments/operations directly while platform contracts record attribution.

Pros:

- less platform custody,
- aligns payment responsibility with users.

Cons:

- worse UX,
- users need funds and approvals,
- platform cannot easily abstract FOC.

### 8.5 Mode E: Hybrid

The platform supports multiple modes per tenant or deployment.

Examples:

- free-tier users use platform wallet,
- enterprise users use dedicated smart account,
- advanced users bring their own FOC wallet.

## 9. Upload Execution and Runner Models

A runner is required for byte movement and FOC execution. Smart contracts can authorize, meter, and record storage operations, but they cannot move file bytes to providers. This section defines the default upload lifecycle and the runner/data-plane options the stack should support.

### 9.1 Recommended upload lifecycle

The recommended platform-managed upload flow is:

```text
user/app
  -> platform UI/API
  -> platform contract request
  -> FOC runner
  -> Synapse SDK / FOC providers / FOC contracts
  -> platform contract finalization
  -> user/app sees stored object
```

#### Step 1: Platform prepares FOC authority

Before user uploads, the platform prepares its FOC execution authority:

1. Platform has a FOC root wallet/payer.
2. Platform deposits USDFC and approves required FOC services.
3. Platform creates one or more runner session keys.
4. Platform root authorizes runner session keys in `SessionKeyRegistry` for FWSS permissions:
   - create dataset,
   - add pieces,
   - schedule removals,
   - delete dataset.

This allows a runner to execute FOC storage operations without using the root wallet directly.

#### Step 2: User requests upload

The user clicks upload or calls the platform API.

The platform collects:

- user identity,
- file size,
- content hash, PieceCID, or both if available,
- desired copy count,
- CDN preference,
- metadata hash,
- max acceptable cost,
- idempotency key.

The user MAY either:

- sign an EIP-712 platform storage intent, or
- authenticate with normal platform auth/API key and have the platform relay the onchain request.

#### Step 3: Platform contract records request

The platform submits `requestUpload(...)` to its platform contract.

The contract checks:

- user authorization,
- nonce/idempotency,
- quota,
- prepaid balance or credit limit,
- max file size,
- max copies,
- CDN policy,
- estimated cost ceiling.

Then it records:

```text
objectId
user
size
contentHash
copies
withCDN
status = Requested
reserved balance / quota impact
```

And emits:

```solidity
event UploadRequested(
  uint256 indexed objectId,
  address indexed user,
  uint256 size,
  bytes32 contentHash,
  uint8 copies,
  bool withCDN
);
```

At this point, the platform has an onchain audit trail before storage execution.

#### Step 4: Runner or upload coordinator picks up request

A runner or upload coordinator watches `UploadRequested` events or receives an equivalent platform job.

Depending on runner/data-plane mode, it gets bytes from one of:

- platform upload endpoint,
- temporary object store,
- browser direct stream,
- signed URL,
- FOC provider direct upload,
- local file path in dev,
- enterprise self-hosted source.

The runner validates:

- file size matches request,
- content hash or PieceCID matches request where available,
- request is still open,
- runner is allowlisted,
- FOC session key is unexpired,
- cost and copy count remain within policy.

#### Step 5: Runner executes FOC operation

The runner uses Synapse SDK with its FOC session key.

Conceptually:

```ts
const sessionKey = SessionKey.fromSecp256k1({
  privateKey: runnerSessionPrivateKey,
  root: platformRootAddress,
  chain,
})

const synapse = Synapse.create({
  account: platformRootAccount,
  sessionKey,
  source: "platform-id",
})
```

Then the runner may:

1. create/reuse storage contexts and datasets,
2. prepare/check funding if needed,
3. upload bytes to a provider, or commit bytes already uploaded directly by the user,
4. add piece to dataset,
5. create multiple copies,
6. receive PieceCID, provider IDs, dataset IDs, piece IDs, tx hashes, and retrieval URLs.

FOC state exists under the platform root/payer, but the platform contract attributes it to the end user.

#### Step 6: Runner finalizes on platform contract

Runner calls a function such as:

```solidity
function finalizeUpload(
  uint256 objectId,
  UploadReceipt calldata receipt
) external onlyRunner;
```

The receipt may include:

- PieceCID or PieceCID hash,
- size,
- completed copies,
- provider IDs,
- FOC dataset IDs,
- piece IDs,
- FOC tx hashes,
- retrieval URLs or hashes,
- actual or estimated cost,
- success / partial / failure status.

The contract checks:

- caller is authorized runner,
- object is in expected state,
- receipt is not already finalized,
- size/copy count matches policy,
- cost is within user's signed max cost or reserved amount.

Then it updates:

```text
status = Committed | Partial | Failed
activeBytes += size * completedCopies
reservedBalance -> finalized charge or release
object receipt fields
usage counters
```

And emits:

```solidity
event UploadFinalized(
  uint256 indexed objectId,
  address indexed user,
  bytes32 pieceCidHash,
  uint256 size,
  uint8 copies,
  uint256 cost
);
```

#### Step 7: User gets result

The platform UI/API can read:

- platform contract state,
- emitted events,
- optional indexer/cache,
- FOC retrieval URL.

Example response:

```json
{
  "objectId": "123",
  "status": "committed",
  "pieceCid": "bafk...",
  "size": 1048576,
  "copies": 2,
  "retrievalUrl": "https://...",
  "charged": "0.00..."
}
```

#### Step 8: Failure path

If upload fails:

1. Runner calls `failUpload(objectId, reasonHash)`, or timeout allows user/platform to cancel.
2. Contract marks status `Failed` or `Expired`.
3. Reserved balance/quota is released or partially charged depending on policy.
4. Event is emitted for auditability.

### 9.2 Dual authorization model

The cleanest architecture has two separate authorization flows:

```text
User authorizes platform action:
  user intent -> platform contract

Platform authorizes FOC execution:
  FOC root wallet -> SessionKeyRegistry -> runner session key
```

The first authorization proves the user requested the action and accepted platform policy/billing. The second authorization lets an operational runner perform FOC actions without exposing the platform root wallet.

### 9.3 Runner responsibilities

The runner MAY:

- watch `UploadRequested` events,
- accept temporary upload bytes,
- coordinate direct-to-FOC uploads,
- validate content hash/size,
- call Synapse SDK,
- create/reuse datasets,
- upload files and commit pieces,
- submit FOC transactions,
- call `finalizeUpload` on the platform contract,
- retry failed phases,
- emit logs/metrics.

The runner is not the same as the platform contract.

The platform contract answers:

- is this upload allowed?
- who owns it?
- who is charged?
- what status is it in?
- which runner may finalize?
- what receipt was recorded?

The runner answers:

- where are the bytes?
- how should they be uploaded?
- how should Synapse SDK be used?
- did FOC accept/commit the piece?
- what receipt should be finalized?

### 9.4 Statelessness requirement

The runner SHOULD be reconstructable from chain state.

Allowed runner state:

- in-memory queue,
- temporary file buffer,
- retry cache,
- idempotency cache,
- logs/metrics,
- optional non-authoritative job mirror.

Authoritative state SHOULD be in platform contracts and FOC contracts.

### 9.5 Runner model A: platform-hosted runner

This is the most natural v1 model for SaaS/platform companies.

```text
user browser/API client
  -> platform upload endpoint
  -> platform-hosted FOC runner
  -> Synapse SDK / FOC
  -> platform contract finalize
```

The platform maintains the runner as backend infrastructure.

Pros:

- best UX for users,
- user does not need FOC keys, FIL, USDFC, Node setup, or CLI,
- platform can enforce file size, MIME policy, quotas, malware scanning, and rate limits,
- platform can hide FOC complexity,
- works well with platform-managed wallet/session key,
- easier to monitor and support.

Cons:

- platform temporarily handles file bytes,
- platform pays bandwidth/compute,
- runner is trusted to report correct receipts unless verification/challenge logic is added,
- more infrastructure burden.

Recommended v1 hosted-runner flow:

```text
1. User uploads bytes to platform-hosted runner.
2. Platform contract records UploadRequested.
3. Runner sees request and validates bytes.
4. Runner uses FOC session key to upload through Synapse.
5. Runner gets PieceCID/dataset/provider receipt.
6. Runner finalizes UploadFinalized on platform contract.
7. User reads result from platform API/contract.
```

### 9.6 Runner model B: user-local runner

The runner runs on the user's machine, browser, desktop app, CLI, or agent.

```text
user local runner
  -> FOC via Synapse SDK
  -> platform contract finalize
```

Two variants should remain possible:

#### B1. User-local runner using platform session key

This is generally unsafe for public users because the platform would be distributing FOC runner credentials.

It is NOT RECOMMENDED except for trusted enterprise/on-prem agents where the runner environment is controlled and contractual trust exists.

#### B2. User-local runner using user's own FOC wallet

The user pays or signs FOC operations directly.

```text
user wallet pays FOC
  -> local runner uploads
  -> platform contract records attribution
```

This is more decentralized but worse UX and no longer the primary “platform-managed wallet pays FOC” model.

Pros:

- platform does not handle file bytes,
- better for privacy or enterprise/on-prem data,
- lower platform bandwidth cost,
- can work for technical users, agents, and CLI workflows.

Cons:

- harder UX,
- user must run software,
- if platform pays, credential delegation is dangerous,
- harder support/retry/reconciliation,
- less suitable for ordinary SaaS users.

### 9.7 Runner model C: hybrid / bring-your-own runner

The platform MAY support allowlisted runners.

```text
platform contract
  -> allows runner A, B, C
  -> each runner can finalize certain uploads
```

Possible runner types:

- platform-hosted runner,
- enterprise customer self-hosted runner,
- local dev runner,
- AI-agent runner,
- serverless worker runner,
- marketplace runner in future.

The contract may store:

```solidity
mapping(address => bool) public approvedRunners;
mapping(address => RunnerPolicy) public runnerPolicies;
```

A request may specify:

```solidity
address preferredRunner;
bytes32 runnerMode;
```

or the platform may assign a runner offchain.

Pros:

- flexible,
- lets v1 start centralized but grow toward self-hosted/decentralized execution,
- useful for enterprise customers who do not want platform to touch bytes.

Cons:

- more complex,
- requires runner authorization, policies, revocation, and audit,
- requires clear responsibility for failures.

Recommended direction:

```text
v1 default:
  platform-hosted runner + platform FOC root wallet + FOC session key

v1 optional/dev:
  local runner for testing

future:
  enterprise self-hosted runner
  bring-your-own FOC wallet
  decentralized/allowlisted runner network
```

### 9.8 Direct-to-FOC upload with platform-delegated signing

A key optional architecture is **direct data plane, platform-controlled control plane**.

In this model, the platform never receives file bytes, but it still controls authorization, payment, and accounting.

High-level flow:

```text
user browser/app
  -> asks platform for upload authorization
  -> uploads bytes directly to FOC provider
  -> platform signs/authorizes FOC commit
  -> FOC provider/FWSS commits piece
  -> platform contract records final receipt
```

#### Step 1: User requests an upload ticket

User calls:

```http
POST /uploads/request
```

with:

- user auth/session/API key,
- file size,
- content hash or PieceCID if already computed,
- desired copies,
- CDN preference,
- max cost,
- metadata hash.

Platform checks:

- user quota/balance,
- max size,
- copies/CDN policy,
- rate limits.

Then platform records or references an onchain `UploadRequested`.

#### Step 2: Platform returns an upload plan

The platform chooses:

- FOC provider,
- dataset or new dataset plan,
- upload endpoint,
- object id,
- expected PieceCID/content hash,
- expiry,
- optional commit authorization token.

Example response:

```json
{
  "objectId": "123",
  "providerId": "5",
  "serviceURL": "https://provider.example",
  "datasetId": "42",
  "expectedPieceCid": "bafk...",
  "expiresAt": 1234567890
}
```

#### Step 3: User uploads bytes directly to FOC provider

The user/browser uploads to the provider's PDP API directly:

```text
browser -> FOC provider /pdp/piece
```

The platform does not proxy the file.

#### Step 4: Platform signs the FOC commit

The browser, runner, or provider needs FOC `extraData` authorizing the piece to be added to a dataset.

The platform keeps its root wallet/session key private and signs only the specific operation:

```text
add this PieceCID
to this dataset
for this payer/root
with this metadata
before this expiry
```

The platform SHOULD sign using a FOC session key rather than the root wallet. The platform MUST NOT give the user the platform wallet key or general runner session key. It only returns a narrow operation-specific signature or arranges for the runner to submit it.

#### Step 5: Commit happens

Two variants should remain possible:

**Variant A: browser submits commit to provider**

```text
browser -> provider addPieces(extraData)
provider -> FOC contracts
```

The browser coordinates the flow, but cannot change what the platform signed.

**Variant B: platform runner submits commit**

```text
browser -> provider stores bytes
platform runner -> provider addPieces(extraData)
provider -> FOC contracts
```

The platform still never sees file bytes. The runner only commits the already-uploaded PieceCID. This is likely the safer v1 direct-upload model.

#### Step 6: Platform finalizes receipt

Once FOC confirms the piece, platform records:

- object id,
- user,
- PieceCID,
- size,
- provider id,
- dataset id,
- FOC tx hash,
- charge/quota impact.

Either:

- platform runner calls `finalizeUpload`, or
- user submits receipt and platform verifies or accepts it under policy.

Recommended direct-upload v1:

```text
browser uploads bytes directly to FOC provider
platform runner/signing service handles commit + finalization
```

This gives the platform less byte-handling responsibility while preserving platform control over wallet/signing/accounting.

Caveats to test:

- provider CORS supports browser direct upload,
- browser can compute PieceCID efficiently for large files,
- provider direct upload APIs work from web clients,
- Synapse SDK supports split direct-upload / delegated-commit flow cleanly in browser,
- commit signatures can be safely issued after quota/policy checks,
- retry/failure behavior when upload succeeds but commit fails,
- direct upload can be bound to an onchain `objectId` and cannot be replayed to spend platform funds unexpectedly.

### 9.9 Runner trust model

Open options:

1. single platform-operated runner,
2. multiple allowlisted runners,
3. runner staking/slashing later,
4. user-submitted finalization with verifiable FOC receipts,
5. optimistic finalization with challenge window.

MVP may use a trusted runner with admin allowlisting.

### 9.10 Finalization receipt design

Open receipt design:

- store all copy receipts onchain,
- store compact hashes onchain and full receipt in event,
- verify FOC contract events onchain if feasible,
- rely on allowlisted runner assertion for MVP.

## 10. Token Host Builder Integration

Token Host Builder can accelerate this stack because it already supports schema-generated EVM CRUD apps, onchain indexing, Filecoin upload adapters, Filecoin chain targets, generated UI, and sponsored transaction concepts.

### 10.1 Possible schema extension

Potential schema surface:

```json
{
  "app": {
    "features": {
      "focPlatformStorage": true,
      "onChainUsageLedger": true,
      "sponsoredTransactions": true,
      "uploads": true
    },
    "focPlatform": {
      "paymentMode": "platformWallet | smartAccount | contractTreasury | userPays | hybrid",
      "billingMode": "prepaid | credit | quotaOnly | hybrid",
      "runnerMode": "local | remote | netlify | worker | sdk",
      "defaultCopies": 2,
      "allowCDN": true
    }
  }
}
```

### 10.2 Generated collections

Token Host MAY generate base collections/contracts for:

- `StorageObject`,
- `UploadRequest`,
- `UsageAccount`,
- `UsageEvent`,
- `DatasetRecord`,
- `ProviderCopy`,
- `Runner`,
- `BillingPlan`.

### 10.3 Generated indexes

Useful indexes:

- objects by user,
- objects by status,
- objects by CID hash,
- requests by status,
- usage events by user,
- datasets by provider,
- copies by object.

### 10.4 Generated UI/admin

Token Host MAY emit:

- user object browser,
- upload form,
- admin usage dashboard,
- runner status view,
- treasury balance view,
- FOC account runway view,
- object detail with PieceCID/provider/dataset receipts.

### 10.5 Upload adapter evolution

Current Token Host upload adapters can prototype FOC upload via `foc-cli`. Production SHOULD prefer direct Synapse SDK integration.

Potential runner modes:

1. `foc-process`: shell out to `foc-cli` for quick prototype.
2. `foc-sdk`: direct Synapse SDK runner.
3. `remote`: platform-hosted upload service.
4. `worker`: background worker / serverless queue.
5. `browser-assisted`: client uploads bytes, runner finalizes.

## 11. Synapse SDK Requirements / Opportunities

Potential SDK support needed:

- platform/backend examples,
- explicit upload receipt type suitable for contract finalization,
- deterministic cost quote helpers,
- contract-wallet compatibility docs,
- smart-account examples,
- KMS signer examples,
- dataset metadata strategy for multi-tenant platforms,
- receipt/reconciliation helpers,
- optional runner-friendly APIs for split upload phases,
- documented session-key runner pattern,
- session-key lifecycle helpers for backend services,
- short-lived runner key examples,
- clear description of which operations require FWSS permissions and which require payment/operator approvals.

## 12. foc-cli and foc-storage-mcp Roles

### 12.1 `foc-cli`

Should remain useful for:

- local testing,
- platform operator diagnostics,
- wallet setup,
- dataset inspection,
- upload prototyping,
- JSON output consumed by early adapters.

Potential additions:

- `foc-cli platform doctor`,
- `foc-cli platform receipt`,
- `foc-cli platform reconcile`,
- `foc-cli upload --receipt-format platform`.

### 12.2 `foc-storage-mcp`

Should remain useful for AI-agent operations, but reusable logic may be extracted for platform use:

- pricing,
- balance checks,
- payment preparation,
- upload orchestration,
- provider selection summaries.

Potential package split:

- `@fil-b/foc-storage-core`,
- `@fil-b/foc-storage-mcp`,
- `@fil-b/foc-platform-runner`.

## 13. Compatibility Spike Requirements

Before choosing final wallet/payment mode, run compatibility tests on Calibration.

Required questions:

1. Can a contract hold USDFC and deposit into Filecoin Pay?
2. Can a contract approve Warm Storage as operator?
3. Can a contract be payer on payment rails?
4. Can a smart account execute Synapse SDK upload flows?
5. Do FOC provider HTTP auth flows require EOA signatures?
6. Is ERC-1271 supported or needed?
7. Can Synapse session keys be rooted in a smart account or contract wallet?
8. Can an EOA session key sign for a contract root/payer if the contract root authorized it through `SessionKeyRegistry.login(...)`?
9. Does FWSS validate session-key authorization based only on the recovered signer plus root/payer address, or are there implicit EOA assumptions about the root?
10. Does `loginAndFund` matter for runner session keys on Filecoin, or should runner keys remain unfunded except for gas edge cases?
11. What expiry duration is appropriate for production runners?
12. Can FOC receipts be compactly represented and verified by a wrapper contract?
13. What minimum data must be stored onchain to reconstruct user/object usage?
14. What gas costs result from storing full receipts vs compact hashes/events?

Deliverable:

- a short compatibility report,
- example tx hashes,
- recommended v1 payment mode,
- required SDK changes, if any.

## 14. MVP Options

### 14.1 MVP Option 1: Fast path, EOA payer + onchain registry

- Platform KMS/EOA pays FOC.
- Contracts track users, objects, requests, and usage.
- Runner is trusted and allowlisted.
- Token Host generates registry/usage UI.

This is likely the fastest working product.

### 14.2 MVP Option 2: Prepaid treasury + EOA executor

- Users deposit USDFC into platform treasury.
- Contract reserves/debits user balances.
- Platform EOA still executes FOC operations.
- Treasury may reimburse executor or simply account for liabilities.

This gives stronger billing/accounting semantics.

### 14.3 MVP Option 3: Smart-account payer

- Platform smart account pays FOC.
- Contracts/policies control smart account execution.
- Requires compatibility confirmation.

This is more onchain-native but higher risk.

### 14.4 MVP Option 4: Token Host generated demo app

- Use Token Host Builder to generate a Filecoin Calibration demo app.
- Image uploads go through FOC runner.
- Object/usage state is stored in generated contracts.
- Good for public demo and iterative design.

## 15. Security Considerations

Required protections:

- nonce/replay protection for intents,
- upload size limits,
- content hash validation,
- runner allowlist or proof model,
- user quota checks,
- platform pause switch,
- admin role separation,
- private key isolation for any EOA/KMS runner,
- no sensitive PII in onchain metadata,
- idempotent finalization,
- duplicate PieceCID/object handling policy,
- cost quote slippage controls.

Open decisions:

- whether finalization needs challenge period,
- whether receipts must be independently verifiable onchain,
- whether runners stake collateral,
- whether user deposits are refundable immediately,
- whether failed uploads reserve or release user funds automatically.

## 16. Data Minimization

Recommended onchain storage:

- object id,
- user address or opaque account id hash,
- content hash,
- PieceCID or PieceCID hash,
- size,
- status,
- copies count,
- compact provider/dataset receipt or receipt hash,
- billing counters.

Avoid onchain:

- raw user email,
- customer name,
- private filename,
- unencrypted business metadata,
- sensitive content descriptors,
- API keys,
- temporary upload URLs.

## 17. Open Questions

1. Should the platform contract store full PieceCID strings or compact hashes?
2. Should provider/dataset copy receipts be stored in contract storage or events only?
3. Should user billing be prepaid, credit-based, quota-only, or hybrid?
4. Should platform contracts custody USDFC in v1?
5. Should FOC payer be EOA/KMS, smart account, or contract treasury?
6. How much of FOC payment rail state should be mirrored in the platform contract?
7. Should Token Host generate generic CRUD contracts or a custom hand-written FOC module?
8. Should uploads be synchronous from API perspective or async event-driven by default?
9. What is the minimum useful admin UI?
10. What reconciliation guarantees are required for production?

## 18. Proposed Phases

### Phase 0: Research and compatibility

- Test FOC contract-wallet/payment compatibility.
- Document current Synapse SDK assumptions.
- Identify required SDK changes.

### Phase 1: Onchain registry prototype

- Generate or hand-write simple platform registry.
- Add upload request/finalize flow.
- Build trusted runner with Synapse SDK.
- Store object and usage state onchain.

### Phase 2: Token Host Builder integration

- Add schema extension or example schema.
- Generate contracts/UI for platform storage objects.
- Integrate upload adapter/runner.
- Add Filecoin Calibration deployment path.

### Phase 3: Billing/treasury modes

- Add prepaid balances and/or credit ledger.
- Add admin quotas and policy controls.
- Add reconciliation tooling.

### Phase 4: Advanced payment/wallet mode

- Add smart-account or contract-treasury FOC payer if compatible.
- Add stronger finalization proof model if needed.

### Phase 5: Production hardening

- KMS/HSM support.
- Monitoring and alerts.
- Runner scaling.
- Audit.
- Documentation and reference platform integration.

## 19. Success Criteria

The buildout is successful when:

1. A platform can offer storage to users without designing its own FOC billing/accounting backend from scratch.
2. User object ownership and usage are reconstructable from onchain state/events.
3. Offchain runner state is not authoritative.
4. Uploads can be attributed to users and charged or quota-enforced.
5. FOC payment/runway health is observable.
6. The stack supports at least one working managed-wallet mode on Calibration.
7. The design remains extensible to smart-account or contract-treasury modes.
8. Token Host Builder can generate or scaffold a meaningful portion of the platform app.

