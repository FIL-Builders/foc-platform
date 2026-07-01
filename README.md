# foc-platform

`foc-platform` is a draft specification and planning workspace for embedding Filecoin Onchain Cloud (FOC) inside a normal platform product.

The core idea is that a SaaS platform, creator tool, AI product, marketplace, enterprise app, or similar service can expose a simple upload API to its users while handling the FOC details behind the scenes. Users should not need to understand wallets, USDFC deposits, datasets, providers, or payment rails in order to store files through the platform.

A typical workflow could look like this:

1. A platform user clicks “upload” or calls the platform’s API.
2. The platform accepts the request through its normal product/backend flow.
3. An upload client or FOC Storage Coordinator moves the file bytes and performs the FOC storage action, for example through tools like Synapse SDK.
4. The platform pays FOC through a managed wallet, smart account, contract treasury, or another supported payment model.
5. Platform Contracts record the relevant policy, accounting, ownership, quota, billing, and receipt information onchain.

The platform remains a normal API/product service. Platform Contracts do not replace the application, move file bytes, or remove the need for an upload/coordinator path. Instead, they provide an onchain record of who caused a storage action, what was stored, what it cost, and how the platform should account for that usage.

The purpose of this project is to make FOC easier to embed inside larger applications without every platform needing to rebuild its own custom storage accounting, quota, and receipt system from scratch.

## Motivation

A platform could manage FOC usage entirely with traditional backend infrastructure: store upload metadata in Postgres, track billing in Stripe, and keep FOC transaction receipts in an offchain database.

This repository explores a more onchain-native design for that platform layer:

- platform-specific contracts can track storage requests, object ownership, usage, quotas, billing events, and receipts,
- the platform can keep its normal API and product experience,
- offchain services can focus on uploading bytes, coordinating FOC execution, and finalizing results,
- FOC execution can still happen through tools like Synapse SDK,
- the chain can become a durable audit log and shared system of record for platform storage activity.

The goal is not to remove all offchain infrastructure. File bytes still need to be uploaded, transferred, and coordinated by software outside the smart contracts. The goal is to define a reusable pattern where Platform Contracts handle policy and accounting while the platform and its coordinators handle the product experience and storage execution.

## Current status

This repository is currently a specification plus early implementation
workspace.

See [`spec.md`](./spec.md).

The design is not production-ready, but it now selects a v1 implementation path to validate: platform EOA/KMS payer, FOC session-key coordinator, hosted coordination, onchain request/object/usage/receipt state, and a Token Host Builder-first scaffold for the generated app, admin/read surfaces, upload adapters, manifests, and sponsored transaction wiring. The workspace includes a local registry artifact/read model, a dev-only upload spine test that exercises request, start, deterministic mocked receipt finalization, object reads, usage reads, and log projection, plus read-only admin/reconciliation projections for object, usage, dataset, provider, coordinator, and mismatch views. These tests do not claim real FOC or Calibration execution. Future payment and coordinator modes remain compatibility-gated by Phase 0 evidence.

## Related projects

- [`@filoz/synapse-sdk`](https://github.com/FilOzone/synapse-sdk) — core SDK for FOC storage, payments, providers, datasets, and retrieval.
- [`foc-cli`](https://github.com/FIL-Builders/foc-cli) — CLI and agent-facing operational tooling for FOC.
- [`foc-storage-mcp`](https://github.com/FIL-Builders/foc-storage-mcp) — MCP tools for AI-agent FOC storage workflows.
- [`tokenhost-builder`](https://github.com/tokenhost/tokenhost-builder/) — first-class scaffold for generated Filecoin-ready apps, generated UI/admin surfaces, upload adapters, manifest metadata, onchain indexing, and sponsored transaction UX around the platform contract/API surface.

Together, these projects cover different layers of the FOC developer experience. `foc-platform` focuses specifically on the platform-integration layer: how a company can offer FOC-backed storage through its own API, billing model, user accounts, and managed payment flow.

## Initial development direction

The current v1 direction is:

- platform EOA/KMS payer,
- FOC session keys for coordinator execution,
- platform-hosted allowlisted coordinator,
- onchain request, object, usage, and compact receipt state,
- Token Host Builder-generated app/admin/read UI, upload adapters, manifest, and sponsored transaction scaffolding,
- quota/credit-style accounting before contract-custodied user deposits.

Smart-account payers, contract treasury payment, direct browser-to-FOC upload, BYO coordinators, and stronger proof models remain compatibility-gated future paths. Token Host Builder is the preferred v1 scaffolding path, but the production contract/API semantics in `spec.md` remain authoritative until a generated custom module proves compatibility with the upload lifecycle, coordinator controls, receipts, and usage accounting model.

The next recommended step is to complete the Phase 0 Filecoin Calibration compatibility report and Token Host Builder compatibility matrix in `spec.md`, including required transaction hashes, pass/fail answers, SDK gaps, builder gaps, and the final recommended v1 implementation mode.

For local development, `pnpm test:spine` runs the mocked vertical upload spine,
`pnpm test:api` validates the route-equivalent platform API surface, and
`pnpm test:admin` validates the read-only operator/reconciliation projections.
`pnpm test:tokenhost` validates the Token Host wrapper manifest plus generated
byte-upload adapter and request/status/object/usage demo flow. `pnpm
build:tokenhost` regenerates the committed wrapper manifest. See
[`docs/upload-spine.md`](./docs/upload-spine.md),
[`docs/platform-api.md`](./docs/platform-api.md),
[`docs/admin-reconciliation.md`](./docs/admin-reconciliation.md), and
[`docs/tokenhost-demo.md`](./docs/tokenhost-demo.md).
