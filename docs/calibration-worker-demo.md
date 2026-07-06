# Calibration Worker Demo

Issue #15 exposes the Calibration demo through a Cloudflare Worker. Issue #32
turns the Worker first screen into a read-only admin dashboard for the
configured `FocPlatformRegistry`: it serves public evidence, reads dashboard
rows through direct registry list/detail views, and links to generated Token
Host wrapper metadata. Issue #33 publishes the current Calibration evidence for
the direct count/list/detail/readBatch dashboard path. The Worker must not
upload files, pay FOC, withdraw funds, or submit registry transactions.

## Worker Commands

Run the local Worker:

```sh
npx wrangler dev --local
```

Check the public endpoints:

```sh
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/demo/evidence
curl http://127.0.0.1:8787/api/demo/registry
curl http://127.0.0.1:8787/api/admin/overview
curl http://127.0.0.1:8787/api/admin/files?limit=10
curl 'http://127.0.0.1:8787/api/admin/files?limit=10&cursor=1'
curl http://127.0.0.1:8787/api/admin/accounts?limit=10
curl 'http://127.0.0.1:8787/api/admin/accounts?limit=10&offset=10'
curl http://127.0.0.1:8787/api/admin/datasets?limit=10
curl http://127.0.0.1:8787/api/admin/coordinators?limit=10
curl http://127.0.0.1:8787/api/admin/reconciliation?limit=10
```

Current deployed Worker:

```text
https://foc-platform-calibration-demo.snissn.workers.dev
```

Validate a deploy bundle without publishing it:

```sh
npx wrangler deploy --dry-run --outdir /tmp/foc-platform-worker-dry-run
```

The committed `wrangler.jsonc` includes only public configuration: the
Calibration RPC URL, registry address, registry deployment evidence, object and
dataset ids, piece CID, retrieval URL, and public registry transaction hashes.
Do not add private keys, wallet seeds, or session keys to `wrangler.jsonc`,
Worker source, generated UI, or committed artifacts.

The Worker is part of the public demo evidence path only. Run
`pnpm ops:validate`, `pnpm ops:smoke -- --iterations 3`, and `pnpm worker:dry-run`
before changing or redeploying it. The security and recovery boundary is
documented in
[`docs/production-hardening-runbook.md`](./production-hardening-runbook.md).

The committed Worker config points at a Calibration registry whose runtime hash
matches the current pagination ABI. Dashboard APIs therefore default to live
direct reads. Append `?live=false` when you need a route-level smoke check
without public RPC calls.

## Public Endpoints

| Route | Purpose |
| --- | --- |
| `/` | Operator-facing admin dashboard HTML surface. |
| `/admin` | Explicit admin dashboard alias. |
| `/api/health` | Worker health and authority boundary. |
| `/api/demo/evidence` | Static public demo configuration assembled from Worker vars. |
| `/api/demo/registry` | Public registry reads for owner, next object id, and configured object/usage/receipt state. |
| `/api/admin/overview` | Bounded dashboard metrics and source metadata from direct registry count reads. |
| `/api/admin/files` | Paginated object/file rows with status, account, provider, dataset, coordinator, and text filters. Uses `cursor` for next-page reads; cross-surface reconciliation remains in `/api/admin/reconciliation`. |
| `/api/admin/accounts` | Paginated account usage rows from registry account list/detail reads. |
| `/api/admin/datasets` | Paginated dataset/provider rows from registry dataset key/detail reads. |
| `/api/admin/coordinators` | Coordinator policy and relayer rows from registry list/detail reads. |
| `/api/admin/reconciliation` | Page-scoped reconciliation warnings and evidence boundaries for the current object cursor page. Cross-surface account, dataset, and coordinator-policy checks are declared as omitted instead of scanning the whole registry from one Worker request. |

The table endpoints accept `limit` up to the registry max list limit. Files use
the object-id cursor returned as `pagination.nextCursorIdExclusive`;
reconciliation uses the same object cursor for page-scoped checks. Accounts,
datasets, and coordinators use the returned `pagination.nextOffset`. Filters
and text search apply to the returned page so the Worker keeps each request
bounded instead of scanning the full registry for a global search.

The admin dashboard renders numbered pagination controls for the current table:
`Previous`, discovered page numbers, and `Next`. File and reconciliation pages
enable number jumps only for cursor pages the browser has already discovered or
the immediate next page returned by the current registry response.

Append `?live=false` to any dashboard or registry endpoint when you need a
route-level smoke check without making public RPC calls. Unknown dashboard
routes still return `404`.

## Local Evidence Generation Boundary

Privileged FOC and registry actions stay local. A local operator can use a
Calibration-funded dev wallet to generate the evidence that the Worker later
serves as public data. Keep the private key in the local shell environment and
redact it from logs, issues, PRs, and committed files.

Example payload and FOC upload command:

