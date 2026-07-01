# FocPlatformRegistry

`FocPlatformRegistry` is the v1 onchain source of truth for upload lifecycle,
receipt, idempotency, coordinator, dataset, policy, and usage accounting state
defined in `spec.md` section 6.7.

The contract intentionally stores compact commitments rather than raw object
metadata or Filecoin payload data. Platform services and Token Host Builder
generated apps can build upload forms, read views, admin tools, and coordinator
adapters around this ABI, but generated CRUD must preserve the registry
invariants instead of replacing them.

## Current Invariants

- `requestUpload` creates monotonically increasing `objectId` records and
  reserves `maxCost` plus pending bytes under `(accountId, idempotencyKey)`.
- Upload requests can be created by the direct user, an allowlisted relayer, or
  any caller carrying a valid EIP-712 user signature.
- `startUpload`, `finalizeUpload`, `failUpload`, and `recordDataset` require an
  allowlisted, unexpired coordinator.
- `CoordinatorPolicy.maxFinalizeDelay` and `permissionsHash` are v1
  admin/reconciliation metadata. The registry enforces `allowed` and
  `sessionKeyExpiresAt`; FOC session-key permission checks remain external to
  this contract.
- `finalizeUpload` accepts committed, partial, or failed receipts and rejects
  expired requests, zero receipt hashes, copy-count mismatches, size mismatches,
  and costs above `maxCost`.
- Successful and partial finalization release reservations and pending bytes,
  count active bytes only for completed copies, retain per-copy receipts, and
  record the FOC payer/root address for reconciliation.
- Failure, cancellation, and expiry release reservations without counting active
  bytes. `failUpload` also rejects expired requests so late failures cannot
  charge after the user-visible deadline.
- Terminal statuses cannot be finalized, failed, cancelled, or expired again.

## Direct Read Surface

Current admin/dashboard state should be read directly from registry views. The
contract exposes bounded list/count methods so wrappers do not need a Token
Host-owned indexer or generated CRUD shadow table for current state:

- `objectCount`, `accountCount`, `coordinatorCount`, `relayerCount`, and
  `datasetRecordCount`;
- `listStorageObjectIds(cursorIdExclusive, limit, includeTerminal)`;
- `listAccountIds(offset, limit)`;
- `listAccountObjectIds(accountId, cursorIdExclusive, limit, includeTerminal)`;
- `listCoordinatorAddresses(offset, limit)`;
- `listRelayerAddresses(offset, limit)`;
- `listDatasetKeys(offset, limit)`;
- `readBatch(bytes[] calls)` for bounded read batching.

`MAX_LIST_LIMIT` is `50`. Calls with a larger limit revert with
`ListLimitExceeded`; `limit == 0` returns an empty page. `readBatch` is bounded
by the same limit and only static-calls the registry itself.

Object and account object lists use newest-first cursor semantics. Terminal
inclusive lists use object IDs. Active lists use linked-list indexes over
non-terminal objects and keep tombstone next pointers so stale cursors can
usually continue after objects finalize, fail, cancel, or expire. If stale
tombstone traversal exceeds the bounded scan budget, active list calls revert
with `ActiveCursorTraversalLimitExceeded(cursorIdExclusive, maxSteps)`; callers
should restart from `cursorIdExclusive = 0` rather than treating a short page as
the end of the list.

Detail truth remains in point reads: `getStorageObject`, `getAccountUsage`,
`getCopyReceipts`, `receiptPayer`, `getDatasetRecord`, `coordinatorPolicies`,
`isRelayer`, and `objectByIdempotencyKey`.

Offset lists retain disabled or expired coordinators/relayers and known dataset
keys. Operator views should show their current enabled/expiry/details from point
reads instead of dropping rows from the index.

## Deferred Semantics

The v1 registry does not move bytes, invoke FOC/Synapse, custody funds, manage
smart-account payer flows, delete active objects, or deduplicate shared
PieceCID values across object owners. Those behaviors belong to the coordinator,
API, demo, and later contract hardening issues in the platform tracker.

Event projection remains useful for audit trails, fixtures, local demos, and
historical reconstruction. It is not the primary current-state source once the
direct list/detail views are available. FOC provider/payment truth still needs
FOC contracts, provider-confirmed transactions, datasets, pieces, payment
rails, or public evidence artifacts; the registry records platform
attribution/accounting, not external FOC finality by itself.

Production claims still require the Phase 0 Calibration compatibility evidence
tracked separately. Until that evidence exists, the registry is an ABI and
invariant implementation target for downstream local and demo work.

## Validation

Run the registry checks with:

```sh
pnpm test:contracts
forge test --gas-report
pnpm build:artifacts
```

The gas report provides the contract deployment size and per-function gas
snapshot used during issue review. The artifact build writes the committed ABI
and bytecode snapshot consumed by deployment/read-model tooling.
