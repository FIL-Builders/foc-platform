# Registry Deployment And Read Model

The v1 registry artifacts live under `artifacts/contracts/` so API,
coordinator, generated UI, and admin tooling do not depend on ignored Foundry
`out/` files.

## Artifact Generation

```sh
pnpm build:artifacts
```

This command runs `forge build` and writes
`artifacts/contracts/FocPlatformRegistry.json`. The committed artifact contains
the ABI, creation bytecode, and deterministic SHA-256 hashes for bytecode and
deployed bytecode.

## Local Deploy Smoke

Run an Anvil node in one terminal:

```sh
anvil
```

Then deploy with a local Anvil private key in another terminal:

```sh
PLATFORM_ROOT_PRIVATE_KEY=0x... forge script script/DeployFocPlatformRegistry.s.sol:DeployFocPlatformRegistryScript \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast
```

Do not commit deployed addresses from local runs. Set
`FOC_PLATFORM_REGISTRY_ADDRESS` in `.env` only for local experiments.

## Calibration Deploy

Calibration deployment uses the same script with
`FILECOIN_CALIBRATION_RPC_URL` and a funded platform root key. Keep the
private key in a local shell environment and redact it from commands, PRs,
issues, logs, and committed files.

```sh
export PLATFORM_ROOT_PRIVATE_KEY=0xYOUR_REDACTED_PRIVATE_KEY

forge script script/DeployFocPlatformRegistry.s.sol:DeployFocPlatformRegistryScript \
  --rpc-url "$FILECOIN_CALIBRATION_RPC_URL" \
  --broadcast \
  --gas-estimate-multiplier 10000
```

The registry is compiled with `evm_version = "paris"` in `foundry.toml`.
The unpinned default solc target produced Calibration opcode-compatibility
risk, and lower Foundry gas estimates failed or reverted. On the 2026-06-30 HST
/ 2026-07-01 UTC partial Phase 0 run, `--gas-estimate-multiplier 10000`
produced a successful registry deployment.

The repo does not contain funded credentials. Any PR claiming Calibration deploy
success must include the deployed address, chain id, transaction hash, block
number, artifact hash, and the exact command used with secrets redacted.

## Operations Validation

Run the production-hardening baseline before publishing new Worker evidence or
claiming a healthy operator surface:

```sh
pnpm ops:validate
pnpm ops:smoke -- --iterations 3
npx wrangler deploy --dry-run --outdir /tmp/foc-platform-worker-dry-run
```

For a production-profile config check, set KMS/signer references instead of raw
private keys:

```sh
FOC_PLATFORM_OPS_PROFILE=production \
FOC_PLATFORM_ROOT_KMS_KEY_REF=projects/example/locations/global/keyRings/foc/cryptoKeys/root \
FOC_COORDINATOR_KMS_KEY_REF=projects/example/locations/global/keyRings/foc/cryptoKeys/coordinator \
FOC_PLATFORM_ADMIN_AUTH_AUDIENCE=https://admin.example.invalid \
pnpm ops:validate
```

These commands prove only local config hygiene, deterministic API/coordinator
semantics, and Worker bundle validity. They do not close the live FOC,
session-key, payment, or KMS gates listed in
[`docs/production-hardening-runbook.md`](./production-hardening-runbook.md).

Current partial Phase 0 registry deployment evidence is recorded in
[`docs/phase0-calibration-report.md`](./phase0-calibration-report.md). It proves
Calibration registry deployment and runtime bytecode verification only. It does
not prove FOC funding/approval, Synapse upload, session-key authorization,
dataset attribution, receipt finalization, or expiry/revocation behavior.

## Read Model

`src/registry/read-model.mjs` exposes:

- `registryArtifact` and `registryAbi` from the committed artifact;
- `decodeRegistryLog(log)` for ABI-safe registry event decoding;
- `registryObjectRead`, `registryUsageRead`, `registryCopyReceiptsRead`,
  `registryReceiptPayerRead`, `registryCoordinatorPolicyRead`,
  `registryRelayerRead`, and `registryDatasetRecordRead` for viem-compatible
  contract read requests;
- `applyRegistryEvents(events)` for reconstructing object, usage, receipt
  payer, copy receipt, coordinator, relayer, dataset, and idempotency state.

The read model is an indexer convenience. The registry contract remains the
authoritative source of object, usage, receipt, and policy state.

### Projection Boundaries

`applyRegistryEvents(events)` is useful for demos, admin lists, and generated
read surfaces, but it is not an authoritative database. Use contract reads when
exact current state matters.

- Object `createdAt` and `updatedAt` are populated only when decoded logs carry
  `blockTimestamp`. Without timestamp-enriched logs, call `registryObjectRead`.
- When every decoded event carries `blockNumber` and `logIndex`,
  `applyRegistryEvents` sorts by those fields before projection. If any event is
  missing those fields, the caller-provided order is preserved.
- `DatasetRecorded` does not emit `createdAt`. The projection records
  `updatedAt` only when `blockTimestamp` is supplied; exact dataset timestamps
  require `registryDatasetRecordRead`.
- Pending byte release is reconstructed from `UsageReleased` plus the known
  object request shape. If an indexer ingests release events without the matching
  request events, release counters clamp at zero and callers should refresh
  usage through `registryUsageRead`.
- `CoordinatorPolicy.permissionsHash` is audit/reconciliation metadata in v1.
  The registry enforces coordinator `allowed` and `sessionKeyExpiresAt`; FOC
  session-key permission checks are external to this registry.
