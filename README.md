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

This repository is currently a draft specification and planning workspace.

See [`spec.md`](./spec.md).

The design is not production-ready and does not yet prescribe a single implementation path. It is intended to clarify the model, identify viable payment and signer options, and guide early compatibility work against FOC.

## Related projects

- [`@filoz/synapse-sdk`](https://github.com/FilOzone/synapse-sdk) — core SDK for FOC storage, payments, providers, datasets, and retrieval.
- [`foc-cli`](https://github.com/FIL-Builders/foc-cli) — CLI and agent-facing operational tooling for FOC.
- [`foc-storage-mcp`](https://github.com/FIL-Builders/foc-storage-mcp) — MCP tools for AI-agent FOC storage workflows.
- [`tokenhost-builder`](https://github.com/tokenhost/tokenhost-builder/) — candidate framework for generating onchain platform registry, usage ledger, UI, upload adapters, and sponsored transaction scaffolding.

Together, these projects cover different layers of the FOC developer experience. `foc-platform` focuses specifically on the platform-integration layer: how a company can offer FOC-backed storage through its own API, billing model, user accounts, and managed payment flow.

## Initial development direction

The draft spec keeps several implementation options open, including:

- platform EOA/KMS payer,
- smart-account payer,
- contract treasury payer,
- prepaid user balances,
- credit/quota accounting,
- trusted coordinator finalization,
- stronger receipt/proof models,
- Token Host-generated contracts and UI.

The next recommended step is a compatibility spike against Filecoin Calibration to determine which FOC payment, signer, and coordinator models are currently viable.
