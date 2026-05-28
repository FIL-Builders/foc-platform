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

## 7. FOC Integration Modes

The stack MUST support multiple FOC payment/execution modes until compatibility is proven.

### 7.1 Mode A: Platform EOA/KMS pays FOC

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

### 7.2 Mode B: Platform smart account pays FOC

A smart account is the FOC payer and uses account abstraction or ERC-1271-compatible signing.

Pros:

- stronger onchain custody/accounting story,
- programmable wallet policies,
- easier multi-admin controls.

Cons:

- depends on FOC/Synapse/provider compatibility,
- may require SDK changes,
- may require ERC-1271 support in auth paths.

### 7.3 Mode C: Platform treasury contract pays FOC directly

Platform contract holds USDFC and directly calls Filecoin Pay / Warm Storage contracts.

Pros:

- most onchain-native model,
- minimal custody outside contracts.

Cons:

- may not be compatible with provider HTTP auth flows,
- contract cannot upload bytes,
- likely needs custom integration beyond current SDK.

### 7.4 Mode D: Users pay FOC directly, platform records usage

User wallets perform FOC payments/operations directly while platform contracts record attribution.

Pros:

- less platform custody,
- aligns payment responsibility with users.

Cons:

- worse UX,
- users need funds and approvals,
- platform cannot easily abstract FOC.

### 7.5 Mode E: Hybrid

The platform supports multiple modes per tenant or deployment.

Examples:

- free-tier users use platform wallet,
- enterprise users use dedicated smart account,
- advanced users bring their own FOC wallet.

## 8. Offchain Runner

A runner is required for byte movement and FOC execution.

### 8.1 Responsibilities

The runner MAY:

- watch `UploadRequested` events,
- accept temporary upload bytes,
- validate content hash/size,
- call Synapse SDK,
- create/reuse datasets,
- upload files and commit pieces,
- submit FOC transactions,
- call `finalizeUpload` on the platform contract,
- retry failed phases,
- emit logs/metrics.

### 8.2 Statelessness requirement

The runner SHOULD be reconstructable from chain state.

Allowed runner state:

- in-memory queue,
- temporary file buffer,
- retry cache,
- idempotency cache,
- logs/metrics,
- optional non-authoritative job mirror.

Authoritative state SHOULD be in platform contracts and FOC contracts.

### 8.3 Runner trust model

Open options:

1. single platform-operated runner,
2. multiple allowlisted runners,
3. runner staking/slashing later,
4. user-submitted finalization with verifiable FOC receipts,
5. optimistic finalization with challenge window.

MVP may use a trusted runner with admin allowlisting.

### 8.4 Finalization

Runner calls a function such as:

```solidity
function finalizeUpload(
  uint256 objectId,
  string calldata pieceCid,
  uint256 size,
  CopyReceipt[] calldata copies,
  bytes32 focTxHash,
  uint256 actualCost
) external onlyRunner;
```

Open receipt design:

- store all copy receipts onchain,
- store compact hashes onchain and full receipt in event,
- verify FOC contract events onchain if feasible,
- rely on allowlisted runner assertion for MVP.

## 9. Token Host Builder Integration

Token Host Builder can accelerate this stack because it already supports schema-generated EVM CRUD apps, onchain indexing, Filecoin upload adapters, Filecoin chain targets, generated UI, and sponsored transaction concepts.

### 9.1 Possible schema extension

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

### 9.2 Generated collections

Token Host MAY generate base collections/contracts for:

- `StorageObject`,
- `UploadRequest`,
- `UsageAccount`,
- `UsageEvent`,
- `DatasetRecord`,
- `ProviderCopy`,
- `Runner`,
- `BillingPlan`.

### 9.3 Generated indexes

Useful indexes:

- objects by user,
- objects by status,
- objects by CID hash,
- requests by status,
- usage events by user,
- datasets by provider,
- copies by object.

### 9.4 Generated UI/admin

