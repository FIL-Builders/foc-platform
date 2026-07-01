# Hosted Coordinator Boundary

Issue #11 adds the dev/local hosted coordinator boundary for the v1
platform-managed FOC path. This is scaffolding, not a claim of live FOC
execution.

## Boundary

The coordinator is a backend-only component. It accepts upload bytes from the
platform path, validates the declared size and optional content commitment,
checks a scoped FOC session-key descriptor, invokes an injected FOC/Synapse
adapter, and maps the result into the section 6.7 `UploadReceipt` and
`CopyReceipt` contract shape.

The coordinator must not expose platform root keys, coordinator session-key
private keys, mnemonics, seeds, provider credentials, or signer internals to
browser builds or generated static artifacts. The config loader rejects raw
`FOC_*PRIVATE_KEY`, `FOC_*MNEMONIC`, `FOC_*SEED`, and `FOC_*SECRET` environment
values. Production signing should enter as a private backend signer/KMS adapter.

## Current Implementation

- `src/coordinator/config.mjs` loads public coordinator config, creates
  session-key descriptors, validates expiry and permissions hashes, and returns
  a public-safe config view.
- `src/coordinator/receipts.mjs` validates upload bytes, maps simulated
  Synapse-style results to section 6.7-compatible receipt tuples, derives
  deterministic receipt hashes when richer FOC receipt artifacts are missing,
  and maps failures to deterministic reason hashes.
- `src/coordinator/local-hosted-coordinator.mjs` composes injected registry and
  FOC adapters. It calls `startUpload`, `finalizeUpload`, or `failUpload` where
  the adapter supports them and keeps only reconstructable, in-memory
  idempotency state for the local/dev process.

## Idempotency

The local coordinator idempotency key is:

```text
<objectId>:<request.idempotencyKey>
```

When no request idempotency key is available, it falls back to the keccak hash
of the bytes. A completed attempt is replayed from the in-memory result. A
failed attempt rethrows the mapped coordinator failure and does not rerun the
FOC adapter. This state is intentionally temporary and process-local; the
registry remains the authoritative lifecycle surface.

## Receipts

Successful uploads are mapped into:

- `finalizationStatus`: `Committed`, `Partial`, or `Failed` enum index.
- `payer`: platform root/payer address from the FOC result, config, or session
  root.
- `pieceCidHash`: supplied FOC value or a deterministic hash of the reported
  PieceCID.
- `size`, `requestedCopies`, `completedCopies`, and `actualCost`.
- `receiptHash`: supplied FOC receipt hash or a deterministic hash of the v1
  receipt tuple.
- `copies`: provider, dataset, piece, add-piece transaction, retrieval URL, and
  dataset-newness fields.

Failure handling maps thrown adapter errors into a deterministic `reasonHash`
and calls `failUpload` with zero charged cost. If future policy allows failure
charges, that should be a deliberate config and test expansion.

## Blockers

Real FOC/Synapse/Calibration execution is still blocked by missing funded
credentials and environment. The local adapter tests prove coordinator boundary
behavior only:

- config rejects raw secret material;
- session-key expiry and permissions hash checks run before upload execution;
- declared size and optional content commitments are validated;
- simulated FOC results map to registry receipt structs;
- coordinator failures map to `failUpload`;
- retries are idempotent within the local process.

Before claiming production readiness, run a funded Calibration smoke test that
authorizes a real FOC session key, executes Synapse upload/commit, captures tx
logs, finalizes the registry receipt, and documents session-key expiry or
revocation behavior.
