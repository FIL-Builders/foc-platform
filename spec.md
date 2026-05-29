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

This document defines a reusable platform stack that enables a platform company to offer Filecoin Onchain Cloud storage to its own users while minimizing platform-managed offchain state.

The target model is:

1. End users interact with a platform API, UI, generated app, or agent.
2. User storage actions are authorized, metered, and auditable through platform-specific smart contracts.
3. A platform-managed wallet, contract wallet, or treasury pays Filecoin Onchain Cloud for storage activity.
4. User-level usage, quotas, prepaid balances, billing events, and object ownership are tracked primarily onchain.
5. Offchain infrastructure remains as stateless and replaceable as possible. Its main responsibilities are byte movement, FOC SDK execution, relaying, optional indexing, and operational coordination.

This is intentionally an early, option-preserving planning spec. It describes viable architecture shapes without prematurely selecting final implementations. Future revisions may narrow the architecture after compatibility testing, prototypes, and product validation.

## 2. Product Goal

Build a reusable **FOC Platform Stack** for companies that want to build higher-level products on Filecoin Onchain Cloud.

The stack should make the following flow straightforward:

```mermaid
flowchart LR
  user["Platform User"]
  action["Platform Storage Action"]
  policy["Platform Contract<br/>Policy + Accounting"]
  foc["FOC Storage Execution"]
  receipt["Onchain Receipt<br/>Usage Update"]

  user --> action
  action --> policy
  policy --> foc
  foc --> receipt
```

The platform should be able to expose simple product APIs such as:

```http
POST /storage/upload
GET  /storage/objects/:id
GET  /usage
```

while using contracts as the primary system of record for:

- who requested storage,
- which object was stored,
- how much storage was consumed,
- which user or account should be charged,
- which FOC datasets, providers, or pieces were used,
- whether platform policy allowed the action,
- and which settlement or accounting event occurred.

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

Contracts SHOULD own policy and accounting. Offchain coordinators SHOULD perform execution that contracts cannot perform directly, especially:

- receiving file bytes,
- uploading bytes to FOC providers,
- using Synapse SDK,
- submitting FOC-related transactions,
- and calling back with receipts.

### 3.4 Flexible wallet model

The stack MUST keep wallet and payment modes configurable until FOC contract-wallet compatibility is confirmed.

Supported target modes MAY include:

1. platform EOA/KMS wallet pays FOC,
2. platform smart account pays FOC,
3. platform treasury contract pays FOC directly,
4. user wallet pays FOC directly while the platform records usage,
5. hybrid prepaid/user-balance models.

### 3.5 Auditability over full trustlessness

The initial product may rely on a trusted platform coordinator or operator. The important requirement is that user actions, platform decisions, and storage receipts are auditable onchain.

### 3.6 No privacy illusions

Onchain metadata is public. The stack MUST NOT store secrets or sensitive PII onchain. User identifiers should be opaque IDs or addresses. File metadata should be minimized or hashed when possible.

## 4. Scope

### 4.1 In scope

- Platform Contract Stack components for storage registry, usage ledger, policy, treasury, and receipt recording.
- User storage intents and authorization.
- Onchain object registry.
- Onchain usage/accounting ledger.
- Quotas, prepaid balances, or spend caps.
- FOC upload coordinator scaffold.
- Synapse SDK integration.
- Token Host Builder integration for generated contracts and UI.
- Optional sponsored transaction / gasless UX.
- Optional offchain indexer or cache.
- Compatibility testing for contract wallets and FOC payment flows.

### 4.2 Out of scope for v0

- Eliminating all offchain infrastructure.
- Uploading bytes directly from smart contracts.
- Building a full fiat invoicing product.
- Guaranteed private storage metadata.
- Decentralized coordinator marketplace.
- Replacing Synapse SDK.

## 5. Core Architecture

```mermaid
flowchart TD
  user["End User / App"]
  api["Platform UI / API / Relay"]
  contracts["Platform Contract Stack<br/>Policy + Accounting"]
  coordinatorRole["FOC Storage Coordinator<br/>role, not fixed location"]
  hosted["Platform-hosted Coordinator"]
  local["User-local Coordinator"]
  enterprise["Enterprise / BYO Coordinator"]
  direct["Direct-to-FOC Upload<br/>Platform-delegated signing"]
  foc["FOC Providers + Contracts"]
  receipt["Finalize Receipt<br/>on Platform Stack"]

  user --> api
  api --> contracts
  contracts -->|"UploadRequested events / jobs"| coordinatorRole

  coordinatorRole -. "deployment option" .-> hosted
  coordinatorRole -. "deployment option" .-> local
  coordinatorRole -. "deployment option" .-> enterprise
  coordinatorRole -. "data-plane option" .-> direct

  hosted --> foc
  local --> foc
  enterprise --> foc
  direct --> foc

  foc --> receipt
  receipt --> contracts
```

The **FOC Storage Coordinator** is an execution and coordination role, not necessarily a platform-owned server. In v1, the default coordinator is expected to be platform-hosted. The same contract model should still support user-local, enterprise self-hosted, serverless, or direct-to-FOC data-plane variants.

The **Platform Contract Stack** remains the authoritative policy and accounting layer regardless of where the coordinator executes.

### 5.1 Execution role terminology