Token Host MAY emit:

- user object browser,
- upload form,
- admin usage dashboard,
- runner status view,
- treasury balance view,
- FOC account runway view,
- object detail with PieceCID/provider/dataset receipts.

### 9.5 Upload adapter evolution

Current Token Host upload adapters can prototype FOC upload via `foc-cli`. Production SHOULD prefer direct Synapse SDK integration.

Potential runner modes:

1. `foc-process`: shell out to `foc-cli` for quick prototype.
2. `foc-sdk`: direct Synapse SDK runner.
3. `remote`: platform-hosted upload service.
4. `worker`: background worker / serverless queue.
5. `browser-assisted`: client uploads bytes, runner finalizes.

## 10. Synapse SDK Requirements / Opportunities

Potential SDK support needed:

- platform/backend examples,
- explicit upload receipt type suitable for contract finalization,
- deterministic cost quote helpers,
- contract-wallet compatibility docs,
- smart-account examples,
- KMS signer examples,
- dataset metadata strategy for multi-tenant platforms,
- receipt/reconciliation helpers,
- optional runner-friendly APIs for split upload phases.

## 11. foc-cli and foc-storage-mcp Roles

### 11.1 `foc-cli`

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

### 11.2 `foc-storage-mcp`

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

## 12. Compatibility Spike Requirements

Before choosing final wallet/payment mode, run compatibility tests on Calibration.

Required questions:

1. Can a contract hold USDFC and deposit into Filecoin Pay?
2. Can a contract approve Warm Storage as operator?
3. Can a contract be payer on payment rails?
4. Can a smart account execute Synapse SDK upload flows?
5. Do FOC provider HTTP auth flows require EOA signatures?
6. Is ERC-1271 supported or needed?
7. Can Synapse session keys be rooted in a smart account or contract wallet?
8. Can FOC receipts be compactly represented and verified by a wrapper contract?
9. What minimum data must be stored onchain to reconstruct user/object usage?
10. What gas costs result from storing full receipts vs compact hashes/events?

Deliverable:

- a short compatibility report,
- example tx hashes,
- recommended v1 payment mode,
- required SDK changes, if any.

## 13. MVP Options

### 13.1 MVP Option 1: Fast path, EOA payer + onchain registry

- Platform KMS/EOA pays FOC.
- Contracts track users, objects, requests, and usage.
- Runner is trusted and allowlisted.
- Token Host generates registry/usage UI.

This is likely the fastest working product.

### 13.2 MVP Option 2: Prepaid treasury + EOA executor

- Users deposit USDFC into platform treasury.
- Contract reserves/debits user balances.
- Platform EOA still executes FOC operations.
- Treasury may reimburse executor or simply account for liabilities.

This gives stronger billing/accounting semantics.

### 13.3 MVP Option 3: Smart-account payer

- Platform smart account pays FOC.
- Contracts/policies control smart account execution.
- Requires compatibility confirmation.

This is more onchain-native but higher risk.

### 13.4 MVP Option 4: Token Host generated demo app

- Use Token Host Builder to generate a Filecoin Calibration demo app.
- Image uploads go through FOC runner.
- Object/usage state is stored in generated contracts.
- Good for public demo and iterative design.

## 14. Security Considerations

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

## 15. Data Minimization

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

## 16. Open Questions

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

## 17. Proposed Phases

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

## 18. Success Criteria

The buildout is successful when:

1. A platform can offer storage to users without designing its own FOC billing/accounting backend from scratch.
2. User object ownership and usage are reconstructable from onchain state/events.
3. Offchain runner state is not authoritative.
4. Uploads can be attributed to users and charged or quota-enforced.
5. FOC payment/runway health is observable.
6. The stack supports at least one working managed-wallet mode on Calibration.
7. The design remains extensible to smart-account or contract-treasury modes.
8. Token Host Builder can generate or scaffold a meaningful portion of the platform app.

