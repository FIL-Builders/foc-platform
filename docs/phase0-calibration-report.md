# Phase 0 Compatibility Report

Date: 2026-06-30 HST / 2026-07-01 UTC
Author/operator: Codex, using local dev Calibration funding credentials
Network: Filecoin Calibration
Chain ID: 314159
FOC environment: Calibration; FOC MCP upload and registry finalization exercised; FOC payment/session-key flows not exercised
foc-platform commit: pending Worker demo PR; evidence generated from branch `codex/issue-15-worker-calibration-demo`
synapse-sdk commit/version: Not exercised
foc-cli commit/version: Not exercised
foc-storage-mcp commit/version: Not exercised
Coordinator branch/commit: Not created
Platform root/payer address: `0xF00DCE36817586672B47480FB48C94177A97278B`
Coordinator session key address: Not created
SessionKeyRegistry address: Not exercised
Warm Storage address: Not exercised
Filecoin Pay address: Not exercised
USDFC address: Not exercised

This is a partial Phase 0 run. It proves that the section 6.7 registry artifact
can be built for Calibration-compatible bytecode, deployed on Calibration, read
back with matching runtime bytecode, and driven through a root-authorized
request/start/dataset/finalize flow for one FOC dataset piece. It does not yet
prove the FOC payment rail, Synapse SDK upload path, real session-key
coordinator, or expiry/revocation paths required to close the full Phase 0 gate.

## Final Recommendation

Recommended v1 payment mode: FAIL/PENDING - keep platform EOA/KMS payer as the selected candidate, but do not claim production readiness until FOC funding, approval, and upload evidence exists.
Recommended v1 coordinator mode: FAIL/PENDING - platform-hosted coordinator with FOC session key remains the selected candidate, but no session key was created in this run.
Recommended v1 contract mode: PASS/PARTIAL - registry deployment, runtime hash verification, upload request/start/finalize, and public readback passed for one root-authorized demo object.
Recommended v1 dataset mode: PASS/PARTIAL - one account/provider/dataset attribution path was recorded and read back; multi-account attribution remains untested.
Modes gated out of v1: contract treasury payer, smart-account payer, direct browser-to-FOC upload.
Required SDK changes before v1: None confirmed by this registry-only run.
Required contract changes before v1: keep Foundry `evm_version = "paris"` for Calibration until Filecoin Calibration supports newer EVM opcodes used by default solc output.
Required operator runbook changes before v1: document high Filecoin message gas limits or a high Foundry gas estimate multiplier for Calibration deploys.

## Required Compatibility Matrix

| ID | Question/test | Required evidence | Result | Tx hash(es) / log link(s) | SDK gaps | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | EOA root + session-key coordinator upload | Root funds/approves FOC, grants session key, coordinator uploads and commits one object. | FAIL/PARTIAL | Registry txs `0x552b1da9b049dc1301effcc34c497625a1e09934b25bec7e5a3fe607ba3382fd`, `0x1d1104fb0807ff05f4a4c9045dcfc888a54bd6d143edab25e19ec6d4bd6a8bb1`, `0xebbf1d335df22f3607e9552753360d80d48fd28d199ef0afa19f052d5fd57608` | Session-key path not exercised | Root address was funded, uploaded through the local FOC MCP tool, and finalized one object. A real FOC session key was not created; the root address was allowlisted as coordinator. |
| T2 | Per-user dataset attribution | Two accountIds upload through same payer; receipts identify separate account/provider dataset attribution. | FAIL | None | Not exercised | Requires live FOC/Synapse uploads. |
| T3 | Compact receipt finalization | Platform registry finalizes with piece hash, provider id, dataset id, piece id, payer, add-piece tx hash, and receipt hash. | PASS/PARTIAL | Finalize tx `0xebbf1d335df22f3607e9552753360d80d48fd28d199ef0afa19f052d5fd57608` | Add-piece tx hash unavailable | Registry object `1` finalized as `Committed` with provider `4`, dataset `12524`, piece `34`, payer `0xF00DCE36817586672B47480FB48C94177A97278B`, and receipt hash `0xce534bd735f5dea29729cd9a25ebcf5e1ff469b0979317d5e50dce75fccbb3c0`. The upload client timed out before returning add-piece tx/cost fields, so those were recorded as explicit limitations. |
| T4 | Reconciliation | A report reconstructs platform object/usage state from Platform Contract events and FOC dataset/payment state. | PASS/PARTIAL | Evidence artifact `artifacts/calibration/demo-evidence.json`; Worker live read `/api/demo/registry` | Payment state not exercised | Object, usage, receipt payer, copy receipt, and dataset records read back from the registry for object `1`; FOC dataset read showed matching piece metadata. Filecoin Pay state remains untested. |
| T5 | Session-key expiry/revocation | Coordinator action fails after expiry or revoke; refreshed authorization recovers cleanly. | FAIL | None | Not exercised | Requires a real session-key coordinator run. |
| F1 | Contract root session-key authorization | Contract or smart account calls `SessionKeyRegistry.login(...)`; EOA session key attempts FOC operation for that root. | N/A | None | Not exercised | Future-mode gate. |
| F2 | Contract treasury payment path | Contract holds USDFC, approves/deposits into Filecoin Pay, and attempts payer flow. | N/A | None | Not exercised | Future-mode gate. |
| F3 | Smart account / ERC-1271 path | Smart account signs or validates required FOC typed data and attempts dataset/add-piece flow. | N/A | None | Not exercised | Future-mode gate. |
| F4 | Direct browser-to-FOC upload | Browser uploads directly to provider; CORS, auth, status, and failure behavior are recorded. | N/A | None | Not exercised | Future-mode gate. |