This spec uses **FOC Storage Coordinator** as the umbrella term for the component, service, or set of components that turns an approved platform storage request into an actual FOC storage operation and records the result.

A FOC Storage Coordinator may be one service in v1 or may be split across browser, server, signer, and worker components. It may include these sub-roles:

```mermaid
flowchart TD
  coordinator["FOC Storage Coordinator"]
  upload["Upload Client<br/>moves file bytes"]
  signer["Commit Signer<br/>produces scoped FOC authorization"]
  focTx["FOC Transaction Executor<br/>executes FOC protocol actions"]
  platformTx["Platform Contract Transaction Executor<br/>writes to Platform Contract"]
  finalizer["Receipt Finalizer<br/>specific finalizeUpload role"]

  coordinator --> upload
  coordinator --> signer
  coordinator --> focTx
  coordinator --> platformTx
  platformTx --> finalizer
```

Definitions:

- **Upload Client**: moves file bytes. This may be a browser, platform backend, local CLI, enterprise agent, or serverless function.
- **Commit Signer**: produces scoped FOC authorization/signatures, often using a platform session key, KMS signer, root wallet, or future smart-account signer.
- **FOC Transaction Executor**: submits or triggers FOC protocol actions such as dataset creation, adding pieces, scheduling deletion, payment preparation, or provider/FWSS calls through Synapse SDK.
- **Platform Contract Transaction Executor**: submits transactions to a Platform Contract, such as `requestUpload(...)`, `finalizeUpload(...)`, `failUpload(...)`, and usage/billing updates.
- **Receipt Finalizer**: the Platform Contract Transaction Executor role for the specific `finalizeUpload(...)` path.

In this spec, **Platform Contract** means a platform-specific onchain contract deployed to Filecoin/EVM for product/accounting state. It does not mean the platform API itself is onchain; the platform can remain a normal offchain API/product service.

**Platform Contract Stack** means the set of Platform Contracts that together implement storage registry, usage ledger, policy, treasury, and receipt-recording concerns.

## 6. Platform Contract Stack

The contract stack MAY be implemented as one contract for an MVP or as multiple contracts for modularity.

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

- Store `pieceCid` as a string.
- Store PieceCID as bytes or multihash parts.
- Store only `bytes32 pieceCidHash` plus event data.
- Store provider/dataset details in the primary object struct.
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

1. **Prepaid balance:** users deposit tokens into the Platform Contract or Platform Treasury.
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
- allowlisted coordinators,
- platform pause/circuit breaker.

Policy may be:

- hardcoded in the registry contract,
- configured by admin setters,
- generated from a Token Host schema,
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

- signer is the user or an authorized delegate,
- nonce is unused,
- deadline has not expired,
- size/copies/CDN policy is valid,
- balance/quota is sufficient,
- request idempotency key has not been reused.

Open authorization models:

1. user sends a transaction directly,
2. user signs an intent and platform sponsors gas,
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

### 6.6 Per-user FOC dataset allocation

The current product assumption is that FOC datasets should be allocated per platform user rather than shared across unrelated users. This is the simplest way to keep FOC payment state, storage receipts, and platform usage accounting auditable to a user identity.

Because a FOC dataset is associated with one provider, multi-copy storage may require multiple per-user datasets. For example, one dataset per `(platformUser, provider, cdnMode, storageClass)` tuple. The platform may still pay from one platform root wallet, but the Platform Contract Stack should be able to attribute each dataset and copy back to one user or opaque user-id hash.

Recommended dataset metadata should avoid PII and use stable opaque identifiers, for example:

```text
source = platform-id
platformUserHash = keccak256(platform-specific-user-id)
storageClass = standard | archive | premium
cdn = true | false
```

This spec does not currently target shared cross-user datasets as a primary product mode. They may be reconsidered later for cost optimization, but only if user-level auditability and billing attribution remain clear.

## 7. FOC Session-Key Primitive

Synapse / FOC includes an onchain **SessionKeyRegistry** and SDK support for temporary delegated signing keys. This primitive is important for `foc-platform` because it already solves part of the problem this stack needs: a root identity can authorize another key to perform a limited set of FOC storage operations for a bounded time window.

### 7.1 What FOC session keys are

A FOC session key is an ephemeral signing key authorized by a root wallet through the `SessionKeyRegistry` contract.

The registry stores grants of the form:

```mermaid
flowchart LR
  root["Root identity address"] --> signer["Session signer address"]
  signer --> permission["Permission bytes32"]
  permission --> expiry["Expiry timestamp"]
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

Session keys are delegated signers, not payment accounts.

In Synapse:

- the **root wallet** owns the FOC identity, funds, payment rails, and datasets;
- the **session key** signs FOC EIP-712 operation payloads;
- FOC `extraData` includes the root/payer address, operation parameters, and the session-key signature;
- FWSS can validate that the recovered signer is authorized for the relevant operation type and has not expired.

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

### 7.4 Why this matters for `foc-platform`

The FOC session-key primitive is close to the coordinator authorization model needed by `foc-platform`.

It provides:

- an existing onchain authorization registry,
- time-bounded delegation,
- operation-scoped permissions,
- revocation,
- event-based observability,
- compatibility with current Synapse SDK storage flows,
- reduced need to keep a hot root wallet online for every FOC operation.

For platform use, the most direct pattern is:

```mermaid
flowchart TD
  root["Platform root wallet / payer"]
  registry["SessionKeyRegistry<br/>authorizes coordinator session key"]
  coordinator["Coordinator uses session key<br/>with Synapse SDK"]
  foc["FOC datasets + payment rails<br/>owned by platform root"]
  platform["Platform Contracts<br/>record per-user attribution + usage"]

  root --> registry
  registry --> coordinator
  coordinator --> foc
  foc --> platform