```sh
PAYLOAD=/tmp/foc-platform-calibration-demo.bin
dd if=/dev/zero of="$PAYLOAD" bs=1048576 count=1

source ~/.zshrc >/dev/null 2>&1
if [[ "$PRIVATE_KEY" != 0x* ]]; then
  export PRIVATE_KEY="0x$PRIVATE_KEY"
fi

export FILECOIN_NETWORK=calibration
export FOC_STORAGE_MCP_WRAPPER="${FOC_STORAGE_MCP_WRAPPER:-$HOME/.codex/skills/foc-storage/scripts/foc-storage-mcp.sh}"

mcporter call --stdio "$FOC_STORAGE_MCP_WRAPPER" uploadFile \
  --args '{"filePath":"/tmp/foc-platform-calibration-demo.bin","datasetId":"12524","withCDN":false,"autoPayment":false,"metadata":{"project":"foc-platform","issue":"15","purpose":"calibration-demo"}}' \
  --output markdown
```

Before running `uploadFile`, confirm the file path, dataset, CDN mode,
metadata, network, and `autoPayment:false`. The upload result should provide
piece, dataset/provider, retrieval, and transaction evidence that can be copied
into the public Worker vars after redaction review.

## Updating Worker Demo Vars

After the local evidence run, update only public values:

```jsonc
{
  "FOC_PLATFORM_DEMO_MODE": "calibration_live_evidence",
  "FOC_PLATFORM_REGISTRY_ADDRESS": "<registry address>",
  "FOC_PLATFORM_REGISTRY_DEPLOY_TX": "<registry deploy tx hash>",
  "FOC_PLATFORM_REGISTRY_DEPLOY_BLOCK": "<registry deploy block>",
  "FOC_PLATFORM_REGISTRY_RUNTIME_SHA256": "<deployed runtime SHA-256>",
  "FOC_PLATFORM_DEMO_STATUS": "Committed",
  "FOC_PLATFORM_DEMO_OBJECT_ID": "<registry object id>",
  "FOC_PLATFORM_DEMO_ACCOUNT_ID": "<bytes32 account id>",
  "FOC_PLATFORM_DEMO_PROVIDER_ID": "<FOC provider id>",
  "FOC_PLATFORM_DEMO_DATASET_ID": "<FOC dataset id>",
  "FOC_PLATFORM_DEMO_PIECE_ID": "<FOC piece id if available>",
  "FOC_PLATFORM_DEMO_PIECE_CID": "<piece CID>",
  "FOC_PLATFORM_DEMO_RETRIEVAL_URL": "<public retrieval URL>",
  "FOC_PLATFORM_DEMO_UPLOAD_TX_HASH": "<FOC upload/add-piece tx hash if available>",
  "FOC_PLATFORM_DEMO_REGISTRY_TX_HASHES_JSON": "{\"request\":\"0x...\",\"start\":\"0x...\",\"finalize\":\"0x...\"}"
}
```

If a tool returns a provider receipt without a transaction hash, record the
provider response or tool log and explain why no transaction hash exists.

## Registry Finalization

After a successful upload or provider dataset read, finalize the platform
registry with local-only credentials:

```sh
source ~/.zshrc >/dev/null 2>&1
if [[ "$PRIVATE_KEY" != 0x* ]]; then
  export PRIVATE_KEY="0x$PRIVATE_KEY"
fi

export FILECOIN_CALIBRATION_RPC_URL="https://api.calibration.node.glif.io/rpc/v1"
export FOC_PLATFORM_REGISTRY_ADDRESS="0x8F6563Bb9E53aeDfE9d87d4C1E162f0371649c18"
export FOC_PLATFORM_REGISTRY_DEPLOY_TX="0xae42c13c50c1b268a1d38389e27d8fa776264b405e28a1cf11a974dd4b178eae"
export FOC_PLATFORM_REGISTRY_DEPLOY_BLOCK="3854411"
export FOC_PLATFORM_REGISTRY_RUNTIME_SHA256="0x2c49443e7a9ebf3337453240e706df249d29f4f217ec948d6c10e9502a199d1f"
export FOC_PLATFORM_DEMO_PAYLOAD_PATH="/tmp/foc-platform-calibration-demo.bin"
export FOC_PLATFORM_DEMO_PROVIDER_ID="4"
export FOC_PLATFORM_DEMO_DATASET_ID="12524"
export FOC_PLATFORM_DEMO_PIECE_ID="34"
export FOC_PLATFORM_DEMO_PIECE_CID="bafkzcibeqcad6egqwuynxmfu6jof2lzkfdp65aelknasuautd4mmjgpvujkaq2ytey"
export FOC_PLATFORM_DEMO_RETRIEVAL_URL="https://caliberation-pdp.infrafolio.com/piece/bafkzcibeqcad6egqwuynxmfu6jof2lzkfdp65aelknasuautd4mmjgpvujkaq2ytey"

node scripts/run-calibration-registry-demo.mjs --write
```

