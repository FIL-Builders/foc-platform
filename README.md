# foc-platform

`foc-platform` explores how a company can build its own product on top of Filecoin Onchain Cloud (FOC) without forcing every end user to understand wallets, USDFC deposits, datasets, providers, or payment rails.

The intended workflow is:

1. A platform user clicks “upload” or calls the platform’s API.
2. The platform handles the FOC storage transaction for them.
3. The platform pays FOC through a managed wallet, smart account, or contract treasury.
4. Smart contracts record which user caused the action, what was stored, how much it costs, and how that user should be charged or quota-limited.

The purpose of this project is to make FOC easier to embed inside larger applications: SaaS platforms, creator tools, AI products, marketplaces, enterprise apps, and other systems where the platform wants to offer decentralized storage as a managed feature.

## Motivation

A typical platform might solve this with a backend database: store user uploads in Postgres, track billing in Stripe, and keep FOC transaction receipts somewhere offchain.

This repository explores a more onchain-native approach:

- platform-specific contracts track storage requests, object ownership, usage, quotas, and billing events,
- offchain services are kept minimal and mostly stateless,
- FOC execution still happens through tools like Synapse SDK,
- the chain becomes the durable audit log and primary system of record.

The goal is not to remove all offchain infrastructure. File bytes still need to be moved by an uploader or runner. The goal is to prevent every platform from having to rebuild its own custom FOC accounting and usage system from scratch.

## Current status

Draft specification only. See [`spec.md`](./spec.md).

## Related projects

- [`@filoz/synapse-sdk`](https://github.com/FilOzone/synapse-sdk) — core SDK for FOC storage, payments, providers, datasets, and retrieval.
- [`foc-cli`](https://github.com/FIL-Builders/foc-cli) — CLI and agent-facing operational tooling for FOC.
- [`foc-storage-mcp`](https://github.com/FIL-Builders/foc-storage-mcp) — MCP tools for AI-agent FOC storage workflows.
- [`tokenhost-builder`](https://github.com/tokenhost/tokenhost-builder/) — candidate framework for generating onchain platform registry, usage ledger, UI, upload adapters, and sponsored transaction scaffolding.

## Initial development direction

The draft spec keeps several implementation options open, including:

- platform EOA/KMS payer,
- smart-account payer,
- contract treasury payer,
- prepaid user balances,
- credit/quota accounting,
- trusted runner finalization,
- stronger receipt/proof models,
- Token Host-generated contracts and UI.

The next recommended step is a compatibility spike against Filecoin Calibration to determine which FOC payment and signer models are currently viable.