```

This gives the platform a safer operational model than using the root wallet directly for all uploads.

### 7.5 Recommended v1 use of session keys

For the first implementation, `foc-platform` SHOULD treat FOC session keys as the preferred authorization layer between the platform's FOC payer identity and the offchain coordinator.

Recommended v1 model:

1. Platform has a FOC payer/root wallet, likely EOA/KMS initially.
2. Platform generates one or more coordinator session keys.
3. Platform root calls `SessionKeyRegistry.login(...)` with scoped FWSS permissions and a short expiry.
4. Coordinator uses the session key with Synapse SDK for create dataset / add pieces / deletion operations.
5. Platform Contract Stack independently records upload request, user attribution, quota/billing impact, and final receipt.
6. Platform root periodically refreshes or revokes coordinator session keys.

This separates three concerns:

- FOC root identity and funds,
- operational signing by coordinator keys,
- user-level policy/accounting in Platform Contracts.

### 7.6 Session keys vs. platform user intents

FOC session keys and platform user intents solve different layers.

| Layer | Primitive | Purpose |
| --- | --- | --- |
| User -> platform | Platform EIP-712 storage intent | User authorizes the platform action and billing/quota impact. |
| Platform -> FOC coordinator | FOC session key | Platform root authorizes coordinator to perform FOC operations. |
| FOC coordinator -> provider/FWSS | Synapse signed `extraData` | Provider/FWSS verifies operation authorization. |
| Platform accounting | Platform Contracts | Track object ownership, usage, quotas, charges, and receipts. |

The platform SHOULD NOT treat a FOC session key as proof that an end user requested an upload. End-user authorization should remain in the Platform Contract Stack.

### 7.7 Contract-wallet considerations

Session keys currently appear EOA/secp256k1-oriented in the SDK. The SDK creates session keys from private keys and signs EIP-712 payloads as a local account.

Open compatibility questions remain:

- Can the root identity be a smart account or contract wallet that calls `SessionKeyRegistry.login(...)`?
- Does FWSS validate EIP-712 signatures only via ECDSA recovery, or can it support ERC-1271 smart-account signatures?
- If the root is a contract, can the session key still sign as an EOA while the payer/root address is the contract?
- Can a contract root hold USDFC, approve Filecoin Pay/Warm Storage, and own datasets/payment rails?

Until these are tested, the safest architecture is:

```mermaid
flowchart LR
  root["EOA / KMS<br/>platform root wallet"]
  session["FOC session keys<br/>for coordinator execution"]
  accounting["Platform Contracts<br/>for user accounting"]

  root --> session
  session --> accounting
```

### 7.8 Spec implication

The FOC session-key primitive should be considered a first-class building block of the platform stack, but not a complete replacement for the Platform Contract Stack.

It should be used for **operator delegation into FOC**, while Platform Contracts handle **multi-tenant product semantics**.

## 8. FOC Integration Modes

The stack MUST support multiple FOC payment and execution modes until compatibility is proven.

### 8.1 Mode A: Platform EOA/KMS pays FOC

A platform-managed EOA signs Synapse SDK operations and pays FOC. Platform Contracts record usage and receipts.

Pros:

- likely works with current Synapse SDK,
- fastest MVP,
- compatible with existing `foc-cli` / MCP patterns,
- easier operational recovery.

Cons:

- FOC payer is not the Platform Contract,
- requires signer custody/KMS,
- trust bridge between FOC transactions and platform receipts.

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

A Platform Treasury or Platform Contract holds USDFC and directly calls Filecoin Pay / Warm Storage contracts.

Pros:

- most onchain-native model,
- minimal custody outside contracts.

Cons:

- may not be compatible with provider HTTP auth flows,
- contract cannot upload bytes,
- likely needs custom integration beyond the current SDK.

### 8.4 Mode D: Users pay FOC directly, platform records usage

User wallets perform FOC payments/operations directly while Platform Contracts record attribution.

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

## 9. Upload Execution and Coordinator Models

A coordinator is required for byte movement and FOC execution. Smart contracts can authorize, meter, and record storage operations, but they cannot move file bytes to providers.

This section defines the default upload lifecycle and the coordinator/data-plane options the stack should support.

### 9.1 Recommended upload lifecycle

The recommended platform-managed upload flow is:

```mermaid
flowchart TD
  user["User / App"]
  api["Platform UI / API"]
  request["Platform Contract request"]
  coordinator["FOC Storage Coordinator"]
  foc["Synapse SDK / FOC providers / FOC contracts"]
  finalize["Platform Contract finalization"]
  result["User / app sees stored object"]

  user --> api
  api --> request
  request --> coordinator
  coordinator --> foc
  foc --> finalize
  finalize --> result
