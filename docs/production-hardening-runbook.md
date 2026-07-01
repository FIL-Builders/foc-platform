# Production Hardening Runbook

This runbook is the issue #16 operational boundary for the current FOC Platform
demo-to-production stack. It documents what the repository can prove today, how
to validate the safe demo surface, and which controls still block production
readiness.

The stack is not production-ready. The public Calibration Worker proves that
live public evidence can be served from Cloudflare Workers; it is not an upload
service, wallet service, KMS integration, durable coordinator queue, or payment
rail.

## Threat Model

| Surface | Primary risk | Current control | Production gate |
| --- | --- | --- | --- |
| Platform root wallet | Fund loss, unauthorized registry ownership or coordinator changes. | Local scripts keep root keys in the operator shell; no root key is committed or sent to the Worker. | Replace raw root-key env usage with a KMS/signer adapter before production. |
| Coordinator session key | Over-broad or expired upload authority. | Coordinator config validates session key address, root, expiry, permissions hash, and rejects `FOC_*PRIVATE_KEY` env values. | Complete issue [#11](https://github.com/FIL-Builders/foc-platform/issues/11) with live hosted session-key evidence, expiry, and revoke checks. |
| Relayers and sponsored transactions | Replay, unexpected signer path, or unbounded spend. | Relayer mode is documented as future/compatibility-gated; generated Token Host metadata keeps sponsored relay wiring explicit. | Add authenticated relay policy, budget limits, and transaction audit logs before enabling. |
| Generated Token Host UI | Generated UI could imply stronger semantics than the section 6.7 API supports. | Wrapper manifest identifies gaps and binds upload calls to `/storage/tokenhost/upload`; production semantics remain in `spec.md` section 6.7. | Track builder gaps in [tokenhost-builder#79](https://github.com/tokenhost/tokenhost-builder/issues/79), [#80](https://github.com/tokenhost/tokenhost-builder/issues/80), [#81](https://github.com/tokenhost/tokenhost-builder/issues/81), and [#82](https://github.com/tokenhost/tokenhost-builder/issues/82). |
| Upload endpoints | Abuse, duplicate requests, oversized bodies, terminal-state retries. | Route-equivalent API validates auth subject, idempotency, account ownership, byte size, and terminal-state retries in local tests. | Add production HTTP wrapper rate limits, body limits, auth, durable idempotency, and queueing before internet exposure. |
| Receipt finalization | Uploaded bytes succeed but registry finalization fails or is replayed incorrectly. | Local coordinator stores pending finalization state and can recover when the registry already matches the receipt. | Persist pending-finalize state durably and alert until registry receipt, FOC evidence, and admin reconciliation agree. |
| Public Worker demo | Public endpoint accidentally receives secrets or privileged behavior. | `wrangler.jsonc` and `src/worker/calibration-demo.mjs` are secret-free; Worker serves only public evidence and registry reads. | Keep privileged upload, payment, and registry write paths outside the Worker unless a new reviewed design adds KMS-backed signing. |

## Secret Management

Production mode must use signer adapters, not raw key environment variables.
The intended v1 signing shape is:

- root wallet operations through `FOC_PLATFORM_ROOT_KMS_KEY_REF`;
- coordinator/session signing through `FOC_COORDINATOR_KMS_KEY_REF`;
- admin API access bound to a real platform auth audience in
  `FOC_PLATFORM_ADMIN_AUTH_AUDIENCE`;
- short-lived session keys with explicit expiry, permissions hash, and
  revocation evidence.

Local Calibration demos may use a funded devnet key from the operator shell.
That key must stay local, must not be committed, and must not be copied into
issues, PRs, Worker vars, generated UI, or artifacts. The production validation
profile rejects raw `PRIVATE_KEY`, `PLATFORM_ROOT_PRIVATE_KEY`,
`COORDINATOR_PRIVATE_KEY`, `FOC_*PRIVATE_KEY`, scoped secret env names, generic
mnemonic/seed env names, and generic private-key/secret env names when they
contain raw 64-byte hex material with or without a `0x` prefix.

## Rate Limits And Timeouts

The repository exposes route-equivalent modules today, not a production HTTP
server. A production wrapper must enforce these minimum controls before exposing
write paths:

| Setting | Default baseline | Purpose |
| --- | --- | --- |
| `FOC_PLATFORM_API_RATE_LIMIT_RPM` | `60` | Per-auth-subject write throttle for upload create/submit paths. |
| `FOC_PLATFORM_API_TIMEOUT_MS` | `10000` | HTTP wrapper timeout before returning a retryable platform error. |
| `FOC_COORDINATOR_UPLOAD_TIMEOUT_MS` | `120000` | Upper bound for coordinator upload execution. |
| `FOC_COORDINATOR_PROVIDER_TIMEOUT_MS` | `120000` | Upper bound for provider/Synapse calls. |
| `FOC_COORDINATOR_MAX_RETRIES` | `3` | Retry cap for pre-FOC and finalization-safe failures. |
| `FOC_COORDINATOR_RETRY_BACKOFF_MS` | `1000` | Initial retry backoff; production wrappers should add jitter. |
| `FOC_RECONCILIATION_INTERVAL_SECONDS` | `300` | Target cadence for admin reconciliation polling. |

The local coordinator already classifies some retry boundaries: pre-FOC start
failures remain retryable, terminal uploads reject byte retries, and
post-upload finalization failures retain a pending receipt for retry. The
production queue still needs durable persistence, bounded retries, and alerting.

## Validation Commands

Baseline local validation:

```sh
pnpm ops:validate
pnpm ops:smoke -- --iterations 3
npx wrangler deploy --dry-run --outdir /tmp/foc-platform-worker-dry-run
```

Production-profile config validation requires KMS references and rejects raw
keys:

```sh
FOC_PLATFORM_OPS_PROFILE=production \
FOC_PLATFORM_ROOT_KMS_KEY_REF=projects/example/locations/global/keyRings/foc/cryptoKeys/root \
FOC_COORDINATOR_KMS_KEY_REF=projects/example/locations/global/keyRings/foc/cryptoKeys/coordinator \
FOC_PLATFORM_ADMIN_AUTH_AUDIENCE=https://admin.example.invalid \
pnpm ops:validate
```

`pnpm ops:validate` performs a tracked-file secret scan for concrete private
key assignments, verifies the runbook and package wiring, and validates the
configured operations profile. `pnpm ops:smoke` runs deterministic in-memory
API and coordinator flows. It does not move real bytes on FOC, spend funds, or
prove production readiness.

## Smoke Baseline

Expected `pnpm ops:smoke -- --iterations 3` shape:

```json
{
  "ok": true,
  "mocked": true,
  "productionReady": false,
  "iterations": 3,
  "api": {
    "created": 3,
    "duplicates": 3,
    "statusReads": 3
  },
  "coordinator": {
    "committed": 3,
    "replays": 3,
    "uploadCalls": 3,
    "finalizeCalls": 3
  }
}
```

If this smoke fails, do not update Worker evidence or claim a healthy operator
baseline. Fix the local API/coordinator failure first, then rerun the command
and include the JSON summary in the PR.

## Reconciliation Runbook

Use registry state as the source of truth. Coordinator-private state, generated
UI state, and local logs are only navigation aids.

1. Run the focused admin checks:

   ```sh
   pnpm test:admin
   ```

2. Run the local operator baseline:

   ```sh
   pnpm ops:validate
   pnpm ops:smoke -- --iterations 3
   ```

3. For the public Worker demo, verify health and evidence:

   ```sh
   curl https://foc-platform-calibration-demo.snissn.workers.dev/api/health
   curl https://foc-platform-calibration-demo.snissn.workers.dev/api/demo/evidence
   curl https://foc-platform-calibration-demo.snissn.workers.dev/api/demo/registry
   ```

4. For live Calibration claims, record registry transaction hashes, provider
   dataset/piece evidence, receipt hashes, payer, and copy receipts. If FOC
   evidence is unavailable, the reconciliation result must remain
   `foc_evidence_not_checked`.

5. Compare admin mismatch classes:

   - committed object copy-count mismatch;
   - missing receipt hash or receipt payer;
   - missing dataset records for observed copy receipts;
   - usage counter mismatch;
   - disallowed, missing, or expired coordinator;
   - optional FOC evidence failure.

## Failure Recovery

| Failure | Recovery |
| --- | --- |
| Upload remains `Requested` | Check idempotency key, account mapping, coordinator allowlist, and `requestExpiresAt`; retry coordinator execution only if the request is still active. |
| Upload remains `Uploading` with no FOC receipt | Inspect coordinator logs and provider/Synapse response. If bytes were not accepted by FOC, retry through the same idempotency key. If FOC accepted bytes, recover finalization instead of starting a new upload. |
| `finalize_upload_failed` after FOC success | Retry finalization with the retained pending receipt. Do not call provider upload again unless reconciliation proves the original upload did not commit. |
| Expired session key | Stop writes, rotate the session key, update coordinator policy, and rerun the expiry/revoke evidence from issue #11 before resuming production writes. |
| Missing FOC transaction hash | Preserve provider dataset/piece evidence and mark transaction-hash verification as unavailable; do not convert it to a verified payment claim. |
| Secret suspected leaked | Rotate the root or session key, remove the leaked value from the environment, run `pnpm ops:validate`, and audit Worker vars plus generated artifacts before redeploy. |
| Worker demo evidence stale | Regenerate only public evidence locally, run `pnpm worker:dry-run`, and redeploy with `npx wrangler deploy` after review. |

## Remaining Production Gates

- [foc-platform#6](https://github.com/FIL-Builders/foc-platform/issues/6):
  finish the full Phase 0 Calibration compatibility report, including FOC
  funding/approval, Synapse upload/commit, payment evidence, reconciliation,
  and expiry/revoke evidence.
- [foc-platform#11](https://github.com/FIL-Builders/foc-platform/issues/11):
  replace local coordinator fixtures with real hosted session-key coordinator
  evidence, durable state, and live failure recovery.
- [tokenhost-builder#79](https://github.com/tokenhost/tokenhost-builder/issues/79),
  [#80](https://github.com/tokenhost/tokenhost-builder/issues/80),
  [#81](https://github.com/tokenhost/tokenhost-builder/issues/81), and
  [#82](https://github.com/tokenhost/tokenhost-builder/issues/82): close the
  generated FOC Platform module, lifecycle, admin/reconciliation, and
  receipt-aware upload-runner gaps.

Until those gates close, this repository can demonstrate the Worker evidence
surface and local route-equivalent operations, but it must not be marketed or
operated as a production FOC storage service.