## Registry Deployment Evidence

Deployment command, with secrets redacted:

```sh
export PLATFORM_ROOT_PRIVATE_KEY=0xYOUR_REDACTED_PRIVATE_KEY
RPC_URL="https://api.calibration.node.glif.io/rpc/v1"

forge script script/DeployFocPlatformRegistry.s.sol:DeployFocPlatformRegistryScript \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --gas-estimate-multiplier 10000
```

Observed deployment:

| Field | Value |
| --- | --- |
| Deployer/root | `0xF00DCE36817586672B47480FB48C94177A97278B` |
| Registry | `0x7771d916a9d742B1D60597a332C7ABBd5796609c` |
| Transaction | `0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552` |
| Block | `3852147` |
| Status | `1` |
| Gas used | `112139191` |
| Effective gas price | `474804` |
| Runtime length | `27224` hex chars, `13612` bytes |
| Artifact bytecode SHA-256 | `0x9452ef2e4b2abb5876cb963f226139267c809ad5ae87ad18d2f72305aab0ff62` |
| Artifact deployed-bytecode SHA-256 | `0xed478a27e255a1b27989ffa4f2fcbf38f1a9ec61a84c8d3e20aceb4e26f72040` |
| RPC runtime SHA-256 | `ed478a27e255a1b27989ffa4f2fcbf38f1a9ec61a84c8d3e20aceb4e26f72040` |

Public verification commands:

```sh
RPC_URL="https://api.calibration.node.glif.io/rpc/v1"
REGISTRY="0x7771d916a9d742B1D60597a332C7ABBd5796609c"

cast receipt 0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552 \
  --rpc-url "$RPC_URL"

cast call "$REGISTRY" 'owner()(address)' --rpc-url "$RPC_URL"
cast call "$REGISTRY" 'nextObjectId()(uint256)' --rpc-url "$RPC_URL"

code=$(cast code "$REGISTRY" --rpc-url "$RPC_URL")
printf "0x%s\n" "$(printf "%s" "${code#0x}" | xxd -r -p | shasum -a 256 | awk '{print $1}')"
jq -r '.deployedBytecodeSha256' artifacts/contracts/FocPlatformRegistry.json
```

Verification results:

- `owner()` returned `0xF00DCE36817586672B47480FB48C94177A97278B`.
- `nextObjectId()` returned `1`.
- Runtime SHA-256 from RPC code matched the committed artifact deployed-bytecode hash.
- The deploy transaction emitted `OwnershipTransferred` and `PolicyUpdated`.

## Failed Deploy Attempts

Default Foundry deployment gas was too low for Filecoin message storage costs.
Increasing `--gas-estimate-multiplier` below the successful value still produced
failed transactions.

| Multiplier | Result | Evidence |
| --- | --- | --- |
| default | Not broadcast | `GasLimit field cannot be less than the cost of storing a message on chain 4078955 < 19114263` |
| `600` | Not broadcast | `18825948 < 19114263` |
| `700` | Broadcast, reverted | tx `0x958d53e59469550338b175d124ab22511820f882f3f5685506af21ac9b383039`, block `3852135`, status `0`, gas used `21963606` |
| `1000` | Broadcast, reverted | tx `0xd10b92c0f4c9eef45af4c6daab2f75a905135f9cc36de264a0317c43fada1e52`, block `3852138`, status `0`, gas used `31376580` |
| `2000` | Broadcast, reverted | tx `0xb4eb54a8c5c34cb81a939a7d53ece768766a9737283b20db229d1ffaa0ae2149`, block `3852142`, status `0`, gas used `62753160` |
| `10000` | Broadcast, succeeded | tx `0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552`, block `3852147`, status `1`, gas used `112139191` |