```

#### Step 1: Platform prepares FOC authority

Before user uploads, the platform prepares its FOC execution authority:

1. Platform has a FOC root wallet/payer.
2. Platform deposits USDFC and approves required FOC services.
3. Platform creates one or more coordinator session keys.
4. Platform root authorizes coordinator session keys in `SessionKeyRegistry` for FWSS permissions:
   - create dataset,
   - add pieces,
   - schedule removals,
   - delete dataset.

This allows a coordinator to execute FOC storage operations without using the root wallet directly.

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

#### Step 3: Platform Contract records request

The platform submits `requestUpload(...)` to its Platform Contract.

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

#### Step 4: FOC Storage Coordinator picks up request

A FOC Storage Coordinator watches `UploadRequested` events or receives an equivalent platform job.

Depending on coordinator/data-plane mode, it gets bytes from one of:

- platform upload endpoint,
- temporary object store,
- browser direct stream,
- signed URL,
- FOC provider direct upload,
- local file path in dev,
- enterprise self-hosted source.

The coordinator validates:

- file size matches request,
- content hash or PieceCID matches request where available,
- request is still open,
- coordinator is allowlisted,
- FOC session key is unexpired,
- cost and copy count remain within policy.

#### Step 5: Coordinator executes FOC operation

The coordinator uses Synapse SDK with its FOC session key.

Conceptually:

```ts
const sessionKey = SessionKey.fromSecp256k1({
  privateKey: coordinatorSessionPrivateKey,
  root: platformRootAddress,
  chain,
})

const synapse = Synapse.create({
  account: platformRootAccount,
  sessionKey,
  source: "platform-id",
})
```

Then the coordinator may:

1. create/reuse storage contexts and datasets,
2. prepare/check funding if needed,
3. upload bytes to a provider, or commit bytes already uploaded directly by the user,
4. add piece to dataset,
5. create multiple copies,
6. receive PieceCID, provider IDs, dataset IDs, piece IDs, transaction hashes, and retrieval URLs.

FOC state exists under the platform root/payer, but the Platform Contract attributes it to the end user.

#### Step 6: Coordinator finalizes on Platform Contract

The coordinator calls a function such as:

```solidity
function finalizeUpload(
  uint256 objectId,
  UploadReceipt calldata receipt
) external onlyCoordinator;
```

The receipt may include:

- PieceCID or PieceCID hash,
- size,
- completed copies,
- provider IDs,
- FOC dataset IDs,
- piece IDs,
- FOC transaction hashes,
- retrieval URLs or hashes,
- actual or estimated cost,
- success / partial / failure status.

The contract checks:

- caller is an authorized coordinator,
- object is in the expected state,
- receipt is not already finalized,
- size/copy count matches policy,
- cost is within the user's signed max cost or reserved amount.

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

- Platform Contract state,
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

1. Coordinator calls `failUpload(objectId, reasonHash)`, or timeout allows user/platform to cancel.
2. Contract marks status `Failed` or `Expired`.
3. Reserved balance/quota is released or partially charged, depending on policy.
4. Event is emitted for auditability.

### 9.2 Dual authorization model

The cleanest architecture has two separate authorization flows:

```mermaid
flowchart TD
  subgraph userAuth["User authorizes platform action"]
    intent["User intent"] --> platformContract["Platform Contract"]
  end

  subgraph platformAuth["Platform authorizes FOC execution"]
    root["FOC root wallet"] --> registry["SessionKeyRegistry"] --> coordinatorKey["Coordinator session key"]
  end
```

The first authorization proves the user requested the action and accepted platform policy/billing. The second authorization lets an operational coordinator perform FOC actions without exposing the platform root wallet.

This preserves the distinction between:

- **user authorization into the platform**, handled by platform auth, user intents, relays, or Platform Contracts;
- **platform authorization into FOC**, handled by root wallet, session keys, and FOC permission grants;
- **FOC protocol execution**, handled through Synapse SDK, providers, FWSS, and FOC contracts;
- **Platform Contract receipt/accounting finalization**, handled by `finalizeUpload(...)`, usage updates, and emitted accounting events.

### 9.3 Coordinator responsibilities

The coordinator MAY:

- watch `UploadRequested` events,
- accept temporary upload bytes,
- coordinate direct-to-FOC uploads,
- validate content hash/size,
- call Synapse SDK,
- create/reuse datasets,
- upload files and commit pieces,
- submit FOC transactions,
- call `finalizeUpload` on the Platform Contract,
- retry failed phases,
- emit logs/metrics.

The coordinator is not the same as the Platform Contract.

The Platform Contract answers:

- is this upload allowed?
- who owns it?
- who is charged?
- what status is it in?
- which coordinator may finalize?
- what receipt was recorded?

The coordinator answers:

- where are the bytes?
- how should they be uploaded?
- how should Synapse SDK be used?
- did FOC accept/commit the piece?
- what receipt should be finalized?

### 9.4 Statelessness requirement

The coordinator SHOULD be reconstructable from chain state.

Allowed coordinator state:

- in-memory queue,
- temporary file buffer,
- retry cache,
- idempotency cache,
- logs/metrics,
- optional non-authoritative job mirror.

Authoritative state SHOULD be in Platform Contracts and FOC contracts.

### 9.5 Coordinator model A: platform-hosted coordinator

This is the most natural v1 model for SaaS/platform companies.

```mermaid
flowchart TD
  user["User browser / API client"]
  endpoint["Platform upload endpoint"]
  coordinator["Platform-hosted FOC coordinator"]
  foc["Synapse SDK / FOC"]
  finalize["Platform Contract finalize"]

  user --> endpoint
  endpoint --> coordinator
  coordinator --> foc
  foc --> finalize
