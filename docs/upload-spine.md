# Dev Upload Spine

The dev upload spine is the first executable local path through the v1 registry
lifecycle. It proves the platform control flow without using Filecoin
Calibration credentials or moving FOC bytes.

Run it with:

```sh
pnpm test:spine
```

The test starts a disposable local Anvil node, deploys the committed
`FocPlatformRegistry` artifact, discovers four unlocked Anvil accounts, and
executes:

1. platform root allowlists a relayer and coordinator,
2. relayer calls `requestUpload` for a platform user,
3. coordinator calls `startUpload`,
4. coordinator finalizes a deterministic mocked `UploadReceipt`,
5. the runner reads object, usage, copy receipts, and receipt payer from the
   registry,
6. the runner projects the same logs through `src/registry/read-model.mjs`.

## Mocked Boundary

This command is local/dev-only.

- No file bytes are uploaded.
- No Synapse SDK call is made.
- No Filecoin Calibration transaction is submitted.
- The receipt, provider IDs, dataset IDs, piece IDs, transaction hashes, and
  retrieval URL hashes are deterministic fixture values.
- The coordinator is a local Anvil account with the registry coordinator role.

The production semantics exercised by this path are the registry artifact,
access control, idempotency key, request lifecycle, receipt validation, copy
receipt persistence, usage accounting, contract reads, and event projection.

## Demo/API Response Shape

`runDevUploadSpine({ rpcUrl })` in `src/dev/upload-spine.mjs` returns a
demo-facing status payload with:

- `request`: account, idempotency, content, metadata, size, copy count, CDN, and
  max cost fields;
- `receipt`: deterministic receipt hash, payer, piece hash, cost, and copy
  fields;
- `reads`: authoritative `getStorageObject`, `getAccountUsage`,
  `getCopyReceipts`, and `receiptPayer` results;
- `projection`: the same object, usage, copy, and payer state reconstructed from
  decoded logs;
- `demoStatus`: the compact status shape intended for downstream Token Host
  Builder API/UI binding;
- `mocked`: explicit flags describing which pieces are not real FOC execution.

Downstream Token Host Builder work should bind against the contract/read-model
shape from this runner, while preserving the mocked boundary until the
production coordinator and Calibration evidence land.