Tooling notes:

- `cast codehash` was not available through the public GLIF Calibration RPC in this run; the RPC returned HTTP 501 for the underlying method.
- `cast run` could not trace the failed Filecoin create transactions cleanly and reported an unexpected zero-address call shape. The receipt/status and deployed-code checks above were used instead.

## Required Transaction Evidence

- Session-key login tx: Not run.
- Filecoin Pay deposit/approval tx: Not run.
- Dataset creation tx(s): provider dataset `12524` already existed; registry dataset attribution tx `0x3ec159924041a28531652a23ca4343f7aa8186da47f5c27cc6e8410bee5a3ea3`.
- Add-piece/commit tx(s): FOC MCP upload timed out before returning an add-piece tx hash; provider dataset read showed piece `34` with matching metadata.
- Platform upload-request tx: `0x552b1da9b049dc1301effcc34c497625a1e09934b25bec7e5a3fe607ba3382fd`.
- Platform finalize/fail tx: `0xebbf1d335df22f3607e9552753360d80d48fd28d199ef0afa19f052d5fd57608`.
- Session-key revoke or expiry evidence: Not run.
- Reconciliation report artifact: `artifacts/calibration/demo-evidence.json`.
- Registry deployment tx: `0xb6a4469ae4bff657326d25dd9989ebae54f03467c8ddee19001b1c114fe70552`.

If a required action does not create a transaction, link the SDK log, provider
response, or script output and explain why no tx exists. The missing actions
above were not executed in this partial registry deploy.

## SDK and Tooling Gaps

| Repo | Gap | Blocks v1? | Proposed fix | Owner | Issue/PR |
| --- | --- | --- | --- | --- | --- |
| synapse-sdk | Not exercised in this registry-only run. | YES, as an evidence gap | Run T1-T5 with the current SDK and record versions/logs. | TBD | TBD |
| foc-cli | Not exercised in this registry-only run. | NO | Use only if the coordinator prototype shells out during the next run. | TBD | TBD |
| foc-storage-mcp | Not exercised in this registry-only run. | NO | Use only for agent-driven upload checks if it is part of the next runbook. | TBD | TBD |
| foc-platform | Calibration deploy required Paris-targeted bytecode and a high gas estimate multiplier. | NO for registry deploy, YES for operator docs | Keep `evm_version = "paris"` and document the Calibration deploy command. | foc-platform | This PR |

## Failure and Timeout Findings

- Upload request expiry behavior: Not tested.
- Coordinator retry behavior: Not tested.
- Partial-copy behavior: Not tested.
- Provider failure behavior: Not tested.
- Session-key expiry/revoke behavior: Not tested.
- Reconciliation mismatch behavior: Not tested.
- Registry deploy behavior: low/default Foundry gas was insufficient on Calibration; `--gas-estimate-multiplier 10000` succeeded for this artifact.

## Decision Log

| Decision | Ship in v1 / Gate / Defer | Evidence | Follow-up |
| --- | --- | --- | --- |
| Platform EOA/KMS payer | Gate | Funded EOA deployed registry, local FOC MCP upload landed in dataset `12524`, and registry object `1` finalized successfully. Filecoin Pay approval/deposit was not separately proven because the upload used existing available storage funds. | Run T1 with explicit payment approval/deposit evidence and a real FOC session-key coordinator. |
| Session-key coordinator | Gate | No coordinator session key was created in this run. | Run T1 and T5. |
| Contract treasury payer | Defer | Not tested. | Keep future-mode gated unless F2 passes. |
| Smart-account payer | Defer | Not tested. | Keep future-mode gated unless F3 passes. |
| Direct browser upload | Defer | Not tested. | Keep future-mode gated unless F4 passes. |
| Token Host Builder scaffolding | Gate | Not exercised in this registry deploy. | Complete the Token Host Builder compatibility matrix and generated-demo run. |
| Token Host generated FOC module | Gate | Not exercised in this registry deploy. | Generate only after section 6.7 compatibility is proven or clearly mark as prototype. |