```

The platform maintains the coordinator as backend infrastructure.

Pros:

- best UX for users,
- user does not need FOC keys, FIL, USDFC, node setup, or CLI,
- platform can enforce file size, MIME policy, quotas, malware scanning, and rate limits,
- platform can hide FOC complexity,
- works well with platform-managed wallet/session key,
- easier to monitor and support.

Cons:

- platform temporarily handles file bytes,
- platform pays bandwidth/compute,
- coordinator is trusted to report correct receipts unless verification/challenge logic is added,
- more infrastructure burden.

Recommended v1 hosted-coordinator flow:

```mermaid
sequenceDiagram
  participant U as User
  participant R as Platform-hosted coordinator
  participant C as Platform Contract
  participant F as FOC / Synapse
  participant A as Platform API / contract reads

  U->>R: Upload bytes
  C-->>R: UploadRequested event/job
  R->>R: Validate bytes and request
  R->>F: Upload with FOC session key
  F-->>R: PieceCID / dataset / provider receipt
  R->>C: UploadFinalized receipt
  U->>A: Read stored object result
```

### 9.6 Coordinator model B: user-local coordinator

The coordinator runs on the user's machine, browser, desktop app, CLI, or agent.

```mermaid
flowchart TD
  coordinator["User-local coordinator"]
  foc["FOC via Synapse SDK"]
  finalize["Platform Contract finalize"]

  coordinator --> foc
  foc --> finalize
```

Two variants should remain possible.

#### B1. User-local coordinator using platform session key

This is generally unsafe for public users because the platform would be distributing FOC coordinator credentials.

It is **NOT RECOMMENDED** except for trusted enterprise/on-prem agents where the coordinator environment is controlled and contractual trust exists.

#### B2. User-local coordinator using user's own FOC wallet

The user pays or signs FOC operations directly.

```mermaid
flowchart TD
  wallet["User wallet pays FOC"]
  coordinator["Local coordinator uploads"]
  platform["Platform Contract<br/>records attribution"]

  wallet --> coordinator
  coordinator --> platform
```

This is more decentralized but has worse UX and is no longer the primary “platform-managed wallet pays FOC” model.

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

### 9.7 Coordinator model C: hybrid / bring-your-own coordinator

The platform MAY support allowlisted coordinators.

```mermaid
flowchart TD
  contract["Platform Contract"]
  coordinators["Allowlisted coordinators<br/>A, B, C"]
  finalize["Each coordinator can finalize<br/>authorized uploads"]

  contract --> coordinators
  coordinators --> finalize
```

Possible coordinator types:

- platform-hosted coordinator,
- enterprise customer self-hosted coordinator,
- local dev coordinator,
- AI-agent coordinator,
- serverless worker coordinator,
- marketplace coordinator in future.

The contract may store:

```solidity
mapping(address => bool) public approvedCoordinators;
mapping(address => CoordinatorPolicy) public coordinatorPolicies;
```

A request may specify:

```solidity
address preferredCoordinator;
bytes32 coordinatorMode;
```

or the platform may assign a coordinator offchain.

Pros:

- flexible,
- lets v1 start centralized but grow toward self-hosted/decentralized execution,
- useful for enterprise customers who do not want the platform to touch bytes.

Cons:

- more complex,
- requires coordinator authorization, policies, revocation, and audit,
- requires clear responsibility for failures.

Recommended direction:

```mermaid
flowchart TD
  default["v1 default"] --> defaultStack["Platform-hosted coordinator<br/>+ platform FOC root wallet<br/>+ FOC session key"]
  dev["v1 optional / dev"] --> local["Local coordinator for testing"]
  future["Future"] --> enterprise["Enterprise self-hosted coordinator"]
  future --> byow["Bring-your-own FOC wallet"]
  future --> network["Decentralized / allowlisted coordinator network"]
```

### 9.8 Direct-to-FOC upload with platform-delegated signing

A key optional architecture is **direct data plane, platform-controlled control plane**.

In this model, the platform never receives file bytes, but it still controls authorization, payment, and accounting.

This flow should usually have two distinct authorization moments:

1. **Upload ticket / plan:** the platform authorizes the user or browser to upload a specific file-shaped payload to a selected provider path. This is not broad spend authority.
2. **FOC commit authorization:** after the PieceCID/content hash is known and policy checks pass, the platform signs a narrow FOC operation-specific authorization for adding that piece to an approved dataset.

High-level flow:

```mermaid
flowchart TD
  user["User browser / app"]
  auth["Ask platform for upload authorization"]
  direct["Upload bytes directly<br/>to FOC provider"]
  sign["Platform signs / authorizes<br/>FOC commit"]
  commit["FOC provider / FWSS<br/>commits piece"]
  receipt["Platform Contract<br/>records final receipt"]

  user --> auth
  auth --> direct
  direct --> sign
  sign --> commit
  commit --> receipt
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
- optional upload ticket or provider authorization token.

