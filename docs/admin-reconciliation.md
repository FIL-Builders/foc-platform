# Admin And Reconciliation Surfaces

Issue #14 adds read-only operator surfaces for the current v1 registry wrapper.
They are route-equivalent modules, not a running admin server:

- `src/admin/reconciliation.mjs` builds object, usage, dataset, provider,
  coordinator, relayer, and mismatch views from `FocPlatformRegistry` event/read
  model state.
- `src/api/platform-admin-api.mjs` wraps those views with explicit admin
  authorization and exposes read-only admin routes.
- `test/admin-reconciliation.test.mjs` and `test/platform-admin-api.test.mjs`
  cover fixture projections, mismatch labels, and admin auth boundaries.

## Source Of Truth

The platform source of truth is the section 6.7 registry contract:

- objects and statuses from `getStorageObject` or reconstructed
  `UploadRequested`, `UploadStarted`, `UploadFinalized`, `UploadFailed`,
  `UploadCancelled`, and `UploadExpired` events;
- usage counters from `getAccountUsage` or reconstructed usage events;
- copy, receipt-payer, dataset, coordinator, and relayer state from registry
  views or events.

Actual FOC storage/payment facts are authoritative only when supplied from FOC
contracts, provider-confirmed FOC transactions, datasets, pieces, and payment
rails. The current helper accepts optional FOC evidence and otherwise reports
stored objects as `foc_evidence_not_checked`.

Coordinator-private state, platform API caches, generated Token Host CRUD
state, and local logs are not authoritative. They may help operators navigate a
demo, but every surfaced claim must be reconstructable from registry state or
explicit FOC evidence.

## Admin Routes

`createPlatformAdminApi({ authorizeAdmin, model | events | admin })` exposes:

```http
GET /admin/storage/dashboard
GET /admin/storage/objects
GET /admin/storage/objects/:objectId
GET /admin/storage/usage
GET /admin/storage/datasets
GET /admin/storage/coordinators
GET /admin/storage/reconciliation
```

The admin API requires an explicit `authorizeAdmin` hook. The included
`createStaticAdminAuthorizer` is a local/demo helper; production wrappers
should bind to the platform's real operator auth.

These routes intentionally do not reuse user object-ownership checks. They are
operator reads over registry state and must remain read-only until a separate
admin mutation surface is designed.

## Mismatch Classes

The projection currently detects:

- committed object copy-count mismatches,
- missing receipt hashes or receipt payers,
- missing dataset records for observed copy receipts,
- usage `activeBytes`, `pendingBytes`, and `reservedCost` mismatches against
  projected object state,
- account quota/runway warnings when quota hints are supplied,
- uploading objects with missing, disallowed, or expired coordinators,
- optional FOC evidence failures or copy-count mismatches,
- stored objects where FOC evidence has not been checked.

This is an admin/read scaffold, not production reconciliation automation. Real
Calibration reconciliation remains gated on Phase 0 evidence and the hosted
coordinator work: the operator view can report `not_checked`, but it must not
claim that FOC datasets, pieces, payment rails, or transaction logs were
verified without supplied evidence.

## Local Commands

Run focused admin checks:

```bash
pnpm test:admin
```

Regenerate Token Host wrapper metadata after changing admin routes or screens:

```bash
pnpm build:tokenhost
pnpm test:tokenhost
```

Full local gate:

```bash
pnpm build:artifacts && pnpm lint && pnpm test
```