The script submits owner/coordinator transactions as needed, creates the upload
request, starts it, records dataset attribution, finalizes the receipt, and
writes public evidence to `artifacts/calibration/demo-evidence.json`. It does
not print or write the private key.

## Seeding Admin Fixture Rows

The deployed Worker admin dashboard reads directly from the public Calibration
registry, so richer demo tables require local registry transactions. Use the
fixture seeder when the dashboard needs many rows without claiming additional
FOC provider evidence:

```sh
# Export PRIVATE_KEY or PLATFORM_ROOT_PRIVATE_KEY in the current shell first.
pnpm demo:seed-calibration-fixtures -- --objects 48 --accounts 24 --committed 8 --uploading 8
```

The seeder creates deterministic synthetic registry-only rows: committed rows
include synthetic receipt and dataset records, uploading rows are advanced to
`Uploading`, and the rest remain `Requested`. It uses durable request expiries
by default (`4102444800`, 2100-01-01 UTC), is idempotent for a given `--seed`,
never writes the private key, and writes a public summary to
`artifacts/calibration/fixture-seed-summary.json`.

## Current Evidence Status

The committed demo evidence now points at a live Calibration object:

| Field | Value |
| --- | --- |
| Generated at | `2026-07-02T02:30:32.494Z` |
| Registry | `0x8F6563Bb9E53aeDfE9d87d4C1E162f0371649c18` |
| Registry deploy tx | `0xae42c13c50c1b268a1d38389e27d8fa776264b405e28a1cf11a974dd4b178eae` |
| Registry deploy block | `3854411` |
| Registry runtime SHA-256 | `0x2c49443e7a9ebf3337453240e706df249d29f4f217ec948d6c10e9502a199d1f` |
| Registry object | `1` |
| Status | `Committed` |
| Account id | `0xfaa4a252e3d762275f3bb2baccba097024ed47a08845bee0de79a2ee58514e01` |
| Provider/dataset/piece | `4` / `12524` / `34` |
| Piece CID | `bafkzcibeqcad6egqwuynxmfu6jof2lzkfdp65aelknasuautd4mmjgpvujkaq2ytey` |
| Retrieval URL | `https://caliberation-pdp.infrafolio.com/piece/bafkzcibeqcad6egqwuynxmfu6jof2lzkfdp65aelknasuautd4mmjgpvujkaq2ytey` |
| Worker URL | `https://foc-platform-calibration-demo.snissn.workers.dev` |
| Worker version | `63d11d7e-6cc1-41af-8c1b-7056a3b1d8e8` |
| Dashboard direct-read proof | Initial evidence object remains object `1`; fixture seed summary `artifacts/calibration/fixture-seed-summary.json` shows live counts after durable seeding: `objectCount=97`, `accountCount=49`, `datasetRecordCount=17`, `coordinatorCount=1`, `relayerCount=1`; verified durable fixture objects span `50`-`97` with 8 committed, 8 uploading, 32 requested, and no expiry mismatches. |

Public registry transaction hashes:

- `setCoordinator`: `0x22a29586247fa39e8d3277c754a42466f1936a3377f2d62ab50ddf1337035cd1`
- `setRelayer`: `0x93153de2f1653b1e632dff19f2dfd632f5f2a6390af20b39097a53607c162570`
- `requestUpload`: `0x35c561f8b6278b63deb1d272b8cc2b7663a45eb3cc564e75092bbeb5ebf12ccf`
- `startUpload`: `0x6c57ded5248162049d64d372c2d1bde7e37c788edeedafc454bbbd2e3f841f38`
- `recordDataset`: `0xb65836f00e8b7a24734e3d5e62d64ad305e3234fd879e2a435b1665d273b6669`
- `finalizeUpload`: `0xe046f47af71e7da40ed475aba0e3ba8ac94677ae2de7341e1b59e2f8e367a2a4`

The FOC MCP upload call timed out before returning an add-piece transaction hash
or cost field, but a read of dataset `12524` showed piece `34` with matching
metadata and retrieval URL. The registry receipt therefore records zero
`actualCost` and a zero `addPieceTxHash`, with that limitation preserved in
`artifacts/calibration/demo-evidence.json`.

This run proves the direct pagination/list/detail/readBatch ABI used by the
Worker dashboard. It still does not prove a real session-key coordinator or
expiry/revoke path. The local dev root address was allowlisted as coordinator
and relayer to complete the public end-to-end Worker demo.

On July 2, 2026, the admin dashboard registry was also seeded with synthetic
registry-only fixture rows for demo table density: 48 fixture files across 24
fixture accounts, with 8 committed, 8 uploading, and 32 requested fixture
targets. These rows are intentionally separate from the provider-backed object
`1` evidence above and should not be described as FOC provider storage proof.
The Worker dashboard defaults to 10 rows per page to stay within Worker
subrequest limits while still showing pagination over the larger registry.