The upload plan SHOULD NOT include broad reusable FOC spend authority. If it includes any commit-related authorization, that authorization must be scoped to the expected PieceCID/content hash, dataset, payer/root, metadata, expiry, and max-cost policy.

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

```mermaid
flowchart LR
  browser["Browser"] --> provider["FOC provider<br/>/pdp/piece"]
```

The platform does not proxy the file.

#### Step 4: Platform signs the FOC commit

The browser, coordinator, or provider needs FOC `extraData` authorizing the piece to be added to a dataset.

This is the second authorization moment. It SHOULD happen after the platform has enough information to bind the operation to the user request, especially the PieceCID or content hash. The platform keeps its root wallet/session key private and signs only the specific operation:

```mermaid
flowchart TD
  sig["Operation-specific signature"]
  piece["Add this PieceCID"]
  dataset["To this dataset"]
  payer["For this payer / root"]
  metadata["With this metadata"]
  expiry["Before this expiry"]

  sig --> piece
  sig --> dataset
  sig --> payer
  sig --> metadata
  sig --> expiry
```

The platform SHOULD sign using a FOC session key rather than the root wallet. The platform MUST NOT give the user the platform wallet key or a general coordinator session key. It only returns a narrow operation-specific signature or arranges for the coordinator to submit it.

#### Step 5: Commit happens

Two variants should remain possible.

**Variant A: browser submits commit to provider**

```mermaid
flowchart LR
  browser["Browser"] --> add["Provider addPieces(extraData)"]
  add --> contracts["FOC contracts"]
```

The browser coordinates the flow but cannot change what the platform signed.

**Variant B: platform coordinator submits commit**

```mermaid
flowchart TD
  browser["Browser"] --> store["Provider stores bytes"]
  coordinator["Platform-hosted coordinator"] --> add["Provider addPieces(extraData)"]
  store --> add
  add --> contracts["FOC contracts"]
```

The platform still never sees file bytes. The coordinator only commits the already-uploaded PieceCID. This is likely the safer v1 direct-upload model.

#### Step 6: Platform finalizes receipt

Once FOC confirms the piece, the platform records:

- object id,
- user,
- PieceCID,
- size,
- provider id,
- dataset id,
- FOC transaction hash,
- charge/quota impact.

Either:

- platform coordinator calls `finalizeUpload`, or
- user submits receipt and platform verifies or accepts it under policy.

Recommended direct-upload v1:

```mermaid
flowchart TD
  browser["Browser uploads bytes<br/>directly to FOC provider"]
  coordinator["Platform-hosted coordinator / signing service<br/>handles commit + finalization"]

  browser --> coordinator
```

This gives the platform less byte-handling responsibility while preserving platform control over wallet, signing, and accounting.

Caveats to test:

- provider CORS supports browser direct upload,
- browser can compute PieceCID efficiently for large files,
- provider direct upload APIs work from web clients,
- Synapse SDK supports split direct-upload / delegated-commit flow cleanly in browser,
- commit signatures can be safely issued after quota/policy checks,
- retry/failure behavior when upload succeeds but commit fails,
- direct upload can be bound to an onchain `objectId` and cannot be replayed to spend platform funds unexpectedly.

### 9.9 Coordinator trust model

Open options:

1. single platform-operated coordinator,
2. multiple allowlisted coordinators,
3. coordinator staking/slashing later,
4. user-submitted finalization with verifiable FOC receipts,
5. optimistic finalization with challenge window.

MVP may use a trusted coordinator with admin allowlisting.

### 9.10 Finalization receipt design

The Platform Contract Stack needs a compact but useful receipt shape for `finalizeUpload(...)`. The exact storage layout remains open, but implementations should preserve enough information to reconstruct the user-facing object, audit FOC transactions, and reconcile platform usage with FOC payment state.

Provisional receipt shape:

```solidity
enum UploadFinalizationStatus {
  Committed,
  Partial,
  Failed
}

struct CopyReceipt {
  uint256 providerId;
  uint256 dataSetId;
  uint256 pieceId;
  bytes32 addPieceTxHash;
  bytes32 retrievalUrlHash;
}

struct UploadReceipt {
  bytes32 pieceCidHash;
  uint256 size;
  uint8 requestedCopies;
  uint8 completedCopies;
  uint256 estimatedCost;
  uint256 actualCost;
  UploadFinalizationStatus status;
  CopyReceipt[] copies;
}
```

Open receipt design choices:

- store full PieceCID strings or only `pieceCidHash` plus event data,
- store all copy receipts in contract storage or only emit them in events,
- store retrieval URLs, retrieval URL hashes, or derive retrieval URLs offchain,
- verify FOC contract events onchain if feasible,
- rely on allowlisted coordinator assertion for MVP,
- include FOC payment rail IDs directly in the receipt or reconstruct them from dataset IDs and FOC views.

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
      "coordinatorMode": "local | remote | netlify | worker | sdk",
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
- `Coordinator`,
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
- coordinator status view,
- treasury balance view,
- FOC account runway view,
- object detail with PieceCID/provider/dataset receipts.

### 10.5 Upload adapter evolution

Current Token Host upload adapters can prototype FOC upload via `foc-cli`. Production SHOULD prefer direct Synapse SDK integration.

