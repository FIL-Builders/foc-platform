# Calibration Worker Demo

Issue #15 exposes the Calibration demo through a Cloudflare Worker. Issue #32
turns the Worker first screen into a read-only admin dashboard for the
configured `FocPlatformRegistry`: it serves public evidence, reads dashboard
rows through direct registry list/detail views, and links to generated Token
Host wrapper metadata. It must not upload files, pay FOC, withdraw funds, or
submit registry transactions.

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

The current deployed Worker and registry evidence predate the direct pagination
ABI. The Worker code now has direct-onchain dashboard routes, but the deployed
public evidence still points at the earlier registry. For that configuration,
the dashboard defaults to skipped read-only API responses instead of attempting
live dashboard reads against missing count/list methods. `?live=true` should be
used only with a registry whose runtime hash matches the current pagination ABI.
Issue #33 must publish updated evidence from a registry build that includes the
pagination ABI before the dashboard stack can claim end-to-end public
Calibration direct-read proof.

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
| `/api/admin/reconciliation` | Reconciliation warnings and evidence boundaries from direct-read admin surfaces. |

The table endpoints accept `limit` up to the registry max list limit. Files use
the object-id cursor returned as `pagination.nextCursorIdExclusive`; accounts,
datasets, and coordinators use the returned `pagination.nextOffset`. Filters
and text search apply to the returned page so the Worker keeps each request
bounded instead of scanning the full registry for a global search.

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
export FOC_PLATFORM_REGISTRY_ADDRESS="0x7771d916a9d742B1D60597a332C7ABBd5796609c"
export FOC_PLATFORM_DEMO_PAYLOAD_PATH="/tmp/foc-platform-calibration-demo.bin"
export FOC_PLATFORM_DEMO_PROVIDER_ID="4"
export FOC_PLATFORM_DEMO_DATASET_ID="12524"
export FOC_PLATFORM_DEMO_PIECE_ID="<piece id>"
export FOC_PLATFORM_DEMO_PIECE_CID="<piece CID>"
export FOC_PLATFORM_DEMO_RETRIEVAL_URL="<provider retrieval URL>"

node scripts/run-calibration-registry-demo.mjs --write
```

The script submits owner/coordinator transactions as needed, creates the upload
request, starts it, records dataset attribution, finalizes the receipt, and
writes public evidence to `artifacts/calibration/demo-evidence.json`. It does
not print or write the private key.

## Current Evidence Status

The committed demo evidence now points at a live Calibration object:

| Field | Value |
| --- | --- |
| Registry object | `1` |
| Status | `Committed` |
| Account id | `0xfaa4a252e3d762275f3bb2baccba097024ed47a08845bee0de79a2ee58514e01` |
| Provider/dataset/piece | `4` / `12524` / `34` |
| Piece CID | `bafkzcibeqcad6egqwuynxmfu6jof2lzkfdp65aelknasuautd4mmjgpvujkaq2ytey` |
| Retrieval URL | `https://caliberation-pdp.infrafolio.com/piece/bafkzcibeqcad6egqwuynxmfu6jof2lzkfdp65aelknasuautd4mmjgpvujkaq2ytey` |
| Worker URL | `https://foc-platform-calibration-demo.snissn.workers.dev` |
| Worker version | `bee0fdaf-f4ac-4a6a-8556-46842d76c6cb` |

Public registry transaction hashes:

- `setCoordinator`: `0xcf21feda99029624d18bcf17035f0f5d0f9c7bc67680ca0d32f210d6acf370ce`
- `requestUpload`: `0x552b1da9b049dc1301effcc34c497625a1e09934b25bec7e5a3fe607ba3382fd`
- `startUpload`: `0x1d1104fb0807ff05f4a4c9045dcfc888a54bd6d143edab25e19ec6d4bd6a8bb1`
- `recordDataset`: `0x3ec159924041a28531652a23ca4343f7aa8186da47f5c27cc6e8410bee5a3ea3`
- `finalizeUpload`: `0xebbf1d335df22f3607e9552753360d80d48fd28d199ef0afa19f052d5fd57608`

The FOC MCP upload call timed out before returning an add-piece transaction hash
or cost field, but a read of dataset `12524` showed piece `34` with matching
metadata and retrieval URL. The registry receipt therefore records zero
`actualCost` and a zero `addPieceTxHash`, with that limitation preserved in
`artifacts/calibration/demo-evidence.json`.

This run still does not prove a real session-key coordinator or expiry/revoke
path. The local dev root address was allowlisted as coordinator to complete the
public end-to-end Worker demo. It also does not prove the later direct
pagination/list-read ABI; use it as historical Worker evidence until issue #33
publishes updated list/detail/dashboard proof.