Potential coordinator modes:

1. `foc-process`: shell out to `foc-cli` for quick prototype.
2. `foc-sdk`: direct Synapse SDK coordinator.
3. `remote`: platform-hosted upload service.
4. `worker`: background worker / serverless queue.
5. `browser-assisted`: client uploads bytes, coordinator finalizes.

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
- optional coordinator-friendly APIs for split upload phases,
- documented session-key coordinator pattern,
- session-key lifecycle helpers for backend services,
- short-lived coordinator key examples,
- clear description of which operations require FWSS permissions and which require payment/operator approvals.

## 12. `foc-cli` and `foc-storage-mcp` Roles

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
- `@fil-b/foc-platform-coordinator`.

## 13. Compatibility Spike Requirements

Before choosing a final wallet/payment mode, run compatibility tests on Calibration.

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
10. Does `loginAndFund` matter for coordinator session keys on Filecoin, or should coordinator keys remain unfunded except for gas edge cases?
11. What expiry duration is appropriate for production coordinators?
12. Can FOC receipts be compactly represented and verified by a Platform Contract?
13. What minimum data must be stored onchain to reconstruct user/object usage?
14. What gas costs result from storing full receipts vs. compact hashes/events?

Recommended test cases:

1. **EOA root + session-key coordinator upload**: platform EOA deposits/approves FOC, authorizes a coordinator session key, uploads a file, and finalizes a Platform Contract receipt.
2. **Per-user dataset attribution**: two platform users upload through the same platform root wallet, but each upload lands in user-attributable FOC datasets and Platform Contract records.
3. **Direct-to-FOC browser upload**: browser uploads bytes directly to a provider, platform signs a scoped commit authorization after PieceCID/content hash is known, and a coordinator finalizes the receipt.
4. **Contract root session-key authorization**: Platform Contract or smart account calls `SessionKeyRegistry.login(...)`; test whether an EOA session key can sign FOC operations for that root/payer.
5. **Contract treasury payment path**: contract holds USDFC, approves/deposits into Filecoin Pay, and attempts to be payer for a dataset/payment rail.
6. **Smart account / ERC-1271 path**: smart account signs or validates FOC typed data, if supported, and attempts dataset creation/add-pieces flow.
7. **Provider direct-upload/CORS path**: browser performs provider upload without platform byte proxying; verify CORS, upload status, and failure behavior.
8. **Receipt compaction path**: finalize with compact hashes and event data, then reconstruct PieceCID/copy/provider/dataset/payment evidence from chain views.
9. **Reconciliation path**: intentionally create a mismatch between Platform Contract receipt state and FOC dataset/payment state, then detect and classify it.
10. **Session-key expiry/revocation path**: coordinator operation fails after expiry or revoke; platform observes and recovers by refreshing authorization.

Deliverable:

- a short compatibility report,
- example transaction hashes,
- recommended v1 payment mode,
- required SDK changes, if any.

## 14. MVP Options

### 14.1 MVP Option 1: Fast path, EOA payer + onchain registry

- Platform KMS/EOA pays FOC.
- Contracts track users, objects, requests, and usage.
- Coordinator is trusted and allowlisted.
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
- Image uploads go through FOC coordinator.
- Object/usage state is stored in generated contracts.
- Good for public demo and iterative design.

## 15. Security Considerations

Required protections:

- nonce/replay protection for intents,
- upload size limits,
- content hash validation,
- coordinator allowlist or proof model,
- user quota checks,
- platform pause switch,
- admin role separation,
- private key isolation for any EOA/KMS coordinator,
- no sensitive PII in onchain metadata,
- idempotent finalization,
- duplicate PieceCID/object handling policy,
- cost quote slippage controls.

Open decisions:

- whether finalization needs a challenge period,
- whether receipts must be independently verifiable onchain,
- whether coordinators stake collateral,
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

## 17. Reconciliation and Audit Model

The Platform Contract Stack and FOC onchain state must remain reconcilable. The goal is not merely to write platform receipts, but to ensure that platform-visible usage, user attribution, and billing state can be checked against actual FOC datasets, pieces, payment rails, and transaction receipts.

### 17.1 Sources of truth

The intended source-of-truth model is:

- **FOC contracts and provider-confirmed FOC transactions** are the source of truth for actual FOC storage commitments, datasets, pieces, payment rails, and payment state.
- **Platform Contracts** are the source of truth for platform product semantics: which user requested an object, who owns it in the platform, what quota/billing impact was recorded, and which FOC receipt was attributed to that user.
- **Coordinator state, platform API databases, logs, and indexers** are not authoritative. They may improve UX and operations, but they must be reconstructable or reconcilable from onchain state.

### 17.2 Required synchronization properties

For each finalized upload, the Platform Contract Stack should be able to prove or reconstruct:

1. The platform user or opaque user-id hash associated with the object.
2. The object id and request that authorized the upload.
3. The PieceCID or PieceCID hash committed to FOC.
4. The FOC provider ids, dataset ids, and piece ids used for each completed copy.
5. The FOC transaction hashes or event evidence for dataset creation/add-pieces operations.
6. The FOC payer/root wallet and payment rail state associated with the dataset.
7. The platform usage/billing delta applied to the user.

The onchain FOC payment state and the corresponding Platform Contract receipt/usage state should be:

- **in sync**: Platform Contract records should correspond to actual FOC datasets, pieces, and payment rails;
- **source-of-truth aligned**: FOC contracts are authoritative for FOC protocol/payment facts, while Platform Contracts are authoritative for user attribution and platform billing semantics;
- **auditable to user identity**: every recorded FOC object/copy/payment attribution should trace back to a platform user address or opaque user-id hash without exposing sensitive PII.

### 17.3 Reconciliation process

A reconciliation process, whether manual, CLI-driven, or automated, should:

1. Read finalized Platform Contract object receipts.
2. Query FOC datasets, pieces, provider ids, and payment rails through Synapse SDK / FOC views.
3. Compare Platform Contract usage counters against FOC piece sizes and copy counts.
4. Compare recorded payer/root, dataset ids, provider ids, and transaction hashes against FOC state.
5. Detect missing receipts, orphan FOC datasets, failed/partial copies, unexpected payment rails, and stale coordinator jobs.
6. Emit an auditable reconciliation report that can be tied to platform user ids or opaque user-id hashes.

Open reconciliation choices:

- whether reconciliation is a CLI command, background worker, Token Host generated admin view, or all of these;
- whether mismatches trigger automatic corrective transactions or only operator alerts;
- whether per-user FOC dataset allocation is required for all production modes or can be relaxed under explicit product constraints.

## 18. Open Questions

This draft intentionally leaves several choices unresolved. The body of the spec describes the viable shapes; this section names the decision gates that should be closed by compatibility work, prototypes, and product feedback.

### 18.1 Payment, custody, and delegation

1. What should the first supported FOC payer be: platform EOA/KMS, platform smart account, contract treasury, user-pays wallet, or a hybrid model?
2. Should v1 always use FOC session keys for coordinator execution, or should direct root signing remain a supported operator mode?
3. Can a smart account or contract wallet safely be the root identity for FOC session keys and payment rails?
4. Should a platform-specific contract custody USDFC in v1, or only record usage while an EOA/KMS wallet funds FOC?
5. How much of FOC payment rail state should be mirrored in the Platform Contract?

### 18.2 User authorization and billing semantics

1. Should users authorize uploads by sending platform-contract transactions, signing EIP-712 storage intents, authenticating to a normal platform API, or using a sponsored/gasless relay flow?
2. Should user billing be prepaid, credit-based, quota-only, token-gated/subscription-based, or hybrid?
3. When should user balances or quotas be reserved and released: request time, byte upload time, FOC commit time, or final receipt time?
4. What cost-slippage and max-cost guarantees should the user receive before the platform spends FOC funds?

### 18.3 Coordinator placement and data plane

1. Should the first product default be a platform-hosted coordinator, direct-to-FOC browser upload with platform-delegated signing, or both?
2. Which coordinator roles can safely run in the browser or user-local environment, and which must remain platform-controlled?
3. What enterprise/BYO coordinator model is worth preserving in v1 interfaces even if not implemented immediately?
4. Should uploads be synchronous from the API perspective, async/event-driven by default, or support both with polling/webhook patterns?

### 18.4 Receipts, verification, and reconciliation

1. Should the Platform Contract store full PieceCID strings or compact hashes?
2. Should provider/dataset copy receipts be stored in contract storage, emitted in events, represented as hashes, or verified against FOC contract events?
3. Is a trusted allowlisted coordinator sufficient for MVP finalization, or is a challenge/proof/user-submitted receipt path required early?
4. What reconciliation guarantees are required for production if offchain coordinator state is non-authoritative?

### 18.5 Implementation path and generated stack

1. Should Token Host generate generic CRUD/ledger contracts, a custom FOC platform module, or only a reference app around hand-written contracts?
2. What is the minimum useful admin UI for a platform operator: account runway, coordinator status, object receipts, usage ledger, or all of these?
3. Which deployment should be the canonical first demo: Calibration platform-hosted coordinator, direct-to-FOC browser upload, Token Host generated app, or a combined demo?
4. Which choices should be fixed before writing production contracts, and which can remain runtime configuration?

## 19. Proposed Phases

### Phase 0: Research and compatibility

- Test FOC contract-wallet/payment compatibility.
- Document current Synapse SDK assumptions.
- Identify required SDK changes.

### Phase 1: Onchain registry prototype

- Generate or hand-write simple platform registry.
- Add upload request/finalize flow.
- Build trusted coordinator with Synapse SDK.
- Store object and usage state onchain.

### Phase 2: Token Host Builder integration

- Add schema extension or example schema.
- Generate contracts/UI for platform storage objects.
- Integrate upload adapter/coordinator.
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
- Coordinator scaling.
- Audit.
- Documentation and reference platform integration.

## 20. Success Criteria

The buildout is successful when:

1. A platform can offer storage to users without designing its own FOC billing/accounting backend from scratch.
2. User object ownership and usage are reconstructable from onchain state/events.
3. Offchain coordinator state is not authoritative.
4. Uploads can be attributed to users and charged or quota-enforced.
5. FOC payment/runway health is observable.
6. The stack supports at least one working managed-wallet mode on Calibration.
7. The design remains extensible to smart-account or contract-treasury modes.
8. Token Host Builder can generate or scaffold a meaningful portion of the platform app.

